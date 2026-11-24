# The WebRGB provider interface

**Status:** draft. The interface follows upstream `@kaleidorg/webrgb` 0.5.0
and is described by `index.d.ts` in this repository. It adds the BFA methods
`burnAsset`, `getConsignment` and `getReceivedMint`, which are proposed for the
upstream core. Like any other method, a wallet need not serve them; see
`methods` in §4.

A **wallet** injects a provider into a web page. A **dApp** calls it to issue,
receive, send and track [RGB](https://rgb.tech) assets, and to pay or receive
them over Lightning, without running an RGB backend of its own. WebRGB sits
next to WebLN (`window.webln`) and WebBTC (`window.webbtc`) and follows their
conventions.

"MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. Installing a provider

A browser wallet MUST expose the provider object as `window.rgb` and MUST
dispatch a `rgb:ready` `CustomEvent` on `window` once it is installed:

```js
window.rgb = provider;
window.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));
```

A page may run before or after the wallet, so a dApp MUST handle both orders —
`requestProvider()` in this package does.

`window.rgb` is a single slot. A wallet SHOULD NOT overwrite a provider another
wallet installed; it MUST still announce itself (§2) so the page can choose.

A wallet that does not run in the page — a mobile app, a remote signer — MAY
serve the same interface through a transport adapter: a library that gives
the dApp a local object implementing `RgbProvider` and relays each call to
the wallet over a pairing channel (a QR code or deep link, then an encrypted
session). The dApp then skips injection and discovery; everything from §3 on
applies unchanged, and consent is still given in the wallet.

## 2. Discovery

`window.rgb` cannot represent two installed wallets. Discovery works like
EIP-6963: pages ask, wallets answer.

- A page asks by dispatching an `Event` named **`rgb:requestProvider`** on
  `window`.
- A wallet answers, and also announces once on load, by dispatching a
  `CustomEvent` named **`rgb:announceProvider`** whose `detail` is
  `{ info, provider }`.

```ts
interface RgbProviderInfo {
  uuid: string; // UUIDv4, fresh per page load — identifies the announcement
  name: string; // "KaleidoSwap"
  rdns: string; // "com.kaleidoswap.extension" — stable, identifies the wallet
  icon?: string; // data: URI
}
```

A wallet MUST keep answering `rgb:requestProvider` for the lifetime of the
page, MUST use a reverse-DNS `rdns` it controls, and MUST announce the same
object it installed at `window.rgb` when it installed one. A page MUST
deduplicate by `rdns`.

Discovery is additive: a wallet that only sets `window.rgb` still works, and a
page that only reads `window.rgb` still works.

## 3. Connection and consent

`enable()` asks the user to connect the origin. Every other method MUST reject
with `NOT_ENABLED` until it has resolved. A wallet MAY share one approval
across its RGB, WebLN and WebBTC providers. `enable()` MUST be idempotent and
MUST NOT prompt again for an origin already connected.

Beyond the connection, consent is per call:

| Method | Prompts | Notes |
|--------|---------|-------|
| `getInfo`, `getAddress`, `listAssets`, `getAssetBalance`, `listTransfers`, `getTransferStatus`, `decodeRgbInvoice`, `getBtcBalance`, `refresh`, `getAssetMetadata` | MUST NOT | Read-only; a page may poll them |
| `blindReceive` | MUST | Creates an invoice that binds a UTXO |
| `witnessReceive` | MUST | Creates an invoice the sender funds; the confirmation MUST say "witness" |
| `createUtxos` | MUST | Spends bitcoin to create colorable UTXOs |
| `cancelReceive` | MUST | Fails a pending receive; MAY skip the prompt when nothing would be cancelled |
| `signPsbt` | MUST | Signs a transaction |
| `signMessage` | MUST | Shows the message and the requesting origin |
| `issueAsset` | MUST | Mints; MAY also require a separate wallet capability |
| `sendAsset` | MUST | Moves assets |
| `burnAsset` | MUST | Burns assets |
| `getConsignment` | MUST unless already approved | Shares a consignment with a third party to verify a burn proof |
| `getReceivedMint` | MUST NOT | After `enable()`, an authorized dApp may poll an owned invoice |
| `makeLnInvoice`, `payLnInvoice` | MUST | Moves, or commits to receiving, assets over Lightning |

A prompt the user dismisses MUST reject with `USER_REJECTED`.

## 4. Methods

Signatures are in [`index.d.ts`](./index.d.ts); this section is the contract
around them.

- **`getInfo()`** returns `{ ready, network, protocol, methods }`. `ready` is
  `false` when no RGB wallet is connected — every other call then rejects.
  `protocol` is `"RGB_L1"` (node-less, client-side RGB), `"RGB_LN"` (an RGB
  Lightning node), or `null` when nothing is connected.
- **`methods`** is the feature-detection contract. It MUST list exactly the
  methods the wallet will serve. A method absent from it MUST reject with
  `METHOD_NOT_SUPPORTED`; a method present in it MUST NOT. `makeLnInvoice` and
  `payLnInvoice` MUST appear only when `protocol` is `"RGB_LN"`, and
  `issueAsset` only when the runtime can mint. Every method in `index.d.ts`
  MUST be present on the provider as a function, whether or not it is served:
  presence is not feature detection. dApps MUST check `methods` and MUST NOT
  rely on a method being absent.
- **`getAddress()`** returns a Bitcoin address of the wallet that anchors its
  RGB state. It is not an RGB invoice.
- **`signMessage(message)`** signs a UTF-8 string and returns `{ signature }`
  in the LND `signmessage` format: zbase32, recoverable, over the message
  prefixed with `Lightning Signed Message:`. A verifier recovers the public
  key from the signature, so a backend can bind a session to it with a
  challenge it issued. The wallet signs with a key it keeps stable across
  calls, so the recovered key identifies it from one session to the next. The wallet
  MUST show the message unchanged with the requesting origin, and MUST reject
  an empty or non-string `message`, or one that is not well-formed Unicode,
  with `INVALID_PARAMS` before prompting.
- **`blindReceive({ assetId?, amount?, minConfirmations?, … })`** returns an
  RGB invoice against a blinded UTXO. Omitting `amount` means any amount.
  Omitting `assetId` means any asset: the invoice names no contract, and it is
  the only way to receive an asset the wallet has never held, since a wallet
  can only name a contract it already knows. An `assetId` the wallet does not
  know MUST reject with `ASSET_NOT_FOUND`, not `INTERNAL_ERROR`.
  A wallet SHOULD NOT accept fewer than 3 confirmations for `minConfirmations`:
  RGB wallets do not handle reorgs today, so a transfer accepted as settled
  whose anchoring transaction is later reorged out loses the received assets.
  A wallet MAY enforce a higher floor, and SHOULD raise a lower request to its
  floor rather than reject. The confirmation MUST show the value actually used,
  and the result MUST carry it as `minConfirmations`.
  If the native backend cannot allocate a receiving slot, reject with
  `NO_AVAILABLE_UTXOS`; do not infer this solely from the empty-UTXO count.
- **`witnessReceive(args?)`** returns an RGB invoice for an output created
  by the sender's transaction, without requiring an existing receiver UTXO.
  Its parameters, result and confirmation rules are the same as `blindReceive`.
- **`createUtxos({ num?, size?, feeRate? })`** creates colorable UTXOs
  using the wallet's bitcoin and returns `{ created, size, feeRate? }`. `num`
  is 1..255, `size` is a positive u32 in sats, and `feeRate` is a positive
  finite number in sat/vB. Omitted arguments take wallet defaults. Bad
  arguments, including values outside the backend's limits, MUST reject with
  `INVALID_PARAMS` before prompting. The wallet MUST show the actual outputs
  and fee before signing. Return the actual `created` count, size and, when
  available, the fee rate used; fewer outputs may be created than requested.
  A wallet without enough bitcoin MUST reject with `INTERNAL_ERROR` and a
  message saying so. Never retry this spending operation automatically.
- **`cancelReceive(recipientId)`** fails a pending receive the wallet created,
  releasing the UTXO a blinded invoice reserved, and resolves
  `{ cancelled: true }`. Only a receive still `WaitingCounterparty` can be
  cancelled; any other state, and an unknown `recipientId`, MUST resolve
  `{ cancelled: false }` rather than reject. The wallet MUST prompt before
  cancelling anything; when nothing would change it MAY resolve
  `{ cancelled: false }` without a prompt. A malformed `recipientId` MUST
  reject with `INVALID_PARAMS`.
- **`getBtcBalance()`** returns aggregate `vanilla` and `colored`
  balances (settled, future and spendable sats) as nonnegative safe integers,
  plus `freeColorableUtxos` or `null` when its exact count is unavailable.
  It MUST NOT expose outpoints. Zero empty UTXOs does not imply a receive
  cannot use a free allocation slot on an occupied output.
- **`refresh(assetId?)`** syncs and advances transfers without a
  confirmation prompt. Return `{ refreshed }`, true when a transfer changed
  state. A successful backend unable to report changes may return false.
  Wallets MUST inspect per-transfer native failures as well as thrown errors;
  failures within the requested scope MUST reject using §6, not return false.
  A rejection does not mean nothing changed: other transfers may have
  advanced, so callers SHOULD re-read transfer state after any `refresh`.
- **`getAssetMetadata(assetId)`** returns the typed contract metadata.
  `issuedSupply` is the initial supply as a canonical unsigned u64 decimal
  string, including zero. It is not the current wallet balance or circulating
  supply. Schema names include `bfa`. `ticker`, `details`, and `media` are null
  when unavailable. An unknown asset rejects with `ASSET_NOT_FOUND`.
- **`signPsbt(psbt, { finalize? })`** signs, in a base64 PSBT, the inputs the
  RGB wallet controls and returns `{ psbt, signedInputs }`, the PSBT again in
  base64 and finalized when `finalize` is `true`. A PSBT with no input the
  wallet controls MUST reject with `INVALID_PARAMS`. The confirmation MUST
  show the outputs (address and amount) and the fee where it can be computed.
  **A wallet MUST refuse, with `UNSAFE_PSBT` and before prompting, any PSBT in
  which an input it would sign holds an RGB allocation, settled or pending.**
  Spending such an input outside an RGB state transition destroys the assets
  it carries, and nothing in a plain PSBT can carry that transition. This
  method is for vanilla, bitcoin-only inputs; RGB-aware PSBT flows are left to
  a later version.
- **`issueAsset({ schema, ticker, name, amounts, precision? })`** mints.
  `schema` is `"nia"`, `"uda"` or `"cfa"`; a wallet that cannot serve a schema
  MUST reject with `METHOD_NOT_SUPPORTED` rather than substituting another.
- **`sendAsset(args)`** takes either `{ invoice }` (preferred) or the explicit
  `{ assetId, amount, recipientId }`. It returns at least the wallet's handle
  on the transfer — `txid` and/or `transferId` — so the page can track it.
  A wallet MAY refuse `{ invoice }` for an any-amount invoice, since nothing
  in the request fixes what leaves the wallet; it MUST then reject with
  `INVALID_PARAMS`, and the explicit form is how a page pays one. A send
  that needs a free colorable UTXO and finds none MUST reject with
  `NO_AVAILABLE_UTXOS`.
- **`burnAsset({ network, assetId, amount, burnDestination, … })`** burns a BFA
  and returns its transaction ID after broadcast. `amount` is a canonical positive
  u64 decimal string in base units; `network` MUST match the connected RGB network.
  When provided, `feeRate` is a positive finite number in sat/vB and
  `minConfirmations` is an integer in 1..255; wallets may enforce higher floors.
  `burnDestination` is the single required `{ version: 1, chainId, address, dstEid }` object
  defined in `RgbBurnDestination`. `address` is native, not a precomputed hash.
  The wallet MUST validate the exact chain/endpoint against its own configured
  routes and validate the address, amount, fee and confirmation count before
  confirmation. Unsupported routes, malformed values, a missing destination,
  or legacy/mixed destination fields MUST reject with `INVALID_PARAMS`.
  It MUST NOT ignore a supplied endpoint, derive a different endpoint silently,
  or fall back to the old address-only commitment. Encoding is fixed in §4.1.
  dApps MUST check `getInfo().burnRecipientNamespaces` (defaults to `["eip155"]`);
  this identifies address formats, not supported payout routes. The wallet MUST
  show the asset, amount, payout chain, native address and Bitcoin fee in its
  confirmation. The result MUST carry the same approved `burnDestination`.
  A dApp MUST NOT automatically repeat a burn after a timeout.
- **`getConsignment({ assetId, txid })`** returns the saved burn consignment
  as Base64, with its byte length and digest as defined in `index.d.ts`.
  The consignment can be shared with a third party, such as a bridge, to
  verify the burn proof. The wallet MUST obtain consent to share this proof
  with the requesting dApp and explain that it may be forwarded to a third
  party; consent already given for that proof and dApp MAY be reused until
  revoked. The result MUST contain the proof bytes, not a local file path,
  and retrieval MUST NOT perform another burn.
- **`getReceivedMint({ invoice })`** inspects a prepared mint before the dApp
  pays the EVM lock. The request MUST contain the complete, unchanged RGB
  invoice. Wallets with only a recipient-ID lookup MUST NOT advertise it as
  this method. The wallet MUST verify the requesting origin is authorized for the
  method and invoice, that the invoice belongs to the active account, and
  that its recipient, public key, expiry, assignment and transport data match
  the wallet's record. A recipient ID alone is insufficient.
  The invoice MAY omit the asset. For an any-asset invoice, the wallet MUST take
  `assetId` from the consignment it validated for this mint and MUST NOT copy it
  from the request, dApp state or any other unvalidated source. A wallet that
  cannot do so MUST reject an any-asset invoice with `INVALID_PARAMS`.
  The wallet MUST refresh incoming state and bind the checked mint and its
  consignment to that exact invoice. The result is
  [`RgbReceivedMint`](./index.d.ts), with the original invoice, the wallet's
  network as returned by `getInfo()`, and `assetId` identifying the asset of
  the validated consignment. `assetId` is REQUIRED in every receipt. If the
  invoice names an asset, the validated consignment MUST match it, and a
  mismatch MUST reject. `txid` MAY be absent before the
  lock is paid; `lockId` already commits to the witness transaction. Its
  absence MUST NOT turn an otherwise checked mint into a pending result.
  The method MUST return `null` only while a valid, authorized invoice has
  no checked mint ready. It MUST reject expired or foreign invoices,
  rejected proofs, mismatches, unavailable wallets and transport failures.
  Refresh MAY acknowledge an incoming transfer and deliver its already
  signed transaction. It MUST NOT create an invoice, initiate or replay an
  outgoing send or burn, or approve or pay an EVM deposit.
  A wallet MAY use previously checked mint terms during refresh. A receipt
  does not establish current EVM connectivity, current reject-list acceptance
  or settlement. Before paying, the dApp MUST match the receipt to its
  intended operation and verify current lock-chain state.
  Before paying, the dApp MUST compare the receipt's `assetId` with the asset it
  selected and MUST NOT pay if they differ. An any-asset invoice does not restrict
  the asset, so this comparison is what binds the mint to the selected asset.
  A change of session, account, network, invoice or mint preparation invalidates the
  prior result. See [the integration guide](./INTEGRATION.md#checking-a-prepared-mint).
- **`listAssets()`** and **`listTransfers(assetId?)`** MUST return arrays.
  (Wallets that wrap them exist; `toAssetArray` / `toTransferArray` in this
  package tolerate that, and the conformance suite reports it.)
- **`getTransferStatus(transferId, assetId?)`** MUST resolve
  `{ found: false, status: null, transfer: null }` for an unknown transfer
  rather than rejecting. `transferId` MAY be matched against the wallet's own
  id, the recipient id, or the txid.
- **`decodeRgbInvoice(invoice)`** reads what an invoice asks for, so a page can
  show it before calling `sendAsset`. It MUST NOT prompt and MUST NOT move
  anything. `amount` MUST be the same number the wallet's own confirmation
  would show, and `null` for an any-amount invoice rather than `0`.
  An invoice whose fungible assignment is `0` is an any-amount invoice: rgb-lib
  writes an unconstrained invoice both as `Assignment::Any` and as
  `Assignment::Fungible(0)`, and a wallet MUST read the two the same way —
  `amount: null` here, and the amount the user or the page supplies on send —
  never as a request for zero. Issuers SHOULD prefer `Any`, which says so.
- **`makeLnInvoice(args)`** returns a BOLT-11 invoice carrying the asset. The
  node enforces a minimum HTLC value, so the wallet MAY raise `amountSats`; the
  confirmation MUST show the figure actually encoded.
- **`payLnInvoice(invoice)`** pays a BOLT-11 invoice that carries an asset. A
  plain Bitcoin invoice SHOULD be refused — that is `webln.sendPayment()`.

### 4.1 Burn destination commitment

`RgbBurnDestination` contains only `version`, `chainId`, `address`, and `dstEid`.
`version` MUST be the number `1` in requests and results. Missing or unsupported
request versions MUST reject with `INVALID_PARAMS` before confirmation; wallets
MUST NOT default or downgrade them. There is no duplicate `burnRecipient`, numeric
`destinationChainId`, or encoded `recipient`. The wallet derives the internal preimage:

- `destinationChainId`: the numeric reference of the validated CAIP-2 ID,
  a positive u64. For this commitment profile, EVM uses `eip155` and Tron `tron`;
  unsupported namespaces or noncanonical numeric references MUST reject.
- `dstEid`: the supplied u32, matched against wallet-owned route configuration.
  Zero means a configured direct payout, not an unknown endpoint. Never accept
  an arbitrary destination merely because it has a syntactically valid ID.
- `recipientBytes`: EVM uses the nonzero 20 native account bytes. Tron uses the
  nonzero 21-byte Base58Check payload, including its `0x41` prefix but excluding
  the checksum, after validating the full native address. No 32-byte padding
  or truncation is applied before hashing these dynamic bytes.

The existing bridge commitment remains unchanged:

```text
typeHash = keccak256(UTF8("UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)"))
commitment = keccak256(abi.encode(typeHash, uint64(destinationChainId), uint32(dstEid), keccak256(recipientBytes)))
```

`version: 1` selects the `V1` type string above; the version is not an additional
ABI-encoded field. The result is a 32-byte commitment, not an EIP-712
signature digest. Native rgb-lib receives it as a 64-character lowercase hex
`burn_reason` without `0x`, together with asset, amount, fee and confirmations.
It does not receive the WebRGB request object or validate bridge payout routes.

For `eip155:137`, endpoint `30109`, and native address
`0x1111111111111111111111111111111111111111`, the commitment is
`0x7234950dd3dc71ccd10bc2b721230f7393ef7782176c1b296669cfda97850a6b`.

The wallet MUST retain the approved destination with the burn result and proof
export, so the receiving service can reconstruct and verify the commitment.
It MUST NOT replace it with currently selected UI values during recovery.
Neither this package nor a successful burn guarantees that a bridge pays out.

This replaces the old `burnRecipient` request contract and is a breaking API
change. The former `getInfo().burnDestinationVersion` and
`burnDestinationRoutes` extensions are not required by this contract. The wallet
owns route validation. See [INTEGRATION.md](./INTEGRATION.md#burn-contract-migration)
for coordinated provider and transport migration; a method name alone cannot
identify an older implementation's request semantics.

## 5. Events

`on(event, listener)` / `off(event, listener)` deliver:

| Event | Fires when |
|-------|-----------|
| `transferReceived` | The wallet sees an incoming transfer for this wallet |
| `transferSettled` | A known transfer reaches `Settled` |

The listener receives the transfer. A wallet SHOULD start whatever polling
backs this only while a page holds a listener, and SHOULD deliver events only
to origins that have called `enable()`.

## 6. Errors

Every rejection MUST be an `Error` carrying a `code`:

| Code | Meaning |
|------|---------|
| `USER_REJECTED` | The user declined the connection or a confirmation |
| `NOT_ENABLED` | Called before `enable()` resolved for this origin |
| `METHOD_NOT_SUPPORTED` | This wallet cannot serve this method |
| `INVALID_PARAMS` | An argument is malformed or out of range; `message` names it |
| `ASSET_NOT_FOUND` | The call names an asset the wallet does not know |
| `NO_AVAILABLE_UTXOS` | No allocatable RGB output/slot; offer UTXO creation or witness receiving |
| `UNSAFE_PSBT` | `signPsbt` would sign an input that holds RGB assets |
| `INTERNAL_ERROR` | Anything else; `message` carries the detail |

A wallet SHOULD reject bad arguments with `INVALID_PARAMS` before raising any
confirmation. A code a wallet's own backend produces MUST be mapped onto this
table, never forwarded as-is. A dApp MUST treat a code it does not recognise
as `INTERNAL_ERROR`: older wallets predate `INVALID_PARAMS`,
`ASSET_NOT_FOUND`, `NO_AVAILABLE_UTXOS` and `UNSAFE_PSBT`, and later versions
may add codes.

A dApp MUST NOT rely on `instanceof`: the error crosses a `postMessage`
boundary and arrives as a plain `Error`. Use `isProviderError()`.

A wallet MUST NOT leak wallet state through error messages to an origin that
has not been enabled.

## 7. Conformance

`@utexo/webrgb/conformance` runs the read-only half of this document
against a live provider:

```js
import { runConformance, formatReport } from "@utexo/webrgb/conformance";
console.log(formatReport(await runConformance(window.rgb)));
```

It never issues, sends, creates an invoice or UTXOs, cancels or signs, so it
raises no confirmation and costs nothing to run against a funded wallet. It
checks that every method is present without burning assets, sharing a
consignment or signing a message. An unlisted method is called only when the
call is a read that cannot prompt (`getBtcBalance`, `refresh`,
`getAssetMetadata`, `getReceivedMint`), and must reject with
`METHOD_NOT_SUPPORTED`.

## 8. Changes

This document and `index.d.ts` version together. A method added to the
interface is a minor version of the package; a changed signature is a major
one. Where a wallet and this document disagree, the wallet is what pages see —
[open an issue](https://github.com/UTEXO-Protocol/webrgb/issues).

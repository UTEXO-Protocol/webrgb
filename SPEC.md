# The WebRGB provider interface

**Status:** draft, version 1. The interface is implemented by the KaleidoSwap
browser extension ≥ 0.3.0 and described by `index.d.ts` in this repository.

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
| `createUtxos` | MUST | Spends on-chain bitcoin |
| `cancelReceive` | MUST | Fails a pending receive; MAY skip the prompt when nothing would be cancelled |
| `signPsbt` | MUST | Signs a transaction |
| `signMessage` | MUST | Shows the message and the requesting origin |
| `issueAsset` | MUST | Mints; MAY also require a separate wallet capability |
| `sendAsset` | MUST | Moves assets |
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
  `issueAsset` only when the runtime can mint. Each method added in a later
  version appears only when the wallet serves it, so an `"RGB_LN"` wallet
  lists those its node supports and rejects the rest.
  Every method in `index.d.ts` MUST exist on the provider as a function,
  including methods the wallet does not serve. A dApp MUST check `methods`
  for support: a method's presence is not a support check.
- **`getAddress()`** returns a Bitcoin address of the wallet that anchors its
  RGB state. It is not an RGB invoice.
- **`signMessage(message)`** signs a UTF-8 string and returns `{ signature }`
  in the LND `signmessage` format: zbase32, recoverable, over the message
  prefixed with `Lightning Signed Message:`. A verifier recovers the public
  key from the signature, so a backend can bind a session to it with a
  challenge it issued. The wallet signs with a key it keeps stable across
  calls, so the recovered key identifies it from one session to the next. The wallet
  MUST show the message unchanged with the requesting origin, and MUST reject
  an empty or non-string `message` with `INVALID_PARAMS` before prompting. It
  MUST also reject a string with an unpaired surrogate: encoding it as UTF-8
  would replace it, so the signed bytes would differ from the message shown.
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
  A blinded invoice needs a receiving slot on a colorable UTXO; a wallet that
  cannot allocate one MUST reject with `NO_AVAILABLE_UTXOS`, and the page
  SHOULD offer `createUtxos()` or `witnessReceive()`. A wallet MAY allocate
  the slot on a UTXO that already holds an allocation, so it MUST NOT reject
  solely because `freeColorableUtxos` is `0`.
- **`witnessReceive(args?)`** takes the same arguments and returns the same
  result as `blindReceive`, but the invoice is a witness invoice: the sender
  funds a new UTXO, so it works on a wallet with no colorable UTXO at all.
- **`createUtxos({ num?, size?, feeRate? })`** spends on-chain bitcoin to
  create colorable UTXOs and returns `{ created, size, feeRate? }`. Omitted
  arguments take wallet defaults. `num` is an integer in 1..255, `size` a
  positive u32 in sats, and `feeRate` a positive finite number in sat/vB. Bad
  arguments, including values outside the backend's limits, MUST reject with
  `INVALID_PARAMS` before prompting. A wallet without enough bitcoin MUST
  reject with `INTERNAL_ERROR` and a message saying so, also before
  prompting. The confirmation MUST show the outputs and the fee. `created` is
  the number actually created, which MAY be lower than `num`. A dApp MUST NOT
  retry the call automatically: a timeout does not mean nothing was spent.
- **`cancelReceive(recipientId)`** fails a pending receive the wallet created,
  releasing the UTXO a blinded invoice reserved, and resolves
  `{ cancelled: true }`. Only a receive still `WaitingCounterparty` can be
  cancelled; any other state, and an unknown `recipientId`, MUST resolve
  `{ cancelled: false }` rather than reject. The wallet MUST prompt before
  cancelling anything; when nothing would change it MAY resolve
  `{ cancelled: false }` without a prompt. A malformed `recipientId` MUST
  reject with `INVALID_PARAMS`.
- **`getBtcBalance()`** returns `{ vanilla, colored, freeColorableUtxos }`.
  `vanilla` and `colored` each carry `settled`, `future` and `spendable` in
  sats, as nonnegative safe integers. `freeColorableUtxos` is the exact count
  of colorable UTXOs with no RGB allocation, settled or pending, and not
  reserved by a pending receive, as a nonnegative safe integer; it is `null`
  when the wallet cannot tell. It counts empty UTXOs, not receiving capacity:
  `0` does not mean `blindReceive` will reject. The result is aggregate
  figures only and MUST NOT expose outpoints.
- **`refresh(assetId?)`** syncs the wallet and advances pending transfers.
  `refreshed` says whether any transfer changed state, and is `false` when
  the wallet cannot tell. A failure within the requested scope MUST reject
  under §6, including a per-transfer failure the backend reports without
  throwing; `{ refreshed: false }` is only for a successful refresh. A
  rejection does not mean no transfer advanced, so a dApp SHOULD re-read
  transfer state after any `refresh`.
- **`getAssetMetadata(assetId)`** returns the asset's contract data:
  `{ assetId, schema, ticker, name, details, precision, issuedSupply,
  timestamp, media }`, with `ticker`, `details` and `media` `null` when
  absent. `precision` is an integer in 0..255 and `timestamp` a Unix time in
  seconds, as a safe integer. An unknown asset MUST reject with
  `ASSET_NOT_FOUND`.
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
| `NO_AVAILABLE_UTXOS` | No suitable colorable UTXO or allocation slot is available for the operation; offer `createUtxos()` or `witnessReceive()` |
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

`@kaleidorg/webrgb/conformance` runs the read-only half of this document
against a live provider:

```js
import { runConformance, formatReport } from "@kaleidorg/webrgb/conformance";
console.log(formatReport(await runConformance(window.rgb)));
```

It never issues, sends, creates an invoice or UTXOs, cancels or signs, so it
raises no confirmation and costs nothing to run against a funded wallet. It
checks that every method exists as a function. It checks the results of
`getBtcBalance`, `getAssetMetadata` and `refresh` when `methods` lists them.
When `methods` omits them, it calls `getBtcBalance()`, and `refresh` and
`getAssetMetadata` with a nonexistent asset, and expects each to reject with
`METHOD_NOT_SUPPORTED`. As before, it also calls one unlisted Lightning method
and expects the same code. Other unlisted methods are only checked for
presence. These probes expect a rejection; they cannot stop a nonconforming
wallet from answering, and `getBtcBalance()` then returns balance data.

## 8. Changes

This document and `index.d.ts` version together. A method added to the
interface is a minor version of the package; a changed signature is a major
one. Where a wallet and this document disagree, the wallet is what pages see —
[open an issue](https://github.com/kaleidoswap/webrgb/issues).

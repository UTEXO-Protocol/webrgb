# The WebRGB provider interface

**Status:** draft, version 1. The interface is implemented by the KaleidoSwap
browser extension ≥ 0.3.0 and described by `index.d.ts` in this repository.
The `burnAsset` and `getConsignment` methods below are optional BFA extensions
provided by this fork; they are not part of that reference implementation.

A **wallet** injects a provider into a web page. A **dApp** calls it to issue,
receive, send and track [RGB](https://rgb.tech) assets, and to pay or receive
them over Lightning, without running an RGB backend of its own. WebRGB sits
next to WebLN (`window.webln`) and WebBTC (`window.webbtc`) and follows their
conventions.

"MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. Installing a provider

For browser injection, a wallet MUST expose the provider object as
`window.rgb` and MUST dispatch a `rgb:ready` `CustomEvent` on `window` once
it is installed:

```js
window.rgb = provider;
window.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));
```

A page may run before or after the wallet, so a dApp MUST handle both orders —
`requestProvider()` in this package does.

`window.rgb` is a single slot. A wallet SHOULD NOT overwrite a provider another
wallet installed; it MUST still announce itself (§2) so the page can choose.

A remote wallet MAY expose the same interface through a transport adapter.
The dApp then uses a local provider object; browser injection and discovery
are not required. Connection and method consent still apply.

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
| `getInfo`, `getAddress`, `listAssets`, `getAssetBalance`, `listTransfers`, `getTransferStatus`, `decodeRgbInvoice` | MUST NOT | Read-only; a page may poll them |
| `blindReceive` | MUST | Creates an invoice that binds a UTXO |
| `issueAsset` | MUST | Mints; MAY also require a separate wallet capability |
| `sendAsset` | MUST | Moves assets |
| `burnAsset` | MUST | Burns assets |
| `getConsignment` | MUST unless already approved | Shares a consignment with a third party to verify a burn proof |
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
  `issueAsset` only when the runtime can mint. `burnAsset` and `getConsignment`
  are optional and MAY be absent from the provider object when unsupported;
  dApps MUST check both the method list and their presence.
- **`getAddress()`** returns a Bitcoin address of the wallet that anchors its
  RGB state. It is not an RGB invoice.
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
- **`issueAsset({ schema, ticker, name, amounts, precision? })`** mints.
  `schema` is `"nia"`, `"uda"` or `"cfa"`; a wallet that cannot serve a schema
  MUST reject with `METHOD_NOT_SUPPORTED` rather than substituting another.
- **`sendAsset(args)`** takes either `{ invoice }` (preferred) or the explicit
  `{ assetId, amount, recipientId }`. It returns at least the wallet's handle
  on the transfer — `txid` and/or `transferId` — so the page can track it.
  A wallet MAY refuse `{ invoice }` for an any-amount invoice, since nothing
  in the request fixes what leaves the wallet; it MUST then reject with
  `INVALID_PARAMS`, and the explicit form is how a page pays one.
- **`burnAsset({ network, assetId, amount, burnRecipient, … })`** burns a BFA
  (bridged fungible asset) and returns `txid` and `transferId` after broadcast.
  `amount` is a positive u64 decimal string in base units; `network` MUST
  match the connected RGB network. `burnRecipient` identifies the EVM chain
  and address. The wallet MUST validate the bridge route and show the asset,
  amount, destination and Bitcoin fee in its confirmation. A dApp MUST NOT
  automatically repeat a burn after a timeout.
- **`getConsignment({ assetId, txid })`** returns the saved burn consignment
  as Base64, with its byte length and digest as defined in `index.d.ts`.
  The consignment can be shared with a third party, such as a bridge, to
  verify the burn proof. The wallet MUST obtain consent to share this proof
  with the requesting dApp and explain that it may be forwarded to a third
  party; consent already given for that proof and dApp MAY be reused until
  revoked. The result MUST contain the proof bytes, not a local file path,
  and retrieval MUST NOT perform another burn.
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
| `INTERNAL_ERROR` | Anything else; `message` carries the detail |

A wallet SHOULD reject bad arguments with `INVALID_PARAMS` before raising any
confirmation. A code a wallet's own backend produces MUST be mapped onto this
table, never forwarded as-is. A dApp MUST treat a code it does not recognise
as `INTERNAL_ERROR`: older wallets predate `INVALID_PARAMS` and
`ASSET_NOT_FOUND`, and later versions may add codes.

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

It never issues, sends or creates an invoice, so it raises no confirmation and
costs nothing to run against a funded wallet. It checks advertised burn
methods without calling `burnAsset()` or sharing a consignment.

## 8. Changes

This document and `index.d.ts` version together. A method added to the
interface is a minor version of the package; a changed signature is a major
one. Where a wallet and this document disagree, the wallet is what pages see —
[open an issue](https://github.com/UTEXO-Protocol/webrgb/issues).

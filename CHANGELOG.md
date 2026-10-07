# Changelog

All notable changes to `@utexo/webrgb` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `witnessReceive()` provider method, types and mock invoice support.
- Optional `signMessage(message)` method and mock signer callback.
- Optional `burnAsset()` and `getConsignment()` types and specification for
  BFA burns and sharing their proofs with third parties, with user consent.
- Type coverage and read-only checks for the optional methods.
- A short integration guide for dApp and wallet developers, with mint/burn examples.

### Changed

- Rename the UTEXO fork to `@utexo/webrgb`, starting at version `0.1.0`.
  WalletConnect is maintained in the separate `@utexo/webrgb-walletconnect` project.

The entries below describe upstream `@kaleidorg/webrgb` releases.

## [0.3.0] - 2026-09-26

Resolves [#2](https://github.com/kaleidoswap/webrgb/issues/2) and
[#4](https://github.com/kaleidoswap/webrgb/issues/4). The KaleidoSwap
extension serves the new behaviour from its first release after 0.3.0;
extension 0.3.0 itself still requires `assetId` and predates the new codes.

### Added

- `blindReceive()` takes an optional `assetId`. Omitting it asks for an invoice
  that accepts any asset, which is the only way to receive an asset the wallet
  has never held ([#2](https://github.com/kaleidoswap/webrgb/issues/2)).
- `RgbBlindReceiveResult.minConfirmations`: the confirmations the wallet will
  actually wait for. SPEC.md recommends at least 3: reorgs are not handled, and
  a reorged-out transfer loses the received assets. A wallet raises a lower
  request to its floor, and now says so.
- Error codes `INVALID_PARAMS` (a malformed or out-of-range argument, rejected
  before any prompt) and `ASSET_NOT_FOUND` (an asset the wallet does not know).
  An unknown asset id used to be indistinguishable from a malformed one.
- `createMockProvider({ minConfirmationsFloor })`.
- SPEC.md: a fungible assignment of `0` is an any-amount invoice, read the
  same way as `Assignment::Any`. Refusing `sendAsset({ invoice })` for an
  any-amount invoice uses `INVALID_PARAMS`
  ([#4](https://github.com/kaleidoswap/webrgb/issues/4)).

### Changed

- `ProviderErrorCode` has two more members, so a `switch` that must be total
  now needs cases for them. A dApp must still treat an unrecognised code as
  `INTERNAL_ERROR`: wallets older than this version never send the new ones.
- The mock rejects an unknown asset with `ASSET_NOT_FOUND` and a malformed
  asset id or invoice with `INVALID_PARAMS`, where it used `INTERNAL_ERROR`.

## [0.2.0] - 2026-09-21

The KaleidoSwap extension 0.3.0 is the first release that injects
`window.rgb`, so this is the first version with a shipped provider to mirror.

### Added

- `SPEC.md`: the interface contract, separated from any one implementation —
  including which calls may raise a confirmation and which must not.
- Discovery, EIP-6963 style: `listProviders()`, `onProviderAnnounced()` and
  `announceProvider()` over the `rgb:requestProvider` / `rgb:announceProvider`
  events, so two installed wallets no longer race for the single `window.rgb`
  slot. `requestProvider()` now resolves from an announcement as well.
- `@kaleidorg/webrgb/mock`: `createMockProvider()` and `installMockProvider()`,
  an in-memory wallet that enforces the same rules as a real one, so a dApp can
  be built and tested with nothing installed.
- `@kaleidorg/webrgb/conformance`: `runConformance()` and `formatReport()`,
  read-only checks a wallet can run against itself.
- `isProviderError()`, `providerErrorCode()` and `RGB_ERROR_CODES`, so handling
  a rejection no longer needs a cast — the error a page catches is a plain
  `Error` and `instanceof` never worked.
- `supports(info, method)` and the `RgbMethod` union for typed feature
  detection; `toAssetArray()` / `toTransferArray()` for wallets that wrap their
  lists.
- `decodeRgbInvoice(invoice)`: read what an invoice asks for before sending
  against it — read-only, no confirmation, `amount: null` for an any-amount
  invoice. Served by the extension from 0.3.1.
- `requestProvider({ enable: true })`, and `timeoutMs: 0` for "do not wait".
- Runtime tests (`node --test`), a NodeNext type-check of the published
  `exports` map, and `attw` + `publint` over the packed tarball.

### Changed

- `listAssets()`, `listTransfers()` and `sendAsset()` are typed to what a
  wallet actually returns (`RgbAsset`, `RgbTransfer`, `RgbSendAssetResult`)
  instead of `unknown`. Narrowing a list now needs `toAssetArray()` /
  `toTransferArray()`.
- `getInfo().methods` is `RgbMethod[]`; `protocol` admits a string a future
  runtime may introduce.
- The playground gained discovery, conformance and the mock wallet, so it is
  useful without an extension installed.

## [0.1.0] - 2026-09-15

First cut of the WebRGB declarations, mirroring the `window.rgb` provider the
KaleidoSwap browser extension injects.

### Added

- `RgbProvider` and its argument and result types: `enable`, `getInfo`,
  `getAddress`, `blindReceive`, `issueAsset`, `listAssets`, `getAssetBalance`,
  `sendAsset`, `listTransfers`, `getTransferStatus`, `makeLnInvoice`,
  `payLnInvoice`, and the `transferReceived` / `transferSettled` events.
- `ProviderError` with the `USER_REJECTED`, `NOT_ENABLED`,
  `METHOD_NOT_SUPPORTED` and `INTERNAL_ERROR` codes.
- `Window` augmentation for `window.rgb` and the `rgb:ready` event.
- `requestProvider()`, which resolves `window.rgb` or waits for `rgb:ready`.

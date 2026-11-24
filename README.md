# @utexo/webrgb

**WebRGB** is the `window.rgb` provider a wallet injects into web pages so a dApp can issue, receive, send and track [RGB](https://rgb.tech) assets, and pay or receive them over Lightning, without running its own RGB backend. It sits next to [WebLN](https://www.webln.dev/) (`window.webln`) and WebBTC (`window.webbtc`) and follows the same conventions: one `enable()` consent per origin, a confirmation in the wallet for every funds-touching call, and errors that carry a `code`.

[`SPEC.md`](./SPEC.md) is the interface contract. The reference implementation is the [KaleidoSwap browser extension](https://docs.kaleidoswap.com/extensions/kaleidoswap-extension/dapp-connectivity) from 0.3.0 on. This package ships the TypeScript declarations, discovery, an in-memory mock wallet and a conformance suite.

This is the UTEXO fork of [KaleidoSwap WebRGB](https://github.com/kaleidoswap/webrgb),
renamed to `@utexo/webrgb`. See [INTEGRATION.md](./INTEGRATION.md) for dApp and
wallet integration, including mint/burn examples. WalletConnect lives in the
separate `@utexo/webrgb-walletconnect` project.

## Try it

The [upstream playground](https://kaleidoswap.github.io/webrgb/) imports the upstream module and exercises every `window.rgb` method, with a live log of calls, results and error codes. Drive it against the extension with a signet or regtest wallet — or press **install mock wallet** and use it with nothing installed at all.

## Install

```bash
npm install @utexo/webrgb
```

Importing anything from the package augments `Window`, so `window.rgb` is typed everywhere. For WebLN typings use `@webbtc/webln-types`; for NIP-07 use `nostr-tools`.

## Usage

```ts
import { requestProvider, isProviderError, supports, toAssetArray } from "@utexo/webrgb";

try {
  // Waits for the wallet if the page ran first; `enable` connects the origin.
  const rgb = await requestProvider({ enable: true });

  const info = await rgb.getInfo();
  // { ready, network, protocol: "RGB_L1" | "RGB_LN", methods: [...] }

  const assets = toAssetArray(await rgb.listAssets());
  const { invoice } = await rgb.blindReceive({ assetId: assets[0].id!, amount: 1 });

  if (supports(info, "makeLnInvoice")) {
    const ln = await rgb.makeLnInvoice({ assetId: assets[0].id!, assetAmount: 5 });
    console.log("pay me over Lightning:", ln.invoice);
  }

  rgb.on("transferSettled", (t) => console.log("settled", t.transferId));
} catch (err) {
  if (isProviderError(err) && err.code === "USER_REJECTED") return; // the user said no
  throw err;
}
```

## Surface

| Method | Purpose |
|--------|---------|
| `enable()` / `getInfo()` | Connect the origin; learn network, runtime and served methods |
| `getAddress()` | Bitcoin address that anchors the wallet's RGB state |
| `signMessage(message)` | Sign a message with user approval |
| `blindReceive(args?)` | Blinded-UTXO receive invoice; omit `assetId` for any asset, including one the wallet has never held |
| `witnessReceive(args?)` | Witness receive invoice: the sender funds the UTXO, so it works on an empty wallet |
| `createUtxos(args?)` | Consented creation of colorable UTXOs |
| `cancelReceive(recipientId)` | Cancel a pending receive and release its UTXO |
| `getBtcBalance()` | Aggregate bitcoin balances; no outpoint disclosure |
| `refresh(assetId?)` | Transfer refresh; backend failures reject |
| `getAssetMetadata(assetId)` | Contract metadata with exact string-valued initial supply |
| `signPsbt(psbt, opts?)` | Sign the wallet's bitcoin-only inputs in a PSBT |
| `issueAsset(args)` | Mint a new asset (gated by its own wallet capability) |
| `listAssets()` / `getAssetBalance(id)` | Holdings |
| `sendAsset(args)` | Send against an RGB invoice, or explicitly |
| `burnAsset(args)` / `getConsignment(args)` | BFA extensions: asset burns and consignment sharing for third-party proof verification |
| `getReceivedMint({ invoice })` | Owned-invoice validation before a bridge deposit; returns a validated commitment or `null` while pending |
| `listTransfers(id?)` / `getTransferStatus(id)` | Transfer history and status |
| `decodeRgbInvoice(invoice)` | What an invoice asks for, before you pay it — read-only, no prompt |
| `makeLnInvoice(args)` / `payLnInvoice(args)` | RGB over Lightning; listed in `methods` only when the wallet has a Lightning node |
| `on` / `off` | `transferReceived` and `transferSettled` events |

Every method is always present on the provider. Not every wallet serves every
method: check `supports(await rgb.getInfo(), method)` first. A method the
wallet does not list rejects with `METHOD_NOT_SUPPORTED`.

Feature-detect with `supports(info, method)` rather than assuming a method exists: a node-less wallet rejects the Lightning methods with `METHOD_NOT_SUPPORTED`.

`listAssets()` and `listTransfers()` are typed wide because wallets differ on whether they wrap the array — pass them through `toAssetArray()` / `toTransferArray()`.

### Burn migration

Version `0.1.6` introduces a breaking burn contract change. `RgbBurnAssetArgs` and
`RgbBurnAssetResult` carry one required `burnDestination`; `burnRecipient` and
`RgbBurnRecipient` are removed. The destination requires `version: 1`, a native address and
explicit route endpoint, which the wallet validates before confirmation. See
[the migration guide](./INTEGRATION.md#burn-contract-migration) before updating
wallet, SDK or WalletConnect integrations. Existing provider implementations do
not gain support by installing newer types.
## Receiving into an empty wallet

A blinded invoice needs a free colorable UTXO. A fresh wallet, or one whose UTXOs all hold assets, has none and rejects with `NO_AVAILABLE_UTXOS`. A faucet-style page can then ask the wallet to create some, or fall back to a witness invoice, which the sender funds:

```ts
import { providerErrorCode, supports } from "@utexo/webrgb";
import type { RgbInfo, RgbProvider } from "@utexo/webrgb";

async function receiveInvoice(rgb: RgbProvider, info: RgbInfo): Promise<string> {
  try {
    return (await rgb.blindReceive()).invoice;
  } catch (err) {
    if (providerErrorCode(err) !== "NO_AVAILABLE_UTXOS") throw err;
    if (supports(info, "witnessReceive")) return (await rgb.witnessReceive()).invoice;
    await rgb.createUtxos(); // spends on-chain bitcoin; the wallet asks first
    return (await rgb.blindReceive()).invoice;
  }
}
```

`getBtcBalance().freeColorableUtxos` is a hint up front (zero does not prove a blinded receive will fail: rgb-lib may use a free allocation slot on an occupied UTXO), and `cancelReceive(recipientId)` releases the UTXO an abandoned invoice reserved.

## Signing PSBTs

`signPsbt(psbt)` signs only inputs the wallet controls, and only bitcoin-only ones. Spending a UTXO that carries RGB assets outside an RGB state transition destroys the assets, so a wallet rejects such a PSBT with `UNSAFE_PSBT` before showing a prompt. Do not build PSBTs over the wallet's colored UTXOs; RGB-aware PSBT flows are for a later version.

## Discovery

`window.rgb` is a single slot, so two installed wallets cannot both own it. Wallets also announce themselves, EIP-6963 style, and `listProviders()` collects the answers:

```ts
import { listProviders } from "@utexo/webrgb";

for (const { info, provider } of await listProviders()) {
  console.log(info.name, info.rdns); // show a picker, then use `provider`
}
```

`requestProvider()` resolves whichever comes first — an installed `window.rgb`, an announcement, or the legacy `rgb:ready` event — so a dApp that wants one wallet needs nothing else.

Wallet side, one call joins discovery:

```ts
import { announceProvider } from "@utexo/webrgb";

announceProvider({
  info: { uuid: crypto.randomUUID(), name: "Example", rdns: "com.example.wallet" },
  provider,
});
```

## Building without a wallet

`@utexo/webrgb/mock` is an in-memory provider that enforces the same rules a real one does — `NOT_ENABLED` before `enable()`, `METHOD_NOT_SUPPORTED` for anything absent from `getInfo().methods`, a confirmation step you can make refuse:

```ts
import { createMockProvider, installMockProvider, mockPsbt } from "@utexo/webrgb/mock";

// In a test:
const rgb = createMockProvider({ protocol: "RGB_LN", assets: [{ id: "rgb:x", balance: 100 }] });
await rgb.enable();
const sent = await rgb.sendAsset({ assetId: "rgb:x", amount: 1, recipientId: "utxob:y" });
rgb.settle(sent.transferId!); // fires transferSettled
expect(rgb.calls.map((c) => c.method)).toContain("sendAsset");

// signPsbt cannot really sign; it reads PSBTs built with mockPsbt().
await rgb.signPsbt(mockPsbt({ inputs: [{ mine: true }] }));

// In a dev build: put it on window.rgb and let the app find it as usual.
const { uninstall } = installMockProvider();
```

Pass a `signMessage` callback to `createMockProvider` to enable signing in tests.

## Conformance

`@utexo/webrgb/conformance` checks a live wallet against `SPEC.md` using read-only calls only, so it raises no confirmation:

```ts
import { runConformance, formatReport } from "@utexo/webrgb/conformance";

console.log(formatReport(await runConformance(window.rgb!)));
```

## Errors

| Code | Meaning |
|------|---------|
| `USER_REJECTED` | The user declined the connection or the confirmation prompt |
| `NOT_ENABLED` | Called before `enable()` resolved for this origin |
| `METHOD_NOT_SUPPORTED` | The connected wallet cannot serve this method, or no provider was found |
| `INVALID_PARAMS` | An argument is malformed or out of range; `error.message` names it |
| `ASSET_NOT_FOUND` | The call names an asset the wallet does not know — for `blindReceive`, omit `assetId` |
| `NO_AVAILABLE_UTXOS` | No available RGB allocation slot; create UTXOs or use a witness invoice |
| `UNSAFE_PSBT` | `signPsbt` was asked to sign an input that holds RGB assets |
| `INTERNAL_ERROR` | Anything else; see `error.message` |

The error crosses a `postMessage` boundary on its way out of the wallet, so what you catch is a plain `Error` carrying `code` — `instanceof` will not help. Use `isProviderError(err)`, or `providerErrorCode(err)` for a `switch` that must be total.

## Versioning

`@utexo/webrgb` starts at `0.1.0` and is versioned independently of the upstream package. Each release is based on one upstream `@kaleidorg/webrgb` version:

| `@utexo/webrgb` | Upstream base |
| --- | --- |
| 0.1.0 – 0.1.5 | 0.3.0 |
| 0.1.6 – 0.1.7 | 0.3.0, with `createUtxos`, `getBtcBalance`, `refresh` and `getAssetMetadata` ported from 0.4.0 |
| 0.2.0 | 0.5.0 |

The [changelog](./CHANGELOG.md) states the base of every release.

The declarations mirror `SPEC.md` and the extension's `src/injected.ts`. A method added to the provider lands here as a minor bump; a changed signature as a major bump. If the two disagree, trust the wallet and open an issue.

## Development

```bash
npm install
npm test           # tsc over the declarations and index.js, plus the runtime tests
npm run test:package   # are-the-types-wrong + publint against the packed tarball
```

## License

MIT

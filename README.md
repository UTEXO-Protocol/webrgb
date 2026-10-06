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
| `signMessage(message)` | Optional LND-compatible message signature, with per-call confirmation |
| `blindReceive(args?)` | Blinded-UTXO receive invoice; omit `assetId` for any asset, including one the wallet has never held |
| `issueAsset(args)` | Mint a new asset (gated by its own wallet capability) |
| `listAssets()` / `getAssetBalance(id)` | Holdings |
| `sendAsset(args)` | Send against an RGB invoice, or explicitly |
| `burnAsset(args)` / `getConsignment(args)` | Optional BFA extensions: asset burns and consignment sharing for third-party proof verification |
| `listTransfers(id?)` / `getTransferStatus(id)` | Transfer history and status |
| `decodeRgbInvoice(invoice)` | What an invoice asks for, before you pay it — read-only, no prompt |
| `makeLnInvoice(args)` / `payLnInvoice(args)` | RGB over Lightning; listed in `methods` only when the wallet has a Lightning node |
| `on` / `off` | `transferReceived` and `transferSettled` events |

Feature-detect with `supports(info, method)` rather than assuming a method exists:
a node-less wallet rejects Lightning payments with `METHOD_NOT_SUPPORTED`, but
may support `signMessage`. Optional methods also need a presence check.

`listAssets()` and `listTransfers()` are typed wide because wallets differ on whether they wrap the array — pass them through `toAssetArray()` / `toTransferArray()`.

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
import { createMockProvider, installMockProvider } from "@utexo/webrgb/mock";

// In a test:
const rgb = createMockProvider({ protocol: "RGB_LN", assets: [{ id: "rgb:x", balance: 100 }] });
await rgb.enable();
const sent = await rgb.sendAsset({ assetId: "rgb:x", amount: 1, recipientId: "utxob:y" });
rgb.settle(sent.transferId!); // fires transferSettled
expect(rgb.calls.map((c) => c.method)).toContain("sendAsset");

// In a dev build: put it on window.rgb and let the app find it as usual.
const { uninstall } = installMockProvider();
```

To exercise message signing in the mock, supply a `signMessage` callback to
`createMockProvider`. It receives the unchanged message after access,
argument and confirmation checks. Without it, signing is unsupported;
the mock does not generate cryptographic signatures.

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
| `INTERNAL_ERROR` | Anything else; see `error.message` |

The error crosses a `postMessage` boundary on its way out of the wallet, so what you catch is a plain `Error` carrying `code` — `instanceof` will not help. Use `isProviderError(err)`, or `providerErrorCode(err)` for a `switch` that must be total.

## Versioning

`@utexo/webrgb` starts at `0.1.0` and is versioned independently of the upstream package.

The declarations mirror `SPEC.md` and the extension's `src/injected.ts`. A method added to the provider lands here as a minor bump; a changed signature as a major bump. If the two disagree, trust the wallet and open an issue.

## Development

```bash
npm install
npm test           # tsc over the declarations and index.js, plus the runtime tests
npm run test:package   # are-the-types-wrong + publint against the packed tarball
```

## License

MIT

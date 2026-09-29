# Integrating a wallet

WebRGB gives dApps a common interface to an RGB wallet. Your wallet can use
any SDK, whether native, WASM or HTTP-based; the provider adapts it to the
methods in [SPEC.md](./SPEC.md). The BFA methods below are UTEXO proposals.

## Connecting

A browser extension injects a provider and answers WebRGB discovery. The dApp
selects a wallet and calls `enable()` to request access.

A mobile wallet can expose the same methods through a transport such as
WalletConnect. The dApp displays a connection QR code or opens a deep link;
the wallet asks the user to approve the connection. The dApp then uses a local
provider object whose calls are forwarded to the phone. This package provides
browser discovery; a WalletConnect adapter is separate work.

Connection approval does not approve a burn or the sharing of a consignment.
Those calls follow the consent rules in SPEC.md.

## Adapting your SDK

Your SDK's methods do not need WebRGB names. For example, a wallet using
`bReceive` can expose it as `blindReceive`:

```js
async function blindReceive(args = {}) {
  requireEnabledOrigin();
  validateReceiveArgs(args);
  await confirmReceive(args);
  return myWallet.bReceive(args);
}
```

The helpers above belong to your wallet app. This example assumes `bReceive`
accepts WebRGB arguments and returns `RgbBlindReceiveResult`; map the fields
if your SDK uses a different format. Preserve the requested asset and amount,
and map backend errors to WebRGB error codes.

## Mint and burn

For mint, the dApp calls `blindReceive()`, the user approves the invoice in the
wallet, and the returned invoice is sent to the bridge or faucet. `issueAsset()`
creates a new asset; it is not used to receive an existing bridge asset.

For burn, check that the wallet supports both optional methods. Here `args`
follows `RgbBurnAssetArgs`, and `saveBurn` stores the result in the dApp:

```ts
import { supports } from "@kaleidorg/webrgb";

await provider.enable();
const info = await provider.getInfo();
if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
    !provider.burnAsset || !provider.getConsignment) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const burn = await provider.burnAsset(args);
await saveBurn(burn);
const proof = await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
```

With the user's consent, the dApp can share `proof.data` with a third party,
such as a bridge, to verify the burn proof. The bridge integration handles
Bitcoin confirmation requirements, unlock submission and payout tracking.

Track the burn with `getTransferStatus(burn.transferId, burn.assetId)`. Proof
retrieval can be retried using the saved txid. If the burn call times out,
check the wallet's history before requesting another burn.

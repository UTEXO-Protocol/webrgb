# Integrating dApps and wallets

WebRGB defines the calls between a dApp and a wallet. The dApp uses a
`RgbProvider`; the wallet implements its methods and handles user consent.
Browser extensions and mobile wallets use the same method signatures.
The BFA methods and message signing below are additions in this UTEXO fork.

## For dApp developers

For a browser extension, discover the provider injected into the page:

```ts
import { requestProvider } from "@utexo/webrgb";

const provider = await requestProvider({ enable: true });
```

For a mobile wallet, use a transport adapter to obtain the same provider
interface. The dApp displays a connection QR or opens a deep link, and the
user approves in their wallet. `@utexo/webrgb-walletconnect` is a separate
project with its own setup and transport documentation.

For mint, request an invoice and pass it to the bridge or faucet:

```ts
const { invoice } = await provider.blindReceive({ assetId, amount: 5 });
```

For witness receiving, use `provider.witnessReceive({ assetId, amount: 5 })`.
It returns the same fields; the sender creates the receiving output.

`issueAsset()` creates a new asset; it is not used to receive an existing
bridge asset. For burn, check capabilities before calling the optional methods:

```ts
import { supports } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
    !provider.burnAsset || !provider.getConsignment) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const burn = await provider.burnAsset(args); // RgbBurnAssetArgs
await saveBurn(burn); // persist the result in your dApp
const proof = await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
```

With consent, share `proof.data` (Base64) with a third party to verify the
burn proof. The receiving service handles confirmations, proof verification
and any payout. Track the burn with
`getTransferStatus(burn.transferId, burn.assetId)`. Proof retrieval can be
retried using the saved txid. If a burn times out, check wallet history before
requesting another burn.

To sign a message, check support and request a signature:

```ts
if (supports(await provider.getInfo(), "signMessage") && provider.signMessage) {
  const { signature } = await provider.signMessage(message);
}
```

The wallet asks for approval. Your backend can verify the returned signature.

## For wallet developers

Implement the methods in [SPEC.md](./SPEC.md) in your wallet app. For example,
`blindReceive` validates the request, asks the user to confirm, creates an
invoice through your wallet backend and returns `RgbBlindReceiveResult`.
Your backend can be native, WASM or a node API; dApps do not call it directly.
Map its arguments, results and errors to WebRGB.

An extension injects this provider and joins discovery (§1–2 in the spec).
A mobile wallet attaches it to a transport adapter. Keep access scoped to the
approved dApp. Connection approval does not approve a burn or the sharing of
a consignment or message signing; each method follows the consent rules in
the specification.

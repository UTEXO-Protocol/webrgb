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
bridge asset. For burn, check capabilities before calling the optional methods.
The following example uses the base interface only. A bridge requiring V1 must
also negotiate and supply its destination extension before calling `burnAsset`,
as described below; namespace support alone is insufficient:

```ts
import { supports } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
    !provider.burnAsset || !provider.getConsignment) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const namespace = args.burnRecipient.chainId.split(":")[0];
if (!(info.burnRecipientNamespaces ?? ["eip155"]).includes(namespace)) {
  throw new Error("Unsupported burn recipient namespace");
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

### Bridge V1 destination commitments

The base `RgbBurnRecipient.address` is a native address, not a universal proof
encoding. The legacy raw-account profile pads a 20-byte account with 12 zero
bytes; for Tron it drops the validated native version byte. That legacy value
does not bind a payout chain or endpoint.

For a V1 bridge, require the application's `burnDestinationVersion: 1`
extension and match the exact `chainId`/`dstEid` in `burnDestinationRoutes`.
Construct the application-owned `burnDestination` preimage from the approved
route and native address. EVM uses 20 account bytes; Tron uses the full 21-byte
decoded payload including `0x41`, with its checksum excluded. V1 hashes these
as dynamic recipient bytes and binds the destination chain and endpoint in a
32-byte commitment; see [SPEC.md §4.1](./SPEC.md#41-bfa-destination-encoding-profiles)
for the exact hashStruct. Do not pad or truncate the Tron payload to the legacy
account encoding, infer an endpoint, or fall back when the wallet lacks V1.

Persist the exact approved preimage and burn result before later submission or
proof sharing. Match that preimage in responses and portable exports, and use
the saved proof for recovery rather than repeating the burn. Capability
negotiation and commitment validation do not prove funded payout settlement.

These V1 fields and encoding are supplied by the wallet/bridge integration;
this package's runtime and base type signatures do not implement or advertise
them. Use the integration's explicit V1 types, encoder, route policy and
independent commitment vectors.

To sign a message, check support and request a signature:

```ts
if (supports(await provider.getInfo(), "signMessage") && provider.signMessage) {
  const { signature } = await provider.signMessage(message);
}
```

The wallet asks for approval. Your backend can verify the returned signature.

### Checking a prepared mint

Request `getReceivedMint` when connecting if your transport negotiates method
access. Enable the provider and create an invoice with the selected `assetId`;
an any-asset invoice is rejected. Pass the invoice unchanged to the bridge to
prepare the mint, then check the wallet's result:

```ts
import { supports } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "getReceivedMint") || !provider.getReceivedMint) {
  throw new Error("This wallet cannot check a prepared mint");
}
const { invoice } = await provider.witnessReceive({ assetId });
await prepareMint(invoice); // application-specific bridge preparation
const receipt = await provider.getReceivedMint({ invoice });
```

A receipt can omit `txid` until the wallet links the receive to its witness
transaction, which may happen only after the lock is paid. Do not wait for
`txid` before payment: match `lockId`, which already commits to that transaction.

A `null` result is pending. Poll the same invoice without requesting another
confirmation. Handle rejected calls separately. Before paying:

1. Compare the receipt's exact invoice, network, asset, net RGB amount, lock
   ID, EVM chain ID, bridge contract and deadline against the prepared mint.
   `opid` identifies an RGB transition. Use the bridge's own operation ID
   separately for tracking.
2. Independently verify the current EVM chain, lock contract and exclusive
   block deadline for deposit inclusion. Use the bridge's deposit terms for
   the gross EVM amount. The receipt's `amount` is the net RGB base-unit amount.
3. Request the receipt again immediately before payment after any asynchronous
   approval, and repeat the checks. Discard the receipt if the session, account,
   network, invoice or mint preparation changes.

For example, [rgb-lib-bfa BFA.8 can retain an earlier checked mint](https://github.com/UTEXO-Protocol/rgb-lib-bfa/blob/2f7b21d8637baad548504ea870deb2c0d4d0a37d/src/wallet/offline.rs#L3458-L3509)
across a reject-list change so an existing lock can complete. A successful
read does not establish settlement, fresh reject-list acceptance or EVM
connectivity.

#### Legacy browser providers

Some builds of the UTEXO browser extension advertise a recipient-only
`getReceivedMint(recipientId)`. For those builds, use the extension's
`getReceivedMintForInvoice({ recipientId, invoice })` through a wallet-specific
adapter that supplies the full invoice and its bound recipient. Never fall back
to a recipient-only lookup for pre-deposit verification. The extension excludes
the legacy method from its WalletConnect namespace.

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

For `getReceivedMint`, validate and bind the full, asset-specific invoice before
using any native recipient-only lookup. Reject any-asset invoices with
`INVALID_PARAMS`. The validated consignment must match the invoice's asset;
do not wait for an asset association or transaction ID in transfer history
before returning the checked mint. Native proof validation is the wallet's
responsibility. The WebRGB package and its mock do not validate RGB proofs.

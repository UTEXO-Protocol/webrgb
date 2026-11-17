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
bridge asset. A burn caller uses the single-destination contract:

```ts
import { supports, type RgbBurnAssetArgs } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
    !provider.burnAsset || !provider.getConsignment) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const args: RgbBurnAssetArgs = {
  network: info.network,
  assetId,
  amount: "1000000",
  burnDestination: {
    chainId: "eip155:137",
    address: "0x1111111111111111111111111111111111111111",
    dstEid: 30109,
  },
  feeRate: 2,
  minConfirmations: 6,
};
const namespace = args.burnDestination.chainId.split(":")[0];
if (!(info.burnRecipientNamespaces ?? ["eip155"]).includes(namespace)) {
  throw new Error("Unsupported burn recipient namespace");
}
const burn = await provider.burnAsset(args);
await saveBurn(burn); // Persist the approved destination and transaction ID.
const proof = await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
```

Use this example only with a wallet/transport integration known to implement
this contract. The wallet validates the route using its own configuration,
shows the destination for approval and derives the commitment in SPEC §4.1.
The SDK/native boundary receives asset ID, exact amount, that 32-byte hash
(`burn_reason` in rgb-lib), fee rate and confirmation count. In the RN binding,
the amount and fee are decimal strings and the hash has no `0x` prefix.

With consent, share the proof and approved destination with the bridge. It must
verify the commitment, asset, amount, transaction and payout parameters. A burn
result is not a payout receipt. After a timeout, inspect wallet history and
recover the existing proof rather than requesting another burn.

### Burn contract migration

This is a breaking request/result change from `@utexo/webrgb@0.1.5`:

- Replace `burnRecipient` and any second destination object with the single
  `{ chainId, address, dstEid }` destination, in both requests and results.
- The request carries a native address. The wallet derives numeric chain ID and
  address bytes internally; the bridge hash algorithm itself stays unchanged.
- Do not require `burnDestinationVersion` or `burnDestinationRoutes` in getInfo.
  The wallet must reject a missing/unsupported endpoint before confirmation.
- Upgrade the wallet implementation, SDK facade, dApp and transport binding
  together. Update package peers and existing transport profile negotiation
  before use; merely replacing TypeScript declarations changes no wallet code.
- The presence of `burnAsset` in `methods` alone cannot distinguish a 0.1.x
  wallet. Use an explicitly supported provider build/transport contract. Never
  probe compatibility by attempting a burn, send both formats, or retry using
  the old format after a failure.
- Keep recovery for already recorded burns separate: their original commitment
  and saved preimage must not be rewritten using new defaults.

### Native mapping for the selected upstream APIs

Compared upstream WebRGB `main` at `b4c9485` with rgb-lib BFA.8 (the RN pin
`cafe66e`) and the latest published BFA/swaps release
`v0.3.0-beta.8-upstream-dev-bfa-swaps.1` (`14c114c`). The methods below are
optional: an older provider need not expose them, and an adapter must advertise
only methods it actually implements.

| WebRGB method | Native mapping and wallet responsibility |
| --- | --- |
| `createUtxos` | `create_utxos`, with `up_to = false`; validate backend bounds, obtain consent, return actual count and selected size/fee. |
| `getBtcBalance` | `get_btc_balance`; obtain the empty, unreserved colorable count separately, or return null. Do not infer failure from zero: rgb-lib can allocate on occupied outputs. |
| `refresh` | `refresh`; derive `refreshed` from `updated_status` and inspect every in-scope `failure`. A native call can succeed while individual transfers fail. |
| `getAssetMetadata` | `get_asset_metadata`; map `initial_supply` to the exact decimal `issuedSupply`, not `known_circulating_supply` or a wallet balance. Map schema names and public media metadata, never local paths. |

Unlike upstream's number-valued `issuedSupply`, this fork uses a string because
native supply is u64. Convert directly from the native integer/string; converting
an already rounded JavaScript number to a string cannot recover its precision.

Two upstream methods are deliberately not adopted here. `cancelReceive` is a
policy operation over transfer lookup and `fail_transfers`, not a direct native
recipient-ID cancellation: even a waiting receive containing a verified BFA mint
cannot be failed arbitrarily before its lock expires. `signPsbt` needs wallet-owned
PSBT parsing, ownership and live RGB allocation checks before signing; a generic
native signer does not provide that WebRGB contract. Both need dedicated adapter
work and tests before they are advertised. `witnessReceive` and `signMessage`
were already present in this fork.

### Signing a message

Check support before requesting a signature:

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

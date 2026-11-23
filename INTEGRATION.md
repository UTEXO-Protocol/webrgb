# Integrating dApps and wallets

dApps call a `RgbProvider`; wallets implement its methods and user consent.
Browser extensions and mobile wallets use the same interface.

## For dApp developers

For a browser extension, discover the provider injected into the page:

```ts
import { requestProvider } from "@utexo/webrgb";

const provider = await requestProvider({ enable: true });
```

For mobile wallets, obtain the provider through a transport adapter such as
`@utexo/webrgb-walletconnect`; follow its connection and authorization setup.

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
if (!supports(info, "burnAsset") || !supports(info, "getConsignment")) {
  throw new Error("This wallet does not support BFA burn proofs");
}
const args: RgbBurnAssetArgs = {
  network: info.network,
  assetId,
  amount: "1000000",
  burnDestination: {
    version: 1,
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

Use a wallet and transport that implement this burn contract. The wallet
validates the destination before approval and computes the commitment in
[SPEC §4.1](./SPEC.md#41-burn-destination-commitment). The bridge verifies the
proof against the approved asset, amount, transaction and destination before payout.
After a timeout, recover the saved burn from wallet history; do not burn again.

### Burn contract migration

- Replace `burnRecipient` and any separate destination object with one
  `burnDestination: { version: 1, chainId, address, dstEid }` in requests and results.
  The version is required; missing or unsupported versions reject before confirmation.
  Use the native address; the commitment algorithm is unchanged.
- Do not require `burnDestinationVersion` or `burnDestinationRoutes` in
  `getInfo()`. The wallet validates route support before confirmation.
- Update the wallet, SDK, dApp and transport together, including dependency
  constraints and transport negotiation. The `burnAsset` method name alone
  does not identify this contract. Never probe compatibility by burning,
  send both formats or retry with the legacy format.
- Preserve the original commitment and destination when recovering older burns.

### Signing a message

Check support before requesting a signature:

```ts
if (supports(await provider.getInfo(), "signMessage")) {
  const { signature } = await provider.signMessage(message);
}
```

The wallet asks for approval. Your backend can verify the returned signature.

### Checking a prepared mint

Request `getReceivedMint` when connecting if your transport negotiates method
access. Enable the provider and create an invoice with the selected `assetId`.
A wallet that has never held the asset rejects that with `ASSET_NOT_FOUND`; only
then request an invoice without an asset. Pass the invoice unchanged to the
bridge to prepare the mint, then check the wallet's result:

```ts
import { providerErrorCode, supports } from "@utexo/webrgb";

const info = await provider.getInfo();
if (!supports(info, "getReceivedMint")) {
  throw new Error("This wallet cannot check a prepared mint");
}

async function createMintInvoice(assetId: string): Promise<string> {
  try {
    return (await provider.witnessReceive({ assetId })).invoice;
  } catch (error) {
    if (providerErrorCode(error) !== "ASSET_NOT_FOUND") throw error;
    return (await provider.witnessReceive()).invoice;
  }
}

const invoice = await createMintInvoice(assetId);
await prepareMint(invoice); // application-specific bridge preparation
const receipt = await provider.getReceivedMint({ invoice });
if (receipt && receipt.assetId !== assetId) {
  throw new Error("The validated mint is for a different asset");
}
```

`null` means pending; poll the same invoice without additional consent and
handle errors separately. A wallet that cannot prove the asset of an any-asset
invoice rejects it with `INVALID_PARAMS`; do not pay in that case. `txid` may be
absent before payment; match `lockId` instead, which already commits to the
witness transaction. Before paying:

1. Compare the receipt's `assetId` with the asset you selected and do not pay if
   they differ. An any-asset invoice does not restrict the asset, so this check
   is what binds the mint to your selection. Also compare the receipt's exact
   invoice, network, net RGB amount, lock ID, EVM chain ID, bridge contract and
   deadline against the prepared mint.
   `opid` identifies an RGB transition. Use the bridge's own operation ID
   separately for tracking.
2. Independently verify the current EVM chain, lock contract and exclusive
   block deadline for deposit inclusion. Use the bridge's deposit terms for
   the gross EVM amount. The receipt's `amount` is the net RGB base-unit amount.
3. Request the receipt again immediately before payment after any asynchronous
   approval, and repeat the checks. Discard the receipt if the session, account,
   network, invoice or mint preparation changes.

A receipt does not prove settlement, current reject-list acceptance or EVM
connectivity. Adapters must preserve invoice binding; never fall back to a
recipient-only lookup for pre-payment verification.

## For wallet developers

Map backend arguments, results and errors to [SPEC.md](./SPEC.md). Advertise
only implemented methods. Extensions join provider discovery; mobile wallets
use a transport adapter. Scope access to the approved dApp and apply the
per-method consent rules in SPEC §3.

For burn, validate the destination and compute its commitment before signing.
Pass the asset ID, exact amount, commitment as `burn_reason` (64 lowercase hex
characters without `0x`), fee rate, rounded up to whole sat/vB, and confirmation
count to rgb-lib.

For `getReceivedMint`, bind the full invoice to the active wallet before a
native recipient-only lookup. Return `assetId` from the consignment validated
for this mint in every receipt. Never copy it from the request, dApp state or any
other unvalidated source. If the invoice names an asset, reject a consignment for
a different one. If the wallet cannot take the asset of an any-asset invoice from
the validated consignment, reject that invoice with `INVALID_PARAMS`. Do not wait
for `assetId` or `txid` in transfer history before returning a checked mint.
Proof validation belongs to the wallet, not this package or its mock.

### Recommended `getReceivedMint` flow with rgb-lib

This flow is informative. [SPEC.md](./SPEC.md) defines the required behaviour.

1. Decode the invoice and check its network. Find the one receive of this wallet
   with the same recipient ID and the exact same invoice string.
2. Call `refresh` for incoming transfers. It reports a per-transfer `failure` in
   its result instead of throwing, so reject if this receive has one.
3. Call `get_received_mint(recipient_id)` and read the receive again. Reject if
   the receive failed. If there is no mint, reject an expired invoice and
   otherwise return `null`.
4. Take the receive's single `consignment_path` and call `inspect_consignment`
   with the `Terminals` bundle filter.
5. Require an operation of the inspected asset with a transition whose `opid`
   equals the mint's `opid`. Inspection does not validate the consignment again;
   this match ties the file to the mint rgb-lib already checked.
6. Return the inspected asset ID as `assetId`. If the invoice names an asset,
   reject a different one.

rgb-lib's `ReceivedMint` has no asset ID, and an any-asset receive is linked to
its asset only once the lock is found, so do not read `assetId` from transfer
history. A wallet that cannot inspect the consignment must reject any-asset
invoices with `INVALID_PARAMS`.

### Optional native methods

| WebRGB method | rgb-lib mapping |
| --- | --- |
| `createUtxos` | `create_utxos` with `up_to = false`; rgb-lib takes whole sat/vB, so round a fractional `feeRate` up. Obtain consent and return the actual count, size and the fee rate used. |
| `getBtcBalance` | `get_btc_balance`; count empty, unreserved colorable UTXOs separately or return null. Zero does not exclude free allocation slots on occupied outputs. Never expose outpoints. |
| `refresh` | `refresh`; derive `refreshed` from `updated_status` and reject on any in-scope per-transfer `failure`, even if the native call succeeds. |
| `getAssetMetadata` | `get_asset_metadata`; map `initial_supply` directly to the exact decimal `issuedSupply`, without conversion through a JavaScript number. Return public media metadata, never local paths. |

# Integrating a wallet

The provider contract is the same for browser and mobile wallets. The wallet
chooses its RGB backend and adapts that backend to [SPEC.md](./SPEC.md).
Installing this package provides types and browser discovery, not a wallet
engine or a WalletConnect connection. The BFA methods below are proposed
additions in the UTEXO fork and must be feature-detected.

## Browser

1. The extension injects a provider and answers WebRGB discovery.
2. The dApp chooses a provider and calls `enable()`.
3. The wallet approves the origin. Each invoice or funds-touching call gets
   its own confirmation as specified in SPEC.md.
4. The provider adapts the call to the wallet's backend and returns the
   standard result.

A WASM backend can serve these calls, but WASM does not connect two pages.
A standalone wallet website needs a remote transport or its own authenticated
page bridge. An in-app browser can inject a provider into its own WebView.

## Mobile

With a transport such as WalletConnect, the connection flow is:

1. The dApp creates a connection proposal and displays its URI as a QR code
   or opens a deep link. This is a connection URI, not an RGB invoice.
2. The wallet scans or opens it and asks the user to approve the dApp, network
   and methods.
3. The dApp's transport adapter exposes a local provider object. Calling
   `blindReceive()` sends a request to the phone; it does not inject anything
   into the desktop browser's `window.rgb`.
4. The wallet validates the approved session, asks for invoice confirmation,
   calls its backend and returns the result. The dApp fills its invoice field.

The transport binding must define its namespace, network/account identifiers,
method and argument mapping, error mapping, events, permissions and version
negotiation. It must also define expiry, reconnect, bounded proof transfer and
resume. Session metadata alone is not proof of a website's identity; the wallet
must use the transport's origin verification and show unverified requests as
such. Pairing alone does not approve an invoice, burn or proof disclosure.

This document describes those boundaries, not a finalized WalletConnect wire
profile. A transport that only implements a subset must document that subset;
it cannot claim full WebRGB conformance by implementing invoice creation alone.

## Adapting the wallet backend

A backend's method names do not have to match WebRGB. For example, a wallet
whose SDK calls invoice creation `bReceive` could use this method adapter:

```ts
import type { RgbBlindReceiveArgs, RgbBlindReceiveResult } from "@kaleidorg/webrgb";

// The backend and confirmation functions here belong to the wallet app.
async function blindReceive(args: RgbBlindReceiveArgs = {}): Promise<RgbBlindReceiveResult> {
  requireEnabledOrigin();
  validateReceiveArgs(args); // reject malformed arguments before prompting
  await confirmReceive(args); // throws USER_REJECTED if declined
  const invoice = await myWallet.bReceive({
    asset: args.assetId,
    quantity: args.amount,
    expiresIn: args.durationSeconds,
    confirmations: args.minConfirmations,
  });
  return {
    invoice: invoice.text,
    recipientId: invoice.recipient,
    expirationTimestamp: invoice.expiresAt,
    minConfirmations: invoice.confirmations,
  };
}
```

This is an illustrative mapping, not an API supplied by this package. The
wallet also handles capability checks, its confirmation floor, serialization
and error mapping. It must preserve invoice constraints; it must not silently
remove an asset or amount its backend cannot encode.

## Mint and burn

Mint uses the existing `blindReceive()` call. The dApp asks for an invoice,
the user approves in the wallet, and the returned invoice goes to the bridge
or faucet. The wallet tracks the receive with the existing transfer methods.
`issueAsset()` creates a new asset and is a separate operation.

For burn, the dApp checks both optional methods and persists the intent before
calling. The following is the provider part of the flow; `persistIntent` and
`persistBurn` represent the dApp's durable storage:

```ts
import { supports } from "@kaleidorg/webrgb";
import type { RgbBurnAssetArgs, RgbProvider } from "@kaleidorg/webrgb";

async function burnAndGetProof(provider: RgbProvider, args: RgbBurnAssetArgs) {
  await provider.enable();
  const info = await provider.getInfo();
  if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
      !provider.burnAsset || !provider.getConsignment) {
    throw new Error("This wallet does not support BFA burn proofs");
  }
  await persistIntent(args); // requestId was created once for this intent
  const burn = await provider.burnAsset(args);
  await persistBurn(burn);
  const proof = await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid });
  return { burn, proof };
}
```

A timeout leaves the operation unresolved. Keep the same `requestId`, query
`getTransferStatus(requestId, assetId)` and recover the saved result; never
retry by inventing another id. Once a txid is known, retrieving the proof can
be retried independently without another burn. For a known request whose
transfer cannot yet be identified, the status call rejects with
`INTERNAL_ERROR`; this does not mean the burn failed. Request progress belongs
to the wallet's operation journal. `getTransferStatus()` returns actual RGB
transfer statuses once a transfer is available.

The bridge integration verifies the returned proof and waits for its required
Bitcoin confirmations and the actual `blockHeight`. It can then send
`proof.data` to its unlock API and track the EVM payout. Bridge credentials,
submission recovery and payout status belong to that integration. A local
regtest mock flow can stop after receiving assets, burning and retrieving the
proof, without claiming an EVM payout occurred.

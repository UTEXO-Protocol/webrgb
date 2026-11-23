// Compile-only consumer: the declarations must let a dApp be written against
// the injected provider without casts, and must reject misuse.
import {
  announceProvider,
  isProviderError,
  listProviders,
  onProviderAnnounced,
  providerErrorCode,
  requestProvider,
  RGB_ERROR_CODES,
  supports,
  toAssetArray,
  toTransferArray,
} from "@utexo/webrgb";
import type {
  ProviderError,
  ProviderErrorCode,
  RgbAsset,
  RgbBurnAssetArgs,
  RgbGetConsignmentResult,
  RgbReceivedMint,
  RgbInfo,
  RgbSignMessageResult,
  RgbProvider,
  RgbProviderDetail,
  RgbTransfer,
  RgbWitnessReceiveArgs,
  RgbWitnessReceiveResult,
} from "@utexo/webrgb";
import { createMockProvider, installMockProvider, mockPsbt } from "@utexo/webrgb/mock";
import type { MockRgbProvider } from "@utexo/webrgb/mock";
import { formatReport, runConformance } from "@utexo/webrgb/conformance";
import type { ConformanceReport } from "@utexo/webrgb/conformance";

async function useRgb(): Promise<void> {
  if (!window.rgb) return;
  await window.rgb.enable();
  const info = await window.rgb.getInfo();
  if (!info.ready) return;

  const { invoice } = await window.rgb.blindReceive({ assetId: "rgb:x", amount: 1 });
  // No asset id: an invoice that accepts any asset.
  const anyAsset = await window.rgb.blindReceive();
  anyAsset.minConfirmations?.toFixed();
  const witnessArgs: RgbWitnessReceiveArgs = { assetId: "rgb:x", amount: 1 };
  const witness: RgbWitnessReceiveResult = await window.rgb.witnessReceive(witnessArgs);
  witness.invoice.toUpperCase();
  await window.rgb.witnessReceive();
  const sent = await window.rgb.sendAsset({ invoice });
  sent.txid?.toUpperCase();
  await window.rgb.sendAsset({ assetId: "rgb:x", amount: 1, recipientId: "utxob:y" });

  // Lists are narrowed with the helpers: a wallet may wrap them.
  const assets: RgbAsset[] = toAssetArray(await window.rgb.listAssets());
  assets.map((a) => a.ticker);
  const transfers: RgbTransfer[] = toTransferArray(await window.rgb.listTransfers());
  transfers.map((t) => t.status);

  // Read what an invoice asks for before sending against it.
  if (supports(info, "decodeRgbInvoice")) {
    const decoded = await window.rgb.decodeRgbInvoice(invoice);
    if (decoded.amount === null) return; // an any-amount invoice
    decoded.amount.toFixed(0);
  }

  // Feature detection is typed, and autocompletes the known names.
  if (supports(info, "makeLnInvoice") && info.protocol === "RGB_LN") {
    const ln = await window.rgb.makeLnInvoice({ assetId: "rgb:x", assetAmount: 5 });
    const paid = await window.rgb.payLnInvoice({ invoice: ln.invoice });
    paid.assetAmount?.toFixed(0);
    await window.rgb.payLnInvoice(ln.invoice);
  }

  // 0.4: bitcoin side, receive housekeeping, metadata, vanilla PSBTs.
  if (supports(info, "getBtcBalance")) {
    const btc = await window.rgb.getBtcBalance();
    if (btc.freeColorableUtxos === 0) {
      if (supports(info, "witnessReceive")) await window.rgb.witnessReceive({ amount: 1 });
      else await window.rgb.createUtxos({ num: 1, size: 3000 });
    }
    btc.vanilla.spendable.toFixed();
  }
  const pending = await window.rgb.blindReceive();
  const { cancelled } = await window.rgb.cancelReceive(pending.recipientId ?? "");
  void cancelled;
  const { refreshed }: { refreshed: boolean } = await window.rgb.refresh("rgb:x");
  void refreshed;
  const meta = await window.rgb.getAssetMetadata("rgb:x");
  meta.ticker?.toLowerCase();
  meta.media?.mime.length;
  const signed = await window.rgb.signPsbt("cHNidP8B", { finalize: true });
  signed.signedInputs.toFixed();
  // @ts-expect-error the PSBT is a base64 string
  await window.rgb.signPsbt(new Uint8Array());
  const { signature }: { signature: string } = await window.rgb.signMessage("login:nonce");
  void signature;
  // @ts-expect-error message is a string
  await window.rgb.signMessage({ text: "x" });

  const onSettled = (t: RgbTransfer): void => {
    t.status === "Settled";
  };
  window.rgb.on("transferSettled", onSettled);
  window.rgb.off("transferSettled", onSettled);

  // @ts-expect-error unknown event name
  window.rgb.on("somethingElse", onSettled);
  // @ts-expect-error sendAsset needs an invoice or the explicit triple
  await window.rgb.sendAsset({ assetId: "rgb:x" });
  // @ts-expect-error a wrapped list is not an array until it is narrowed
  (await window.rgb.listAssets()).map((a: RgbAsset) => a.id);
}

async function useBurn(provider: RgbProvider): Promise<void> {
  const info = await provider.getInfo();
  if (!supports(info, "burnAsset") || !supports(info, "getConsignment")) return;

  const args: RgbBurnAssetArgs = {
    network: info.network,
    assetId: "rgb:bfa",
    amount: "18446744073709551615",
    burnDestination: { version: 1, chainId: "eip155:31337", dstEid: 0, address: `0x${"11".repeat(20)}` },
    feeRate: 2,
    minConfirmations: 3,
  };
  const tron: RgbBurnAssetArgs = { ...args, burnDestination: {
    version: 1, chainId: "tron:728126428", dstEid: 30420, address: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
  } };
  // Unknown namespaces remain representable; wallets must reject unsupported routes.
  const extended: RgbBurnAssetArgs = { ...args, burnDestination: {
    version: 1, chainId: "cosmos:cosmoshub-4", dstEid: 100, address: "cosmos1t2uflqwqe0fsj0shcfkrvpukewcw40yjj6hdc0",
  } };
  const extendedInfo: RgbInfo = { ...info, burnRecipientNamespaces: ["eip155", "tron", "cosmos"] };
  // @ts-expect-error addresses must be strings; format validation belongs to the wallet
  const wrongAddress: RgbBurnAssetArgs = { ...args, burnDestination: { version: 1, chainId: "tron:728126428", dstEid: 30420, address: 123 } };
  void [tron, extended, extendedInfo, wrongAddress];
  // @ts-expect-error burn amounts must preserve all u64 digits as a string
  const imprecise: RgbBurnAssetArgs = { ...args, amount: 9007199254740993 };
  // @ts-expect-error a recipient must name its payout chain as well as its address
  const noChain: RgbBurnAssetArgs = { ...args, burnDestination: { version: 1, address: "0x11" } };
  void [imprecise, noChain];
  // @ts-expect-error the endpoint must be explicit, including zero for direct payout
  const noEndpoint: RgbBurnAssetArgs = { ...args, burnDestination: { version: 1, chainId: "eip155:137", address: "0x11" } };
  // @ts-expect-error the old recipient-only request is not this contract
  const legacy: RgbBurnAssetArgs = { network: info.network, assetId: "rgb:bfa", amount: "1", burnRecipient: { chainId: "eip155:1", address: "0x11" } };
  // @ts-expect-error callers send native addresses, not a second encoded preimage
  const duplicated: RgbBurnAssetArgs = { ...args, burnDestination: { ...args.burnDestination, destinationChainId: 137 } };
  // @ts-expect-error a burn destination must explicitly select its commitment version
  const noVersion: RgbBurnAssetArgs = { ...args, burnDestination: { chainId: "eip155:137", address: "0x11", dstEid: 30109 } };
  // @ts-expect-error only the numeric literal 1 is supported
  const wrongVersion: RgbBurnAssetArgs = { ...args, burnDestination: { ...args.burnDestination, version: 2 } };
  // @ts-expect-error a string is not the commitment version
  const stringVersion: RgbBurnAssetArgs = { ...args, burnDestination: { ...args.burnDestination, version: "1" } };
  void [noEndpoint, legacy, duplicated, noVersion, wrongVersion, stringVersion];


  const namespace = args.burnDestination.chainId.split(":")[0];
  if (!(info.burnRecipientNamespaces ?? ["eip155"]).includes(namespace)) return;
  const burn = await provider.burnAsset(args);
  const exactAmount: string = burn.amount;
  const version: 1 = burn.burnDestination.version;
  void version;
  burn.burnDestination.dstEid.toFixed();
  burn.minConfirmations.toFixed();
  const proof: RgbGetConsignmentResult = await provider.getConsignment({
    assetId: burn.assetId, txid: burn.txid,
  });
  const encoding: "base64" = proof.encoding;
  const algorithm: "keccak256" = proof.digest.algorithm;
  // @ts-expect-error retrieval requires both assetId and txid
  await provider.getConsignment({ txid: burn.txid });
  // @ts-expect-error chunk offsets belong to the transport, not the public method
  await provider.getConsignment({ assetId: burn.assetId, txid: burn.txid, offset: 0 });
  const status = await provider.getTransferStatus(burn.transferId, burn.assetId);
  void [exactAmount, encoding, algorithm, status];
}

async function useSignMessage(provider: RgbProvider): Promise<void> {
  // Always callable; getInfo().methods says whether the wallet serves it.
  if (!supports(await provider.getInfo(), "signMessage")) return;
  const signed: RgbSignMessageResult = await provider.signMessage("test message");
  signed.signature.toUpperCase();
  createMockProvider({ signMessage: async () => signed });
}

function useLegacyProvider(
  legacy: Omit<RgbProvider, "burnAsset" | "getConsignment" | "signMessage" | "getReceivedMint" | "createUtxos" | "getBtcBalance" | "refresh" | "getAssetMetadata">,
  args: RgbBurnAssetArgs,
): void {
  // Every method is required, so a wallet must at least stub it to reject.
  // @ts-expect-error a provider missing methods is not an RgbProvider
  const incomplete: RgbProvider = legacy;
  void [incomplete, args];
}

async function inspectPreparedMint(provider: RgbProvider, invoice: string): Promise<void> {
  const info = await provider.getInfo();
  if (!supports(info, "getReceivedMint")) return;
  const received: RgbReceivedMint | null = await provider.getReceivedMint({ invoice });
  if (received === null) return;
  BigInt(received.amount);
  BigInt(received.beforeBlock);
  received.assetId.toUpperCase();
  received.txid?.toUpperCase();
  // @ts-expect-error a checked mint may not have a witness transaction ID yet
  received.txid.toUpperCase();
  const withoutTxid: RgbReceivedMint = {
    invoice: received.invoice,
    recipientId: received.recipientId,
    assetId: received.assetId,
    network: received.network,
    opid: received.opid,
    lockId: received.lockId,
    amount: received.amount,
    beforeBlock: received.beforeBlock,
    evmChainId: received.evmChainId,
    bridgeContract: received.bridgeContract,
  };
  withoutTxid.lockId.toUpperCase();
  const anyAssetReceipt: RgbReceivedMint = {
    ...withoutTxid,
    invoice: "rgb:~/~/bcrt:utxob:owned",
    assetId: "rgb:validated",
  };
  anyAssetReceipt.assetId.toUpperCase();
  const { assetId: _provenAsset, ...withoutAssetId } = anyAssetReceipt;
  // @ts-expect-error every receipt carries the asset of the validated consignment
  const missingAssetId: RgbReceivedMint = withoutAssetId;
  void missingAssetId;
  // @ts-expect-error recipient-only lookup does not bind the exact invoice
  await provider.getReceivedMint({ recipientId: "utxob:seal" });
  // @ts-expect-error a bare string is not the negotiated request object
  await provider.getReceivedMint(invoice);
}
void inspectPreparedMint;

async function useDiscovery(): Promise<void> {
  const rgb = await requestProvider({ timeoutMs: 5000 });
  await rgb.enable();
  const rgbDefault = await requestProvider();
  rgbDefault.enabled;
  const enabled = await requestProvider({ enable: true });
  enabled.enabled;

  const details: RgbProviderDetail[] = await listProviders({
    timeoutMs: 200,
    includeLegacy: false,
  });
  details.map((d) => `${d.info.name} (${d.info.rdns})`);

  const stop = onProviderAnnounced((detail) => detail.provider.enable());
  stop();
}

function useWalletSide(provider: MockRgbProvider): () => void {
  // What a wallet writes to join discovery.
  return announceProvider({
    info: { uuid: crypto.randomUUID(), name: "Example", rdns: "com.example.wallet" },
    provider,
  });
}

function handle(err: unknown): ProviderErrorCode {
  if (isProviderError(err)) {
    const code: ProviderErrorCode = err.code;
    if (code === "USER_REJECTED") return code;
    if (code === "NO_AVAILABLE_UTXOS" || code === "UNSAFE_PSBT") return code;
  }
  // @ts-expect-error the codes are a closed union
  const bogus: ProviderErrorCode = "NOPE";
  void bogus;
  return providerErrorCode(err);
}

async function useMockAndConformance(): Promise<void> {
  const mock = createMockProvider({
    protocol: "RGB_LN",
    assets: [{ id: "rgb:x", ticker: "X", balance: 10 }],
    latencyMs: 1,
  });
  await mock.enable();
  const issued = await mock.issueAsset({
    schema: "nia",
    ticker: "MOCK",
    name: "Mock",
    amounts: [1],
  });
  mock.emit("transferReceived", { assetId: issued.assetId });
  mock.settle(1);
  mock.calls.map((c) => c.method);
  await mock.signPsbt(mockPsbt({ inputs: [{ mine: true }] }));
  mock.reset();

  const installed = installMockProvider({ info: { name: "Example" } });
  installed.uninstall();

  const report: ConformanceReport = await runConformance(mock, { assetId: "rgb:x" });
  formatReport(report).split("\n");

  // @ts-expect-error calls is read-only
  mock.calls = [];
}

// The error shape stays assignable from a plain caught value.
const asError: ProviderError = Object.assign(new Error("x"), { code: "USER_REJECTED" as const });

window.addEventListener("rgb:ready", (e) => {
  e.detail.version.length;
});

window.addEventListener("rgb:announceProvider", (e) => {
  e.detail.info.rdns.length;
  void e.detail.provider.enabled;
});

void useRgb;
void useBurn;
void useSignMessage;
void useLegacyProvider;
void useDiscovery;
void useWalletSide;
void handle;
void useMockAndConformance;
void asError;
void RGB_ERROR_CODES;

async function useWalletMaintenance(provider: RgbProvider): Promise<void> {
  const info = await provider.getInfo();
  if (supports(info, "createUtxos")) {
    const created = await provider.createUtxos({ num: 3, size: 3000, feeRate: 2 });
    created.created.toFixed();
  }
  if (supports(info, "getBtcBalance")) {
    (await provider.getBtcBalance()).freeColorableUtxos?.toFixed();
  }
  if (supports(info, "refresh")) {
    const changed: boolean = (await provider.refresh("rgb:x")).refreshed;
    void changed;
  }
  if (supports(info, "getAssetMetadata")) {
    const metadata = await provider.getAssetMetadata("rgb:x");
    BigInt(metadata.issuedSupply);
    // @ts-expect-error u64 supply is an exact decimal string
    const rounded: number = metadata.issuedSupply;
    void rounded;
  }
}
void useWalletMaintenance;

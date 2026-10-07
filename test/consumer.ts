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
  RgbSignMessageResult,
  RgbProvider,
  RgbProviderDetail,
  RgbTransfer,
  RgbWitnessReceiveArgs,
  RgbWitnessReceiveResult,
} from "@utexo/webrgb";
import { createMockProvider, installMockProvider } from "@utexo/webrgb/mock";
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
  if (!supports(info, "burnAsset") || !supports(info, "getConsignment") ||
      !provider.burnAsset || !provider.getConsignment) return;

  const args: RgbBurnAssetArgs = {
    network: info.network,
    assetId: "rgb:bfa",
    amount: "18446744073709551615",
    burnRecipient: { chainId: "eip155:31337", address: `0x${"11".repeat(20)}` },
    feeRate: 2,
    minConfirmations: 3,
  };
  // @ts-expect-error burn amounts must preserve all u64 digits as a string
  const imprecise: RgbBurnAssetArgs = { ...args, amount: 9007199254740993 };
  // @ts-expect-error a recipient must name its EVM chain as well as its address
  const noChain: RgbBurnAssetArgs = { ...args, burnRecipient: { address: "0x11" } };
  void [imprecise, noChain];

  const burn = await provider.burnAsset(args);
  const exactAmount: string = burn.amount;
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
  // @ts-expect-error optional signing needs a presence check
  await provider.signMessage("test message");
  if (!supports(await provider.getInfo(), "signMessage") || !provider.signMessage) return;
  const signed: RgbSignMessageResult = await provider.signMessage("test message");
  signed.signature.toUpperCase();
  createMockProvider({ signMessage: async () => signed });
}

function useLegacyProvider(
  legacy: Omit<RgbProvider, "burnAsset" | "getConsignment" | "signMessage">,
  args: RgbBurnAssetArgs,
): void {
  // Adding the extension must not require an existing wallet to implement it.
  const compatible: RgbProvider = legacy;
  // @ts-expect-error optional methods need a presence check
  compatible.burnAsset(args);
}

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

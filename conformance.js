/**
 * Runtime half of @utexo/webrgb/conformance. Types live in conformance.d.ts.
 */

import { providerErrorCode, supports, toAssetArray, toTransferArray } from "./index.js";

const CORE_METHODS = [
  "enable",
  "getInfo",
  "getAddress",
  "listAssets",
  "getAssetBalance",
  "listTransfers",
  "getTransferStatus",
  "on",
  "off",
];

const LN_METHODS = ["makeLnInvoice", "payLnInvoice"];

/**
 * @param {import("./index.js").RgbProvider} provider
 * @param {import("./conformance.js").ConformanceOptions} [options]
 * @returns {Promise<import("./conformance.js").ConformanceReport>}
 */
export async function runConformance(provider, options = {}) {
  /** @type {import("./conformance.js").ConformanceCheck[]} */
  const checks = [];

  /**
   * @param {string} name
   * @param {() => Promise<string | void> | string | void} body
   *   Returns a reason to skip, or nothing when the check passes.
   */
  const check = async (name, body) => {
    try {
      const skip = await body();
      checks.push(skip ? { name, status: "skip", detail: skip } : { name, status: "pass" });
    } catch (err) {
      checks.push({
        name,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * @param {unknown} condition
   * @param {string} message
   * @returns {asserts condition}
   */
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // A call before enable() must be refused, not served.
  if (!provider.enabled) {
    await check("not-enabled-guard", async () => {
      try {
        await provider.getAddress();
      } catch (err) {
        assert(
          providerErrorCode(err) === "NOT_ENABLED",
          `expected NOT_ENABLED, got ${providerErrorCode(err)}`,
        );
        return;
      }
      throw new Error("getAddress() resolved before enable()");
    });
  }

  if (options.enable !== false) {
    await check("enable-resolves", async () => {
      await provider.enable();
    });
    await check("enabled-flag", () => {
      assert(provider.enabled === true, "provider.enabled is not true after enable()");
    });
    await check("enable-idempotent", async () => {
      await provider.enable();
    });
  }

  if (!provider.enabled) {
    checks.push({
      name: "getInfo-shape",
      status: "skip",
      detail: "provider is not enabled; nothing further can be checked",
    });
    return summarise(checks);
  }

  /** @type {import("./index.js").RgbInfo | null} */
  let info = null;

  await check("getInfo-shape", async () => {
    info = await provider.getInfo();
    assert(typeof info.ready === "boolean", "ready is not a boolean");
    assert(typeof info.network === "string" && info.network !== "", "network is not a string");
    assert(Array.isArray(info.methods), "methods is not an array");
    assert(
      info.methods.every((m) => typeof m === "string"),
      "methods contains a non-string",
    );
  });

  await check("protocol-known", () => {
    if (!info) return "getInfo() did not return";
    assert(
      info.protocol === null || info.protocol === "RGB_L1" || info.protocol === "RGB_LN",
      `protocol ${JSON.stringify(info.protocol)} is not RGB_L1, RGB_LN or null`,
    );
  });

  await check("methods-include-core", () => {
    const seen = info;
    if (!seen) return "getInfo() did not return";
    const missing = CORE_METHODS.filter((m) => !supports(seen, m));
    assert(missing.length === 0, `methods omits ${missing.join(", ")}`);
  });

  await check("ln-methods-match-protocol", () => {
    const seen = info;
    if (!seen) return "getInfo() did not return";
    const listed = LN_METHODS.filter((m) => supports(seen, m));
    if (seen.protocol === "RGB_LN") {
      assert(listed.length === LN_METHODS.length, `RGB_LN wallet omits ${LN_METHODS.join(", ")}`);
    } else {
      assert(listed.length === 0, `non-RGB_LN wallet lists ${listed.join(", ")}`);
    }
  });

  await check("witnessReceive-available", () => {
    assert(typeof provider.witnessReceive === "function", "witnessReceive is missing");
  });

  // Every method is present whether or not the wallet serves it; `methods` is
  // the feature-detection contract. An unlisted method is probed only when the
  // call cannot prompt, spend or disclose wallet data.
  /** @type {Partial<Record<import("./index.js").RgbMethod, () => Promise<unknown>>>} */
  const safeProbes = {
    getReceivedMint: () => provider.getReceivedMint({ invoice: "rgb:webrgb-conformance-no-such-invoice" }),
    getBtcBalance: () => provider.getBtcBalance(),
    refresh: () => provider.refresh("rgb:webrgb-conformance-no-such-asset"),
    getAssetMetadata: () => provider.getAssetMetadata("rgb:webrgb-conformance-no-such-asset"),
  };
  for (const method of /** @type {const} */ (["burnAsset", "getConsignment", "signMessage", "getReceivedMint", "createUtxos", "getBtcBalance", "refresh", "getAssetMetadata"])) {
    await check(`${method}-available`, async () => {
      assert(typeof provider[method] === "function", `${method} is missing; unserved methods must reject instead`);
      if (!info) return "getInfo() did not return";
      if (supports(info, method)) return;
      const probe = safeProbes[method];
      if (!probe) return `the wallet does not serve ${method}; not called, since it prompts, spends or shares data`;
      try {
        await probe();
      } catch (err) {
        const code = providerErrorCode(err);
        assert(code === "METHOD_NOT_SUPPORTED", `unlisted ${method} rejected with ${code}, not METHOD_NOT_SUPPORTED`);
        return;
      }
      throw new Error(`${method} is absent from methods but was served anyway`);
    });
  }

  await check("getAddress-shape", async () => {
    const result = await provider.getAddress();
    assert(
      !!result && typeof result.address === "string" && result.address !== "",
      "getAddress() did not return a non-empty address",
    );
  });

  /** @type {import("./index.js").RgbAsset[]} */
  let assets = [];

  await check("listAssets-array", async () => {
    const result = await provider.listAssets();
    assets = toAssetArray(result);
    assert(
      Array.isArray(result),
      "listAssets() returned a wrapped object; a conforming wallet returns an array",
    );
  });

  await check("listTransfers-array", async () => {
    const result = await provider.listTransfers();
    toTransferArray(result);
    assert(
      Array.isArray(result),
      "listTransfers() returned a wrapped object; a conforming wallet returns an array",
    );
  });

  const assetId =
    options.assetId ?? assets.map((a) => a.id ?? a.asset_id).find((id) => typeof id === "string");

  await check("getAssetBalance-shape", async () => {
    if (!assetId) return "the wallet holds no asset and none was passed";
    const balance = await provider.getAssetBalance(assetId);
    assert(balance.assetId === assetId, "assetId does not echo back");
    assert(typeof balance.balance === "number", "balance is not a number");
  });

  await check("getTransferStatus-miss", async () => {
    const result = await provider.getTransferStatus("webrgb-conformance-no-such-transfer");
    assert(result.found === false, "an unknown transfer was reported as found");
    assert(result.status === null && result.transfer === null, "a miss carried a status");
  });

  await check("unsupported-method-code", async () => {
    const seen = info;
    if (!seen) return "getInfo() did not return";
    const unsupported = LN_METHODS.find((m) => !supports(seen, m));
    if (!unsupported) return "the wallet serves every method this suite can refuse safely";
    try {
      if (unsupported === "makeLnInvoice") {
        await provider.makeLnInvoice({ assetId: assetId ?? "rgb:unknown", assetAmount: 1 });
      } else {
        await provider.payLnInvoice({ invoice: "lnbc-webrgb-conformance" });
      }
    } catch (err) {
      const code = providerErrorCode(err);
      assert(
        code === "METHOD_NOT_SUPPORTED",
        `an unlisted method rejected with ${code}, not METHOD_NOT_SUPPORTED`,
      );
      return;
    }
    throw new Error(`${unsupported} is absent from methods but was served anyway`);
  });

  await check("error-codes-carried", async () => {
    try {
      await provider.getAssetBalance("rgb:webrgb-conformance-no-such-asset");
    } catch (err) {
      assert(err instanceof Error, "a rejection was not an Error");
      assert(
        typeof (/** @type {{ code?: unknown }} */ (err).code) === "string",
        "a rejection carried no code",
      );
      return;
    }
    return "the wallet answered for an unknown asset instead of rejecting";
  });

  // Decoding is read-only, so a wallet that serves it must refuse rubbish
  // with a code rather than throwing something uncoded at the page.
  await check("decode-rejects-rubbish", async () => {
    const seen = info;
    if (!seen || !supports(seen, "decodeRgbInvoice")) return "the wallet does not decode invoices";
    try {
      await provider.decodeRgbInvoice("not-an-rgb-invoice");
    } catch (err) {
      assert(err instanceof Error, "a rejection was not an Error");
      assert(
        typeof (/** @type {{ code?: unknown }} */ (err).code) === "string",
        "a rejection carried no code",
      );
      return;
    }
    return "the wallet decoded a malformed invoice instead of rejecting";
  });

  await check("getBtcBalance-shape", async () => {
    if (!info || !supports(info, "getBtcBalance")) return "the wallet does not serve getBtcBalance";
    const balance = await provider.getBtcBalance();
    for (const side of /** @type {const} */ (["vanilla", "colored"])) {
      for (const field of /** @type {const} */ (["settled", "future", "spendable"])) {
        const value = balance?.[side]?.[field];
        assert(Number.isSafeInteger(value) && value >= 0, `${side}.${field} is not safe nonnegative sats`);
      }
    }
    assert(balance.freeColorableUtxos === null ||
      (Number.isSafeInteger(balance.freeColorableUtxos) && balance.freeColorableUtxos >= 0),
      "freeColorableUtxos is neither a count nor null");
    const leak = findOutpoint(balance);
    assert(!leak, `getBtcBalance exposes an outpoint (${leak})`);
  });

  await check("getAssetMetadata-miss", async () => {
    if (!info || !supports(info, "getAssetMetadata")) return "the wallet does not serve getAssetMetadata";
    try {
      await provider.getAssetMetadata("rgb:webrgb-conformance-no-such-asset");
    } catch (error) {
      assert(providerErrorCode(error) === "ASSET_NOT_FOUND", "unknown metadata must reject with ASSET_NOT_FOUND");
      return;
    }
    throw new Error("getAssetMetadata answered for an unknown asset");
  });

  await check("getAssetMetadata-shape", async () => {
    if (!info || !supports(info, "getAssetMetadata")) return "the wallet does not serve getAssetMetadata";
    if (!assetId) return "the wallet holds no asset and none was passed";
    const meta = await provider.getAssetMetadata(assetId);
    assert(meta?.assetId === assetId, "metadata assetId does not match");
    assert(typeof meta.schema === "string", "schema is not a string");
    assert(typeof meta.name === "string", "name is not a string");
    assert(meta.ticker === null || typeof meta.ticker === "string", "invalid ticker");
    assert(meta.details === null || typeof meta.details === "string", "invalid details");
    assert(Number.isInteger(meta.precision) && meta.precision >= 0 && meta.precision <= 255, "invalid precision");
    assert(Number.isSafeInteger(meta.timestamp), "invalid timestamp");
    assert(typeof meta.issuedSupply === "string" && /^(0|[1-9]\d{0,19})$/.test(meta.issuedSupply) &&
      BigInt(meta.issuedSupply) <= 18446744073709551615n, "issuedSupply is not an exact u64 string");
    assert(meta.media === null || (typeof meta.media?.mime === "string" &&
      typeof meta.media?.digest === "string"), "invalid media metadata");
  });

  await check("refresh-shape", async () => {
    if (!info || !supports(info, "refresh")) return "the wallet does not serve refresh";
    const refreshed = await provider.refresh();
    assert(typeof refreshed?.refreshed === "boolean", "refresh did not return a boolean result");
  });

  await check("events-register", () => {
    /** @param {import("./index.js").RgbTransfer} _transfer */
    const listener = (_transfer) => {};
    provider.on("transferSettled", listener);
    provider.off("transferSettled", listener);
  });

  return summarise(checks);
}

/**
 * @param {import("./conformance.js").ConformanceCheck[]} checks
 * @returns {import("./conformance.js").ConformanceReport}
 */
function summarise(checks) {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  return { ok: failed === 0, passed, failed, skipped, checks };
}

/**
 * @param {import("./conformance.js").ConformanceReport} report
 * @returns {string}
 */
export function formatReport(report) {
  const marks = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
  const lines = report.checks.map(
    (c) => `${marks[c.status]}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
  );
  lines.push(
    `${report.ok ? "conformant" : "NOT conformant"}: ${report.passed} passed, ` +
      `${report.failed} failed, ${report.skipped} skipped`,
  );
  return lines.join("\n");
}

/**
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string | undefined}
 */
function findOutpoint(value, path = "") {
  if (typeof value === "string") return /^[0-9a-f]{64}:\d+$/i.test(value) ? path || "(root)" : undefined;
  if (!value || typeof value !== "object") return undefined;
  for (const [key, inner] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (/^(outpoints?|txid|vout|utxos|unspents)$/i.test(key)) return at;
    const found = findOutpoint(inner, at);
    if (found) return found;
  }
  return undefined;
}

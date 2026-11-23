/**
 * Runtime half of @utexo/webrgb/mock. Types live in mock.d.ts.
 */

import { announceProvider } from "./index.js";

const BASE_METHODS = [
  "enable",
  "getInfo",
  "getAddress",
  "blindReceive",
  "witnessReceive",
  "createUtxos",
  "cancelReceive",
  "getBtcBalance",
  "refresh",
  "getAssetMetadata",
  "signPsbt",
  "signMessage",
  "issueAsset",
  "listAssets",
  "getAssetBalance",
  "sendAsset",
  "listTransfers",
  "getTransferStatus",
  "decodeRgbInvoice",
  "on",
  "off",
];

const LN_METHODS = ["makeLnInvoice", "payLnInvoice"];

/**
 * @param {string} message
 * @param {import("./index.js").ProviderErrorCode} code
 */
function fail(message, code) {
  const err = /** @type {import("./index.js").ProviderError} */ (new Error(message));
  err.name = "ProviderError";
  err.code = code;
  return err;
}

/**
 * @param {import("./mock.js").MockProviderOptions} [options]
 * @returns {import("./mock.js").MockRgbProvider}
 */
export function createMockProvider(options = {}) {
  const network = options.network ?? "signet";
  const protocol = options.protocol ?? "RGB_L1";
  const ready = options.ready ?? true;
  const autoEnable = options.autoEnable ?? true;
  const latencyMs = options.latencyMs ?? 0;
  const minConfirmationsFloor = options.minConfirmationsFloor ?? 1;
  const utxoSize = 3000;
  let freeUtxos = options.freeColorableUtxos ?? 5;
  let vanillaSats = options.vanillaSats ?? 100_000;
  let coloredSats = freeUtxos * utxoSize;
  const createdAt = Math.floor(Date.now() / 1000);
  const methods = options.methods ?? [
    ...BASE_METHODS,
    ...(protocol === "RGB_LN" ? LN_METHODS : []),
    ...(options.getReceivedMint ? ["getReceivedMint"] : []),
    ...(options.burnAsset ? ["burnAsset"] : []),
  ];

  /** @type {Map<string, { asset: import("./index.js").RgbAsset, balance: number, issuedSupply: unknown }>} */
  const assets = new Map();
  for (const [index, entry] of (options.assets ?? []).entries()) {
    const { balance = 0, ...asset } = entry;
    const id = asset.id ?? asset.asset_id ?? `rgb:mock-${index + 1}`;
    assets.set(id, { asset: { ...asset, id }, balance, issuedSupply: asset.issuedSupply ?? balance });
  }

  /** @type {import("./index.js").RgbTransfer[]} */
  let transfers = [];
  /** Pending receives by recipient id; `blinded` ones hold a UTXO. */
  /** @type {Map<string, { blinded: boolean, status: string }>} */
  const receives = new Map();
  /** @type {import("./mock.js").MockCall[]} */
  let calls = [];
  /** @type {Map<string, Set<(transfer: import("./index.js").RgbTransfer) => void>>} */
  let listeners = new Map();

  let enabled = false;
  let counter = 0;
  const nextId = () => ++counter;

  /**
   * @param {import("./index.js").RgbMethod} method
   * @param {unknown[]} args
   */
  async function call(method, args) {
    calls.push({ method, args });
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    if (!enabled) throw fail("Call rgb.enable() first", "NOT_ENABLED");
    if (!methods.includes(method)) {
      throw fail(`${method} is not supported by this wallet`, "METHOD_NOT_SUPPORTED");
    }
  }

  /** Confirmation-gated calls honour `rejectConfirmations`. */
  function confirm() {
    if (options.rejectConfirmations) throw fail("User rejected the request", "USER_REJECTED");
  }

  /** @param {unknown} assetId */
  function requireAsset(assetId) {
    if (typeof assetId !== "string" || !assetId.startsWith("rgb:")) {
      throw fail(`Invalid assetId: ${String(assetId)}`, "INVALID_PARAMS");
    }
    const held = assets.get(assetId);
    if (!held) throw fail(`Unknown asset ${assetId}`, "ASSET_NOT_FOUND");
    return held;
  }

  /**
   * @param {"blindReceive" | "witnessReceive"} method
   * @param {import("./index.js").RgbBlindReceiveArgs} args
   */
  async function receive(method, args) {
    await call(method, [args]);
    if (args.assetId !== undefined) requireAsset(args.assetId);
    if (method === "blindReceive" && freeUtxos < 1) {
      throw fail("No free colorable UTXO", "NO_AVAILABLE_UTXOS");
    }
    confirm();
    if (method === "blindReceive") freeUtxos -= 1;
    return method === "blindReceive"
      ? receiveInvoice(args, "utxob", true)
      : receiveInvoice(args, "wvout", false);
  }

  /**
   * @param {import("./index.js").RgbEvent} event
   * @param {import("./index.js").RgbTransfer} transfer
   */
  function emit(event, transfer) {
    for (const listener of listeners.get(event) ?? []) listener(transfer);
  }

  /**
   * @param {import("./index.js").RgbBlindReceiveArgs} args
   * @param {"utxob" | "wvout"} kind
   * @param {boolean} blinded
   */
  function receiveInvoice(args, kind, blinded) {
    const recipientId = `${kind}:mock${nextId()}`;
    receives.set(recipientId, { blinded, status: "WaitingCounterparty" });
    return {
      // An any-asset invoice leaves the contract out, like rgb-lib's `rgb:~/…`.
      invoice: `${args.assetId ?? "rgb:~"}/RGB20/${recipientId}`,
      recipientId,
      expirationTimestamp: Math.floor(Date.now() / 1000) + (args.durationSeconds ?? 86400),
      minConfirmations: Math.max(args.minConfirmations ?? 1, minConfirmationsFloor),
    };
  }

  const provider = {
    get enabled() {
      return enabled;
    },

    get calls() {
      return calls;
    },

    async enable() {
      calls.push({ method: "enable", args: [] });
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (enabled) return;
      if (!autoEnable) throw fail("User rejected the connection", "USER_REJECTED");
      enabled = true;
    },

    async getInfo() {
      await call("getInfo", []);
      return { ready, network, protocol, methods: [...methods] };
    },

    async getAddress() {
      await call("getAddress", []);
      return { address: `bcrt1qmock${String(nextId()).padStart(6, "0")}` };
    },

    /** @param {import("./index.js").RgbGetReceivedMintArgs} args */
    async getReceivedMint(args) {
      await call("getReceivedMint", [args]);
      if (!options.getReceivedMint) throw fail("No mint validation fixture configured", "METHOD_NOT_SUPPORTED");
      if (!args || typeof args.invoice !== "string" || !args.invoice.startsWith("rgb:") || args.invoice.length > 8192) {
        throw fail("getReceivedMint requires the full invoice", "INVALID_PARAMS");
      }
      return options.getReceivedMint(args);
    },
    /** @param {string} message */
    async signMessage(message) {
      await call("signMessage", [message]);
      if (typeof message !== "string" || /[\uD800-\uDFFF]/u.test(message)) {
        throw fail("message must be a well-formed Unicode string", "INVALID_PARAMS");
      }
      confirm();
      if (options.signMessage) return options.signMessage(message);
      // Not a real signature: a deterministic stand-in in the zbase32 alphabet.
      let hash = 0;
      for (const ch of message) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
      const alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
      let signature = "";
      for (let i = 0; i < 104; i++) {
        hash = (hash * 1103515245 + 12345) >>> 0;
        signature += alphabet[hash >>> 27];
      }
      return { signature };
    },

    /** @param {import("./index.js").RgbBlindReceiveArgs} [args] */
    async blindReceive(args = {}) {
      return receive("blindReceive", args);
    },

    /** @param {import("./index.js").RgbWitnessReceiveArgs} [args] */
    async witnessReceive(args = {}) {
      return receive("witnessReceive", args);
    },

    /** @param {import("./index.js").RgbCreateUtxosArgs} [args] */
    async createUtxos(args = {}) {
      await call("createUtxos", [args]);
      const num = args.num ?? 3;
      const size = args.size ?? 3000;
      const feeRate = args.feeRate ?? 2;
      if (!Number.isInteger(num) || num < 1 || num > 255 ||
          !Number.isInteger(size) || size < 1 || size > 0xffffffff ||
          !Number.isSafeInteger(feeRate) || feeRate < 1) {
        throw fail("Invalid UTXO count, size or fee rate", "INVALID_PARAMS");
      }
      // A deterministic test fee, not a real Bitcoin transaction estimate.
      const cost = num * size + feeRate * (110 + 43 * num);
      if (!Number.isSafeInteger(cost) || cost > vanillaSats) {
        throw fail("Not enough bitcoin to create UTXOs", "INTERNAL_ERROR");
      }
      confirm();
      vanillaSats -= cost;
      coloredSats += num * size;
      freeUtxos += num;
      return { created: num, size, feeRate };
    },

    /** @param {string} recipientId */
    async cancelReceive(recipientId) {
      await call("cancelReceive", [recipientId]);
      if (typeof recipientId !== "string" || !/^(utxob|wvout):\S+$/.test(recipientId)) {
        throw fail(`Invalid recipientId: ${String(recipientId)}`, "INVALID_PARAMS");
      }
      confirm();
      const pending = receives.get(recipientId);
      if (!pending || pending.status !== "WaitingCounterparty") return { cancelled: false };
      pending.status = "Failed";
      if (pending.blinded) freeUtxos += 1;
      return { cancelled: true };
    },

    async getBtcBalance() {
      await call("getBtcBalance", []);
      return {
        vanilla: { settled: vanillaSats, future: vanillaSats, spendable: vanillaSats },
        colored: { settled: coloredSats, future: coloredSats, spendable: coloredSats },
        freeColorableUtxos: freeUtxos,
      };
    },

    /** @param {string} [assetId] */
    async refresh(assetId) {
      await call("refresh", assetId === undefined ? [] : [assetId]);
      if (assetId !== undefined) requireAsset(assetId);
      // settle() advances this fixture; it has no native refresh or network.
      return { refreshed: false };
    },

    /** @param {string} assetId */
    async getAssetMetadata(assetId) {
      await call("getAssetMetadata", [assetId]);
      const { asset, issuedSupply: supply } = requireAsset(assetId);
      if (typeof supply === "number" && !Number.isSafeInteger(supply)) {
        throw fail("Initial supply fixture must preserve exact integers", "INTERNAL_ERROR");
      }
      const issuedSupply = String(supply);
      if (!/^(0|[1-9]\d*)$/.test(issuedSupply) || BigInt(issuedSupply) > 18446744073709551615n) {
        throw fail("Invalid initial supply in the metadata fixture", "INTERNAL_ERROR");
      }
      return {
        assetId,
        schema: typeof asset.schema === "string" ? asset.schema : "nia",
        ticker: asset.ticker ?? null,
        name: asset.name ?? "",
        details: typeof asset.details === "string" ? asset.details : null,
        precision: asset.precision ?? 0,
        issuedSupply,
        timestamp: typeof asset.timestamp === "number" ? asset.timestamp : createdAt,
        media: null,
      };
    },

    /** @param {import("./index.js").RgbBurnAssetArgs} args */
    async burnAsset(args) {
      const request = structuredClone(args);
      await call("burnAsset", [request]);
      if (!options.burnAsset) throw fail("No burn fixture configured", "METHOD_NOT_SUPPORTED");
      const destination = request?.burnDestination;
      if (!request || "burnRecipient" in request || request.network !== network ||
          typeof request.amount !== "string" || !/^[1-9]\d*$/.test(request.amount) ||
          BigInt(request.amount) > 18446744073709551615n || !destination || destination.version !== 1 ||
          typeof destination.chainId !== "string" || !destination.chainId.includes(":") ||
          typeof destination.address !== "string" || !destination.address ||
          !Number.isInteger(destination.dstEid) || destination.dstEid < 0 || destination.dstEid > 0xffffffff ||
          "destinationChainId" in destination || "recipient" in destination ||
          (request.feeRate !== undefined && (!Number.isSafeInteger(request.feeRate) || request.feeRate < 1)) ||
          (request.minConfirmations !== undefined && (!Number.isInteger(request.minConfirmations) || request.minConfirmations < 1 || request.minConfirmations > 255))) {
        throw fail("burnAsset requires a single native-address destination and exact amount", "INVALID_PARAMS");
      }
      requireAsset(request.assetId);
      confirm();
      // The caller-supplied fixture owns route/address validation and the result.
      return options.burnAsset(request);
    },

    /** @param {import("./index.js").RgbGetConsignmentArgs} args */
    async getConsignment(args) {
      await call("getConsignment", [args]);
      throw fail("The mock keeps no burn consignments", "METHOD_NOT_SUPPORTED");
    },

    /**
     * @param {string} psbt
     * @param {import("./index.js").RgbSignPsbtOptions} [opts]
     */
    async signPsbt(psbt, opts = {}) {
      await call("signPsbt", opts.finalize === undefined ? [psbt] : [psbt, opts]);
      const parsed = readMockPsbt(psbt);
      const mine = parsed.inputs.filter((input) => input.mine);
      // Checked before the prompt: signing a colored input destroys its assets.
      if (mine.some((input) => input.colored)) {
        throw fail("The PSBT spends an input that holds RGB assets", "UNSAFE_PSBT");
      }
      if (mine.length === 0) throw fail("No input in the PSBT belongs to this wallet", "INVALID_PARAMS");
      confirm();
      const signed = {
        ...parsed,
        inputs: parsed.inputs.map((input) => (input.mine ? { ...input, signed: true } : input)),
        finalized: opts.finalize === true,
      };
      return { psbt: btoa(JSON.stringify(signed)), signedInputs: mine.length };
    },

    /** @param {import("./index.js").RgbIssueAssetArgs} args */
    async issueAsset(args) {
      await call("issueAsset", [args]);
      confirm();
      if (args.schema !== "nia") {
        throw fail(`Schema ${args.schema} is not supported yet`, "METHOD_NOT_SUPPORTED");
      }
      const assetId = `rgb:mock-${args.ticker.toLowerCase()}-${nextId()}`;
      const asset = {
        id: assetId,
        ticker: args.ticker,
        name: args.name,
        precision: args.precision ?? 0,
      };
      assets.set(assetId, {
        asset,
        balance: args.amounts.reduce((sum, amount) => sum + amount, 0),
        issuedSupply: String(args.amounts.reduce((sum, amount) => sum + amount, 0)),
      });
      return { assetId, asset: /** @type {Record<string, unknown>} */ ({ ...asset }) };
    },

    async listAssets() {
      await call("listAssets", []);
      return [...assets.values()].map((held) => ({ ...held.asset, balance: held.balance }));
    },

    /** @param {string} assetId */
    async getAssetBalance(assetId) {
      await call("getAssetBalance", [assetId]);
      const held = requireAsset(assetId);
      return {
        assetId,
        balance: held.balance,
        raw: { settled: held.balance, future: held.balance, spendable: held.balance },
      };
    },

    /** @param {import("./index.js").RgbSendAssetArgs} args */
    async sendAsset(args) {
      await call("sendAsset", [args]);
      confirm();
      const byInvoice = "invoice" in args;
      const assetId = byInvoice ? parseAssetId(args.invoice) : args.assetId;
      if (assetId === undefined) {
        throw fail(
          "The invoice accepts any asset; send with { assetId, amount, recipientId }",
          "INVALID_PARAMS",
        );
      }
      const amount = byInvoice ? 0 : args.amount;
      const held = requireAsset(assetId);
      if (!byInvoice && held.balance < amount) {
        throw fail("Insufficient asset balance", "INTERNAL_ERROR");
      }
      held.balance -= amount;
      const transfer = {
        assetId,
        transferId: nextId(),
        status: /** @type {import("./index.js").RgbTransferStatus} */ ("WaitingCounterparty"),
        kind: "send",
        amount,
        recipientId: byInvoice ? parseRecipientId(args.invoice) : args.recipientId,
        txid: `mocktxid${nextId()}`,
      };
      transfers.push(transfer);
      return { ...transfer };
    },

    /** @param {string} [assetId] */
    async listTransfers(assetId) {
      await call("listTransfers", assetId === undefined ? [] : [assetId]);
      return transfers.filter((t) => assetId === undefined || t.assetId === assetId);
    },

    /**
     * @param {string | number} transferId
     * @param {string} [assetId]
     */
    async getTransferStatus(transferId, assetId) {
      await call("getTransferStatus", assetId === undefined ? [transferId] : [transferId, assetId]);
      const match = transfers.find(
        (t) =>
          (assetId === undefined || t.assetId === assetId) &&
          (String(t.transferId) === String(transferId) ||
            t.recipientId === transferId ||
            t.txid === transferId),
      );
      return match
        ? { found: true, status: match.status ?? null, transfer: { ...match } }
        : { found: false, status: null, transfer: null };
    },

    /** @param {{ invoice: string } | string} args */
    async decodeRgbInvoice(args) {
      const invoice = typeof args === "string" ? args : args?.invoice;
      await call("decodeRgbInvoice", [args]);
      if (!invoice) throw fail("An invoice is required", "INVALID_PARAMS");
      const assetId = parseAssetId(invoice);
      const amount = /\/(\d+)\+(?:utxob|wvout):/.exec(invoice);
      return {
        assetId,
        // A fungible 0 is an any-amount invoice, not a request for zero.
        amount: amount && Number(amount[1]) > 0 ? Number(amount[1]) : null,
        recipientId: parseRecipientId(invoice),
        network: network,
      };
    },

    /** @param {import("./index.js").RgbMakeLnInvoiceArgs} args */
    async makeLnInvoice(args) {
      await call("makeLnInvoice", [args]);
      confirm();
      requireAsset(args.assetId);
      const id = nextId();
      return {
        invoice: `lnbcrt1mock${id}`,
        paymentHash: `mockhash${id}`,
        expiresAt: Math.floor(Date.now() / 1000) + (args.expirySeconds ?? 3600),
        assetId: args.assetId,
        assetAmount: args.assetAmount,
      };
    },

    /** @param {{ invoice: string } | string} args */
    async payLnInvoice(args) {
      const invoice = typeof args === "string" ? args : args?.invoice;
      await call("payLnInvoice", [args]);
      confirm();
      if (!invoice) throw fail("An invoice is required", "INTERNAL_ERROR");
      const id = nextId();
      return {
        paymentHash: `mockhash${id}`,
        preimage: `mockpreimage${id}`,
        status: "Succeeded",
        amountSats: 3000,
      };
    },

    /**
     * @param {import("./index.js").RgbEvent} event
     * @param {(transfer: import("./index.js").RgbTransfer) => void} listener
     */
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      /** @type {Set<any>} */ (listeners.get(event)).add(listener);
    },

    /**
     * @param {import("./index.js").RgbEvent} event
     * @param {(transfer: import("./index.js").RgbTransfer) => void} listener
     */
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },

    emit,

    /** @param {string | number} transferId */
    settle(transferId) {
      const match = transfers.find((t) => String(t.transferId) === String(transferId));
      if (!match) return;
      match.status = "Settled";
      emit("transferSettled", { ...match });
    },

    reset() {
      transfers = [];
      freeUtxos = options.freeColorableUtxos ?? 5;
      vanillaSats = options.vanillaSats ?? 100_000;
      coloredSats = freeUtxos * 3000;
      calls = [];
      listeners = new Map();
      enabled = false;
    },
  };

  return /** @type {import("./mock.js").MockRgbProvider} */ (
    /** @type {unknown} */ (provider)
  );
}

/**
 * `undefined` for an invoice that accepts any asset (`rgb:~/…`).
 * @param {string} invoice
 */
function parseAssetId(invoice) {
  const match = /rgb:([^/]+)/.exec(invoice);
  if (!match) throw fail("Not an RGB invoice", "INVALID_PARAMS");
  return match[1] === "~" ? undefined : `rgb:${match[1]}`;
}

/** @param {string} invoice */
function parseRecipientId(invoice) {
  const match = /((?:utxob|wvout):[^?/]+)/.exec(invoice);
  return match ? match[1] : undefined;
}

/**
 * The mock cannot sign Bitcoin: its PSBT is base64 JSON naming which inputs
 * the wallet owns and which hold RGB assets, enough to exercise the rules.
 * @param {import("./mock.js").MockPsbt} spec
 * @returns {string}
 */
export function mockPsbt(spec) {
  return btoa(JSON.stringify({ mockPsbt: 1, outputs: [], ...spec }));
}

/**
 * @param {unknown} psbt
 * @returns {import("./mock.js").MockPsbt}
 */
function readMockPsbt(psbt) {
  /** @type {any} */
  let parsed;
  try {
    parsed = typeof psbt === "string" && psbt !== "" ? JSON.parse(atob(psbt)) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.mockPsbt !== 1 || !Array.isArray(parsed.inputs)) {
    throw fail("Not a PSBT this mock can read; build one with mockPsbt()", "INVALID_PARAMS");
  }
  return parsed;
}

/**
 * @param {import("./mock.js").MockProviderOptions & { info?: Partial<import("./index.js").RgbProviderInfo> }} [options]
 * @returns {import("./mock.js").InstallMockProviderResult}
 */
export function installMockProvider(options = {}) {
  if (typeof window === "undefined") {
    throw fail("installMockProvider needs a browser-like window", "METHOD_NOT_SUPPORTED");
  }
  const { info: infoOverrides, ...providerOptions } = options;
  const provider = createMockProvider(providerOptions);
  const info = {
    uuid: infoOverrides?.uuid ?? "11111111-1111-4111-8111-111111111111",
    name: infoOverrides?.name ?? "WebRGB mock wallet",
    rdns: infoOverrides?.rdns ?? "dev.webrgb.mock",
    ...(infoOverrides?.icon ? { icon: infoOverrides.icon } : {}),
  };

  const previous = window.rgb;
  window.rgb = provider;
  const stopAnnouncing = announceProvider({ info, provider });
  window.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));

  return {
    provider,
    info,
    uninstall() {
      stopAnnouncing();
      if (window.rgb === provider) window.rgb = previous;
    },
  };
}

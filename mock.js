/**
 * Runtime half of @kaleidorg/webrgb/mock. Types live in mock.d.ts.
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
  /** Sizes in sats of the free colorable UTXOs. */
  const freeUtxos = Array.from({ length: options.freeColorableUtxos ?? 5 }, () => utxoSize);
  let vanillaSats = options.vanillaSats ?? 100_000;
  const createdAt = Math.floor(Date.now() / 1000);
  const methods =
    options.methods ?? (protocol === "RGB_LN" ? [...BASE_METHODS, ...LN_METHODS] : BASE_METHODS);

  /** `issuedSupply` is fixed at creation; `balance` changes as assets move. */
  /** @type {Map<string, { asset: import("./index.js").RgbAsset, balance: number, issuedSupply: number }>} */
  const assets = new Map();
  for (const [index, entry] of (options.assets ?? []).entries()) {
    const { balance = 0, ...asset } = entry;
    const id = asset.id ?? asset.asset_id ?? `rgb:mock-${index + 1}`;
    const issuedSupply = typeof asset.issuedSupply === "number" ? asset.issuedSupply : balance;
    assets.set(id, { asset: { ...asset, id }, balance, issuedSupply });
  }

  /** @type {import("./index.js").RgbTransfer[]} */
  let transfers = [];
  /** Pending receives by recipient id; a blinded one holds a UTXO of `utxoSats`. */
  /** @type {Map<string, { utxoSats: number | null, status: string }>} */
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
   * @param {import("./index.js").RgbEvent} event
   * @param {import("./index.js").RgbTransfer} transfer
   */
  function emit(event, transfer) {
    for (const listener of listeners.get(event) ?? []) listener(transfer);
  }

  /**
   * @param {import("./index.js").RgbBlindReceiveArgs} args
   * @param {"utxob" | "wvout"} kind
   * @param {number | null} utxoSats the reserved UTXO's size, or null for a witness receive
   */
  function receiveInvoice(args, kind, utxoSats) {
    const recipientId = `${kind}:mock${nextId()}`;
    receives.set(recipientId, { utxoSats, status: "WaitingCounterparty" });
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

    /** @param {import("./index.js").RgbBlindReceiveArgs} [args] */
    async blindReceive(args = {}) {
      await call("blindReceive", [args]);
      // Arguments are checked before the prompt, as a wallet does.
      if (args.assetId !== undefined) requireAsset(args.assetId);
      if (freeUtxos.length < 1) {
        throw fail(
          "No free colorable UTXO; call createUtxos() or use witnessReceive()",
          "NO_AVAILABLE_UTXOS",
        );
      }
      confirm();
      return receiveInvoice(args, "utxob", /** @type {number} */ (freeUtxos.pop()));
    },

    /** @param {import("./index.js").RgbBlindReceiveArgs} [args] */
    async witnessReceive(args = {}) {
      await call("witnessReceive", [args]);
      if (args.assetId !== undefined) requireAsset(args.assetId);
      confirm();
      return receiveInvoice(args, "wvout", null);
    },

    /** @param {import("./index.js").RgbCreateUtxosArgs} [args] */
    async createUtxos(args = {}) {
      await call("createUtxos", [args]);
      const num = args.num ?? 3;
      const size = args.size ?? utxoSize;
      const feeRate = args.feeRate ?? 2;
      // Arguments and funds are checked before the prompt, as a wallet does.
      if (!Number.isInteger(num) || num < 1 || num > 255) {
        throw fail(`Invalid num: ${num}`, "INVALID_PARAMS");
      }
      if (!Number.isInteger(size) || size < 1 || size > 0xffffffff) {
        throw fail(`Invalid size: ${size}`, "INVALID_PARAMS");
      }
      if (!(typeof feeRate === "number" && Number.isFinite(feeRate) && feeRate > 0)) {
        throw fail(`Invalid feeRate: ${feeRate}`, "INVALID_PARAMS");
      }
      const cost = num * size + Math.ceil(feeRate * (110 + 43 * num));
      if (cost > vanillaSats) {
        throw fail(`Not enough bitcoin to create UTXOs: need ${cost} sats`, "INTERNAL_ERROR");
      }
      confirm();
      vanillaSats -= cost;
      for (let i = 0; i < num; i++) freeUtxos.push(size);
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
      if (pending.utxoSats !== null) freeUtxos.push(pending.utxoSats);
      return { cancelled: true };
    },

    async getBtcBalance() {
      await call("getBtcBalance", []);
      const vanilla = { settled: vanillaSats, future: vanillaSats, spendable: vanillaSats };
      const sum = (/** @type {number[]} */ sizes) => sizes.reduce((total, sats) => total + sats, 0);
      const free = sum(freeUtxos);
      const reserved = sum(
        [...receives.values()]
          .filter((r) => r.status === "WaitingCounterparty")
          .map((r) => r.utxoSats ?? 0),
      );
      return {
        vanilla,
        colored: { settled: free + reserved, future: free + reserved, spendable: free },
        freeColorableUtxos: freeUtxos.length,
      };
    },

    /** @param {string} [assetId] */
    async refresh(assetId) {
      await call("refresh", assetId === undefined ? [] : [assetId]);
      if (assetId !== undefined) requireAsset(assetId);
      // Nothing moves on its own here; settle() is how a test advances a transfer.
      return { refreshed: false };
    },

    /** @param {string} assetId */
    async getAssetMetadata(assetId) {
      await call("getAssetMetadata", [assetId]);
      const { asset, issuedSupply } = requireAsset(assetId);
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

    /** @param {string} message */
    async signMessage(message) {
      await call("signMessage", [message]);
      // A lone surrogate would be replaced when encoded as UTF-8, changing what is signed.
      if (typeof message !== "string" || message.length === 0 || /[\uD800-\uDFFF]/u.test(message)) {
        throw fail("message must be a non-empty, well-formed string", "INVALID_PARAMS");
      }
      confirm();
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
      const supply = args.amounts.reduce((sum, amount) => sum + amount, 0);
      assets.set(assetId, { asset, balance: supply, issuedSupply: supply });
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

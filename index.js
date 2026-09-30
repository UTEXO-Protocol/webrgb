/**
 * Runtime half of @utexo/webrgb. Types live in index.d.ts.
 *
 * No imports: the GitHub Pages playground serves this file as-is.
 */

/** @type {readonly import("./index.js").ProviderErrorCode[]} */
export const RGB_ERROR_CODES = Object.freeze([
  "USER_REJECTED",
  "NOT_ENABLED",
  "METHOD_NOT_SUPPORTED",
  "INVALID_PARAMS",
  "ASSET_NOT_FOUND",
  "INTERNAL_ERROR",
]);

const ANNOUNCE_EVENT = "rgb:announceProvider";
const REQUEST_EVENT = "rgb:requestProvider";
const READY_EVENT = "rgb:ready";

/**
 * Rejections built here. Not exported: what a page catches from a wallet
 * crossed postMessage and is a plain Error, so `instanceof` would lie.
 * @param {string} message
 * @param {import("./index.js").ProviderErrorCode} code
 * @returns {import("./index.js").ProviderError}
 */
function providerError(message, code) {
  const err = /** @type {import("./index.js").ProviderError} */ (new Error(message));
  err.name = "ProviderError";
  err.code = code;
  return err;
}

/**
 * @param {unknown} value
 * @returns {value is import("./index.js").ProviderError}
 */
export function isProviderError(value) {
  if (!(value instanceof Error)) return false;
  const code = /** @type {{ code?: unknown }} */ (value).code;
  return typeof code === "string" && RGB_ERROR_CODES.includes(/** @type {any} */ (code));
}

/**
 * @param {unknown} value
 * @returns {import("./index.js").ProviderErrorCode}
 */
export function providerErrorCode(value) {
  return isProviderError(value) ? value.code : "INTERNAL_ERROR";
}

/**
 * @param {Pick<import("./index.js").RgbInfo, "methods">} info
 * @param {import("./index.js").RgbMethod} method
 */
export function supports(info, method) {
  return Array.isArray(info?.methods) && info.methods.includes(method);
}

/**
 * @param {unknown} result
 * @returns {import("./index.js").RgbAsset[]}
 */
export function toAssetArray(result) {
  return listFrom(result, "assets");
}

/**
 * @param {unknown} result
 * @returns {import("./index.js").RgbTransfer[]}
 */
export function toTransferArray(result) {
  return listFrom(result, "transfers");
}

/**
 * Wallets either return the array or wrap it under one key. Anything else
 * (null, an error envelope) reads as empty rather than throwing in a render.
 * @param {unknown} result
 * @param {string} key
 * @returns {any[]}
 */
function listFrom(result, key) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    const wrapped = /** @type {Record<string, unknown>} */ (result)[key];
    if (Array.isArray(wrapped)) return wrapped;
  }
  return [];
}

/**
 * @param {unknown} detail
 * @returns {detail is import("./index.js").RgbProviderDetail}
 */
function isProviderDetail(detail) {
  if (!detail || typeof detail !== "object") return false;
  const { info, provider } = /** @type {Record<string, any>} */ (detail);
  return (
    !!provider &&
    typeof provider === "object" &&
    typeof provider.enable === "function" &&
    !!info &&
    typeof info === "object" &&
    typeof info.rdns === "string" &&
    typeof info.name === "string" &&
    typeof info.uuid === "string"
  );
}

/**
 * @param {import("./index.js").RequestProviderOptions} [options]
 * @returns {Promise<import("./index.js").RgbProvider>}
 */
export function requestProvider(options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const promise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(providerError("window.rgb needs a browser page", "METHOD_NOT_SUPPORTED"));
      return;
    }
    if (window.rgb) {
      resolve(window.rgb);
      return;
    }

    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(READY_EVENT, onReady);
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
    };

    /** @param {import("./index.js").RgbProvider} provider */
    const settle = (provider) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(provider);
    };

    const onReady = () => {
      if (window.rgb) settle(window.rgb);
      else if (!settled) {
        settled = true;
        cleanup();
        reject(providerError("rgb:ready fired without window.rgb", "INTERNAL_ERROR"));
      }
    };

    /** @param {Event} event */
    const onAnnounce = (event) => {
      const detail = /** @type {CustomEvent} */ (event).detail;
      if (isProviderDetail(detail)) settle(detail.provider);
    };

    const giveUp = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        providerError(
          "No RGB provider found — is a WebRGB wallet such as the KaleidoSwap extension installed?",
          "METHOD_NOT_SUPPORTED",
        ),
      );
    };

    window.addEventListener(READY_EVENT, onReady);
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);

    if (timeoutMs <= 0) {
      // A wallet already loaded answers the request synchronously.
      window.dispatchEvent(new Event(REQUEST_EVENT));
      giveUp();
      return;
    }
    timer = setTimeout(giveUp, timeoutMs);
    window.dispatchEvent(new Event(REQUEST_EVENT));
  });

  if (!options.enable) return promise;
  return promise.then(async (provider) => {
    await provider.enable();
    return provider;
  });
}

/**
 * @param {(detail: import("./index.js").RgbProviderDetail) => void} listener
 * @returns {() => void}
 */
export function onProviderAnnounced(listener) {
  if (typeof window === "undefined") return () => {};
  /** @param {Event} event */
  const handler = (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail;
    if (isProviderDetail(detail)) listener(detail);
  };
  window.addEventListener(ANNOUNCE_EVENT, handler);
  window.dispatchEvent(new Event(REQUEST_EVENT));
  return () => window.removeEventListener(ANNOUNCE_EVENT, handler);
}

/**
 * @param {import("./index.js").ListProvidersOptions} [options]
 * @returns {Promise<import("./index.js").RgbProviderDetail[]>}
 */
export function listProviders(options = {}) {
  const timeoutMs = options.timeoutMs ?? 500;
  const includeLegacy = options.includeLegacy ?? true;
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve([]);
      return;
    }
    /** @type {import("./index.js").RgbProviderDetail[]} */
    const found = [];
    const seen = new Set();
    const unsubscribe = onProviderAnnounced((detail) => {
      if (seen.has(detail.info.rdns)) return;
      seen.add(detail.info.rdns);
      found.push(detail);
    });
    setTimeout(() => {
      unsubscribe();
      const legacy = window.rgb;
      if (includeLegacy && legacy && !found.some((d) => d.provider === legacy)) {
        found.push({
          info: {
            uuid: "00000000-0000-4000-8000-000000000000",
            name: "Injected wallet",
            rdns: "global.window.rgb",
          },
          provider: legacy,
        });
      }
      resolve(found);
    }, timeoutMs);
  });
}

/**
 * @param {import("./index.js").RgbProviderDetail} detail
 * @returns {() => void}
 */
export function announceProvider(detail) {
  if (typeof window === "undefined") return () => {};
  const announce = () => {
    window.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: Object.freeze({ ...detail }) }));
  };
  window.addEventListener(REQUEST_EVENT, announce);
  announce();
  return () => window.removeEventListener(REQUEST_EVENT, announce);
}

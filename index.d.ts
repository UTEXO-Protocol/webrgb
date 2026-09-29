/**
 * WebRGB — the `window.rgb` provider a wallet injects into web pages so a
 * dApp can issue, receive, send and track RGB assets, and pay or receive them
 * over Lightning, without running its own RGB backend.
 *
 * `SPEC.md` in this repository is the interface contract; the reference
 * implementation is the KaleidoSwap browser extension (`src/injected.ts`).
 * `window.webln`, `window.webbtc` and `window.nostr` are separate specs with
 * their own typings.
 *
 * Every call rejects with a {@link ProviderError} whose `code` tells a user's
 * refusal apart from a wallet fault.
 */

/** Error codes the provider rejects with. */
export type ProviderErrorCode =
  | "USER_REJECTED"
  | "NOT_ENABLED"
  | "METHOD_NOT_SUPPORTED"
  | "INVALID_PARAMS"
  | "ASSET_NOT_FOUND"
  | "INTERNAL_ERROR";

/** Every code, in the order the README documents them. */
export declare const RGB_ERROR_CODES: readonly ProviderErrorCode[];

/**
 * The shape of a rejection. The error crosses `postMessage` on its way out of
 * the wallet, so what a page catches is a plain `Error` carrying `code` — not
 * an instance of any class this package exports. Use {@link isProviderError}
 * rather than `instanceof`.
 */
export interface ProviderError extends Error {
  code: ProviderErrorCode;
}

/** `true` when `value` is an error carrying a WebRGB `code`. */
export declare function isProviderError(value: unknown): value is ProviderError;

/**
 * The code of any thrown value, for a `switch` that must be total.
 * Anything without a recognised `code` reads as `"INTERNAL_ERROR"`.
 */
export declare function providerErrorCode(value: unknown): ProviderErrorCode;

// ---------------------------------------------------------------------------
// window.rgb
// ---------------------------------------------------------------------------

/** Which RGB runtime the wallet is connected with. */
export type RgbProtocol = "RGB_L1" | "RGB_LN";

export type RgbTransferStatus =
  | "WaitingCounterparty"
  | "WaitingConfirmations"
  | "Settled"
  | "Failed"
  | (string & {});

/**
 * Names as they appear in `getInfo().methods`. The union is open: a wallet may
 * serve methods this version does not know about.
 */
export type RgbMethod =
  | "enable"
  | "getInfo"
  | "getAddress"
  | "blindReceive"
  | "issueAsset"
  | "listAssets"
  | "getAssetBalance"
  | "sendAsset"
  | "burnAsset"
  | "getConsignment"
  | "listTransfers"
  | "getTransferStatus"
  | "decodeRgbInvoice"
  | "makeLnInvoice"
  | "payLnInvoice"
  | "on"
  | "off"
  | (string & {});

export interface RgbInfo {
  /** `false` when no RGB wallet is connected; other calls will then reject. */
  ready: boolean;
  network: string;
  protocol: RgbProtocol | (string & {}) | null;
  /**
   * Methods the connected wallet can serve. `issueAsset` appears only when the
   * runtime can mint; `makeLnInvoice` / `payLnInvoice` only when `protocol` is
   * `"RGB_LN"`. Test it with {@link supports} rather than assuming.
   */
  methods: RgbMethod[];
}

/** `true` when `info.methods` lists `method`. */
export declare function supports(info: Pick<RgbInfo, "methods">, method: RgbMethod): boolean;

export interface RgbBlindReceiveArgs {
  /**
   * Omit for an invoice that accepts any asset — the only way to receive an
   * asset the wallet has never held. An id the wallet does not know rejects
   * with `ASSET_NOT_FOUND`.
   */
  assetId?: string;
  /** Omit for an any-amount invoice. */
  amount?: number;
  durationSeconds?: number;
  /**
   * Raised to the wallet's floor — at least 3, since RGB reorgs are not handled
   * and would lose the assets. The result carries the value used.
   */
  minConfirmations?: number;
}

export interface RgbBlindReceiveResult {
  invoice: string;
  recipientId?: string;
  expirationTimestamp?: number;
  /** Confirmations the wallet will wait for — at least what was asked. */
  minConfirmations?: number;
}

export interface RgbIssueAssetArgs {
  /** Only `"nia"` is served today; `"uda"` and `"cfa"` reject with METHOD_NOT_SUPPORTED. */
  schema: "nia" | "uda" | "cfa";
  /** 1–8 uppercase letters or digits. */
  ticker: string;
  name: string;
  /** Per-allocation issuance amounts. */
  amounts: number[];
  precision?: number;
}

export interface RgbIssueAssetResult {
  assetId: string;
  asset: Record<string, unknown>;
}

/**
 * One asset the wallet holds. Wallets carry more fields than these; the named
 * ones are what a conforming wallet always provides.
 */
export interface RgbAsset {
  /** Asset id (`rgb:…`). Some wallets spell it `asset_id`. */
  id?: string;
  asset_id?: string;
  ticker?: string;
  name?: string;
  precision?: number;
  [key: string]: unknown;
}

/**
 * A conforming wallet returns a plain array. Older builds wrap it, so the type
 * stays wide — pass the result through {@link toAssetArray}.
 */
export type RgbAssetList = RgbAsset[] | { assets?: RgbAsset[]; [key: string]: unknown };

/** Narrow any shape a wallet returns from `listAssets()` to an array. */
export declare function toAssetArray(result: unknown): RgbAsset[];

export interface RgbAssetBalance {
  assetId: string;
  balance: number;
  raw: unknown;
}

export type RgbSendAssetArgs =
  | {
      /** Receiver's RGB invoice (`rgb:…/…utxob:…`). Preferred. */
      invoice: string;
      feeRate?: number;
    }
  | {
      assetId: string;
      amount: number;
      recipientId: string;
      feeRate?: number;
      transportEndpoints?: string[];
    };

/** What a wallet reports once it has broadcast a send. Fields are best-effort. */
export interface RgbSendAssetResult {
  txid?: string;
  transferId?: string | number;
  status?: RgbTransferStatus;
  assetId?: string;
  amount?: number;
  recipientId?: string;
  [key: string]: unknown;
}

/** EVM destination for a BFA burn; the chain is checked separately from the address. */
export interface RgbBurnRecipient {
  chainId: `eip155:${number}`;
  /** 20-byte hex address, with a 0x prefix. */
  address: `0x${string}`;
}

export interface RgbBurnAssetArgs {
  /** Fresh UUIDv4 per intent; persist it before calling and reuse it on retry. */
  requestId: string;
  /** Expected RGB network, checked against getInfo().network. */
  network: string;
  assetId: string;
  /** Positive base-unit decimal integer, at most 18446744073709551615 (u64). */
  amount: string;
  burnRecipient: RgbBurnRecipient;
  /** sat/vB; the wallet validates its backend's supported range. */
  feeRate?: number;
  minConfirmations?: number;
}

/** Returned after broadcast; it does not report an EVM payout. */
export interface RgbBurnAssetResult {
  requestId: string;
  transferId: string | number;
  txid: string;
  assetId: string;
  amount: string;
  burnRecipient: RgbBurnRecipient;
  status: RgbTransferStatus;
  /** Confirmations the wallet will wait for, as shown in the prompt. */
  minConfirmations: number;
}

export interface RgbGetConsignmentArgs {
  assetId: string;
  /** Bitcoin transaction id of the burn, as 64 hex characters. */
  txid: string;
}

export interface RgbGetConsignmentResult {
  assetId: string;
  txid: string;
  encoding: "base64";
  /** Complete proof bytes as standard padded Base64, without a data: prefix. */
  data: string;
  /** Length of the decoded bytes. */
  byteLength: number;
  /** Keccak-256 of the decoded bytes; value is 0x followed by 64 hex characters. */
  digest: { algorithm: "keccak256"; value: `0x${string}` };
}

export interface RgbTransfer {
  assetId?: string;
  transferId?: string | number;
  status?: RgbTransferStatus;
  kind?: string;
  amount?: number;
  /** Burn request handle, also accepted by getTransferStatus for its origin. */
  requestId?: string;
  /** Exact burn amount; use this instead of the legacy numeric amount. */
  amountBaseUnits?: string;
  /** Actual Bitcoin anchor height; null while unconfirmed or unknown. */
  blockHeight?: number | null;
  /** Observed Bitcoin confirmations, not the requested minimum. */
  confirmations?: number;
  recipientId?: string;
  txid?: string;
  [key: string]: unknown;
}

/**
 * A conforming wallet returns a plain array. Older builds pass the node's own
 * envelope through — use {@link toTransferArray}.
 */
export type RgbTransferList =
  | RgbTransfer[]
  | { transfers?: RgbTransfer[]; [key: string]: unknown };

/** Narrow any shape a wallet returns from `listTransfers()` to an array. */
export declare function toTransferArray(result: unknown): RgbTransfer[];

/** What an RGB invoice asks for, as the wallet reads it. */
export interface RgbDecodedInvoice {
  assetId?: string;
  /**
   * Units the invoice moves, or `null` for an any-amount invoice — including
   * one whose fungible assignment is `0`. A wallet may refuse to pay one
   * unattended, since nothing fixes what leaves it.
   */
  amount: number | null;
  recipientId?: string;
  expirationTimestamp?: number;
  network?: string;
  transportEndpoints?: string[];
  /** The wallet's own decode, unmapped. */
  raw?: Record<string, unknown>;
}

export interface RgbTransferStatusResult {
  found: boolean;
  status: RgbTransferStatus | null;
  transfer: RgbTransfer | null;
}

export interface RgbMakeLnInvoiceArgs {
  assetId: string;
  /** Omit for an any-amount invoice. */
  assetAmount?: number;
  /**
   * Bitcoin the HTLC carries. The node enforces a floor and the wallet raises
   * the figure to it; the confirmation shows what is actually encoded.
   */
  amountSats?: number;
  description?: string;
  expirySeconds?: number;
}

export interface RgbMakeLnInvoiceResult {
  /** BOLT-11 invoice carrying the asset. */
  invoice: string;
  paymentHash: string;
  expiresAt?: number;
  assetId: string;
  assetAmount?: number;
}

export interface RgbPayLnInvoiceResult {
  paymentHash: string;
  preimage?: string;
  status?: string;
  /** Bitcoin the HTLC carried. */
  amountSats: number;
  assetId?: string;
  assetAmount?: number;
}

export type RgbEvent = "transferReceived" | "transferSettled";

export interface RgbProvider {
  readonly enabled: boolean;
  /** Connect the origin. Shares the approval with webln/webbtc. */
  enable(): Promise<void>;
  getInfo(): Promise<RgbInfo>;
  /** Bitcoin address of the RGB wallet, used to anchor RGB state. */
  getAddress(): Promise<{ address: string }>;
  blindReceive(args?: RgbBlindReceiveArgs): Promise<RgbBlindReceiveResult>;
  issueAsset(args: RgbIssueAssetArgs): Promise<RgbIssueAssetResult>;
  listAssets(): Promise<RgbAssetList>;
  getAssetBalance(assetId: string): Promise<RgbAssetBalance>;
  sendAsset(args: RgbSendAssetArgs): Promise<RgbSendAssetResult>;
  /** Optional BFA burn extension; requires a separate wallet confirmation. */
  burnAsset?(args: RgbBurnAssetArgs): Promise<RgbBurnAssetResult>;
  /** Optional retrieval of an existing burn proof, with consent to share it. */
  getConsignment?(args: RgbGetConsignmentArgs): Promise<RgbGetConsignmentResult>;
  listTransfers(assetId?: string): Promise<RgbTransferList>;
  getTransferStatus(
    transferId: string | number,
    assetId?: string,
  ): Promise<RgbTransferStatusResult>;
  /**
   * Read what an invoice asks for before paying it. Read-only: it raises no
   * confirmation. Served only by wallets that list it in `getInfo().methods`.
   */
  decodeRgbInvoice(args: { invoice: string } | string): Promise<RgbDecodedInvoice>;
  /** RGB over Lightning; `RGB_LN` wallets only. */
  makeLnInvoice(args: RgbMakeLnInvoiceArgs): Promise<RgbMakeLnInvoiceResult>;
  /** Pay a BOLT-11 invoice that carries an asset; `RGB_LN` wallets only. */
  payLnInvoice(args: { invoice: string } | string): Promise<RgbPayLnInvoiceResult>;
  on(event: RgbEvent, listener: (transfer: RgbTransfer) => void): void;
  off(event: RgbEvent, listener: (transfer: RgbTransfer) => void): void;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** How a wallet identifies itself when it announces a provider. */
export interface RgbProviderInfo {
  /** Fresh per page load (UUIDv4); identifies this announcement, not the wallet. */
  uuid: string;
  /** Human name, e.g. `"KaleidoSwap"`. */
  name: string;
  /** Reverse-DNS wallet id, e.g. `"com.kaleidoswap.extension"`. Stable across loads. */
  rdns: string;
  /** Optional `data:` URI icon. */
  icon?: string;
}

export interface RgbProviderDetail {
  info: RgbProviderInfo;
  provider: RgbProvider;
}

export interface RequestProviderOptions {
  /**
   * How long to wait for a provider before rejecting. Default 3000 ms;
   * `0` rejects at once when none is already installed.
   */
  timeoutMs?: number;
  /** Call `enable()` before resolving, so one `await` yields a usable provider. */
  enable?: boolean;
}

/**
 * Resolve a provider: `window.rgb` if the wallet installed it already,
 * otherwise the first one to answer discovery (`rgb:announceProvider`) or to
 * fire the legacy `rgb:ready`. Rejects with a {@link ProviderError}
 * (`METHOD_NOT_SUPPORTED`) when none appears within the timeout.
 */
export declare function requestProvider(options?: RequestProviderOptions): Promise<RgbProvider>;

export interface ListProvidersOptions {
  /** How long to collect announcements. Default 500 ms. */
  timeoutMs?: number;
  /**
   * Include `window.rgb` as a synthetic detail when it is installed but its
   * wallet never announced. Default `true`.
   */
  includeLegacy?: boolean;
}

/**
 * Ask every installed wallet to announce itself and collect the answers,
 * deduplicated by `rdns`. Use this to offer a picker when more than one RGB
 * wallet may be present; `window.rgb` is a single slot and only one wallet
 * can own it.
 */
export declare function listProviders(
  options?: ListProvidersOptions,
): Promise<RgbProviderDetail[]>;

/**
 * Listen for wallets announcing themselves, and ask those already loaded to
 * announce now. Returns an unsubscribe function.
 */
export declare function onProviderAnnounced(
  listener: (detail: RgbProviderDetail) => void,
): () => void;

/**
 * Announce a provider — the wallet side of discovery. Dispatches
 * `rgb:announceProvider` now and on every later `rgb:requestProvider`, and
 * returns a function that stops answering.
 */
export declare function announceProvider(detail: RgbProviderDetail): () => void;

declare global {
  interface Window {
    rgb?: RgbProvider;
  }

  interface WindowEventMap {
    /** Dispatched once `window.rgb` is installed. */
    "rgb:ready": CustomEvent<{ version: string }>;
    /** A wallet offering a provider, in answer to `rgb:requestProvider` or on load. */
    "rgb:announceProvider": CustomEvent<RgbProviderDetail>;
    /** A page asking every wallet to announce. */
    "rgb:requestProvider": Event;
  }
}

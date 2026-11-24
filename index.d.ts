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
  | "NO_AVAILABLE_UTXOS"
  | "UNSAFE_PSBT"
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
  | "witnessReceive"
  | "createUtxos"
  | "cancelReceive"
  | "getBtcBalance"
  | "refresh"
  | "getAssetMetadata"
  | "signPsbt"
  | "signMessage"
  | "issueAsset"
  | "listAssets"
  | "getAssetBalance"
  | "sendAsset"
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
   * `"RGB_LN"`. Test it with {@link supports} rather than assuming: every
   * `RgbProvider` method exists as a function whether or not it is served, so
   * a method's presence says nothing about support.
   */
  methods: RgbMethod[];
}

/** `true` when `info.methods` lists `method`. */
export declare function supports(info: Pick<RgbInfo, "methods">, method: RgbMethod): boolean;

export interface RgbSignMessageResult {
  /** LND `signmessage` format: zbase32, public key recoverable. */
  signature: string;
}

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

export interface RgbCreateUtxosArgs {
  /** How many UTXOs to create, 1..255. Wallet default when omitted. */
  num?: number;
  /** Sats per UTXO, a positive u32. Wallet default when omitted. */
  size?: number;
  /** sat/vB, positive and finite. The wallet's estimate when omitted. */
  feeRate?: number;
}

export interface RgbCreateUtxosResult {
  /** UTXOs actually created; may be fewer than `num`. */
  created: number;
  size: number;
  feeRate?: number;
}

/** One side of the wallet's bitcoin, in sats: nonnegative safe integers. */
export interface RgbBtcBalanceSide {
  settled: number;
  future: number;
  spendable: number;
}

/** Aggregate figures only: a wallet never exposes outpoints through it. */
export interface RgbBtcBalance {
  vanilla: RgbBtcBalanceSide;
  colored: RgbBtcBalanceSide;
  /**
   * Colorable UTXOs with no RGB allocation, settled or pending, and not
   * reserved by a pending receive; `null` when the wallet cannot tell.
   * `0` does not mean `blindReceive` will reject: a wallet may still allocate
   * a receiving slot on an occupied UTXO.
   */
  freeColorableUtxos: number | null;
}

export interface RgbAssetMetadata {
  assetId: string;
  schema: "nia" | "uda" | "cfa" | "ifa" | (string & {});
  ticker: string | null;
  name: string;
  details: string | null;
  /** Integer, 0..255. */
  precision: number;
  issuedSupply: number;
  /** Unix time in seconds, a safe integer. */
  timestamp: number;
  media: { mime: string; digest: string } | null;
}

export interface RgbSignPsbtOptions {
  /** Return a finalized PSBT. */
  finalize?: boolean;
}

export interface RgbSignPsbtResult {
  /** Base64. */
  psbt: string;
  signedInputs: number;
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

export interface RgbTransfer {
  assetId?: string;
  transferId?: string | number;
  status?: RgbTransferStatus;
  kind?: string;
  amount?: number;
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
  /**
   * Rejects with `NO_AVAILABLE_UTXOS` when the wallet cannot allocate a
   * receiving slot; offer {@link RgbProvider.createUtxos} or
   * {@link RgbProvider.witnessReceive} then.
   */
  blindReceive(args?: RgbBlindReceiveArgs): Promise<RgbBlindReceiveResult>;
  /**
   * A witness invoice: the sender funds a new UTXO, so it works on an empty
   * wallet. Same arguments and result as `blindReceive`.
   */
  witnessReceive(args?: RgbBlindReceiveArgs): Promise<RgbBlindReceiveResult>;
  /**
   * Spend on-chain bitcoin to create colorable UTXOs. Prompts. No automatic
   * retries: a timed-out call may still have spent funds.
   */
  createUtxos(args?: RgbCreateUtxosArgs): Promise<RgbCreateUtxosResult>;
  /**
   * Fail a pending receive this wallet created, releasing the UTXO it
   * reserved. `cancelled: false` when it is unknown or no longer pending.
   */
  cancelReceive(recipientId: string): Promise<{ cancelled: boolean }>;
  /** Read-only. */
  getBtcBalance(): Promise<RgbBtcBalance>;
  /**
   * Sync and advance pending transfers. Read-only from the user's side; no
   * prompt. A failure in the requested scope rejects; a rejection does not
   * mean no transfer advanced, so re-read transfer state afterwards.
   */
  refresh(assetId?: string): Promise<{ refreshed: boolean }>;
  /** Read-only. An unknown asset rejects with `ASSET_NOT_FOUND`. */
  getAssetMetadata(assetId: string): Promise<RgbAssetMetadata>;
  /**
   * Sign the inputs this wallet controls in a base64 PSBT. Rejects with
   * `UNSAFE_PSBT`, before prompting, when any of them holds an RGB
   * allocation: signing it outside a state transition destroys the assets.
   */
  signPsbt(psbt: string, opts?: RgbSignPsbtOptions): Promise<RgbSignPsbtResult>;
  /**
   * Sign `message` as shown to the user, in the LND `signmessage` format.
   * Prompts. An empty or malformed string (a lone surrogate) rejects with
   * `INVALID_PARAMS`.
   */
  signMessage(message: string): Promise<RgbSignMessageResult>;
  issueAsset(args: RgbIssueAssetArgs): Promise<RgbIssueAssetResult>;
  listAssets(): Promise<RgbAssetList>;
  getAssetBalance(assetId: string): Promise<RgbAssetBalance>;
  sendAsset(args: RgbSendAssetArgs): Promise<RgbSendAssetResult>;
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

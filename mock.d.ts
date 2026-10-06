/**
 * An in-memory `window.rgb` for building and testing a dApp without a wallet
 * installed. It enforces the same rules a real provider does — `NOT_ENABLED`
 * before `enable()`, `METHOD_NOT_SUPPORTED` for anything absent from
 * `getInfo().methods` — so code written against it works against a wallet.
 */

import type {
  RgbAsset,
  RgbEvent,
  RgbMethod,
  RgbProtocol,
  RgbProvider,
  RgbProviderInfo,
  RgbSignMessageResult,
  RgbTransfer,
} from "./index.js";

export interface MockProviderOptions {
  network?: string;
  /** Default `"RGB_L1"`. `"RGB_LN"` adds the Lightning methods. */
  protocol?: RgbProtocol;
  /** `getInfo().ready`. Default `true`. */
  ready?: boolean;
  /** Override the served method list; by default it follows `protocol`. */
  methods?: RgbMethod[];
  /** `false` makes `enable()` reject with `USER_REJECTED`. Default `true`. */
  autoEnable?: boolean;
  /** Make every confirmation-gated call reject with `USER_REJECTED`. */
  rejectConfirmations?: boolean;
  /**
   * Opt in to signMessage with a test or wallet signer. Receives the unchanged
   * message after the mock's access, argument and confirmation checks.
   * The mock does not hold a key or generate cryptographic signatures itself.
   */
  signMessage?: (message: string) => Promise<RgbSignMessageResult>;
  /** Assets the wallet starts with. Balances default to 0. */
  assets?: Array<RgbAsset & { balance?: number }>;
  /** Delay every call by this many milliseconds, to shake out missing awaits. */
  latencyMs?: number;
  /**
   * The fewest confirmations `blindReceive` will accept; a lower request is
   * raised to it. Default `1`. The KaleidoSwap extension uses `3`.
   */
  minConfirmationsFloor?: number;
}

export interface MockCall {
  method: RgbMethod;
  args: unknown[];
}

export interface MockRgbProvider extends RgbProvider {
  /** Every call made, in order — assert against this in tests. */
  readonly calls: readonly MockCall[];
  /** Push an event to the page's listeners. */
  emit(event: RgbEvent, transfer: RgbTransfer): void;
  /** Move a transfer to `Settled` and emit `transferSettled`. */
  settle(transferId: string | number): void;
  /** Back to a fresh, un-enabled provider; keeps the assets and options. */
  reset(): void;
}

export declare function createMockProvider(options?: MockProviderOptions): MockRgbProvider;

export interface InstallMockProviderResult {
  provider: MockRgbProvider;
  info: RgbProviderInfo;
  /** Remove `window.rgb` and stop answering discovery. */
  uninstall(): void;
}

/**
 * Put a mock on `window.rgb`, announce it and fire `rgb:ready`, so
 * `requestProvider()` and `listProviders()` find it like a real wallet.
 * Throws outside a browser-like environment.
 */
export declare function installMockProvider(
  options?: MockProviderOptions & { info?: Partial<RgbProviderInfo> },
): InstallMockProviderResult;

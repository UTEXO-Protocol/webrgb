// Runtime behaviour of the package, against a fake window. The declarations
// are checked separately by tsc; these tests are what the .d.ts cannot prove:
// that discovery settles, times out, and cleans up after itself.
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";

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
} from "../index.js";
import { createMockProvider, installMockProvider, mockPsbt } from "../mock.js";
import { formatReport, runConformance } from "../conformance.js";

class FakeWindow extends EventTarget {}

/** Fresh `window` per test; the modules read the global lazily. */
function useWindow() {
  const win = new FakeWindow();
  globalThis.window = win;
  return win;
}

afterEach(() => {
  delete globalThis.window;
});

after(() => {
  delete globalThis.window;
});

/** @param {string} rdns */
function detailFor(rdns, provider = createMockProvider()) {
  return { info: { uuid: `uuid-${rdns}`, name: rdns, rdns }, provider };
}

describe("requestProvider", () => {
  it("resolves an already installed window.rgb", async () => {
    const win = useWindow();
    win.rgb = createMockProvider();
    assert.equal(await requestProvider(), win.rgb);
  });

  it("waits for the legacy rgb:ready event", async () => {
    const win = useWindow();
    const pending = requestProvider({ timeoutMs: 1000 });
    setTimeout(() => {
      win.rgb = createMockProvider();
      win.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));
    }, 5);
    assert.equal(await pending, win.rgb);
  });

  it("resolves from an announcement, without window.rgb", async () => {
    const win = useWindow();
    const detail = detailFor("com.example.wallet");
    const pending = requestProvider({ timeoutMs: 1000 });
    setTimeout(() => {
      win.dispatchEvent(new CustomEvent("rgb:announceProvider", { detail }));
    }, 5);
    assert.equal(await pending, detail.provider);
    assert.equal(win.rgb, undefined);
  });

  it("answers a synchronous announcer even with timeoutMs 0", async () => {
    const win = useWindow();
    const detail = detailFor("com.example.sync");
    const stop = announceProvider(detail);
    assert.equal(await requestProvider({ timeoutMs: 0 }), detail.provider);
    stop();
  });

  it("rejects at once with timeoutMs 0 and no wallet", async () => {
    useWindow();
    await assert.rejects(requestProvider({ timeoutMs: 0 }), (err) => {
      assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
      return true;
    });
  });

  it("times out and leaves no listeners behind", async () => {
    const win = useWindow();
    await assert.rejects(requestProvider({ timeoutMs: 10 }), (err) => {
      assert.ok(isProviderError(err));
      assert.equal(err.code, "METHOD_NOT_SUPPORTED");
      return true;
    });
    // A late announcement must not settle an already-rejected promise, and
    // must not throw from a stale listener.
    win.dispatchEvent(new CustomEvent("rgb:announceProvider", { detail: detailFor("late") }));
    win.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));
  });

  it("reports a ready event that installed nothing", async () => {
    const win = useWindow();
    const pending = requestProvider({ timeoutMs: 1000 });
    setTimeout(() => {
      win.dispatchEvent(new CustomEvent("rgb:ready", { detail: { version: "1.0.0" } }));
    }, 5);
    await assert.rejects(pending, (err) => {
      assert.equal(providerErrorCode(err), "INTERNAL_ERROR");
      return true;
    });
  });

  it("enables the provider when asked", async () => {
    const win = useWindow();
    win.rgb = createMockProvider();
    const provider = await requestProvider({ enable: true });
    assert.equal(provider.enabled, true);
  });

  it("propagates a refused enable()", async () => {
    const win = useWindow();
    win.rgb = createMockProvider({ autoEnable: false });
    await assert.rejects(requestProvider({ enable: true }), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
  });

  it("refuses outside a browser", async () => {
    await assert.rejects(requestProvider(), (err) => {
      assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
      return true;
    });
  });
});

describe("discovery", () => {
  it("collects announcements and deduplicates by rdns", async () => {
    useWindow();
    const first = detailFor("com.example.one");
    const second = detailFor("com.example.two");
    const stops = [
      announceProvider(first),
      announceProvider(second),
      announceProvider(detailFor("com.example.one")),
    ];
    const found = await listProviders({ timeoutMs: 20 });
    assert.deepEqual(
      found.map((d) => d.info.rdns),
      ["com.example.one", "com.example.two"],
    );
    assert.equal(found[0].provider, first.provider);
    assert.equal(found[1].provider, second.provider);
    for (const stop of stops) stop();
  });

  it("includes a legacy window.rgb that never announced", async () => {
    const win = useWindow();
    win.rgb = createMockProvider();
    const found = await listProviders({ timeoutMs: 20 });
    assert.equal(found.length, 1);
    assert.equal(found[0].info.rdns, "global.window.rgb");
    const withoutLegacy = await listProviders({ timeoutMs: 20, includeLegacy: false });
    assert.deepEqual(withoutLegacy, []);
  });

  it("does not list window.rgb twice when its wallet announces", async () => {
    const win = useWindow();
    const detail = detailFor("com.example.wallet");
    win.rgb = detail.provider;
    const stop = announceProvider(detail);
    const found = await listProviders({ timeoutMs: 20 });
    assert.deepEqual(
      found.map((d) => d.info.rdns),
      ["com.example.wallet"],
    );
    stop();
  });

  it("ignores announcements that are not provider details", async () => {
    const win = useWindow();
    const stop = onProviderAnnounced(() => {
      throw new Error("listener ran for a malformed announcement");
    });
    win.dispatchEvent(new CustomEvent("rgb:announceProvider", { detail: { info: {} } }));
    win.dispatchEvent(new CustomEvent("rgb:announceProvider", { detail: null }));
    stop();
  });

  it("stops announcing once the wallet unsubscribes", async () => {
    useWindow();
    const stop = announceProvider(detailFor("com.example.gone"));
    stop();
    assert.deepEqual(await listProviders({ timeoutMs: 20 }), []);
  });

  it("unsubscribes onProviderAnnounced listeners", async () => {
    const win = useWindow();
    /** @type {string[]} */
    const seen = [];
    const stop = onProviderAnnounced((d) => seen.push(d.info.rdns));
    win.dispatchEvent(
      new CustomEvent("rgb:announceProvider", { detail: detailFor("com.example.a") }),
    );
    stop();
    win.dispatchEvent(
      new CustomEvent("rgb:announceProvider", { detail: detailFor("com.example.b") }),
    );
    assert.deepEqual(seen, ["com.example.a"]);
  });

  it("returns nothing outside a browser", async () => {
    assert.deepEqual(await listProviders({ timeoutMs: 20 }), []);
    assert.equal(typeof onProviderAnnounced(() => {}), "function");
    assert.equal(typeof announceProvider(detailFor("com.example.x")), "function");
  });
});

describe("helpers", () => {
  it("recognises a coded error and nothing else", () => {
    const coded = Object.assign(new Error("no"), { code: "USER_REJECTED" });
    assert.equal(isProviderError(coded), true);
    assert.equal(isProviderError(new Error("plain")), false);
    assert.equal(isProviderError(Object.assign(new Error("x"), { code: "NOPE" })), false);
    assert.equal(isProviderError({ code: "USER_REJECTED" }), false);
    assert.equal(isProviderError(null), false);
  });

  it("reads a code off anything", () => {
    assert.equal(providerErrorCode(Object.assign(new Error("x"), { code: "NOT_ENABLED" })), "NOT_ENABLED");
    assert.equal(providerErrorCode("a string"), "INTERNAL_ERROR");
    assert.equal(providerErrorCode(undefined), "INTERNAL_ERROR");
  });

  it("exposes every documented code", () => {
    assert.deepEqual([...RGB_ERROR_CODES], [
      "USER_REJECTED",
      "NOT_ENABLED",
      "METHOD_NOT_SUPPORTED",
      "INVALID_PARAMS",
      "ASSET_NOT_FOUND",
      "NO_AVAILABLE_UTXOS",
      "UNSAFE_PSBT",
      "INTERNAL_ERROR",
    ]);
    assert.throws(() => RGB_ERROR_CODES.push("NEW"));
  });

  it("feature-detects against getInfo().methods", () => {
    assert.equal(supports({ methods: ["getInfo", "payLnInvoice"] }, "payLnInvoice"), true);
    assert.equal(supports({ methods: ["getInfo"] }, "payLnInvoice"), false);
    assert.equal(supports(/** @type {any} */ ({}), "getInfo"), false);
  });

  it("normalises list results a wallet may wrap", () => {
    assert.deepEqual(toAssetArray([{ id: "rgb:a" }]), [{ id: "rgb:a" }]);
    assert.deepEqual(toAssetArray({ assets: [{ id: "rgb:a" }] }), [{ id: "rgb:a" }]);
    assert.deepEqual(toAssetArray({ nia: [] }), []);
    assert.deepEqual(toAssetArray(null), []);
    assert.deepEqual(toTransferArray({ transfers: [{ txid: "x" }] }), [{ txid: "x" }]);
    assert.deepEqual(toTransferArray("nope"), []);
  });
});

describe("mock provider", () => {
  it("refuses calls before enable()", async () => {
    const rgb = createMockProvider();
    await assert.rejects(rgb.getInfo(), (err) => {
      assert.equal(providerErrorCode(err), "NOT_ENABLED");
      return true;
    });
  });

  it("refuses a connection when told to", async () => {
    const rgb = createMockProvider({ autoEnable: false });
    await assert.rejects(rgb.enable(), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
  });

  it("serves Lightning only on an RGB_LN wallet", async () => {
    const l1 = createMockProvider();
    await l1.enable();
    const info = await l1.getInfo();
    assert.equal(supports(info, "makeLnInvoice"), false);
    await assert.rejects(l1.makeLnInvoice({ assetId: "rgb:a" }), (err) => {
      assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
      return true;
    });

    const ln = createMockProvider({ protocol: "RGB_LN", assets: [{ id: "rgb:a", balance: 10 }] });
    await ln.enable();
    assert.equal(supports(await ln.getInfo(), "makeLnInvoice"), true);
    const invoice = await ln.makeLnInvoice({ assetId: "rgb:a", assetAmount: 5 });
    assert.match(invoice.invoice, /^lnbcrt/);
    assert.equal(invoice.assetId, "rgb:a");
    const paid = await ln.payLnInvoice(invoice.invoice);
    assert.equal(typeof paid.paymentHash, "string");
  });

  it("issues, sends, tracks and settles", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    const { assetId } = await rgb.issueAsset({
      schema: "nia",
      ticker: "MOCK",
      name: "Mock",
      amounts: [1000],
    });
    assert.equal((await rgb.getAssetBalance(assetId)).balance, 1000);

    const received = await rgb.blindReceive({ assetId, amount: 5 });
    assert.match(received.invoice, /utxob:/);

    /** @type {unknown[]} */
    const settled = [];
    const listener = (t) => settled.push(t);
    rgb.on("transferSettled", listener);

    const sent = await rgb.sendAsset({ assetId, amount: 100, recipientId: "utxob:them" });
    assert.equal((await rgb.getAssetBalance(assetId)).balance, 900);
    assert.equal(sent.status, "WaitingCounterparty");
    // The initial supply does not follow the balance.
    assert.equal((await rgb.getAssetMetadata(assetId)).issuedSupply, 1000);

    const transfers = toTransferArray(await rgb.listTransfers(assetId));
    assert.equal(transfers.length, 1);

    const before = await rgb.getTransferStatus(sent.transferId);
    assert.equal(before.found, true);
    assert.equal(before.status, "WaitingCounterparty");

    rgb.settle(sent.transferId);
    assert.equal(settled.length, 1);
    assert.equal((await rgb.getTransferStatus(sent.transferId)).status, "Settled");

    rgb.off("transferSettled", listener);
    rgb.emit("transferSettled", { transferId: sent.transferId });
    assert.equal(settled.length, 1);
  });

  it("decodes its own invoices and refuses rubbish", async () => {
    const rgb = createMockProvider({ assets: [{ id: "rgb:a", balance: 5 }] });
    await rgb.enable();
    const { invoice } = await rgb.blindReceive({ assetId: "rgb:a", amount: 2 });
    const decoded = await rgb.decodeRgbInvoice(invoice);
    assert.equal(decoded.assetId, "rgb:a");
    assert.match(String(decoded.recipientId), /^utxob:/);
    await assert.rejects(rgb.decodeRgbInvoice("not-an-invoice"), (err) => {
      assert.equal(providerErrorCode(err), "INVALID_PARAMS");
      return true;
    });
  });

  it("rejects an unimplemented schema and an unknown asset", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    await assert.rejects(
      rgb.issueAsset({ schema: "uda", ticker: "UDA", name: "One", amounts: [1] }),
      (err) => {
        assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
        return true;
      },
    );
    await assert.rejects(rgb.getAssetBalance("rgb:nope"), (err) => {
      assert.equal(providerErrorCode(err), "ASSET_NOT_FOUND");
      return true;
    });
  });

  it("receives an asset it has never held through an any-asset invoice", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    await assert.rejects(rgb.blindReceive({ assetId: "rgb:new" }), (err) => {
      assert.equal(providerErrorCode(err), "ASSET_NOT_FOUND");
      return true;
    });
    await assert.rejects(rgb.blindReceive({ assetId: "not-an-id" }), (err) => {
      assert.equal(providerErrorCode(err), "INVALID_PARAMS");
      return true;
    });

    const { invoice } = await rgb.blindReceive();
    const decoded = await rgb.decodeRgbInvoice(invoice);
    assert.equal(decoded.assetId, undefined);
    assert.match(String(decoded.recipientId), /^utxob:/);
    // Nothing in the invoice says which asset leaves, so only the explicit form pays it.
    await assert.rejects(rgb.sendAsset({ invoice }), (err) => {
      assert.equal(providerErrorCode(err), "INVALID_PARAMS");
      return true;
    });
  });

  it("decodes a fungible-zero invoice as any-amount", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    const decoded = await rgb.decodeRgbInvoice("rgb:a/RGB20/0+utxob:zero");
    assert.equal(decoded.amount, null);
    assert.equal((await rgb.decodeRgbInvoice("rgb:a/RGB20/5+utxob:five")).amount, 5);
  });

  it("decodes the amount of a witness invoice", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    assert.equal((await rgb.decodeRgbInvoice("rgb:a/RGB20/7+wvout:seven")).amount, 7);
    assert.equal((await rgb.decodeRgbInvoice("rgb:a/RGB20/0+wvout:zero")).amount, null);
  });

  it("reports the confirmations it will wait for, raised to its floor", async () => {
    const rgb = createMockProvider({ minConfirmationsFloor: 3, assets: [{ id: "rgb:a" }] });
    await rgb.enable();
    assert.equal((await rgb.blindReceive({ assetId: "rgb:a", minConfirmations: 1 })).minConfirmations, 3);
    assert.equal((await rgb.blindReceive({ minConfirmations: 6 })).minConfirmations, 6);
  });

  it("refuses confirmations when told to, and records every call", async () => {
    const rgb = createMockProvider({ rejectConfirmations: true, assets: [{ id: "rgb:a" }] });
    await rgb.enable();
    await assert.rejects(rgb.blindReceive({ assetId: "rgb:a" }), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
    assert.deepEqual(
      rgb.calls.map((c) => c.method),
      ["enable", "blindReceive"],
    );
    rgb.reset();
    assert.deepEqual(rgb.calls, []);
    assert.equal(rgb.enabled, false);
  });

  it("needs a free UTXO to receive blinded; createUtxos or witnessReceive fix it", async () => {
    const rgb = createMockProvider({ freeColorableUtxos: 0 });
    await rgb.enable();
    assert.equal((await rgb.getBtcBalance()).freeColorableUtxos, 0);
    await assert.rejects(rgb.blindReceive(), (err) => {
      assert.equal(providerErrorCode(err), "NO_AVAILABLE_UTXOS");
      return true;
    });

    const witness = await rgb.witnessReceive({ amount: 3 });
    assert.match(witness.invoice, /wvout:/);
    assert.match(String((await rgb.decodeRgbInvoice(witness.invoice)).recipientId), /^wvout:/);

    const created = await rgb.createUtxos({ num: 2 });
    assert.equal(created.created, 2);
    assert.equal(created.size, 3000);
    const balance = await rgb.getBtcBalance();
    assert.equal(balance.freeColorableUtxos, 2);
    assert.ok(balance.vanilla.spendable < 100_000);
    assert.match((await rgb.blindReceive()).invoice, /utxob:/);
  });

  it("checks createUtxos arguments before prompting, and refuses without funds", async () => {
    const rgb = createMockProvider({ rejectConfirmations: true });
    await rgb.enable();
    for (const bad of [
      { num: 0 }, { num: 256 }, { size: 1.5 }, { size: 2 ** 32 },
      { feeRate: -1 }, { feeRate: Infinity }, { feeRate: NaN },
    ]) {
      await assert.rejects(rgb.createUtxos(bad), (err) => {
        assert.equal(providerErrorCode(err), "INVALID_PARAMS");
        return true;
      });
    }
    await assert.rejects(rgb.createUtxos(), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });

    // Funds are checked before the prompt too, so a refusing user never sees it.
    const poor = createMockProvider({ vanillaSats: 1000, rejectConfirmations: true });
    await poor.enable();
    await assert.rejects(poor.createUtxos(), (err) => {
      assert.equal(providerErrorCode(err), "INTERNAL_ERROR");
      assert.match(err.message, /bitcoin/);
      return true;
    });
  });

  it("counts colored bitcoin by each UTXO's size", async () => {
    const rgb = createMockProvider({ freeColorableUtxos: 1 });
    await rgb.enable();
    await rgb.createUtxos({ num: 2, size: 1000 });
    const before = await rgb.getBtcBalance();
    assert.equal(before.freeColorableUtxos, 3);
    assert.deepEqual(before.colored, { settled: 5000, future: 5000, spendable: 5000 });

    // A blinded receive reserves one UTXO: still colored, no longer spendable.
    const { recipientId } = await rgb.blindReceive();
    const reserved = await rgb.getBtcBalance();
    assert.equal(reserved.colored.settled, 5000);
    assert.equal(reserved.colored.spendable, 5000 - 1000);

    await rgb.cancelReceive(String(recipientId));
    assert.deepEqual((await rgb.getBtcBalance()).colored, before.colored);
  });

  it("cancels a pending receive and releases its UTXO", async () => {
    const rgb = createMockProvider({ freeColorableUtxos: 1 });
    await rgb.enable();
    const { recipientId } = await rgb.blindReceive();
    assert.equal((await rgb.getBtcBalance()).freeColorableUtxos, 0);
    assert.deepEqual(await rgb.cancelReceive(String(recipientId)), { cancelled: true });
    assert.equal((await rgb.getBtcBalance()).freeColorableUtxos, 1);
    assert.deepEqual(await rgb.cancelReceive(String(recipientId)), { cancelled: false });
    assert.deepEqual(await rgb.cancelReceive("utxob:unknown"), { cancelled: false });
    await assert.rejects(rgb.cancelReceive("nonsense"), (err) => {
      assert.equal(providerErrorCode(err), "INVALID_PARAMS");
      return true;
    });

    const witness = await rgb.witnessReceive();
    assert.deepEqual(await rgb.cancelReceive(String(witness.recipientId)), { cancelled: true });
    assert.equal((await rgb.getBtcBalance()).freeColorableUtxos, 1);
  });

  it("signs a message deterministically and checks it before prompting", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    const a = await rgb.signMessage("login:abc");
    assert.match(a.signature, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{104}$/);
    assert.deepEqual(await rgb.signMessage("login:abc"), a);
    assert.notEqual((await rgb.signMessage("login:abd")).signature, a.signature);

    const refusing = createMockProvider({ rejectConfirmations: true });
    await refusing.enable();
    for (const bad of ["", "lone \uD83D surrogate", "\uDE00"]) {
      await assert.rejects(refusing.signMessage(bad), (err) => {
        assert.equal(providerErrorCode(err), "INVALID_PARAMS");
        return true;
      });
    }
    await assert.rejects(refusing.signMessage("paired \uD83D\uDE00 surrogates"), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
    await assert.rejects(refusing.signMessage("hi"), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
  });

  it("reads balances, metadata and refreshes without prompting", async () => {
    const rgb = createMockProvider({
      rejectConfirmations: true,
      assets: [{ id: "rgb:a", ticker: "A", name: "Alpha", precision: 2, balance: 40 }],
    });
    await rgb.enable();
    const balance = await rgb.getBtcBalance();
    assert.equal(balance.vanilla.settled, 100_000);
    assert.equal(balance.freeColorableUtxos, 5);
    const meta = await rgb.getAssetMetadata("rgb:a");
    assert.equal(meta.schema, "nia");
    assert.equal(meta.ticker, "A");
    assert.equal(meta.precision, 2);
    assert.equal(meta.issuedSupply, 40);
    assert.equal(meta.media, null);
    await assert.rejects(rgb.getAssetMetadata("rgb:nope"), (err) => {
      assert.equal(providerErrorCode(err), "ASSET_NOT_FOUND");
      return true;
    });
    assert.deepEqual(await rgb.refresh(), { refreshed: false });
    assert.deepEqual(await rgb.refresh("rgb:a"), { refreshed: false });
  });

  it("signs only vanilla inputs it owns", async () => {
    const rgb = createMockProvider();
    await rgb.enable();
    const psbt = mockPsbt({
      inputs: [{ mine: true }, { mine: false }],
      outputs: [{ address: "tb1qdest", amount: 1000 }],
      fee: 200,
    });
    const signed = await rgb.signPsbt(psbt, { finalize: true });
    assert.equal(signed.signedInputs, 1);
    const decoded = JSON.parse(atob(signed.psbt));
    assert.equal(decoded.finalized, true);
    assert.equal(decoded.inputs[0].signed, true);

    const refusing = createMockProvider({ rejectConfirmations: true });
    await refusing.enable();
    // UNSAFE_PSBT comes before the prompt, so a refusing user never sees it.
    await assert.rejects(
      refusing.signPsbt(mockPsbt({ inputs: [{ mine: true, colored: true }] })),
      (err) => {
        assert.equal(providerErrorCode(err), "UNSAFE_PSBT");
        return true;
      },
    );
    for (const bad of [mockPsbt({ inputs: [{ mine: false }] }), "not-base64-json"]) {
      await assert.rejects(refusing.signPsbt(bad), (err) => {
        assert.equal(providerErrorCode(err), "INVALID_PARAMS");
        return true;
      });
    }
    await assert.rejects(refusing.signPsbt(psbt), (err) => {
      assert.equal(providerErrorCode(err), "USER_REJECTED");
      return true;
    });
  });

  it("refuses the new methods when not enabled or not listed", async () => {
    const rgb = createMockProvider({ methods: ["enable", "getInfo"] });
    await assert.rejects(rgb.getBtcBalance(), (err) => {
      assert.equal(providerErrorCode(err), "NOT_ENABLED");
      return true;
    });
    await rgb.enable();
    for (const attempt of [
      () => rgb.getBtcBalance(),
      () => rgb.refresh(),
      () => rgb.getAssetMetadata("rgb:a"),
      () => rgb.witnessReceive(),
      () => rgb.createUtxos(),
      () => rgb.cancelReceive("utxob:x"),
      () => rgb.signPsbt(mockPsbt({ inputs: [{ mine: true }] })),
    ]) {
      await assert.rejects(attempt, (err) => {
        assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
        return true;
      });
    }
  });

  it("installs on window and answers discovery", async () => {
    const win = useWindow();
    const { provider, info, uninstall } = installMockProvider({ protocol: "RGB_LN" });
    assert.equal(win.rgb, provider);
    const found = await listProviders({ timeoutMs: 20 });
    assert.deepEqual(
      found.map((d) => d.info.rdns),
      [info.rdns],
    );
    uninstall();
    assert.equal(win.rgb, undefined);
    assert.deepEqual(await listProviders({ timeoutMs: 20 }), []);
  });

  it("will not install outside a browser", () => {
    assert.throws(() => installMockProvider(), (err) => {
      assert.equal(providerErrorCode(err), "METHOD_NOT_SUPPORTED");
      return true;
    });
  });
});

describe("conformance", () => {
  it("passes a conforming wallet", async () => {
    const rgb = createMockProvider({ assets: [{ id: "rgb:a", ticker: "A", balance: 7 }] });
    const report = await runConformance(rgb);
    assert.equal(report.ok, true, formatReport(report));
    assert.equal(report.failed, 0);
    assert.ok(report.passed >= 10, formatReport(report));
  });

  it("passes an RGB_LN wallet, which serves the Lightning methods", async () => {
    const rgb = createMockProvider({
      protocol: "RGB_LN",
      assets: [{ id: "rgb:a", balance: 1 }],
    });
    const report = await runConformance(rgb);
    assert.equal(report.ok, true, formatReport(report));
    const ln = report.checks.find((c) => c.name === "ln-methods-match-protocol");
    assert.equal(ln?.status, "pass");
  });

  it("catches a wallet that lists Lightning without a node", async () => {
    const rgb = createMockProvider({
      protocol: "RGB_L1",
      methods: ["enable", "getInfo", "getAddress", "listAssets", "getAssetBalance",
        "listTransfers", "getTransferStatus", "on", "off", "makeLnInvoice", "payLnInvoice"],
    });
    const report = await runConformance(rgb);
    assert.equal(report.ok, false);
    const ln = report.checks.find((c) => c.name === "ln-methods-match-protocol");
    assert.equal(ln?.status, "fail");
  });

  it("catches a wallet that serves calls before enable()", async () => {
    const rgb = createMockProvider();
    const leaky = Object.create(rgb);
    leaky.getAddress = async () => ({ address: "bcrt1qleak" });
    const report = await runConformance(leaky);
    const guard = report.checks.find((c) => c.name === "not-enabled-guard");
    assert.equal(guard?.status, "fail");
    assert.equal(report.ok, false);
  });

  it("checks decoding only when the wallet serves it", async () => {
    const serving = await runConformance(createMockProvider());
    assert.equal(
      serving.checks.find((c) => c.name === "decode-rejects-rubbish")?.status,
      "pass",
      formatReport(serving),
    );

    const notServing = createMockProvider({
      methods: ["enable", "getInfo", "getAddress", "listAssets", "getAssetBalance",
        "listTransfers", "getTransferStatus", "on", "off"],
    });
    const report = await runConformance(notServing);
    assert.equal(report.checks.find((c) => c.name === "decode-rejects-rubbish")?.status, "skip");
    assert.equal(report.ok, true, formatReport(report));
  });

  it("checks the 0.4 read-only methods only when listed", async () => {
    const report = await runConformance(createMockProvider({ assets: [{ id: "rgb:a", balance: 1 }] }));
    for (const name of ["getBtcBalance-shape", "getAssetMetadata-miss", "getAssetMetadata-shape", "refresh-shape"]) {
      assert.equal(report.checks.find((c) => c.name === name)?.status, "pass", formatReport(report));
    }

    const older = await runConformance(
      createMockProvider({
        methods: ["enable", "getInfo", "getAddress", "listAssets", "getAssetBalance",
          "listTransfers", "getTransferStatus", "on", "off"],
      }),
    );
    assert.equal(older.checks.find((c) => c.name === "getBtcBalance-shape")?.status, "skip");
    assert.equal(older.ok, true, formatReport(older));
  });

  it("catches a balance that leaks outpoints and a metadata miss with the wrong code", async () => {
    const rgb = createMockProvider();
    const leaky = Object.create(rgb);
    leaky.getBtcBalance = async () => ({
      vanilla: { settled: 1, future: 1, spendable: 1 },
      colored: { settled: 0, future: 0, spendable: 0 },
      freeColorableUtxos: 1,
      free: [`${"ab".repeat(32)}:0`],
    });
    leaky.getAssetMetadata = async () => {
      throw Object.assign(new Error("boom"), { code: "INTERNAL_ERROR" });
    };
    const report = await runConformance(leaky);
    assert.equal(report.checks.find((c) => c.name === "getBtcBalance-shape")?.status, "fail");
    assert.equal(report.checks.find((c) => c.name === "getAssetMetadata-miss")?.status, "fail");
  });

  it("requires every method and probes unlisted reads", async () => {
    const report = await runConformance(createMockProvider());
    assert.equal(report.checks.find((c) => c.name === "methods-present")?.status, "pass");
    for (const name of ["getBtcBalance-unlisted", "refresh-unlisted", "getAssetMetadata-unlisted"]) {
      assert.equal(report.checks.find((c) => c.name === name)?.status, "skip", name);
    }

    const older = await runConformance(
      createMockProvider({
        methods: ["enable", "getInfo", "getAddress", "listAssets", "getAssetBalance",
          "listTransfers", "getTransferStatus", "on", "off"],
      }),
    );
    for (const name of ["getBtcBalance-unlisted", "refresh-unlisted", "getAssetMetadata-unlisted"]) {
      assert.equal(older.checks.find((c) => c.name === name)?.status, "pass", formatReport(older));
    }

    const rgb = createMockProvider({ methods: ["enable", "getInfo", "getAddress", "listAssets",
      "getAssetBalance", "listTransfers", "getTransferStatus", "on", "off"] });
    const partial = Object.create(rgb);
    partial.signPsbt = undefined;
    partial.getBtcBalance = async () => ({
      vanilla: { settled: 0, future: 0, spendable: 0 },
      colored: { settled: 0, future: 0, spendable: 0 },
      freeColorableUtxos: 0,
    });
    const bad = await runConformance(partial);
    const present = bad.checks.find((c) => c.name === "methods-present");
    assert.equal(present?.status, "fail");
    assert.match(String(present?.detail), /signPsbt/);
    assert.equal(bad.checks.find((c) => c.name === "getBtcBalance-unlisted")?.status, "fail");
  });

  it("rejects each fractional, negative or unsafe balance and metadata number", async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const goodBalance = () => ({
      vanilla: { settled: 1, future: 1, spendable: 1 },
      colored: { settled: 0, future: 0, spendable: 0 },
      freeColorableUtxos: 0,
    });
    const goodMeta = (/** @type {string} */ assetId) => ({ assetId, schema: "nia", ticker: null,
      name: "A", details: null, precision: 2, issuedSupply: 1, timestamp: 1_700_000_000, media: null });

    /**
     * @param {(balance: any) => void} breakBalance
     * @param {(meta: any) => void} breakMeta
     */
    const run = (breakBalance, breakMeta) => {
      const odd = Object.create(createMockProvider({ assets: [{ id: "rgb:a", balance: 1 }] }));
      odd.getBtcBalance = async () => {
        const balance = goodBalance();
        breakBalance(balance);
        return balance;
      };
      odd.getAssetMetadata = async (/** @type {string} */ assetId) => {
        if (assetId !== "rgb:a") throw Object.assign(new Error("no"), { code: "ASSET_NOT_FOUND" });
        const meta = goodMeta(assetId);
        breakMeta(meta);
        return meta;
      };
      return runConformance(odd);
    };
    const status = async (/** @type {Promise<any>} */ report, /** @type {string} */ name) =>
      (await report).checks.find((/** @type {any} */ c) => c.name === name)?.status;

    // The unbroken fixture passes, so each failure below comes from one field.
    const clean = await run(() => {}, () => {});
    assert.equal(await status(Promise.resolve(clean), "getBtcBalance-shape"), "pass", formatReport(clean));
    assert.equal(await status(Promise.resolve(clean), "getAssetMetadata-shape"), "pass", formatReport(clean));

    /** @type {[string, (balance: any) => void][]} */
    const badBalances = [
      ["fractional sats", (b) => { b.vanilla.settled = 1.5; }],
      ["negative sats", (b) => { b.colored.spendable = -1; }],
      ["unsafe sats", (b) => { b.vanilla.future = unsafe; }],
      ["fractional count", (b) => { b.freeColorableUtxos = 0.5; }],
      ["negative count", (b) => { b.freeColorableUtxos = -1; }],
      ["unsafe count", (b) => { b.freeColorableUtxos = unsafe; }],
    ];
    for (const [label, breakBalance] of badBalances) {
      assert.equal(await status(run(breakBalance, () => {}), "getBtcBalance-shape"), "fail", label);
    }

    /** @type {[string, (meta: any) => void][]} */
    const badMetas = [
      ["precision above 255", (m) => { m.precision = 256; }],
      ["negative precision", (m) => { m.precision = -1; }],
      ["fractional precision", (m) => { m.precision = 1.5; }],
      ["fractional timestamp", (m) => { m.timestamp = 1.5; }],
      ["unsafe timestamp", (m) => { m.timestamp = unsafe; }],
    ];
    for (const [label, breakMeta] of badMetas) {
      assert.equal(await status(run(() => {}, breakMeta), "getAssetMetadata-shape"), "fail", label);
    }
  });

  it("catches a wallet that wraps its lists", async () => {
    const rgb = createMockProvider();
    const wrapping = Object.create(rgb);
    wrapping.listAssets = async () => ({ assets: [{ id: "rgb:a" }] });
    const report = await runConformance(wrapping);
    const listed = report.checks.find((c) => c.name === "listAssets-array");
    assert.equal(listed?.status, "fail");
  });

  it("formats a report", async () => {
    const report = await runConformance(createMockProvider());
    const text = formatReport(report);
    assert.match(text, /getInfo-shape/);
    assert.match(text, /conformant: \d+ passed/);
  });
});

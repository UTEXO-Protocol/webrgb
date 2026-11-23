import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockProvider } from "../mock.js";
import { formatReport, runConformance } from "../conformance.js";

describe("selected upstream wallet methods", () => {
  it("gates UTXO spending, then makes a previously unavailable blinded receive possible", async () => {
    const wallet = createMockProvider({ freeColorableUtxos: 0 });
    await assert.rejects(wallet.createUtxos(), { code: "NOT_ENABLED" });
    await wallet.enable();
    await assert.rejects(wallet.blindReceive(), { code: "NO_AVAILABLE_UTXOS" });
    assert.match((await wallet.witnessReceive()).recipientId, /^wvout:/);
    const before = await wallet.getBtcBalance();
    assert.deepEqual(await wallet.createUtxos({ num: 2, size: 3000, feeRate: 2 }), {
      created: 2, size: 3000, feeRate: 2,
    });
    assert.match((await wallet.blindReceive()).recipientId, /^utxob:/);
    const after = await wallet.getBtcBalance();
    assert.equal(after.freeColorableUtxos, 1);
    assert.equal(after.colored.settled, 6000);
    assert.ok(after.vanilla.spendable < before.vanilla.spendable);
  });

  it("accepts a fractional fee rate and charges whole sats", async () => {
    const wallet = createMockProvider();
    await wallet.enable();
    const before = (await wallet.getBtcBalance()).vanilla.spendable;
    assert.deepEqual(await wallet.createUtxos({ num: 1, size: 3000, feeRate: 1.5 }), {
      created: 1, size: 3000, feeRate: 1.5,
    });
    const spent = before - (await wallet.getBtcBalance()).vanilla.spendable;
    assert.equal(spent, 3000 + Math.ceil(1.5 * (110 + 43)));
  });

  it("rejects native bounds before prompting and does not spend when consent is declined", async () => {
    const wallet = createMockProvider({ rejectConfirmations: true });
    await wallet.enable();
    const before = await wallet.getBtcBalance();
    for (const args of [{ num: 0 }, { num: 256 }, { size: 2 ** 32 }, { size: 0 },
      { feeRate: Infinity }, { feeRate: NaN }, { feeRate: "2" }, { feeRate: 0 }, { feeRate: -0.5 }]) {
      await assert.rejects(wallet.createUtxos(args), { code: "INVALID_PARAMS" });
    }
    await assert.rejects(wallet.createUtxos(), { code: "USER_REJECTED" });
    assert.deepEqual(await wallet.getBtcBalance(), before);
    const empty = createMockProvider({ vanillaSats: 0 });
    await empty.enable();
    await assert.rejects(empty.createUtxos(), { code: "INTERNAL_ERROR" });
  });

  it("preserves the initial u64 supply after spending and supports the BFA schema", async () => {
    const wallet = createMockProvider({ assets: [{
      id: "rgb:bfa", balance: 10, schema: "bfa", issuedSupply: "18446744073709551615",
    }] });
    await wallet.enable();
    await wallet.sendAsset({ assetId: "rgb:bfa", amount: 3, recipientId: "utxob:test" });
    const metadata = await wallet.getAssetMetadata("rgb:bfa");
    assert.equal(metadata.schema, "bfa");
    assert.equal(metadata.issuedSupply, "18446744073709551615");
    assert.equal((await wallet.getAssetBalance("rgb:bfa")).balance, 7);
    assert.equal((await runConformance(wallet)).ok, true);
    await assert.rejects(wallet.getAssetMetadata("rgb:absent"), { code: "ASSET_NOT_FOUND" });
    const rounded = createMockProvider({ assets: [{ id: "rgb:x", issuedSupply: 2 ** 53 }] });
    await rounded.enable();
    await assert.rejects(rounded.getAssetMetadata("rgb:x"), { code: "INTERNAL_ERROR" });
  });

  it("keeps reads prompt-free and does not turn an unknown refresh asset into false", async () => {
    const wallet = createMockProvider({ rejectConfirmations: true, assets: [{ id: "rgb:x" }] });
    await wallet.enable();
    await wallet.getBtcBalance();
    await wallet.getAssetMetadata("rgb:x");
    assert.deepEqual(await wallet.refresh("rgb:x"), { refreshed: false });
    await assert.rejects(wallet.refresh("rgb:absent"), { code: "ASSET_NOT_FOUND" });
  });

  it("does not call spending methods during conformance and probes only safe unlisted reads", async () => {
    const wallet = createMockProvider();
    assert.equal((await runConformance(wallet)).ok, true);
    assert.equal(wallet.calls.some(({ method }) => method === "createUtxos"), false);
    const info = await wallet.getInfo();
    const added = ["createUtxos", "getBtcBalance", "refresh", "getAssetMetadata"];
    const unlisted = createMockProvider({ methods: info.methods.filter((method) => !added.includes(method)) });
    const report = await runConformance(unlisted);
    assert.equal(report.ok, true, formatReport(report));
    assert.equal(unlisted.calls.some(({ method }) => method === "createUtxos"), false);
    assert.equal(report.checks.find(({ name }) => name === "createUtxos-available").status, "skip");
    for (const method of ["getBtcBalance", "refresh", "getAssetMetadata"]) {
      assert.equal(report.checks.find(({ name }) => name === `${method}-available`).status, "pass");
    }
  });

  it("fails an unlisted method that is missing or served anyway", async () => {
    const wallet = createMockProvider();
    await wallet.enable();
    const info = await wallet.getInfo();
    const unlisted = createMockProvider({ methods: info.methods.filter((method) => method !== "getBtcBalance" && method !== "createUtxos") });
    delete unlisted.createUtxos;
    unlisted.getBtcBalance = async () => ({ vanilla: { settled: 0, future: 0, spendable: 0 }, colored: { settled: 0, future: 0, spendable: 0 }, freeColorableUtxos: 0 });
    const report = await runConformance(unlisted);
    assert.equal(report.checks.find(({ name }) => name === "createUtxos-available").status, "fail");
    assert.equal(report.checks.find(({ name }) => name === "getBtcBalance-available").status, "fail");
  });

  it("fails a provider that lacks any declared method", async () => {
    const passing = await runConformance(createMockProvider());
    assert.equal(passing.checks.find(({ name }) => name === "methods-present").status, "pass");
    for (const method of ["blindReceive", "issueAsset", "sendAsset", "decodeRgbInvoice", "makeLnInvoice", "off"]) {
      const wallet = createMockProvider();
      delete wallet[method];
      const check = (await runConformance(wallet)).checks.find(({ name }) => name === "methods-present");
      assert.equal(check.status, "fail", method);
      assert.match(check.detail, new RegExp(`lacks ${method};`));
    }
  });

  it("detects advertised-but-missing methods and a failed native refresh", async () => {
    const wallet = createMockProvider();
    delete wallet.createUtxos;
    wallet.refresh = async () => { throw Object.assign(new Error("No EVM RPC"), { code: "INTERNAL_ERROR" }); };
    const report = await runConformance(wallet);
    assert.equal(report.checks.find(({ name }) => name === "createUtxos-available").status, "fail");
    assert.equal(report.checks.find(({ name }) => name === "refresh-shape").status, "fail");
  });

  it("rejects outpoint disclosure and number-valued initial supply", async () => {
    const wallet = createMockProvider({ assets: [{ id: "rgb:x", balance: 2 }] });
    const balance = wallet.getBtcBalance.bind(wallet);
    wallet.getBtcBalance = async () => ({ ...await balance(), utxos: ["a".repeat(64) + ":0"] });
    const metadata = wallet.getAssetMetadata.bind(wallet);
    wallet.getAssetMetadata = async (id) => ({ ...await metadata(id), issuedSupply: 2 });
    const report = await runConformance(wallet);
    assert.equal(report.checks.find(({ name }) => name === "getBtcBalance-shape").status, "fail");
    assert.equal(report.checks.find(({ name }) => name === "getAssetMetadata-shape").status, "fail");
  });
});

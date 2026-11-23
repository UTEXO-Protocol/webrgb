import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockProvider } from "../mock.js";
import { runConformance } from "../conformance.js";

const destination = {
  version: 1,
  chainId: "eip155:137",
  address: "0x" + "11".repeat(20),
  dstEid: 30109,
};
const args = () => ({
  network: "signet", assetId: "rgb:bfa", amount: "1000000",
  burnDestination: { ...destination }, feeRate: 2, minConfirmations: 6,
});
const result = (request) => ({
  transferId: 1, txid: "a".repeat(64), assetId: request.assetId,
  amount: request.amount, burnDestination: request.burnDestination,
  status: "WaitingConfirmations", minConfirmations: 6,
});

describe("single burn destination contract", () => {
  it("passes one approved native-address destination through an explicit fixture", async () => {
    let received;
    const wallet = createMockProvider({
      assets: [{ id: "rgb:bfa" }],
      burnAsset: async (request) => { received = request; return result(request); },
    });
    await assert.rejects(wallet.burnAsset(args()), { code: "NOT_ENABLED" });
    await wallet.enable();
    const request = args();
    const pending = wallet.burnAsset(request);
    request.burnDestination.version = 2;
    request.burnDestination.dstEid = 30101;
    request.amount = "2";
    const response = await pending;
    assert.deepEqual(received, args());
    assert.deepEqual(response.burnDestination, destination);
    assert.equal(response.amount, "1000000");
    assert.equal("burnRecipient" in response, false);
  });

  it("rejects legacy, mixed, incomplete and imprecise requests before confirmation", async () => {
    let called = false;
    const wallet = createMockProvider({
      assets: [{ id: "rgb:bfa" }], rejectConfirmations: true,
      burnAsset: async (request) => { called = true; return result(request); },
    });
    await wallet.enable();
    const { burnDestination, ...withoutDestination } = args();
    const legacy = { ...withoutDestination, burnRecipient: { chainId: destination.chainId, address: destination.address } };
    for (const request of [
      withoutDestination, legacy, { ...args(), burnRecipient: legacy.burnRecipient },
      { ...args(), amount: 1000000 }, { ...args(), amount: "18446744073709551616" },
      { ...args(), burnDestination: { ...destination, dstEid: undefined } },
      { ...args(), burnDestination: { ...destination, dstEid: -1 } },
      { ...args(), burnDestination: { ...destination, dstEid: 2 ** 32 } },
      { ...args(), burnDestination: { ...destination, destinationChainId: 137 } },
      { ...args(), feeRate: 0 }, { ...args(), minConfirmations: 256 },
    ]) {
      await assert.rejects(wallet.burnAsset(request), { code: "INVALID_PARAMS" });
    }
    assert.equal(called, false);
    await assert.rejects(wallet.burnAsset(args()), { code: "USER_REJECTED" });
    assert.equal(called, false);
  });

  it("rejects missing and unsupported versions before confirmation or burn", async () => {
    let called = false;
    const wallet = createMockProvider({
      assets: [{ id: "rgb:bfa" }], rejectConfirmations: true,
      burnAsset: async (request) => { called = true; return result(request); },
    });
    await wallet.enable();
    const { version, ...unversioned } = destination;
    for (const burnDestination of [
      unversioned,
      ...[undefined, null, "1", 0, 2, 1.5, true].map((version) => ({ ...destination, version })),
    ]) {
      await assert.rejects(wallet.burnAsset({ ...args(), burnDestination }), { code: "INVALID_PARAMS" });
    }
    assert.equal(called, false);
    await assert.rejects(wallet.burnAsset(args()), { code: "USER_REJECTED" });
    assert.equal(called, false);
  });

  it("does not advertise or construct burns without a fixture, and conformance never calls it", async () => {
    const plain = createMockProvider();
    await plain.enable();
    assert.equal(typeof plain.burnAsset, "function");
    assert.equal((await plain.getInfo()).methods.includes("burnAsset"), false);
    await assert.rejects(plain.burnAsset({}), { code: "METHOD_NOT_SUPPORTED" });
    const fixture = createMockProvider({ burnAsset: async () => { throw new Error("must not burn"); } });
    assert.equal((await runConformance(fixture)).ok, true);
    assert.equal(fixture.calls.some(({ method }) => method === "burnAsset"), false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { consumeToolEffectReceipt } from "../tool-effect-receipt.js";
import { callGatewayTool } from "./gateway.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));
vi.mock("../../infra/device-identity.js", () => ({
  loadDeviceIdentityIfPresent: () => undefined,
  loadOrCreateDeviceIdentity: () => ({
    deviceId: "effect-test",
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
  }),
}));

describe("Gateway tool effect provenance", () => {
  beforeEach(() => mocks.callGateway.mockReset());

  it("turns structured Gateway no-dispatch proof into a host-owned no-effect receipt", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "invalid cron.update params",
      requestEffect: "not_started",
    });
    mocks.callGateway.mockRejectedValueOnce(error);

    await expect(callGatewayTool("cron.update", {}, { id: "job-1", patch: {} })).rejects.toBe(
      error,
    );
    expect(consumeToolEffectReceipt(error)).toEqual({ state: "not_started" });
  });

  it("preserves a started request's explicit no-effect proof", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "cron job changed before commit",
      requestEffect: "failed_no_effect",
    });
    mocks.callGateway.mockRejectedValueOnce(error);

    await expect(callGatewayTool("cron.update", {}, { id: "job-1", patch: {} })).rejects.toBe(
      error,
    );
    expect(consumeToolEffectReceipt(error)).toEqual({ state: "failed_no_effect" });
  });

  it("does not infer no effect from an INVALID_REQUEST code or message", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "invalid cron.update params",
    });
    mocks.callGateway.mockRejectedValueOnce(error);

    await expect(callGatewayTool("cron.update", {}, { id: "job-1", patch: {} })).rejects.toBe(
      error,
    );
    expect(consumeToolEffectReceipt(error)).toBeUndefined();
  });
});

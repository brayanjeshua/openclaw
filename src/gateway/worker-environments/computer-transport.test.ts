import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  NodeWorkerComputerCloseParamsSchema,
  parseNodeWorkerComputerInput,
} from "../../worker/node-computer-protocol.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  createApprovalClientLookup,
  createContext,
  createNodeSession,
  createOperatorClient,
  expectSinglePendingApproval,
} from "../node-invoke-plugin-policy.test-helpers.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { NodeRegistry, NodeSession } from "../node-registry.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import {
  createWorkerComputerService,
  createWorkerComputerTransportOwner,
} from "./computer-transport.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  isCurrentPlacementTurnClaim,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { createWorkerComputerRpc } from "./worker-turn-computer-rpc.js";

const COMPUTER_USE: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture-computer", label: "Fixture computer", generation: "provider-1" },
  actions: ["screenshot", "type"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const NEXT_EXECUTION_ID = "00000000-0000-4000-8000-000000000002";

function createHarness(sharedHost = false, withPolicy = true) {
  const claim: WorkerSessionTurnClaim = {
    sessionId: "session-1",
    claimId: "claim-1",
    runId: "run-1",
    placementGeneration: 3,
    owner: { kind: "worker", environmentId: "environment-1", ownerEpoch: 7 },
  };
  const placement: WorkerSessionPlacementRecord = {
    state: "active",
    executionMode: "worker-turn",
    sessionId: claim.sessionId,
    sessionKey: "agent:main:session-1",
    agentId: "main",
    generation: claim.placementGeneration,
    turnClaim: {
      owner: "worker",
      claimId: claim.claimId,
      runId: claim.runId,
      generation: claim.placementGeneration,
      ownerEpoch: 7,
    },
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "environment-1",
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "sha256:fixture",
    remoteWorkspaceDir: "/worker/workspace",
    workerBundleHash: "a".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
  const environment: WorkerEnvironmentRecord = {
    environmentId: "environment-1",
    providerId: sharedHost ? "device" : "fixture-cloud",
    profileId: "desktop",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: "desktop-node",
    sharedHost,
    desktop: sharedHost ? null : { protocol: "rfb", port: 5900, passwordFilePath: "/vnc.password" },
    bootstrapReceipt: null,
    ownerEpoch: 7,
    teardownTerminalState: null,
    attachedSessionIds: [claim.sessionId],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "lease-1",
    sshEndpoint: null,
  };
  const node: NodeSession = {
    ...createNodeSession(),
    nodeId: "desktop-node",
    connId: "desktop-connection",
    pairingGeneration: "pairing-1",
    platform: "linux",
    deviceFamily: "Linux",
    commands: sharedHost ? ["screen.snapshot", "computer.act"] : [],
    computerUse: sharedHost ? COMPUTER_USE : undefined,
  };
  const proof: NodeWorkerSupervisorNodeProof = {
    nodeId: node.nodeId,
    connId: node.connId,
    pairingIdentity: "pairing-identity",
    pairingGeneration: "pairing-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
  const state: {
    placement: WorkerSessionPlacementRecord;
    environment: Extract<WorkerEnvironmentRecord, { leaseId: string }>;
    node: NodeSession;
    privateCurrent: boolean;
    context?: GatewayRequestContext;
    nodeTransport?: NodeWorkerSupervisorTransport;
    config: OpenClawConfig;
    beforePolicy?: () => Promise<void>;
    beforeDispatch?: () => Promise<void>;
    afterDispatch?: () => Promise<void>;
  } = {
    placement,
    environment,
    node,
    privateCurrent: true,
    config: {},
  };
  const { context } = createContext({
    nodeSession: node,
    getRuntimeConfig: () => state.config,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator({
      validateTurnClaim: (candidate) => isCurrentPlacementTurnClaim(state.placement, candidate),
    }),
  });
  const nativeExecutionIds: string[] = [];
  const publicInvoke = vi.fn<NodeRegistry["invoke"]>(async (invocation) => {
    await state.beforeDispatch?.();
    if (invocation.isDispatchAuthorized?.() === false) {
      return { ok: false, error: { message: "dispatch authority closed" } };
    }
    const input = parseNodeWorkerComputerInput(
      JSON.stringify(
        Value.Check(NodeWorkerComputerCloseParamsSchema, invocation.params)
          ? {
              operation: "close",
              executionId: invocation.params.executionId,
              reason: invocation.params.reason,
            }
          : {
              operation: invocation.command === "screen.snapshot" ? "snapshot" : "act",
              providerGeneration: COMPUTER_USE.provider.generation,
              params: invocation.params,
            },
      ),
    );
    if (input.operation !== "capabilities") {
      nativeExecutionIds.push(
        input.operation === "close" ? input.executionId : input.params.executionId,
      );
    }
    invocation.onDispatchReady?.("public-invoke");
    return { ok: true, payload: { ok: true } };
  });
  context.nodeRegistry.invoke = publicInvoke;
  vi.spyOn(context.nodeRegistry, "get").mockImplementation((id) =>
    id === state.node.nodeId ? state.node : undefined,
  );
  vi.spyOn(context.nodeRegistry, "getForPairingGeneration").mockImplementation((id, generation) =>
    id === state.node.nodeId && generation === state.node.pairingGeneration
      ? state.node
      : undefined,
  );
  state.context = context;
  const privateInvoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (invocation) => {
    await state.beforeDispatch?.();
    if (!invocation.isDispatchAuthorized()) {
      return { ok: false, error: { message: "dispatch authority closed" } };
    }
    invocation.onDispatchReady?.("private-invoke");
    const input = parseNodeWorkerComputerInput(JSON.stringify(invocation.params));
    if (input.operation === "capabilities") {
      return { ok: true, payload: COMPUTER_USE };
    }
    nativeExecutionIds.push(
      input.operation === "close" ? input.executionId : input.params.executionId,
    );
    await state.afterDispatch?.();
    return { ok: true, payload: { ok: true, node: invocation.node.nodeId } };
  });
  const nodeTransport = {
    listCurrentNodes: vi.fn(async () => [proof]),
    hasCurrentRunner: (id) => id === proof.nodeId && state.privateCurrent,
    isCurrent: (candidate) => candidate === proof && state.privateCurrent,
    invoke: privateInvoke,
  } satisfies NodeWorkerSupervisorTransport;
  state.nodeTransport = nodeTransport;
  const policyHandle = vi.fn(async (policy: OpenClawPluginNodeInvokePolicyContext) => {
    await state.beforePolicy?.();
    return await policy.invokeNode();
  });
  const classifyRisk = vi.fn(() => ({ level: "ordinary" as const, family: "fixture_input" }));
  const registry = createEmptyPluginRegistry();
  if (withPolicy) {
    registry.plugins.push(
      createPluginRecord({
        id: "fixture-computer",
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      }),
    );
    registry.nodeHostCommands.push({
      pluginId: "fixture-computer",
      source: "test",
      command: { command: "computer.act", dangerous: true, handle: async () => "{}" },
    });
    registry.nodeInvokePolicies.push({
      pluginId: "fixture-computer",
      source: "test",
      pluginConfig: {},
      policy: { commands: ["computer.act"], dangerous: true, classifyRisk, handle: policyHandle },
    });
  }
  setActivePluginRegistry(registry);
  const closedHandlers = new Set<(closed: WorkerSessionTurnClaim) => void>();
  const options = {
    store: { get: () => state.environment },
    placements: {
      get: () => state.placement,
      validateTurnClaim: (candidate: WorkerSessionTurnClaim) =>
        isCurrentPlacementTurnClaim(state.placement, candidate),
      registerTurnClaimClosedHandler(handler: (closed: WorkerSessionTurnClaim) => void) {
        closedHandlers.add(handler);
        return () => {
          closedHandlers.delete(handler);
        };
      },
    },
    resolveGatewayContext: () => state.context,
    getNodeTransport: () => state.nodeTransport,
    warn: vi.fn(),
  };
  const run = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(run);
  return {
    claim,
    options,
    state,
    run,
    authority,
    privateInvoke,
    publicInvoke,
    nodeTransport,
    policyHandle,
    classifyRisk,
    registry,
    nativeExecutionIds,
    releaseClaim() {
      state.placement = { ...state.placement, turnClaim: null };
      for (const handler of closedHandlers) {
        handler(claim);
      }
    },
    async prepare() {
      const prepared = await createWorkerComputerTransportOwner(options)(claim);
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      return { prepared, transport: prepared.bind(run) };
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function request(
  action: "snapshot" | "type" | "close",
  executionId = EXECUTION_ID,
): Parameters<ComputerToolTransport["invoke"]>[0] {
  return {
    nodeId: "desktop-node",
    command: action === "snapshot" ? "screen.snapshot" : "computer.act",
    commandParams:
      action === "snapshot"
        ? { executionId, format: "png" }
        : action === "close"
          ? { executionId, action: "__close_execution", reason: "completion" }
          : { executionId, action: "type", text: "session desktop only" },
  };
}

const revocations: Array<{ name: string; revoke(harness: Harness): void }> = [
  { name: "turn claim", revoke: (h) => h.releaseClaim() },
  {
    name: "lease",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, leaseId: "replacement" };
    },
  },
  {
    name: "owner epoch",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, ownerEpoch: 8 };
    },
  },
  {
    name: "node connection",
    revoke: (h) => {
      h.state.node = { ...h.state.node, connId: "replacement" };
    },
  },
  {
    name: "node pairing",
    revoke: (h) => {
      h.state.node = { ...h.state.node, pairingGeneration: "replacement" };
    },
  },
  {
    name: "private runner proof",
    revoke: (h) => {
      h.state.privateCurrent = false;
    },
  },
  {
    name: "operational run",
    revoke: (h) => {
      claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef(h.claim.runId));
    },
  },
  {
    name: "Gateway lifecycle",
    revoke: () => {
      rotateAgentRunRegistryLifecycleGeneration();
    },
  },
  {
    name: "Gateway context",
    revoke: (h) => {
      h.state.context = undefined;
    },
  },
  {
    name: "plugin registry",
    revoke: () => setActivePluginRegistry(createEmptyPluginRegistry()),
  },
  {
    name: "plugin policy",
    revoke: (h) => {
      h.registry.nodeInvokePolicies.splice(0);
    },
  },
  {
    name: "plugin lifecycle",
    revoke: (h) => {
      h.registry.plugins[0]!.enabled = false;
    },
  },
];

describe("session computer transport", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });

  it("routes snapshots and classified input to the exact private node without public fallback", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    expect(transport.computerUse).toEqual(COMPUTER_USE);
    await expect(transport.resolveNode()).resolves.toMatchObject({ nodeId: "desktop-node" });
    await transport.invoke(request("snapshot"));
    await transport.invoke(request("type"));
    const physicalId = h.nativeExecutionIds[0];
    expect(physicalId).not.toBe(EXECUTION_ID);
    expect(h.privateInvoke.mock.calls.map(([call]) => call.params)).toEqual([
      { operation: "capabilities" },
      {
        operation: "snapshot",
        providerGeneration: COMPUTER_USE.provider.generation,
        params: { ...request("snapshot").commandParams, executionId: physicalId },
      },
      {
        operation: "act",
        providerGeneration: COMPUTER_USE.provider.generation,
        params: { ...request("type").commandParams, executionId: physicalId },
      },
    ]);
    expect(
      h.privateInvoke.mock.calls.every(
        ([call]) =>
          call.node.nodeId === "desktop-node" &&
          call.command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
      ),
    ).toBe(true);
    expect(h.classifyRisk).toHaveBeenCalledWith({
      command: "computer.act",
      params: { ...request("type").commandParams, executionId: physicalId },
    });
    expect(h.policyHandle.mock.calls[0]?.[0].risk).toEqual({
      level: "ordinary",
      family: "fixture_input",
    });
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each([true, false])(
    "uses a shared paired node's approved public capability (plugin policy: %s)",
    async (withPolicy) => {
      const h = createHarness(true, withPolicy);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      await transport.invoke(request("type"));
      expect(h.nodeTransport.listCurrentNodes).not.toHaveBeenCalled();
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          nodeId: "desktop-node",
          expectedConnId: "desktop-connection",
          expectedPairingGeneration: "pairing-1",
          command: "computer.act",
          params: { ...request("type").commandParams, executionId: h.nativeExecutionIds[0] },
        }),
      );
      await prepared.close("completion");
    },
  );

  it("rejects foreign targets and execution IDs without dispatching or selecting another node", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await expect(transport.resolveNode("other-desktop")).rejects.toThrow(/bound/);
    await expect(transport.invoke({ ...request("type"), nodeId: "other-desktop" })).rejects.toThrow(
      /bound/,
    );
    await transport.invoke(request("snapshot"));
    h.privateInvoke.mockClear();
    await expect(transport.invoke(request("type", NEXT_EXECUTION_ID))).rejects.toThrow(
      /execution owner changed/,
    );
    await expect(transport.invoke(request("close", NEXT_EXECUTION_ID))).rejects.toThrow(
      /execution owner changed/,
    );
    expect(h.privateInvoke).not.toHaveBeenCalled();
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each([false, true])(
    "keeps independent bound attempts separate even when execution IDs are copied (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      const projection = prepared.bind(h.run);
      await transport.invoke(request("snapshot"));
      const firstPhysicalId = h.nativeExecutionIds[0]!;
      expect(firstPhysicalId).not.toBe(EXECUTION_ID);
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      await expect(projection.invoke(request("close", firstPhysicalId))).resolves.toEqual({
        ok: true,
      });
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await expect(projection.invoke(request("type", firstPhysicalId))).rejects.toThrow(/closed/);
      await transport.invoke(request("type"));
      expect(h.nativeExecutionIds.at(-1)).toBe(firstPhysicalId);
      await transport.invoke(request("close"));
      await expect(transport.invoke(request("snapshot"))).rejects.toThrow(/closed/);

      const next = prepared.bind(h.run);
      await next.invoke(request("snapshot", firstPhysicalId));
      expect(h.nativeExecutionIds.at(-1)).not.toBe(firstPhysicalId);
      expect(h.nativeExecutionIds.at(-1)).not.toBe(EXECUTION_ID);
      await prepared.close("completion");
    },
  );

  it("rejects a close envelope submitted as a snapshot before any node dispatch", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    h.privateInvoke.mockClear();
    await expect(
      transport.invoke({ ...request("close"), command: "screen.snapshot" }),
    ).rejects.toThrow(/invalid worker computer request/);
    expect(h.policyHandle).not.toHaveBeenCalled();
    expect(h.privateInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each(["commands", "provider"] as const)(
    "honors a paired host's live %s revocation during policy work",
    async (surface) => {
      const h = createHarness(true);
      const { transport, prepared } = await h.prepare();
      h.state.beforePolicy = async () => {
        await Promise.resolve();
        if (surface === "commands") {
          h.state.node.commands = [];
        } else {
          h.state.node.computerUse = {
            ...COMPUTER_USE,
            provider: { ...COMPUTER_USE.provider, generation: "provider-2" },
          };
        }
      };
      await expect(transport.invoke(request("type"))).rejects.toThrow();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      h.state.node.commands = ["screen.snapshot", "computer.act"];
      h.state.beforePolicy = undefined;
      await prepared.close("completion");
    },
  );

  it("keeps session and live run authority on clientless policy approvals", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) &&
        (authority.kind === "local" || h.options.placements.validateTurnClaim(authority.turnClaim)),
    });
    const context = h.state.context!;
    context.pluginApprovalManager = manager;
    context.getApprovalClientConnIds = createApprovalClientLookup([createOperatorClient()]);
    h.policyHandle.mockImplementationOnce(async (policy) => {
      const approval = await policy.approvals?.request({
        title: "Session desktop action",
        description: "Approve the bound desktop action",
      });
      if (approval?.decision !== "allow-once") {
        return { ok: false, message: "approval required" };
      }
      return await policy.invokeNode();
    });
    const operation = transport.invoke(request("type"));
    const record = await expectSinglePendingApproval(manager);
    expect(record.request).toMatchObject({
      agentId: "main",
      sessionKey: h.state.placement.sessionKey,
      runId: h.claim.runId,
    });
    expect(record.agentRuntimeDelegatedAuthority).toMatchObject({
      kind: "worker",
      turnClaim: h.claim,
      operationalRunInstance: h.run,
    });
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(operation).resolves.toMatchObject({ ok: true });
    expect(manager.getSnapshot(record.id)?.consumedDecision).toBe("allow-once");
    releaseAgentRunDelegatedAuthority(h.authority);
    h.releaseClaim();
    h.policyHandle.mockClear();
    await prepared.close("completion");
    expect(h.policyHandle).not.toHaveBeenCalled();
    expect(manager.listPendingRecords()).toEqual([]);
  });

  it.each([
    { sharedHost: false, boundary: "policy" },
    { sharedHost: true, boundary: "policy" },
    { sharedHost: false, boundary: "pairing" },
    { sharedHost: true, boundary: "pairing" },
  ] as const)(
    "withholds native input when only the RPC grant closes during $boundary (shared host: $sharedHost)",
    async ({ sharedHost, boundary }) => {
      const h = createHarness(sharedHost);
      const service = createWorkerComputerService(h.options);
      const prepared = await service.prepare(h.claim);
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      prepared.bind(h.run);
      const identity: WorkerConnectionIdentity = {
        environmentId: h.state.environment.environmentId,
        credentialHash: "credential-hash",
        bundleHash: "bundle-hash",
        sessionId: h.claim.sessionId,
        runId: h.claim.runId,
        turnClaim: h.claim,
        ownerEpoch: h.state.environment.ownerEpoch,
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
      };
      let granted = true;
      const rpc = createWorkerComputerRpc({
        execute: service.execute,
        validate: () => (granted ? { ok: true } : { ok: false, closeReason: "method-not-allowed" }),
      });
      const invoke = (action: "snapshot" | "type") => {
        const input = request(action);
        return rpc(identity, {
          command: input.command,
          paramsJson: JSON.stringify(input.commandParams),
        });
      };
      await expect(invoke("snapshot")).resolves.toMatchObject({ ok: true });
      const physicalId = h.nativeExecutionIds[0];
      const entered = createDeferred();
      const resume = createDeferred();
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      if (boundary === "policy") {
        h.state.beforePolicy = pause;
      } else {
        h.state.beforeDispatch = pause;
      }
      const operation = invoke("type");
      await entered.promise;
      granted = false;
      expect(h.options.placements.validateTurnClaim(h.claim)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(h.authority)).toBe(true);
      resume.resolve();
      await expect(operation).resolves.toEqual({
        ok: false,
        closeReason: "method-not-allowed",
      });
      expect(h.nativeExecutionIds).toEqual([physicalId]);
      h.state.beforePolicy = undefined;
      h.state.beforeDispatch = undefined;
      await service.close();
      expect(h.nativeExecutionIds).toEqual([physicalId, physicalId]);
      const calls = sharedHost ? h.publicInvoke.mock.calls : h.privateInvoke.mock.calls;
      expect(calls.at(-1)?.[0].params).toMatchObject(
        sharedHost
          ? { action: "__close_execution", executionId: physicalId }
          : { operation: "close", executionId: physicalId },
      );
    },
  );

  it.each(revocations)(
    "rejects input after $name revocation while policy is pending",
    async (revocation) => {
      const h = createHarness();
      const { transport, prepared } = await h.prepare();
      const entered = createDeferredCore();
      const policy = createDeferredCore();
      h.state.beforePolicy = async () => {
        entered.resolve();
        await policy.promise;
      };
      h.privateInvoke.mockClear();
      const invoked = transport.invoke(request("type"));
      const rejected = expect(invoked).rejects.toThrow();
      await entered.promise;
      revocation.revoke(h);
      policy.resolve();
      await rejected;
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await prepared.close("cancellation");
    },
  );

  it.each(revocations)("withholds an awaited result after $name revocation", async (revocation) => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    const entered = createDeferredCore();
    const result = createDeferredCore();
    h.state.afterDispatch = async () => {
      entered.resolve();
      await result.promise;
    };
    h.privateInvoke.mockClear();
    const invoked = transport.invoke(request("type"));
    const rejected = expect(invoked).rejects.toThrow();
    await entered.promise;
    revocation.revoke(h);
    result.resolve();
    await rejected;
    expect(h.privateInvoke).toHaveBeenCalledOnce();
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("cancellation");
  });

  it("closes only the captured execution after run and claim release, and never resumes input", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    releaseAgentRunDelegatedAuthority(h.authority);
    h.releaseClaim();
    h.privateInvoke.mockClear();
    await prepared.close("cancellation");
    await prepared.close("cancellation");
    await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    expect(h.privateInvoke).toHaveBeenCalledOnce();
    expect(h.privateInvoke.mock.calls[0]?.[0].params).toEqual({
      operation: "close",
      executionId: h.nativeExecutionIds[0],
      reason: "cancellation",
    });
  });

  it.each([
    { sharedHost: false, revoke: "policy" },
    { sharedHost: true, revoke: "policy" },
    { sharedHost: false, revoke: "commands" },
    { sharedHost: true, revoke: "commands" },
  ] as const)(
    "releases its native execution after $revoke revocation (shared host: $sharedHost)",
    async ({ sharedHost, revoke }) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      const physicalId = h.nativeExecutionIds[0];
      if (revoke === "policy") {
        setActivePluginRegistry(createEmptyPluginRegistry());
      } else {
        h.state.config = { gateway: { nodes: { commands: { deny: ["computer.act"] } } } };
      }
      await expect(transport.invoke(request("type"))).rejects.toThrow();
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockClear();

      await expect(prepared.close("revoked")).resolves.toBeUndefined();
      const nativeInvoke = sharedHost ? h.publicInvoke : h.privateInvoke;
      expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(
          sharedHost
            ? {
                command: "computer.act",
                params: { action: "__close_execution", executionId: physicalId, reason: "revoked" },
              }
            : {
                command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
                params: { operation: "close", executionId: physicalId, reason: "revoked" },
              },
        ),
      );
      expect(h.policyHandle).not.toHaveBeenCalled();
      await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    },
  );

  it.each([false, true])(
    "prevents plugin policy overrides from replacing the execution owner (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockImplementationOnce((policy) =>
        policy.invokeNode({ params: request("type", NEXT_EXECUTION_ID).commandParams }),
      );
      await expect(transport.invoke(request("type"))).rejects.toThrow(/replace.*execution owner/);
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await prepared.close("completion");
    },
  );

  it.each([false, true])(
    "releases owned resources without re-entering an input policy (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      releaseAgentRunDelegatedAuthority(h.authority);
      h.releaseClaim();
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockClear();
      h.policyHandle.mockImplementationOnce((policy) =>
        policy.invokeNode({ params: request("type").commandParams }),
      );
      await prepared.close("completion");
      expect(h.policyHandle).not.toHaveBeenCalled();
      if (sharedHost) {
        expect(h.publicInvoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            command: "computer.act",
            params: { ...request("close").commandParams, executionId: h.nativeExecutionIds[0] },
          }),
        );
        expect(h.privateInvoke).not.toHaveBeenCalled();
      } else {
        expect(h.privateInvoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            params: {
              operation: "close",
              executionId: h.nativeExecutionIds[0],
              reason: "completion",
            },
          }),
        );
        expect(h.publicInvoke).not.toHaveBeenCalled();
      }
    },
  );

  it.each(
    revocations.filter(({ name }) =>
      [
        "lease",
        "owner epoch",
        "node connection",
        "node pairing",
        "private runner proof",
        "Gateway context",
      ].includes(name),
    ),
  )("never sends cleanup to a replacement $name owner", async (revocation) => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    h.privateInvoke.mockClear();
    revocation.revoke(h);
    await prepared.close("completion");
    expect(h.privateInvoke).not.toHaveBeenCalled();
    expect(h.publicInvoke).not.toHaveBeenCalled();
  });

  it("allows a fresh attempt execution after the earlier execution closes normally", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    await transport.invoke(request("close"));
    await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    await prepared.bind(h.run).invoke(request("type", NEXT_EXECUTION_ID));
    const nextPhysicalId = h.nativeExecutionIds.at(-1);
    expect(nextPhysicalId).not.toBe(h.nativeExecutionIds[0]);
    expect(nextPhysicalId).not.toBe(NEXT_EXECUTION_ID);
    await prepared.close("completion");
    expect(h.privateInvoke.mock.calls.at(-1)?.[0].params).toEqual({
      operation: "close",
      executionId: nextPhysicalId,
      reason: "completion",
    });
  });

  it.each(["claim", "shutdown"] as const)(
    "service closes its captured owners on %s and rejects retained handles",
    async (boundary) => {
      const h = createHarness();
      const service = createWorkerComputerService(h.options);
      const first = service.prepare(h.claim);
      expect(service.prepare(h.claim)).toBe(first);
      const prepared = await first;
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      const transport = prepared.bind(h.run);
      await transport.invoke(request("snapshot"));
      h.privateInvoke.mockClear();
      if (boundary === "claim") {
        h.releaseClaim();
        await vi.waitFor(() => expect(h.privateInvoke).toHaveBeenCalledOnce());
      } else {
        await service.close();
      }
      await expect(transport.invoke(request("type"))).rejects.toThrow(/closed|replaced/);
      await expect(service.prepare(h.claim)).rejects.toThrow(/closed/);
      expect(h.privateInvoke.mock.calls[0]?.[0].params).toMatchObject({
        operation: "close",
        executionId: h.nativeExecutionIds[0],
      });
      await service.close();
      expect(h.privateInvoke).toHaveBeenCalledOnce();
    },
  );
});

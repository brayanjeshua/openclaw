import { Value } from "typebox/value";
import {
  WorkerComputerParamsSchema,
  type WorkerComputerParams,
  type WorkerComputerResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  createComputerTool,
  type ComputerToolTransport,
  type ComputerContextEpoch,
} from "../agents/tools/computer-tool.js";
import type { WorkerComputerLaunchDescriptor } from "./launch-descriptor.js";

export function createWorkerComputerTool(params: {
  descriptor: WorkerComputerLaunchDescriptor;
  requestComputer(request: WorkerComputerParams): Promise<WorkerComputerResponseFrame>;
  runId: string;
  contextEpoch?: ComputerContextEpoch;
  registerRunCleanup: NonNullable<Parameters<typeof createComputerTool>[0]>["registerRunCleanup"];
}) {
  const transport: ComputerToolTransport = {
    computerUse: params.descriptor.computerUse,
    resolveNode: async (query, signal) => {
      signal?.throwIfAborted();
      if (query !== undefined && query !== params.descriptor.nodeId) {
        throw new Error("Computer input is bound to this session's desktop.");
      }
      return params.descriptor;
    },
    invoke: async ({ nodeId, command, commandParams, timeoutMs, idempotencyKey, signal }) => {
      signal?.throwIfAborted();
      if (nodeId !== params.descriptor.nodeId) {
        throw new Error("Computer input is bound to this session's desktop.");
      }
      const request = {
        command,
        paramsJson: JSON.stringify(commandParams),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      if (!Value.Check(WorkerComputerParamsSchema, request)) {
        throw new Error("Computer request exceeds the worker protocol limits.");
      }
      const response = await params.requestComputer(request);
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return JSON.parse(response.payload.resultJson) as unknown;
    },
  };
  return createComputerTool({
    transport,
    contextEpoch: params.contextEpoch,
    idempotencyScope: params.runId,
    registerRunCleanup: params.registerRunCleanup,
  });
}

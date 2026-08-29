import type { WorkerTranscriptCommitRequestFrame } from "./schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "./schema/worker-protocol-primitives.js";

export const WORKER_MEDIA_TRANSCRIPT_PROTOCOL_FEATURE = "worker-media-transcript-v1";

/** Image bytes get the media budget; all non-image data retains the control budget. */
export function isWorkerTranscriptFrameWithinLimits(
  frame: WorkerTranscriptCommitRequestFrame,
): boolean {
  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
    if (bytes <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
      return true;
    }
    if (bytes > WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) {
      return false;
    }
    const controlFrame = {
      ...frame,
      params: {
        ...frame.params,
        messages: frame.params.messages.map((message) =>
          message.role === "assistant"
            ? message
            : {
                ...message,
                content: message.content.map((part) =>
                  part.type === "image" ? { ...part, data: "" } : part,
                ),
              },
        ),
      },
    };
    return (
      encoder.encode(JSON.stringify(controlFrame)).byteLength <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}

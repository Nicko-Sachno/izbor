import type { Hook } from "../../../core/ports.js";
import { lowerSessionId } from "../../../domain/wire.js";
import { toEventRecord } from "./eventRecord.js";
import { toEvidence } from "./evidence.js";
import { readHookPayload } from "./payload.js";

export function readHook(body: string, receivedAt: Date): Hook | undefined {
    const payload = readHookPayload(body);
    if (!payload) {
        return undefined;
    }

    const sessionId = lowerSessionId(payload.session_id);
    const name = payload.hook_event_name;

    return {
        sessionId,
        sessionOver: name === "SessionEnd",
        cwd: payload.cwd,
        ended: name === "Stop" || name === "StopFailure" || name === "SessionEnd",
        event: toEventRecord(payload, sessionId, receivedAt),
        evidence: toEvidence(payload, receivedAt),
        record: { kind: "hook", sessionId, timestamp: receivedAt.toISOString(), payload },
    };
}

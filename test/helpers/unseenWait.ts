import type { BriefEvent } from "../../src/domain/streamEvent.js";
import { toTerminalBrief } from "../../src/terminal/live/brief.js";
import type { Observation } from "../../src/terminal/model.js";

export function fromBeforeIzborStarted(row: Observation, at = "2026-10-09T11:59:45.000Z"): Observation {
    const event: BriefEvent = {
        type: "brief",
        sessionId: row.id,
        task: null,
        status: { state: "waiting", waitingFor: "permission prompt" },
        latestActivity: null,
        needsYou: { state: "unknown", at, waitingFor: "permission prompt" },
        answerable: "not running when it asked",
        lastObserved: { at, from: "status", lastHookAt: null },
        explanation: { state: "unknown" },
    };
    const { needsYou, answerable } = toTerminalBrief(event);
    return { ...row, brief: row.brief && { ...row.brief, needsYou, ...(answerable !== undefined && { answerable }) } };
}

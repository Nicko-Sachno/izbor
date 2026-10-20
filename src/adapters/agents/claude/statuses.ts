import type { ListedSession } from "../../../core/ports.js";
import { readJson } from "../../../domain/text.js";

export function readStatuses(output: string): ListedSession[] | { unreadable: string } {
    const agents = readJson(output);
    if (!Array.isArray(agents)) {
        return { unreadable: `claude agents --json printed no list: ${output.slice(0, 200)}` };
    }

    return agents.flatMap((agent: Agent | null) => toListedSession(agent) ?? []);
}

function toListedSession(agent: Agent | null): ListedSession | undefined {
    if (typeof agent?.sessionId !== "string") {
        return undefined;
    }

    const { sessionId, status, waitingFor } = agent;
    switch (status) {
        case "busy":
        case "idle":
            return { sessionId, status };
        case "waiting":
            return { sessionId, status, ...(typeof waitingFor === "string" && { waitingFor }) };
        case undefined:
            return unknownStatus(sessionId, "claude agents --json lists the session without a status");
        default:
            return unknownStatus(
                sessionId,
                `claude agents --json reports a status Izbor does not know: ${JSON.stringify(status)}`,
            );
    }
}

function unknownStatus(sessionId: string, reason: string): ListedSession {
    return { sessionId, status: "unknown", error: `Error: ${reason}` };
}

type Agent = { sessionId?: unknown; status?: unknown; waitingFor?: unknown };

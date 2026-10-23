import type { ListedSession } from "../../../core/ports.js";
import { readJson } from "../../../domain/text.js";

export function readStatuses(output: string): ListedSession[] | { unreadable: string } {
    const agents = readJson(output);
    if (!Array.isArray(agents)) {
        return { unreadable: `claude agents --json printed no list: ${output.slice(0, 200)}` };
    }

    return agents.flatMap((agent: Agent | null) => toListedSession(agent) ?? []);
}

/** A listed session, with its folder when `claude agents --json` names one. */
function toListedSession(agent: Agent | null): ListedSession | undefined {
    if (typeof agent?.sessionId !== "string") {
        return undefined;
    }

    const listed = statusOf({ ...agent, sessionId: agent.sessionId });
    return typeof agent.cwd === "string" ? { ...listed, cwd: agent.cwd } : listed;
}

function statusOf({ sessionId, status, waitingFor }: Agent & { sessionId: string }): ListedSession {
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

type Agent = { sessionId?: unknown; cwd?: unknown; status?: unknown; waitingFor?: unknown };

import type { Answerable } from "./answer.js";
import type { Brief, Explained, Outdated } from "./brief.js";
import type { PromptState } from "./prompt.js";
import type { Status, StopWhy } from "./records.js";

export type ListedState = "watching" | "not listed";

type WireStatus =
    | { state: "busy" | "idle" | "not listed" }
    | { state: "waiting"; waitingFor?: string }
    | { state: "unknown"; error: string };

export type BriefEvent = {
    type: "brief";
    sessionId: string;
    task: Brief["task"];
    status: WireStatus | null;
    latestActivity: Brief["latestActivity"];
    needsYou: Brief["needsYou"];
    answerable: Answerable;
    lastObserved: Brief["lastObserved"];
    explanation:
        { state: "unknown"; reason?: string } | { state: "explained"; text: string; at: string; outdated?: Outdated };
};

export type StreamEvent = SessionEvent | BriefEvent | ActionEvent | PromptEvent;

type ActionEvent = { type: "action"; sessionId: string; at: string; what: string };

export type PromptEvent = {
    type: "prompt";
    sessionId: string;
    promptId: string;
    text: string;
    state: PromptState;
    reason?: string;
};

export type SessionEvent =
    | { type: "session"; sessionId: string; state: ListedState }
    | { type: "session"; sessionId: string; state: "stopped"; why: StopWhy };

function toWireStatus(status: Status): WireStatus {
    switch (status.status) {
        case "not_listed":
            return { state: "not listed" };
        case "waiting":
            return { state: "waiting", ...(status.waitingFor !== undefined && { waitingFor: status.waitingFor }) };
        case "unknown":
            return { state: "unknown", error: status.error };
        default:
            return { state: status.status };
    }
}

function withoutCovers(explanation: Explained): BriefEvent["explanation"] {
    if (explanation.state === "unknown") return explanation;
    const { covers, ...rest } = explanation;
    return rest;
}

export function toBriefEvent(sessionId: string, brief: Brief, answerable: Answerable): BriefEvent {
    const { task, status, latestActivity, needsYou, lastObserved, explanation } = brief;
    return {
        type: "brief",
        sessionId,
        task,
        status: status && toWireStatus(status),
        latestActivity,
        needsYou,
        answerable,
        lastObserved,
        explanation: withoutCovers(explanation),
    };
}

export function sessionStateAfter(state: ListedState, status: Status | null): ListedState {
    if (status === null || status.status === "unknown") return state;
    return status.status === "not_listed" ? "not listed" : "watching";
}

import { isDeepStrictEqual } from "node:util";
import type { Status } from "./records.js";
import type { CallResult, FullResponse } from "./response.js";

export type Brief = {
    task: Task | null;
    status: Status | null;
    latestActivity: Action | null;
    needsYou: NeedsYou;
    lastObserved: { at: string; from: "hook" | "status"; lastHookAt: string | null } | null;
    explanation: Explained;
    /** The agent's reply to the Task; null while the Task is unknown. */
    response: FullResponse | null;
};

type Task = { text: string; at: string; from: "hook" | "transcript" };

export type Action = { what: string; at: string; replyFinished?: true };

export const PROMPT_SUBMITTED = "prompt submitted";

export const bySubagent = (agentId: string | null, what: string) =>
    agentId ? `subagent ${agentId.slice(0, 4)} ${what}` : what;

export type Explanation = {
    text: string;
    at: string;
    covers: Coverage;
};

export type Coverage = {
    taskAt: string | null;
    requestAt: string | null;
    from: string | null;
    to: string | null;
};

export type Outdated = "request over" | "request replaced" | "reply finished";

export type Explained =
    { state: "unknown"; reason?: string } | ({ state: "explained"; outdated?: Outdated } & Explanation);

export type Request = {
    agentId: string | null;
    tool: string;
    input: unknown;
};

export type NeedsYou =
    | { state: "unknown"; at?: string; waitingFor?: string }
    | { state: "nothing"; at: string }
    | ({ state: "request"; at: string } & Request);

type WaitingNeedsYou =
    Extract<NeedsYou, { state: "request" }> | (Extract<NeedsYou, { state: "unknown" }> & { waitingFor: string });

export const waitsForUser = (needsYou: NeedsYou): needsYou is WaitingNeedsYou =>
    needsYou.state === "request" || (needsYou.state === "unknown" && needsYou.waitingFor !== undefined);

export const UNKNOWN_BRIEF: Brief = {
    task: null,
    status: null,
    latestActivity: null,
    needsYou: { state: "unknown" },
    lastObserved: null,
    explanation: { state: "unknown" },
    response: null,
};

export type HookEvidence = {
    at: string;
    action: string | null;
    prompt?: string;
    replyFinished?: true;
    /** The agent's whole last message, from the hook that finished the reply. */
    lastMessage?: string;
    /** The hook says the reply failed, with the error the user sees. */
    replyFailed?: string;
    agentId: string | null;
    request?: Request;
    endedCall?: string;
    /** The hook says the ended call finished: it is `done` though its transcript row is not read yet, and whether or
     *  not the hook tells its result. A failure, which may be an interrupt, sets nothing. */
    callDone?: true;
    /** What the hook tells of the ended call, when it tells anything: its result, or that the user interrupted it. */
    result?: CallResult;
    ends?: "all" | "agent" | RequestedCall;
};

/** A call as a request names it: its tool and its input. */
export type RequestedCall = Pick<Request, "tool" | "input">;

/** Whether two calls are the same: the same tool, with the same input, whatever the order of its keys. A hook gives
 *  the input in Claude Code's order and the transcript in the model's, so the two differ for a question or a Bash call
 *  with a timeout. */
export const isSameCall = (one: RequestedCall, other: RequestedCall): boolean =>
    one.tool === other.tool && isDeepStrictEqual(one.input, other.input);

function isOver(request: Request, { agentId, ends }: HookEvidence): boolean {
    if (ends === undefined) return false;
    if (ends === "all") return true;
    if (request.agentId !== agentId) return false;
    return ends === "agent" || isSameCall(ends, request);
}

export const mainThreadRequest = ({ request, agentId }: HookEvidence): Request | undefined =>
    agentId === null ? request : undefined;

export function needsYouAfterHook(needsYou: NeedsYou, evidence: HookEvidence): NeedsYou {
    const { at, request } = evidence;
    if (request) return { state: "request", at, ...request };
    return needsYou.state === "request" && isOver(needsYou, evidence) ? { state: "nothing", at } : needsYou;
}

export function afterHook(brief: Brief, evidence: HookEvidence): Brief {
    const { at, action, prompt, replyFinished } = evidence;
    return withExplanationChecked({
        ...brief,
        task: prompt === undefined ? brief.task : { text: prompt, at, from: "hook" },
        latestActivity:
            action === null ? brief.latestActivity : { what: action, at, ...(replyFinished && { replyFinished }) },
        needsYou: needsYouAfterHook(brief.needsYou, evidence),
        lastObserved: { at, from: "hook", lastHookAt: at },
    });
}

export function statusInWords(status: Status): string {
    switch (status.status) {
        case "waiting":
            return status.waitingFor ? `waiting: ${status.waitingFor}` : "waiting";
        case "not_listed":
            return "not listed (the session exited or was replaced)";
        case "unknown":
            return `unknown (${status.error})`;
        default:
            return status.status;
    }
}

export type StatusEvidence = {
    status: Status;
    askedAt: string;
    at: string;
    /** The session's folder, as the agent's session list names it. */
    folder?: string | undefined;
};

export function afterStatus(brief: Brief, reading: StatusEvidence): Brief {
    const { status, at } = reading;
    return withExplanationChecked({
        ...brief,
        status,
        needsYou: needsYouAfterStatus(brief.needsYou, reading),
        lastObserved:
            status.status === "unknown"
                ? brief.lastObserved
                : { at, from: "status", lastHookAt: brief.lastObserved?.lastHookAt ?? null },
    });
}

function needsYouAfterStatus(needsYou: NeedsYou, { status, askedAt, at }: StatusEvidence): NeedsYou {
    if (status.status === "unknown") return needsYou;
    if (needsYou.at !== undefined && askedAt < needsYou.at) return needsYou;
    if (status.status === "waiting") {
        const { waitingFor } = status;
        if (needsYou.state === "request") return needsYou;
        if (needsYou.state === "unknown" && needsYou.at && needsYou.waitingFor === waitingFor) return needsYou;
        return { state: "unknown", at, ...(waitingFor !== undefined && { waitingFor }) };
    }
    return needsYou.state === "nothing" ? needsYou : { state: "nothing", at };
}

export type MessageAction = Action & { wrote: boolean; prompt?: string };

export function afterMessages(brief: Brief, actions: MessageAction[]): Brief {
    let { task, latestActivity } = brief;
    for (const { what, at, prompt } of actions) {
        if (prompt !== undefined && (!task || Date.parse(at) > Date.parse(task.at)))
            task = { text: prompt, at, from: "transcript" };
        if (!latestActivity || Date.parse(at) >= Date.parse(latestActivity.at)) latestActivity = { what, at };
    }
    return withExplanationChecked({ ...brief, task, latestActivity });
}

const isOfTask = ({ covers }: Explanation, { task }: Brief) => covers.taskAt === (task?.at ?? null);

function outdatedBy({ covers }: Explanation, { needsYou, latestActivity }: Brief): Outdated | null {
    if (latestActivity?.replyFinished && !(covers.to && Date.parse(covers.to) >= Date.parse(latestActivity.at)))
        return "reply finished";
    if (covers.requestAt === null) return null;
    if (needsYou.state !== "request") return "request over";
    return needsYou.at === covers.requestAt ? null : "request replaced";
}

function withExplanationChecked(brief: Brief): Brief {
    const { explanation } = brief;
    if (explanation.state !== "explained") return brief;
    if (!isOfTask(explanation, brief)) return { ...brief, explanation: { state: "unknown" } };
    if (explanation.outdated) return brief;
    const outdated = outdatedBy(explanation, brief);
    return outdated ? { ...brief, explanation: { ...explanation, outdated } } : brief;
}

export function afterExplanation(brief: Brief, explanation: Explanation): Brief {
    if (!isOfTask(explanation, brief)) return brief;
    return withExplanationChecked({ ...brief, explanation: { state: "explained", ...explanation } });
}

export function afterNoExplanation(brief: Brief, reason: string): Brief {
    return { ...brief, explanation: { state: "unknown", reason } };
}

import { bySubagent, type HookEvidence, PROMPT_SUBMITTED } from "../../../domain/brief.js";
import { finishedInWords, QUESTION_TOOL, questionsOf } from "../../../domain/question.js";
import type { CallResult } from "../../../domain/response.js";
import { describeTool, PLAN_TOOL, shorten, toolLabel } from "../../../domain/toolCalls.js";
import type { HookEventName, HookPayload } from "./payload.js";
import { readFailure, readToolResponse } from "./toolResult.js";

const TASK_NOTIFICATION = "<task-notification>";

const ACTION_DESCRIPTIONS: Partial<Record<HookEventName, (payload: HookPayload) => string | null>> = {
    UserPromptSubmit: promptSubmitted,
    PreToolUse: (payload) => `started ${labelOf(payload)}`,
    PostToolUse: toolFinished,
    PostToolUseFailure: (payload) => `failed ${labelOf(payload)}`,
    PermissionRequest: permissionRequested,
    PermissionDenied: (payload) => `permission denied for ${labelOf(payload)}`,
    SubagentStart: ({ agent_type }) => (agent_type ? `subagent started: ${agent_type}` : null),
    SubagentStop: ({ agent_type }) => (agent_type ? `subagent finished: ${agent_type}` : null),
    Stop: replyFinished,
    StopFailure: ({ error }) => withDetail("reply failed", typeof error === "string" ? error : undefined),
    SessionStart: ({ source }) => withDetail("session started", source),
    SessionEnd: ({ reason }) => withDetail("session ended", reason),
};

const REQUEST_ENDS: Partial<Record<HookEventName, "all" | "agent" | "call">> = {
    PostToolUse: "call",
    PostToolUseFailure: "call",
    PermissionDenied: "call",
    PostToolBatch: "agent",
    SubagentStop: "agent",
    Stop: "all",
    StopFailure: "all",
    SessionEnd: "all",
};

const CALL_END_EVENTS: HookEventName[] = ["PostToolUse", "PostToolUseFailure"];
const SUBAGENT_EVENTS: HookEventName[] = ["SubagentStart", "SubagentStop"];

export function toEvidence(payload: HookPayload, receivedAt: Date): HookEvidence {
    const name = payload.hook_event_name as HookEventName;
    const action = entryOf(ACTION_DESCRIPTIONS, name)?.(payload) ?? null;
    const agentId = payload.agent_id ?? null;
    const prompt = userPrompt(payload);
    const ends = prompt !== undefined ? "all" : entryOf(REQUEST_ENDS, name);

    const evidence: HookEvidence = {
        at: receivedAt.toISOString(),
        agentId,
        action: action && bySubagent(SUBAGENT_EVENTS.includes(name) ? null : agentId, action),
    };

    if (prompt !== undefined) {
        evidence.prompt = prompt;
    }
    if (name === "Stop") {
        evidence.replyFinished = true;
        if (payload.last_assistant_message?.trim()) evidence.lastMessage = payload.last_assistant_message;
    }
    if (name === "StopFailure") {
        evidence.replyFailed = failureOf(payload);
    }
    if (CALL_END_EVENTS.includes(name) && payload.tool_use_id) {
        evidence.endedCall = payload.tool_use_id;
        if (name === "PostToolUse") evidence.callDone = true;
        const result = endedCallResult(name, payload);
        if (result) evidence.result = result;
    }
    if (name === "PermissionRequest") {
        evidence.request = { agentId, tool: payload.tool_name ?? "", input: payload.tool_input };
    }
    if (ends) {
        evidence.ends = ends === "call" ? { tool: payload.tool_name ?? "", input: requestedInput(payload) } : ends;
    }

    return evidence;
}

/** PostToolUse tells the result in its `tool_response`, PostToolUseFailure in its `error`, or by `is_interrupt` that
 *  the call stopped by an abort, which reads `interrupted`. */
function endedCallResult(
    name: HookEventName,
    { tool_name = "", tool_input, tool_response, error, is_interrupt }: HookPayload,
): CallResult | undefined {
    if (is_interrupt === true) return { kind: "interrupted" };
    return name === "PostToolUse" ? readToolResponse(tool_name, tool_input, tool_response) : readFailure(error);
}

/** A failed reply's error as Claude Code shows it: its last message, else the error's details, else its category,
 *  which is `unknown` when the hook gives none. */
function failureOf({ last_assistant_message: shown, error_details: details, error }: HookPayload): string {
    const hasWords = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
    return [shown, details, error].find(hasWords) ?? "unknown";
}

function userPrompt(payload: HookPayload): string | undefined {
    if (payload.hook_event_name !== "UserPromptSubmit" || payload.prompt?.startsWith(TASK_NOTIFICATION)) {
        return undefined;
    }

    return payload.prompt;
}

function promptSubmitted({ prompt = "" }: HookPayload): string {
    if (!prompt.startsWith(TASK_NOTIFICATION)) {
        return PROMPT_SUBMITTED;
    }

    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(prompt)?.[1];
    return withDetail("task notification", summary);
}

function permissionRequested(payload: HookPayload): string {
    switch (payload.tool_name) {
        case PLAN_TOOL:
            return "asked to approve a plan";
        case QUESTION_TOOL: {
            const [firstQuestion] = questionsOf(payload.tool_input);
            return withDetail("asked the user", firstQuestion && shorten(firstQuestion));
        }
        default:
            return `asked permission for ${labelOf(payload)}`;
    }
}

function toolFinished(payload: HookPayload): string {
    if (payload.tool_name === QUESTION_TOOL) {
        const answered = finishedInWords(payload.tool_response);
        if (answered) {
            return answered;
        }
    }

    return `finished ${labelOf(payload)}`;
}

function replyFinished({ last_assistant_message: reply, background_tasks: tasks }: HookPayload): string {
    const finished = withDetail("reply finished", reply && shorten(reply));
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return finished;
    }

    const names = tasks
        .map((task) => (typeof task?.description === "string" ? shorten(task.description) : "unnamed"))
        .join(", ");
    const taskNoun = tasks.length === 1 ? "task" : "tasks";
    return `${finished} (${tasks.length} background ${taskNoun} still running: ${names})`;
}

function requestedInput({ tool_name, tool_input: input }: HookPayload): unknown {
    if (tool_name !== QUESTION_TOOL || typeof input !== "object" || input === null) {
        return input;
    }

    const { answers, annotations, ...asked } = input as Record<string, unknown>;
    return asked;
}

function labelOf({ tool_name: name = "a tool", tool_input: input }: HookPayload): string {
    return toolLabel(name, describeTool(name, input).title);
}

const withDetail = (words: string, detail: string | undefined) => (detail ? `${words}: ${detail}` : words);

const entryOf = <T>(table: Partial<Record<HookEventName, T>>, name: HookEventName): T | undefined =>
    Object.hasOwn(table, name) ? table[name] : undefined;

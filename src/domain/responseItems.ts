import { type HookEvidence, isSameCall, type NeedsYou, type Request, type RequestedCall } from "./brief.js";
import type { Block, MessageRecord } from "./records.js";
import {
    type CallResult,
    type FullResponse,
    PATH_KINDS,
    type ResponseItem,
    type ResponseSource,
    resultInWords,
    type SubagentItem,
    type ToolItem,
    type ToolResult,
    type ToolState,
    withTextCut,
} from "./response.js";
import { type Ending, endingAfterHook, endingAfterPrompt, endingAfterRecord, withEnd } from "./responseEnd.js";
import { relativeTo } from "./text.js";
import { isEndedByUser, isNoInIzbor, isUsersPrompt, waitedAt } from "./transcriptActions.js";

/** What the full response is built from: when the Task began, the response items since its prompt in order, with
 *  whole paths, the tool and input of their calls, the session's folder from the last main-thread hook, and what the
 *  Task's main-thread hooks told of the calls that ended, by call id. A reducer returns a new value. */
export type ResponseState = {
    /** The Task's time: a record stamped before it belongs to an earlier Task. Null while the Task is unknown. */
    since: string | null;
    items: readonly ResponseItem[];
    /** The tool and input of each call item, by call id, as a request names them: the waiting call is found by them.
     *  Emptied with the items. */
    requested: ReadonlyMap<string, RequestedCall>;
    /** From the last main-thread hook that named it, else from the agent's session list. */
    folder?: string;
    /** Wins over what the transcript tells of the same call; a new Task empties it. Kept only in memory, so a call
     *  that ended before the watch began reads by its result's first line. */
    results: ReadonlyMap<string, CallResult>;
    /** The calls a main-thread hook said finished, by call id: `done` before their row is read. Kept as `results`. */
    done: ReadonlySet<string>;
    /** What told how the reply ended; a new Task starts it again. */
    ending?: Ending;
};

/** The state of a keeper that knows no Task yet. */
export const NO_RESPONSE: ResponseState = {
    since: null,
    items: [],
    requested: new Map(),
    results: new Map(),
    done: new Set(),
};

/** A hook with a prompt of the user starts the response again, empty; a main-thread hook names the session's folder,
 *  and keeps what it tells of the call that ended: that it finished, and its result. */
export function responseAfterHook(state: ResponseState, evidence: HookEvidence, cwd?: string): ResponseState {
    const { at, prompt, agentId, endedCall, callDone, result } = evidence;
    const folder = agentId === null && cwd !== undefined ? cwd : state.folder;
    if (prompt !== undefined) return { ...NO_RESPONSE, since: at, folder };
    const ending = endingAfterHook(state.ending, evidence, state.items);
    if (agentId !== null || endedCall === undefined) return { ...state, folder, ending };
    const results = result ? new Map<string, CallResult>([...state.results, [endedCall, result]]) : state.results;
    const done = callDone ? new Set([...state.done, endedCall]) : state.done;
    return { ...state, folder, results, done, ending };
}

type Stamped = MessageRecord & { timestamp: string };

const isStamped = (record: MessageRecord): record is Stamped => record.timestamp !== null;

const isPrompt = ({ origin, blocks }: MessageRecord) =>
    isUsersPrompt(origin) && blocks.some(({ type }) => type === "text");

/** Reads new message records into the items: only the main thread's, after the Task's prompt, each block once. A
 *  record stamped before the Task's time, such as a late one of the Task before, adds nothing; a prompt record of the
 *  user starts the response again. `needsYouLog` tells a rejected call from an interrupted one. */
export function responseAfterRecords(
    state: ResponseState,
    records: readonly MessageRecord[],
    needsYouLog: NeedsYou[],
): ResponseState {
    let { since, items, ending } = state;
    let requested = [...state.requested];
    for (const record of records) {
        if (record.agentId !== null || !isStamped(record)) continue;
        if (since !== null && Date.parse(record.timestamp) < Date.parse(since)) continue;
        if (isPrompt(record)) {
            since = record.timestamp;
            items = [];
            requested = [];
            ending = endingAfterPrompt(ending, since);
        } else if (since !== null) {
            items = withRecord(items, record, needsYouLog);
            requested = [...requested, ...requestedIn(record)];
            ending = endingAfterRecord(ending, record, record.timestamp);
        }
    }
    return { ...state, since, items, requested: new Map(requested), ending };
}

/** The calls a record starts, each by its call id with its tool and input, as a request names them. */
const requestedIn = ({ blocks }: MessageRecord) =>
    blocks.flatMap((block): [string, RequestedCall][] =>
        block.type === "toolCall" ? [[block.toolCallId, { tool: block.name, input: block.rawInput }]] : [],
    );

/** The items after one record: a text, call or notice block adds an item keyed by record id and block index, or by
 *  call id, unless it is already there; a result ends its call. */
function withRecord(items: readonly ResponseItem[], record: Stamped, needsYouLog: NeedsYou[]): readonly ResponseItem[] {
    let next = items;
    for (const [index, block] of record.blocks.entries()) {
        if (block.type === "toolResult") {
            const state = stateAfter(block, record.timestamp, needsYouLog);
            next = next.map((item) =>
                (item.type === "tool" || item.type === "subagent") && item.id === block.toolCallId
                    ? ended(item, block, state)
                    : item,
            );
            continue;
        }
        const item = itemOf(block, record, `${record.id}:${index}`);
        if (item && !next.some(({ id }) => id === item.id)) next = [...next, item];
    }
    return next;
}

function itemOf(block: Block, { role, timestamp: at, synthetic }: Stamped, id: string): ResponseItem | undefined {
    switch (block.type) {
        case "text":
            if (role !== "assistant" || synthetic !== undefined || !block.text.trim()) return undefined;
            return { type: "text", id, at, text: block.text };
        case "notice":
            return { type: "notice", id, at, text: block.text };
        case "toolCall":
            return callItem(block, at);
        case "thinking":
        case "toolResult":
        case "other":
            return undefined;
        default:
            return block satisfies never;
    }
}

/** A call that starts a subagent is one subagent item, any other call a tool item; each runs until its result. */
function callItem(block: Extract<Block, { type: "toolCall" }>, at: string): ResponseItem {
    const { toolCallId: id, name, kind, title, display, argument, description, subagent } = block;
    const shown = { display, description: description ?? argument, state: "running" } as const;
    if (subagent) return { type: "subagent", id, at, ...subagent, ...shown };
    const described = description === undefined ? {} : { description };
    return { type: "tool", id, at, name, kind, title, display, argument, ...described, state: "running" };
}

type ToolResultBlock = Extract<Block, { type: "toolResult" }>;

/** A refusal by the user is `rejected` when Needs you waited at the result's time, otherwise `interrupted`. */
function stateAfter({ status, rawOutput }: ToolResultBlock, at: string, needsYouLog: NeedsYou[]): ToolState {
    if (status !== "failed") return "done";
    if (isNoInIzbor(rawOutput)) return "rejected";
    if (!isEndedByUser(rawOutput)) return "failed";
    return waitedAt(needsYouLog, at) ? "rejected" : "interrupted";
}

/** A call its result in the transcript ended: its state, and what that result tells for when no hook told it. */
function ended(item: ToolItem | SubagentItem, block: ToolResultBlock, state: ToolState): ResponseItem {
    const result = resultIn(block, state);
    const shown = { state, ...(result && { result }) };
    return item.type === "tool" ? { ...item, ...shown } : { ...item, ...shown, ...block.counts };
}

/** A done call reads by its output's first line, or as sent to the background; a failed one by its exit code and
 *  first error line. */
function resultIn({ firstLine, exitCode, background }: ToolResultBlock, state: ToolState): ToolResult | undefined {
    if (state === "done" && background) return { kind: "background" };
    if (state === "done") return firstLine === undefined ? undefined : { kind: "first line", text: firstLine };
    if (state !== "failed" || (firstLine === undefined && exitCode === undefined)) return undefined;
    return { kind: "failed", ...(exitCode !== undefined && { exitCode }), firstLine: firstLine ?? "" };
}

/** The full response for the brief whose Needs you is `needsYou`, its items from `source`, their text within the
 *  limit: null while the Task is unknown. */
export function fullResponse(state: ResponseState, needsYou: NeedsYou, source: ResponseSource): FullResponse | null {
    const { since, items, ending, requested } = state;
    if (since === null) return null;
    const request = needsYou.state === "request" && needsYou.agentId === null ? needsYou : undefined;
    const shown = items.map((item) => shownIn(item, state, request));
    const { items: told, end } = withEnd(shown, ending, { since, requested, source, ...(request && { request }) });
    const { items: kept, cut } = withTextCut(told);
    return { items: kept, end, source, cut };
}

/** An item as the brief shows it, `request` being the main thread's in Needs you: a call in its state, with its result
 *  in words and its paths relative to the session's folder; a subagent with the counts its hook told. */
function shownIn(item: ResponseItem, response: ResponseState, request?: Request): ResponseItem {
    const { folder, results } = response;
    switch (item.type) {
        case "tool": {
            const { result, ...call } = item;
            const argument = PATH_KINDS.includes(item.kind) ? relativeTo(folder, item.argument) : item.argument;
            return { ...call, argument, ...shownState(call, result, response, request) };
        }
        case "subagent": {
            const { result, ...call } = item;
            const told = results.get(item.id);
            const counts = told?.kind === "subagent" ? { toolUses: told.toolUses, durationMs: told.durationMs } : {};
            return { ...call, ...counts, ...shownState(call, result, response, request) };
        }
        case "text":
        case "notice":
            return item;
        default:
            return item satisfies never;
    }
}

/** A call's state, and its result: the one its hook told, else `fromRow`, the one its transcript row told. */
function shownState(
    item: Pick<ToolItem, "id" | "state">,
    fromRow: ToolResult | undefined,
    response: ResponseState,
    request?: Request,
): Pick<ToolItem, "state" | "result" | "summary"> {
    const told = response.results.get(item.id);
    const state = stateOf(item, told, response, request);
    return { state, ...worded(state, toolResultOf(told) ?? fromRow, response.folder) };
}

/** The one rule: a hook that said the user interrupted the call wins; else its transcript row tells the state
 *  (`stateAfter`). Until that row is read, a call is `done` once its hook said it finished, `waiting` while the request
 *  asks for its tool with its input, until Needs you shows the request is over, and otherwise `running`. */
function stateOf(
    { id, state }: Pick<ToolItem, "id" | "state">,
    told: CallResult | undefined,
    { done, requested }: ResponseState,
    request?: Request,
): ToolState {
    if (told?.kind === "interrupted") return "interrupted";
    if (state !== "running") return state;
    if (done.has(id)) return "done";
    const call = requested.get(id);
    return request !== undefined && call !== undefined && isSameCall(call, request) ? "waiting" : "running";
}

const toolResultOf = (told: CallResult | undefined): ToolResult | undefined =>
    told?.kind === "subagent" || told?.kind === "interrupted" ? undefined : told;

/** A result with its path relative to the session's folder, and its words; nothing when there is no result, when the
 *  user refused or interrupted the call, which then reads by its state alone, or for a failure of a call not `failed`:
 *  the failure a hook told may be an interrupt or a refusal, until the transcript row tells which. */
function worded(state: ToolState, result?: ToolResult, folder?: string): Pick<ToolItem, "result" | "summary"> {
    if (result === undefined || state === "rejected" || state === "interrupted") return {};
    if (result.kind === "failed" && state !== "failed") return {};
    const shown = "path" in result ? { ...result, path: relativeTo(folder, result.path) } : result;
    return { result: shown, summary: resultInWords(shown) };
}

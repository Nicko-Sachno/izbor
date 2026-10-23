import type { HookEvidence, NeedsYou, RequestedCall } from "./brief.js";
import type { MessageRecord } from "./records.js";
import type { FullResponse, ResponseEnd, ResponseItem, ResponseSource, SubagentItem, ToolItem } from "./response.js";
import { describeTool, toolLabel } from "./toolCalls.js";

/** What told how the reply to the Task ended: the main-thread hook that ended it, and the Task's newest main-thread
 *  record. A reducer returns a new value; undefined when nothing told it yet. */
export type Ending = { hook?: HookEnd; record?: RecordEnd };

/** Stop, with the agent's last message and the newest text item when it came, or a main-thread StopFailure. */
type HookEnd =
    | { state: "finished"; at: string; lastMessage?: string; textBefore?: string }
    | { state: "failed"; at: string; error: string };

/** What the newest record tells: the model ended its turn, an error stood in for the reply, or the user interrupted
 *  it, `atCall` when at a tool call. */
type RecordEnd =
    | { state: "finished"; at: string }
    | { state: "failed"; at: string; error: string }
    | { state: "interrupted"; at: string; atCall: boolean };

/** A main-thread hook that finished the reply keeps its time, the agent's last message, and which text item was the
 *  newest then; one that failed keeps the error. A subagent's hook, and any other, leave the end as it is. */
export function endingAfterHook(
    ending: Ending | undefined,
    { at, agentId, replyFinished, lastMessage, replyFailed }: HookEvidence,
    items: readonly ResponseItem[],
): Ending | undefined {
    if (agentId !== null) return ending;
    if (replyFailed !== undefined) return { ...ending, hook: { state: "failed", at, error: replyFailed } };
    if (!replyFinished) return ending;
    const textBefore = items.findLast(({ type }) => type === "text")?.id;
    const told = { ...(lastMessage !== undefined && { lastMessage }), ...(textBefore !== undefined && { textBefore }) };
    return { ...ending, hook: { state: "finished", at, ...told } };
}

/** A prompt record of the user at `at` starts the end again, keeping only a hook's that came after it. */
export function endingAfterPrompt(ending: Ending | undefined, at: string): Ending | undefined {
    const hook = ending?.hook;
    return hook && Date.parse(hook.at) > Date.parse(at) ? { hook } : undefined;
}

/** A main-thread record of the Task, stamped at `at`, after its prompt: the newest that tells of the end decides. One
 *  that ends the reply tells how; one that shows the reply going on (the model wrote, a tool call ended, a notice
 *  came) tells that it has not ended. A line of the user's own, such as a local command, and the stand-in where no
 *  reply was asked for tell nothing. */
export function endingAfterRecord(ending: Ending | undefined, record: MessageRecord, at: string): Ending | undefined {
    const told = toldBy(record, at);
    if (told === undefined) return ending;
    const hook = ending?.hook;
    return { ...(hook && { hook }), ...(told !== "goes on" && { record: told }) };
}

function toldBy({ role, blocks, synthetic, endedTurn }: MessageRecord, at: string): RecordEnd | "goes on" | undefined {
    const interrupt = blocks.find((block) => block.type === "text" && block.interrupt !== undefined);
    if (interrupt?.type === "text") return { state: "interrupted", at, atCall: interrupt.interrupt === "tool use" };
    if (role === "user")
        return blocks.some(({ type }) => type === "toolResult" || type === "notice") ? "goes on" : undefined;
    if (synthetic === "error") return { state: "failed", at, error: textOf(blocks) };
    if (synthetic === "no reply") return undefined;
    return endedTurn ? { state: "finished", at } : "goes on";
}

const textOf = (blocks: MessageRecord["blocks"]) =>
    blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

/** Where the full response stands: the Task's time, the main thread's request in Needs you, the tool and input of
 *  each call, by call id, and where its items come from. */
type Standing = {
    since: string;
    request?: Extract<NeedsYou, { state: "request" }>;
    requested: ReadonlyMap<string, RequestedCall>;
    source: ResponseSource;
};

/** The shown items with the agent's last message from the hook that finished the reply, while the transcript does not
 *  hold it yet, and how the reply ended. From `last message only`, that message is the one item, and there is none
 *  when no hook finished the reply with one; the end still reads every item Izbor holds. */
export function withEnd(
    shown: ResponseItem[],
    ending: Ending | undefined,
    standing: Standing,
): Pick<FullResponse, "items" | "end"> {
    const items = withLastMessage(shown, ending?.hook);
    const end = endAfter(items, ending, standing);
    return { items: standing.source === "transcript" ? items : lastMessageOf(ending?.hook), end };
}

/** The end that came last stands until an item or the main thread's request in Needs you comes after it; otherwise
 *  the reply is `waiting` on that request, `writing` since its newest item, or has `nothing yet` since the Task's time. */
function endAfter(
    items: readonly ResponseItem[],
    ending: Ending | undefined,
    { since, request, requested }: Standing,
): ResponseEnd {
    const newest = items.at(-1);
    const ended = latest(ending?.hook, ending?.record);
    const after = (at: string | undefined) =>
        ended !== undefined && at !== undefined && Date.parse(at) > Date.parse(ended.at);
    if (ended && !after(newest?.at) && !after(request?.at)) return endOf(ended, items, requested);
    if (request) return { state: "waiting", at: request.at };
    return newest ? { state: "writing", at: newest.at } : { state: "nothing yet", at: since };
}

/** The end told last; a hook's when both came at once. */
const latest = (hook?: HookEnd, record?: RecordEnd): HookEnd | RecordEnd | undefined =>
    hook && record && Date.parse(record.at) > Date.parse(hook.at) ? record : (hook ?? record);

/** The end as the brief gives it. */
function endOf(
    ended: HookEnd | RecordEnd,
    items: readonly ResponseItem[],
    requested: Standing["requested"],
): ResponseEnd {
    switch (ended.state) {
        case "finished":
            return { state: ended.state, at: ended.at };
        case "failed":
            return { state: ended.state, at: ended.at, error: ended.error };
        case "interrupted":
            return ended.atCall ? atCall(ended.at, items, requested) : { state: ended.state, at: ended.at };
        default:
            return ended satisfies never;
    }
}

/** A call the user refused or interrupted. */
const userEnded = (item: ResponseItem): item is ToolItem | SubagentItem =>
    (item.type === "tool" || item.type === "subagent") && (item.state === "rejected" || item.state === "interrupted");

/** At the interrupt line of a tool call: ended at that call when the newest call the user ended was refused, named as
 *  its label names it; interrupted otherwise. */
function atCall(at: string, items: readonly ResponseItem[], requested: Standing["requested"]): ResponseEnd {
    const call = items.findLast(userEnded);
    const refused = call?.state === "rejected" ? requested.get(call.id) : undefined;
    if (refused === undefined) return { state: "interrupted", at };
    return {
        state: "ended at a tool call",
        at,
        call: toolLabel(refused.tool, describeTool(refused.tool, refused.input).title),
    };
}

/** The id of the text item that holds the agent's last message from the hook. */
const LAST_MESSAGE = "last message";

/** The items, and last the agent's last message from the hook that finished the reply, unless the transcript holds it
 *  (the newest text item has its words, or came after the hook and stands last) or the reply went on after it. */
function withLastMessage(items: ResponseItem[], hook?: HookEnd): ResponseItem[] {
    if (hook?.state !== "finished" || hook.lastMessage === undefined) return items;
    if (items.some(({ at }) => Date.parse(at) > Date.parse(hook.at))) return items;
    const newest = items.findLast((item) => item.type === "text");
    const same = newest?.type === "text" && newest.text.trim() === hook.lastMessage.trim();
    if (same || (newest !== undefined && newest.id !== hook.textBefore && items.at(-1) === newest)) return items;
    return [...items, ...lastMessageOf(hook)];
}

/** The agent's last message from the hook that finished the reply, as a text item; none when no such hook gave one. */
const lastMessageOf = (hook?: HookEnd): ResponseItem[] =>
    hook?.state === "finished" && hook.lastMessage !== undefined
        ? [{ type: "text", id: LAST_MESSAGE, at: hook.at, text: hook.lastMessage }]
        : [];

import type { Brief, HookEvidence, MessageAction, NeedsYou } from "./brief.js";
import type { MessageRecord } from "./records.js";
import type { ResponseSource } from "./response.js";
import {
    fullResponse,
    NO_RESPONSE,
    type ResponseState,
    responseAfterHook,
    responseAfterRecords,
} from "./responseItems.js";
import { actionsOf, type ToolCalls } from "./transcriptActions.js";

/** What the brief keeper keeps between two readings of the transcript: the tool calls met so far, the calls whose
 *  end a hook already reported, the last Needs you changes, oldest first, what the full response is built from, and
 *  where its items come from, as the reads tell it. A reducer returns a new value. */
export type TranscriptMemory = {
    calls: ToolCalls;
    reported: ReadonlySet<string>;
    needsYouLog: NeedsYou[];
    response: ResponseState;
    source: ResponseSource;
};

/** What one read of the transcript found: records of its main thread, none, or nothing because it failed. */
export type TranscriptRead = "found" | "empty" | "failed";

const NEEDS_YOU_CHANGES = 50;

/** The memory of a keeper that has read nothing yet, whose brief's Needs you is `needsYou`. */
export const firstMemory = (needsYou: NeedsYou): TranscriptMemory => ({
    calls: new Map(),
    reported: new Set(),
    needsYouLog: [needsYou],
    response: NO_RESPONSE,
    source: "transcript",
});

/** A read that failed leaves the full response with only the agent's last message at once, and so does one that
 *  found no record of the main thread once a main-thread hook ended the reply: before that, the agent may not have
 *  written yet, and it changes nothing. A read that found records brings the transcript back. The source holds across
 *  Tasks. */
export function rememberRead(memory: TranscriptMemory, read: TranscriptRead): TranscriptMemory {
    switch (read) {
        case "found":
            return { ...memory, source: "transcript" };
        case "empty":
            return memory.response.ending?.hook === undefined ? memory : { ...memory, source: "last message only" };
        case "failed":
            return { ...memory, source: "last message only" };
        default:
            return read satisfies never;
    }
}

/** Remembers the call whose end the hook reported, so its result in the transcript adds no action, and reads the hook
 *  into the response: a prompt of the user starts it again, `cwd`, the hook's folder, is the session's folder, and
 *  what the hook told of its call, that it finished and its result, is kept by call id, in memory only, until the next
 *  Task. */
export function rememberHook(memory: TranscriptMemory, evidence: HookEvidence, cwd?: string): TranscriptMemory {
    const { endedCall } = evidence;
    const reported = endedCall ? new Set([...memory.reported, endedCall]) : memory.reported;
    return { ...memory, reported, response: responseAfterHook(memory.response, evidence, cwd) };
}

/** Takes the session's folder from the agent's session list (`listed`) while no main-thread hook has named one: a
 *  session watched after its turn ended may send none before you read its response. */
export const rememberFolder = (memory: TranscriptMemory, listed: string | undefined): TranscriptMemory =>
    listed === undefined || memory.response.folder !== undefined
        ? memory
        : { ...memory, response: { ...memory.response, folder: listed } };

/** Adds a changed Needs you to the log, which keeps the last NEEDS_YOU_CHANGES. */
export const rememberNeedsYou = (memory: TranscriptMemory, needsYou: NeedsYou): TranscriptMemory => ({
    ...memory,
    needsYouLog: [...memory.needsYouLog, needsYou].slice(-NEEDS_YOU_CHANGES),
});

/** The brief with the full response the memory holds, against the brief's own Needs you: the call it asks about waits
 *  until Needs you shows the request is over. */
export const withResponse = (brief: Brief, { response, source }: TranscriptMemory): Brief => ({
    ...brief,
    response: fullResponse(response, brief.needsYou, source),
});

/** Reads new message records into actions and into the response, and remembers the tool calls they start. */
export function rememberMessages(
    memory: TranscriptMemory,
    records: MessageRecord[],
): { memory: TranscriptMemory; actions: MessageAction[] } {
    const { actions, calls } = actionsOf(records, memory.calls, memory.reported, memory.needsYouLog);
    const response = responseAfterRecords(memory.response, records, memory.needsYouLog);
    return { memory: { ...memory, calls, response }, actions };
}

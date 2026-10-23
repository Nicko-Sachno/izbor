import type { EventRecord, MessageRecord } from "../domain/records.js";
import type { TranscriptRead } from "../domain/transcriptMemory.js";
import type { Report } from "./report.js";

export type Thread = { agentId: string | null; messages: MessageRecord[] };

export type SessionFiles = {
    exists(sessionId: string): Promise<boolean>;
    append(sessionId: string, records: (MessageRecord | EventRecord)[]): Promise<void>;
    replaceMessages(sessionId: string, messages: MessageRecord[]): Promise<void>;
};

type SessionSyncDeps = {
    sessionId: string;
    readThreads: (sessionId: string, cwd?: string) => Promise<Thread[]>;
    files: SessionFiles;
    report: Pick<Report, "shrunk" | "error">;
    onMessages: (records: MessageRecord[]) => void;
    /** Told of each read as it ends, before its records go to `onMessages`; a read that fails, or whose records
     *  cannot be written, is `failed`. */
    onRead: (read: TranscriptRead) => void;
    onSyncError: (err: unknown) => Promise<void>;
};

export type SessionSync = {
    sync(cwd?: string): Promise<void>;
    appendEvent(record: EventRecord, cwd?: string): Promise<void>;
};

/** How many messages of each thread the session file holds, by the thread's agent id: null for the main thread. */
type Cursors = {
    /** Whether `advance` has met the thread. */
    has(agentId: string | null): boolean;
    /** 0 for a thread `advance` has not met. */
    of(agentId: string | null): number;
    /** Marks every message of `threads` as written. */
    advance(threads: Thread[]): void;
};

/** What a read found in the threads it gave: the transcript, when its main thread holds a record. */
const foundIn = (threads: Thread[]): TranscriptRead =>
    threads.some(({ agentId, messages }) => agentId === null && messages.length > 0) ? "found" : "empty";

function threadCursors(): Cursors {
    const cursors = new Map<string | null, number>();
    return {
        has: (agentId) => cursors.has(agentId),
        of: (agentId) => cursors.get(agentId) ?? 0,
        advance(threads) {
            for (const { agentId, messages } of threads) cursors.set(agentId, messages.length);
        },
    };
}

export function createSessionSync(deps: SessionSyncDeps): SessionSync {
    const { sessionId, readThreads, files, report, onMessages, onRead, onSyncError } = deps;
    const cursors = threadCursors();

    const needsRebuild = async () => !cursors.has(null) || !(await files.exists(sessionId));

    async function rebuild(threads: Thread[]) {
        const records = threads.flatMap(({ messages }) => messages);
        if (records.length === 0) return;
        await files.replaceMessages(sessionId, records);
        cursors.advance(threads);
        onMessages(records);
    }

    async function append(threads: Thread[]) {
        const records = threads.flatMap(({ agentId, messages }) => messages.slice(cursors.of(agentId)));
        if (records.length === 0) return;
        await files.append(sessionId, records);
        cursors.advance(threads);
        onMessages(records);
    }

    async function sync(cwd?: string) {
        try {
            await syncThreads(cwd);
        } catch (err) {
            onRead("failed");
            await onSyncError(err);
            throw err;
        }
    }

    async function syncThreads(cwd?: string) {
        const threads = await readThreads(sessionId, cwd);
        onRead(foundIn(threads));
        if (await needsRebuild()) return rebuild(threads);
        const shrunk = threads.find(({ agentId, messages }) => messages.length < cursors.of(agentId));
        if (!shrunk) return append(threads);
        const keepFile = threads.every(({ messages }) => messages.length === 0);
        const { agentId, messages } = shrunk;
        report.shrunk(agentId, messages.length, cursors.of(agentId), keepFile);
        if (!keepFile) await rebuild(threads);
    }

    async function appendEvent(record: EventRecord, cwd?: string) {
        if (await needsRebuild()) await sync(cwd).catch(report.error);
        await files.append(sessionId, [record]);
    }

    return { sync, appendEvent };
}

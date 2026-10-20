import type { EventRecord, MessageRecord } from "../domain/records.js";
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
    onSyncError: (err: unknown) => Promise<void>;
};

export type SessionSync = {
    sync(cwd?: string): Promise<void>;
    appendEvent(record: EventRecord, cwd?: string): Promise<void>;
};

export function createSessionSync(deps: SessionSyncDeps): SessionSync {
    const { sessionId, readThreads, files, report, onMessages, onSyncError } = deps;
    const cursors = new Map<string | null, number>();
    const cursorOf = (agentId: string | null) => cursors.get(agentId) ?? 0;
    const advanceCursors = (threads: Thread[]) => {
        for (const { agentId, messages } of threads) cursors.set(agentId, messages.length);
    };

    const needsRebuild = async () => !cursors.has(null) || !(await files.exists(sessionId));

    async function rebuild(threads: Thread[]) {
        const records = threads.flatMap(({ messages }) => messages);
        if (records.length === 0) return;
        await files.replaceMessages(sessionId, records);
        advanceCursors(threads);
        onMessages(records);
    }

    async function append(threads: Thread[]) {
        const records = threads.flatMap(({ agentId, messages }) => messages.slice(cursorOf(agentId)));
        if (records.length === 0) return;
        await files.append(sessionId, records);
        advanceCursors(threads);
        onMessages(records);
    }

    async function sync(cwd?: string) {
        try {
            await syncThreads(cwd);
        } catch (err) {
            await onSyncError(err);
            throw err;
        }
    }

    async function syncThreads(cwd?: string) {
        const threads = await readThreads(sessionId, cwd);
        if (await needsRebuild()) return rebuild(threads);
        const shrunk = threads.find(({ agentId, messages }) => messages.length < cursorOf(agentId));
        if (!shrunk) return append(threads);
        const keepFile = threads.every(({ messages }) => messages.length === 0);
        const { agentId, messages } = shrunk;
        report.shrunk(agentId, messages.length, cursorOf(agentId), keepFile);
        if (!keepFile) await rebuild(threads);
    }

    async function appendEvent(record: EventRecord, cwd?: string) {
        if (await needsRebuild()) await sync(cwd).catch(report.error);
        await files.append(sessionId, [record]);
    }

    return { sync, appendEvent };
}

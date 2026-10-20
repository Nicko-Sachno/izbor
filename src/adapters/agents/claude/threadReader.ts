import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Thread } from "../../../core/sessionSync.js";
import { toMessageRecord } from "./messageRecord.js";

export type SessionReaders = {
    getSessionMessages: (sessionId: string, options: { dir?: string }) => Promise<SessionMessage[]>;
    listSubagents: (sessionId: string, options: { dir?: string }) => Promise<string[]>;
    getSubagentMessages: (sessionId: string, agentId: string, options: { dir?: string }) => Promise<SessionMessage[]>;
};

export function createThreadReader({ getSessionMessages, listSubagents, getSubagentMessages }: SessionReaders) {
    return async function readThreads(sessionId: string, cwd?: string): Promise<Thread[]> {
        const options = { dir: cwd };
        const [mainMessages, agentIds] = await Promise.all([
            getSessionMessages(sessionId, options),
            listSubagents(sessionId, options),
        ]);

        const subagentThreads = await Promise.all(
            agentIds.map(async (agentId) => {
                const messages = await getSubagentMessages(sessionId, agentId, options);
                return toThread(agentId, messages);
            }),
        );

        return [toThread(null, mainMessages), ...subagentThreads];
    };
}

function toThread(agentId: string | null, messages: SessionMessage[]): Thread {
    return {
        agentId,
        messages: messages.map((message) => toMessageRecord(message, agentId)),
    };
}

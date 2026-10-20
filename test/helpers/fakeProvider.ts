import { readHook } from "../../src/adapters/agents/claude/hook.js";
import { answerHook } from "../../src/adapters/agents/claude/provider.js";
import { readStatuses } from "../../src/adapters/agents/claude/statuses.js";
import { createThreadReader, type SessionReaders } from "../../src/adapters/agents/claude/threadReader.js";
import type { AgentProvider } from "../../src/core/ports.js";

type FakeProviderOptions = Partial<SessionReaders> & {
    runClaudeAgents?: (signal: AbortSignal) => Promise<string>;
    isActing?: AgentProvider["isActing"];
};

export function fakeProvider({
    getSessionMessages = async () => [],
    listSubagents = async () => [],
    getSubagentMessages = async () => [],
    runClaudeAgents = async () => "[]",
    isActing = () => false,
}: FakeProviderOptions = {}): AgentProvider {
    return {
        readHook,
        readThreads: createThreadReader({ getSessionMessages, listSubagents, getSubagentMessages }),
        async queryStatus(signal) {
            const listed = readStatuses(await runClaudeAgents(signal));
            if ("unreadable" in listed) throw new Error(listed.unreadable);
            return listed;
        },
        isActing,
        answerHook,
    };
}

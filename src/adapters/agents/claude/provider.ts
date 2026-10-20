import { getSessionMessages, getSubagentMessages, listSubagents } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider, CreateProvider } from "../../../core/ports.js";
import { createAgentsList } from "./agentsList.js";
import { readHook } from "./hook.js";
import { answerHookAt } from "./setup/answerHook.js";
import { readStatuses } from "./statuses.js";
import { createThreadReader } from "./threadReader.js";

export const answerHook: AgentProvider["answerHook"] = {
    output(decision) {
        if (!decision) {
            return "";
        }

        return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    },
};

export const createClaudeProvider: CreateProvider = ({ platform }) => {
    const list = createAgentsList({ run: platform.run });

    return {
        readHook,
        readThreads: createThreadReader({ getSessionMessages, listSubagents, getSubagentMessages }),
        async queryStatus(signal) {
            const output = await list(signal);
            const listed = readStatuses(output);
            if ("unreadable" in listed) {
                return Promise.reject(new Error(listed.unreadable));
            }

            return listed;
        },
        isActing: (cwd, port) => answerHookAt(cwd, port, platform),
        answerHook,
    };
};

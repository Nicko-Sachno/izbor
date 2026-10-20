import type { Platform, Ran } from "../../../core/ports.js";

export type AgentsList = (signal: AbortSignal) => Promise<string>;

export const CLAUDE_COMMAND = "claude";

const TIMEOUT_MS = 5000;

export function createAgentsList({ run }: { run: Platform["run"] }): AgentsList {
    return async (signal) => {
        const result = await run(CLAUDE_COMMAND, ["agents", "--json"], { timeoutMs: TIMEOUT_MS, signal });
        const output = commandOutput(result, signal);
        if ("failed" in output) {
            throw output.failed;
        }

        return output.stdout;
    };
}

function commandOutput(result: Ran, signal: AbortSignal): CommandOutput {
    switch (result.outcome) {
        case "exited": {
            const { code, stderr } = result;
            const exitReason = code === null ? result.signal : `code ${code}`;
            if (code !== 0) {
                return { failed: new Error(`claude agents --json exited with ${exitReason}: ${stderr.trim()}`) };
            }

            return { stdout: result.stdout };
        }
        case "timed_out":
            return { failed: new Error(`claude agents --json gave no answer in ${TIMEOUT_MS} ms`) };
        case "cancelled":
            return { failed: signal.reason };
        case "not_started":
            return { failed: new Error(result.why) };
        default:
            return result satisfies never;
    }
}

type CommandOutput = { stdout: string } | { failed: unknown };

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { query, type SDKRateLimitInfo, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Platform } from "../../core/ports.js";
import type { Summarize, SummaryRequest, SummaryResult } from "../../domain/summary.js";
import { messageOf } from "../../domain/text.js";

type SummarizerOptions = {
    dir: string;
    platform: Pick<Platform, "killTree" | "reachesTreeAfterExit">;
    command?: string;
    env: NodeJS.ProcessEnv;
    killAfterMs?: number;
};

const KILL_AFTER_MS = 2000;

const MESSAGES_WAIT_MS = 1000;

const STDERR_WAIT_MS = 200;

const STDERR_CHARS = 2000;

const API_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

const CANCELLED: SummaryResult = { outcome: "cancelled" };

const NO_RESULT: SummaryResult = { outcome: "unavailable", reason: "claude ended without a result" };

const limitReached = ({ rateLimitType, overageDisabledReason }: SDKRateLimitInfo) =>
    `${rateLimitType ?? "usage"} limit reached, no overage${overageDisabledReason ? ` (${overageDisabledReason})` : ""}`;

function toResult(message: SDKResultMessage, errors: string[]): SummaryResult {
    if (message.subtype === "success" && !message.is_error) return { outcome: "summary", text: message.result.trim() };
    const said = message.subtype === "success" ? message.result : [message.subtype, ...message.errors].join(" ");
    return { outcome: "unavailable", reason: [...errors, said].join(": ") };
}

const mayKill = (child: ChildProcess | undefined, { reachesTreeAfterExit }: Pick<Platform, "reachesTreeAfterExit">) =>
    reachesTreeAfterExit || child === undefined || (child.exitCode === null && child.signalCode === null);

export function createSummarizer({
    dir,
    platform,
    command,
    env,
    killAfterMs = KILL_AFTER_MS,
}: SummarizerOptions): Summarize {
    const subscriptionEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !API_KEYS.includes(name)));

    async function run({ systemPrompt, input }: SummaryRequest, signal: AbortSignal): Promise<SummaryResult> {
        let child: ChildProcess | undefined;
        let stderr = "";
        let result: SummaryResult | undefined;
        const answer = (answered: SummaryResult) => (result ??= answered);
        let onExit = () => {};
        const exited = new Promise<void>((resolve) => (onExit = resolve));
        let onStderrEnd = () => {};
        const stderrEnded = new Promise<void>((resolve) => (onStderrEnd = resolve));
        const kill = () => (mayKill(child, platform) ? platform.killTree(child?.pid) : undefined);
        await mkdir(dir, { recursive: true });
        if (signal.aborted) return CANCELLED;
        const request = query({
            prompt: input,
            options: {
                model: "haiku",
                cwd: dir,
                settingSources: [],
                settings: { disableAllHooks: true, autoMemoryEnabled: false },
                persistSession: false,
                tools: [],
                strictMcpConfig: true,
                mcpServers: {},
                systemPrompt,
                title: "izbor-summarizer",
                thinking: { type: "disabled" },
                maxTurns: 1,
                pathToClaudeCodeExecutable: command,
                env: subscriptionEnv,
                spawnClaudeCodeProcess: ({ command, args, cwd, env }) => {
                    const spawned = spawn(command, args, { cwd, env, detached: true, windowsHide: true });
                    spawned.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-STDERR_CHARS)));
                    spawned.stderr.once("close", onStderrEnd);
                    spawned.once("exit", onExit);
                    spawned.once("error", onExit);
                    child = spawned;
                    return spawned;
                },
            },
        });

        let killTimer: NodeJS.Timeout | undefined;
        const onCancel = () => {
            if (result) return kill();
            answer(CANCELLED);
            request.interrupt().catch(() => {});
            killTimer = setTimeout(kill, killAfterMs);
        };
        signal.addEventListener("abort", onCancel, { once: true });

        async function readMessages(): Promise<void> {
            const errors: string[] = [];
            try {
                for await (const message of request) {
                    if (message.type === "assistant" && message.error) errors.push(message.error);
                    if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected")
                        errors.push(limitReached(message.rate_limit_info));
                    if (message.type !== "result") continue;
                    answer(toResult(message, errors));
                    if (signal.aborted) kill();
                }
                answer(NO_RESULT);
            } catch (err) {
                const said = messageOf(err);
                await Promise.race([stderrEnded, sleep(STDERR_WAIT_MS, undefined, { ref: false })]);
                answer({ outcome: "unavailable", reason: `${said} ${stderr}`.trim() });
            }
        }

        const messagesRead = readMessages();
        await Promise.race([messagesRead, exited]);
        if (child) await exited;
        signal.removeEventListener("abort", onCancel);
        clearTimeout(killTimer);
        kill();
        if (!result) await Promise.race([messagesRead, sleep(MESSAGES_WAIT_MS, undefined, { ref: false })]);
        return result ?? NO_RESULT;
    }

    return (request, signal) => run(request, signal).catch((err) => ({ outcome: "unavailable", reason: String(err) }));
}

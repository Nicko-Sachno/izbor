import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { mergeAnswerHook } from "../../src/adapters/agents/claude/setup/answerHook.js";
import { settingsFileOf } from "../../src/adapters/agents/claude/setup/projectFiles.js";
import { createIzborClient } from "../../src/adapters/izbor/client.js";
import { HOOK_RUNNER } from "../../src/config.js";
import type { BriefEvent, StreamEvent } from "../../src/domain/streamEvent.js";
import { until } from "../support.js";
import { missingIzborHooks } from "../../src/adapters/agents/claude/setup/izborHooks.js";
import { readJson } from "../../src/domain/text.js";

export { HOOK_RUNNER };

// The answer hook's stdout for an allowed permission request, byte for byte.
export const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

// A permission request for one Bash command.
export const BASH = {
    tool_name: "Bash",
    tool_input: { command: "echo held > held.txt", description: "Write held.txt" },
};

export type ExecHookEntry = { command: string; args: string[] };

export function runHookEntry(t: TestContext, entry: ExecHookEntry, payload: object) {
    const groups = process.platform !== "win32";
    const child = spawn(entry.command, entry.args, { stdio: ["pipe", "pipe", "ignore"], detached: groups });
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
        try {
            if (groups) process.kill(-child.pid!, signal);
            else child.kill(signal);
        } catch {}
    };
    t.after(() => kill("SIGKILL"));
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.end(JSON.stringify(payload));
    const exited = once(child, "exit").then(([code]) => code as number | null);
    let done = false;
    void exited.then(() => (done = true));
    return { child, kill, exited, stdout: () => stdout, running: () => !done };
}

export async function actingProject(t: TestContext, port: number) {
    const project = await mkdtemp(join(tmpdir(), "izbor-acting-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const merged = mergeAnswerHook(null, port, HOOK_RUNNER);
    if (!("text" in merged)) throw new Error("no answer hook to write");
    await mkdir(join(project, ".claude"));
    await writeFile(settingsFileOf(project), merged.text);
    return project;
}

export async function tuneInOverHttp(t: TestContext, port: number, sessionId: string) {
    const events: StreamEvent[] = [];
    const leaving = new AbortController();
    const client = createIzborClient({ port });
    const ended = client.readStream(sessionId, { open() {}, event: (event) => events.push(event) }, leaving.signal);
    const leave = async () => {
        leaving.abort();
        await ended;
    };
    t.after(leave);
    const briefs = () => events.filter((event): event is BriefEvent => event.type === "brief");
    await until(() => briefs().length > 0);
    return {
        events,
        briefs,
        leave,
        latest: () => briefs().at(-1)!,
        answerables: () =>
            briefs()
                .map(({ answerable }) => answerable)
                .filter((answerable, i, all) => i === 0 || answerable !== all[i - 1]),
    };
}

export const readSendKey = async (path: string) => (await readFile(path, "utf8")).trim();

export const hasIzborHooks = (text: string, port: number): boolean =>
    missingIzborHooks(readJson(text), port).length === 0;

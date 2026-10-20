import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { eventHookEntry, HOOK_EVENT_NAMES } from "../src/adapters/agents/claude/setup/izborHooks.js";
import { HOOK_RUNNER, INHERITED_FROM_CLAUDE } from "../src/config.js";
import type { StopWhy } from "../src/domain/records.js";
import type { BriefEvent, StreamEvent } from "../src/domain/streamEvent.js";

const PORT = process.env.VERIFY_PORT ?? "4399";
const MODEL = process.env.VERIFY_MODEL ?? "haiku";
const REPO = join(import.meta.dirname, "..");

const HOOK_ENTRY = eventHookEntry(HOOK_RUNNER, Number(PORT));

const PROMPT_A =
    "Read src/a.ts and src/b.ts, one at a time. Then ask me with the AskUserQuestion tool whether I want a short or a detailed answer. Then explain what the two files do. Do not edit any file and do not run any command.";
const PROMPT_B =
    "Run `ping -c 10 127.0.0.1`. When it has finished, read src/b.ts. Then run `ping -c 5 127.0.0.1`. Then tell me both average round-trip times. One step at a time, in this order. Do not edit any file.";

const EXPLANATION_SETTLES_MS = 12_000;
const SUMMARIZER = "claude-agent-sdk-darwin-arm64/claude";

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED_FROM_CLAUDE.test(name)));

const run = promisify(execFile);
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function until<T>(
    what: string,
    look: () => T | null | undefined | false | Promise<T | null | undefined | false>,
    timeoutMs: number,
    everyMs = 100,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = await look();
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${what} in ${seconds(timeoutMs)}`);
        await sleep(everyMs);
    }
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function pgrep(...args: string[]): Promise<number[]> {
    try {
        return (await run("pgrep", args)).stdout.split("\n").filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

async function stillRunning(pids: number[]): Promise<number[]> {
    const groups = await Promise.all(pids.map((pid) => pgrep("-g", String(pid))));
    return [...new Set([...pids.filter(alive), ...groups.flat()])];
}

const folder = await mkdtemp(join(tmpdir(), "izbor-verify-"));
const project = join(folder, "project");
const dataDir = join(folder, "data");
const sessionId = randomUUID();

await mkdir(join(project, ".claude"), { recursive: true });
await mkdir(join(project, "src"));
await writeFile(join(project, "src", "a.ts"), "export const greet = (name: string) => `hello ${name}`;\n");
await writeFile(join(project, "src", "b.ts"), 'import { greet } from "./a";\n\nconsole.log(greet("izbor"));\n');
await writeFile(
    join(project, ".claude", "settings.local.json"),
    JSON.stringify(
        {
            hooks: Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, [{ hooks: [HOOK_ENTRY] }]])),
        },
        null,
        2,
    ),
);

type Agent = { pid: number; sessionId: string; status?: string; waitingFor?: string };

async function listed(): Promise<Agent | null> {
    try {
        const { stdout } = await run("claude", ["agents", "--json"], { env, timeout: 5000 });
        return (JSON.parse(stdout) as Agent[]).find((agent) => agent.sessionId === sessionId) ?? null;
    } catch {
        return null;
    }
}

function startSession() {
    const claude = `stty rows 50 cols 160; exec claude --model ${MODEL} --session-id ${sessionId} --setting-sources project,local`;
    const child = spawn("python3", ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", "sh", "-c", claude], {
        cwd: project,
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let screen = "";
    const show = (chunk: Buffer) => {
        appendFileSync(join(folder, "session.txt"), chunk);
        screen += chunk
            .toString()
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
    };
    child.stdout.on("data", show);
    child.stderr.on("data", show);
    const key = (keys: string) => void child.stdin.write(keys);
    return {
        child,
        screen: () => screen,
        key,
        async type(text: string) {
            key(text);
            await sleep(500);
            key("\r");
        },
    };
}

type Brief = BriefEvent & { at: number; run: number };

const briefs: Brief[] = [];
const streamEnds: string[] = [];
let runs = 0;

function toStreamEvent(frame: string): StreamEvent | null {
    const lines = frame.split("\n").filter((line) => !line.startsWith(":"));
    if (lines.length === 0) return null;
    const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
    const type = field("event");
    if (!type) throw new Error(`a frame with no event name: ${frame}`);
    return { type, ...JSON.parse(field("data") ?? "") } as StreamEvent;
}

const endInWords = ({ error }: { error?: string }) => (error ? `broke off: ${error}` : "ended by Izbor");

async function tuneIn(run: number, isRunning: () => boolean) {
    const res = await until(
        "answer to the tune-in",
        async () => {
            if (!isRunning()) throw new Error(`Izbor run ${run} exited before it listened`);
            return fetch(`http://127.0.0.1:${PORT}/sessions/${sessionId}/events`).catch(() => null);
        },
        15_000,
        200,
    );
    const body = res.body;
    if (!res.ok || !body) throw new Error(`the tune-in got ${res.status}: ${await res.text()}`);
    const events: StreamEvent[] = [];
    const over: Promise<{ error?: string }> = (async () => {
        let rest = "";
        for await (const text of body.pipeThrough(new TextDecoderStream())) {
            appendFileSync(join(folder, `stream-${run}.txt`), text);
            const frames = (rest + text).split("\n\n");
            rest = frames.pop() ?? "";
            for (const event of frames.map(toStreamEvent)) {
                if (!event) continue;
                events.push(event);
                if (event.type === "brief") briefs.push({ ...event, at: Date.now(), run });
            }
        }
        return {};
    })().catch((err: Error) => ({ error: `${err.message}${err.cause ? ` (${err.cause})` : ""}` }));
    void over.then((end) => streamEnds.push(`run ${run} ${endInWords(end)}`));
    return { events, over };
}

function startIzbor() {
    const run = ++runs;
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: REPO,
        env: { ...env, PORT, IZBOR_DATA_DIR: dataDir },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const save = (chunk: Buffer) => appendFileSync(join(folder, `izbor-${run}.txt`), chunk);
    child.stdout?.on("data", save);
    child.stderr?.on("data", save);
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const isRunning = () => child.exitCode === null && child.signalCode === null;
    return {
        pid: child.pid!,
        tunedIn: tuneIn(run, isRunning),
        async stop() {
            const sent = Date.now();
            child.kill("SIGINT");
            return { code: await exited, ms: Date.now() - sent };
        },
        isRunning,
    };
}

const briefSince = (what: string, since: number, holds: (brief: Brief) => unknown, timeoutMs: number) =>
    until(`brief with ${what}`, () => briefs.slice(since).find(holds), timeoutMs);

const latest = () => briefs.at(-1);

type HookRecord = {
    kind: string;
    event?: string;
    why?: StopWhy;
    payload?: { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
};

async function hookRecords(): Promise<HookRecord[]> {
    const file = await readFile(join(dataDir, "sessions", `${sessionId}.hooks.ndjson`), "utf8");
    return file
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HookRecord);
}

type Check = { name: string; passed: boolean; notes: string[] };
const checks: Check[] = [];
const NAMES = [
    "1. Working",
    "2. Waiting",
    "3. Continuing",
    "4. Response finished",
    "6. Stop during a summary request",
    "5. Missing observations",
    "4. Response finished, after the restart",
    "7. After every stop",
];

async function check(name: string, body: (note: (text: string) => void) => Promise<boolean>): Promise<void> {
    const notes: string[] = [];
    try {
        checks.push({ name, passed: await body((text) => notes.push(text)), notes });
    } catch (err) {
        notes.push(err instanceof Error ? err.message : String(err));
        checks.push({ name, passed: false, notes });
        throw new Error(`${name} did not finish`);
    }
}

const speaksOfWaiting = (explanation: string) => /\b(wait(s|ing)?|awaits?|awaiting|about to)\b/i.test(explanation);
const finished = ({ latestActivity, status }: Brief) => latestActivity?.replyFinished && status?.state === "idle";
const requestFor = (tool: string, { needsYou }: Brief) =>
    needsYou.state === "request" && needsYou.tool === tool ? needsYou : null;
const explanationText = ({ explanation }: Brief) => (explanation.state === "explained" ? explanation.text : "");
function judgeLastBrief(last: Brief, note: (text: string) => void): boolean {
    note("the last brief:");
    rowsOf(last).forEach(note);
    const fields = finished(last) && last.needsYou.state === "nothing";
    if (!fields) note("the fields are not those of a finished reply");
    const { explanation } = last;
    if (explanation.state === "unknown") {
        note("the finished reply has no explanation");
        return false;
    }
    const waits = speaksOfWaiting(explanation.text);
    if (waits) note("the explanation speaks of waiting after the reply finished");
    if (explanation.outdated)
        note(`the explanation is outdated (${explanation.outdated}): none came for the finished reply`);
    return Boolean(fields) && !waits && !explanation.outdated;
}
const restoredTask = ({ task }: Brief) =>
    task?.from === "transcript" && task.text.startsWith("Run `ping -c 10 127.0.0.1`");
const namesFirstTask = (explanation: string) => /a\.ts|\b(two|both)\b[^.]*\bfiles\b|explain/i.test(explanation);
const rowsOf = ({ task, status, latestActivity, needsYou, explanation }: Brief) => [
    `Task             ${JSON.stringify(task)}`,
    `Status           ${JSON.stringify(status)}`,
    `Latest activity  ${JSON.stringify(latestActivity)}`,
    `Needs you        ${JSON.stringify(needsYou)}`,
    `Explanation      ${JSON.stringify(explanation)}`,
];

const session = startSession();
let izbor = startIzbor();
let sessionPid = 0;
let aborted = "";

try {
    await izbor.tunedIn;
    const TRUST_DIALOG = /trust\s*this\s*folder/i;
    await until(
        "trust dialog or idle session",
        async () => TRUST_DIALOG.test(session.screen()) || (await listed())?.status === "idle",
        30_000,
        500,
    );
    if (TRUST_DIALOG.test(session.screen())) {
        session.key("\x1b[B");
        await sleep(500);
        session.key("\r");
    }
    sessionPid = (
        await until(
            "idle session in `claude agents --json`",
            async () => {
                const agent = await listed();
                return agent?.status === "idle" && agent;
            },
            30_000,
            500,
        )
    ).pid;
    await briefSince("a Status of idle", 0, (brief) => brief.status?.state === "idle", 15_000);

    let since = briefs.length;
    let typedAt = Date.now();
    await session.type(PROMPT_A);

    await check("1. Working", async (note) => {
        const task = await briefSince("the Task", since, (brief) => brief.task?.text.includes("Read src/a.ts"), 20_000);
        note(`Task after ${seconds(task.at - typedAt)}: ${JSON.stringify(task.task)}`);
        const read = await briefSince(
            "a Read",
            since,
            (brief) => /(started|finished) Read: .*a\.ts/.test(brief.latestActivity?.what ?? ""),
            40_000,
        );
        note(`Latest activity: ${JSON.stringify(read.latestActivity)}`);
        return true;
    });

    await check("2. Waiting", async (note) => {
        const asked = await briefSince(
            "a question under Needs you",
            since,
            (brief) => requestFor("AskUserQuestion", brief),
            60_000,
        );
        const waiting = await briefSince(
            "a Status of waiting",
            since,
            (brief) => brief.status?.state === "waiting",
            10_000,
        );
        note(`Needs you: ${JSON.stringify(asked.needsYou)}`);
        note(`Status ${seconds(waiting.at - asked.at)} later: ${JSON.stringify(waiting.status)}`);
        await sleep(EXPLANATION_SETTLES_MS);
        const request = (await hookRecords()).findLast(
            ({ payload }) =>
                payload?.hook_event_name === "PermissionRequest" && payload.tool_name === "AskUserQuestion",
        );
        const questions = (request?.payload?.tool_input as { questions?: unknown[] } | undefined)?.questions ?? [];
        const same = isDeepStrictEqual(requestFor("AskUserQuestion", asked)?.input, request?.payload?.tool_input);
        if (questions.length === 0) note("no PermissionRequest for AskUserQuestion with questions in the hook file");
        else if (!same) note("Needs you does not hold the questions of the PermissionRequest in the hook file");
        const inputNeeded = waiting.status?.state === "waiting" && waiting.status.waitingFor === "input needed";
        return questions.length > 0 && same && inputNeeded;
    });

    since = briefs.length;
    typedAt = Date.now();
    session.key("\r");

    await check("3. Continuing", async (note) => {
        const cleared = await briefSince(
            "no request pending",
            since,
            (brief) => brief.needsYou.state === "nothing",
            15_000,
        );
        note(`Needs you ${seconds(cleared.at - typedAt)} after the answer: ${JSON.stringify(cleared.needsYou)}`);
        const resumed = await briefSince("a Status of busy", since, (brief) => brief.status?.state === "busy", 15_000);
        note(`Status: ${JSON.stringify(resumed.status)}; Latest activity: ${JSON.stringify(resumed.latestActivity)}`);
        return true;
    });

    await check("4. Response finished", async (note) => {
        await briefSince("a finished reply and a Status of idle", since, finished, 120_000);
        await sleep(EXPLANATION_SETTLES_MS);
        const last = latest()!;
        const task = last.task?.text.includes("Read src/a.ts");
        if (!task) note("the Task is not the prompt");
        return judgeLastBrief(last, note) && Boolean(task);
    });

    since = briefs.length;
    await session.type(PROMPT_B);
    let aliveAfterFirstStop = false;

    await check("6. Stop during a summary request", async (note) => {
        const asked = await briefSince(
            "a permission request under Needs you",
            since,
            (brief) => requestFor("Bash", brief),
            60_000,
        );
        note(`Needs you: ${JSON.stringify(asked.needsYou)}`);
        const [summarizer] = await until(
            "summary request",
            async () => {
                const found = await pgrep("-P", String(izbor.pid), "-f", SUMMARIZER);
                return found.length > 0 && found;
            },
            30_000,
            50,
        );
        await sleep(300);
        const children = await pgrep("-P", String(izbor.pid));
        const { code, ms } = await izbor.stop();
        const { events, over } = await izbor.tunedIn;
        const end = await Promise.race([over, sleep(5000, { error: "still open 5 s after Izbor exited" })]);
        const last = events.at(-1);
        const stopped = last?.type === "session" && last.state === "stopped" && last.why === "izbor stopping";
        const checked = [...new Set([izbor.pid, summarizer!, ...children])];
        const left = await stillRunning(checked);
        const record = (await hookRecords()).findLast(({ kind }) => kind === "izbor");
        note(
            `SIGINT 0.3 s after the summarizer's process ${summarizer} appeared; Izbor exited with code ${code} after ${ms} ms`,
        );
        note(`the last stream event: ${JSON.stringify(last)}; the stream ${endInWords(end)}`);
        note(
            `processes of Izbor left: ${left.length} of ${checked.length}; last Izbor record: ${JSON.stringify(record)}`,
        );
        aliveAfterFirstStop = alive(sessionPid);
        return (
            stopped &&
            !end.error &&
            code === 0 &&
            left.length === 0 &&
            record?.event === "stopped" &&
            record.why === "izbor stopping"
        );
    });

    session.key("\r");
    await sleep(3000);

    await check("5. Missing observations", async (note) => {
        const waiting = await until(
            "second permission prompt",
            async () => {
                const agent = await listed();
                return agent?.status === "waiting" && agent;
            },
            120_000,
            500,
        );
        note(`while Izbor was down the session went on to: waiting for ${waiting.waitingFor}`);
        since = briefs.length;
        izbor = startIzbor();
        await izbor.tunedIn;
        await briefSince(
            "a Status of waiting after the restart",
            since,
            (brief) => brief.status?.state === "waiting",
            20_000,
        );
        await sleep(EXPLANATION_SETTLES_MS);
        const restarted = latest()!;
        note("the brief after the restart, with the permission prompt pending:");
        rowsOf(restarted).forEach(note);
        const task = restoredTask(restarted);
        if (!task) note("expected the second prompt as the Task, from the transcript");
        const { needsYou, explanation } = restarted;
        const waitsForPermission =
            needsYou.state === "unknown" &&
            needsYou.at !== undefined &&
            Boolean(needsYou.waitingFor?.startsWith("permission prompt"));
        if (!waitsForPermission) note("expected Needs you unknown, with the session waiting for a permission prompt");
        const explained = explanation.state === "explained";
        if (!explained) note("expected an explanation of the last turn, asked at the watch start");
        session.key("\r");
        return task && waitsForPermission && explained;
    });

    await check("4. Response finished, after the restart", async (note) => {
        await briefSince("a finished reply after the restart", since, finished, 120_000);
        await sleep(EXPLANATION_SETTLES_MS);
        const last = latest()!;
        const judged = judgeLastBrief(last, note);
        const task = restoredTask(last);
        if (!task) note("the Task is not the second prompt, from the transcript");
        const earlier = namesFirstTask(explanationText(last));
        if (earlier) note("the explanation names work of the first Task");
        return judged && task && !earlier;
    });

    await check("7. After every stop", async (note) => {
        note(
            `after the stop during the summary request: session process ${aliveAfterFirstStop ? "alive" : "gone"}, and it finished the Task`,
        );
        const { code, ms } = await izbor.stop();
        note(
            `second stop: Izbor exited with code ${code} after ${ms} ms; session process ${alive(sessionPid) ? "alive" : "gone"}`,
        );
        await session.type("say ok");
        const reply = await until(
            "reply to `say ok`",
            async () => {
                const messages = (await getSessionMessages(sessionId)) as {
                    type: string;
                    message?: { content?: unknown };
                }[];
                const asked = messages.findLastIndex(
                    ({ type, message }) => type === "user" && JSON.stringify(message?.content ?? "").includes("say ok"),
                );
                if (asked < 0) return null;
                const blocks = messages
                    .slice(asked + 1)
                    .flatMap(({ type, message }) => (type === "assistant" ? message?.content : []));
                return (blocks as { type?: string; text?: string }[]).find((block) => block?.type === "text")?.text;
            },
            60_000,
            1000,
        );
        note(`the session answered \`say ok\` after the last stop: ${reply.slice(0, 80)}`);
        return aliveAfterFirstStop && code === 0 && alive(sessionPid);
    });
} catch (err) {
    aborted = err instanceof Error ? err.message : String(err);
} finally {
    if (izbor.isRunning()) await izbor.stop();
    await session.type("/exit");
    await until("end of the session", () => session.child.exitCode !== null, 10_000).catch(() => session.child.kill());
    await sleep(500);
}

const report: string[] = [`Izbor complete flow · session ${sessionId} · ${new Date().toISOString()}`, ""];
for (const name of NAMES) {
    const done = checks.find((check) => check.name === name);
    report.push(`${name}: ${done ? (done.passed ? "passed" : "FAILED") : "not run"}`);
    for (const note of done?.notes ?? []) report.push(`    ${note}`);
}
if (aborted) report.push("", `Stopped early: ${aborted}`);

report.push("", "Explanations, each at the time it was first streamed:");
let shown = "";
for (const { at, run, explanation } of briefs) {
    const text =
        explanation.state === "unknown"
            ? `unknown${explanation.reason ? ` (${explanation.reason})` : ""}`
            : `${explanation.outdated ? `(outdated: ${explanation.outdated}) ` : ""}${explanation.text}`;
    if (text !== shown) report.push(`    ${clock(at)} run ${run}  ${text}`);
    shown = text;
}

const left = [
    ...(sessionPid && alive(sessionPid) ? [`the session (pid ${sessionPid})`] : []),
    ...(alive(izbor.pid) ? [`Izbor (pid ${izbor.pid})`] : []),
];
report.push(
    "",
    `Streams: ${streamEnds.join("; ") || "none ended"}`,
    `Left running: ${left.length > 0 ? left.join(", ") : "nothing"}`,
    `Evidence: ${folder}`,
);

await writeFile(join(folder, "report.txt"), `${report.join("\n")}\n`);
console.log(report.join("\n"));
process.exit(aborted || checks.some((check) => !check.passed) ? 1 : 0);

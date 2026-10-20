import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { toLine } from "../src/adapters/log/stdoutLog.js";
import { PROJECT_DIR } from "../src/config.js";
import { createSessionHolds } from "../src/core/sessionHolds.js";
import { createStatusQuery, type StatusQuery } from "../src/core/statusQuery.js";
import { createSummaryTurns } from "../src/core/summaryTurns.js";
import type { Listener } from "../src/core/watchTracker.js";
import type { StopWhy } from "../src/domain/records.js";
import type { StreamEvent } from "../src/domain/streamEvent.js";
import { createIzbor } from "../src/izbor.js";
import { createWatch } from "../src/watch.js";
import { pathFirst, writeFakeCommand } from "./helpers/fakeCommand.js";
import { fakeProvider } from "./helpers/fakeProvider.js";
import { heldSummarizer } from "./helpers/fakeSummarizers.js";
import { recordingLog } from "./helpers/recordingLog.js";

export const SESSION = "1234abcd-0000-4000-8000-000000000000";
export const OTHER_SESSION = "9999ffff-0000-4000-8000-000000000000";
export const RECEIVED_AT = new Date("2026-10-01T12:00:00.000Z");

let n = 0;
export const msg = (
    type: SessionMessage["type"],
    content: unknown,
    parentToolUseId: string | null = null,
): SessionMessage => ({
    type,
    uuid: `uuid-${++n}`,
    session_id: SESSION,
    message: { role: type, content },
    parent_tool_use_id: parentToolUseId,
    parent_agent_id: null,
});

export const dated = (message: SessionMessage, timestamp: string, origin?: object): SessionMessage => {
    const fromTranscript = { timestamp, ...(origin && { origin }) };
    return { ...message, ...fromTranscript };
};

export const prompt = (text: string, timestamp: string) => dated(msg("user", text), timestamp, { kind: "human" });

export const hook = (hook_event_name: string, extra: object = {}) => ({
    session_id: SESSION,
    hook_event_name,
    cwd: "/repo",
    ...extra,
});

export const eventMarker = () => hook("PermissionRequest", { tool_name: "Bash", tool_input: {} });

export function testClock() {
    let time = RECEIVED_AT;
    const iso = (hms: string) => `2026-10-01T${hms}.000Z`;
    return { now: () => time, at: (hms: string) => (time = new Date(iso(hms))), iso };
}

export function fakeClock(start = 0) {
    let now = start;
    const timers: { at: number; fire: () => void }[] = [];
    return {
        wait: (ms: number, signal?: AbortSignal) =>
            new Promise<void>((fire) => {
                if (signal?.aborted) return fire();
                const timer = { at: now + ms, fire };
                timers.push(timer);
                signal?.addEventListener("abort", () => {
                    if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1);
                    fire();
                });
            }),
        now: () => new Date(now),
        dueWithin: (ms: number) => timers.some((t) => t.at <= now + ms),
        async advance(ms: number) {
            await settle();
            const target = now + ms;
            for (;;) {
                const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers.splice(timers.indexOf(due), 1);
                now = due.at;
                due.fire();
                await settle();
            }
            now = target;
        },
    };
}

export async function until(condition: () => boolean | Promise<boolean>, { what = "condition", ms = 3000 } = {}) {
    for (let i = 0; i < ms / 5 && !(await condition()); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(await condition(), `${what} never became true`);
}

export async function readUntil(body: ReadableStream<Uint8Array>, text: string): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let read = "";
    while (!read.includes(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        read += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    return read;
}

const noWait = async (_ms: number) => {};

export { settle };

export type AgentsListEntry = { sessionId: string; cwd: string; status: string; waitingFor?: string };

export const agentsList = (sessions: { sessionId: string; cwd: string; [field: string]: unknown }[]) =>
    JSON.stringify(
        sessions.map((session, i) => ({ pid: i + 1, kind: "interactive", name: basename(session.cwd), ...session })),
    );

export const agentsOutput = (session: object | null) =>
    agentsList([
        { sessionId: OTHER_SESSION, cwd: "/other", status: "idle" },
        ...(session ? [{ sessionId: SESSION, cwd: "/repo", ...session }] : []),
    ]);

export const ONE_SESSION_HERE = agentsList([
    { sessionId: SESSION, cwd: PROJECT_DIR, status: "idle", name: "izbor-b8" },
]);

export async function freePort(): Promise<number> {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    server.close();
    await once(server, "close");
    return port;
}

export async function portAnswering(t: TestContext, answer: RequestListener): Promise<number> {
    const server = createHttpServer(answer).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((closed) => server.close(closed)));
    return (server.address() as { port: number }).port;
}

export function fakeAgents(session: object | null | Error) {
    const agents = {
        session,
        runClaudeAgents: async () => {
            if (agents.session instanceof Error) throw agents.session;
            return agentsOutput(agents.session);
        },
    };
    return agents;
}

const NO_STATUS: StatusQuery = { subscribe: () => () => {}, query: async () => {}, stop: async () => {} };

export const noAnswer = (signal: AbortSignal) =>
    new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

export const readNdjson = async (path: string) =>
    (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));

export async function setup(
    transcript: SessionMessage[],
    {
        subagents = new Map<string, SessionMessage[]>(),
        wait = noWait,
        failReads = (): boolean => false,
        beforeRead = async (): Promise<void> => {},
        dir = undefined as string | undefined,
        now = () => RECEIVED_AT,
        runClaudeAgents = undefined as ((signal: AbortSignal) => Promise<string>) | undefined,
        summarize = heldSummarizer().summarize,
        takeTurn = createSummaryTurns().take,
        statusQuery = undefined as StatusQuery | undefined,
        isActing = (_cwd: string): boolean => false,
    } = {},
) {
    dir ??= await mkdtemp(join(tmpdir(), "izbor-"));
    const logged = recordingLog();
    const events: StreamEvent[] = [];
    const reads = { count: 0 };
    const ownsStatusQuery = !statusQuery;
    const { readThreads, queryStatus, readHook } = fakeProvider({
        getSessionMessages: async () => {
            reads.count++;
            await beforeRead();
            if (failReads()) throw new Error("sdk down");
            return [...transcript];
        },
        listSubagents: async () => [...subagents.keys()],
        getSubagentMessages: async (_sessionId, agentId) => [...(subagents.get(agentId) ?? [])],
        runClaudeAgents,
    });
    const query = statusQuery ?? (runClaudeAgents ? createStatusQuery({ queryStatus, wait, now }) : NO_STATUS);
    const holds = createSessionHolds({ wait, isActing, onChange: () => watch.holdsChanged() });
    const watch = createWatch({
        readThreads,
        statusQuery: query,
        summarize,
        takeTurn,
        sessionId: SESSION,
        sessionsDir: dir,
        log: logged.log,
        emit: (event) => events.push(event),
        holds: holds.of(SESSION),
        onNotListed: () => {},
        wait,
        now,
    });
    const file = join(dir, `${SESSION}.ndjson`);
    const hookFile = join(dir, `${SESSION}.hooks.ndjson`);
    const readHookFile = () => readNdjson(hookFile).catch(() => []);
    return {
        handle: (payload: object) => watch.handleHook(readHook(JSON.stringify(payload), now())!),
        handleRejected: watch.handleRejected,
        start: watch.start,
        snapshot: watch.snapshot,
        events,
        stop: async (why: StopWhy = "izbor stopping") => {
            await Promise.all([watch.stop(why), ownsStatusQuery && query.stop()]);
        },
        errors: () => logged.errors().map(toLine),
        printed: () => logged.entries.map(toLine),
        brief: () => events.findLast((event) => event.type === "brief")!,
        briefNow: () => watch.snapshot()[1],
        readRecords: () => readNdjson(file),
        readMessages: async () => (await readNdjson(file).catch(() => [])).filter((r) => r.kind === "message"),
        readHookFile,
        readStatuses: async () =>
            (await readHookFile())
                .filter((r) => r.kind === "status")
                .map(({ kind, sessionId, timestamp, ...status }) => status),
        reads,
        dir,
        file,
    };
}

export function listener() {
    const events: StreamEvent[] = [];
    let leave!: () => void;
    const gone = new Promise<void>((resolve) => (leave = resolve));
    const recorder = {
        events,
        ended: false,
        leave,
        send(event: StreamEvent) {
            assert.equal(recorder.ended, false, "sent after the end");
            events.push(event);
        },
        end() {
            assert.equal(recorder.ended, false, "ended twice");
            recorder.ended = true;
            leave();
        },
        gone,
    } satisfies Listener & Record<string, unknown>;
    return recorder;
}

export async function setupIzbor({
    transcripts = {} as Record<string, SessionMessage[]>,
    session = { status: "idle" } as object | null,
    agents = undefined as AgentsListEntry[] | string | undefined,
    summarize = heldSummarizer().summarize,
    wait = fakeClock().wait as (ms: number, signal?: AbortSignal) => Promise<void>,
    now = () => RECEIVED_AT,
    isActing = (_cwd: string): boolean => false,
} = {}) {
    const dir = await mkdtemp(join(tmpdir(), "izbor-"));
    const logged = recordingLog();
    const { readThreads, queryStatus, readHook } = fakeProvider({
        getSessionMessages: async (sessionId) => [...(transcripts[sessionId] ?? [])],
        runClaudeAgents: async () => (Array.isArray(agents) ? agentsList(agents) : (agents ?? agentsOutput(session))),
    });
    const { log } = logged;
    const izbor = createIzbor({ readThreads, queryStatus, summarize, sessionsDir: dir, log, isActing, wait, now });
    const read = (payload: object) => readHook(JSON.stringify(payload), now())!;
    return {
        ...izbor,
        hooks: { read: (body: string) => readHook(body, now()), handle: izbor.handleHook, hold: izbor.holdAnswer },
        handleHook: (payload: object) => izbor.handleHook(read(payload)),
        holdAnswer: (payload: object, closed: AbortSignal) => izbor.holdAnswer(read(payload), closed),
        printed: () => logged.entries.map(toLine),
        dir,
        tuneIn(sessionId: string) {
            const tunedIn = listener();
            izbor.tracker.tuneIn(sessionId, tunedIn);
            return Object.assign(tunedIn, { caughtUp: () => until(() => tunedIn.events.length === 2) });
        },
        tuneInAll() {
            const all = listener();
            izbor.tracker.tuneInAll(all);
            return Object.assign(all, {
                caughtUp: (watches: number) => until(() => all.events.length === 2 * watches),
            });
        },
        files: async () => (await readdir(dir).catch(() => [])).sort(),
        readSessionFile: (sessionId: string) => readNdjson(join(dir, `${sessionId}.ndjson`)).catch(() => []),
        readHookFile: (sessionId: string) => readNdjson(join(dir, `${sessionId}.hooks.ndjson`)).catch(() => []),
        errors: () => logged.errors().map(toLine),
    };
}

export async function fakeClaude(script: string) {
    const dir = await mkdtemp(join(tmpdir(), "izbor-claude-"));
    const command = join(dir, "claude");
    await writeFakeCommand(dir, "claude", script);
    const pids = async () =>
        (await readFile(join(dir, "pids"), "utf8").catch(() => "")).split(" ").filter(Boolean).map(Number);
    return { dir, command, sdkCommand: join(dir, "claude.js"), pids };
}

export async function isolatedIzborEnv(claudeScript = 'process.stdout.write("[]\\n");') {
    const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
    const claude = await fakeClaude(claudeScript);
    const summarizer = await fakeClaude("process.exit(1);");
    const env: NodeJS.ProcessEnv = {
        ...pathFirst(claude.dir),
        IZBOR_DATA_DIR: dataDir,
        IZBOR_SUMMARIZER_COMMAND: summarizer.sdkCommand,
    };
    return { dataDir, claude, env };
}

export function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

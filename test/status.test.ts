import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider } from "../src/adapters/agents/claude/provider.js";
import { readStatuses as readListedSessions } from "../src/adapters/agents/claude/statuses.js";
import type { Ran } from "../src/core/ports.js";
import { createStatusQuery } from "../src/core/statusQuery.js";
import { fakePlatform } from "./helpers/fakePlatform.js";
import { fakeProvider } from "./helpers/fakeProvider.js";
import {
    agentsList,
    agentsOutput,
    fakeClock,
    hook,
    noAnswer,
    OTHER_SESSION,
    RECEIVED_AT,
    SESSION,
    setup,
    setupIzbor,
    until,
} from "./support.js";

test("the Status of the watched session is saved at the watch start, with the time it was observed", async () => {
    const clock = fakeClock();
    const { start, readHookFile } = await setup([], {
        wait: clock.wait,
        runClaudeAgents: async () => agentsOutput({ status: "busy" }),
    });

    await start();
    assert.equal((await readHookFile()).length, 2);

    assert.deepEqual((await readHookFile())[1], {
        kind: "status",
        sessionId: SESSION,
        timestamp: RECEIVED_AT.toISOString(),
        status: "busy",
    });
});

function answering(...outputs: (string | Error)[]) {
    const queries = { count: 0 };
    const runClaudeAgents = async () => {
        const output = outputs[Math.min(queries.count++, outputs.length - 1)]!;
        if (output instanceof Error) throw output;
        return output;
    };
    return { queries, runClaudeAgents };
}

test("a Status change is saved; a Status query that finds the same Status saves nothing", async () => {
    const clock = fakeClock();
    const { queries, runClaudeAgents } = answering(
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "idle" }),
    );
    const { start, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    assert.equal((await readStatuses()).length, 1);
    await clock.advance(2000);
    assert.equal(queries.count, 2);
    await clock.advance(2000);
    await until(async () => (await readStatuses()).length === 2);

    assert.equal(queries.count, 3);
    assert.deepEqual(await readStatuses(), [{ status: "busy" }, { status: "idle" }]);
});

test("a waiting Status is saved with what the session waits for, and again when that changes", async () => {
    const clock = fakeClock();
    const { runClaudeAgents } = answering(
        agentsOutput({ status: "waiting", waitingFor: "permission prompt" }),
        agentsOutput({ status: "waiting", waitingFor: "worker request" }),
    );
    const { start, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    assert.equal((await readStatuses()).length, 1);
    await clock.advance(2000);
    await until(async () => (await readStatuses()).length === 2);

    assert.deepEqual(await readStatuses(), [
        { status: "waiting", waitingFor: "permission prompt" },
        { status: "waiting", waitingFor: "worker request" },
    ]);
});

test("a session Claude Code no longer lists is saved as not listed", async () => {
    const clock = fakeClock();
    const { runClaudeAgents } = answering(agentsOutput({ status: "idle" }), agentsOutput(null));
    const { start, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    assert.equal((await readStatuses()).length, 1);
    await clock.advance(2000);
    await until(async () => (await readStatuses()).length === 2);

    assert.deepEqual(await readStatuses(), [{ status: "idle" }, { status: "not_listed" }]);
});

test("a Status query that fails is saved as unknown, never as not listed; the next answer is saved again", async () => {
    const clock = fakeClock();
    const { runClaudeAgents } = answering(
        agentsOutput({ status: "busy" }),
        new Error("claude agents --json gave no answer in 5000 ms"),
        agentsOutput({ status: "busy" }),
    );
    const { start, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    assert.equal((await readStatuses()).length, 1);
    await clock.advance(2000);
    await until(async () => (await readStatuses()).length === 2);
    await clock.advance(2000);
    await until(async () => (await readStatuses()).length === 3);

    assert.deepEqual(await readStatuses(), [
        { status: "busy" },
        { status: "unknown", error: "Error: claude agents --json gave no answer in 5000 ms" },
        { status: "busy" },
    ]);
});

test("output Izbor cannot read as a Status is saved as unknown", async () => {
    const clock = fakeClock();
    const { queries, runClaudeAgents } = answering(
        "Not logged in",
        JSON.stringify({ error: "no sessions" }),
        agentsOutput({ status: "compacting" }),
        agentsOutput({}),
        agentsOutput({ status: "idle" }),
    );
    const { start, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    for (let i = 0; i < 20 && (await readStatuses()).at(-1)?.status !== "idle"; i++) {
        await clock.advance(2000);
        await new Promise((r) => setTimeout(r, 5));
    }

    assert.equal(queries.count, 5);
    const saved = await readStatuses();
    assert.deepEqual(
        saved.map((s) => s.status),
        ["unknown", "idle"],
    );
    assert.ok(saved[0]!.error, "the unknown Status says why");
});

test("a hook of the watched session causes a Status query at once; the next timed query is 2 s after it", async () => {
    const clock = fakeClock();
    const { queries, runClaudeAgents } = answering(
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "waiting", waitingFor: "permission prompt" }),
    );
    const { start, handle, readStatuses } = await setup([], { wait: clock.wait, runClaudeAgents });

    await start();
    assert.equal((await readStatuses()).length, 1);
    await clock.advance(1000);
    void handle(hook("PreToolUse", { tool_name: "Bash" }));
    await until(async () => (await readStatuses()).length === 2);
    assert.deepEqual((await readStatuses())[1], { status: "waiting", waitingFor: "permission prompt" });

    await clock.advance(1999);
    assert.equal(queries.count, 2);
    await clock.advance(1);
    assert.equal(queries.count, 3);
});

test("a Izbor stop cancels the Status query in flight, saves nothing for it and asks no more", async () => {
    const clock = fakeClock();
    const queries = { count: 0 };
    let cancelled = false;
    const { start, handle, stop, errors, readHookFile } = await setup([], {
        wait: clock.wait,
        runClaudeAgents: (signal) => {
            queries.count++;
            signal.addEventListener("abort", () => (cancelled = true));
            return noAnswer(signal);
        },
    });

    const started = start();
    assert.equal(queries.count, 1);
    await stop();
    await started;
    assert.equal(cancelled, true);

    await handle(hook("PostToolUse"));
    await clock.advance(5000);
    assert.equal(queries.count, 1);
    assert.deepEqual(errors(), []);
    assert.deepEqual(
        (await readHookFile()).map((r) => r.event ?? r.kind),
        ["started", "stopped"],
    );
});

test("watches share each Status query; a watch stop leaves it running for the others, and that watch saves no more Status", async () => {
    const clock = fakeClock();
    const { queries, runClaudeAgents } = answering(
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "busy" }),
        agentsOutput({ status: "idle" }),
    );
    const { queryStatus } = fakeProvider({ runClaudeAgents });
    const statusQuery = createStatusQuery({ queryStatus, wait: clock.wait, now: () => RECEIVED_AT });
    const a = await setup([], { wait: clock.wait, statusQuery });
    const b = await setup([], { wait: clock.wait, statusQuery });

    await Promise.all([a.start(), b.start()]);
    assert.equal((await a.readStatuses()).length, 1);
    assert.equal((await b.readStatuses()).length, 1);
    await clock.advance(2000);
    assert.equal(queries.count, 3);

    await a.stop();
    await clock.advance(2000);
    await until(async () => (await b.readStatuses()).length === 2);

    assert.equal(queries.count, 4);
    assert.deepEqual(await b.readStatuses(), [{ status: "busy" }, { status: "idle" }]);
    assert.deepEqual(
        (await a.readHookFile()).map((r) => r.event ?? r.status),
        ["started", "busy", "stopped"],
    );
});

async function statusesOfBoth(agents: NonNullable<Parameters<typeof setupIzbor>[0]>["agents"]) {
    const izbor = await setupIzbor({ agents });
    await Promise.all([SESSION, OTHER_SESSION].map((sessionId) => izbor.tuneIn(sessionId).caughtUp()));
    const saved = async (sessionId: string) =>
        (await izbor.readHookFile(sessionId))
            .filter((r) => r.kind === "status")
            .map(({ kind, sessionId, timestamp, ...status }) => status);
    const statuses = { watched: await saved(SESSION), other: await saved(OTHER_SESSION) };
    await izbor.stop();
    return statuses;
}

test("a session listed with a status Izbor does not know is saved as unknown, with the status; the other session keeps its own", async () => {
    const statuses = await statusesOfBoth([
        { sessionId: SESSION, cwd: "/repo", status: "compacting" },
        { sessionId: OTHER_SESSION, cwd: "/other", status: "idle" },
    ]);

    assert.deepEqual(statuses, {
        watched: [
            {
                status: "unknown",
                error: 'Error: claude agents --json reports a status Izbor does not know: "compacting"',
            },
        ],
        other: [{ status: "idle" }],
    });
});

test("output that is not JSON is saved as unknown by every watch, with the same sentence as output that is no list", async () => {
    const statuses = await statusesOfBoth("Not logged in");

    const unknown = { status: "unknown", error: "Error: claude agents --json printed no list: Not logged in" };
    assert.deepEqual(statuses, { watched: [unknown], other: [unknown] });
});

function providerOn(ran: Ran | "hangs") {
    const platform = fakePlatform({ runs: { claude: ran } });
    const provider = createClaudeProvider({
        platform,
        home: "/home/test",
        pluginDir: "/izbor/plugin",
        hookRunner: { node: "node", script: "/izbor/bin/post-hook.js" },
    });
    return { platform, provider };
}

const exited = (code: number, output: { stdout?: string; stderr?: string }): Ran => ({
    outcome: "exited",
    code,
    signal: null,
    stdout: "",
    stderr: "",
    ...output,
});

test("queryStatus runs `claude agents --json` once, with a limit of 5 s and its signal, and gives every listed session with its Status", async () => {
    const stdout = agentsOutput({ status: "waiting", waitingFor: "permission prompt" });
    const { platform, provider } = providerOn(exited(0, { stdout }));
    const { signal } = new AbortController();

    assert.deepEqual(await provider.queryStatus(signal), [
        { sessionId: OTHER_SESSION, status: "idle" },
        { sessionId: SESSION, status: "waiting", waitingFor: "permission prompt" },
    ]);
    assert.deepEqual(platform.ran, [
        { command: "claude", args: ["agents", "--json"], options: { timeoutMs: 5000, signal } },
    ]);
});

test("queryStatus rejects for a `claude agents --json` that exits with another code than 0, with the code and what it printed as its error", async () => {
    const { provider } = providerOn(exited(3, { stdout: "[]", stderr: "  Not logged in\n" }));

    await assert.rejects(provider.queryStatus(new AbortController().signal), {
        name: "Error",
        message: "claude agents --json exited with code 3: Not logged in",
    });
});

test("queryStatus rejects for a `claude agents --json` that gives no answer in 5 s", async () => {
    const { provider } = providerOn({ outcome: "timed_out", why: "no answer in 5000 ms" });

    await assert.rejects(provider.queryStatus(new AbortController().signal), {
        name: "Error",
        message: "claude agents --json gave no answer in 5000 ms",
    });
});

test("queryStatus rejects with the signal's reason when its signal aborts, during the run or before it", async () => {
    const { provider } = providerOn("hangs");
    const cancel = new AbortController();
    const reason = new Error("the watch stopped");

    const query = provider.queryStatus(cancel.signal);
    cancel.abort(reason);

    await assert.rejects(query, (rejected) => rejected === reason);
    await assert.rejects(provider.queryStatus(cancel.signal), (rejected) => rejected === reason);
});

test("queryStatus rejects for a `claude` that cannot start, in the words of the start", async () => {
    const { provider } = providerOn({ outcome: "not_started", why: "spawn claude ENOENT" });

    const rejected: unknown = await provider.queryStatus(new AbortController().signal).catch((error: unknown) => error);

    assert.equal(String(rejected), "Error: spawn claude ENOENT");
});

test("queryStatus rejects for output that is no list, with the start of the output", async () => {
    const { provider } = providerOn(exited(0, { stdout: "Not logged in" }));

    await assert.rejects(provider.queryStatus(new AbortController().signal), {
        name: "Error",
        message: "claude agents --json printed no list: Not logged in",
    });
});

test("readStatuses gives each session of the list its Status: busy, idle, and waiting with what it waits for", () => {
    const recorded = `[{"pid":71494,"cwd":"/Users/me/project","kind":"interactive","startedAt":1791107060252,
  "sessionId":"4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff","name":"izbor-b8","status":"idle"}]`;

    assert.deepEqual(readListedSessions(recorded), [
        { sessionId: "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff", status: "idle" },
    ]);
    assert.deepEqual(readListedSessions(agentsOutput({ status: "busy" })), [
        { sessionId: OTHER_SESSION, status: "idle" },
        { sessionId: SESSION, status: "busy" },
    ]);
    assert.deepEqual(readListedSessions(agentsOutput({ status: "waiting", waitingFor: "permission prompt" })), [
        { sessionId: OTHER_SESSION, status: "idle" },
        { sessionId: SESSION, status: "waiting", waitingFor: "permission prompt" },
    ]);
    assert.deepEqual(readListedSessions("[]"), []);
});

test("readStatuses reads a session with no status, or one Izbor does not know, as unknown for that session only, with the reason a watch saves", () => {
    const output = agentsList([
        { sessionId: OTHER_SESSION, cwd: "/other", status: "idle" },
        { sessionId: SESSION, cwd: "/repo" },
        { sessionId: "starting", cwd: "/third", status: "compacting" },
    ]);

    assert.deepEqual(readListedSessions(output), [
        { sessionId: OTHER_SESSION, status: "idle" },
        {
            sessionId: SESSION,
            status: "unknown",
            error: "Error: claude agents --json lists the session without a status",
        },
        {
            sessionId: "starting",
            status: "unknown",
            error: 'Error: claude agents --json reports a status Izbor does not know: "compacting"',
        },
    ]);
});

test("readStatuses reads output that is no list as unreadable, with its first 200 characters, and throws nothing", () => {
    assert.deepEqual(readListedSessions("Not logged in"), {
        unreadable: "claude agents --json printed no list: Not logged in",
    });
    assert.deepEqual(readListedSessions(JSON.stringify({ error: "no sessions" })), {
        unreadable: 'claude agents --json printed no list: {"error":"no sessions"}',
    });
    assert.deepEqual(readListedSessions("x".repeat(300)), {
        unreadable: `claude agents --json printed no list: ${"x".repeat(200)}`,
    });
});

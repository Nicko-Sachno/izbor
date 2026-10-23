import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createIzborClient, type IzborAnswer, type IzborClient } from "../src/adapters/izbor/client.js";
import type { SessionsAnswer } from "../src/domain/wire.js";
import { createTerminalController } from "../src/terminal/controller.js";
import { createRunningSessions, type Where } from "../src/terminal/live/agents.js";
import type { ReadStream } from "../src/terminal/live/observation.js";
import { createLiveSource, TICK_MS } from "../src/terminal/live/source.js";
import {
    hasStream,
    listedSessions,
    type ObservationSource,
    type ObservedSource,
    type SessionList,
} from "../src/terminal/model.js";
import { renderTerminal } from "../src/terminal/render.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { observedStoreContract, rowOf } from "./helpers/storeContract.js";
import { postHook } from "./helpers/izborPrompts.js";
import { agentsOutput, fakeClock, noAnswer, OTHER_SESSION, SESSION, settle, until } from "./support.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

const WHERE: Where = {
    summarizerDir: "/repo/.izbor/summarizer",
    checkoutOf: (cwd) => cwd,
    hasHooks: () => true,
    acts: () => false,
};

async function liveStore(t: TestContext, { fetch }: { fetch?: typeof globalThis.fetch } = {}) {
    const server = await startIzborServer(t);
    let runs = 0;
    const running = createRunningSessions({
        run: async () => (runs++, agentsOutput({ status: "idle" })),
        where: () => WHERE,
        now: () => new Date(),
    });
    const clock = fakeClock();
    const client = createIzborClient({ port: server.port, fetch });
    const answers: IzborAnswer[] = [];
    let probesOut = 0;
    const source = createLiveSource({
        client: {
            ...client,
            getIzbor: async (signal) => {
                probesOut++;
                try {
                    const answer = await client.getIzbor(signal);
                    answers.push(answer);
                    return answer;
                } finally {
                    probesOut--;
                }
            },
        },
        running,
        address: `127.0.0.1:${server.port}`,
        wait: clock.wait,
        now: () => new Date(),
    });
    t.after(() => source.dispose());
    return { ...server, source, runs: () => runs, clock, answers, probing: () => probesOut > 0 };
}

observedStoreContract("the live store", async (t) => ({ source: (await liveStore(t)).source, id: SESSION }));

const sendingNothing = (source: ObservedSource): ObservationSource => ({
    ...source,
    answer: () => Promise.reject(new Error("this test sends nothing")),
    prompt: () => Promise.reject(new Error("this test sends nothing")),
});

function statesOf(source: ObservedSource, id = SESSION) {
    const states: string[] = [];
    source.onChange(() => {
        const state = rowOf(source, id)?.connection.state;
        if (state && state !== states.at(-1)) states.push(state);
    });
    return states;
}

test("the store starts with Izbor up and the list loading, then runs claude agents once: the list", async (t) => {
    const { source, port, runs } = await liveStore(t);
    assert.deepEqual(source.getSnapshot(), {
        izbor: { state: "up", address: `127.0.0.1:${port}` },
        list: { state: "loading" },
        observations: [],
    });
    await until(() => source.getSnapshot().list.state === "listed");
    const { list } = source.getSnapshot();
    assert.deepEqual(list.state === "listed" && list.sessions.map(({ id }) => id), [OTHER_SESSION, SESSION]);
    assert.equal(runs(), 1);
});

test("observe of a listed UUID answers added: connecting before it returns, then catching up, then live", async (t) => {
    const { source } = await liveStore(t);
    await until(() => source.getSnapshot().list.state === "listed");
    const states = statesOf(source);

    assert.equal(source.observe(SESSION), "added");
    assert.deepEqual(rowOf(source), { id: SESSION, brief: null, connection: { state: "connecting" } });

    await until(() => rowOf(source)?.connection.state === "live");
    assert.deepEqual(states, ["connecting", "catching up", "live"]);
    assert.equal(rowOf(source)?.brief?.status, "idle");
});

async function storeWithLiveRow(t: TestContext) {
    const store = await liveStore(t);
    store.source.observe(SESSION);
    await until(() => rowOf(store.source)?.connection.state === "live");
    return store;
}

const tuneIns = (requests: { method: string; path: string }[], id = SESSION) =>
    requests.filter(({ method, path }) => method === "GET" && path === `/sessions/${id}/events`).length;

test("a UserPromptSubmit hook posted to Izbor → the row's Task shows that prompt", async (t) => {
    const { source, base } = await storeWithLiveRow(t);
    await postHook(base, "UserPromptSubmit", { prompt: "Fix the token refresh bug" });
    await until(() => rowOf(source)?.brief?.task?.text === "Fix the token refresh bug");
    assert.equal(rowOf(source)?.brief?.task?.from, "hook");
});

test("a DELETE of the watch → the row is stopped, deleted, with its last brief; it never observes again by itself", async (t) => {
    const { source, base, requests } = await storeWithLiveRow(t);
    const app = createTerminalController(sendingNothing(source), {
        ...NO_WRITES,
        columns: 120,
        rows: 40,
        changed() {},
    });
    const { brief, since } = rowOf(source)!;

    await (await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" })).text();
    await until(() => rowOf(source)?.connection.state === "stopped");
    assert.deepEqual(rowOf(source), { id: SESSION, brief, since, connection: { state: "stopped", why: "deleted" } });
    const frame = renderTerminal(app.view, { columns: 120, rows: 40 }).lines.join("\n");
    assert.ok(frame.includes("▲ Stopped · last known Brief"), frame);

    await delay(100);
    assert.equal(rowOf(source)?.connection.state, "stopped");
    assert.equal(tuneIns(requests), 1);
});

test("the server closes the stream with no stopped → disconnected for 1 s, then the row catches up and goes live, with no gap: the drop was under 30 s and Izbor was up", async (t) => {
    const { source, server, requests, clock } = await storeWithLiveRow(t);
    const app = createTerminalController(sendingNothing(source), {
        ...NO_WRITES,
        columns: 120,
        rows: 40,
        changed() {},
    });
    t.after(() => app.dispose());
    const brief = rowOf(source)?.brief;
    server.closeAllConnections();
    await until(() => rowOf(source)?.connection.state === "disconnected");
    const dropped = rowOf(source)!;
    assert.equal(dropped.brief, brief);
    assert.ok(dropped.connection.state === "disconnected" && dropped.connection.retryAt, JSON.stringify(dropped));
    const { since, retryAt } = dropped.connection;
    assert.equal(Date.parse(retryAt) - Date.parse(since), 1_000);
    await delay(100);
    assert.equal(tuneIns(requests), 1, "no read before the wait ends");

    const states = statesOf(source);
    await clock.advance(1_000);
    await until(() => rowOf(source)?.connection.state === "live");
    assert.deepEqual(states, ["connecting", "catching up", "live"]);
    assert.equal(tuneIns(requests), 2);
    assert.ok(!("gap" in rowOf(source)!), JSON.stringify(rowOf(source)));
    const frame = renderTerminal(app.view, { columns: 120, rows: 40 }).lines.join("\n");
    assert.ok(!frame.includes("Izbor did not observe"), frame);
});

function windowOn(t: TestContext, source: ObservedSource) {
    const headers: string[] = [];
    const frame = () => renderTerminal(app.view, { columns: 120, rows: 40 }).lines;
    const app = createTerminalController(sendingNothing(source), {
        ...NO_WRITES,
        columns: 120,
        rows: 40,
        changed() {
            const header = frame()[0]!.trim();
            if (header !== headers.at(-1)) headers.push(header);
        },
    });
    t.after(() => app.dispose());
    return { app, headers, text: () => frame().join("\n") };
}

test("Izbor stops in startService's order → the row reads ▲ last known Brief; ▲ Izbor ○ stopping, its probe a 503, until the tick after the port refuses; observe after a new Izbor shows the gap from the stop", async (t) => {
    const { source, server, izbor, port, requests, clock, answers } = await storeWithLiveRow(t);
    const { app, headers, text } = windowOn(t, source);
    const before = answers.length;
    izbor.tracker.close();
    await until(() => rowOf(source)?.connection.state === "stopped");
    assert.ok(text().includes("▲ last known Brief"), text());
    assert.ok(!text().includes("Stopped · Izbor stopped"), text());
    assert.equal(source.getSnapshot().izbor.state, "stopping");

    await until(() => answers.length > before);
    assert.deepEqual(answers.slice(before), [{ away: "stopping" }]);
    await new Promise((closed) => server.close(closed));
    await delay(50);
    assert.equal(source.getSnapshot().izbor.state, "stopping", "the port refuses, and nothing probes until the tick");
    await clock.advance(TICK_MS);
    await until(() => source.getSnapshot().izbor.state === "not running");
    assert.deepEqual(headers, [
        "Izbor ● up",
        "▲ Izbor ○ stopping",
        `▲ Izbor ○ not running on port ${port} · run izbor`,
    ]);
    assert.equal(tuneIns(requests), 1, "no second tune-in");

    await startIzborServer(t, { port });
    await clock.advance(TICK_MS);
    await until(() => app.view.feedback === "Izbor is back");
    assert.equal(rowOf(source)?.connection.state, "stopped");
    app.observe(SESSION);
    assert.equal(app.view.feedback, "Observing 1234abcd again.");
    await until(() => rowOf(source)?.connection.state === "live");
    const { gap } = rowOf(source)!;
    assert.ok(
        gap && Date.parse(gap.to) >= Date.parse(gap.from),
        "a gap from Izbor's stop to the first brief after it, shown however short",
    );
    assert.ok(text().includes("▲ Izbor did not observe this session between"), text());
});

test("Izbor's connections cut and its port closed with no stopped → ▲ Izbor ○ not running on port <port> · run izbor within one tick; a new Izbor on the port → Izbor is back, the row live by itself, with the gap", async (t) => {
    const { source, server, port, clock, probing } = await storeWithLiveRow(t);
    const { app, headers, text } = windowOn(t, source);
    server.closeAllConnections();
    server.close();
    await until(() => rowOf(source)?.connection.state === "disconnected");
    await clock.advance(TICK_MS);
    await until(() => source.getSnapshot().izbor.state === "not running");
    assert.equal(headers.at(-1), `▲ Izbor ○ not running on port ${port} · run izbor`);
    await until(() => !probing());
    await until(() => rowOf(source)?.connection.state === "izbor away");

    await startIzborServer(t, { port });
    await clock.advance(TICK_MS);
    await until(() => app.view.feedback === "Izbor is back");
    await until(() => rowOf(source)?.connection.state === "live");
    assert.equal(headers.at(-1), "Izbor ● up");
    assert.ok(text().includes("Izbor did not observe this session between"), text());
});

test("a 404 and a 400 → refused after exactly one request each, and none more after 60 s", async (t) => {
    const unknown = await liveStore(t, {
        fetch: (input, init) => globalThis.fetch(String(input).replace(/\/events$/, "/stream"), init),
    });
    unknown.source.observe(SESSION);
    const malformed = await liveStore(t);
    malformed.source.observe("not-a-session");

    for (const [{ source, requests, clock }, id, status] of [
        [unknown, SESSION, 404],
        [malformed, "not-a-session", 400],
    ] as const) {
        await until(() => rowOf(source, id)?.connection.state === "refused");
        const { connection } = rowOf(source, id)!;
        assert.equal(connection.state === "refused" && connection.status, status);
        await clock.advance(60_000);
        await delay(50);
        const reads = requests.filter(({ method, path }) => method === "GET" && path.startsWith(`/sessions/${id}/`));
        assert.equal(reads.length, 1, `${status}: ${JSON.stringify(reads)}`);
    }
});

async function watches(base: string) {
    const answer = (await (await fetch(`${base}/sessions`)).json()) as SessionsAnswer;
    return answer.sessions;
}

test("observe on a stopped or a disconnected row answers again: the same row catches up, then goes live", async (t) => {
    const { source, base, server } = await storeWithLiveRow(t);
    for (const cut of [
        async () => (await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" })).text(),
        async () => server.closeAllConnections(),
    ]) {
        await cut();
        await until(() => !hasStream(rowOf(source)!.connection));
        const states = statesOf(source);
        assert.equal(source.observe(SESSION), "again");
        assert.equal(rowOf(source)?.connection.state, "connecting", "before observe returns");
        await until(() => rowOf(source)?.connection.state === "live");
        assert.deepEqual(states, ["connecting", "catching up", "live"]);
        assert.deepEqual(
            source.getSnapshot().observations.map(({ id }) => id),
            [SESSION],
        );
    }
});

test("observe on a connecting, catching up or live row answers already", async (t) => {
    const { source } = await liveStore(t);
    const answers: string[] = [];
    source.onChange(() => {
        const row = rowOf(source);
        if (row && hasStream(row.connection)) answers.push(`${row.connection.state}: ${source.observe(SESSION)}`);
    });
    source.observe(SESSION);
    await until(() => rowOf(source)?.connection.state === "live");
    assert.deepEqual([...new Set(answers)], ["connecting: already", "catching up: already", "live: already"]);
});

test("leave drops the row before it returns; Izbor keeps the watch with 0 listeners, and got no DELETE", async (t) => {
    const { source, base, requests } = await storeWithLiveRow(t);
    source.leave(SESSION);
    assert.deepEqual(source.getSnapshot().observations, []);
    await until(async () => (await watches(base)).some(({ listeners }) => listeners === 0));
    assert.deepEqual(await watches(base), [{ sessionId: SESSION, listeners: 0 }]);
    assert.deepEqual(
        requests.filter(({ method }) => method === "DELETE"),
        [],
    );
});

test("a hook posted after the leave → the rows never change, and no row comes back", async (t) => {
    const { source, base } = await storeWithLiveRow(t);
    source.leave(SESSION);
    const rows = source.getSnapshot().observations;
    let rowChanges = 0;
    source.onChange(() => (rowChanges += Number(source.getSnapshot().observations !== rows)));
    await until(async () => (await watches(base))[0]?.listeners === 0);
    await postHook(base, "UserPromptSubmit", { prompt: "Fix the token refresh bug" });
    await delay(100);
    assert.equal(rowChanges, 0);
    assert.deepEqual(source.getSnapshot().observations, []);
});

test("the store reads every stream whatever the screen shows: Help open, a window too small", async (t) => {
    const { source, base } = await storeWithLiveRow(t);
    const app = createTerminalController(sendingNothing(source), { ...NO_WRITES, columns: 20, rows: 6, changed() {} });
    app.toggleHelp();
    assert.ok(app.view.help && app.view.small);
    renderTerminal(app.view, { columns: 20, rows: 6 });
    await postHook(base, "UserPromptSubmit", { prompt: "Fix the token refresh bug" });
    await until(() => rowOf(source)?.brief?.task?.text === "Fix the token refresh bug");
});

test("dispose aborts every stream and the list run before it returns; later refreshes reject and nothing fires", async (t) => {
    const server = await startIzborServer(t);
    const client = createIzborClient({ port: server.port });
    const streams: AbortSignal[] = [];
    let run: AbortSignal | undefined;
    const source = createLiveSource({
        client: { ...client, readStream: (id, on, leave) => (streams.push(leave), client.readStream(id, on, leave)) },
        running: createRunningSessions({
            run: (signal) => ((run = signal), noAnswer(signal)),
            where: () => WHERE,
            now: () => new Date(),
        }),
        address: `127.0.0.1:${server.port}`,
        wait: fakeClock().wait,
        now: () => new Date(),
    });
    await until(() => run !== undefined);
    source.observe(SESSION);
    source.observe(OTHER_SESSION);
    await until(() => source.getSnapshot().observations.every(({ connection }) => connection.state === "live"));
    let fired = 0;
    source.onChange(() => fired++);

    source.dispose();
    assert.equal(run?.aborted, true);
    assert.deepEqual(
        streams.map(({ aborted }) => aborted),
        [true, true],
    );

    await postHook(server.base, "UserPromptSubmit", { prompt: "Fix the token refresh bug" });
    await assert.rejects(source.refreshSessions(), { name: "AbortError" });
    assert.equal(fired, 0);
    await until(async () => (await watches(server.base)).every(({ listeners }) => listeners === 0));
    assert.deepEqual(
        (await watches(server.base)).map(({ sessionId }) => sessionId).sort(),
        [SESSION, OTHER_SESSION].sort(),
    );
});

const HELD_START = "2026-10-06T14:00:00.000Z";

type HeldRun = { answer(output: string): void; fail(reason: string): void; signal: AbortSignal };

type HeldProbe = { answer(answer: IzborAnswer): void; signal: AbortSignal | undefined };

type HeldRead = {
    id: string;
    on: Parameters<ReadStream>[1];
    end(end: Awaited<ReturnType<IzborClient["readStream"]>>): void;
};

const UP: IzborAnswer = { up: "older" };

const HELD_ADDRESS = "127.0.0.1:4319";

async function heldStore(t: TestContext) {
    const runs: HeldRun[] = [];
    const probes: HeldProbe[] = [];
    const reads: HeldRead[] = [];
    const calls: ("probe" | "run")[] = [];
    let says: IzborAnswer | "held" = UP;
    const clock = fakeClock(Date.parse(HELD_START));
    const source = createLiveSource({
        client: {
            ...createIzborClient({ port: 4319 }),
            getIzbor: (signal) =>
                new Promise<IzborAnswer>((answer) => {
                    calls.push("probe");
                    probes.push({ answer, signal });
                    if (says !== "held") answer(says);
                }),
            readStream: (id, on, leave) =>
                new Promise((end) => {
                    reads.push({ id, on, end });
                    leave.addEventListener("abort", () => end("left"), { once: true });
                }),
        },
        running: createRunningSessions({
            run: (signal) =>
                new Promise<string>((answer, reject) => {
                    calls.push("run");
                    const fail = (reason: string) => reject(new Error(reason));
                    runs.push({ answer, fail, signal });
                    if (signal.aborted) fail("aborted");
                    signal.addEventListener("abort", () => fail("aborted"));
                }),
            where: () => WHERE,
            now: clock.now,
        }),
        address: HELD_ADDRESS,
        wait: clock.wait,
        now: clock.now,
    });
    t.after(() => source.dispose());
    await settle();
    return {
        source,
        runs,
        probes,
        reads,
        calls,
        later: (ms: number) => clock.advance(ms),
        says: (answer: IzborAnswer | "held") => void (says = answer),
    };
}

const NOT_LOGGED_IN = "claude agents --json exited with code 3: Not logged in";

const statusOf = (list: SessionList) =>
    list.state === "listed" ? list.sessions.find(({ id }) => id === SESSION)?.status : undefined;

test("with nothing observed, the store runs claude agents at its start, then every 5 s from it, and never in between; each tick probes Izbor first", async (t) => {
    const { runs, calls, later } = await heldStore(t);
    assert.equal(runs.length, 1, "the first tick is the store's start");
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    for (const at of [5, 10, 15]) {
        await later(4_999);
        assert.equal(runs.length, at / 5, `no run just before ${at} s`);
        await later(1);
        assert.equal(runs.length, at / 5 + 1, `one run at ${at} s`);
        runs.at(-1)!.answer(agentsOutput({ status: "idle" }));
    }
    assert.deepEqual(calls.slice(0, 6), ["probe", "run", "probe", "run", "probe", "run"]);

    await later(5_000);
    assert.equal(runs.length, 5, "one run at 20 s");
    await later(2_000);
    runs[4]!.answer(agentsOutput({ status: "idle" }));
    await later(2_999);
    assert.equal(runs.length, 5, "no run just before 25 s");
    await later(1);
    assert.equal(runs.length, 6, "one run at 25 s, though the run before it ended at 22 s");
});

test("with a row and Izbor up, every tick runs the list and probes nothing; leaving the last row runs it at once; leaving one of two runs nothing", async (t) => {
    const { source, runs, calls, later } = await heldStore(t);
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    source.observe(SESSION);
    const observedAt = calls.length;
    for (const at of [5, 10, 15]) {
        await later(4_999);
        assert.equal(runs.length, at / 5, `no run just before ${at} s`);
        await later(1);
        assert.equal(runs.length, at / 5 + 1, `one run at ${at} s, with a row observed`);
        runs.at(-1)!.answer(agentsOutput({ status: "idle" }));
    }
    assert.deepEqual(
        calls.slice(observedAt),
        ["run", "run", "run"],
        "with a row and Izbor up, the ticks probe nothing",
    );

    await later(1_000);
    source.observe(OTHER_SESSION);
    source.leave(OTHER_SESSION);
    await settle();
    assert.equal(runs.length, 4, "a row is left, one is still observed: no run at once");

    source.leave(SESSION);
    assert.equal(runs.length, 5, "the last row is left: one run at once, though the list is 1 s old");
    runs[4]!.answer(agentsOutput({ status: "busy" }));
    await settle();
    const { list } = source.getSnapshot();
    assert.equal(statusOf(list), "busy", "the leave's list is in the snapshot");
    await later(3_999);
    assert.equal(runs.length, 5, "the ticks keep their own times: none before 20 s");
    await later(1);
    assert.equal(runs.length, 6, "one at 20 s");
});

test("a run in flight when a row is observed finishes, and its list goes in the snapshot", async (t) => {
    const { source, runs } = await heldStore(t);
    source.observe(SESSION);
    runs[0]!.answer(agentsOutput({ status: "busy" }));
    await settle();
    const { list } = source.getSnapshot();
    assert.equal(statusOf(list), "busy");
});

test("dispose during the wait: no run and no change, ever; dispose during a run aborts it, and nothing runs after it", async (t) => {
    const waiting = await heldStore(t);
    waiting.runs[0]!.answer(agentsOutput({ status: "idle" }));
    await waiting.later(1_000);
    let changes = 0;
    waiting.source.onChange(() => changes++);
    const before = waiting.source.getSnapshot();
    waiting.source.dispose();
    await waiting.later(20_000);
    assert.equal(waiting.runs.length, 1);
    assert.equal(changes, 0);
    assert.equal(waiting.source.getSnapshot(), before);

    const running = await heldStore(t);
    running.source.dispose();
    assert.equal(running.runs[0]!.signal.aborted, true, "the run's signal is aborted");
    await running.later(20_000);
    assert.equal(running.runs.length, 1, "the failed run starts no other");
});

test("a failed run says no list, with the sessions listed before, and carries no retry time; the next tick runs again and lists, with a row observed or none", async (t) => {
    for (const observed of [false, true]) {
        const label = observed ? "with a row" : "with no row";
        const { source, runs, later } = await heldStore(t);
        runs[0]!.answer(agentsOutput({ status: "idle" }));
        await settle();
        const listed = source.getSnapshot().list;
        assert.equal(listed.state, "listed", label);
        if (observed) source.observe(SESSION);

        await later(5_000);
        runs[1]!.fail(NOT_LOGGED_IN);
        await settle();
        assert.deepEqual(
            source.getSnapshot().list,
            { state: "no list", reason: NOT_LOGGED_IN, last: listedSessions(listed) },
            label,
        );

        await later(5_000);
        assert.equal(runs.length, 3, `the next tick runs again, ${label}`);
        runs[2]!.answer(agentsOutput({ status: "busy" }));
        await settle();
        assert.equal(source.getSnapshot().list.state, "listed", label);
    }
});

test("a Tab run that fails between ticks says no list; a Tab that shares a failed tick changes the snapshot once", async (t) => {
    const { source, runs, later } = await heldStore(t);
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    await later(5_000);
    runs[1]!.fail(NOT_LOGGED_IN);
    await later(2_000);

    const tab = source.refreshSessions();
    assert.equal(runs.length, 3, "Tab runs at 7 s");
    runs[2]!.fail(NOT_LOGGED_IN);
    const failed = await tab;
    assert.equal(failed.state, "no list");
    assert.equal(source.getSnapshot().list, failed);

    await later(3_000);
    assert.equal(runs.length, 4, "the tick at 10 s runs");
    let changes = 0;
    source.onChange(() => changes++);
    const shared = source.refreshSessions();
    runs[3]!.fail(NOT_LOGGED_IN);
    const list = await shared;
    assert.equal(list, source.getSnapshot().list, "Tab answers the snapshot's own list");
    assert.equal(list.state, "no list");
    assert.equal(changes, 1, "one change for the tick and the Tab");
});

test("refreshSessions shares the run in flight: one run for two calls", async (t) => {
    const { source, runs, later } = await heldStore(t);
    const atStart = source.refreshSessions();
    assert.equal(runs.length, 1, "it shares the run the store started with");
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    const first = await atStart;
    assert.equal(first.state, "listed");
    assert.equal(source.getSnapshot().list, first);

    await later(5_000);
    let changes = 0;
    source.onChange(() => changes++);
    const one = source.refreshSessions();
    const two = source.refreshSessions();
    assert.equal(runs.length, 2, "one run, for both calls");
    runs[1]!.answer(agentsOutput({ status: "busy" }));
    const second = await one;
    assert.equal(await two, second);
    assert.equal(statusOf(second), "busy");
    assert.equal(source.getSnapshot().list, second, "the new list is in the snapshot");
    assert.equal(changes, 1);
});

const stoppedEvent = (id: string, why: "deleted" | "izbor stopping") =>
    ({ type: "session", sessionId: id, state: "stopped", why }) as const;

test("a row's read finds Izbor away → exactly one getIzbor, and the header says what it answered", async (t) => {
    const info = {
        service: "izbor" as const,
        pid: 51234,
        port: 4319,
        dataDir: "/repo/.izbor",
        startedAt: HELD_START,
        sendKeyPath: "/home/me/.config/izbor/send-key-4319",
    };
    for (const [answer, state] of [
        [{ up: info }, "up"],
        [{ up: "older" }, "up"],
        [{ away: "not running" }, "not running"],
        [{ away: "stopping" }, "stopping"],
        [{ away: "not answering" }, "not answering"],
        [{ foreign: 'GET /izbor answered 200 OK, with no "service":"izbor"' }, "foreign"],
    ] as const) {
        const { source, probes, reads, says } = await heldStore(t);
        source.observe(SESSION);
        says(answer);
        reads[0]!.end({ away: "not running" });
        await settle();
        assert.equal(probes.length, 2, `${state}: the start's probe, then one`);
        assert.deepEqual(source.getSnapshot().izbor, { state, address: HELD_ADDRESS });
    }
});

test("a row's stopped with why izbor stopping → the header says stopping before any probe answers, then one probe", async (t) => {
    const { source, probes, reads, says, later } = await heldStore(t);
    source.observe(SESSION);
    reads[0]!.on.open();
    says("held");
    reads[0]!.on.event(stoppedEvent(SESSION, "izbor stopping"));
    assert.deepEqual(source.getSnapshot().izbor, { state: "stopping", address: HELD_ADDRESS });
    assert.equal(probes.length, 2, "the start's probe, then one, held");

    reads[0]!.end("ended");
    await later(5_000);
    assert.equal(probes.length, 2, "the stream's end starts none, and the tick shares the probe out");
    probes[1]!.answer({ away: "not running" });
    await settle();
    assert.deepEqual(source.getSnapshot().izbor, { state: "not running", address: HELD_ADDRESS });
});

test("a row's stream that ends or breaks with no stopped → one probe each; a failed claude agents run → none", async (t) => {
    const { source, probes, reads, runs } = await heldStore(t);
    runs[0]!.fail(NOT_LOGGED_IN);
    await settle();
    assert.equal(source.getSnapshot().list.state, "no list");
    assert.equal(probes.length, 1, "the start's probe only");

    source.observe(SESSION);
    source.observe(OTHER_SESSION);
    reads[0]!.end("ended");
    await settle();
    assert.equal(probes.length, 2);
    reads[1]!.end("broken");
    await settle();
    assert.equal(probes.length, 3);
    assert.equal(source.getSnapshot().izbor.state, "up");
});

test("while Izbor is not up, each tick probes once and runs no list; signs in between start none", async (t) => {
    const { source, probes, reads, runs, says, later } = await heldStore(t);
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    source.observe(SESSION);
    source.observe(OTHER_SESSION);
    says({ away: "not running" });
    reads[0]!.end("ended");
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "not running");
    assert.equal(probes.length, 2);

    reads[1]!.on.event(stoppedEvent(OTHER_SESSION, "izbor stopping"));
    reads[1]!.end("ended");
    await settle();
    assert.equal(probes.length, 2);
    assert.equal(source.getSnapshot().izbor.state, "not running", "only a probe changes a header that is not up");

    let ended = reads.length;
    for (const at of [5, 10, 15]) {
        await later(4_000);
        for (const read of reads.slice(ended)) read.end({ away: "not running" });
        ended = reads.length;
        await settle();
        assert.equal(probes.length, at / 5 + 1, `no probe between the ticks, before ${at} s`);
        await later(1_000);
        assert.equal(probes.length, at / 5 + 2, `one probe at ${at} s`);
    }
    assert.ok(reads.length > 2, "SESSION read again in between");
    assert.equal(runs.length, 1, "no list while Izbor is not up");
});

const STOPPED_SESSION = "5555eeee-0000-4000-8000-000000000000";
const REFUSED_SESSION = "7777dddd-0000-4000-8000-000000000000";

test("Izbor up again → Izbor is back once; disconnected and izbor away rows read at once; stopped and refused rows do not", async (t) => {
    const { source, runs, reads, says, later } = await heldStore(t);
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    const app = createTerminalController(sendingNothing(source), { ...NO_WRITES, columns: 80, rows: 24, changed() {} });
    t.after(() => app.dispose());
    const ids = [SESSION, OTHER_SESSION, STOPPED_SESSION, REFUSED_SESSION];
    for (const id of ids) source.observe(id);
    const readsOf = (id: string) => reads.filter((read) => read.id === id);

    await later(4_500);
    says({ away: "not running" });
    readsOf(SESSION)[0]!.end("ended");
    readsOf(OTHER_SESSION)[0]!.end({ away: "not running" });
    readsOf(STOPPED_SESSION)[0]!.on.event(stoppedEvent(STOPPED_SESSION, "deleted"));
    readsOf(STOPPED_SESSION)[0]!.end("ended");
    readsOf(REFUSED_SESSION)[0]!.end({ refused: 404, message: "Izbor has no address /stream" });
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "not running");
    const states = () => ids.map((id) => rowOf(source, id)?.connection.state);
    assert.deepEqual(states(), ["disconnected", "izbor away", "stopped", "refused"]);
    assert.equal(app.view.feedback, "");

    says(UP);
    await later(500);
    assert.equal(source.getSnapshot().izbor.state, "up");
    assert.equal(app.view.feedback, "Izbor is back");
    assert.equal(app.view.feedbackIsError, false);
    assert.deepEqual(
        ids.map((id) => readsOf(id).length),
        [2, 2, 1, 1],
        "the tick at 5 s, before the 5.5 s retries",
    );
    assert.deepEqual(states(), ["connecting", "connecting", "stopped", "refused"]);

    app.view.feedback = "";
    await later(10_000);
    assert.equal(app.view.feedback, "", "Izbor is back once");
    assert.deepEqual(
        ids.map((id) => readsOf(id).length),
        [2, 2, 1, 1],
        "the planned retries were run, not run again",
    );
});

test("a probe that began before Izbor's stopped never sets up after it: its answer is dropped, and one more probe runs", async (t) => {
    const { source, probes, reads, says } = await heldStore(t);
    const app = createTerminalController(sendingNothing(source), { ...NO_WRITES, columns: 80, rows: 24, changed() {} });
    t.after(() => app.dispose());
    source.observe(SESSION);
    source.observe(OTHER_SESSION);
    says("held");
    reads[0]!.end("ended");
    await settle();
    assert.equal(probes.length, 2);

    reads[1]!.on.event(stoppedEvent(OTHER_SESSION, "izbor stopping"));
    assert.equal(source.getSnapshot().izbor.state, "stopping");
    probes[1]!.answer(UP);
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "stopping", "the answer from before the stop is dropped");
    assert.equal(app.view.feedback, "");
    assert.equal(probes.length, 3, "one more probe when it ends");
    probes[2]!.answer({ away: "stopping" });
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "stopping");
    assert.equal(probes.length, 3);
});

test("a tick's probe out while Izbor is not up, then Izbor's stopped: its up is dropped, and one more probe runs", async (t) => {
    const { source, runs, probes, reads, says, later } = await heldStore(t);
    const app = createTerminalController(sendingNothing(source), { ...NO_WRITES, columns: 80, rows: 24, changed() {} });
    t.after(() => app.dispose());
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    source.observe(SESSION);
    source.observe(OTHER_SESSION);
    says({ away: "not running" });
    reads[0]!.end("ended");
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "not running");

    says("held");
    await later(5_000);
    assert.equal(probes.length, 3, "the tick at 5 s probes");
    reads[1]!.on.event(stoppedEvent(OTHER_SESSION, "izbor stopping"));
    assert.equal(source.getSnapshot().izbor.state, "not running", "a sign while not up changes no header");
    probes[2]!.answer(UP);
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "not running", "the answer from before the stop is dropped");
    assert.equal(app.view.feedback, "");
    assert.equal(probes.length, 4, "one more probe when it ends");
    probes[3]!.answer({ away: "stopping" });
    await settle();
    assert.equal(source.getSnapshot().izbor.state, "stopping");
});

test("dispose while a probe is held: it is aborted, its answer changes nothing, and no later tick probes", async (t) => {
    const { source, runs, probes, says, later } = await heldStore(t);
    runs[0]!.answer(agentsOutput({ status: "idle" }));
    says("held");
    await later(5_000);
    assert.equal(probes.length, 2, "the tick at 5 s probes");
    let changes = 0;
    source.onChange(() => changes++);
    const before = source.getSnapshot();

    source.dispose();
    assert.equal(probes[1]!.signal?.aborted, true);
    probes[1]!.answer({ away: "not running" });
    await settle();
    await later(20_000);
    assert.equal(source.getSnapshot(), before);
    assert.equal(changes, 0);
    assert.equal(probes.length, 2);
    assert.equal(runs.length, 1);
});

test("a refresh already waiting on discovery rejects when its source is disposed", async () => {
    let finish = (_list: SessionList) => {};
    const pending = new Promise<SessionList>((resolve) => (finish = resolve));
    const source = createLiveSource({
        client: {
            getIzbor: async () => ({ up: "older" }),
            readStream: async () => "left",
        },
        running: { refresh: () => pending, dispose() {} },
        address: "127.0.0.1:4319",
        wait: fakeClock().wait,
        now: () => new Date(),
    });
    const refresh = assert.rejects(source.refreshSessions(), { name: "AbortError" });
    source.dispose();
    await refresh;
    const before = source.getSnapshot();
    finish({ state: "listed", sessions: [], at: new Date().toISOString() });
    await settle();
    assert.equal(source.getSnapshot(), before);
});

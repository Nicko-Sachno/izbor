import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import type { BriefEvent, StreamEvent } from "../src/domain/streamEvent.js";
import { toTerminalBrief } from "../src/terminal/live/brief.js";
import { createObservation, type ReadStream } from "../src/terminal/live/observation.js";
import { createLiveSource } from "../src/terminal/live/source.js";
import type { Observation } from "../src/terminal/model.js";
import { fakeClock, settle, testClock } from "./support.js";

const ID = "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff";

const briefEvent = (task: string): BriefEvent => ({
    type: "brief",
    sessionId: ID,
    task: { text: task, at: "2026-10-01T11:59:00.000Z", from: "hook" },
    status: { state: "idle" },
    latestActivity: null,
    needsYou: { state: "nothing", at: "2026-10-01T11:59:00.000Z" },
    answerable: null,
    lastObserved: { at: "2026-10-01T11:59:00.000Z", from: "hook", lastHookAt: "2026-10-01T11:59:00.000Z" },
    explanation: { state: "unknown" },
});

const screenBrief = (event: BriefEvent) => toTerminalBrief(event);

const WATCHING: StreamEvent = { type: "session", sessionId: ID, state: "watching" };

type FakeStream = {
    id: string;
    leave: AbortSignal;
    open(): void;
    event(event: StreamEvent): void;
    end(how: Awaited<ReturnType<ReadStream>>): Promise<void>;
};

function fakeRead() {
    const streams: FakeStream[] = [];
    const read: ReadStream = (id, on, leave) =>
        new Promise((resolve) =>
            streams.push({
                id,
                leave,
                open: () => on.open(),
                event: (event) => on.event(event),
                async end(how) {
                    resolve(how);
                    await settle();
                },
            }),
        );
    return { read, streams };
}

const iso = testClock().iso;

function row() {
    const { read, streams } = fakeRead();
    const timers = fakeClock(Date.parse(iso("12:00:00")));
    const changes: Observation[] = [];
    const aways: unknown[] = [];
    const signals: AbortSignal[] = [];
    const observation = createObservation({
        id: ID,
        read,
        wait: (ms, signal) => (signals.push(signal), timers.wait(ms)),
        now: timers.now,
        changed: (row) => changes.push(row),
        away: (away) => aways.push(away),
    });
    const at = (hms: string) => timers.advance(Date.parse(iso(hms)) - timers.now().getTime());
    return { observation, streams, timers, at, changes, aways, signals };
}

function waitOf(observation: ReturnType<typeof createObservation>, timers: ReturnType<typeof fakeClock>) {
    const { connection } = observation.row();
    const retryAt = "retryAt" in connection ? connection.retryAt : undefined;
    return retryAt && Date.parse(retryAt) - timers.now().getTime();
}

test("a row goes connecting, then catching up on the head, then live with the first brief", () => {
    const { observation, streams, changes } = row();
    assert.deepEqual(observation.row(), { id: ID, brief: null, connection: { state: "connecting" } });
    assert.equal(streams.length, 1);
    assert.equal(streams[0]!.id, ID);

    streams[0]!.open();
    assert.deepEqual(observation.row(), { id: ID, brief: null, connection: { state: "catching up" } });
    streams[0]!.event(WATCHING);
    streams[0]!.event(briefEvent("Fix the retry bug"));
    assert.deepEqual(observation.row(), {
        id: ID,
        brief: screenBrief(briefEvent("Fix the retry bug")),
        since: iso("12:00:00"),
        connection: { state: "live" },
    });
    assert.deepEqual(
        changes.map(({ connection }) => connection.state),
        ["catching up", "live"],
    );
    assert.equal(changes.at(-1), observation.row());
});

function liveObservation(task = "Fix the retry bug") {
    const started = row();
    const [stream] = started.streams;
    stream!.open();
    stream!.event(WATCHING);
    stream!.event(briefEvent(task));
    return { ...started, stream: stream! };
}

test("each later brief replaces the last one", () => {
    const { observation, stream } = liveObservation();
    stream.event(briefEvent("Add CSV export"));
    assert.deepEqual(observation.row().brief, screenBrief(briefEvent("Add CSV export")));
});

test("stopped → the row is stopped with Izbor's reason and keeps its last brief; it never reads again by itself", async () => {
    for (const why of ["deleted", "izbor stopping"] as const) {
        const { observation, stream, streams, timers } = liveObservation();
        stream.event({ type: "session", sessionId: ID, state: "stopped", why });
        assert.deepEqual(observation.row(), {
            id: ID,
            brief: screenBrief(briefEvent("Fix the retry bug")),
            since: iso("12:00:00"),
            connection: { state: "stopped", why },
        });
        await stream.end("ended");
        assert.equal(timers.dueWithin(60_000), false, "no wait");
        await timers.advance(60_000);
        assert.deepEqual(observation.row().connection, { state: "stopped", why });
        assert.equal(streams.length, 1);
    }
});

test("stopped while catching up: the row is stopped with no brief", () => {
    const { observation, streams } = row();
    streams[0]!.open();
    streams[0]!.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    assert.deepEqual(observation.row(), { id: ID, brief: null, connection: { state: "stopped", why: "deleted" } });
});

test("an end with no stopped, or a broken read, is disconnected since then, with the last brief, for 1 s; then it reads again", async () => {
    for (const end of ["ended", "broken"] as const) {
        const { observation, stream, streams, timers, at } = liveObservation();
        const brief = screenBrief(briefEvent("Fix the retry bug"));
        await at("12:00:07");
        await stream.end(end);
        assert.deepEqual(observation.row(), {
            id: ID,
            brief,
            since: iso("12:00:00"),
            connection: { state: "disconnected", since: iso("12:00:07"), retryAt: iso("12:00:08") },
        });
        await timers.advance(999);
        assert.equal(streams.length, 1, `${end}: no read before 1 s`);
        await timers.advance(1);
        assert.deepEqual(
            observation.row(),
            { id: ID, brief, since: iso("12:00:00"), connection: { state: "connecting" } },
            end,
        );
        assert.equal(streams.length, 2, `${end}: one read at 1 s`);
    }
});

test("failures in a row wait 1 s, 2 s, 4 s, then 10 s each time, each retryAt to match", async () => {
    const { observation, stream, streams, timers } = liveObservation();
    await stream.end("broken");
    for (const [i, ms] of [1_000, 2_000, 4_000, 10_000, 10_000, 10_000].entries()) {
        assert.equal(waitOf(observation, timers), ms, `failure ${i + 1}`);
        await timers.advance(ms - 1);
        assert.equal(streams.length, i + 1, `no read before ${ms} ms`);
        await timers.advance(1);
        assert.equal(streams.length, i + 2, `one read at ${ms} ms`);
        await streams.at(-1)!.end(i % 2 ? "ended" : "broken");
    }
});

test("a retry that reaches live resets the ladder: the next drop waits 1 s; one that only catches up does not", async () => {
    const { observation, stream, streams, timers } = liveObservation();
    await stream.end("broken");
    await timers.advance(1_000);
    streams[1]!.open();
    streams[1]!.event(WATCHING);
    await streams[1]!.end("ended");
    assert.equal(waitOf(observation, timers), 2_000, "catching up, then the end: the next step");

    await timers.advance(2_000);
    streams[2]!.open();
    streams[2]!.event(WATCHING);
    streams[2]!.event(briefEvent("Add CSV export"));
    await streams[2]!.end("broken");
    assert.equal(waitOf(observation, timers), 1_000, "live, then the end: 1 s again");
});

test("Izbor away, on a first read and on a retry → izbor away with retryAt; the store hears each read; the retries go on", async () => {
    for (const reason of ["not running", "stopping"] as const) {
        const { observation, streams, aways, timers } = row();
        await streams[0]!.end({ away: reason });
        assert.deepEqual(observation.row(), {
            id: ID,
            brief: null,
            connection: { state: "izbor away", reason, retryAt: iso("12:00:01") },
        });
        assert.deepEqual(aways, [{ away: reason }]);

        await timers.advance(1_000);
        assert.deepEqual(observation.row(), { id: ID, brief: null, connection: { state: "connecting" } });
        await streams[1]!.end({ away: reason });
        assert.deepEqual(observation.row().connection, { state: "izbor away", reason, retryAt: iso("12:00:03") });
        assert.deepEqual(aways, [{ away: reason }, { away: reason }]);

        await timers.advance(2_000);
        assert.equal(streams.length, 3, reason);
    }
});

test("a refused read → refused, with the status and Izbor's message, after exactly one read: never retried", async () => {
    const message = "Izbor answers only requests addressed to 127.0.0.1 or localhost";
    for (const status of [400, 403, 404]) {
        const { observation, streams, timers } = row();
        await streams[0]!.end({ refused: status, message });
        assert.deepEqual(observation.row().connection, { state: "refused", status, message });
        assert.equal(timers.dueWithin(60_000), false, `${status}: no wait`);
        await timers.advance(60_000);
        assert.equal(streams.length, 1, `${status}: one read`);
    }
});

test("leave during a wait ends the wait; when its timer fires: no read, no changed call", async () => {
    const { observation, stream, streams, changes, timers, signals } = liveObservation();
    await stream.end("broken");
    const reported = changes.length;
    observation.leave();
    assert.equal(signals[0]!.aborted, true, "the wait's signal is aborted");
    await timers.advance(60_000);
    assert.equal(streams.length, 1);
    assert.equal(changes.length, reported);
});

test("retryNow or again during a wait reads once, at once; the old timer reads nothing, and the next failure waits the next step after retryNow, 1 s after again", async () => {
    const cases = [
        { call: "retryNow", end: "ended", next: 4_000, ladder: "the ladder kept its place" },
        { call: "again", end: "broken", next: 1_000, ladder: "the ladder starts over" },
    ] as const;
    for (const { call, end, next, ladder } of cases) {
        const { observation, stream, streams, timers, signals } = liveObservation();
        await stream.end("broken");
        await timers.advance(1_000);
        await streams[1]!.end("broken");
        assert.equal(waitOf(observation, timers), 2_000, call);

        observation[call]();
        assert.equal(streams.length, 3, `${call}: one read at once`);
        assert.equal(observation.row().connection.state, "connecting", call);
        assert.equal(signals[1]!.aborted, true, `${call}: the wait's signal is aborted`);
        await timers.advance(2_000);
        assert.equal(streams.length, 3, `${call}: the old timer reads nothing`);
        await streams[2]!.end(end);
        assert.equal(waitOf(observation, timers), next, `${call}: ${ladder}`);
    }
});

test("retryNow on a connecting, catching up, live, stopped or refused row does nothing", async () => {
    const connecting = row();
    const catchingUp = row();
    catchingUp.streams[0]!.open();
    const live = liveObservation();
    const stopped = liveObservation();
    stopped.stream.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    await stopped.stream.end("ended");
    const refused = row();
    await refused.streams[0]!.end({ refused: 404, message: "Not found" });

    for (const [name, { observation, streams, changes }] of Object.entries({
        connecting,
        catchingUp,
        live,
        stopped,
        refused,
    })) {
        const before = { row: observation.row(), reads: streams.length, changes: changes.length };
        observation.retryNow();
        assert.deepEqual({ row: observation.row(), reads: streams.length, changes: changes.length }, before, name);
    }
});

test("the gap runs from the first drop to the first brief after it, through failed retries; since stays the first drop; a drop under 30 s with Izbor up writes none; a brief that changes the Status drops the gap", async () => {
    const { observation, stream, streams, at } = liveObservation();
    await at("12:00:07");
    await stream.end("broken");
    await at("12:00:08");
    await streams[1]!.end({ away: "not running" });
    assert.ok(!("gap" in observation.row()), "no gap while it is open");
    await at("12:00:10");
    await streams[2]!.end("broken");
    assert.deepEqual(observation.row().connection, {
        state: "disconnected",
        since: iso("12:00:07"),
        retryAt: iso("12:00:14"),
    });

    await at("12:00:14");
    streams[3]!.open();
    streams[3]!.event(WATCHING);
    await at("12:00:31");
    streams[3]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(observation.row(), {
        id: ID,
        brief: screenBrief(briefEvent("Add CSV export")),
        since: iso("12:00:31"),
        connection: { state: "live" },
        gap: { from: iso("12:00:07"), to: iso("12:00:31") },
    });

    streams[3]!.event(briefEvent("Fix the retry bug"));
    assert.deepEqual(observation.row().gap, { from: iso("12:00:07"), to: iso("12:00:31") });
    await at("12:01:00");
    await streams[3]!.end("ended");
    assert.deepEqual(observation.row().connection, {
        state: "disconnected",
        since: iso("12:01:00"),
        retryAt: iso("12:01:01"),
    });
    await at("12:01:01");
    streams[4]!.open();
    await at("12:01:05");
    streams[4]!.event(briefEvent("Fix the retry bug"));
    assert.deepEqual(
        observation.row().gap,
        { from: iso("12:00:07"), to: iso("12:00:31") },
        "a drop under 30 s with Izbor up writes no gap; the earlier one stays",
    );
    streams[4]!.event({ ...briefEvent("Fix the retry bug"), status: { state: "busy" } });
    assert.ok(!("gap" in observation.row()), "a brief that changes the Status drops the gap");
});

test("a first read that finds Izbor away opens no gap: no stream ended", async () => {
    const { observation, streams, timers } = row();
    await streams[0]!.end({ away: "not running" });
    await timers.advance(1_000);
    streams[1]!.open();
    streams[1]!.event(briefEvent("Fix the retry bug"));
    assert.ok(!("gap" in observation.row()), JSON.stringify(observation.row()));
});

test("stopped keeps the gap open from the drop; Izbor's own stop means it was away, so the brief after again shows it however short", async () => {
    const { observation, stream, streams, at } = liveObservation();
    await at("12:00:07");
    await stream.end("broken");
    await at("12:00:08");
    streams[1]!.open();
    streams[1]!.event({ type: "session", sessionId: ID, state: "stopped", why: "izbor stopping" });
    await streams[1]!.end("ended");
    await at("12:00:09");
    observation.again();
    streams[2]!.open();
    streams[2]!.event(WATCHING);
    await at("12:00:12");
    streams[2]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(observation.row().connection, { state: "live" });
    assert.deepEqual(observation.row().gap, { from: iso("12:00:07"), to: iso("12:00:12") });
});

test("a deleted stop opens the gap at the stop: the brief after again shows it past 30 s and not before", async () => {
    const short = liveObservation();
    await short.at("12:00:07");
    short.stream.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    await short.stream.end("ended");
    short.observation.again();
    short.streams[1]!.open();
    await short.at("12:00:17");
    short.streams[1]!.event(briefEvent("Add CSV export"));
    assert.ok(!("gap" in short.observation.row()), "10 s after a deleted stop with Izbor up: no gap");

    const long = liveObservation();
    await long.at("12:00:07");
    long.stream.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    await long.stream.end("ended");
    long.observation.again();
    long.streams[1]!.open();
    await long.at("12:00:40");
    long.streams[1]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(long.observation.row().gap, { from: iso("12:00:07"), to: iso("12:00:40") });
});

test("again keeps a closed gap, and the brief after again that changes the Status drops it; an open one stays open, and the brief after again closes it", async () => {
    const closed = liveObservation();
    await closed.stream.end("broken");
    await closed.timers.advance(1_000);
    await closed.at("12:00:40");
    closed.streams[1]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(
        closed.observation.row().gap,
        { from: iso("12:00:00"), to: iso("12:00:40") },
        "the brief closed the gap",
    );
    closed.streams[1]!.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    closed.observation.again();
    assert.deepEqual(closed.observation.row().gap, { from: iso("12:00:00"), to: iso("12:00:40") }, "again keeps it");
    closed.streams[2]!.open();
    closed.streams[2]!.event({ ...briefEvent("Add CSV export"), status: { state: "busy" } });
    assert.ok(!("gap" in closed.observation.row()), "the brief that changes the Status drops it");

    const open = liveObservation();
    await open.at("12:00:07");
    await open.stream.end("broken");
    open.observation.again();
    await open.at("12:00:40");
    open.streams[1]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(open.observation.row().gap, { from: iso("12:00:07"), to: iso("12:00:40") });
});

test("leave aborts the stream; its late head, events and end change nothing", async () => {
    const { observation, streams, changes, timers } = row();
    const [stream] = streams;
    observation.leave();
    assert.equal(stream!.leave.aborted, true);
    stream!.open();
    stream!.event(WATCHING);
    stream!.event(briefEvent("Fix the retry bug"));
    stream!.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    await stream!.end("ended");
    await timers.advance(60_000);
    assert.deepEqual(changes, []);
    assert.equal(streams.length, 1);
});

test("a read that sends a stream event after its leave signal fired → no changed call", () => {
    const { observation, stream, changes } = liveObservation();
    const before = changes.length;
    stream.leave.addEventListener("abort", () => stream.event(briefEvent("Too late")));
    observation.leave();
    stream.event(briefEvent("Later still"));
    assert.equal(changes.length, before);
});

test("again reconnects a stopped row in place: connecting with its last brief, reported before again returns, then catching up, then live", () => {
    const { observation, stream, streams, changes } = liveObservation();
    stream.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    observation.again();
    assert.equal(changes.at(-1), observation.row(), "the connecting row is reported before again returns");
    assert.deepEqual(observation.row(), {
        id: ID,
        brief: screenBrief(briefEvent("Fix the retry bug")),
        connection: { state: "connecting" },
    });
    assert.equal(streams.length, 2);
    streams[1]!.open();
    assert.equal(observation.row().connection.state, "catching up");
    streams[1]!.event(WATCHING);
    streams[1]!.event(briefEvent("Add CSV export"));
    assert.deepEqual(observation.row().connection, { state: "live" });
    assert.deepEqual(observation.row().brief, screenBrief(briefEvent("Add CSV export")));
});

test("each new stream gets the next generation: the old stream's late events and end do not touch the row", async () => {
    const { observation, stream: first, streams } = liveObservation();
    await first.end("broken");
    observation.again();
    assert.equal(first.leave.aborted, true, "the old stream is closed");
    const second = streams[1]!;
    second.open();
    first.event(briefEvent("From the old stream"));
    first.event({ type: "session", sessionId: ID, state: "stopped", why: "deleted" });
    await first.end("ended");
    assert.deepEqual(observation.row(), {
        id: ID,
        brief: screenBrief(briefEvent("Fix the retry bug")),
        connection: { state: "catching up" },
    });
});

test("leave, then observe the same id again: the old stream's late events and end do not touch the new row", async () => {
    const { read, streams } = fakeRead();
    const source = createLiveSource({
        client: {
            ...createIzborClient({ port: 1 }),
            getIzbor: async () => ({ up: "older" as const }),
            readStream: read,
        },
        running: { refresh: () => new Promise(() => {}), dispose() {} },
        address: "127.0.0.1:1",
        wait: fakeClock().wait,
        now: testClock().now,
    });
    source.observe(ID);
    const [old] = streams;
    old!.open();
    source.leave(ID);
    assert.equal(source.observe(ID), "added");
    const fresh = source.getSnapshot().observations;
    old!.event(WATCHING);
    old!.event(briefEvent("From the old stream"));
    await old!.end("broken");
    assert.equal(source.getSnapshot().observations, fresh);
    assert.deepEqual(fresh, [{ id: ID, brief: null, connection: { state: "connecting" } }]);
    source.dispose();
});

test("an observation is pure: no import of the Izbor client, no real timer, no real clock", async () => {
    const source = await readFile(new URL("../src/terminal/live/observation.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*adapters\//);
    assert.doesNotMatch(source, /\b(setTimeout|setInterval|setImmediate)\b/);
    assert.doesNotMatch(source, /\bDate\.now\b|\bnew Date\s*\(\s*\)|\bnew Date\b(?!\s*\()/);
});

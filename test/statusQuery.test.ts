import { test } from "node:test";
import assert from "node:assert/strict";
import type { ListedSession } from "../src/core/ports.js";
import { createStatusQuery, type StatusAnswer } from "../src/core/statusQuery.js";
import { fakeClock, settle, testClock } from "./support.js";

function heldRuns() {
    const runs: { signal: AbortSignal; answer: (sessions: ListedSession[]) => void; fail: (err: Error) => void }[] = [];
    return {
        runs,
        queryStatus: (signal: AbortSignal) =>
            new Promise<ListedSession[]>((answer, fail) => runs.push({ signal, answer, fail })),
    };
}

const listing = (sessionId: string): ListedSession[] => [{ sessionId, status: "idle" }];

function sharedQuery() {
    const agents = heldRuns();
    const timer = fakeClock();
    const clock = testClock();
    const statusQuery = createStatusQuery({
        queryStatus: agents.queryStatus,
        wait: timer.wait,
        now: clock.now,
    });
    const watch = () => {
        const answers: StatusAnswer[] = [];
        const unsubscribe = statusQuery.subscribe((answer) => answers.push(answer));
        return { answers, unsubscribe };
    };
    return { ...agents, timer, clock, statusQuery, watch };
}

test("a query runs claude agents once, and every watch subscribed gets its answer with when it was asked and answered", async () => {
    const { runs, clock, statusQuery, watch } = sharedQuery();
    const a = watch();
    const b = watch();

    clock.at("12:00:01");
    void statusQuery.query();
    clock.at("12:00:02");
    runs[0]!.answer([]);
    await settle();

    assert.equal(runs.length, 1);
    const answer = { askedAt: clock.iso("12:00:01"), at: clock.iso("12:00:02"), sessions: [] };
    assert.deepEqual(a.answers, [answer]);
    assert.deepEqual(b.answers, [answer]);
});

test("queries during a run start no second run: they share exactly one more run after it", async () => {
    const { runs, statusQuery, watch } = sharedQuery();
    const a = watch();
    void statusQuery.query();
    for (let i = 0; i < 3; i++) void statusQuery.query();
    await settle();
    assert.equal(runs.length, 1);

    runs[0]!.answer(listing("1"));
    await settle();
    assert.equal(runs.length, 2);
    runs[1]!.answer(listing("2"));
    await settle();

    assert.equal(runs.length, 2);
    assert.deepEqual(
        a.answers.map((answer) => "sessions" in answer && answer.sessions),
        [listing("1"), listing("2")],
    );
});

test("a query during a run resolves only once the run after it has answered, whose askedAt is that run's own start", async () => {
    const { runs, clock, statusQuery, watch } = sharedQuery();
    const a = watch();
    const resolved: string[] = [];
    clock.at("12:00:01");
    void statusQuery.query().then(() => resolved.push("first"));
    clock.at("12:00:02");
    void statusQuery.query().then(() => resolved.push("during the run"));

    clock.at("12:00:03");
    runs[0]!.answer(listing("1"));
    await settle();
    assert.deepEqual(resolved, ["first"]);

    clock.at("12:00:04");
    runs[1]!.answer(listing("2"));
    await settle();
    assert.deepEqual(resolved, ["first", "during the run"]);
    assert.deepEqual(a.answers[1], {
        askedAt: clock.iso("12:00:03"),
        at: clock.iso("12:00:04"),
        sessions: listing("2"),
    });
});

test("a run that fails answers every watch with its error, and the query resolves", async () => {
    const { runs, clock, statusQuery, watch } = sharedQuery();
    const a = watch();
    let resolved = false;
    void statusQuery.query().then(() => (resolved = true));

    runs[0]!.fail(new Error("claude agents --json gave no answer in 5000 ms"));
    await settle();

    assert.equal(resolved, true);
    assert.deepEqual(a.answers, [
        {
            askedAt: clock.iso("12:00:00"),
            at: clock.iso("12:00:00"),
            error: "Error: claude agents --json gave no answer in 5000 ms",
        },
    ]);
});

test("while a watch subscribes, the next timed run starts 2 s after a run ends", async () => {
    const { runs, timer, statusQuery, watch } = sharedQuery();
    watch();
    void statusQuery.query();
    runs[0]!.answer([]);
    await settle();

    await timer.advance(1999);
    assert.equal(runs.length, 1);
    await timer.advance(1);
    assert.equal(runs.length, 2);

    await timer.advance(500);
    runs[1]!.answer([]);
    await settle();
    await timer.advance(1999);
    assert.equal(runs.length, 2);
    await timer.advance(1);
    assert.equal(runs.length, 3);
});

test("with no watch subscribed there are no timed runs, only queries", async () => {
    const { runs, timer, statusQuery, watch } = sharedQuery();
    void statusQuery.query();
    runs[0]!.answer([]);
    await settle();
    await timer.advance(10_000);
    assert.equal(runs.length, 1);

    const a = watch();
    void statusQuery.query();
    runs[1]!.answer([]);
    await settle();
    a.unsubscribe();
    await timer.advance(10_000);
    assert.equal(runs.length, 2);
});

test("a query while a timed run is due runs at once; the timed run due meanwhile starts no second run", async () => {
    const { runs, timer, statusQuery, watch } = sharedQuery();
    watch();
    void statusQuery.query();
    runs[0]!.answer([]);
    await settle();

    await timer.advance(1000);
    void statusQuery.query();
    assert.equal(runs.length, 2);
    assert.equal(timer.dueWithin(2000), false);
    await timer.advance(1000);
    assert.equal(runs.length, 2);

    runs[1]!.answer([]);
    await settle();
    await timer.advance(1999);
    assert.equal(runs.length, 2);
    await timer.advance(1);
    assert.equal(runs.length, 3);
});

test("stop cancels the run in flight, resolves once its process has ended, gives no answer for it and runs no more", async () => {
    const { runs, timer, statusQuery, watch } = sharedQuery();
    const a = watch();
    void statusQuery.query();
    let waitingResolved = false;
    void statusQuery.query().then(() => (waitingResolved = true));

    let stopped = false;
    const stopping = statusQuery.stop().then(() => (stopped = true));
    await settle();
    assert.equal(runs[0]!.signal.aborted, true);
    assert.equal(stopped, false);

    runs[0]!.fail(new Error("killed"));
    await stopping;
    assert.equal(waitingResolved, true);
    assert.deepEqual(a.answers, []);

    await statusQuery.query();
    await timer.advance(10_000);
    assert.equal(runs.length, 1);
});

test("after stop the timed run that was due makes no run, however long the clock runs", async () => {
    const { runs, timer, statusQuery, watch } = sharedQuery();
    const a = watch();
    void statusQuery.query();
    runs[0]!.answer([]);
    await settle();

    assert.equal(timer.dueWithin(2000), true);
    await statusQuery.stop();
    assert.equal(timer.dueWithin(2000), false);
    await timer.advance(10_000);

    assert.equal(runs.length, 1);
    assert.equal(a.answers.length, 1);
});

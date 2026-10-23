import { test } from "node:test";
import assert from "node:assert/strict";
import { createWatchTracker } from "../src/core/watchTracker.js";
import { UNKNOWN_BRIEF } from "../src/domain/brief.js";
import type { StopWhy } from "../src/domain/records.js";
import { type StreamEvent, toBriefEvent } from "../src/domain/streamEvent.js";
import { fakeClock, listener, settle } from "./support.js";

const ID = "9b6dd6e1-4c57-4733-89cf-d0c7226a5cbc";
const OTHER = "73205487-0000-4000-8000-000000000000";

function fakeWatch(sessionId: string, emit: (event: StreamEvent) => void) {
    let finish!: () => void;
    let fail!: (err: Error) => void;
    const started = new Promise<void>((resolve, reject) => ([finish, fail] = [resolve, reject]));
    let endStop!: () => void;
    let failStop!: (err: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => ([endStop, failStop] = [resolve, reject]));
    const watch = {
        sessionId,
        finish,
        fail,
        act: (what: string) => emit({ type: "action", sessionId, at: "2026-10-04T12:00:05.123Z", what }),
        start: () => started,
        snapshot: (): [StreamEvent, StreamEvent] => [
            { type: "session", sessionId, state: "watching" },
            toBriefEvent(sessionId, UNKNOWN_BRIEF, null),
        ],
        stoppedWith: undefined as StopWhy | undefined,
        endStop,
        failStop,
        stop: (why: StopWhy) => {
            watch.stoppedWith = why;
            return stopped;
        },
    };
    return watch;
}

function tracker() {
    const clock = fakeClock();
    const made: ReturnType<typeof fakeWatch>[] = [];
    const errors: unknown[] = [];
    const watchTracker = createWatchTracker({
        createWatch: (sessionId, emit) => {
            const watch = fakeWatch(sessionId, emit);
            made.push(watch);
            return watch;
        },
        wait: clock.wait,
        onError: (error) => errors.push(error),
    });
    async function watching(sessionId = ID) {
        const a = listener();
        watchTracker.tuneIn(sessionId, a);
        made.at(-1)!.finish();
        await settle();
        return a;
    }
    async function stopping() {
        (await watching()).leave();
        await clock.advance(30_000);
        const waits = listener();
        watchTracker.tuneIn(ID, waits);
        return waits;
    }
    return { ...watchTracker, clock, made, errors, watching, stopping };
}

function short(event: StreamEvent): string {
    if (event.type === "session")
        return event.state === "stopped" ? `session stopped (${event.why})` : `session ${event.state}`;
    return event.type === "action" ? `action ${event.what}` : event.type;
}

const got = (l: ReturnType<typeof listener>) => [...l.events.map(short), ...(l.ended ? ["end"] : [])];

const gotAll = (l: ReturnType<typeof listener>) => [
    ...l.events.map((event) => [event.sessionId, short(event)]),
    ...(l.ended ? ["end"] : []),
];

test("a listener gets the session event, then the brief, then every live stream event, and nothing from the catch-up", async () => {
    const { tuneIn, made } = tracker();
    const a = listener();

    tuneIn(ID, a);
    const watch = made[0]!;
    watch.act("read src/router.ts");
    assert.deepEqual(got(a), []);

    watch.finish();
    await settle();
    watch.act("started Bash: npm test");

    assert.deepEqual(got(a), ["session watching", "brief", "action started Bash: npm test"]);
});

test("a listener joining a live watch gets its snapshot inside tuneIn, then shares every stream event with the first", async () => {
    const { tuneIn, made, watching } = tracker();
    const a = await watching();

    const b = listener();
    tuneIn(ID, b);
    assert.deepEqual(got(b), ["session watching", "brief"]);
    made[0]!.act("started Bash: npm test");

    assert.equal(made.length, 1);
    assert.deepEqual(got(a), ["session watching", "brief", "action started Bash: npm test"]);
    assert.deepEqual(got(b), got(a));
});

test("two listeners tuning in during the catch-up share one watch and both get its snapshot", async () => {
    const { tuneIn, made } = tracker();
    const a = listener();
    const b = listener();
    tuneIn(ID, a);
    tuneIn(ID, b);

    made[0]!.finish();
    await settle();

    assert.equal(made.length, 1);
    assert.deepEqual(got(a), ["session watching", "brief"]);
    assert.deepEqual(got(b), ["session watching", "brief"]);
});

test("a watch whose catch-up hangs counts as caught up at 5 s", async () => {
    const { tuneIn, made, clock } = tracker();
    const a = listener();
    tuneIn(ID, a);

    await clock.advance(4999);
    assert.deepEqual(got(a), []);
    await clock.advance(1);
    assert.deepEqual(got(a), ["session watching", "brief"]);

    made[0]!.finish();
    await settle();
    made[0]!.act("started Bash: npm test");
    assert.deepEqual(got(a), ["session watching", "brief", "action started Bash: npm test"]);
});

test("a watch whose catch-up rejects reaches onError once, and its listener still gets the snapshot", async () => {
    const { tuneIn, made, errors } = tracker();
    const a = listener();
    tuneIn(ID, a);
    const unreadable = new Error("transcript unreadable");

    made[0]!.fail(unreadable);
    await settle();

    assert.deepEqual(errors, [unreadable]);
    assert.deepEqual(got(a), ["session watching", "brief"]);
});

test("a watch whose stop rejects reaches onError once, and a new watch of the id still starts", async () => {
    const { tuneIn, stop, made, errors, watching } = tracker();
    const a = await watching();
    stop(ID);
    const b = listener();
    tuneIn(ID, b);
    assert.equal(made.length, 1);
    const unwritten = new Error("hook file unwritable");

    made[0]!.failStop(unwritten);
    await settle();

    assert.deepEqual(errors, [unwritten]);
    assert.equal(made.length, 2);
    made[1]!.finish();
    await settle();
    assert.deepEqual(got(a), ["session watching", "brief", "session stopped (deleted)", "end"]);
    assert.deepEqual(got(b), ["session watching", "brief"]);
});

test("list, watchOf and watches show a watch from its watch start on, list with its number of listeners", async () => {
    const { tuneIn, list, watchOf, watches, made } = tracker();
    tuneIn(ID, listener());
    tuneIn(ID, listener());
    tuneIn(OTHER, listener());
    made[0]!.finish();
    await settle();

    assert.deepEqual(list(), [
        { sessionId: ID, listeners: 2 },
        { sessionId: OTHER, listeners: 1 },
    ]);
    assert.equal(watchOf(ID), made[0]);
    assert.equal(watchOf(OTHER), made[1]);
    assert.deepEqual(watches(), [made[0], made[1]]);
    assert.equal(watchOf("00000000-0000-4000-8000-000000000000"), undefined);
});

test("a listener that has left gets nothing more and is no longer counted", async () => {
    const { tuneIn, list, made } = tracker();
    const a = listener();
    const b = listener();
    const early = listener();
    tuneIn(ID, a);
    tuneIn(ID, b);
    tuneIn(ID, early);
    early.leave();
    await settle();
    made[0]!.finish();
    await settle();

    b.leave();
    await settle();
    made[0]!.act("started Bash: npm test");

    assert.deepEqual(got(early), []);
    assert.deepEqual(got(b), ["session watching", "brief"]);
    assert.deepEqual(got(a), ["session watching", "brief", "action started Bash: npm test"]);
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 1 }]);
});

test("stopAll ends every stream with `stopped`, stops every watch with its why, and is done once each stop is; what a stopping watch emits is dropped", async () => {
    const { tuneIn, stopAll, list, watchOf, made } = tracker();
    const a = listener();
    const b = listener();
    tuneIn(ID, a);
    tuneIn(OTHER, b);
    made[0]!.finish();
    made[1]!.finish();
    await settle();

    let stopped = false;
    const all = stopAll("izbor stopping");
    void all.done.then(() => (stopped = true));
    made[0]!.act("finished Bash: npm test");

    assert.deepEqual(all.stopped, [ID, OTHER]);
    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        ["izbor stopping", "izbor stopping"],
    );
    assert.deepEqual(list(), []);
    assert.equal(watchOf(ID), undefined);
    const ended = ["session watching", "brief", "session stopped (izbor stopping)", "end"];
    assert.deepEqual(got(a), ended);
    assert.deepEqual(got(b), ended);
    made[0]!.endStop();
    await settle();
    assert.equal(stopped, false);
    made[1]!.endStop();
    await all.done;
});

test("stopAll with none watched stops nothing; after it, a tune-in starts a new watch", async () => {
    const { tuneIn, stopAll, made } = tracker();
    const none = stopAll("deleted");
    assert.deepEqual(none.stopped, []);
    await none.done;

    const a = listener();
    tuneIn(ID, a);
    const deleted = stopAll("deleted");
    assert.deepEqual(deleted.stopped, [ID]);
    const b = listener();
    tuneIn(ID, b);
    made[0]!.endStop();
    await settle();
    made[1]!.finish();
    await settle();

    assert.deepEqual(got(a), ["session stopped (deleted)", "end"]);
    assert.deepEqual(got(b), ["session watching", "brief"]);
});

test("a watch stopped during its catch-up sends no snapshot when the catch-up ends", async () => {
    const { tuneIn, stopAll, made } = tracker();
    const a = listener();
    tuneIn(ID, a);

    const { done } = stopAll("izbor stopping");
    made[0]!.finish();
    made[0]!.endStop();
    await done;
    await settle();

    assert.deepEqual(got(a), ["session stopped (izbor stopping)", "end"]);
});

test("the last listener leaving stops the watch with `no listener` 30 s later; until then list shows it with no listener", async () => {
    const { tuneIn, list, watchOf, made, clock } = tracker();
    const a = listener();
    const b = listener();
    tuneIn(ID, a);
    tuneIn(ID, b);
    made[0]!.finish();
    await settle();

    a.leave();
    await clock.advance(60_000);
    assert.equal(made[0]!.stoppedWith, undefined);

    b.leave();
    await clock.advance(29_999);
    assert.equal(made[0]!.stoppedWith, undefined);
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 0 }]);

    await clock.advance(1);
    assert.equal(made[0]!.stoppedWith, "no listener");
    assert.deepEqual(list(), []);
    assert.equal(watchOf(ID), undefined);
});

test("a listener tuning in within 30 s cancels the stop and gets the snapshot at once", async () => {
    const { tuneIn, list, made, clock, watching } = tracker();
    const a = await watching();
    a.leave();
    await clock.advance(10_000);

    const b = listener();
    tuneIn(ID, b);
    assert.deepEqual(got(b), ["session watching", "brief"]);

    await clock.advance(60_000);
    assert.equal(made[0]!.stoppedWith, undefined);
    assert.equal(made.length, 1);
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 1 }]);
});

test("an old timer that fires after a new listener joined does nothing: the stop comes 30 s after the latest leave", async () => {
    const { tuneIn, made, clock, watching } = tracker();
    const a = await watching();
    a.leave();
    await clock.advance(10_000);
    const b = listener();
    tuneIn(ID, b);
    await clock.advance(10_000);
    b.leave();

    await clock.advance(29_999);
    assert.equal(made[0]!.stoppedWith, undefined);
    await clock.advance(1);
    assert.equal(made[0]!.stoppedWith, "no listener");
});

test("a tune-in during a stop waits for it, and everyone who joins meanwhile shares one new watch", async () => {
    const { tuneIn, list, watchOf, watches, made, clock, watching } = tracker();
    const a = await watching();
    a.leave();
    await clock.advance(30_000);
    assert.equal(made[0]!.stoppedWith, "no listener");

    const b = listener();
    const c = listener();
    tuneIn(ID, b);
    tuneIn(ID, c);
    await settle();
    assert.equal(made.length, 1);
    assert.deepEqual(list(), []);
    assert.equal(watchOf(ID), undefined);
    assert.deepEqual(watches(), []);

    made[0]!.endStop();
    await settle();
    assert.equal(made.length, 2);
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 2 }]);
    made[1]!.finish();
    await settle();
    made[1]!.act("started Bash: npm test");

    assert.deepEqual(got(b), ["session watching", "brief", "action started Bash: npm test"]);
    assert.deepEqual(got(c), got(b));
    assert.deepEqual(got(a), ["session watching", "brief"]);
});

test("stopAll during a stop is done once that stop is, and stops the id that waits for it, which never gets a watch", async () => {
    const { stopAll, list, made, stopping } = tracker();
    const b = await stopping();

    let stopped = false;
    const all = stopAll("izbor stopping");
    void all.done.then(() => (stopped = true));
    await settle();
    assert.equal(stopped, false);
    assert.deepEqual(all.stopped, [ID]);

    made[0]!.endStop();
    await all.done;
    await settle();
    assert.equal(made.length, 1);
    assert.equal(made[0]!.stoppedWith, "no listener");
    assert.deepEqual(list(), []);
    assert.deepEqual(got(b), ["session stopped (izbor stopping)", "end"]);
});

test("stop of an id that waits for its old watch's stop ends its streams, and it never gets a watch", async () => {
    const { stop, made, stopping } = tracker();
    const b = await stopping();

    assert.equal(stop(ID), true);
    made[0]!.endStop();
    await settle();

    assert.equal(made.length, 1);
    assert.deepEqual(got(b), ["session stopped (deleted)", "end"]);
    assert.equal(stop(ID), false);
});

test("a tune-in during a stop on a delete waits for it, then starts a new watch", async () => {
    const { tuneIn, stop, list, made, watching } = tracker();
    await watching();
    stop(ID);

    const b = listener();
    tuneIn(ID, b);
    await settle();
    assert.equal(made.length, 1);
    assert.deepEqual(list(), []);

    made[0]!.endStop();
    await settle();
    made[1]!.finish();
    await settle();
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 1 }]);
    assert.deepEqual(got(b), ["session watching", "brief"]);
});

test("the watch of an id whose listeners all left while it waited stops 30 s after they left", async () => {
    const { made, clock, stopping } = tracker();
    const b = await stopping();
    b.leave();
    await settle();

    made[0]!.endStop();
    await settle();
    made[1]!.finish();
    await clock.advance(29_999);
    assert.equal(made[1]!.stoppedWith, undefined);
    await clock.advance(1);
    assert.equal(made[1]!.stoppedWith, "no listener");
});

test("stop ends the streams of one id with `stopped` (`deleted`) and stops its watch; another id's stream keeps going", async () => {
    const { tuneIn, stop, list, watchOf, made } = tracker();
    const a = listener();
    const b = listener();
    const c = listener();
    tuneIn(ID, a);
    tuneIn(ID, b);
    tuneIn(OTHER, c);
    made[0]!.finish();
    made[1]!.finish();
    await settle();

    assert.equal(stop(ID), true);
    made[0]!.act("finished Bash: npm test");
    made[1]!.act("started Bash: npm test");
    await settle();

    const stopped = ["session watching", "brief", "session stopped (deleted)", "end"];
    assert.deepEqual(got(a), stopped);
    assert.deepEqual(got(b), stopped);
    assert.deepEqual(got(c), ["session watching", "brief", "action started Bash: npm test"]);
    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        ["deleted", undefined],
    );
    assert.deepEqual(list(), [{ sessionId: OTHER, listeners: 1 }]);
    assert.equal(watchOf(ID), undefined);
    assert.equal(stop(ID), false);
});

test("close ends every stream with `stopped` (`izbor stopping`) but keeps every watch for the hooks still arriving", async () => {
    const { tuneIn, close, closing, watchOf, made } = tracker();
    const a = listener();
    const b = listener();
    tuneIn(ID, a);
    tuneIn(OTHER, b);
    made[0]!.finish();
    await settle();
    assert.equal(closing(), false);

    close();
    made[0]!.act("finished Bash: npm test");
    await settle();

    assert.equal(closing(), true);
    assert.deepEqual(got(a), ["session watching", "brief", "session stopped (izbor stopping)", "end"]);
    assert.deepEqual(got(b), ["session stopped (izbor stopping)", "end"]);
    assert.equal(watchOf(ID), made[0]);
    assert.equal(watchOf(OTHER), made[1]);
    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        [undefined, undefined],
    );
});

test("after close, a tune-in gets `stopped` (`izbor stopping`) and ends at once, and starts nothing", async () => {
    const { tuneIn, close, list, made } = tracker();
    close();

    const late = listener();
    tuneIn(ID, late);
    await settle();

    assert.deepEqual(got(late), ["session stopped (izbor stopping)", "end"]);
    assert.equal(made.length, 0);
    assert.deepEqual(list(), []);
});

test("close cancels the 30 s timers, and an id that waits never gets its watch; stopAll then stops each watch once", async () => {
    const { tuneIn, close, stopAll, made, clock } = tracker();
    const waits = "00000000-0000-4000-8000-000000000002";
    const a = listener();
    tuneIn(ID, a);
    tuneIn(OTHER, listener());
    const w = listener();
    tuneIn(waits, w);
    made[0]!.finish();
    made[1]!.finish();
    made[2]!.finish();
    await settle();
    w.leave();
    await clock.advance(30_000);
    const again = listener();
    tuneIn(waits, again);
    a.leave();
    await clock.advance(10_000);

    close();
    await clock.advance(60_000);
    made[2]!.endStop();
    await settle();

    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        [undefined, undefined, "no listener"],
    );
    assert.equal(made.length, 3);
    assert.deepEqual(got(again), ["session stopped (izbor stopping)", "end"]);

    const all = stopAll("izbor stopping");
    assert.deepEqual(all.stopped, [ID, OTHER, waits]);
    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        ["izbor stopping", "izbor stopping", "no listener"],
    );
    made[0]!.endStop();
    made[1]!.endStop();
    await all.done;
    assert.deepEqual(got(again), ["session stopped (izbor stopping)", "end"]);
});

test("after close, however long the clock runs, no watch stops and no stream gets an event", async () => {
    const { tuneIn, tuneInAll, close, made, clock, watching } = tracker();
    const a = await watching();
    a.leave();
    const b = listener();
    tuneIn(OTHER, b);
    const all = listener();
    tuneInAll(all);
    await settle();

    assert.equal(clock.dueWithin(30_000), true);
    close();
    assert.equal(clock.dueWithin(30_000), false);
    const atClose = [got(a), got(b), gotAll(all)];
    await clock.advance(60_000);

    assert.deepEqual([got(a), got(b), gotAll(all)], atClose);
    assert.deepEqual(
        made.map((watch) => watch.stoppedWith),
        [undefined, undefined],
    );
});

test("no timer of the tracker outlives its use: not the 5 s of a caught-up watch, not the 30 s after a tune-in, neither after a watch stop", async () => {
    const { tuneIn, stop, made, clock } = tracker();
    const a = listener();
    tuneIn(ID, a);
    assert.equal(clock.dueWithin(5000), true);
    made[0]!.finish();
    await settle();
    assert.equal(clock.dueWithin(30_000), false);

    a.leave();
    await settle();
    assert.equal(clock.dueWithin(30_000), true);
    tuneIn(ID, listener());
    assert.equal(clock.dueWithin(30_000), false);

    const b = listener();
    tuneIn(OTHER, b);
    b.leave();
    await settle();
    assert.equal(clock.dueWithin(5000), true);
    stop(OTHER);
    assert.equal(clock.dueWithin(30_000), false);
});

test("a stream of every session gets the snapshot of each caught-up watch when it connects and when a watch catches up, then every stream event of every watch", async () => {
    const { tuneIn, tuneInAll, made, watching } = tracker();
    await watching(ID);
    tuneIn(OTHER, listener());

    const all = listener();
    tuneInAll(all);
    assert.deepEqual(gotAll(all), [
        [ID, "session watching"],
        [ID, "brief"],
    ]);
    made[1]!.act("read src/router.ts");
    made[1]!.finish();
    await settle();
    made[0]!.act("started Bash: npm test");
    made[1]!.act("finished Bash: npm test");

    assert.deepEqual(gotAll(all), [
        [ID, "session watching"],
        [ID, "brief"],
        [OTHER, "session watching"],
        [OTHER, "brief"],
        [ID, "action started Bash: npm test"],
        [OTHER, "action finished Bash: npm test"],
    ]);
});

test("a stream of every session alone starts no watch and keeps none alive: at 30 s it gets `stopped` (`no listener`) and stays open", async () => {
    const { tuneInAll, list, made, clock, watching } = tracker();
    const all = listener();
    tuneInAll(all);
    await settle();
    assert.equal(made.length, 0);
    assert.deepEqual(list(), []);

    const a = await watching();
    a.leave();
    await clock.advance(30_000);

    assert.equal(made[0]!.stoppedWith, "no listener");
    assert.deepEqual(gotAll(all), [
        [ID, "session watching"],
        [ID, "brief"],
        [ID, "session stopped (no listener)"],
    ]);
});

test("a stream of every session gets `stopped` (`deleted`) for a deleted watch, stays open and gets nothing the stopping watch emits; an id it got no snapshot of sends no `stopped`", async () => {
    const { tuneIn, tuneInAll, stop, made, watching } = tracker();
    const all = listener();
    tuneInAll(all);
    await watching();
    tuneIn(OTHER, listener());

    assert.equal(stop(ID), true);
    made[0]!.act("finished Bash: npm test");
    tuneIn(ID, listener());
    assert.equal(stop(ID), true);
    assert.equal(stop(OTHER), true);
    made[1]!.finish();
    made[0]!.endStop();
    await settle();

    assert.deepEqual(gotAll(all), [
        [ID, "session watching"],
        [ID, "brief"],
        [ID, "session stopped (deleted)"],
    ]);
});

test("close sends a stream of every session `stopped` (`izbor stopping`) for each live watch and ends it; what comes after sends it nothing, and a late one ends at once", async () => {
    const { tuneIn, tuneInAll, close, stopAll, made, watching } = tracker();
    await watching();
    tuneIn(OTHER, listener());
    const all = listener();
    tuneInAll(all);

    close();
    made[0]!.act("finished Bash: npm test");
    made[1]!.finish();
    await settle();
    made[1]!.act("started Bash: npm test");
    const late = listener();
    tuneInAll(late);
    stopAll("izbor stopping");

    assert.deepEqual(gotAll(all), [
        [ID, "session watching"],
        [ID, "brief"],
        [ID, "session stopped (izbor stopping)"],
        "end",
    ]);
    assert.deepEqual(gotAll(late), ["end"]);
});

test("a stream of every session that has left gets nothing more, and is not a listener of any watch", async () => {
    const { tuneInAll, list, made, watching } = tracker();
    const all = listener();
    tuneInAll(all);
    all.leave();
    await settle();

    await watching();
    made[0]!.act("started Bash: npm test");

    assert.deepEqual(gotAll(all), []);
    assert.deepEqual(list(), [{ sessionId: ID, listeners: 1 }]);
});

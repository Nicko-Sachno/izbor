import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummaryTurns, type SummaryTurns } from "../src/core/summaryTurns.js";
import { settle } from "./support.js";

function takeFor(turns: SummaryTurns, name: string, got: string[], signal = new AbortController().signal) {
    return turns.take(signal).then((endTurn) => {
        if (endTurn) got.push(name);
        return endTurn;
    });
}

test("turns are given in the order of the take calls, the next one once the turn before has ended", async () => {
    const turns = createSummaryTurns();
    const got: string[] = [];
    const a = takeFor(turns, "a", got);
    const b = takeFor(turns, "b", got);
    const c = takeFor(turns, "c", got);
    await settle();
    assert.deepEqual(got, ["a"]);

    (await a)!();
    await settle();
    assert.deepEqual(got, ["a", "b"]);

    (await b)!();
    await settle();
    assert.deepEqual(got, ["a", "b", "c"]);
    (await c)!();
});

test("a watch whose signal aborts while it waits gets null, and its place goes to the next watch", async () => {
    const turns = createSummaryTurns();
    const got: string[] = [];
    const leaving = new AbortController();
    const a = takeFor(turns, "a", got);
    const b = takeFor(turns, "b", got, leaving.signal);
    const c = takeFor(turns, "c", got);
    await settle();

    leaving.abort();
    assert.equal(await b, null);
    assert.deepEqual(got, ["a"]);

    (await a)!();
    await settle();
    assert.deepEqual(got, ["a", "c"]);

    (await c)!();
    await takeFor(turns, "d", got);
    assert.deepEqual(got, ["a", "c", "d"]);
});

test("ending a turn twice does nothing: the turn after it is not ended too", async () => {
    const turns = createSummaryTurns();
    const got: string[] = [];
    const a = takeFor(turns, "a", got);
    const b = takeFor(turns, "b", got);
    void takeFor(turns, "c", got);
    const endA = (await a)!;

    endA();
    endA();
    await settle();
    assert.deepEqual(got, ["a", "b"]);

    (await b)!();
    await settle();
    assert.deepEqual(got, ["a", "b", "c"]);
});

test("a watch whose signal has aborted already gets null, even while the turn is free", async () => {
    const turns = createSummaryTurns();
    const got: string[] = [];
    assert.equal(await takeFor(turns, "a", got, AbortSignal.abort()), null);
    await takeFor(turns, "b", got);
    assert.deepEqual(got, ["b"]);
});

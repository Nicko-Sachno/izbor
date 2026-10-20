import { test } from "node:test";
import assert from "node:assert/strict";
import { blinking, blinkShown, relativeTime, settling } from "../src/terminal/presentation.js";
import { waitStart } from "../src/terminal/model.js";
import { createSampleWorld, SAMPLE_IDS } from "./helpers/sampleSessions.js";

const at = "2026-10-09T12:00:00.000Z";
const now = (ms: number) => new Date(Date.parse(at) + ms);

test("a fresh wait's ! is drawn in the even seconds of its five and hidden in the odd ones", () => {
    for (const ms of [0, 999, 2000, 2999, 4000, 4999]) assert.equal(blinkShown(at, now(ms)), true, `${ms} ms`);
    for (const ms of [1000, 1999, 3000, 3999]) assert.equal(blinkShown(at, now(ms)), false, `${ms} ms`);
});

test("from the fifth second on it is drawn and still", () => {
    for (const ms of [5000, 5001, 3_600_000]) {
        assert.equal(blinkShown(at, now(ms)), true, `${ms} ms`);
        assert.equal(blinking(at, now(ms)), false, `${ms} ms`);
    }
    for (const ms of [0, 4999]) assert.equal(blinking(at, now(ms)), true, `${ms} ms`);
});

test("a wait with no time, a time that is no time, or a time ahead of the frame is drawn and never blinks", () => {
    const cases: [string | undefined, Date][] = [
        [undefined, now(0)],
        ["time unknown", now(0)],
        [at, now(-1)],
    ];
    for (const [since, when] of cases) {
        assert.equal(blinkShown(since, when), true, String(since));
        assert.equal(blinking(since, when), false, String(since));
    }
});

test("a relative time counts whole seconds, minutes, hours and days back; a time over a second ahead says so, and no time says unknown", () => {
    const cases: [number, string][] = [
        [59_000, "59s ago"],
        [60_000, "1m ago"],
        [3_599_000, "59m ago"],
        [3_600_000, "1h ago"],
        [2 * 3_600_000, "2h ago"],
        [3 * 86_400_000, "3d ago"],
        [-500, "0s ago"],
        [-60_000, "timestamp ahead"],
    ];
    for (const [ms, shown] of cases) assert.equal(relativeTime(at, now(ms)), shown, `${ms} ms`);
    assert.equal(relativeTime("not a time", now(0)), "time unknown");
});

test("the clock still ticks in the second after the blink, so the last draw is the still one", () => {
    for (const ms of [0, 4999, 5000, 5999]) assert.equal(settling(at, now(ms)), true, `${ms} ms`);
    for (const ms of [6000, -1]) assert.equal(settling(at, now(ms)), false, `${ms} ms`);
    assert.equal(settling(undefined, now(0)), false);
});

test("waitStart is the request's time only while the Brief waits and Needs you holds a request", () => {
    const waiting = createSampleWorld("overview").row(SAMPLE_IDS[1]).brief!;
    assert.equal(waiting.needsYou.state, "request");
    const requestAt = waiting.needsYou.state === "request" ? waiting.needsYou.at : undefined;
    assert.ok(requestAt);
    assert.equal(waitStart(waiting), requestAt);
    assert.equal(waitStart({ ...waiting, status: "busy" }), undefined, "an answer sent: the request stays");
    assert.equal(
        waitStart({ ...waiting, needsYou: { state: "unknown", at: requestAt, waitingFor: "permission prompt" } }),
        undefined,
        "the watch's time, not a request's",
    );
    assert.equal(
        waitStart({
            ...waiting,
            needsYou: { state: "request", text: "Permission to run tests", detail: "Bash: npm test" },
        }),
        undefined,
        "a request with no time",
    );
    assert.equal(waitStart(null), undefined);
    assert.equal(waitStart(undefined), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { QUIET_TITLE, rings, windowTitle } from "../src/terminal/alerts.js";
import { createSampleSource, createSampleWorld, SAMPLE_IDS } from "./helpers/sampleSessions.js";
import { writeAlerts } from "../src/terminal/main.js";
import type { Observation, IzborState, Snapshot } from "../src/terminal/model.js";

const world = createSampleWorld();
const [BUSY, WAITING, IDLE] = SAMPLE_IDS.map((id) => world.row(id));
const UP: IzborState = { state: "up", address: "127.0.0.1:4319" };

test("the title is izbor while no observed session waits, Izbor · needs you while one does, with no number", () => {
    assert.equal(QUIET_TITLE, "izbor");
    assert.equal(windowTitle({ izbor: UP, observations: [] }), "izbor");
    assert.equal(windowTitle({ izbor: UP, observations: [BUSY!, IDLE!] }), "izbor");
    assert.equal(windowTitle({ izbor: UP, observations: [BUSY!, WAITING!, IDLE!] }), "Izbor · needs you");
    const second: Observation = { ...WAITING!, id: "second" };
    assert.equal(windowTitle({ izbor: UP, observations: [WAITING!, second] }), "Izbor · needs you", "no count");
    assert.equal(windowTitle({ izbor: UP, observations: [WAITING!] }), "Izbor · needs you");
    const away: Observation = { ...WAITING!, connection: { state: "disconnected", since: "2026-10-09T12:00:00.000Z" } };
    assert.equal(windowTitle({ izbor: UP, observations: [away] }), "Izbor · needs you", "its last known Brief waits");
});

test("while the top line shows Izbor in trouble the title is Izbor · not running, whatever waits", () => {
    for (const state of ["stopping", "not running", "not answering", "foreign"] as const)
        assert.equal(
            windowTitle({ izbor: { state, address: "127.0.0.1:4319" }, observations: [WAITING!] }),
            "Izbor · not running",
            state,
        );
});

test("the title reads the observed rows only: a session that waits on Home's list and is not observed leaves izbor", () => {
    assert.equal(world.list.state, "listed");
    const listed = world.list.state === "listed" ? world.list.sessions : [];
    assert.ok(
        listed.some(({ status }) => status === "waiting"),
        "the sample list holds a waiting session",
    );
    const snapshot: Snapshot = { izbor: UP, list: world.list, observations: [] };
    assert.equal(windowTitle(snapshot), "izbor");
});

test("the title is written at once, then only when it changes, and izbor when the writer ends; nothing after", (t) => {
    const source = createSampleSource({ scenario: "overview", animate: false });
    t.after(() => source.dispose());
    const written: string[] = [];
    const exits = process.listenerCount("exit");
    const reset = writeAlerts(source, { write: (text: string) => written.push(text) });
    assert.equal(process.listenerCount("exit"), exits + 1, "the process's exit resets it too");
    source.observe(SAMPLE_IDS[0]);
    source.observe(SAMPLE_IDS[1]);
    source.observe(SAMPLE_IDS[2]);
    source.leave(SAMPLE_IDS[1]);
    reset();
    assert.equal(process.listenerCount("exit"), exits);
    source.observe(SAMPLE_IDS[1]);
    const osc = (title: string) => `\x1b]0;${title}\x07`;
    assert.deepEqual(written, [osc("izbor"), osc("Izbor · needs you"), osc("izbor"), osc("izbor")]);
});

test("the bell rings for an observed session's new wait that began while its stream was open, once, and never for an older one", () => {
    const fresh = createSampleWorld("fresh-wait").row(SAMPLE_IDS[2]);
    const idle = { ...fresh, brief: createSampleWorld().row(SAMPLE_IDS[2]).brief };
    const later = new Date(Date.parse(fresh.since!) + 1000).toISOString();
    const { since: _since, ...unopened } = fresh;
    const unknown: Observation = {
        ...fresh,
        brief: { ...fresh.brief!, needsYou: { state: "unknown", waitingFor: "permission prompt", at: fresh.since! } },
    };
    assert.equal(rings([idle], [fresh]), true, "a new wait, asked the moment the scene opened its stream");
    assert.equal(rings([fresh], [fresh]), false, "not again while the same wait stays");
    assert.equal(rings([idle], [unknown]), true, "an Unknown wait Izbor dated rings too");
    assert.equal(rings([idle], [{ ...fresh, since: later }]), false, "a wait from before the stream opened");
    assert.equal(rings([idle], [unopened]), false, "a row with no since never rings");
    assert.equal(rings([], [createSampleWorld().row(SAMPLE_IDS[1])]), false, "a sample's wait, older than the window");
});

test("the bell rings once more when an answer sent from Izbor is first found not taken, on a live row only", () => {
    const taken = createSampleWorld("answer-not-taken").row(SAMPLE_IDS[2]);
    const { stillWaits: _stillWaits, ...pending } = taken.sent!;
    const before = { ...taken, sent: pending };
    assert.equal(rings([before], [taken]), true, "found not taken");
    assert.equal(rings([taken], [taken]), false, "not again while it still waits");
    const notLive: Observation = { ...taken, connection: { state: "disconnected", since: taken.since! } };
    assert.equal(rings([before], [notLive]), false, "not while a ▲ notice keeps its line off the Brief");
    assert.equal(rings([before], [before]), false, "an answer not yet found not taken");
});

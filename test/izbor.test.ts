import { test } from "node:test";
import assert from "node:assert/strict";
import type { BriefEvent } from "../src/domain/streamEvent.js";
import { heldSummarizer, lingeringSummarizer } from "./helpers/fakeSummarizers.js";
import {
    eventMarker,
    fakeClock,
    hook,
    listener,
    OTHER_SESSION,
    prompt,
    RECEIVED_AT,
    SESSION,
    setupIzbor,
    until,
} from "./support.js";

const AT = RECEIVED_AT.toISOString();

async function izborRecords(izbor: Awaited<ReturnType<typeof setupIzbor>>, sessionId: string) {
    return (await izbor.readHookFile(sessionId)).filter((r) => r.kind === "izbor").map((r) => [r.event, r.why]);
}

test("tuning in starts the watch: the session event and the caught-up brief, then an action and a brief for a hook", async () => {
    const izbor = await setupIzbor({
        transcripts: { [SESSION]: [prompt("fix the login redirect", "2026-10-01T11:58:00.000Z")] },
        session: { status: "busy" },
    });

    const listener = izbor.tuneIn(SESSION);
    await listener.caughtUp();

    const [session, brief] = listener.events;
    assert.deepEqual(session, { type: "session", sessionId: SESSION, state: "watching" });
    assert.ok(brief?.type === "brief");
    assert.equal(brief.task?.text, "fix the login redirect");
    assert.deepEqual(brief.status, { state: "busy" });

    void izbor.handleHook(
        hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1" }),
    );

    const [action, next] = listener.events.slice(2);
    assert.deepEqual(action, { type: "action", sessionId: SESSION, at: AT, what: "started Bash: npm test" });
    assert.ok(next?.type === "brief");
    assert.deepEqual(next.latestActivity, { what: "started Bash: npm test", at: AT });
    assert.equal(listener.events.length, 4);
});

test("an id Claude Code does not list streams the session event `not listed`", async () => {
    const izbor = await setupIzbor();
    const unlisted = "sess-0000-0000";

    const listener = izbor.tuneIn(unlisted);
    await listener.caughtUp();

    const [session, brief] = listener.events;
    assert.deepEqual(session, { type: "session", sessionId: unlisted, state: "not listed" });
    assert.ok(brief?.type === "brief");
    assert.deepEqual(brief.status, { state: "not listed" });
});

test("hooks of a session nobody watches change no file and start no watch", async () => {
    const izbor = await setupIzbor();

    await izbor.handleHook(eventMarker());
    assert.deepEqual(await izbor.files(), []);

    const listener = izbor.tuneIn(SESSION);
    await listener.caughtUp();
    await izbor.handleHook({ ...eventMarker(), session_id: OTHER_SESSION });

    assert.deepEqual(
        (await izbor.files()).filter((file) => file.startsWith(OTHER_SESSION)),
        [],
    );
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: SESSION, listeners: 1 }]);
});

test("a hook whose session id is in upper case goes to the watch of that id, and its records say the id in lower case", async () => {
    const izbor = await setupIzbor();
    const listener = izbor.tuneIn(SESSION);
    await listener.caughtUp();
    const upperCase = { ...eventMarker(), session_id: SESSION.toUpperCase() };

    void izbor.handleHook(upperCase);
    await until(async () => (await izbor.readSessionFile(SESSION)).some((r) => r.kind === "event"));

    const hookRecord = (await izbor.readHookFile(SESSION)).find((r) => r.kind === "hook");
    assert.equal(hookRecord?.sessionId, SESSION);
    assert.deepEqual(hookRecord?.payload, upperCase);
    const eventRecord = (await izbor.readSessionFile(SESSION)).find((r) => r.kind === "event");
    assert.equal(eventRecord?.sessionId, SESSION);
});

test("a Izbor stop stops every watch: each hook file ends with `stopped`, why `izbor stopping`", async () => {
    const izbor = await setupIzbor();
    const listeners = [izbor.tuneIn(SESSION), izbor.tuneIn(OTHER_SESSION)];
    await Promise.all(listeners.map((listener) => listener.caughtUp()));

    await izbor.stop();

    for (const sessionId of [SESSION, OTHER_SESSION]) {
        const last = (await izbor.readHookFile(sessionId)).at(-1);
        assert.deepEqual([last?.event, last?.why], ["stopped", "izbor stopping"], sessionId);
    }
});

test("a rejected payload goes to the hook file of every watched session, with one error line", async () => {
    const izbor = await setupIzbor();
    const listeners = [izbor.tuneIn(SESSION), izbor.tuneIn(OTHER_SESSION)];
    await Promise.all(listeners.map((listener) => listener.caughtUp()));

    await izbor.handleRejected("not json");

    for (const sessionId of [SESSION, OTHER_SESSION]) {
        const rejected = (await izbor.readHookFile(sessionId)).filter((r) => r.event === "rejected_payload");
        assert.deepEqual(
            rejected.map((r) => r.body),
            ["not json"],
            sessionId,
        );
    }
    assert.deepEqual(izbor.errors(), ["izbor error: answered 400 to a payload without a session id: not json"]);
});

test("after the last listener leaves, the session is listed at 25 s and not at 35 s; then a hook of it grows no file", async () => {
    const clock = fakeClock();
    const izbor = await setupIzbor({ wait: clock.wait });
    const listener = izbor.tuneIn(SESSION);
    await listener.caughtUp();

    listener.leave();
    await clock.advance(25_000);
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: SESSION, listeners: 0 }]);
    await clock.advance(10_000);
    assert.deepEqual(izbor.tracker.list(), []);

    const stopped = async () => (await izbor.readHookFile(SESSION)).at(-1)?.why === "no listener";
    await until(stopped);
    const files = async () => [await izbor.readHookFile(SESSION), await izbor.readSessionFile(SESSION)];
    const before = await files();
    await izbor.handleHook(eventMarker());
    assert.deepEqual(await files(), before);
});

test("tuning in again 10 s after the last listener left gives the brief at once, and the watch never stopped", async () => {
    const clock = fakeClock();
    const izbor = await setupIzbor({ wait: clock.wait });
    const first = izbor.tuneIn(SESSION);
    await first.caughtUp();
    first.leave();
    await clock.advance(10_000);

    const again = izbor.tuneIn(SESSION);
    assert.deepEqual(
        again.events.map((event) => event.type),
        ["session", "brief"],
    );

    await clock.advance(60_000);
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: SESSION, listeners: 1 }]);
    assert.deepEqual(await izborRecords(izbor, SESSION), [["started", undefined]]);
});

test("a tune-in during a watch stop waits for it: the hook file holds one watch, then the next", async () => {
    const clock = fakeClock();
    const summarizer = lingeringSummarizer();
    const izbor = await setupIzbor({ wait: clock.wait, summarize: summarizer.summarize });
    const first = izbor.tuneIn(SESSION);
    await first.caughtUp();
    void izbor.handleHook(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    await clock.advance(5000);
    first.leave();
    await clock.advance(30_000);
    assert.equal(summarizer.signal()?.aborted, true);

    const again = izbor.tuneIn(SESSION);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await izborRecords(izbor, SESSION), [["started", undefined]]);
    assert.deepEqual(izbor.tracker.list(), []);

    summarizer.processGone();
    await again.caughtUp();
    assert.deepEqual(await izborRecords(izbor, SESSION), [
        ["started", undefined],
        ["stopped", "no listener"],
        ["started", undefined],
    ]);
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: SESSION, listeners: 1 }]);
});

test("a delete ends that session's stream with `stopped` (`deleted`), cancels its summary request and frees the summary turn for the other", async () => {
    const clock = fakeClock();
    const summarizer = heldSummarizer();
    const izbor = await setupIzbor({ wait: clock.wait, summarize: summarizer.summarize });
    const a = izbor.tuneIn(SESSION);
    const b = izbor.tuneIn(OTHER_SESSION);
    await Promise.all([a.caughtUp(), b.caughtUp()]);
    void izbor.handleHook(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    void izbor.handleHook({
        ...hook("UserPromptSubmit", { prompt: "update the changelog" }),
        session_id: OTHER_SESSION,
    });
    await clock.advance(5000);
    assert.equal(summarizer.requests.length, 1);
    assert.match(summarizer.requests[0]!.request.input, /^Task:\nfix the login redirect\n/);

    assert.equal(izbor.tracker.stop(SESSION), true);

    assert.deepEqual(a.events.at(-1), { type: "session", sessionId: SESSION, state: "stopped", why: "deleted" });
    assert.equal(a.ended, true);
    assert.equal(summarizer.requests[0]!.signal.aborted, true);
    await until(() => summarizer.requests.length === 2);
    assert.match(summarizer.requests[1]!.request.input, /^Task:\nupdate the changelog\n/);
    await until(async () => (await izborRecords(izbor, SESSION)).at(-1)?.[1] === "deleted");
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: OTHER_SESSION, listeners: 1 }]);
    assert.equal(b.ended, false);
    assert.ok(!b.events.some((event) => event.type === "session" && event.state === "stopped"));
});

test("a delete of every watch ends every stream with `stopped` (`deleted`), and Izbor keeps running; `/events` stays open", async () => {
    const izbor = await setupIzbor();
    const a = izbor.tuneIn(SESSION);
    const b = izbor.tuneIn(OTHER_SESSION);
    const all = izbor.tuneInAll();
    await Promise.all([a.caughtUp(), b.caughtUp(), all.caughtUp(2)]);

    const { stopped, done } = izbor.tracker.stopAll("deleted");

    assert.deepEqual(stopped, [SESSION, OTHER_SESSION]);
    for (const [listener, sessionId] of [
        [a, SESSION],
        [b, OTHER_SESSION],
    ] as const) {
        assert.deepEqual(listener.events.at(-1), { type: "session", sessionId, state: "stopped", why: "deleted" });
        assert.equal(listener.ended, true, sessionId);
    }
    assert.deepEqual(all.events.slice(4), [
        { type: "session", sessionId: SESSION, state: "stopped", why: "deleted" },
        { type: "session", sessionId: OTHER_SESSION, state: "stopped", why: "deleted" },
    ]);
    await done;
    for (const sessionId of [SESSION, OTHER_SESSION]) {
        assert.deepEqual((await izborRecords(izbor, sessionId)).at(-1), ["stopped", "deleted"], sessionId);
    }
    assert.deepEqual(izbor.tracker.list(), []);

    const again = izbor.tuneIn(SESSION);
    await Promise.all([again.caughtUp(), all.caughtUp(4)]);
    assert.deepEqual(izbor.tracker.list(), [{ sessionId: SESSION, listeners: 1 }]);
    assert.deepEqual(all.events.slice(6), again.events);
    assert.equal(all.ended, false);
});

const bashHook = (sessionId: string, command: string, tool_use_id: string) => ({
    ...hook("PreToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id }),
    session_id: sessionId,
});

const actions = (stream: ReturnType<typeof listener>) =>
    stream.events.flatMap((event) => (event.type === "action" ? [[event.sessionId, event.what]] : []));

const briefOf = (stream: ReturnType<typeof listener>, sessionId: string) =>
    stream.events.findLast((event): event is BriefEvent => event.type === "brief" && event.sessionId === sessionId);

test("two sessions tuned in, plus `/events`: it gets everything the listeners of both get, each with its own session id", async () => {
    const izbor = await setupIzbor();
    const all = izbor.tuneInAll();
    const a = izbor.tuneIn(SESSION);
    const b = izbor.tuneIn(OTHER_SESSION);
    await Promise.all([a.caughtUp(), b.caughtUp(), all.caughtUp(2)]);

    void izbor.handleHook(bashHook(SESSION, "npm test", "t1"));
    void izbor.handleHook(bashHook(OTHER_SESSION, "npm run lint", "t2"));

    assert.deepEqual(actions(all), [
        [SESSION, "started Bash: npm test"],
        [OTHER_SESSION, "started Bash: npm run lint"],
    ]);
    assert.deepEqual(
        all.events.filter((event) => event.sessionId === SESSION),
        a.events,
    );
    assert.deepEqual(
        all.events.filter((event) => event.sessionId === OTHER_SESSION),
        b.events,
    );
});

test("session A asks for permission while B works: A's brief shows the request, and B keeps streaming", async () => {
    const izbor = await setupIzbor();
    const a = izbor.tuneIn(SESSION);
    const b = izbor.tuneIn(OTHER_SESSION);
    const all = izbor.tuneInAll();
    await Promise.all([a.caughtUp(), b.caughtUp(), all.caughtUp(2)]);

    void izbor.handleHook(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    void izbor.handleHook(bashHook(OTHER_SESSION, "npm test", "t1"));
    void izbor.handleHook(bashHook(OTHER_SESSION, "npm run lint", "t2"));

    const request = { state: "request", at: AT, agentId: null, tool: "Bash", input: { command: "rm -rf build" } };
    for (const stream of [a, all]) assert.deepEqual(briefOf(stream, SESSION)?.needsYou, request);
    assert.deepEqual(actions(b), [
        [OTHER_SESSION, "started Bash: npm test"],
        [OTHER_SESSION, "started Bash: npm run lint"],
    ]);
    assert.deepEqual(actions(all), [
        [SESSION, "asked permission for Bash: rm -rf build"],
        [OTHER_SESSION, "started Bash: npm test"],
        [OTHER_SESSION, "started Bash: npm run lint"],
    ]);
});

test("`/events` alone starts no watch; after the last listener left, it gets `stopped` (`no listener`) at 30 s and stays open", async () => {
    const clock = fakeClock();
    const izbor = await setupIzbor({ wait: clock.wait });
    const all = izbor.tuneInAll();
    await clock.advance(60_000);
    assert.deepEqual(await izbor.files(), []);
    assert.deepEqual(izbor.tracker.list(), []);

    const listener = izbor.tuneIn(SESSION);
    await Promise.all([listener.caughtUp(), all.caughtUp(1)]);
    listener.leave();
    await clock.advance(30_000);

    assert.deepEqual(all.events.at(-1), { type: "session", sessionId: SESSION, state: "stopped", why: "no listener" });
    assert.equal(all.ended, false);
    assert.deepEqual(izbor.tracker.list(), []);
    await until(async () => (await izborRecords(izbor, SESSION)).at(-1)?.[1] === "no listener");
});

test("a Izbor stop ends `/events` after `stopped` (`izbor stopping`) for each watch; hooks still arriving send it nothing", async () => {
    const izbor = await setupIzbor();
    const a = izbor.tuneIn(SESSION);
    const b = izbor.tuneIn(OTHER_SESSION);
    const all = izbor.tuneInAll();
    await Promise.all([a.caughtUp(), b.caughtUp(), all.caughtUp(2)]);

    izbor.tracker.close();
    void izbor.handleHook(bashHook(SESSION, "npm test", "t1"));
    await izbor.stop();

    assert.deepEqual(all.events.slice(4), [
        { type: "session", sessionId: SESSION, state: "stopped", why: "izbor stopping" },
        { type: "session", sessionId: OTHER_SESSION, state: "stopped", why: "izbor stopping" },
    ]);
    assert.equal(all.ended, true);
    assert.deepEqual((await izborRecords(izbor, SESSION)).at(-1), ["stopped", "izbor stopping"]);
});

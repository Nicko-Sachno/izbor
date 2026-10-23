import { test } from "node:test";
import assert from "node:assert/strict";
import { type Brief, UNKNOWN_BRIEF } from "../src/domain/brief.js";
import type { Status } from "../src/domain/records.js";
import { sessionStateAfter, toBriefEvent } from "../src/domain/streamEvent.js";
import {
    dated,
    eventMarker,
    fakeAgents,
    fakeClock,
    hook,
    msg,
    prompt,
    RECEIVED_AT,
    SESSION,
    setup,
    testClock,
    until,
} from "./support.js";

const AT = RECEIVED_AT.toISOString();

const beforeTheWatch = () => [
    prompt("fix the login redirect", "2026-10-01T11:58:00.000Z"),
    dated(
        msg("assistant", [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "src/router.ts" } }]),
        "2026-10-01T11:58:03.000Z",
    ),
];

test("once the watch start resolves, the snapshot is the session event and the caught-up brief", async () => {
    const { start, snapshot } = await setup(beforeTheWatch(), {
        wait: fakeClock().wait,
        ...fakeAgents({ status: "busy" }),
    });

    await start();

    assert.deepEqual(snapshot(), [
        { type: "session", sessionId: SESSION, state: "watching" },
        {
            type: "brief",
            sessionId: SESSION,
            task: { text: "fix the login redirect", at: "2026-10-01T11:58:00.000Z", from: "transcript" },
            status: { state: "busy" },
            latestActivity: { what: "started Read: src/router.ts", at: "2026-10-01T11:58:03.000Z" },
            needsYou: { state: "nothing", at: AT },
            answerable: null,
            lastObserved: { at: AT, from: "status", lastHookAt: null },
            explanation: { state: "unknown" },
            response: {
                items: [
                    {
                        type: "tool",
                        id: "t0",
                        at: "2026-10-01T11:58:03.000Z",
                        name: "Read",
                        kind: "read",
                        title: "src/router.ts",
                        display: "Read",
                        argument: "src/router.ts",
                        state: "running",
                    },
                ],
                end: { state: "writing", at: "2026-10-01T11:58:03.000Z" },
                source: "transcript",
                cut: 0,
            },
        },
    ]);
});

test("a change of Last observed alone emits no brief event", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const { start, handle, events, briefNow } = await setup([], {
        wait: timer.wait,
        now: clock.now,
        ...fakeAgents({ status: "busy" }),
    });
    const briefEvents = () => events.filter(({ type }) => type === "brief");
    clock.at("12:00:01");
    await start();
    assert.equal(briefEvents().length, 1);

    clock.at("12:00:03");
    await timer.advance(2000);
    void handle(hook("SomeHookWithNoAction"));
    await until(() => briefNow().lastObserved?.from === "status");

    assert.deepEqual(briefNow().lastObserved, {
        at: clock.iso("12:00:03"),
        from: "status",
        lastHookAt: clock.iso("12:00:03"),
    });
    assert.equal(briefEvents().length, 1);
});

test("the sync's copy of a tool call that a hook already reported emits no second action event", async () => {
    const clock = testClock();
    const transcript = [prompt("run the tests", "2026-10-01T11:59:00.000Z")];
    const { start, handle, events } = await setup(transcript, { now: clock.now });
    await start();
    const caughtUp = events.length;
    const call = { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1" };

    clock.at("12:00:05");
    transcript.push(
        dated(
            msg("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
            "2026-10-01T12:00:04.990Z",
        ),
    );
    await handle(hook("PreToolUse", call));
    clock.at("12:00:07");
    transcript.push(
        dated(msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]), "2026-10-01T12:00:07.010Z"),
    );
    await handle(hook("PostToolUse", { ...call, tool_response: "ok" }));

    assert.deepEqual(
        events.slice(caughtUp).filter(({ type }) => type === "action"),
        [
            { type: "action", sessionId: SESSION, at: clock.iso("12:00:05"), what: "started Bash: npm test" },
            { type: "action", sessionId: SESSION, at: clock.iso("12:00:07"), what: "finished Bash: npm test" },
        ],
    );
});

test("a session Claude Code does not list is a session event `not listed`; listed again, `watching`", async () => {
    const timer = fakeClock();
    const agents = fakeAgents(null);
    const { start, snapshot, events } = await setup([], { wait: timer.wait, ...agents });

    await start();
    assert.deepEqual(snapshot()[0], { type: "session", sessionId: SESSION, state: "not listed" });
    const caughtUp = events.length;

    agents.session = { status: "idle" };
    await timer.advance(2000);
    await until(() => events.length > caughtUp);

    assert.deepEqual(
        events.slice(caughtUp).map((event) => (event.type === "brief" ? ["brief", event.status] : event)),
        [{ type: "session", sessionId: SESSION, state: "watching" }, ["brief", { state: "idle" }]],
    );
    assert.deepEqual(snapshot()[0], { type: "session", sessionId: SESSION, state: "watching" });
});

test("the brief event is the brief without what its explanation covers, with its Status as `state`", () => {
    const brief: Brief = {
        task: { text: "fix the login redirect", at: "2026-10-01T12:00:01.000Z", from: "hook" },
        status: { status: "not_listed" },
        latestActivity: { what: "reply finished: done", at: "2026-10-01T12:00:09.000Z", replyFinished: true },
        needsYou: { state: "nothing", at: "2026-10-01T12:00:09.000Z" },
        lastObserved: { at: "2026-10-01T12:00:11.000Z", from: "status", lastHookAt: "2026-10-01T12:00:09.000Z" },
        explanation: {
            state: "explained",
            text: "Claude is tracing the login redirect.",
            at: "2026-10-01T12:00:06.000Z",
            outdated: "reply finished",
            covers: { taskAt: "2026-10-01T12:00:01.000Z", requestAt: null, from: null, to: null },
        },
        response: {
            items: [{ type: "text", id: "m1:0", at: "2026-10-01T12:00:08.000Z", text: "done" }],
            end: { state: "writing", at: "2026-10-01T12:00:08.000Z" },
            source: "transcript",
            cut: 0,
        },
    };

    assert.deepEqual(toBriefEvent(SESSION, brief, null), {
        type: "brief",
        sessionId: SESSION,
        task: { text: "fix the login redirect", at: "2026-10-01T12:00:01.000Z", from: "hook" },
        status: { state: "not listed" },
        latestActivity: { what: "reply finished: done", at: "2026-10-01T12:00:09.000Z", replyFinished: true },
        needsYou: { state: "nothing", at: "2026-10-01T12:00:09.000Z" },
        answerable: null,
        lastObserved: { at: "2026-10-01T12:00:11.000Z", from: "status", lastHookAt: "2026-10-01T12:00:09.000Z" },
        explanation: {
            state: "explained",
            text: "Claude is tracing the login redirect.",
            at: "2026-10-01T12:00:06.000Z",
            outdated: "reply finished",
        },
        response: {
            items: [{ type: "text", id: "m1:0", at: "2026-10-01T12:00:08.000Z", text: "done" }],
            end: { state: "writing", at: "2026-10-01T12:00:08.000Z" },
            source: "transcript",
            cut: 0,
        },
    });
    const statusOf = (status: Status) => toBriefEvent(SESSION, { ...UNKNOWN_BRIEF, status }, null).status;
    assert.deepEqual(statusOf({ status: "waiting", waitingFor: "permission prompt" }), {
        state: "waiting",
        waitingFor: "permission prompt",
    });
    assert.deepEqual(statusOf({ status: "unknown", error: "no answer" }), { state: "unknown", error: "no answer" });
});

test("only a Status reading that lists the session or does not list it changes whether it is listed", () => {
    assert.equal(sessionStateAfter("watching", { status: "not_listed" }), "not listed");
    assert.equal(sessionStateAfter("not listed", { status: "waiting" }), "watching");
    assert.equal(sessionStateAfter("not listed", { status: "unknown", error: "no answer" }), "not listed");
    assert.equal(sessionStateAfter("not listed", null), "not listed");
});

test("a watch stop saves `stopped` with why, emits no `stopped`, logs one line, and takes no more hooks", async () => {
    const { start, stop, handle, events, readHookFile, printed } = await setup([]);
    await start();
    assert.equal(printed()[0], `watching ${SESSION}`);
    const before = { events: events.length, lines: printed().length };

    await stop("deleted");
    await handle(hook("UserPromptSubmit", { prompt: "too late" }));

    assert.deepEqual((await readHookFile()).at(-1), {
        kind: "izbor",
        sessionId: SESSION,
        timestamp: AT,
        event: "stopped",
        why: "deleted",
    });
    assert.deepEqual(events.slice(before.events), []);
    assert.deepEqual(printed().slice(before.lines), [`stopped watching ${SESSION} (deleted)`]);
});

test("the terminal shows only the watch start and stop: no messages, event records, Statuses, briefs or final replies", async () => {
    const timer = fakeClock();
    const agents = fakeAgents({ status: "busy" });
    const transcript = beforeTheWatch();
    const { start, stop, handle, events, readMessages, readRecords, readStatuses, printed } = await setup(transcript, {
        wait: timer.wait,
        ...agents,
    });
    await start();

    transcript.push(dated(msg("assistant", [{ type: "text", text: "Fixed." }]), "2026-10-01T12:00:01.000Z"));
    void handle(eventMarker());
    void handle(hook("Stop", { last_assistant_message: "Fixed." }));
    agents.session = { status: "idle" };
    await timer.advance(5000);
    await stop("deleted");

    assert.equal((await readMessages()).length, 3);
    assert.ok((await readRecords()).some((record) => record.kind === "event"));
    assert.deepEqual(await readStatuses(), [{ status: "busy" }, { status: "idle" }]);
    assert.ok(events.some((event) => event.type === "brief"));
    assert.deepEqual(printed(), [`watching ${SESSION}`, `stopped watching ${SESSION} (deleted)`]);
});

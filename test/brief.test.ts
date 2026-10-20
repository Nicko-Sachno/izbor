import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
    agentsOutput,
    dated,
    fakeAgents,
    fakeClock,
    hook,
    msg,
    prompt,
    RECEIVED_AT,
    SESSION,
    settle,
    setup,
    testClock,
    until,
} from "./support.js";
import { transcriptFixture } from "./helpers/transcripts.js";

const AT = RECEIVED_AT.toISOString();

function heldAgents() {
    const held: ((output: string) => void)[] = [];
    return {
        held,
        runClaudeAgents: () => new Promise<string>((resolve) => held.push(resolve)),
        async answer(session: object | null) {
            await until(() => held.length > 0);
            held.shift()!(agentsOutput(session));
            await settle();
        },
    };
}

const REQUEST = { tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Remove the build folder" } };

test("after a watch start with no evidence every field of the brief is unknown, and the start emits no brief event", async () => {
    const { start, briefNow, events } = await setup([]);

    await start();

    assert.deepEqual(events, []);
    assert.deepEqual(briefNow(), {
        type: "brief",
        sessionId: SESSION,
        task: null,
        status: null,
        latestActivity: null,
        needsYou: { state: "unknown" },
        answerable: null,
        lastObserved: null,
        explanation: { state: "unknown" },
    });
});

test("a prompt of the user is the Task, word for word, and the latest activity", async () => {
    const { start, handle, brief } = await setup([]);
    await start();

    await handle(hook("UserPromptSubmit", { prompt: "fix the login redirect\nand add a test" }));

    assert.deepEqual(brief().task, { text: "fix the login redirect\nand add a test", at: AT, from: "hook" });
    assert.deepEqual(brief().latestActivity, { what: "prompt submitted", at: AT });
    assert.deepEqual(brief().lastObserved, { at: AT, from: "hook", lastHookAt: AT });
});

test("a task notification is not the user's Task: the Task stays, the notification is the latest activity", async () => {
    const { start, handle, brief } = await setup([]);
    await start();
    await handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));

    const prompt =
        "<task-notification>\n<task-id>b1x9i5zos</task-id>\n<tool-use-id>toolu_0125ydKcugxRFemEX5R7yWtD</tool-use-id>\n" +
        "<output-file>/private/tmp/tasks/b1x9i5zos.output</output-file>\n<status>completed</status>\n" +
        '<summary>Background command "sleep 3; echo bg-done" completed (exit code 0)</summary>\n</task-notification>';
    await handle(hook("UserPromptSubmit", { prompt }));

    assert.equal(brief().task?.text, "fix the login redirect");
    assert.equal(
        brief().latestActivity?.what,
        'task notification: Background command "sleep 3; echo bg-done" completed (exit code 0)',
    );
});

test("the Status is the latest Status reading; a reading that finds no change still moves Last observed", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = fakeAgents({ status: "busy" });
    const { start, brief, briefNow, readStatuses } = await setup([], { wait: timer.wait, now: clock.now, ...agents });

    clock.at("12:00:01");
    await start();
    assert.equal((await readStatuses()).length, 1);
    assert.deepEqual(brief().status, { state: "busy" });
    assert.deepEqual(brief().lastObserved, { at: clock.iso("12:00:01"), from: "status", lastHookAt: null });

    clock.at("12:00:03");
    await timer.advance(2000);
    await until(() => briefNow().lastObserved?.at === clock.iso("12:00:03"));
    assert.deepEqual(brief().status, { state: "busy" });

    agents.session = { status: "waiting", waitingFor: "permission prompt" };
    await timer.advance(2000);
    await until(() => brief().status?.state === "waiting");
    assert.deepEqual(brief().status, { state: "waiting", waitingFor: "permission prompt" });
});

test("a Status query that fails makes the Status unknown and is no observation of the session", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = fakeAgents({ status: "busy" });
    const { start, brief, readStatuses } = await setup([], { wait: timer.wait, now: clock.now, ...agents });
    clock.at("12:00:01");
    await start();
    assert.equal((await readStatuses()).length, 1);

    clock.at("12:00:03");
    agents.session = new Error("claude agents --json gave no answer in 5000 ms");
    await timer.advance(2000);
    await until(() => brief().status?.state === "unknown");

    assert.deepEqual(brief().status, {
        state: "unknown",
        error: "Error: claude agents --json gave no answer in 5000 ms",
    });
    assert.deepEqual(brief().lastObserved, { at: clock.iso("12:00:01"), from: "status", lastHookAt: null });
});

test("a tool call is the latest activity when it starts, finishes or fails", async () => {
    const { start, handle, brief } = await setup([]);
    await start();
    const call = {
        tool_name: "Bash",
        tool_input: { command: "npm test", description: "Run the tests" },
        tool_use_id: "t1",
    };

    await handle(hook("PreToolUse", call));
    assert.deepEqual(brief().latestActivity, { what: "started Bash: npm test", at: AT });

    await handle(hook("PostToolUse", { ...call, tool_response: "ok" }));
    assert.equal(brief().latestActivity?.what, "finished Bash: npm test");

    await handle(hook("PostToolUseFailure", { ...call, error: "exit code 1" }));
    assert.equal(brief().latestActivity?.what, "failed Bash: npm test");

    await handle(hook("PostToolBatch", { tool_calls: [] }));
    assert.equal(brief().latestActivity?.what, "failed Bash: npm test");
});

test("a subagent's work is the latest activity, marked as the subagent's", async () => {
    const { start, handle, brief } = await setup([]);
    await start();

    await handle(hook("SubagentStart", { agent_id: "a1b2c3d4e5", agent_type: "Explore" }));
    assert.equal(brief().latestActivity?.what, "subagent started: Explore");

    await handle(
        hook("PreToolUse", { agent_id: "a1b2c3d4e5", tool_name: "Grep", tool_input: { pattern: "redirect" } }),
    );
    assert.equal(brief().latestActivity?.what, "subagent a1b2 started Grep: redirect");

    await handle(hook("SubagentStop", { agent_id: "a1b2c3d4e5", agent_type: "Explore" }));
    assert.equal(brief().latestActivity?.what, "subagent finished: Explore");
});

test("a finished reply is the latest activity, with the background work still running when it ended", async () => {
    const { start, handle, brief } = await setup([]);
    await start();

    await handle(
        hook("Stop", {
            last_assistant_message: "Done: the redirect is fixed.\n\nNext: run the tests.",
            background_tasks: [],
        }),
    );
    assert.equal(brief().latestActivity?.what, "reply finished: Done: the redirect is fixed. …");

    const background_tasks = [
        {
            id: "b0nhlyajy",
            type: "shell",
            status: "running",
            description: "sleep 25; echo bg-done",
            command: "sleep 25; echo bg-done",
        },
        { id: "a81", type: "agent", status: "running", description: "Trace the login flow" },
    ];
    await handle(hook("Stop", { last_assistant_message: "ok", background_tasks }));
    assert.equal(
        brief().latestActivity?.what,
        "reply finished: ok (2 background tasks still running: sleep 25; echo bg-done, Trace the login flow)",
    );

    await handle(hook("Stop", { last_assistant_message: "ok", background_tasks: background_tasks.slice(0, 1) }));
    assert.equal(
        brief().latestActivity?.what,
        "reply finished: ok (1 background task still running: sleep 25; echo bg-done)",
    );
});

test("a helper agent or a notification of Claude Code's after a reply does not replace the finished reply", async () => {
    const { start, handle, brief } = await setup([]);
    await start();
    await handle(hook("Stop", { last_assistant_message: "ok", background_tasks: [] }));

    await handle(
        hook("SubagentStop", { agent_id: "a703e3452b4b5e2dd", agent_type: "", last_assistant_message: "! cat x" }),
    );

    await handle(
        hook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }),
    );

    assert.equal(brief().latestActivity?.what, "reply finished: ok");
});

test("the other hooks are the latest activity in words of their own", async () => {
    const { start, handle, brief } = await setup([]);
    await start();
    const after = async (name: string, extra: object) => {
        await handle(hook(name, extra));
        return brief().latestActivity?.what;
    };
    const call = { tool_name: "Bash", tool_input: { command: "rm -rf build" } };

    assert.equal(await after("SessionStart", { source: "startup" }), "session started: startup");
    assert.equal(await after("PermissionRequest", call), "asked permission for Bash: rm -rf build");
    assert.equal(await after("PermissionDenied", call), "permission denied for Bash: rm -rf build");
    assert.equal(await after("StopFailure", { error: "rate_limit" }), "reply failed: rate_limit");
    assert.equal(await after("SessionEnd", { reason: "other" }), "session ended: other");
});

test("a plan approval in plain words: `Plan approval` titled by the plan's first line, `asked to approve a plan` as the latest activity, and the request exactly as Claude Code made it", async () => {
    const plan = "1. Edit the router\n2. Run the tests";
    const transcript = [
        {
            ...msg("assistant", [{ type: "tool_use", id: "t1", name: "ExitPlanMode", input: { plan } }]),
            timestamp: "2026-10-01T11:58:03.000Z",
        },
    ];
    const { start, handle, brief } = await setup(transcript);
    await start();
    assert.equal(brief().latestActivity?.what, "started Plan approval: 1. Edit the router …");

    const call = { tool_name: "ExitPlanMode", tool_input: { plan }, tool_use_id: "t1" };
    await handle(hook("PreToolUse", call));
    assert.deepEqual(brief().latestActivity, { what: "started Plan approval: 1. Edit the router …", at: AT });
    await handle(hook("PermissionRequest", call));
    assert.deepEqual(brief().latestActivity, { what: "asked to approve a plan", at: AT });
    assert.deepEqual(brief().needsYou, {
        state: "request",
        at: AT,
        agentId: null,
        tool: "ExitPlanMode",
        input: { plan },
    });

    await handle(hook("PostToolUse", { ...call, tool_response: { plan, isAgent: false } }));
    assert.equal(brief().latestActivity?.what, "finished Plan approval: 1. Edit the router …");
    assert.deepEqual(brief().needsYou, { state: "nothing", at: AT });
});

test("a permission request is what needs the user, exactly as Claude Code asked it", async () => {
    const { start, handle, brief } = await setup([]);
    await start();

    await handle(hook("PermissionRequest", REQUEST));

    assert.deepEqual(brief().needsYou, {
        state: "request",
        at: AT,
        agentId: null,
        tool: "Bash",
        input: { command: "rm -rf build", description: "Remove the build folder" },
    });
});

test("a pending request is cleared by a Status reading that is not waiting, only if it was asked for after the request", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = heldAgents();
    const { start, handle, brief, readStatuses } = await setup([], { wait: timer.wait, now: clock.now, ...agents });

    clock.at("12:00:04");
    void start();
    clock.at("12:00:05");
    void handle(hook("PermissionRequest", REQUEST));
    clock.at("12:00:06");
    await agents.answer({ status: "busy" });
    assert.equal(brief().needsYou.state, "request");

    await agents.answer({ status: "waiting", waitingFor: "permission prompt" });
    assert.equal(brief().needsYou.state, "request");

    await until(async () => (await readStatuses()).some((s) => s.status === "waiting"));
    clock.at("12:00:08");
    await timer.advance(2000);
    await agents.answer({ status: "busy" });
    assert.deepEqual(brief().needsYou, { state: "nothing", at: clock.iso("12:00:08") });
});

test("a pending request is cleared by a hook that shows it is over", async () => {
    const over: [string, object][] = [
        ["PostToolUse", REQUEST],
        ["PostToolUseFailure", REQUEST],
        ["PermissionDenied", REQUEST],
        ["PostToolBatch", { tool_calls: [] }],
        ["Stop", { last_assistant_message: "ok" }],
        ["StopFailure", {}],
        ["UserPromptSubmit", { prompt: "never mind, do something else" }],
        ["SessionEnd", { reason: "other" }],
    ];
    for (const [name, extra] of over) {
        const { start, handle, brief } = await setup([]);
        await start();
        await handle(hook("PermissionRequest", REQUEST));

        await handle(hook(name, extra));

        assert.deepEqual(brief().needsYou, { state: "nothing", at: AT }, name);
    }
});

test("a pending request stays when a hook says nothing about it", async () => {
    const { start, handle, brief } = await setup([]);
    await start();
    await handle(hook("PermissionRequest", REQUEST));

    await handle(hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    await handle(hook("PostToolBatch", { agent_id: "a1b2c3d4e5", tool_calls: [] }));
    await handle(hook("SubagentStop", { agent_id: "a1b2c3d4e5", agent_type: "Explore" }));
    await handle(
        hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission" }),
    );
    await handle(
        hook("UserPromptSubmit", { prompt: "<task-notification>\n<summary>done</summary>\n</task-notification>" }),
    );

    assert.equal(brief().needsYou.state, "request");
});

test("a subagent's request is cleared when its batch or the subagent itself ends", async () => {
    for (const name of ["PostToolBatch", "SubagentStop"]) {
        const { start, handle, brief } = await setup([]);
        await start();
        await handle(hook("PermissionRequest", { ...REQUEST, agent_id: "a1b2c3d4e5" }));
        assert.partialDeepStrictEqual(brief().needsYou, { state: "request", agentId: "a1b2c3d4e5" });

        await handle(hook(name, { agent_id: "a1b2c3d4e5", agent_type: "Explore" }));

        assert.equal(brief().needsYou.state, "nothing", name);
    }
});

test("a session that waits for something Izbor saw no request for: what needs the user is unknown", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = fakeAgents({ status: "waiting", waitingFor: "input needed" });
    const { start, brief, readStatuses } = await setup([], { wait: timer.wait, now: clock.now, ...agents });

    clock.at("12:00:01");
    await start();
    assert.equal((await readStatuses()).length, 1);
    assert.deepEqual(brief().needsYou, { state: "unknown", at: clock.iso("12:00:01"), waitingFor: "input needed" });

    clock.at("12:00:03");
    agents.session = { status: "idle" };
    await timer.advance(2000);
    await until(async () => (await readStatuses()).length === 2);
    assert.deepEqual(brief().needsYou, { state: "nothing", at: clock.iso("12:00:03") });
});

test("a session Claude Code no longer lists has no pending request; a failed Status query changes nothing", async () => {
    const timer = fakeClock();
    const agents = fakeAgents(new Error("no answer"));
    const { start, handle, brief, readStatuses, readRecords } = await setup([], { wait: timer.wait, ...agents });
    await start();
    assert.equal((await readStatuses()).length, 1);
    assert.deepEqual(brief().needsYou, { state: "unknown" });

    void handle(hook("PermissionRequest", REQUEST));
    await until(async () => (await readRecords().catch(() => [])).some((r) => r.event === "permission_request"));
    assert.equal(brief().needsYou.state, "request");

    agents.session = null;
    await timer.advance(2000);
    await until(async () => (await readStatuses()).some((s) => s.status === "not_listed"));
    assert.deepEqual(brief().needsYou, { state: "nothing", at: AT });
});

test("without hooks, the latest activity is the last action in the transcript, at the time the transcript gives it", async () => {
    const at = (hms: string) => ({ timestamp: `2026-10-01T${hms}.000Z` });
    const transcript = [
        { ...msg("user", "fix the login redirect"), ...at("11:58:00") },
        { ...msg("assistant", [{ type: "text", text: "I will read the router first." }]), ...at("11:58:02") },
        {
            ...msg("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/router.ts" } }]),
            ...at("11:58:03"),
        },
    ];
    const { start, handle, brief } = await setup(transcript);

    await start();
    assert.deepEqual(brief().latestActivity, { what: "started Read: src/router.ts", at: "2026-10-01T11:58:03.000Z" });
    assert.equal(brief().task, null);
    assert.equal(brief().lastObserved, null);

    transcript.push({
        ...msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "export const router" }]),
        ...at("11:58:04"),
    });
    await handle(hook("SomeHookWithNoAction"));
    assert.deepEqual(brief().latestActivity, { what: "finished Read: src/router.ts", at: "2026-10-01T11:58:04.000Z" });

    transcript.push({
        ...msg("assistant", [{ type: "text", text: "The redirect is in `router.ts`." }]),
        ...at("11:58:09"),
    });
    await handle(hook("SomeHookWithNoAction"));
    assert.deepEqual(brief().latestActivity, {
        what: "Claude wrote: The redirect is in `router.ts`.",
        at: "2026-10-01T11:58:09.000Z",
    });
});

test("an action in the transcript that is older than the latest activity does not replace it", async () => {
    const transcript = [msg("user", "hi")];
    const { start, handle, brief } = await setup(transcript);
    await start();

    transcript.push({
        ...msg("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
        timestamp: "2026-10-01T11:59:59.990Z",
    } as never);
    transcript.push({ ...msg("assistant", [{ type: "text", text: "undated" }]) });
    await handle(hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));

    assert.deepEqual(brief().latestActivity, { what: "finished Bash: ls", at: AT });
});

test("a Status change no hook announced causes a sync: a request rejected in the terminal reaches the brief", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = fakeAgents({ status: "waiting", waitingFor: "permission prompt" });
    const transcript = [
        msg("user", "okay... so tests ?"),
        msg("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
    ];
    const { start, brief, readStatuses, readRecords } = await setup(transcript, {
        wait: timer.wait,
        now: clock.now,
        ...agents,
    });
    await start();
    assert.ok((await readStatuses()).some((s) => s.status === "waiting"));

    const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected";
    transcript.push({
        ...msg("user", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: rejected }]),
        timestamp: "2026-10-01T12:00:09.000Z",
    } as never);
    agents.session = { status: "idle" };
    clock.at("12:00:10");
    await timer.advance(2000);
    await until(async () => (await readStatuses()).some((s) => s.status === "idle") && timer.dueWithin(300));
    await timer.advance(300);

    await until(async () => (await readRecords()).length === 3);
    assert.deepEqual(brief().latestActivity, {
        what: "rejected by the user: Bash: npm test",
        at: "2026-10-01T12:00:09.000Z",
    });
    assert.equal(brief().needsYou.state, "nothing");
});

async function savedSession() {
    let time = RECEIVED_AT;
    const transcript: SessionMessage[] = [];
    const izbor = await setup(transcript, { now: () => time });
    await izbor.start();
    const receive = (at: string, name: string, extra: object) => {
        time = new Date(`2026-10-02T${at}Z`);
        return izbor.handle(hook(name, extra));
    };
    return { ...izbor, transcript, receive };
}

const questionCall = (id: string, questions: object[]) => ({
    type: "tool_use",
    id,
    name: "AskUserQuestion",
    input: { questions },
});

test("an answered question: the latest activity says what the user answered, and the answer ends the request", async () => {
    const questions = [
        {
            question: "Tea or coffee?",
            header: "Drink",
            options: [
                { label: "Tea", description: "Tea is your pick." },
                { label: "Coffee", description: "Coffee is your pick." },
            ],
            multiSelect: false,
        },
    ];
    const asked = { tool_name: "AskUserQuestion", tool_input: { questions } };
    const answered = { questions, answers: { "Tea or coffee?": "Coffee" }, annotations: {} };
    const tool_use_id = "toolu_01NfxNqWLdcaB7ff4HX46UFh";
    const { brief, transcript, receive } = await savedSession();

    await receive("15:23:51.390", "UserPromptSubmit", {
        prompt: "Ask me one question with AskUserQuestion: tea or coffee?",
    });
    transcript.push(dated(msg("assistant", [questionCall(tool_use_id, questions)]), "2026-10-02T15:23:53.227Z"));
    await receive("15:23:53.254", "PreToolUse", { ...asked, tool_use_id });
    assert.equal(brief().latestActivity?.what, "started AskUserQuestion: Tea or coffee?");
    await receive("15:23:53.276", "PermissionRequest", asked);
    assert.equal(brief().latestActivity?.what, "asked the user: Tea or coffee?");
    assert.deepEqual(brief().needsYou, {
        state: "request",
        at: "2026-10-02T15:23:53.276Z",
        agentId: null,
        tool: "AskUserQuestion",
        input: asked.tool_input,
    });

    await receive("15:23:56.215", "PostToolUse", {
        ...asked,
        tool_input: answered,
        tool_response: answered,
        tool_use_id,
        duration_ms: 1,
    });
    assert.deepEqual(brief().latestActivity, {
        what: 'the user answered "Coffee" to: Tea or coffee?',
        at: "2026-10-02T15:23:56.215Z",
    });
    assert.deepEqual(brief().needsYou, { state: "nothing", at: "2026-10-02T15:23:56.215Z" });

    const content =
        'Your questions have been answered: "Tea or coffee?"="Coffee". You can now continue with these answers in mind.';
    transcript.push(dated(msg("user", [{ type: "tool_result", tool_use_id, content }]), "2026-10-02T15:23:56.222Z"));
    await receive("15:23:56.240", "PostToolBatch", {
        tool_calls: [{ ...asked, tool_use_id, tool_response: content }],
    });
    assert.deepEqual(brief().latestActivity, {
        what: 'the user answered "Coffee" to: Tea or coffee?',
        at: "2026-10-02T15:23:56.215Z",
    });

    await receive("15:23:57.226", "Stop", {
        stop_hook_active: false,
        last_assistant_message: "Coffee again.",
        background_tasks: [],
        session_crons: [],
    });
    assert.equal(brief().latestActivity?.what, "reply finished: Coffee again.");
});

test("a dismissed question: no hook reports it, and the latest activity says so once the transcript has it; `no` and words from Izbor say it was dismissed in Izbor, with no tool name", async () => {
    const dismissed = `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:
The user wants to clarify these questions.
    This means they may have additional information, context or questions for you.
    Take their response into account and then reformulate the questions if appropriate.
    Start by asking them what they would like to clarify.

    Questions asked:
- "What do you want me to do about tests?"
  (No answer provided)`;
    const cases: [object[], string, string, string][] = [
        [
            [{ question: "What do you want me to do about tests?", header: "Tests", options: [] }],
            "What do you want me to do about tests?",
            dismissed,
            "the user dismissed the question: What do you want me to do about tests?",
        ],
        [
            [{ question: "Which date format should the export use?", options: [{ label: "ISO 8601" }] }],
            "Which date format should the export use?",
            "The user said no in Izbor: ask me about the columns first",
            "the user dismissed the question in Izbor: Which date format should the export use?",
        ],
    ];
    for (const [questions, question, content, what] of cases) {
        const asked = { tool_name: "AskUserQuestion", tool_input: { questions } };
        const tool_use_id = "toolu_01VbiSJDzETBJyQMgFpQqgmH";
        const { brief, transcript, receive } = await savedSession();

        transcript.push(dated(msg("assistant", [questionCall(tool_use_id, questions)]), "2026-10-02T15:03:02.708Z"));
        await receive("15:03:02.744", "PreToolUse", { ...asked, tool_use_id });
        await receive("15:03:02.768", "PermissionRequest", asked);
        assert.equal(brief().needsYou.state, "request", what);
        assert.equal(brief().latestActivity?.what, `asked the user: ${question}`, what);

        const result = { type: "tool_result", tool_use_id, is_error: true, content };
        transcript.push(dated(msg("user", [result]), "2026-10-02T15:03:09.034Z"));
        await receive("15:03:09.082", "PostToolBatch", {
            tool_calls: [{ ...asked, tool_use_id, tool_response: content }],
        });

        assert.deepEqual(brief().latestActivity, { what, at: "2026-10-02T15:03:09.034Z" });
        assert.deepEqual(brief().needsYou, { state: "nothing", at: "2026-10-02T15:03:09.082Z" }, what);
    }
});

test("the hook of a finished question says what the user did: answers, several options, a reply of their own, or no answer", async () => {
    const questions = [{ question: "Tea or coffee?" }, { question: "With sugar?" }];
    const { start, handle, brief } = await setup([]);
    await start();
    const after = async (response: object) => {
        const tool_response = { questions, ...response };
        await handle(hook("PostToolUse", { tool_name: "AskUserQuestion", tool_input: tool_response, tool_response }));
        return brief().latestActivity?.what;
    };

    assert.equal(
        await after({ answers: { "Tea or coffee?": "Coffee", "With sugar?": 'Yes, "a little"' } }),
        'the user answered "Coffee" to: Tea or coffee? · "Yes, "a little"" to: With sugar?',
    );
    assert.equal(
        await after({ answers: { "Tea or coffee?": ["Tea", "Coffee"] } }),
        'the user answered "Tea, Coffee" to: Tea or coffee?',
    );
    assert.equal(
        await after({ answers: {}, response: "ask me later" }),
        'the user replied "ask me later" to: Tea or coffee? · With sugar?',
    );
    assert.equal(await after({ answers: {} }), "the user gave no answer to: Tea or coffee? · With sugar?");
    assert.equal(await after({}), "finished AskUserQuestion: Tea or coffee?");
});

test("a question that finished with no hook, as before the watch start: the latest activity quotes what Claude Code wrote about it", async () => {
    const startedAfter = async (content: string) => {
        const result = { type: "tool_result", tool_use_id: "t1", content };
        const call = questionCall("t1", [{ question: "Tea or coffee?" }]);
        const { start, brief } = await setup([dated(msg("assistant", [call]), AT), dated(msg("user", [result]), AT)]);
        await start();
        return brief().latestActivity?.what;
    };

    const own = 'The user answered: "Tea or coffee?"="Neither, water". Read the answers carefully.';
    assert.equal(await startedAfter(own), `the question ended: ${own}`);
    assert.equal(
        await startedAfter("The user did not answer the questions."),
        "the question ended: The user did not answer the questions.",
    );
});

async function savedSessionWithStatus(startedAt: string, firstStatus: object, date = "2026-10-02") {
    const day = (at: string) => new Date(`${date}T${at}Z`);
    let time = day(startedAt);
    const timer = fakeClock();
    const agents = fakeAgents(firstStatus);
    const transcript: SessionMessage[] = [];
    const izbor = await setup(transcript, { now: () => time, wait: timer.wait, ...agents });
    const { briefNow, readStatuses, readMessages } = izbor;
    let last: object | undefined;
    const observe = async (at: string, status: object, act: () => unknown) => {
        const saved = (await readStatuses()).length + (JSON.stringify(status) === JSON.stringify(last) ? 0 : 1);
        last = status;
        time = day(at);
        agents.session = status;
        await act();
        const observed = () => {
            const { lastObserved } = briefNow();
            return lastObserved?.from === "status" && lastObserved?.at === time.toISOString();
        };
        await until(async () => observed() && (await readStatuses()).length === saved && timer.dueWithin(300));
        await timer.advance(300);
        await until(async () => (await readMessages()).length === transcript.length);
    };
    await observe(startedAt, firstStatus, () => izbor.start());
    return {
        ...izbor,
        transcript,
        receive: (at: string, name: string, extra: object, status: object) =>
            observe(at, status, () => void izbor.handle(hook(name, extra))),
        reading: (at: string, status: object) => observe(at, status, () => timer.advance(2000)),
    };
}

const REJECTED =
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const endedByUser = (tool_use_id: string, at: string) => [
    dated(msg("user", [{ type: "tool_result", tool_use_id, is_error: true, content: REJECTED }]), at),
    dated(
        msg("user", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
        new Date(Date.parse(at) + 2).toISOString(),
    ),
];

const BUSY = { status: "busy" };
const IDLE = { status: "idle" };
const AT_PROMPT = { status: "waiting", waitingFor: "permission prompt" };

test("Esc while a granted tool runs, then Esc while Claude writes: the latest activity says the user interrupted, not that the user rejected", async () => {
    const { brief, transcript, receive, reading } = await savedSessionWithStatus("15:42:07.983", IDLE);
    const ping = {
        tool_name: "Bash",
        tool_input: { command: "ping -c 40 127.0.0.1", description: "Ping localhost 40 times" },
    };
    const tool_use_id = "toolu_01FXkMnSgk3G4zad8cUDassu";

    transcript.push(prompt("Run with Bash in the foreground: ping -c 40 127.0.0.1", "2026-10-02T15:42:24.199Z"));
    await receive(
        "15:42:24.215",
        "UserPromptSubmit",
        { prompt: "Run with Bash in the foreground: ping -c 40 127.0.0.1" },
        BUSY,
    );
    const call = { type: "tool_use", id: tool_use_id, name: "Bash", input: ping.tool_input };
    transcript.push(dated(msg("assistant", [call]), "2026-10-02T15:42:26.243Z"));
    await receive("15:42:26.273", "PreToolUse", { ...ping, tool_use_id }, BUSY);
    await receive("15:42:26.299", "PermissionRequest", ping, AT_PROMPT);
    assert.equal(brief().needsYou.state, "request");

    await reading("15:42:30.814", BUSY);
    assert.deepEqual(brief().needsYou, { state: "nothing", at: "2026-10-02T15:42:30.814Z" });

    transcript.push(...endedByUser(tool_use_id, "2026-10-02T15:42:32.994Z"));
    await reading("15:42:35.100", IDLE);
    assert.deepEqual(brief().latestActivity, {
        what: "interrupted by the user: Bash: ping -c 40 127.0.0.1",
        at: "2026-10-02T15:42:32.994Z",
    });

    await reading("15:42:56.660", { status: "waiting", waitingFor: "dialog open" });
    const model = [
        "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>",
        "<local-command-stdout>Set model to `Opus 5.5` and saved as your default for new sessions</local-command-stdout>",
    ];
    transcript.push(...model.map((text) => dated(msg("user", [{ type: "text", text }]), "2026-10-02T15:42:58.430Z")));
    await reading("15:42:58.800", IDLE);
    assert.equal(brief().latestActivity?.what, "interrupted by the user: Bash: ping -c 40 127.0.0.1");

    transcript.push(prompt("Write a 600-word story about a heron", "2026-10-02T15:42:59.709Z"));
    await receive("15:42:59.727", "UserPromptSubmit", { prompt: "Write a 600-word story about a heron" }, BUSY);

    const story =
        "# The Patient One\n\nEvery morning before the mist lifted off Calder Pond, the heron was already there.";
    transcript.push(
        dated(msg("assistant", []), "2026-10-02T15:43:10.790Z"),
        dated(msg("assistant", [{ type: "text", text: story }]), "2026-10-02T15:43:11.701Z"),
        dated(msg("user", [{ type: "text", text: "[Request interrupted by user]" }]), "2026-10-02T15:43:11.710Z"),
    );
    await reading("15:43:12.787", IDLE);
    assert.deepEqual(brief().latestActivity, {
        what: "reply interrupted by the user",
        at: "2026-10-02T15:43:11.710Z",
    });
    assert.equal(brief().task?.text, "Write a 600-word story about a heron");
});

test("a request the user rejected is still shown as rejected: the session waited until the tool result", async () => {
    const { brief, transcript, receive, reading } = await savedSessionWithStatus("14:53:00.469", IDLE);
    const bash = (command: string, description: string) => ({
        tool_name: "Bash",
        tool_input: { command, timeout: 300000, description },
    });
    const bashCall = (id: string, { tool_input: input }: ReturnType<typeof bash>) => ({
        type: "tool_use",
        id,
        name: "Bash",
        input,
    });

    const first = bash(
        `grep -A12 '"scripts"' package.json && npm test 2>&1 | tail -60`,
        "Show the project's scripts and run the test suite",
    );
    const firstId = "toolu_01PXh6wRuuy5URTN36TmL1gQ";
    transcript.push(prompt("okay... so tests ?", "2026-10-02T14:54:01.134Z"));
    await receive("14:54:01.151", "UserPromptSubmit", { prompt: "okay... so tests ?" }, BUSY);
    transcript.push(
        dated(msg("assistant", []), "2026-10-02T14:54:03.123Z"),
        dated(msg("assistant", [bashCall(firstId, first)]), "2026-10-02T14:54:03.788Z"),
    );
    await receive("14:54:03.826", "PreToolUse", { ...first, tool_use_id: firstId }, BUSY);
    await receive("14:54:03.859", "PermissionRequest", first, AT_PROMPT);
    const reminder = { message: "Claude needs your permission", notification_type: "permission_prompt" };
    await receive("14:54:09.874", "Notification", reminder, AT_PROMPT);

    transcript.push(...endedByUser(firstId, "2026-10-02T14:54:12.569Z"));
    await reading("14:54:14.288", IDLE);
    assert.deepEqual(brief().latestActivity, {
        what: `rejected by the user: Bash: grep -A12 '"scripts"' package.json && npm test 2>&1 | tail -60`,
        at: "2026-10-02T14:54:12.569Z",
    });
    assert.equal(brief().needsYou.state, "nothing");
});

test("a tool call the user ended before the watch start: the latest activity does not say whether it was rejected or interrupted", async () => {
    const call = { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } };
    const transcript = [
        prompt("okay... so tests ?", "2026-10-01T11:50:00.000Z"),
        dated(msg("assistant", [call]), "2026-10-01T11:50:03.000Z"),
        ...endedByUser("t1", "2026-10-01T11:50:12.569Z"),
    ];
    const { start, brief, readStatuses } = await setup(transcript, { wait: fakeClock().wait, ...fakeAgents(IDLE) });

    await start();
    assert.ok((await readStatuses()).some((s) => s.status === "idle"));

    assert.deepEqual(brief().latestActivity, {
        what: "rejected or interrupted by the user: Bash: npm test",
        at: "2026-10-01T11:50:12.569Z",
    });
});

type RecordedBlock = { type: string; id?: string; name?: string; input?: object; text?: string };

function recorded(name: string) {
    const { messages } = transcriptFixture(name);
    const contents = messages.map(({ message }) => (message as { content: string | RecordedBlock[] }).content);
    const blocks = contents.flatMap((content) => (Array.isArray(content) ? content : []));
    const call = blocks.find((block) => block.type === "tool_use")!;
    return {
        messages,
        prompt: contents[0] as string,
        tool: { tool_name: call.name!, tool_input: call.input! },
        toolUseId: call.id!,
        reply: blocks.findLast((block) => block.type === "text")?.text,
    };
}

test("`no` from Izbor: the latest activity says the user rejected the request, as after Claude Code's own No, which the transcript cannot be told from", async () => {
    const { messages, prompt, tool, toolUseId } = recorded("deny-interrupt");
    const { brief, transcript, receive, reading } = await savedSessionWithStatus("10:59:00.000", IDLE, "2026-10-09");

    transcript.push(messages[0]!);
    await receive("10:59:12.300", "UserPromptSubmit", { prompt }, BUSY);
    transcript.push(messages[1]!, messages[2]!);
    await receive("10:59:13.650", "PreToolUse", { ...tool, tool_use_id: toolUseId }, BUSY);
    await receive("10:59:13.680", "PermissionRequest", tool, AT_PROMPT);
    assert.equal(brief().needsYou.state, "request");

    transcript.push(messages[3]!, messages[4]!);
    await reading("10:59:43.000", IDLE);
    assert.deepEqual(brief().latestActivity, {
        what: "rejected by the user: Bash: echo denied > deny.txt",
        at: "2026-10-09T10:59:42.247Z",
    });
    assert.equal(brief().needsYou.state, "nothing");
});

test("`no` and words from Izbor: the latest activity identifies the rejection and Claude goes on", async () => {
    const { messages, prompt, tool, toolUseId, reply } = recorded("deny-with-words");
    const { brief, transcript, receive, reading } = await savedSessionWithStatus("10:59:00.000", IDLE, "2026-10-09");

    transcript.push(messages[0]!);
    await receive("10:59:13.150", "UserPromptSubmit", { prompt }, BUSY);
    transcript.push(messages[1]!, messages[2]!);
    await receive("10:59:14.520", "PreToolUse", { ...tool, tool_use_id: toolUseId }, BUSY);
    await receive("10:59:14.550", "PermissionRequest", tool, AT_PROMPT);
    assert.equal(brief().needsYou.state, "request");

    transcript.push(messages[3]!);
    await reading("10:59:43.000", BUSY);
    assert.deepEqual(brief().latestActivity, {
        what: "rejected by the user in Izbor: Bash: echo words > words.txt",
        at: "2026-10-09T10:59:42.255Z",
    });
    assert.equal(brief().needsYou.state, "nothing");

    transcript.push(messages[4]!, messages[5]!);
    await receive("10:59:45.900", "Stop", { last_assistant_message: reply, background_tasks: [] }, IDLE);
    assert.equal(
        brief().latestActivity!.what,
        "reply finished: The command was denied, so `words.txt` was not created. The denial said you wanted `printf` used in…",
    );
});

test("a session watched again within one Task shows the Task again, marked as read from the transcript", async () => {
    const clock = testClock();
    const transcript = [prompt("fix the login redirect", "2026-10-01T12:00:00.980Z")];
    const first = await setup(transcript, { now: clock.now });
    await first.start();
    clock.at("12:00:01");
    await first.handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    assert.deepEqual(first.brief().task, { text: "fix the login redirect", at: clock.iso("12:00:01"), from: "hook" });
    await first.stop();

    const read = [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.ts" } }];
    transcript.push(dated(msg("assistant", read), clock.iso("12:00:20")));
    clock.at("12:00:51");
    const second = await setup(transcript, { now: clock.now, dir: first.dir });
    await second.start();

    assert.deepEqual(second.brief().task, {
        text: "fix the login redirect",
        at: "2026-10-01T12:00:00.980Z",
        from: "transcript",
    });
    assert.deepEqual(second.brief().latestActivity, { what: "started Read: src/auth.ts", at: clock.iso("12:00:20") });
});

test("the first watch of a session takes the Task from the transcript: the latest prompt the user wrote", async () => {
    const at = (hms: string) => `2026-10-01T${hms}.000Z`;
    const notification = "<task-notification>\n<summary>tests ended</summary>\n</task-notification>";
    const transcript = [
        prompt("tell me a story", "2026-09-30T21:48:57.000Z"),
        prompt("fix the login redirect", at("11:50:00")),
        dated(
            msg("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
            at("11:50:05"),
        ),
        dated(msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]), at("11:50:20")),
        dated(msg("user", notification), at("11:50:30"), { kind: "task-notification", producer: "session-task" }),
        dated(msg("user", "<command-name>/model</command-name>"), at("11:50:40")),
        dated(msg("assistant", [{ type: "text", text: "The tests pass." }]), at("11:50:45")),
        dated(msg("user", [{ type: "text", text: "[Request interrupted by user]" }]), at("11:50:46")),
    ];
    const { start, brief } = await setup(transcript);

    await start();

    assert.deepEqual(brief().task, { text: "fix the login redirect", at: at("11:50:00"), from: "transcript" });
    assert.deepEqual(brief().latestActivity, { what: "reply interrupted by the user", at: at("11:50:46") });
});

test("a prompt submitted while the session was not watched is the Task after the watch start, not the older prompt Izbor received", async () => {
    const clock = testClock();
    const transcript = [
        prompt("fix the login redirect", "2026-10-01T12:00:00.980Z"),
        dated(msg("assistant", [{ type: "text", text: "The redirect is fixed." }]), clock.iso("12:00:10")),
    ];
    const first = await setup(transcript, { now: clock.now });
    await first.start();
    clock.at("12:00:01");
    await first.handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:11");
    await first.handle(hook("Stop", { last_assistant_message: "The redirect is fixed." }));
    await first.stop();

    transcript.push(prompt("now update the changelog", "2026-10-01T12:03:00.000Z"));
    clock.at("12:03:02");
    const second = await setup(transcript, { now: clock.now, dir: first.dir });
    await second.start();

    assert.deepEqual(second.brief().task, {
        text: "now update the changelog",
        at: clock.iso("12:03:00"),
        from: "transcript",
    });
    assert.deepEqual(second.brief().latestActivity, { what: "prompt submitted", at: clock.iso("12:03:00") });
});

test("a prompt submitted as the user by Izbor is the Task; another plugin or a missing as-the-user mark is not", async () => {
    const izborPlugin = JSON.parse(
        readFileSync(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"),
    ).name as string;
    const { messages } = transcriptFixture("plugin-prompt");
    const earlier = prompt("the prompt before", "2026-10-09T11:00:00.000Z");
    const taskWith = async (origin: object) => {
        const row = dated(messages[0]!, "2026-10-09T11:09:17.400Z", origin);
        const { start, brief } = await setup([earlier, row, ...messages.slice(1)]);
        await start();
        return brief().task;
    };

    assert.deepEqual(await taskWith({ kind: "plugin", name: izborPlugin, asUser: true }), {
        text: "Reply with exactly these words and nothing else: plugin prompt one",
        at: "2026-10-09T11:09:17.400Z",
        from: "transcript",
    });
    const before = { text: "the prompt before", at: "2026-10-09T11:00:00.000Z", from: "transcript" };
    assert.deepEqual(await taskWith({ kind: "plugin", name: "fixture-probe", asUser: true }), before);
    assert.deepEqual(await taskWith({ kind: "plugin", name: izborPlugin }), before);
});

test("a prompt whose hook Izbor never received becomes the Task when the transcript brings it", async () => {
    const clock = testClock();
    const transcript = [prompt("fix the login redirect", "2026-10-01T12:00:00.980Z")];
    const { start, handle, brief } = await setup(transcript, { now: clock.now });
    await start();
    clock.at("12:00:01");
    await handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));

    transcript.push(prompt("now update the changelog", "2026-10-01T12:03:00.000Z"));
    clock.at("12:03:04");
    await handle(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "CHANGELOG.md" } }));

    assert.deepEqual(brief().task, { text: "now update the changelog", at: clock.iso("12:03:00"), from: "transcript" });
});

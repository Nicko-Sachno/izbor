import { test } from "node:test";
import assert from "node:assert/strict";
import { createExplanationKeeper } from "../src/core/explanationKeeper.js";
import { createSummaryTurns } from "../src/core/summaryTurns.js";
import { UNKNOWN_BRIEF } from "../src/domain/brief.js";
import { toSummaryRequest } from "../src/domain/explanation.js";
import type { BriefEvent } from "../src/domain/streamEvent.js";
import type { Summarize } from "../src/domain/summary.js";
import { heldSummarizer, lingeringSummarizer } from "./helpers/fakeSummarizers.js";
import { dated, fakeAgents, fakeClock, hook, msg, prompt, setup, testClock, until } from "./support.js";

async function explaining(
    transcript = [msg("user", "fix the login redirect")],
    options: { runClaudeAgents?: (signal: AbortSignal) => Promise<string> } = {},
) {
    const timer = fakeClock();
    const clock = testClock();
    const summarizer = heldSummarizer();
    const izbor = await setup(transcript, {
        wait: timer.wait,
        now: clock.now,
        summarize: summarizer.summarize,
        ...options,
    });
    const started = izbor.start();
    return { ...izbor, started, timer, clock, summarizer, transcript };
}

const explanationOf = ({ explanation }: BriefEvent) => (explanation.state === "explained" ? explanation.text : null);

const explainedAt = ({ explanation }: BriefEvent) => (explanation.state === "explained" ? explanation.at : null);

const READ = { tool_name: "Read", tool_input: { file_path: "src/auth.ts" } };

test("5 s after an action Izbor asks the summarizer, and the brief shows the explanation with the time it was asked for", async () => {
    const { handle, brief, briefNow, timer, clock, summarizer } = await explaining();
    assert.deepEqual(briefNow().explanation, { state: "unknown" });

    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:03");
    void handle(hook("PreToolUse", READ));
    await timer.advance(4000);
    assert.equal(summarizer.requests.length, 0);

    clock.at("12:00:06");
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 1);
    const { systemPrompt, input } = summarizer.requests[0]!.request;
    assert.match(systemPrompt, /one sentence/i);
    assert.match(input, /^Task:\nfix the login redirect\n/);
    assert.match(input, /- prompt submitted\n- started Read: src\/auth\.ts$/);

    clock.at("12:00:08");
    await summarizer.summary("Claude is tracing the login redirect flow.\n");
    assert.deepEqual(brief().explanation, {
        state: "explained",
        text: "Claude is tracing the login redirect flow.",
        at: clock.iso("12:00:06"),
    });
});

async function firstRequest(izbor: Awaited<ReturnType<typeof explaining>>) {
    const { handle, timer, clock } = izbor;
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:06");
    await timer.advance(5000);
}

test("one summary request at a time: an action during a request starts no second one, and one more request follows the first", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);

    clock.at("12:00:07");
    void handle(hook("PreToolUse", READ));
    await timer.advance(20_000);
    assert.equal(summarizer.requests.length, 1);

    await summarizer.summary("Claude is starting on the login redirect.");
    assert.equal(summarizer.requests.length, 1);
    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 2);
    const { input } = summarizer.requests[1]!.request;
    assert.match(input, /- started Read: src\/auth\.ts$/);
    assert.doesNotMatch(input, /Explanation|Claude is starting on the login redirect/);

    await summarizer.summary("Claude is reading src/auth.ts.");
    await timer.advance(20_000);
    assert.equal(summarizer.requests.length, 2);
    assert.equal(explanationOf(brief()), "Claude is reading src/auth.ts.");
});

test("while the summarizer is slow the five fields keep changing, and the explanation stays unknown", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);

    clock.at("12:00:20");
    void handle(hook("PreToolUse", READ));
    void handle(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    await timer.advance(20_000);

    assert.equal(summarizer.requests.length, 1);
    assert.equal(brief().task?.text, "fix the login redirect");
    assert.deepEqual(brief().latestActivity, {
        what: "asked permission for Bash: rm -rf build",
        at: clock.iso("12:00:20"),
    });
    assert.equal(brief().needsYou.state, "request");
    assert.deepEqual(brief().lastObserved, {
        at: clock.iso("12:00:20"),
        from: "hook",
        lastHookAt: clock.iso("12:00:20"),
    });
    assert.deepEqual(brief().explanation, { state: "unknown" });
});

test("an unavailable summarizer leaves the explanation unknown, with the reason, and the five fields keep changing", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);
    await summarizer.summary("Claude is starting on the login redirect.");

    clock.at("12:00:10");
    void handle(hook("PreToolUse", READ));
    await timer.advance(5000);
    await summarizer.answer({ outcome: "unavailable", reason: "five_hour limit reached, no overage" });

    assert.deepEqual(brief().explanation, { state: "unknown", reason: "five_hour limit reached, no overage" });

    clock.at("12:00:30");
    void handle(hook("PostToolUse", READ));
    assert.deepEqual(brief().latestActivity, { what: "finished Read: src/auth.ts", at: clock.iso("12:00:30") });

    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 3);
    await summarizer.summary("Claude read src/auth.ts.");
    assert.equal(explanationOf(brief()), "Claude read src/auth.ts.");
});

test("a summary with no text is no explanation", async () => {
    const izbor = await explaining();
    await firstRequest(izbor);

    await izbor.summarizer.summary(" \n");

    assert.deepEqual(izbor.brief().explanation, { state: "unknown", reason: "the summarizer wrote nothing" });
});

test("a new Task removes the explanation of the Task before it, and a late explanation of that Task is not shown", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);
    await summarizer.summary("Claude is starting on the login redirect.");
    clock.at("12:00:10");
    void handle(hook("PreToolUse", READ));
    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 2);

    clock.at("12:00:20");
    void handle(hook("UserPromptSubmit", { prompt: "now update the changelog" }));
    assert.equal(brief().task?.text, "now update the changelog");
    assert.deepEqual(brief().explanation, { state: "unknown" });

    await summarizer.summary("Claude is reading src/auth.ts to trace the login redirect.");
    assert.deepEqual(brief().explanation, { state: "unknown" });

    clock.at("12:00:26");
    await timer.advance(5000);
    assert.match(summarizer.requests[2]!.request.input, /^Task:\nnow update the changelog\n/);
    await summarizer.summary("Claude is starting on the changelog.");
    assert.equal(explanationOf(brief()), "Claude is starting on the changelog.");
});

const DELETE = { tool_name: "Bash", tool_input: { command: "rm -rf build" } };

const outdatedOf = ({ explanation }: BriefEvent) => (explanation.state === "explained" && explanation.outdated) || null;

test("a late explanation made while a request was pending is shown as outdated once that request is over, and Izbor asks again 1 s later", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:02");
    void handle(hook("PermissionRequest", DELETE));
    clock.at("12:00:06");
    await timer.advance(5000);
    assert.match(summarizer.requests[0]!.request.input, /\nNeeds you: a request is pending, for Bash\n/);

    clock.at("12:00:07");
    void handle(hook("PostToolUse", DELETE));
    assert.equal(brief().needsYou.state, "nothing");

    await summarizer.summary("Claude is about to delete the build folder.");
    assert.equal(explanationOf(brief()), "Claude is about to delete the build folder.");
    assert.equal(outdatedOf(brief()), "request over");

    await timer.advance(999);
    assert.equal(summarizer.requests.length, 1);
    clock.at("12:00:09");
    await timer.advance(1);
    assert.equal(summarizer.requests.length, 2);
    assert.match(summarizer.requests[1]!.request.input, /\nNeeds you: no request pending\n/);
    await summarizer.summary("Claude deleted the build folder.");
    assert.equal(explanationOf(brief()), "Claude deleted the build folder.");
    assert.equal(outdatedOf(brief()), null);
    assert.ok(!("outdated" in brief().explanation));

    await timer.advance(60_000);
    assert.equal(summarizer.requests.length, 2);
});

test("an explanation shown while a request was pending is outdated when that request is over, and Izbor asks for a new one 1 s later", async () => {
    const agents = fakeAgents({ status: "waiting", waitingFor: "permission prompt" });
    const izbor = await explaining(undefined, { runClaudeAgents: agents.runClaudeAgents });
    const { handle, brief, timer, clock, summarizer } = izbor;
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:02");
    void handle(hook("PermissionRequest", DELETE));
    clock.at("12:00:07");
    await timer.advance(5000);
    await summarizer.summary("Claude is about to delete the build folder.");
    assert.equal(explanationOf(brief()), "Claude is about to delete the build folder.");
    assert.equal(outdatedOf(brief()), null);
    assert.equal(brief().needsYou.state, "request");

    clock.at("12:00:09");
    void handle(hook("PreToolUse", { ...READ, agent_id: "a1b2c3d4" }));
    assert.equal(brief().needsYou.state, "request");

    agents.session = { status: "busy" };
    clock.at("12:00:10");
    await timer.advance(2000);
    await until(() => brief().needsYou.state === "nothing");
    assert.equal(explanationOf(brief()), "Claude is about to delete the build folder.");
    assert.equal(outdatedOf(brief()), "request over");

    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 2);
    assert.match(summarizer.requests[1]!.request.input, /\nNeeds you: no request pending\n/);
    await summarizer.summary("Claude is deleting the build folder.");
    assert.equal(outdatedOf(brief()), null);

    await timer.advance(60_000);
    assert.equal(summarizer.requests.length, 2);
});

test("an explanation asked for under one request is outdated when another request takes its place in Needs you", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:02");
    void handle(hook("PermissionRequest", DELETE));
    clock.at("12:00:07");
    await timer.advance(5000);
    await summarizer.summary("Claude is about to delete the build folder.");
    assert.equal(outdatedOf(brief()), null);

    clock.at("12:00:10");
    void handle(hook("PermissionRequest", { tool_name: "WebFetch", tool_input: { url: "https://example.com" } }));
    assert.equal(explanationOf(brief()), "Claude is about to delete the build folder.");
    assert.equal(outdatedOf(brief()), "request replaced");

    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 2);
    assert.match(summarizer.requests[1]!.request.input, /\nNeeds you: a request is pending, for WebFetch\n/);

    clock.at("12:00:12");
    void handle(hook("PostToolUse", { tool_name: "WebFetch", tool_input: { url: "https://example.com" } }));
    assert.equal(brief().needsYou.state, "nothing");
    assert.equal(outdatedOf(brief()), "request replaced");
});

const DONE = { last_assistant_message: "The redirect is fixed in src/auth.ts." };

test("after a finished reply Izbor asks the summarizer what the reply did, not what Claude is working on", async () => {
    const izbor = await explaining();
    const { handle, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);
    assert.match(summarizer.requests[0]!.request.systemPrompt, /what Claude is working on/);
    await summarizer.summary("Claude is starting on the login redirect.");

    clock.at("12:00:10");
    void handle(hook("PostToolUse", READ));
    clock.at("12:00:12");
    void handle(hook("Stop", DONE));
    await timer.advance(5000);

    assert.equal(summarizer.requests.length, 2);
    const { systemPrompt, input } = summarizer.requests[1]!.request;
    assert.match(systemPrompt, /Claude has finished its reply/);
    assert.match(systemPrompt, /what Claude did in this reply/);
    assert.doesNotMatch(systemPrompt, /is working on/);
    assert.match(input, /- finished Read: src\/auth\.ts\n- reply finished: The redirect is fixed in src\/auth\.ts\.$/);
});

test("once the session acts again after a finished reply, Izbor asks what Claude is working on", async () => {
    const izbor = await explaining();
    const { handle, timer, clock, summarizer } = izbor;
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:02");
    void handle(hook("Stop", { last_assistant_message: "The tests run in the background." }));
    await timer.advance(5000);
    assert.match(summarizer.requests[0]!.request.systemPrompt, /what Claude did in this reply/);
    await summarizer.summary("Claude started the tests in the background.");

    clock.at("12:00:30");
    void handle(
        hook("UserPromptSubmit", { prompt: "<task-notification><summary>tests ended</summary></task-notification>" }),
    );
    void handle(hook("PreToolUse", READ));
    await timer.advance(5000);

    assert.equal(summarizer.requests.length, 2);
    assert.match(summarizer.requests[1]!.request.systemPrompt, /what Claude is working on/);
});

test("an explanation written before the reply finished is outdated when it finishes, and so is a late one", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);
    await summarizer.summary("Claude is starting on the login redirect.");
    clock.at("12:00:10");
    void handle(hook("PreToolUse", READ));
    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 2);

    clock.at("12:00:16");
    void handle(hook("Stop", DONE));
    assert.equal(brief().latestActivity?.what, "reply finished: The redirect is fixed in src/auth.ts.");
    assert.equal(explanationOf(brief()), "Claude is starting on the login redirect.");
    assert.equal(outdatedOf(brief()), "reply finished");

    await summarizer.summary("Claude is reading src/auth.ts.");
    assert.equal(explanationOf(brief()), "Claude is reading src/auth.ts.");
    assert.equal(outdatedOf(brief()), "reply finished");

    clock.at("12:00:18");
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 3);
    assert.match(summarizer.requests[2]!.request.systemPrompt, /what Claude did in this reply/);
    await summarizer.summary("Claude fixed the login redirect in src/auth.ts.");
    await timer.advance(60_000);
    assert.equal(explanationOf(brief()), "Claude fixed the login redirect in src/auth.ts.");
    assert.equal(outdatedOf(brief()), null);
    assert.equal(summarizer.requests.length, 3);
});

test("the same evidence is not explained twice, so an explanation that is outdated when it comes starts no row of requests", async () => {
    const timer = fakeClock();
    const summarizer = heldSummarizer();
    let recent = [{ what: "started Read: src/auth.ts", at: "2026-10-01T12:00:03.000Z" }];
    const explanations: string[] = [];
    const keeper = createExplanationKeeper({
        summarize: summarizer.summarize,
        takeTurn: createSummaryTurns().take,
        evidence: () => ({ brief: UNKNOWN_BRIEF, recent }),
        onExplanation: ({ text }) => {
            explanations.push(text);
            keeper.wake(true);
        },
        onNoExplanation: () => {},
        onError: (err) => assert.fail(String(err)),
        wait: timer.wait,
        now: () => new Date("2026-10-01T12:00:10.000Z"),
    });

    keeper.wake(false);
    await timer.advance(5000);
    await summarizer.summary("Claude is reading src/auth.ts.");
    await timer.advance(20_000);
    assert.deepEqual(explanations, ["Claude is reading src/auth.ts."]);
    assert.equal(summarizer.requests.length, 1);

    recent = [...recent, { what: "finished Read: src/auth.ts", at: "2026-10-01T12:00:04.000Z" }];
    keeper.wake(false);
    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 2);
    await keeper.stop();
});

test("a Izbor stop cancels the summary request in flight, waits until it has ended and shows nothing of it", async () => {
    const timer = fakeClock();
    const summarizer = lingeringSummarizer();
    const { start, handle, stop, brief } = await setup([], { wait: timer.wait, summarize: summarizer.summarize });
    void start();
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    await timer.advance(5000);
    assert.equal(summarizer.signal()?.aborted, false);

    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(summarizer.signal()?.aborted, true);
    assert.equal(stopped, false);

    summarizer.processGone({ outcome: "summary", text: "Claude is starting on the login redirect." });
    await stopping;
    assert.deepEqual(brief().explanation, { state: "unknown" });
});

function keeperAlone() {
    const timer = fakeClock();
    const summarizer = heldSummarizer();
    const explanations: string[] = [];
    const keeper = createExplanationKeeper({
        summarize: summarizer.summarize,
        takeTurn: createSummaryTurns().take,
        evidence: () => ({
            brief: UNKNOWN_BRIEF,
            recent: [{ what: "started Read: src/auth.ts", at: "2026-10-01T12:00:03.000Z" }],
        }),
        onExplanation: ({ text }) => explanations.push(text),
        onNoExplanation: (reason) => assert.fail(reason),
        onError: (err) => assert.fail(String(err)),
        wait: timer.wait,
        now: () => new Date("2026-10-01T12:00:10.000Z"),
    });
    return { keeper, timer, summarizer, explanations };
}

test("after its stop the explanation keeper makes no summary request, soon or not, however long the clock runs", async () => {
    const { keeper, timer, summarizer, explanations } = keeperAlone();
    keeper.wake(false);
    keeper.wake(true);

    assert.equal(timer.dueWithin(30_000), true);
    await keeper.stop();
    assert.equal(timer.dueWithin(30_000), false);
    await timer.advance(60_000);

    assert.equal(summarizer.requests.length, 0);
    assert.deepEqual(explanations, []);
});

test("no timer of the explanation keeper outlives its use: not the wait a sooner one replaced, not the 30 s of an answered request or of a stopped one", async () => {
    const { keeper, timer, summarizer, explanations } = keeperAlone();
    keeper.wake(false);
    keeper.wake(true);
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 1);
    assert.equal(timer.dueWithin(4000), false);
    assert.equal(timer.dueWithin(30_000), true);

    await summarizer.summary("Claude is reading src/auth.ts.");
    assert.deepEqual(explanations, ["Claude is reading src/auth.ts."]);
    assert.equal(timer.dueWithin(30_000), false);

    await keeper.stop();

    const other = keeperAlone();
    other.keeper.wake(false);
    await other.timer.advance(5000);
    assert.equal(other.timer.dueWithin(30_000), true);
    await other.keeper.stop();
    assert.equal(other.timer.dueWithin(30_000), false);
});

test("a summary request with no answer in 30 s is cancelled, and the explanation is unknown with that reason", async () => {
    const izbor = await explaining();
    const { handle, brief, timer, clock, summarizer } = izbor;
    await firstRequest(izbor);

    await timer.advance(29_000);
    assert.equal(summarizer.requests[0]!.signal.aborted, false);
    await timer.advance(1000);
    assert.equal(summarizer.requests[0]!.signal.aborted, true);
    assert.deepEqual(brief().explanation, { state: "unknown", reason: "the summarizer gave no answer in 30 s" });

    clock.at("12:01:00");
    void handle(hook("PreToolUse", READ));
    await timer.advance(5000);
    assert.equal(summarizer.requests.length, 2);
    await timer.advance(20_000);
    assert.equal(summarizer.requests[1]!.signal.aborted, false);
    await summarizer.summary("Claude is reading src/auth.ts.");
    assert.equal(explanationOf(brief()), "Claude is reading src/auth.ts.");
    await timer.advance(60_000);
    assert.equal(explanationOf(brief()), "Claude is reading src/auth.ts.");
});

const actionsIn = (input: string) => input.split("Recent actions, oldest first:\n")[1]!;

test("a summary request carries bounded evidence: the start of a long Task, and the 40 latest actions, each cut", async () => {
    const { handle, timer, clock, summarizer } = await explaining();
    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: `fix the login redirect ${"and more ".repeat(500)}` }));
    for (let i = 1; i <= 45; i++) {
        clock.at(`12:01:${String(i).padStart(2, "0")}`);
        void handle(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: `src/file-${i}.ts` } }));
    }
    void handle(hook("Stop", { last_assistant_message: "x".repeat(5000) }));
    await timer.advance(5000);

    const { input } = summarizer.requests[0]!.request;
    const [task, actions] = [input.split("\n")[1]!, actionsIn(input).split("\n")];
    assert.equal(task.length, 1000);
    assert.match(task, /^fix the login redirect and more .*…$/);
    assert.equal(actions.length, 40);
    assert.equal(actions[0], "- started Read: src/file-7.ts");
    assert.equal(actions[38], "- started Read: src/file-45.ts");
    assert.ok(actions.every((action) => action.length <= 302));
    assert.ok(input.length < 15_000, `the input has ${input.length} characters`);
});

const wrote = (text: string, timestamp: string) => dated(msg("assistant", [{ type: "text", text }]), timestamp);

test("what Claude wrote between its tool calls is among the recent actions, in the order it happened and only once", async () => {
    const transcript = [msg("user", "fix the login redirect")];
    const { handle, brief, started, timer, clock, summarizer } = await explaining(transcript);
    await started;

    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    transcript.push(wrote("I'll look at how the redirect\nis built first.", clock.iso("12:00:02")));
    clock.at("12:00:03");
    const handled = handle(hook("PreToolUse", READ));
    await timer.advance(1000);
    await handled;
    await timer.advance(4000);

    assert.ok(brief().response?.items.some((item) => item.type === "text" && item.text.includes("redirect\nis built")));
    assert.equal(
        summarizer.requests[0]!.request.input,
        [
            "Task:",
            "fix the login redirect",
            "",
            "Brief:",
            "Status: unknown",
            "Latest activity: started Read: src/auth.ts",
            "Needs you: unknown",
            "",
            "Recent actions, oldest first:",
            "- prompt submitted",
            "- Claude wrote: I'll look at how the redirect is built first.",
            "- started Read: src/auth.ts",
        ].join("\n"),
    );

    transcript.shift();
    clock.at("12:00:10");
    const rebuilt = handle(hook("PostToolUse", READ));
    await timer.advance(1000);
    await rebuilt;
    await summarizer.summary("Claude is reading src/auth.ts.");
    await timer.advance(5000);
    assert.equal(summarizer.requests[1]!.request.input.match(/Claude wrote/g)?.length, 1);
});

test("a finished tool call a hook reported is among the recent actions once: its copy in the transcript is left out", async () => {
    const transcript = [msg("user", "fix the login redirect")];
    const { handle, brief, started, timer, clock, summarizer } = await explaining(transcript);
    await started;
    const read = { ...READ, tool_use_id: "toolu_1" };

    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:03");
    void handle(hook("PreToolUse", read));
    clock.at("12:00:04");
    const handled = handle(hook("PostToolUse", read));
    const call = { type: "tool_use", id: "toolu_1", name: "Read", input: READ.tool_input };
    const result = { type: "tool_result", tool_use_id: "toolu_1", content: "export const auth = 1;" };
    transcript.push(
        dated(msg("assistant", [call]), "2026-10-01T12:00:02.970Z"),
        dated(msg("user", [result]), "2026-10-01T12:00:04.010Z"),
    );
    await timer.advance(1000);
    await handled;
    await timer.advance(5000);

    assert.match(
        summarizer.requests[0]!.request.input,
        /- prompt submitted\n- started Read: src\/auth\.ts\n- finished Read: src\/auth\.ts$/,
    );
    assert.deepEqual(brief().latestActivity, { what: "finished Read: src/auth.ts", at: clock.iso("12:00:04") });
});

test("a summary request carries only the actions of the current Task: none from before its prompt, from a hook or from the transcript", async () => {
    const transcript = [
        msg("user", "tell me a story"),
        wrote("Once upon a time a heron stood in the pond.", "2026-09-30T21:49:07.000Z"),
    ];
    const { handle, started, timer, clock, summarizer } = await explaining(transcript);
    await started;

    clock.at("12:00:01");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    clock.at("12:00:03");
    void handle(hook("PreToolUse", READ));
    clock.at("12:00:05");
    void handle(hook("Stop", DONE));
    await timer.advance(5000);
    assert.equal(
        actionsIn(summarizer.requests[0]!.request.input),
        "- prompt submitted\n- started Read: src/auth.ts\n- reply finished: The redirect is fixed in src/auth.ts.",
    );
    await summarizer.summary("Claude fixed the login redirect in src/auth.ts.");

    clock.at("12:00:20");
    void handle(hook("UserPromptSubmit", { prompt: "now update the changelog" }));
    await timer.advance(5000);
    assert.equal(actionsIn(summarizer.requests[1]!.request.input), "- prompt submitted");
    await summarizer.summary("Claude is starting on the changelog.");

    transcript.push(wrote("The redirect loop came from a stale cookie.", clock.iso("12:00:04")));
    const handled = handle(hook("Notification"));
    await timer.advance(1000);
    await handled;
    await timer.advance(20_000);
    assert.equal(summarizer.requests.length, 2);

    clock.at("12:00:50");
    void handle(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "CHANGELOG.md" } }));
    await timer.advance(5000);
    assert.equal(actionsIn(summarizer.requests[2]!.request.input), "- prompt submitted\n- started Read: CHANGELOG.md");
});

test("at a watch start Izbor asks at once about the last turn it read in the transcript, and the explanation covers that Task and its actions", async () => {
    const read = [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/router.ts" } }];
    const transcript = [
        prompt("tell me a story", "2026-09-30T21:48:57.000Z"),
        wrote("Once upon a time a heron stood in the pond.", "2026-09-30T21:49:07.000Z"),
        prompt("fix the login redirect", "2026-10-01T11:59:00.000Z"),
        wrote("I will read the router first.", "2026-10-01T11:59:02.000Z"),
        dated(msg("assistant", read), "2026-10-01T11:59:03.000Z"),
    ];
    const { handle, brief, started, timer, clock, summarizer } = await explaining(transcript);
    await started;
    await timer.advance(0);
    assert.equal(summarizer.requests.length, 1, "asked once the catch-up is in, with no 5 s wait");
    const { input } = summarizer.requests[0]!.request;
    assert.match(input, /^Task:\nfix the login redirect\n/);
    assert.equal(
        actionsIn(input),
        "- prompt submitted\n- Claude wrote: I will read the router first.\n- started Read: src/router.ts",
    );
    clock.at("12:00:03");
    await summarizer.summary("Claude is reading src/router.ts for the login redirect.");
    assert.deepEqual(brief().explanation, {
        state: "explained",
        text: "Claude is reading src/router.ts for the login redirect.",
        at: clock.iso("12:00:00"),
    });

    await timer.advance(60_000);
    assert.equal(summarizer.requests.length, 1);

    clock.at("12:01:05");
    void handle(hook("Stop", DONE));
    assert.equal(outdatedOf(brief()), "reply finished");
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 2);
    assert.match(
        actionsIn(summarizer.requests[1]!.request.input),
        /- reply finished: The redirect is fixed in src\/auth\.ts\.$/,
    );
});

test("a watch start on a transcript with no turn yet asks nothing: the first request comes 5 s after the first action", async () => {
    const { handle, briefNow, started, timer, clock, summarizer } = await explaining([]);
    await started;
    await timer.advance(60_000);
    assert.equal(summarizer.requests.length, 0);
    assert.deepEqual(briefNow().explanation, { state: "unknown" });

    clock.at("12:01:00");
    void handle(hook("UserPromptSubmit", { prompt: "fix the login redirect" }));
    await timer.advance(4000);
    assert.equal(summarizer.requests.length, 0);
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 1);
});

test("a watch start on a busy session makes one request: an action during the catch-up joins it, and one during the request waits for its end", async () => {
    const transcript = [prompt("fix the login redirect", "2026-10-01T11:59:00.000Z")];
    const { handle, started, timer, clock, summarizer } = await explaining(transcript);
    clock.at("12:00:00");
    void handle(hook("PreToolUse", READ));
    await started;
    await timer.advance(0);
    assert.equal(summarizer.requests.length, 1);
    const { input } = summarizer.requests[0]!.request;
    assert.match(input, /^Task:\nfix the login redirect\n/);
    assert.equal(actionsIn(input), "- started Read: src/auth.ts");

    clock.at("12:00:02");
    void handle(hook("PostToolUse", READ));
    await timer.advance(20_000);
    assert.equal(summarizer.requests.length, 1, "no second request while the first is in flight");
    await summarizer.summary("Claude is reading src/auth.ts.");
    await timer.advance(4000);
    assert.equal(summarizer.requests.length, 1);
    await timer.advance(1000);
    assert.equal(summarizer.requests.length, 2);
    assert.match(actionsIn(summarizer.requests[1]!.request.input), /- finished Read: src\/auth\.ts$/);
});

function sharingTheTurn() {
    const timer = fakeClock();
    const clock = testClock();
    const { take } = createSummaryTurns();
    async function watch(task: string, summarize: Summarize = heldSummarizer().summarize) {
        const izbor = await setup([], { wait: timer.wait, now: clock.now, summarize, takeTurn: take });
        await izbor.start();
        void izbor.handle(hook("UserPromptSubmit", { prompt: task }));
        return izbor;
    }
    async function held(task: string) {
        const summarizer = heldSummarizer();
        return { ...(await watch(task, summarizer.summarize)), summarizer };
    }
    return { timer, clock, watch, held };
}

test("a summary request due while another watch has the summary turn waits for it; its evidence, Age and 30 s limit start at the turn", async () => {
    const { timer, clock, held } = sharingTheTurn();
    clock.at("12:00:01");
    const a = await held("fix the login redirect");
    const b = await held("update the changelog");
    clock.at("12:00:06");
    await timer.advance(5000);
    assert.equal(a.summarizer.requests.length, 1);
    assert.equal(b.summarizer.requests.length, 0);

    clock.at("12:00:10");
    void b.handle(hook("PreToolUse", READ));
    await timer.advance(20_000);
    assert.equal(b.summarizer.requests.length, 0);

    clock.at("12:00:26");
    await a.summarizer.summary("Claude is starting on the login redirect.");
    assert.equal(b.summarizer.requests.length, 1);
    assert.match(b.summarizer.requests[0]!.request.input, /^Task:\nupdate the changelog\n/);
    assert.match(b.summarizer.requests[0]!.request.input, /- started Read: src\/auth\.ts$/);

    await timer.advance(29_000);
    assert.equal(b.summarizer.requests[0]!.signal.aborted, false);
    await b.summarizer.summary("Claude is reading src/auth.ts for the changelog.");
    assert.equal(explainedAt(b.brief()), clock.iso("12:00:26"));

    await timer.advance(60_000);
    assert.equal(b.summarizer.requests.length, 1);
});

test("a watch stop while its summary request waits for the summary turn cancels the request, and its place goes to the next watch", async () => {
    const { timer, clock, held } = sharingTheTurn();
    clock.at("12:00:01");
    const a = await held("fix the login redirect");
    const b = await held("update the changelog");
    const c = await held("bump the version");
    clock.at("12:00:06");
    await timer.advance(5000);

    await b.stop();

    await a.summarizer.summary("Claude is starting on the login redirect.");
    assert.equal(b.summarizer.requests.length, 0);
    assert.equal(c.summarizer.requests.length, 1);
    assert.match(c.summarizer.requests[0]!.request.input, /^Task:\nbump the version\n/);
});

test("a watch stop during its summary request cancels it, and the summary turn passes on once no process of it is left", async () => {
    const { timer, clock, watch, held } = sharingTheTurn();
    const lingering = lingeringSummarizer();
    clock.at("12:00:01");
    const a = await watch("fix the login redirect", lingering.summarize);
    const b = await held("update the changelog");
    clock.at("12:00:06");
    await timer.advance(5000);
    assert.equal(lingering.signal()?.aborted, false);

    const stopping = a.stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lingering.signal()?.aborted, true);
    assert.equal(b.summarizer.requests.length, 0);

    clock.at("12:00:08");
    lingering.processGone();
    await stopping;
    assert.equal(b.summarizer.requests.length, 1);
    await b.summarizer.summary("Claude is starting on the changelog.");
    assert.equal(explainedAt(b.brief()), clock.iso("12:00:08"));
});

test("an idle session's summary request asks what the reply did, even with no Stop hook seen; a busy one asks what Claude is working on", () => {
    const recent = [{ what: "Claude wrote: The changelog fix is committed.", at: "2026-10-14T12:00:00.000Z" }];
    const idle = toSummaryRequest({ ...UNKNOWN_BRIEF, status: { status: "idle" } }, recent).request.systemPrompt;
    assert.match(idle, /Claude has finished its reply/);
    assert.doesNotMatch(idle, /is working on/);
    const busy = toSummaryRequest({ ...UNKNOWN_BRIEF, status: { status: "busy" } }, recent).request.systemPrompt;
    assert.match(busy, /what Claude is working on/);
});

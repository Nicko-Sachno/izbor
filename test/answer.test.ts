import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
    ANSWER_HOOK_TIMEOUT_S,
    answerHookEntry,
    answerHookUrl,
    mergeAnswerHook,
} from "../src/adapters/agents/claude/setup/answerHook.js";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import { HOLD_LIMIT_MS } from "../src/domain/answer.js";
import type { ErrorAnswer } from "../src/domain/wire.js";
import {
    actingProject,
    ALLOW,
    BASH,
    type ExecHookEntry,
    HOOK_RUNNER,
    readSendKey,
    runHookEntry,
    tuneInOverHttp,
} from "./helpers/answerHook.js";
import { postHook } from "./helpers/izborPrompts.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { transcriptFixture } from "./helpers/transcripts.js";
import { type AgentsListEntry, fakeClock, hook, OTHER_SESSION, RECEIVED_AT, SESSION, until } from "./support.js";
import { postInTwoPieces } from "./helpers/http.js";

const DENY_INTERRUPT = JSON.stringify({
    hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "The user said no in Izbor.", interrupt: true },
    },
});

const hookReplyOf = (fixture: string) => JSON.stringify(transcriptFixture(fixture).hookReply);

const answerEntry = (port: number) => answerHookEntry(HOOK_RUNNER, port);

const statusPrinting = (port: number): ExecHookEntry => ({
    command: "curl",
    args: [
        "-sf",
        "-w",
        "%{http_code}",
        "-m",
        String(ANSWER_HOOK_TIMEOUT_S),
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
        answerHookUrl(port),
    ],
});

const waitingSession = (cwd: string) => ({
    agents: [{ sessionId: SESSION, cwd, status: "waiting", waitingFor: "permission prompt" } as AgentsListEntry],
});

test("seam 1: a Request in an acting project is held through the real answer hook; yes from Izbor's client allows it", async (t) => {
    const listed = waitingSession("/repo");
    const izbor = await startIzborServer(t, listed);
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);

    const request = hook("PermissionRequest", { ...BASH, cwd: acting });
    await postHook(izbor.base, "PermissionRequest", { ...BASH, cwd: acting });
    const held = runHookEntry(t, answerEntry(izbor.port), request);
    await until(() => stream.latest().answerable === true);
    const { needsYou } = stream.latest();
    assert.equal(needsYou.state, "request");

    const key = await readSendKey(izbor.info.sendKeyPath);
    const client = createIzborClient({ port: izbor.port });
    assert.deepEqual(await client.sendAnswer(SESSION, { at: needsYou.at!, answer: "yes" }, key), { sent: "yes" });

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
    await until(() => stream.latest().answerable === "answered");
    assert.deepEqual(stream.latest().needsYou, needsYou);

    listed.agents[0]!.status = "busy";
    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });
    await until(() => stream.latest().needsYou.state === "nothing");
    assert.equal(stream.latest().answerable, null);
    const answerables = stream.answerables();
    assert.deepEqual(answerables.slice(answerables.indexOf(true)), [true, "answered", null]);
});

async function heldRequest(t: TestContext, request: object = BASH, wait = fakeClock().wait) {
    const listed = waitingSession("/repo");
    const izbor = await startIzborServer(t, { ...listed, wait });
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await postHook(izbor.base, "PermissionRequest", { ...request, cwd: acting });
    const held = runHookEntry(t, answerEntry(izbor.port), hook("PermissionRequest", { ...request, cwd: acting }));
    await until(() => stream.latest().answerable === true);
    const at = stream.latest().needsYou.at!;
    const client = createIzborClient({ port: izbor.port });
    const key = await readSendKey(izbor.info.sendKeyPath);
    return { izbor, listed, acting, stream, held, at, client, key };
}

const postAnswer = (base: string, headers: Record<string, string>, body: string) =>
    fetch(`${base}/sessions/${SESSION}/answer`, { method: "POST", headers, body });

test("without the send key, or with a wrong one: 401 `unauthorized`, and the hook still holds", async (t) => {
    const { izbor, held, at, client, key } = await heldRequest(t);
    const body = JSON.stringify({ at, answer: "yes" });
    const wrongKey = key.replace(/^./, (c) => (c === "0" ? "1" : "0"));

    const tries: Record<string, string>[] = [{}, { authorization: `Bearer ${wrongKey}` }, { authorization: key }];
    for (const headers of tries) {
        const response = await postAnswer(izbor.base, headers, body);
        assert.equal(response.status, 401, JSON.stringify(headers));
        assert.equal(((await response.json()) as ErrorAnswer).error, "unauthorized");
    }
    const refused = await client.sendAnswer(SESSION, { at, answer: "yes" }, wrongKey);
    assert.equal("refused" in refused && refused.error, "unauthorized");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(held.running(), true);
    assert.equal(held.stdout(), "");
    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "yes" }, key), { sent: "yes" });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
});

test("the Izbor log has one line per answer sent: the session, the Request, the answer and the time", async (t) => {
    const { izbor, held, at, client, key } = await heldRequest(t);

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: " Yes " }, key), { sent: "yes" });
    await held.exited;
    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "yes" }, key), {
        refused: 409,
        error: "already_answered",
        message: "That request has an answer already.",
    });

    const sent = izbor.izbor.printed().filter((line) => line.includes(" sent "));
    assert.deepEqual(sent, [
        `${SESSION} sent yes at ${RECEIVED_AT.toISOString()}: Bash: echo held > held.txt (Needs you at ${at})`,
    ]);
});

test("`no` denies the held Request with the recorded interrupt flag and Izbor's message: Claude Code stops Claude, as after its own No", async (t) => {
    const { stream, held, at, client, key } = await heldRequest(t);

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: " No " }, key), { sent: "no" });

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), DENY_INTERRUPT);
    await until(() => stream.latest().answerable === "answered");
});

test("a comma or a space after `no` starts the words; `no` is read in any case, the words keep theirs", async (t) => {
    const decisionOf = (stdout: string) =>
        (JSON.parse(stdout) as { hookSpecificOutput: { decision: object } }).hookSpecificOutput.decision;
    const cases: [string, string][] = [
        ["no, run only the export tests", "run only the export tests"],
        ["NO,Run Only The Export Tests", "Run Only The Export Tests"],
        ["No   run only the export tests ", "run only the export tests"],
        ["no , run only the export tests", "run only the export tests"],
    ];
    for (const [typed, words] of cases) {
        const { held, at, client, key } = await heldRequest(t);
        assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: typed }, key), { sent: `no ${words}` }, typed);
        assert.equal(await held.exited, 0, typed);
        assert.deepEqual(
            decisionOf(held.stdout()),
            { behavior: "deny", message: `The user said no in Izbor: ${words}` },
            typed,
        );
    }
});

test("the answer hook's limits nest: Izbor's hold of 1 hour, then the script's own limit, then the entry's timeout", () => {
    const merged = mergeAnswerHook(null, 4319, HOOK_RUNNER);
    assert.ok("text" in merged);
    const [entry] = JSON.parse(merged.text).hooks.PermissionRequest[0].hooks;
    assert.equal(HOLD_LIMIT_MS, 3_600_000);
    assert.deepEqual(entry, {
        type: "command",
        command: "node",
        args: [HOOK_RUNNER.script, "http://127.0.0.1:4319/hook/answer", "3630", "print"],
        timeout: 3660,
    });
    assert.deepEqual(entry, answerEntry(4319));
});

test("a test Izbor lets go at once, with no decision, of a Request it does not hold: a subagent's, a plan approval", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const entry = answerEntry(izbor.port);
    const noDecision = async (payload: object, what: string) => {
        const run = runHookEntry(t, entry, payload);
        assert.equal(await run.exited, 0, what);
        assert.equal(run.stdout(), "", what);
    };

    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    const subagent = { ...BASH, cwd: acting, agent_id: "af3f12f733bb2dea5", agent_type: "general-purpose" };
    await postHook(izbor.base, "PermissionRequest", subagent);
    await noDecision(hook("PermissionRequest", subagent), "a subagent's");
    const plan = { tool_name: "ExitPlanMode", tool_input: { plan: "1. Edit the router" }, cwd: acting };
    await postHook(izbor.base, "PermissionRequest", plan);
    await noDecision(hook("PermissionRequest", plan), "a plan approval");
    await until(() => stream.latest().answerable === "plan approval not supported");
    assert.ok(!stream.answerables().includes(true));
    const at = stream.latest().needsYou.at!;
    const refused = await createIzborClient({ port: izbor.port }).sendAnswer(
        SESSION,
        { at, answer: "yes" },
        await readSendKey(izbor.info.sendKeyPath),
    );
    assert.deepEqual(refused, {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: Izbor does not answer plan approvals.",
        answerable: "plan approval not supported",
    });
});

test("in a project without the answer hook, answerable is `not an acting project`, and an answer gets 409 `not_answerable` with that reason", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);

    await postHook(izbor.base, "PermissionRequest", BASH);
    await until(() => stream.latest().needsYou.state === "request");
    assert.equal(stream.latest().answerable, "not an acting project");

    const answer = { at: stream.latest().needsYou.at!, answer: "yes" };
    const key = await readSendKey(izbor.info.sendKeyPath);
    assert.deepEqual(await createIzborClient({ port: izbor.port }).sendAnswer(SESSION, answer, key), {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: this project has no plugin.",
        answerable: "not an acting project",
    });
});

test("an answer that does not fit, a changed Request, an unwatched session or a body Izbor cannot read is refused, and the hook still holds", async (t) => {
    const { izbor, held, at, client, key } = await heldRequest(t);
    const refusal = async (id: string, body: { at: string; answer: string }) => {
        const answered = await client.sendAnswer(id, body, key);
        return "refused" in answered ? [answered.refused, answered.error, answered.message] : answered;
    };

    for (const answer of ["nope", "no!", "maybe", "", "  ", "yes please", "1", "2"])
        assert.deepEqual(
            await refusal(SESSION, { at, answer }),
            [400, "bad_answer", "Type yes, no, or no and your words."],
            answer,
        );
    assert.deepEqual(await refusal(SESSION, { at: "2026-10-01T11:00:00.000Z", answer: "yes" }), [
        409,
        "request_changed",
        "That request is over or changed: check the Brief.",
    ]);
    const unwatched = "9999ffff-0000-4000-8000-000000000000";
    assert.deepEqual(await refusal(unwatched, { at, answer: "yes" }), [
        404,
        "not_watched",
        `${unwatched} is not watched`,
    ]);
    const unreadable = await postAnswer(izbor.base, { authorization: `Bearer ${key}` }, '{"answer":"yes"}');
    assert.equal(unreadable.status, 400);
    assert.equal(((await unreadable.json()) as ErrorAnswer).error, "bad_answer");

    assert.equal(held.running(), true);
    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "YES" }, key), { sent: "yes" });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
});

test("`yes` to a Question is refused with what a Question takes, as Claude Code ignores an allow without answers; `no` ends it", async (t) => {
    const question = {
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }] }] },
    };
    const { held, at, client, key } = await heldRequest(t, question);

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "yes" }, key), {
        refused: 400,
        error: "bad_answer",
        message: "Type an option's number, or no.",
    });
    assert.equal(held.running(), true);

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "no" }, key), { sent: "no" });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), DENY_INTERRUPT);
});

const COLOR_QUESTION = {
    tool_name: "AskUserQuestion",
    tool_input: {
        questions: [
            {
                question: "Which color?",
                header: "Color",
                options: [
                    { label: "Red", description: "Pick red" },
                    { label: "Blue", description: "Pick blue" },
                ],
                multiSelect: false,
            },
        ],
    },
};

test("seam 1: an option's number to a Question of one question with one choice allows it with the answers filled in, in the format Claude Code recorded", async (t) => {
    const { izbor, held, at, client, key, stream } = await heldRequest(t, COLOR_QUESTION);

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: " 2 " }, key), { sent: "2" });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), hookReplyOf("question-answered"));
    await until(() => stream.latest().answerable === "answered");
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" sent ")),
        [`${SESSION} sent 2 at ${RECEIVED_AT.toISOString()}: AskUserQuestion: Which color? (Needs you at ${at})`],
    );
});

test("`yes`, a number past the last option, 0, 00 and any other text to a Question are refused with what a Question takes, and the hook still holds", async (t) => {
    const { held, at, client, key } = await heldRequest(t, COLOR_QUESTION);

    for (const answer of ["yes", "3", "4", "0", "00", "-1", "2.", "2 3", "1.5", "Blue", "second", ""])
        assert.deepEqual(
            await client.sendAnswer(SESSION, { at, answer }, key),
            { refused: 400, error: "bad_answer", message: "Type an option's number, or no." },
            answer,
        );
    assert.equal(held.running(), true);
    assert.equal(held.stdout(), "");

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "1" }, key), { sent: "1" });
    assert.equal(await held.exited, 0);
    const { decision } = (JSON.parse(held.stdout()) as { hookSpecificOutput: { decision: object } }).hookSpecificOutput;
    assert.deepEqual(decision, {
        behavior: "allow",
        updatedInput: { ...COLOR_QUESTION.tool_input, answers: { "Which color?": "Red" } },
    });
});

test("a Question is answered by its option's number: `02` is taken as `2`, and a question whose `kind` is `choice` as one with no kind", async (t) => {
    const [asked] = COLOR_QUESTION.tool_input.questions;
    const cases: [string, object, string][] = [
        ["02 to a Question", COLOR_QUESTION.tool_input, "02"],
        ["2 to a choice", { questions: [{ ...asked!, kind: "choice" }] }, "2"],
    ];
    for (const [what, input, answer] of cases) {
        const { held, at, client, key } = await heldRequest(t, { tool_name: "AskUserQuestion", tool_input: input });

        assert.deepEqual(await client.sendAnswer(SESSION, { at, answer }, key), { sent: "2" }, what);
        assert.equal(await held.exited, 0, what);
        const { decision } = (JSON.parse(held.stdout()) as { hookSpecificOutput: { decision: object } })
            .hookSpecificOutput;
        assert.deepEqual(
            decision,
            { behavior: "allow", updatedInput: { ...input, answers: { "Which color?": "Blue" } } },
            what,
        );
    }
});

test("seam 1: a Question Izbor cannot answer by number (two questions, several choices, a question for text or a number, no options, an empty options list, an empty question, an empty option label) is not held: answerable reads `question not supported`, and every answer gets `not_answerable`", async (t) => {
    const [asked] = COLOR_QUESTION.tool_input.questions;
    const shapes: Record<string, object> = {
        "two questions": { questions: [asked, { ...asked!, question: "Which size?" }] },
        "several choices": { questions: [{ ...asked!, multiSelect: true }] },
        "a text question": { questions: [{ ...asked!, kind: "text" }] },
        "a number question": { questions: [{ ...asked!, kind: "number" }] },
        "no options": { questions: [{ question: "Which color?" }] },
        "an empty options list": { questions: [{ question: "Which color?", options: [] }] },
        "an empty question": { questions: [{ ...asked!, question: "" }] },
        "an option without a label": { questions: [{ ...asked!, options: [{ label: "Red" }, {}] }] },
        "an empty option label": { questions: [{ ...asked!, options: [{ label: "Red" }, { label: "" }] }] },
        "no questions": { questions: [] },
        "nothing Izbor can read": {},
    };
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    const client = createIzborClient({ port: izbor.port });
    const key = await readSendKey(izbor.info.sendKeyPath);

    for (const [what, tool_input] of Object.entries(shapes)) {
        const question = { tool_name: "AskUserQuestion", tool_input, cwd: acting };
        await postHook(izbor.base, "PermissionRequest", question);
        const run = runHookEntry(t, answerEntry(izbor.port), hook("PermissionRequest", question));
        assert.equal(await run.exited, 0, what);
        assert.equal(run.stdout(), "", what);
        await until(() => {
            const { needsYou } = stream.latest();
            return needsYou.state === "request" && isDeepStrictEqual(needsYou.input, tool_input);
        });
        assert.equal(stream.latest().answerable, "question not supported", what);
        const at = stream.latest().needsYou.at!;
        for (const answer of ["1", "no", "yes"])
            assert.deepEqual(
                await client.sendAnswer(SESSION, { at, answer }, key),
                {
                    refused: 409,
                    error: "not_answerable",
                    message: "Answer it in the session: Izbor answers only one question with one choice.",
                    answerable: "question not supported",
                },
                `${what}: ${answer}`,
            );
    }
    assert.ok(!stream.answerables().includes(true));
});

test("when Claude Code ends the held hook (Esc, the session's exit), Izbor drops it: answerable reads `expired`, and an answer gets that reason", async (t) => {
    const { stream, held, at, client, key } = await heldRequest(t);

    held.kill();
    await held.exited;
    await until(() => stream.latest().answerable === "expired");

    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "yes" }, key), {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: Izbor is no longer holding this request.",
        answerable: "expired",
    });
});

test("at the hold limit of 1 hour Izbor lets go with no decision, and answerable reads `expired`", async (t) => {
    const clock = fakeClock();
    const { stream, held } = await heldRequest(t, BASH, clock.wait);

    await clock.advance(HOLD_LIMIT_MS - 1000);
    assert.equal(held.running(), true);
    await clock.advance(1000);

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await until(() => stream.latest().answerable === "expired");
});

test("a newer request replaces the held one: the older gets no decision, and no brief event in between says neither is held", async (t) => {
    const { izbor, acting, stream, held: older } = await heldRequest(t);
    const next = { tool_name: "Bash", tool_input: { command: "echo next > next.txt" } };

    await postHook(izbor.base, "PermissionRequest", { ...next, cwd: acting });
    const newer = runHookEntry(t, answerEntry(izbor.port), hook("PermissionRequest", { ...next, cwd: acting }));
    assert.equal(await older.exited, 0);
    assert.equal(older.stdout(), "");
    await until(() => stream.latest().answerable === true && stream.latest().needsYou.state === "request");
    assert.deepEqual((stream.latest().needsYou as { input: unknown }).input, next.tool_input);
    const answerables = stream.answerables();
    assert.ok(
        answerables
            .slice(answerables.indexOf(true))
            .every((answerable) => answerable === true || answerable === "not running when it asked"),
        JSON.stringify(answerables),
    );
    assert.ok(!answerables.includes("expired"), JSON.stringify(answerables));
    assert.equal(newer.running(), true);
});

test("seam 1: a watch starts on a session whose request Izbor never received: Needs you is `unknown` with `waitingFor`, answerable says `not running when it asked`, and an answer gets `not_answerable` with that reason", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await postHook(izbor.base, "Notification", { cwd: acting, notification_type: "permission_prompt" });
    await until(() => stream.latest().needsYou.state === "unknown" && stream.latest().answerable !== null);

    assert.equal(stream.latest().answerable, "not running when it asked");
    const answer = { at: stream.latest().needsYou.at!, answer: "yes" };
    const key = await readSendKey(izbor.info.sendKeyPath);
    assert.deepEqual(await createIzborClient({ port: izbor.port }).sendAnswer(SESSION, answer, key), {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: Izbor was not running when it asked.",
        answerable: "not running when it asked",
    });
});

test("a subagent's request in an acting project is not held: answerable reads `subagent wait over`, and an answer gets `not_answerable` with that reason", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);

    await postHook(izbor.base, "PermissionRequest", { ...BASH, cwd: acting, agent_id: "af3f12f733bb2dea5" });
    await until(() => stream.latest().needsYou.state === "request");
    assert.equal(stream.latest().answerable, "subagent wait over");

    const answer = { at: stream.latest().needsYou.at!, answer: "yes" };
    const key = await readSendKey(izbor.info.sendKeyPath);
    assert.deepEqual(await createIzborClient({ port: izbor.port }).sendAnswer(SESSION, answer, key), {
        refused: 409,
        error: "not_answerable",
        message: "A subagent asks: answer it in the session.",
        answerable: "subagent wait over",
    });
});

test("the evidence that clears Needs you lets go of the hold with no decision: the user allowed it in Claude Code's dialog, which keeps the hook open, and the tool's end came by hook; a late answer gets `request_changed`", async (t) => {
    const { izbor, listed, acting, stream, held, at, client, key } = await heldRequest(t);

    listed.agents[0]!.status = "busy";
    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await until(() => stream.latest().needsYou.state === "nothing");
    assert.equal(stream.latest().answerable, null);
    const answerables = stream.answerables();
    assert.deepEqual(answerables.slice(answerables.indexOf(true)), [true, null]);
    const briefs = stream.briefs();
    assert.ok(
        briefs.every((brief, i) => i === 0 || !isDeepStrictEqual(brief, briefs[i - 1])),
        JSON.stringify(briefs),
    );
    assert.deepEqual(await client.sendAnswer(SESSION, { at, answer: "yes" }, key), {
        refused: 409,
        error: "request_changed",
        message: "That request is over or changed: check the Brief.",
    });
});

test("a Status reading that is no longer waiting, the evidence of a No in Claude Code's dialog, which sends no hook, lets go of the hold with no decision", async (t) => {
    const clock = fakeClock();
    const { listed, stream, held } = await heldRequest(t, BASH, clock.wait);

    listed.agents[0]!.status = "idle";
    await clock.advance(2000);

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await until(() => stream.latest().needsYou.state === "nothing");
    const answerables = stream.answerables();
    assert.deepEqual(answerables.slice(answerables.indexOf(true)), [true, null]);
});

test("a reading answered late, before Needs you showed the held request, clears nothing held and leaves the hold: only evidence after that ends it", async (t) => {
    const clock = fakeClock();
    const listed = waitingSession("/repo");
    const izbor = await startIzborServer(t, { ...listed, wait: clock.wait });
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    const request = hook("PermissionRequest", { ...BASH, cwd: acting });
    const held = runHookEntry(t, answerEntry(izbor.port), request);
    await until(() => izbor.requests.some(({ path }) => path === "/hook/answer"));

    listed.agents[0]!.status = "busy";
    await clock.advance(2000);
    await until(() => stream.latest().needsYou.state === "nothing");

    listed.agents[0]!.status = "waiting";
    await postHook(izbor.base, "PermissionRequest", { ...BASH, cwd: acting });
    await until(() => stream.latest().answerable === true);
    listed.agents[0]!.status = "busy";
    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await until(() => stream.latest().needsYou.state === "nothing" && stream.latest().answerable === null);
});

test("the Izbor stop lets go of every held answer hook with an empty reply before it cuts connections, and an answer whose body arrives meanwhile gets 503 `stopping`", async (t) => {
    const entry = (sessionId: string) =>
        ({ sessionId, cwd: "/repo", status: "waiting", waitingFor: "permission prompt" }) as AgentsListEntry;
    const izbor = await startIzborServer(t, { agents: [entry(SESSION), entry(OTHER_SESSION)] });
    const acting = await actingProject(t, izbor.port);
    const entries = [
        [SESSION, answerEntry(izbor.port)],
        [OTHER_SESSION, statusPrinting(izbor.port)],
    ] as const;
    const holds = [];
    for (const [sessionId, run] of entries) {
        const stream = await tuneInOverHttp(t, izbor.port, sessionId);
        const payload = { ...BASH, cwd: acting, session_id: sessionId };
        await postHook(izbor.base, "PermissionRequest", payload);
        const held = runHookEntry(t, run, hook("PermissionRequest", payload));
        await until(() => stream.latest().answerable === true);
        holds.push({ stream, held, at: stream.latest().needsYou.at! });
    }
    const key = await readSendKey(izbor.info.sendKeyPath);
    let stopped = false;

    const body = JSON.stringify({ at: holds[0]!.at, answer: "yes" });
    const answered = await postInTwoPieces(
        `${izbor.base}/sessions/${SESSION}/answer`,
        body.slice(0, 10),
        body.slice(10),
        () => void izbor.stop().then(() => (stopped = true)),
        { authorization: `Bearer ${key}`, "content-type": "application/json" },
    );

    assert.deepEqual(
        { status: answered.status, connection: answered.headers.get("connection"), body: await answered.json() },
        {
            status: 503,
            connection: "close",
            body: { error: "stopping", message: "Izbor is stopping" },
        },
    );
    for (const { held, stream } of holds) {
        assert.equal(await held.exited, 0);
        assert.deepEqual(stream.events.at(-1), {
            type: "session",
            sessionId: stream.latest().sessionId,
            state: "stopped",
            why: "izbor stopping",
        });
    }
    assert.equal(holds[0]!.held.stdout(), "");
    assert.equal(holds[1]!.held.stdout(), "200");
    await until(() => stopped);
});

test("after a Izbor restart the running Izbor holds nothing and never received the pending Request: answerable reads `not running when it asked`, true of it, and an answer gets `not_answerable`", async (t) => {
    const first = await heldRequest(t);
    await first.izbor.stop();
    assert.equal(await first.held.exited, 0);
    assert.equal(first.held.stdout(), "");

    const izbor = await startIzborServer(t, { ...waitingSession("/repo"), port: first.izbor.port });
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await postHook(izbor.base, "Notification", { cwd: first.acting, notification_type: "permission_prompt" });
    await until(() => stream.latest().needsYou.state === "unknown" && stream.latest().answerable !== null);

    assert.deepEqual(stream.latest().needsYou, {
        state: "unknown",
        at: RECEIVED_AT.toISOString(),
        waitingFor: "permission prompt",
    });
    assert.equal(stream.latest().answerable, "not running when it asked");
    const key = await readSendKey(izbor.info.sendKeyPath);
    assert.notEqual(key, first.key);
    const answer = { at: stream.latest().needsYou.at!, answer: "yes" };
    assert.deepEqual(await createIzborClient({ port: izbor.port }).sendAnswer(SESSION, answer, key), {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: Izbor was not running when it asked.",
        answerable: "not running when it asked",
    });
});

test("two senders, as two terminal app windows, answer the same held request at once: one answer is sent, the other hears `already_answered`, and the hook gets that one decision, never a second", async (t) => {
    const { izbor, held, at, key } = await heldRequest(t);
    const clients = [createIzborClient({ port: izbor.port }), createIzborClient({ port: izbor.port })];

    const results = await Promise.all(
        clients.map((client, i) => client.sendAnswer(SESSION, { at, answer: i === 0 ? "yes" : "no" }, key)),
    );

    const sent = results.filter((result) => "sent" in result);
    assert.equal(sent.length, 1, JSON.stringify(results));
    assert.deepEqual(
        results.filter((result) => "refused" in result),
        [{ refused: 409, error: "already_answered", message: "That request has an answer already." }],
    );
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), sent[0]!.sent === "yes" ? ALLOW : DENY_INTERRUPT);
    assert.equal(izbor.izbor.printed().filter((line) => line.includes(" sent ")).length, 1);
});

test("a hold left behind by a request that replaced it in Needs you without being held, a plan approval, is let go by the evidence that then clears Needs you", async (t) => {
    const { izbor, listed, acting, stream, held } = await heldRequest(t);
    const plan = { tool_name: "ExitPlanMode", tool_input: { plan: "1. Edit the router" } };

    await postHook(izbor.base, "PermissionRequest", { ...plan, cwd: acting });
    await until(() => stream.latest().answerable === "plan approval not supported");
    listed.agents[0]!.status = "busy";
    await postHook(izbor.base, "PostToolUse", { ...plan, cwd: acting, tool_response: { plan: plan.tool_input.plan } });

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await until(() => stream.latest().needsYou.state === "nothing" && stream.latest().answerable === null);
});

async function requestWhileUnwatched(
    t: TestContext,
    izbor: Awaited<ReturnType<typeof startIzborServer>>,
    acting: string,
    request: object = BASH,
    entry: ExecHookEntry = answerEntry(izbor.port),
) {
    const answerHooks = () => izbor.requests.filter(({ path }) => path === "/hook/answer").length;
    const before = answerHooks();
    await postHook(izbor.base, "PermissionRequest", { ...request, cwd: acting });
    const held = runHookEntry(t, entry, hook("PermissionRequest", { ...request, cwd: acting }));
    await until(() => answerHooks() > before);
    return held;
}

test("seam 1: a Request made before the watch start, in an acting project, is held while nobody watches the session, and nothing about it is written; the watch start shows it at once, answerable, and `yes` allows it", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);

    const held = await requestWhileUnwatched(t, izbor, acting);
    assert.deepEqual(await izbor.izbor.files(), []);

    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    const [snapshot] = stream.briefs();
    assert.deepEqual(snapshot!.needsYou, {
        state: "request",
        at: RECEIVED_AT.toISOString(),
        agentId: null,
        tool: "Bash",
        input: BASH.tool_input,
    });
    assert.equal(snapshot!.answerable, true);
    assert.equal(held.running(), true);

    const key = await readSendKey(izbor.info.sendKeyPath);
    const client = createIzborClient({ port: izbor.port });
    assert.deepEqual(await client.sendAnswer(SESSION, { at: snapshot!.needsYou.at!, answer: "yes" }, key), {
        sent: "yes",
    });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
    await until(() => stream.latest().answerable === "answered");
});

test("seam 1: the Status reading at the watch start shows the Request made before it is over: Needs you clears, and the hold is let go with no decision", async (t) => {
    const listed = waitingSession("/repo");
    const izbor = await startIzborServer(t, listed);
    const acting = await actingProject(t, izbor.port);
    const held = await requestWhileUnwatched(t, izbor, acting);

    listed.agents[0]!.status = "busy";
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);

    const [snapshot] = stream.briefs();
    assert.deepEqual(snapshot!.needsYou, { state: "nothing", at: RECEIVED_AT.toISOString() });
    assert.equal(snapshot!.answerable, null);
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
});

test("an unwatched session's hold is let go, with no decision, by the evidence hook that shows its request over, and replaced by a newer request's hold; the watch start then shows the newer request", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const first = await requestWhileUnwatched(t, izbor, acting);

    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });
    assert.equal(await first.exited, 0);
    assert.equal(first.stdout(), "");

    const next = { tool_name: "Bash", tool_input: { command: "echo next > next.txt" } };
    const second = await requestWhileUnwatched(t, izbor, acting, next);
    const later = { tool_name: "Bash", tool_input: { command: "echo later > later.txt" } };
    const third = await requestWhileUnwatched(t, izbor, acting, later);
    assert.equal(await second.exited, 0);
    assert.equal(second.stdout(), "");

    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    const [snapshot] = stream.briefs();
    assert.deepEqual(snapshot!.needsYou, {
        state: "request",
        at: RECEIVED_AT.toISOString(),
        agentId: null,
        tool: "Bash",
        input: later.tool_input,
    });
    assert.equal(snapshot!.answerable, true);
    assert.equal(third.running(), true);
});

test("when Claude Code ends an unwatched session's held hook (Esc, the session's exit), Izbor drops it: a watch start while the session still waits shows the kept request with answerable `expired`, and an answer gets that reason", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const held = await requestWhileUnwatched(t, izbor, acting);

    held.kill();
    assert.notEqual(await held.exited, 0);

    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await until(() => stream.latest().answerable === "expired");
    assert.equal(stream.latest().needsYou.state, "request");
    const key = await readSendKey(izbor.info.sendKeyPath);
    const answer = { at: stream.latest().needsYou.at!, answer: "yes" };
    assert.deepEqual(await createIzborClient({ port: izbor.port }).sendAnswer(SESSION, answer, key), {
        refused: 409,
        error: "not_answerable",
        message: "Answer it in the session: Izbor is no longer holding this request.",
        answerable: "expired",
    });
});

test("the Izbor stop lets go of an unwatched session's held answer hook too, with the empty reply before any connection is cut", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const held = await requestWhileUnwatched(t, izbor, acting, BASH, statusPrinting(izbor.port));

    await izbor.stop();

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "200");
});

test("a watch stop keeps the hold for the now unwatched session: the next watch start shows the request kept from its hook, answerable, and `yes` allows it", async (t) => {
    const clock = fakeClock();
    const { izbor, stream, held, client, key } = await heldRequest(t, BASH, clock.wait);

    await stream.leave();
    const listeners = async () =>
        ((await (await fetch(`${izbor.base}/sessions`)).json()) as { sessions: { listeners: number }[] }).sessions;
    await until(async () => (await listeners()).every(({ listeners }) => listeners === 0));
    await clock.advance(30_000);
    await until(() => izbor.izbor.printed().includes(`stopped watching ${SESSION} (no listener)`));

    const again = await tuneInOverHttp(t, izbor.port, SESSION);
    const [snapshot] = again.briefs();
    assert.deepEqual(snapshot!.needsYou, {
        state: "request",
        at: RECEIVED_AT.toISOString(),
        agentId: null,
        tool: "Bash",
        input: BASH.tool_input,
    });
    assert.equal(snapshot!.answerable, true);
    assert.deepEqual(await client.sendAnswer(SESSION, { at: snapshot!.needsYou.at!, answer: "yes" }, key), {
        sent: "yes",
    });
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
});

test("while nobody watches, a subagent's request is neither held nor kept, and a request of a project without the answer hook is not kept: the watch start then reads `unknown` with `waitingFor`", async (t) => {
    const izbor = await startIzborServer(t, waitingSession("/repo"));
    const acting = await actingProject(t, izbor.port);
    const subagent = { ...BASH, cwd: acting, agent_id: "af3f12f733bb2dea5", agent_type: "general-purpose" };
    await postHook(izbor.base, "PermissionRequest", subagent);
    const held = runHookEntry(t, answerEntry(izbor.port), hook("PermissionRequest", subagent));
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    await postHook(izbor.base, "PermissionRequest", { ...BASH, cwd: "/repo" });
    assert.deepEqual(await izbor.izbor.files(), []);

    const stream = await tuneInOverHttp(t, izbor.port, SESSION);

    const [snapshot] = stream.briefs();
    assert.deepEqual(snapshot!.needsYou, {
        state: "unknown",
        at: RECEIVED_AT.toISOString(),
        waitingFor: "permission prompt",
    });
});

test("at the hold limit an unwatched session's hold is let go with no decision, and a watch start then reads `expired`", async (t) => {
    const clock = fakeClock();
    const izbor = await startIzborServer(t, { ...waitingSession("/repo"), wait: clock.wait });
    const acting = await actingProject(t, izbor.port);
    const held = await requestWhileUnwatched(t, izbor, acting);

    await clock.advance(HOLD_LIMIT_MS - 1000);
    assert.equal(held.running(), true);
    await clock.advance(1000);

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), "");
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await until(() => stream.latest().answerable === "expired");
});

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { answerHookEntry } from "../src/adapters/agents/claude/setup/answerHook.js";
import { createIzborClient, type IzborClient } from "../src/adapters/izbor/client.js";
import { createSampleWorld, SAMPLE_IDS } from "./helpers/sampleSessions.js";
import { COLLECT_LIMIT_MS } from "../src/domain/prompt.js";
import type { PromptEvent } from "../src/domain/streamEvent.js";
import { answering, REASON_HOLDS_MS, STILL_WAITS_MS } from "../src/terminal/live/answers.js";
import { sentPrompts } from "../src/terminal/live/prompts.js";
import { createLiveStore } from "../src/terminal/main.js";
import type { Observation, ObservationSource, TerminalBrief } from "../src/terminal/model.js";
import { NO_PLUGIN_HERE } from "../src/terminal/reply.js";
import { actingProject, ALLOW, BASH, HOOK_RUNNER, readSendKey, runHookEntry } from "./helpers/answerHook.js";
import { pluginPrompts, postHook } from "./helpers/izborPrompts.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { rowOf, storeContract } from "./helpers/storeContract.js";
import { type AgentsListEntry, agentsList, fakeClock, hook, OTHER_SESSION, SESSION, settle, until } from "./support.js";

async function liveOnIzbor(
    t: TestContext,
    readKey: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
) {
    const agents: AgentsListEntry[] = [
        { sessionId: SESSION, cwd: "/repo", status: "waiting", waitingFor: "permission prompt" },
    ];
    const izbor = await startIzborServer(t, { agents });
    const source = createLiveStore({
        client: createIzborClient({ port: izbor.port }),
        izbor: izbor.info,
        port: izbor.port,
        run: async () => agentsList(agents),
        platform: hostPlatform(),
        env: {},
        readKey,
    });
    t.after(() => source.dispose());
    return { izbor, source, agents };
}

async function heldInWindow(t: TestContext, readKey?: (path: string) => Promise<string>) {
    const live = await liveOnIzbor(t, readKey);
    const acting = await actingProject(t, live.izbor.port);
    live.source.observe(SESSION);
    await until(() => rowOf(live.source)?.connection.state === "live");
    await postHook(live.izbor.base, "PermissionRequest", { ...BASH, cwd: acting });
    const held = runHookEntry(
        t,
        answerHookEntry(HOOK_RUNNER, live.izbor.port),
        hook("PermissionRequest", { ...BASH, cwd: acting }),
    );
    await until(() => rowOf(live.source)?.brief?.answerable === true);
    const needsYou = rowOf(live.source)!.brief!.needsYou;
    assert.ok(needsYou.state === "request" && needsYou.at !== undefined);
    return { ...live, acting, held, at: needsYou.at };
}

storeContract("the live store with its layer that answers, on a test Izbor", async (t) => ({
    source: (await liveOnIzbor(t)).source,
    id: SESSION,
}));

test("seam 2: yes through the live store's answer call allows the request a test Izbor holds; the row keeps what was sent, and Needs you clears only on evidence", async (t) => {
    const { izbor, source, held, at, acting, agents } = await heldInWindow(t);
    const before = rowOf(source)!.brief!.needsYou;

    assert.deepEqual(await source.answer(SESSION, { at, answer: " Yes " }), { sent: "yes" });
    const { sent } = rowOf(source)!;
    assert.deepEqual({ at: sent?.at, text: sent?.text }, { at, text: "yes" });
    assert.ok(Number.isFinite(Date.parse(sent!.sentAt)));

    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
    await until(() => rowOf(source)?.brief?.answerable === "answered");
    assert.deepEqual(rowOf(source)!.brief!.needsYou, before, "Needs you still holds the request");

    agents[0]!.status = "busy";
    delete agents[0]!.waitingFor;
    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });
    await until(() => rowOf(source)?.brief?.needsYou.state === "nothing");
    assert.equal(rowOf(source)!.brief!.answerable, undefined);
});

test("seam 2: no and words go as typed; the row shows them as typed, where Izbor's own word drops the comma", async (t) => {
    const { source, held, at } = await heldInWindow(t);
    const typed = "no, run only the export tests";
    assert.deepEqual(await source.answer(SESSION, { at, answer: typed }), { sent: typed });
    assert.equal(rowOf(source)!.sent?.text, typed);
    assert.equal(await held.exited, 0);
    assert.match(held.stdout(), /"behavior":"deny","message":"The user said no in Izbor: run only the export tests"/);
});

test("seam 2: each refusal code of the answer route is one sentence on the field's line, and the hook still holds", async (t) => {
    const { source, held, at } = await heldInWindow(t);
    const answer = (id: string, body: { at: string; answer: string }) => source.answer(id, body);

    assert.deepEqual(await answer(SESSION, { at, answer: "yse" }), { refused: "Type yes, no, or no and your words." });
    assert.deepEqual(await answer(SESSION, { at: "2026-10-01T11:00:00.000Z", answer: "yes" }), {
        refused: "That request is over or changed: check the Brief.",
    });
    assert.deepEqual(await answer(OTHER_SESSION, { at, answer: "yes" }), {
        refused: "Izbor is not watching this session: nothing was sent.",
    });
    assert.equal(rowOf(source)!.sent, undefined, "a refusal is not a sent answer");
    assert.equal(held.running(), true);
    assert.equal(held.stdout(), "");

    assert.deepEqual(await answer(SESSION, { at, answer: "yes" }), { sent: "yes" });
    assert.deepEqual(await answer(SESSION, { at, answer: "no" }), { refused: "That request has an answer already." });
    assert.equal(rowOf(source)!.sent?.text, "yes", "the row keeps the answer that went");
    assert.equal(await held.exited, 0);
    assert.equal(held.stdout(), ALLOW);
});

test("seam 2: 409 not_answerable carries Izbor's reason: a request in a project without the answer hook", async (t) => {
    const { izbor, source } = await liveOnIzbor(t);
    source.observe(SESSION);
    await until(() => rowOf(source)?.connection.state === "live");
    await postHook(izbor.base, "PermissionRequest", BASH);
    await until(() => rowOf(source)?.brief?.answerable === "not an acting project");
    const needsYou = rowOf(source)!.brief!.needsYou;
    assert.ok(needsYou.state === "request" && needsYou.at !== undefined);
    assert.deepEqual(await source.answer(SESSION, { at: needsYou.at, answer: "yes" }), {
        refused: "Answer it in the session: this project has no plugin.",
    });
});

const WAITING = createSampleWorld().row(SAMPLE_IDS[1]);
const AT = (WAITING.brief!.needsYou as { at: string }).at;
type Sent = Awaited<ReturnType<IzborClient["sendAnswer"]>>;
type Collected = Awaited<ReturnType<IzborClient["sendPrompt"]>>;

const waiting = (answerable: TerminalBrief["answerable"]): Observation => {
    const { answerable: _held, ...brief } = WAITING.brief!;
    return { ...WAITING, brief: { ...brief, ...(answerable !== undefined && { answerable }) } };
};

function layer(
    t: TestContext,
    reply: (answer: string, key: string) => Sent = () => ({ sent: "yes" }),
    keyPath?: string,
) {
    const clock = fakeClock(Date.parse("2026-10-09T12:00:00.000Z"));
    const store = createFakeStore({ observations: [waiting(true)] });
    const posted: { id: string; at: string; answer: string; key: string }[] = [];
    let key = "k3y\n";
    const source = answering(store, {
        client: {
            async sendAnswer(id, { at, answer }, sentKey) {
                posted.push({ id, at, answer, key: sentKey });
                return reply(answer, sentKey);
            },
            sendPrompt: async () => ({ away: "not running" }),
        },
        keyPath: keyPath ?? "/home/me/.config/izbor/send-key-4319",
        readKey: async () => key,
        wait: clock.wait,
        now: clock.now,
        prompts: sentPrompts(),
    });
    t.after(() => source.dispose());
    const say = (row: Observation) => store.set({ observations: [row] });
    return { clock, store, source, posted, say, newKey: (next: string) => (key = next) };
}
const shown = (source: ObservationSource) => rowOf(source, SAMPLE_IDS[1])!;

test("an answer goes to Izbor once, with the request's time and the key as its file holds it now", async (t) => {
    const { source, posted, newKey } = layer(t);
    assert.deepEqual(await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" }), { sent: "yes" });
    newKey("n3w\n");
    await source.answer(SAMPLE_IDS[1].toUpperCase(), { at: AT, answer: "yes" });
    assert.deepEqual(posted, [
        { id: SAMPLE_IDS[1], at: AT, answer: "yes", key: "k3y" },
        { id: SAMPLE_IDS[1], at: AT, answer: "yes", key: "n3w" },
    ]);
});

test("the row has what was sent before the answer's promise resolves, and onChange fires for it", async (t) => {
    const { source, clock } = layer(t);
    let fired = 0;
    source.onChange(() => fired++);
    const before = source.getSnapshot();
    const answer = await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    assert.deepEqual(answer, { sent: "yes" });
    assert.deepEqual(shown(source).sent, { at: AT, text: "yes", sentAt: clock.now().toISOString() });
    assert.equal(fired, 1);
    assert.notEqual(source.getSnapshot(), before);
    assert.equal(source.getSnapshot(), source.getSnapshot(), "the same object while nothing changes");
});

test("5 s after a send, while the same request still waits, the row's answer is marked stillWaits; not before", async (t) => {
    const { source, clock, say } = layer(t);
    await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    say(waiting("answered"));
    await clock.advance(STILL_WAITS_MS - 1);
    assert.equal(shown(source).sent?.stillWaits, undefined);
    await clock.advance(1);
    assert.equal(shown(source).sent?.stillWaits, true);
    assert.equal(shown(source).brief?.answerable, "answered");
});

test("an answer Claude Code took is never marked: Needs you cleared, or holds another request, when the 5 s are over", async (t) => {
    const cleared = layer(t);
    await cleared.source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    cleared.say({ ...WAITING, brief: { ...WAITING.brief!, needsYou: { state: "nothing" } } });
    await cleared.clock.advance(STILL_WAITS_MS);
    assert.equal(shown(cleared.source).sent?.stillWaits, undefined);

    const next = layer(t);
    await next.source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    const other = { ...WAITING.brief!.needsYou, at: "2026-10-09T12:00:03.000Z" } as TerminalBrief["needsYou"];
    next.say({ ...WAITING, brief: { ...WAITING.brief!, needsYou: other } });
    await next.clock.advance(STILL_WAITS_MS);
    assert.equal(shown(next.source).sent?.stillWaits, undefined);
});

test("the 5 s warning needs a live row: a brief of a stream that dropped marks nothing, and the row back live with the same request is marked then", async (t) => {
    const dropped = { state: "disconnected", since: "2026-10-09T12:00:01.000Z" } as const;
    const { source, clock, say } = layer(t);
    await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    say({ ...waiting("answered"), connection: dropped });
    await clock.advance(STILL_WAITS_MS);
    assert.equal(shown(source).sent?.stillWaits, undefined, "the last brief before the drop is no evidence");
    say({ ...waiting("answered"), connection: { state: "catching up" } });
    assert.equal(shown(source).sent?.stillWaits, undefined, "nor is it while the stream catches up");
    say(waiting("answered"));
    assert.equal(shown(source).sent?.stillWaits, true, "a live brief with the same request is evidence again");
    say({ ...waiting("answered"), connection: dropped });
    assert.equal(shown(source).sent?.stillWaits, true, "what was seen stays said");

    const took = layer(t);
    await took.source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" });
    took.say({ ...waiting("answered"), connection: dropped });
    await took.clock.advance(STILL_WAITS_MS);
    took.say({ ...WAITING, brief: { ...WAITING.brief!, needsYou: { state: "nothing" } } });
    assert.equal(shown(took.source).sent?.stillWaits, undefined, "back live with Needs you clear: never marked");
});

test("a 200 whose body has no string sent is not a sent answer: Izbor replied, so the hook may be let go, and the line says to check the Brief", async (t) => {
    for (const body of [{}, { sent: 1 }, { ok: true }, null, "yes"]) {
        const { source, clock } = layer(t, () => body as never);
        assert.deepEqual(await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" }), {
            refused: "Izbor gave no reply: check the Brief before you answer again.",
        });
        await clock.advance(STILL_WAITS_MS);
        assert.equal(shown(source).sent, undefined, JSON.stringify(body));
    }
});

test("a refusal or a Izbor that is away is one sentence, and the row keeps no sent answer", async (t) => {
    const cases: [Sent, string][] = [
        [{ away: "stopping" }, "Izbor is stopping: nothing was sent."],
        [{ away: "not running" }, "Izbor is not running: nothing was sent."],
        [{ away: "not answering" }, "Izbor gave no reply: check the Brief before you answer again."],
        [
            { refused: 404, error: "not_watched", message: "x is not watched" },
            "Izbor is not watching this session: nothing was sent.",
        ],
        [
            { refused: 409, error: "already_answered", message: "That request has an answer already." },
            "That request has an answer already.",
        ],
        [
            { refused: 500, message: "Izbor answered 500 Internal Server Error" },
            "Izbor answered 500 Internal Server Error.",
        ],
    ];
    for (const [reply, sentence] of cases) {
        const { source } = layer(t, () => reply);
        assert.deepEqual(await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" }), { refused: sentence });
        assert.equal(shown(source).sent, undefined, sentence);
    }
});

test("an older Izbor has no answer route: the layer refuses and asks it nothing", async (t) => {
    const clock = fakeClock();
    let asked = 0;
    const source = answering(createFakeStore({ observations: [waiting(true)] }), {
        client: {
            sendAnswer: async () => (asked++, { sent: "yes" }),
            sendPrompt: async () => (asked++, { collected: "p1" }),
        },
        keyPath: undefined,
        readKey: async () => "k3y",
        wait: clock.wait,
        now: clock.now,
        prompts: sentPrompts(),
    });
    t.after(() => source.dispose());
    assert.deepEqual(await source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" }), {
        refused: "This Izbor is older than the app: it takes no answers.",
    });
    assert.deepEqual(await source.prompt(SAMPLE_IDS[1], "go on"), {
        refused: "This Izbor is older than the app: it takes no prompts.",
    });
    assert.equal(asked, 0);
});

test("a reason that may last a moment shows only once it has held: not running when it asked, then true, never shows", async (t) => {
    const { source, clock, say } = layer(t);
    const seen: TerminalBrief["answerable"][] = [];
    source.onChange(() => seen.push(shown(source).brief?.answerable));
    say(waiting("not running when it asked"));
    assert.equal(shown(source).brief?.answerable, undefined, "Izbor has not said, as far as the screen knows");
    assert.deepEqual(shown(source).brief?.needsYou, WAITING.brief!.needsYou, "the request itself shows at once");
    await clock.advance(5);
    say(waiting(true));
    await clock.advance(REASON_HOLDS_MS);
    assert.deepEqual(seen, [undefined, true]);
});

test("a momentary reason that holds shows after the moment, and expired is held back the same way", async (t) => {
    for (const reason of ["not running when it asked", "expired"] as const) {
        const { source, clock, say } = layer(t);
        say(waiting(reason));
        await clock.advance(REASON_HOLDS_MS - 1);
        assert.equal(shown(source).brief?.answerable, undefined, reason);
        say(waiting(reason));
        await clock.advance(1);
        assert.equal(shown(source).brief?.answerable, reason);
        say(waiting(reason));
        assert.equal(shown(source).brief?.answerable, reason, "it stays shown");
    }
});

const unseen = (answerable: TerminalBrief["answerable"], at = "2026-10-09T11:59:58.000Z"): Observation => {
    const row = waiting(answerable);
    return { ...row, brief: { ...row.brief!, needsYou: { state: "unknown", waitingFor: "permission prompt", at } } };
};

test("a wait Izbor saw no request for is plain unknown until its reason has held: when the request comes within the moment, the line never shows", async (t) => {
    const { source, clock, say } = layer(t);
    const seen: TerminalBrief[] = [];
    source.onChange(() => seen.push(shown(source).brief!));
    say(unseen("not running when it asked"));
    assert.deepEqual(shown(source).brief?.needsYou, { state: "unknown" }, "no name: nothing to answer here yet");
    assert.equal(shown(source).brief?.answerable, undefined);
    await clock.advance(5);
    say(waiting("not running when it asked"));
    await clock.advance(5);
    say(waiting(true));
    await clock.advance(REASON_HOLDS_MS);
    assert.deepEqual(
        seen.map(({ needsYou, answerable }) => [needsYou.state, answerable]),
        [
            ["unknown", undefined],
            ["request", undefined],
            ["request", true],
        ],
    );
});

test("a wait Izbor saw no request for shows with its reason once the reason has held, and another wait starts its own moment", async (t) => {
    const { source, clock, say } = layer(t);
    const wait = unseen("not running when it asked");
    say(wait);
    await clock.advance(REASON_HOLDS_MS - 1);
    assert.deepEqual(shown(source).brief?.needsYou, { state: "unknown" });
    say(wait);
    await clock.advance(1);
    assert.deepEqual(shown(source).brief, wait.brief);
    say(unseen("not running when it asked", "2026-10-09T12:00:09.000Z"));
    assert.deepEqual(shown(source).brief?.needsYou, { state: "unknown" }, "the next wait's reason has not held yet");
    const pluginless = unseen("not an acting project");
    say(pluginless);
    assert.deepEqual(shown(source).brief, pluginless.brief);
});

test("every other reason shows at once, and a new request starts its own moment", async (t) => {
    const { source, clock, say } = layer(t);
    for (const reason of [
        "answered",
        "plan approval not supported",
        "question not supported",
        "not an acting project",
        "subagent wait over",
    ] as const) {
        say(waiting(reason));
        assert.equal(shown(source).brief?.answerable, reason);
    }
    say(waiting("expired"));
    await clock.advance(REASON_HOLDS_MS);
    assert.equal(shown(source).brief?.answerable, "expired");
    const next = waiting("expired");
    next.brief = { ...next.brief!, needsYou: { ...next.brief!.needsYou, at: "2026-10-09T12:00:09.000Z" } as never };
    say(next);
    assert.equal(shown(source).brief?.answerable, undefined, "the next request's reason has not held yet");
});

async function promptWindow(
    t: TestContext,
    { status = "idle", readKey = (path: string) => readFile(path, "utf8") } = {},
) {
    const clock = fakeClock();
    const agents: AgentsListEntry[] = [{ sessionId: SESSION, cwd: "/repo", status }];
    const izbor = await startIzborServer(t, { agents, wait: clock.wait });
    const acting = await actingProject(t, izbor.port);
    const source = createLiveStore({
        client: createIzborClient({ port: izbor.port }),
        izbor: izbor.info,
        port: izbor.port,
        run: async () => agentsList(agents),
        platform: hostPlatform(),
        env: {},
        readKey,
    });
    t.after(() => source.dispose());
    source.observe(SESSION);
    await until(() => rowOf(source)?.connection.state === "live");
    await postHook(izbor.base, "UserPromptSubmit", { cwd: acting, prompt: "hello" });
    await until(() => rowOf(source)?.brief?.task?.text === "hello");
    const plugin = pluginPrompts(izbor, await readSendKey(izbor.info.sendKeyPath));
    const poll = async () => {
        const polled = await plugin.poll();
        assert.equal(polled.status, 200);
        return (await polled.json()) as { promptId: string; text: string };
    };
    const report = async (promptId: string, state: "delivered" | "dropped", reason?: string) => {
        const reported = await plugin.report(promptId, state, reason === undefined ? {} : { reason });
        assert.equal(reported.status, 200);
        await reported.text();
    };
    return { izbor, source, agents, acting, clock, poll, polls: plugin.polled, report };
}

test("seam 2: a prompt through the live store's prompt call reaches the plugin's poll of a test Izbor, once; the row keeps what was sent, and its line is over when Izbor sees the new turn", async (t) => {
    const { izbor, source, agents, acting, poll, polls, report } = await promptWindow(t);
    const collecting = poll();
    await polls(1);
    let fired = 0;
    source.onChange(() => fired++);

    assert.deepEqual(await source.prompt(SESSION, "run the tests again"), { sent: "run the tests again" });
    const collected = await collecting;
    assert.equal(collected.text, "run the tests again");
    const { prompt } = rowOf(source)!;
    assert.deepEqual(
        { id: prompt?.id, text: prompt?.text, state: prompt?.state },
        { id: collected.promptId, text: "run the tests again", state: "sent" },
        "the row has it when the promise resolves",
    );
    assert.ok(Number.isFinite(Date.parse(prompt!.sentAt)));
    assert.ok(fired >= 1, "onChange fired for it");
    assert.deepEqual(
        izbor.requests.filter((r) => r.method === "POST" && r.path.endsWith("/prompts")).length,
        1,
        "one POST: nothing is tried again",
    );
    assert.deepEqual(
        izbor.requests.filter((r) => r.path.endsWith("/answer")),
        [],
        "never the answer route",
    );

    await report(collected.promptId, "delivered");
    await settle();
    assert.equal(rowOf(source)?.prompt?.state, "sent");
    agents[0]!.status = "busy";
    await postHook(izbor.base, "UserPromptSubmit", { cwd: acting, prompt: "run the tests again" });
    await until(() => rowOf(source)?.brief?.status === "busy");
    assert.equal(rowOf(source)?.prompt, undefined);
    assert.equal(rowOf(source)?.brief?.task?.text, "run the tests again", "the Brief has the evidence now");
});

test("seam 2: a prompt sent while Claude is busy is queued until the prompt event says delivered, which is when the turn ended", async (t) => {
    const { source, poll, polls, report } = await promptWindow(t, { status: "busy" });
    await until(() => rowOf(source)?.brief?.status === "busy");
    const collecting = poll();
    await polls(1);
    assert.deepEqual(await source.prompt(SESSION, "also add a test"), { sent: "also add a test" });
    const { promptId } = await collecting;
    assert.equal(rowOf(source)?.prompt?.state, "queued");
    await report(promptId, "delivered");
    await until(() => rowOf(source)?.prompt === undefined);
});

test("seam 2: the prompt event of a dropped prompt marks the row's prompt dropped, with the plugin's reason", async (t) => {
    const { source, poll, polls, report } = await promptWindow(t);
    const collecting = poll();
    await polls(1);
    await source.prompt(SESSION, "also add a test");
    const { promptId } = await collecting;
    await report(promptId, "dropped", "the prompt was removed from the queue before it ran");
    await until(() => rowOf(source)?.prompt?.state === "dropped");
    assert.deepEqual(rowOf(source)!.prompt, {
        id: promptId,
        text: "also add a test",
        sentAt: rowOf(source)!.prompt!.sentAt,
        state: "dropped",
        reason: "the prompt was removed from the queue before it ran",
    });
});

test("seam 2: each refusal code of the prompt route is one sentence on the field's line, and the row keeps no prompt", async (t) => {
    const { izbor, source, agents, clock, acting, poll, polls, report } = await promptWindow(t);
    const refused = async (id: string, text: string, sentence: string) => {
        assert.deepEqual(await source.prompt(id, text), { refused: sentence });
        assert.equal(rowOf(source)?.prompt, undefined, sentence);
    };
    await refused(SESSION, "   ", "The prompt is empty.");
    await refused(SESSION, " /clear", "Run slash commands in the session.");
    await refused(OTHER_SESSION, "go on", "Izbor is not watching this session: nothing was sent.");
    let withdrawn = false;
    const unheard = source.prompt(SESSION, "go on").finally(() => (withdrawn = true));
    await until(async () => {
        await clock.advance(COLLECT_LIMIT_MS);
        return withdrawn;
    });
    assert.deepEqual(await unheard, {
        refused: "Type /reload-plugins in this session once to send messages from here.",
    });
    assert.equal(rowOf(source)?.prompt, undefined);
    Object.assign(agents[0]!, { status: "waiting", waitingFor: "permission prompt" });
    await postHook(izbor.base, "PermissionRequest", { ...BASH, cwd: acting });
    await until(() => rowOf(source)?.brief?.needsYou.state === "request");
    await refused(SESSION, "go on", "Answer the request first.");
    agents[0] = { sessionId: SESSION, cwd: "/repo", status: "idle" };
    await postHook(izbor.base, "PostToolUse", { ...BASH, cwd: acting, tool_response: {} });
    await until(() => rowOf(source)?.brief?.needsYou.state === "nothing");
    const collecting = poll();
    await polls(1);
    assert.deepEqual(await source.prompt(SESSION, "first"), { sent: "first" });
    assert.deepEqual(await source.prompt(SESSION, "second"), {
        refused: "A prompt for this session waits already.",
    });
    assert.equal(rowOf(source)?.prompt?.text, "first", "the row keeps the prompt that went");
    await report((await collecting).promptId, "delivered");
});

test("seam 2: 409 not_acting, a prompt to a session in a project without the plugin, is the window's sentence, naming Home's cue", async (t) => {
    const { izbor, source } = await promptWindow(t);
    await postHook(izbor.base, "UserPromptSubmit", { cwd: "/repo", prompt: "elsewhere" });
    await until(() => rowOf(source)?.brief?.task?.text === "elsewhere");
    assert.deepEqual(await source.prompt(SESSION, "go on"), {
        refused: NO_PLUGIN_HERE,
    });
});

test("seam 2: a key Izbor does not take (401 unauthorized) and a key file that cannot be read each refuse an answer or a prompt in one sentence: nothing was sent, and a held hook still holds", async (t) => {
    const keys: [string, (path: string) => Promise<string>, string][] = [
        ["a wrong key", async () => "0".repeat(64), "Izbor refused this window's send key: nothing was sent."],
        [
            "an unreadable key",
            async () => {
                throw new Error("ENOENT");
            },
            "Izbor's send key could not be read: nothing was sent.",
        ],
    ];
    for (const [what, readKey, refused] of keys) {
        const answering = await heldInWindow(t, readKey);
        assert.deepEqual(
            await answering.source.answer(SESSION, { at: answering.at, answer: "yes" }),
            { refused },
            `answer, ${what}`,
        );
        assert.equal(rowOf(answering.source)?.sent, undefined, `answer, ${what}`);
        assert.equal(answering.held.running(), true, `answer, ${what}`);

        const prompting = await promptWindow(t, { readKey });
        assert.deepEqual(await prompting.source.prompt(SESSION, "go on"), { refused }, `prompt, ${what}`);
        assert.equal(rowOf(prompting.source)?.prompt, undefined, `prompt, ${what}`);
    }
});

const IDLE = createSampleWorld().row(SAMPLE_IDS[2]);
const BUSY = createSampleWorld().row(SAMPLE_IDS[0]);

function promptLayer(
    t: TestContext,
    row: Observation,
    reply: (text: string) => Collected = () => ({ collected: "p1" }),
) {
    const clock = fakeClock(Date.parse("2026-10-09T12:00:00.000Z"));
    const store = createFakeStore({ observations: [row] });
    const posted: { id: string; text: string; key: string }[] = [];
    let answers = 0;
    const prompts = sentPrompts();
    const source = answering(store, {
        client: {
            sendAnswer: async () => (answers++, { sent: "yes" }),
            async sendPrompt(id, { text }, key) {
                posted.push({ id, text, key });
                return reply(text);
            },
        },
        keyPath: "/home/me/.config/izbor/send-key-4319",
        readKey: async () => "k3y\n",
        wait: clock.wait,
        now: clock.now,
        prompts,
    });
    t.after(() => source.dispose());
    const say = (next: Observation) => store.set({ observations: [next] });
    const report = (promptId: string, state: PromptEvent["state"], reason?: string) =>
        prompts.reported({
            type: "prompt",
            sessionId: row.id,
            promptId,
            text: "as Izbor has it",
            state,
            ...(reason !== undefined && { reason }),
        });
    return { clock, store, source, posted, say, report, answers: () => answers };
}
const promptOf = (source: ObservationSource, id: string) => rowOf(source, id)?.prompt;

test("a prompt goes to Izbor once, as typed, with the key as its file holds it, and never as an answer; the row has it before the promise resolves", async (t) => {
    const { source, posted, clock, answers } = promptLayer(t, IDLE);
    let fired = 0;
    source.onChange(() => fired++);
    assert.deepEqual(await source.prompt(SAMPLE_IDS[2].toUpperCase(), "run the tests again"), {
        sent: "run the tests again",
    });
    assert.deepEqual(posted, [{ id: SAMPLE_IDS[2], text: "run the tests again", key: "k3y" }]);
    assert.equal(answers(), 0);
    assert.deepEqual(promptOf(source, SAMPLE_IDS[2]), {
        id: "p1",
        text: "run the tests again",
        sentAt: clock.now().toISOString(),
        state: "sent",
    });
    assert.equal(fired, 1);
    assert.equal(source.getSnapshot(), source.getSnapshot(), "the same object while nothing changes");
});

test("a prompt sent to an idle session keeps its line through the delivered report, until a brief shows the session busy or asking; then it is gone for good", async (t) => {
    const { source, say, report } = promptLayer(t, IDLE);
    await source.prompt(SAMPLE_IDS[2], "run the tests again");
    report("p1", "delivered");
    assert.equal(promptOf(source, SAMPLE_IDS[2])?.state, "sent", "delivered comes 100 ms after: the line would flash");
    say({ ...IDLE, brief: { ...IDLE.brief!, status: "busy" } });
    assert.equal(promptOf(source, SAMPLE_IDS[2]), undefined, "Izbor saw the new turn");
    say(IDLE);
    assert.equal(promptOf(source, SAMPLE_IDS[2]), undefined, "idle again after the turn: nothing comes back");

    const asking = promptLayer(t, IDLE);
    await asking.source.prompt(SAMPLE_IDS[2], "run the tests again");
    asking.say({ ...IDLE, brief: { ...WAITING.brief! } });
    assert.equal(promptOf(asking.source, SAMPLE_IDS[2]), undefined, "a request is the new turn's too");
});

test("a prompt sent to a busy session is queued until its delivered report, or until a brief shows the turn over", async (t) => {
    const delivered = promptLayer(t, BUSY);
    await delivered.source.prompt(SAMPLE_IDS[0], "also add a test");
    assert.equal(promptOf(delivered.source, SAMPLE_IDS[0])?.state, "queued");
    let fired = 0;
    delivered.source.onChange(() => fired++);
    delivered.report("p1", "delivered");
    assert.equal(promptOf(delivered.source, SAMPLE_IDS[0]), undefined);
    assert.equal(fired, 1, "the report changes the snapshot");

    const idle = promptLayer(t, BUSY);
    await idle.source.prompt(SAMPLE_IDS[0], "also add a test");
    idle.say({ ...BUSY, brief: { ...BUSY.brief!, status: "idle" } });
    assert.equal(promptOf(idle.source, SAMPLE_IDS[0]), undefined);
});

test("a dropped report marks the prompt dropped with its reason and keeps the text as typed; a report of another prompt, or of another window's, changes nothing", async (t) => {
    const { source, report } = promptLayer(t, BUSY);
    await source.prompt(SAMPLE_IDS[0], "also add a test");
    let fired = 0;
    source.onChange(() => fired++);
    report("another-windows", "dropped", "not ours");
    assert.equal(promptOf(source, SAMPLE_IDS[0])?.state, "queued");
    assert.equal(fired, 0);
    report("p1", "dropped", "the prompt was removed from the queue before it ran");
    assert.deepEqual(
        { ...promptOf(source, SAMPLE_IDS[0]), sentAt: "" },
        {
            id: "p1",
            text: "also add a test",
            sentAt: "",
            state: "dropped",
            reason: "the prompt was removed from the queue before it ran",
        },
    );
    assert.equal(fired, 1);
});

test("a dropped report still counts after the prompt's line is over: a queued prompt whose turn asked for permission, and a sent one whose next brief said busy, come back dropped with their text and reason", async (t) => {
    const WHY = "the prompt was removed from the queue before it ran";
    const queued = promptLayer(t, BUSY);
    await queued.source.prompt(SAMPLE_IDS[0], "also add a test");
    queued.say({ ...BUSY, brief: { ...BUSY.brief!, status: "waiting" } });
    assert.equal(promptOf(queued.source, SAMPLE_IDS[0]), undefined, "the line is over");
    queued.say(BUSY);
    assert.equal(promptOf(queued.source, SAMPLE_IDS[0]), undefined, "and stays over while the turn goes on");
    let fired = 0;
    queued.source.onChange(() => fired++);
    queued.report("p1", "dropped", WHY);
    assert.deepEqual(
        { ...promptOf(queued.source, SAMPLE_IDS[0]), sentAt: "" },
        { id: "p1", text: "also add a test", sentAt: "", state: "dropped", reason: WHY },
    );
    assert.equal(fired, 1, "the report changes the snapshot");

    const sent = promptLayer(t, IDLE);
    await sent.source.prompt(SAMPLE_IDS[2], "run the tests again");
    sent.say({ ...IDLE, brief: { ...IDLE.brief!, status: "busy" } });
    assert.equal(promptOf(sent.source, SAMPLE_IDS[2]), undefined);
    sent.report("p1", "dropped", WHY);
    assert.equal(promptOf(sent.source, SAMPLE_IDS[2])?.state, "dropped");
    assert.equal(promptOf(sent.source, SAMPLE_IDS[2])?.text, "run the tests again");

    const delivered = promptLayer(t, BUSY, (text) => ({ collected: text === "one" ? "p1" : "p2" }));
    await delivered.source.prompt(SAMPLE_IDS[0], "one");
    delivered.say({ ...BUSY, brief: { ...BUSY.brief!, status: "idle" } });
    delivered.report("p1", "delivered");
    assert.equal(promptOf(delivered.source, SAMPLE_IDS[0]), undefined);
    await delivered.source.prompt(SAMPLE_IDS[0], "two");
    delivered.report("p1", "dropped", WHY);
    assert.equal(
        promptOf(delivered.source, SAMPLE_IDS[0])?.state,
        "sent",
        "the old prompt's report is not the new one's",
    );
});

test("a report that comes before Izbor's collected reply counts: the prompt is dropped, or was delivered, when the row first has it", async (t) => {
    let early: () => void = () => {};
    const dropped = promptLayer(t, IDLE, () => (early(), { collected: "p1" }));
    early = () => dropped.report("p1", "dropped");
    await dropped.source.prompt(SAMPLE_IDS[2], "go on");
    assert.equal(promptOf(dropped.source, SAMPLE_IDS[2])?.state, "dropped");
    assert.equal(promptOf(dropped.source, SAMPLE_IDS[2])?.reason, undefined, "the plugin gave none");

    const queued = promptLayer(t, BUSY, () => (early(), { collected: "p1" }));
    early = () => queued.report("p1", "delivered");
    assert.deepEqual(await queued.source.prompt(SAMPLE_IDS[0], "go on"), { sent: "go on" });
    assert.equal(promptOf(queued.source, SAMPLE_IDS[0]), undefined, "the turn it waited for is over already");
});

test("a refusal, a Izbor that is away or a 200 with no prompt id is one sentence for a prompt, and the row keeps none; no reply says the prompt may have gone", async (t) => {
    const NO_REPLY = "Izbor gave no reply: check the Brief before you send again.";
    const cases: [unknown, string][] = [
        [{ away: "stopping" }, "Izbor is stopping: nothing was sent."],
        [{ away: "not running" }, "Izbor is not running: nothing was sent."],
        [{ away: "not answering" }, NO_REPLY],
        [{}, NO_REPLY],
        [{ collected: 7 }, NO_REPLY],
        [null, NO_REPLY],
        [
            { refused: 409, error: "prompt_pending", message: "A prompt for this session waits already." },
            "A prompt for this session waits already.",
        ],
        [
            { refused: 404, error: "not_watched", message: "x is not watched" },
            "Izbor is not watching this session: nothing was sent.",
        ],
        [
            { refused: 500, message: "Izbor answered 500 Internal Server Error" },
            "Izbor answered 500 Internal Server Error.",
        ],
    ];
    for (const [reply, sentence] of cases) {
        const { source } = promptLayer(t, IDLE, () => reply as Collected);
        assert.deepEqual(await source.prompt(SAMPLE_IDS[2], "go on"), { refused: sentence });
        assert.equal(promptOf(source, SAMPLE_IDS[2]), undefined, sentence);
    }
});

test("leaving a row forgets its prompt", async (t) => {
    const { source, store } = promptLayer(t, IDLE);
    await source.prompt(SAMPLE_IDS[2], "go on");
    source.leave(SAMPLE_IDS[2]);
    store.set({ observations: [IDLE] });
    assert.equal(promptOf(source, SAMPLE_IDS[2]), undefined);
});

for (const operation of ["answer", "prompt"] as const) {
    for (const phase of ["key", "request"] as const) {
        test(`disposing a pending ${operation} during its ${phase} read aborts and settles before delayed completion`, async (t) => {
            const clock = fakeClock();
            const store = createFakeStore({ observations: [WAITING, IDLE] });
            let readSignal: AbortSignal | undefined;
            let requestSignal: AbortSignal | undefined;
            let finishKey = (_key: string) => {};
            let finishRequest = () => {};
            let requests = 0;
            const source = answering(store, {
                client: {
                    sendAnswer(_id, _answer, _key, signal) {
                        requestSignal = signal;
                        requests++;
                        return new Promise((resolve) => (finishRequest = () => resolve({ sent: "yes" })));
                    },
                    sendPrompt(_id, _prompt, _key, signal) {
                        requestSignal = signal;
                        requests++;
                        return new Promise((resolve) => (finishRequest = () => resolve({ collected: "p1" })));
                    },
                },
                keyPath: "/send-key",
                readKey: (_path, signal) => {
                    readSignal = signal;
                    return phase === "key" ? new Promise((resolve) => (finishKey = resolve)) : Promise.resolve("key");
                },
                wait: clock.wait,
                now: clock.now,
                prompts: sentPrompts(),
            });
            t.after(() => source.dispose());
            let fired = 0;
            source.onChange(() => fired++);
            const pending =
                operation === "answer"
                    ? source.answer(SAMPLE_IDS[1], { at: AT, answer: "yes" })
                    : source.prompt(SAMPLE_IDS[2], "run tests");
            const aborted = assert.rejects(pending, { name: "AbortError" });
            if (phase === "request") await until(() => requests === 1);
            source.dispose();
            await aborted;
            assert.equal(readSignal?.aborted, true);
            if (phase === "request") assert.equal(requestSignal?.aborted, true);
            finishKey("key");
            finishRequest();
            await settle();
            assert.equal(requests, phase === "request" ? 1 : 0);
            assert.equal(fired, 0);
            assert.equal(
                source.getSnapshot().observations.some((row) => row.sent || row.prompt),
                false,
            );
        });
    }
}

test("completed sends release their lifetime abort listeners", async (t) => {
    const store = createFakeStore({ observations: [IDLE] });
    let lifetime: AbortSignal | undefined;
    const source = answering(store, {
        client: {
            sendAnswer: async () => ({ sent: "yes" }),
            sendPrompt: async () => ({ collected: "p1" }),
        },
        keyPath: "/send-key",
        readKey: async (_path, signal) => {
            lifetime = signal;
            return "key";
        },
        wait: async () => {},
        now: () => new Date(),
        prompts: sentPrompts(),
    });
    t.after(() => source.dispose());
    for (let send = 0; send < 12; send++) {
        await source.prompt(IDLE.id, "run tests");
        assert.ok(lifetime);
        assert.deepEqual(getEventListeners(lifetime, "abort"), []);
    }
});

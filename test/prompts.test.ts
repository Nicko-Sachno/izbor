import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECT_LIMIT_MS, POLL_LIMIT_MS, REPORT_LIMIT_MS } from "../src/domain/prompt.js";
import type { ErrorAnswer } from "../src/domain/wire.js";
import { tuneInOverHttp } from "./helpers/answerHook.js";
import { postHook, watchedSession } from "./helpers/izborPrompts.js";
import { type AgentsListEntry, fakeClock, OTHER_SESSION, RECEIVED_AT, SESSION, until } from "./support.js";
import { postInTwoPieces } from "./helpers/http.js";

test("seam 1: a prompt to a watched session in an acting project goes to the plugin's waiting poll: the route answers collected, the Izbor log has the line, and the plugin's delivered report reaches the listeners as a `prompt` event", async (t) => {
    const { izbor, stream, key, client, poll, polled, report, promptEvents } = await watchedSession(t);

    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "run the tests" }, key);
    const got = await polling;
    assert.equal(got.status, 200);
    const prompt = (await got.json()) as { promptId: string; text: string };
    assert.equal(prompt.text, "run the tests");
    assert.deepEqual(sent, { collected: prompt.promptId });
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" sent ")),
        [`${SESSION} sent prompt ${prompt.promptId} at ${RECEIVED_AT.toISOString()}: run the tests`],
    );
    assert.deepEqual(promptEvents(), []);

    const delivered = await report(prompt.promptId, "delivered");
    assert.equal(delivered.status, 200);
    assert.deepEqual(await delivered.json(), { reported: "delivered" });
    await until(() => promptEvents().length === 1);
    assert.deepEqual(stream.events.at(-1), {
        type: "prompt",
        sessionId: SESSION,
        promptId: prompt.promptId,
        text: "run the tests",
        state: "delivered",
    });
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" prompt ")),
        [
            `${SESSION} sent prompt ${prompt.promptId} at ${RECEIVED_AT.toISOString()}: run the tests`,
            `${SESSION} prompt ${prompt.promptId} delivered at ${RECEIVED_AT.toISOString()}`,
        ],
    );
});

test("the plugin's dropped report carries the reason: the `prompt` event says dropped with it, and so does the Izbor log", async (t) => {
    const { izbor, stream, key, client, poll, polled, report } = await watchedSession(t);
    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "and now?" }, key);
    const { promptId } = (await (await polling).json()) as { promptId: string };
    assert.deepEqual(sent, { collected: promptId });

    const dropped = await report(promptId, "dropped", {
        reason: "the prompt was removed from the queue before it ran",
    });
    assert.deepEqual([dropped.status, await dropped.json()], [200, { reported: "dropped" }]);
    await until(() => stream.events.some((event) => event.type === "prompt"));
    assert.deepEqual(stream.events.at(-1), {
        type: "prompt",
        sessionId: SESSION,
        promptId,
        text: "and now?",
        state: "dropped",
        reason: "the prompt was removed from the queue before it ran",
    });
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(` prompt ${promptId} dropped`)),
        [
            `${SESSION} prompt ${promptId} dropped at ${RECEIVED_AT.toISOString()}: the prompt was removed from the queue before it ran`,
        ],
    );

    const again = await report(promptId, "delivered");
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as ErrorAnswer).error, "unknown_prompt");
    const never = await report("00000000-0000-4000-8000-000000000000", "dropped", { reason: "x" });
    assert.equal(never.status, 404);
    assert.deepEqual(await never.json(), {
        error: "unknown_prompt",
        message: "00000000-0000-4000-8000-000000000000 is not a prompt Izbor handed to a plugin",
    });
});

test("a dropped report whose body is not JSON is taken, with no reason: 200 `reported`, and the `prompt` event says dropped", async (t) => {
    const { izbor, stream, key, client, bearer, poll, polled, promptEvents } = await watchedSession(t);
    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "and now?" }, key);
    const { promptId } = (await (await polling).json()) as { promptId: string };
    assert.deepEqual(sent, { collected: promptId });

    const dropped = await fetch(`${izbor.base}/prompts/${promptId}/dropped`, {
        method: "POST",
        headers: bearer,
        body: "not json",
    });

    assert.deepEqual([dropped.status, await dropped.json()], [200, { reported: "dropped" }]);
    await until(() => promptEvents().length === 1);
    assert.deepEqual(stream.events.at(-1), {
        type: "prompt",
        sessionId: SESSION,
        promptId,
        text: "and now?",
        state: "dropped",
    });
});

test("no poll within 5 s: 409 `no_plugin` with its sentence, and the prompt is withdrawn, so a later poll gets nothing", async (t) => {
    const clock = fakeClock();
    const { izbor, key, client, poll, polled } = await watchedSession(t, { wait: clock.wait });

    const sending = client.sendPrompt(SESSION, { text: "run the tests" }, key);
    await until(() => izbor.requests.some((r) => r.path.endsWith("/prompts")));
    await clock.advance(COLLECT_LIMIT_MS - 1);
    await clock.advance(1);
    assert.deepEqual(await sending, {
        refused: 409,
        error: "no_plugin",
        message: "Type /reload-plugins in this session once to send messages from here.",
    });
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" prompt ")),
        [],
    );

    const polling = poll();
    await polled(1);
    await clock.advance(POLL_LIMIT_MS - 1);
    await clock.advance(1);
    const got = await polling;
    assert.equal(got.status, 204);
    assert.equal(await got.text(), "");

    const next = poll();
    await polled(2);
    const sent = await client.sendPrompt(SESSION, { text: "run the tests" }, key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    await (await next).text();
});

test("a poll that waits gets the prompt that arrives within its 25 s, and a prompt that waits goes to the next poll at once", async (t) => {
    const clock = fakeClock();
    const { key, client, poll, polled, report } = await watchedSession(t, { wait: clock.wait });

    const polling = poll();
    await polled(1);
    await clock.advance(POLL_LIMIT_MS - 1000);
    const sent = await client.sendPrompt(SESSION, { text: "first" }, key);
    const first = (await (await polling).json()) as { promptId: string; text: string };
    assert.deepEqual([sent, first.text], [{ collected: first.promptId }, "first"]);
    await (await report(first.promptId, "delivered")).text();

    const sending = client.sendPrompt(SESSION, { text: "second" }, key);
    await until(() => clock.dueWithin(COLLECT_LIMIT_MS));
    await clock.advance(COLLECT_LIMIT_MS - 1000);
    const second = (await (await poll()).json()) as { promptId: string; text: string };
    assert.deepEqual([await sending, second.text], [{ collected: second.promptId }, "second"]);
    assert.notEqual(first.promptId, second.promptId);
});

test("without the send key, or with a wrong one, the plugin's reports answer 401 `unauthorized`", async (t) => {
    const { izbor, key } = await watchedSession(t);
    const wrongKey = key.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const routes = [
        ["POST", "/prompts/00000000-0000-4000-8000-000000000000/delivered"],
        ["POST", "/prompts/00000000-0000-4000-8000-000000000000/dropped"],
    ] as const;
    const tries: Record<string, string>[] = [{}, { authorization: `Bearer ${wrongKey}` }, { authorization: key }];
    for (const [method, path] of routes)
        for (const headers of tries) {
            const response = await fetch(`${izbor.base}${path}`, {
                method,
                headers,
                body: method === "POST" ? JSON.stringify({ text: "x", reason: "y" }) : undefined,
            });
            assert.equal(response.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
            assert.equal(((await response.json()) as ErrorAnswer).error, "unauthorized");
        }
});

test("a body Izbor cannot read, or an empty text: 400 `bad_prompt`; an unwatched session: 404 `not_watched`; a session whose project has no plugin: 409 `not_acting` naming its folder", async (t) => {
    const { izbor, key, client, bearer } = await watchedSession(t);

    for (const body of ["", "not json", "{}", '{"text": 1}', '{"prompt": "x"}']) {
        const response = await fetch(`${izbor.base}/sessions/${SESSION}/prompts`, {
            method: "POST",
            headers: bearer,
            body,
        });
        assert.equal(response.status, 400, body);
        assert.deepEqual(await response.json(), {
            error: "bad_prompt",
            message: 'Izbor could not read this as a prompt: send {"text"}',
        });
    }
    for (const text of ["", "   ", "\n"])
        assert.deepEqual(await client.sendPrompt(SESSION, { text }, key), {
            refused: 400,
            error: "bad_prompt",
            message: "The prompt is empty.",
        });

    assert.deepEqual(await client.sendPrompt(OTHER_SESSION, { text: "hi" }, key), {
        refused: 404,
        error: "not_watched",
        message: `${OTHER_SESSION} is not watched`,
    });

    const stream = await tuneInOverHttp(t, izbor.port, OTHER_SESSION);
    const plain = await mkdtemp(join(tmpdir(), "izbor-plain-"));
    t.after(() => rm(plain, { recursive: true, force: true }));
    await postHook(izbor.base, "UserPromptSubmit", { session_id: OTHER_SESSION, cwd: plain, prompt: "hey" });
    await until(() => stream.latest().task?.text === "hey");
    assert.deepEqual(await client.sendPrompt(OTHER_SESSION, { text: "hi" }, key), {
        refused: 409,
        error: "not_acting",
        message: `To answer from here, run add plugin ${plain}.`,
    });
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" prompt ")),
        [],
    );
});

test('a text that starts with `/`, after spaces or not, is 400 `bad_prompt`, "Run slash commands in the session."; a `/` elsewhere in the text is a prompt like any other', async (t) => {
    const { key, client, poll, polled } = await watchedSession(t);
    for (const text of ["/clear", "  /help", "/model opus\n"])
        assert.deepEqual(await client.sendPrompt(SESSION, { text }, key), {
            refused: 400,
            error: "bad_prompt",
            message: "Run slash commands in the session.",
        });

    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "fix src/a.ts, then run ./check" }, key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    assert.equal(((await (await polling).json()) as { text: string }).text, "fix src/a.ts, then run ./check");
});

test('while the session waits for the user, a prompt is 409 `request_pending`, "Answer the request first.": for a wait Izbor saw no request for, and for a request in Needs you; once the request is over, the prompt goes to the plugin, busy session or not', async (t) => {
    const agents: AgentsListEntry[] = [
        { sessionId: SESSION, cwd: "/repo", status: "waiting", waitingFor: "permission prompt" },
    ];
    const { izbor, acting, stream, key, client, poll, polled } = await watchedSession(t, { agents });
    const waitingFor = () => (stream.latest().needsYou as { waitingFor?: string }).waitingFor;
    await until(() => waitingFor() === "permission prompt");
    assert.equal(stream.latest().needsYou.state, "unknown");
    const refused = { refused: 409, error: "request_pending", message: "Answer the request first." };
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "and then?" }, key), refused);

    const tool = { tool_name: "Bash", tool_input: { command: "npm test" } };
    await postHook(izbor.base, "PermissionRequest", { ...tool, cwd: acting });
    await until(() => stream.latest().needsYou.state === "request");
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "and then?" }, key), refused);
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" prompt ")),
        [],
    );

    agents[0]!.status = "busy";
    delete agents[0]!.waitingFor;
    await postHook(izbor.base, "PostToolUse", { ...tool, cwd: acting, tool_response: {} });
    await until(() => stream.latest().needsYou.state === "nothing");
    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "and then?" }, key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    assert.equal(((await (await polling).json()) as { text: string }).text, "and then?");
});

test("the Izbor stop ends a waiting poll with the 204 and a waiting sender with 503 `stopping`, before any connection is cut", async (t) => {
    const { izbor, bearer, poll, polled } = await watchedSession(t);
    const polling = poll(OTHER_SESSION);
    await polled(1);
    const sending = fetch(`${izbor.base}/sessions/${SESSION}/prompts`, {
        method: "POST",
        headers: bearer,
        body: '{"text":"late"}',
    });
    await until(() => izbor.requests.some((r) => r.path.endsWith("/prompts")));

    const stopped = izbor.stop();
    const got = await polling;
    assert.deepEqual([got.status, got.headers.get("connection"), await got.text()], [204, "close", ""]);
    const refused = await sending;
    assert.deepEqual(
        [refused.status, refused.headers.get("connection"), await refused.json()],
        [503, "close", { error: "stopping", message: "Izbor is stopping" }],
    );
    await stopped;
});

test("a collected prompt the plugin never reports is forgotten at the report limit of 1 hour: its late report gets 404 `unknown_prompt`", async (t) => {
    const clock = fakeClock();
    const { key, client, poll, polled, report } = await watchedSession(t, { wait: clock.wait });
    const polling = poll();
    await polled(1);
    const sent = await client.sendPrompt(SESSION, { text: "slow" }, key);
    assert.ok("collected" in sent);
    await (await polling).text();

    await clock.advance(REPORT_LIMIT_MS - 1);
    assert.deepEqual(
        ((await client.sendPrompt(SESSION, { text: "next" }, key)) as ErrorAnswer).error,
        "prompt_pending",
    );
    await clock.advance(1);
    const late = await report(sent.collected, "delivered");
    assert.deepEqual([late.status, ((await late.json()) as ErrorAnswer).error], [404, "unknown_prompt"]);
    const next = poll();
    await polled(2);
    assert.ok("collected" in (await client.sendPrompt(SESSION, { text: "next" }, key)));
    await (await next).text();
});

test("evidence that the session ended frees it for the next prompt while an earlier one is collected and unreported: its SessionEnd hook, or a Status reading that no longer lists it; the forgotten prompt's late report is 404 `unknown_prompt`", async (t) => {
    const clock = fakeClock();
    const agents: AgentsListEntry[] = [{ sessionId: SESSION, cwd: "/repo", status: "idle" }];
    const { izbor, acting, stream, key, client, poll, polled, report } = await watchedSession(t, {
        wait: clock.wait,
        agents,
    });
    const refused = { refused: 409, error: "prompt_pending", message: "A prompt for this session waits already." };
    async function collected(polling: Promise<Response>, text: string): Promise<string> {
        const sent = await client.sendPrompt(SESSION, { text }, key);
        const got = (await (await polling).json()) as { promptId: string; text: string };
        assert.deepEqual([sent, got.text], [{ collected: got.promptId }, text]);
        return got.promptId;
    }

    let polling = poll();
    await polled(1);
    const first = await collected(polling, "first");
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "second" }, key), refused);

    await postHook(izbor.base, "SessionEnd", { cwd: acting, reason: "exit" });
    polling = poll();
    await polled(2);
    const second = await collected(polling, "second");
    assert.equal((await report(first, "delivered")).status, 404);
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "third" }, key), refused);

    agents.length = 0;
    await clock.advance(2000);
    await until(() => stream.events.some((event) => event.type === "session" && event.state === "not listed"));
    polling = poll();
    await polled(3);
    const third = await collected(polling, "third");
    assert.equal((await report(second, "dropped")).status, 404);
    assert.deepEqual((await (await report(third, "delivered")).json()) as unknown, { reported: "delivered" });
});

test('two prompts sent quickly: the second is 409 `prompt_pending`, "A prompt for this session waits already.", while the first waits for a poll, and still while the first is collected and not yet reported; the first is delivered, once, and after its report the next prompt is taken', async (t) => {
    const clock = fakeClock();
    const { key, client, poll, polled, bearer, izbor, report, promptEvents } = await watchedSession(t, {
        wait: clock.wait,
    });
    const refused = { refused: 409, error: "prompt_pending", message: "A prompt for this session waits already." };

    const ended = new AbortController();
    const ending = fetch(`${izbor.base}/sessions/${SESSION}/prompts/next`, { headers: bearer, signal: ended.signal });
    await polled(1);
    ended.abort();
    await assert.rejects(ending);

    const first = client.sendPrompt(SESSION, { text: "first" }, key);
    await until(() => izbor.requests.filter((r) => r.path.endsWith("/prompts")).length === 1);
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "second" }, key), refused);

    const got = (await (await poll()).json()) as { promptId: string; text: string };
    assert.deepEqual([await first, got.text], [{ collected: got.promptId }, "first"]);
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "second" }, key), refused);
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" sent prompt ")),
        [`${SESSION} sent prompt ${got.promptId} at ${RECEIVED_AT.toISOString()}: first`],
    );

    await (await report(got.promptId, "delivered")).text();
    await until(() => promptEvents().length === 1);
    const polling = poll();
    await polled(3);
    const third = await client.sendPrompt(SESSION, { text: "third" }, key);
    const next = (await (await polling).json()) as { promptId: string; text: string };
    assert.deepEqual([third, next.text], [{ collected: next.promptId }, "third"]);
});

test("a report of a state other than delivered or dropped is 404 `not_found`", async (t) => {
    const { izbor, bearer } = await watchedSession(t);
    const other = await fetch(`${izbor.base}/prompts/${SESSION}/lost`, { method: "POST", headers: bearer });
    assert.deepEqual([other.status, ((await other.json()) as ErrorAnswer).error], [404, "not_found"]);
});

test("a text that is no prompt is 400 `bad_prompt` for an unwatched session too, not 404 `not_watched`: the body is checked before the watch", async (t) => {
    const { key, client } = await watchedSession(t);
    assert.deepEqual(await client.sendPrompt(OTHER_SESSION, { text: "  " }, key), {
        refused: 400,
        error: "bad_prompt",
        message: "The prompt is empty.",
    });
    assert.deepEqual(await client.sendPrompt(OTHER_SESSION, { text: " /clear" }, key), {
        refused: 400,
        error: "bad_prompt",
        message: "Run slash commands in the session.",
    });
});

test("a session that waits for the user while an earlier prompt is on its way: 409 `request_pending`, not `prompt_pending`: the request is checked before the earlier prompt", async (t) => {
    const agents: AgentsListEntry[] = [{ sessionId: SESSION, cwd: "/repo", status: "idle" }];
    const { izbor, acting, stream, key, client, poll, polled } = await watchedSession(t, { agents });
    const polling = poll();
    await polled(1);
    const first = await client.sendPrompt(SESSION, { text: "first" }, key);
    assert.ok("collected" in first, JSON.stringify(first));
    await (await polling).text();
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "second" }, key), {
        refused: 409,
        error: "prompt_pending",
        message: "A prompt for this session waits already.",
    });

    agents[0] = { ...agents[0]!, status: "waiting", waitingFor: "permission prompt" };
    const tool = { tool_name: "Bash", tool_input: { command: "npm test" } };
    await postHook(izbor.base, "PermissionRequest", { ...tool, cwd: acting });
    await until(() => stream.latest().needsYou.state === "request");
    assert.deepEqual(await client.sendPrompt(SESSION, { text: "second" }, key), {
        refused: 409,
        error: "request_pending",
        message: "Answer the request first.",
    });
});

test("a prompt whose body arrives as the Izbor stop begins gets 503 `stopping`, and no plugin gets it", async (t) => {
    const { izbor, bearer } = await watchedSession(t);
    let stopped: Promise<void> | undefined;
    const body = '{"text":"run the tests"}';
    const refused = await postInTwoPieces(
        `${izbor.base}/sessions/${SESSION}/prompts`,
        body.slice(0, 10),
        body.slice(10),
        () => {
            stopped = izbor.stop();
        },
        bearer,
    );
    assert.deepEqual(
        { status: refused.status, connection: refused.headers.get("connection"), body: await refused.json() },
        {
            status: 503,
            connection: "close",
            body: { error: "stopping", message: "Izbor is stopping" },
        },
    );
    assert.deepEqual(
        izbor.izbor.printed().filter((line) => line.includes(" prompt ")),
        [],
    );
    await stopped;
});

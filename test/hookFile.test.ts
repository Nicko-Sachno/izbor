import { test } from "node:test";
import assert from "node:assert/strict";
import { hook, msg, RECEIVED_AT, SESSION, setup, until } from "./support.js";

test("every hook of the watched session is saved with its full payload and the time Izbor received it", async () => {
    const { handle, readHookFile } = await setup([msg("user", "first")]);
    const prompt = hook("UserPromptSubmit", { prompt: "fix the login redirect", prompt_id: "p-1" });
    const toolStart = hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" });
    const stop = hook("Stop", { last_assistant_message: "Done.", background_tasks: [{ id: "b1", type: "shell" }] });

    await handle(prompt);
    await handle(toolStart);
    await handle(stop);

    const saved = (payload: object) => ({
        kind: "hook",
        sessionId: SESSION,
        timestamp: RECEIVED_AT.toISOString(),
        payload,
    });
    assert.deepEqual(await readHookFile(), [saved(prompt), saved(toolStart), saved(stop)]);
});

test("a hook is saved while a sync is still waiting for a slow SDK", async () => {
    let finishRead = () => {};
    const slowRead = new Promise<void>((resolve) => (finishRead = resolve));
    const { handle, start, reads, readHookFile } = await setup([msg("user", "first")], { beforeRead: () => slowRead });

    const syncing = start();
    await until(() => reads.count === 1);
    const handling = handle(hook("PreToolUse", { tool_name: "Bash" }));

    await until(async () => (await readHookFile()).some((r) => r.kind === "hook"));
    finishRead();
    await Promise.all([syncing, handling]);
});

test("saved hooks are still there after a new watch of the same session rebuilds the session file", async () => {
    const transcript = [msg("user", "first")];
    const first = await setup(transcript);
    await first.handle(hook("UserPromptSubmit", { prompt: "first" }));
    await first.stop();
    const saved = await first.readHookFile();

    transcript.push(msg("assistant", [{ type: "text", text: "second" }]));
    const second = await setup(transcript, { dir: first.dir });
    await second.start();

    assert.deepEqual(
        (await second.readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );
    const afterSecond = await second.readHookFile();
    assert.deepEqual(afterSecond.slice(0, saved.length), saved);
    assert.deepEqual(
        afterSecond.map((r) => r.event ?? r.payload.hook_event_name),
        ["UserPromptSubmit", "stopped", "started"],
    );
});

test("saved hooks are still there after a shrink rebuilds the session file", async () => {
    const transcript = [msg("user", "first"), msg("assistant", [{ type: "text", text: "second" }])];
    const { handle, readRecords, readHookFile } = await setup(transcript);
    await handle(hook("UserPromptSubmit", { prompt: "first" }));

    transcript.pop();
    await handle(hook("PostToolUse", { tool_name: "Bash" }));

    assert.deepEqual(
        (await readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );
    assert.deepEqual(
        (await readHookFile()).map((r) => r.payload.hook_event_name),
        ["UserPromptSubmit", "PostToolUse"],
    );
});

function tickingClock() {
    let seconds = 0;
    return () => new Date(RECEIVED_AT.getTime() + 1000 * seconds++);
}

test("the times the watch started and stopped are saved, the stop after every hook before it", async () => {
    const { start, handle, stop, readHookFile } = await setup([msg("user", "first")], { now: tickingClock() });

    await start();
    void handle(hook("UserPromptSubmit", { prompt: "first" }));
    await stop();

    assert.deepEqual(
        (await readHookFile()).map((r) => [r.kind, r.event ?? r.payload.hook_event_name, r.timestamp]),
        [
            ["izbor", "started", "2026-10-01T12:00:00.000Z"],
            ["hook", "UserPromptSubmit", "2026-10-01T12:00:01.000Z"],
            ["izbor", "stopped", "2026-10-01T12:00:02.000Z"],
        ],
    );
    assert.equal((await readHookFile())[0].sessionId, SESSION);
});

test("a sync that fails is saved with its error and its time", async () => {
    const { handle, errors, readHookFile } = await setup([msg("user", "first")], { failReads: () => true });

    await handle(hook("UserPromptSubmit", { prompt: "first" }));

    assert.deepEqual((await readHookFile())[1], {
        kind: "izbor",
        event: "sync_error",
        sessionId: SESSION,
        timestamp: RECEIVED_AT.toISOString(),
        error: "Error: sdk down",
    });
    assert.deepEqual(errors(), ["1234abcd error: Error: sdk down"]);
});

test("a rejected payload is saved as it arrived, with the time Izbor received it", async () => {
    const { handleRejected, readHookFile } = await setup([msg("user", "first")]);

    await handleRejected('{"session_id": "s1", "hook_event_name"');

    assert.deepEqual(await readHookFile(), [
        {
            kind: "izbor",
            event: "rejected_payload",
            sessionId: SESSION,
            timestamp: RECEIVED_AT.toISOString(),
            body: '{"session_id": "s1", "hook_event_name"',
        },
    ]);
});

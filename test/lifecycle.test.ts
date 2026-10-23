import { test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { eventMarker, fakeClock, hook, msg, SESSION, settle, setup, until } from "./support.js";

const exists = (file: string) =>
    access(file).then(
        () => true,
        () => false,
    );

test("a Izbor stop writes an event record still waiting behind a slow sync", async () => {
    let finishRead = () => {};
    const slowRead = new Promise<void>((resolve) => (finishRead = resolve));
    const { handle, stop, reads, readRecords } = await setup([msg("user", "first")], { beforeRead: () => slowRead });

    void handle(hook("UserPromptSubmit"));
    await until(() => reads.count === 1);
    void handle(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf dist" } }));

    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await settle();
    assert.equal(stopped, false);

    finishRead();
    await stopping;
    assert.deepEqual(
        (await readRecords()).map((r) => r.event ?? r.kind),
        ["message", "permission_request"],
    );
});

test("a Izbor stop cancels a sync still waiting on its timer, and the delayed syncs", async () => {
    const clock = fakeClock();
    const { handle, stop, reads, file } = await setup([msg("user", "first")], { wait: clock.wait });

    void handle(hook("Stop"));
    await stop();
    await clock.advance(5000);

    assert.equal(reads.count, 0);
    assert.equal(await exists(file), false);
});

test("a hook that arrives after a Izbor stop is not handled", async () => {
    const { handle, handleRejected, stop, reads, file, readHookFile } = await setup([msg("user", "first")]);

    await stop();
    await handle(hook("PermissionRequest", { tool_name: "Bash", tool_input: {} }));
    await handleRejected("not json");

    assert.equal(reads.count, 0);
    assert.equal(await exists(file), false);
    assert.deepEqual(
        (await readHookFile()).map((r) => r.event),
        ["stopped"],
    );
});

test("start writes the watched session to its file before any hook arrives", async () => {
    const transcript = [msg("user", "first")];
    const { start, handle, readRecords } = await setup(transcript);

    await start();
    assert.deepEqual(
        (await readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );

    await handle(eventMarker());
    transcript.push(msg("assistant", [{ type: "text", text: "second" }]));
    await handle(hook("Stop"));
    assert.deepEqual(
        (await readRecords()).map((r) => r.id ?? r.event),
        [transcript[0]!.uuid, "permission_request", transcript[1]!.uuid],
    );
});

test("at a new watch of the same session, start continues the same session file and keeps its event records", async () => {
    const transcript = [msg("user", "first")];
    const { start, readRecords, file } = await setup(transcript);
    const event = {
        kind: "event",
        event: "notification",
        sessionId: SESSION,
        agentId: null,
        timestamp: "t",
        message: "waiting",
    };
    await writeFile(file, `${JSON.stringify({ kind: "message", id: "stale" })}\n${JSON.stringify(event)}\n`);

    await start();

    assert.deepEqual(
        (await readRecords()).map((r) => r.id ?? r.message),
        [transcript[0]!.uuid, "waiting"],
    );
});

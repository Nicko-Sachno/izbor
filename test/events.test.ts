import { test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { hook, msg, RECEIVED_AT, SESSION, setup, until } from "./support.js";

test("a permission request is appended as an event record", async () => {
    const { handle, readRecords } = await setup([msg("user", "first")]);
    await handle(hook("UserPromptSubmit"));

    await handle(
        hook("PermissionRequest", {
            tool_name: "Bash",
            tool_input: { command: "rm -rf dist" },
            tool_use_id: "toolu_9",
        }),
    );

    const records = await readRecords();
    assert.deepEqual(
        records.map((r) => r.kind),
        ["message", "event"],
    );
    assert.deepEqual(records[1], {
        kind: "event",
        event: "permission_request",
        sessionId: SESSION,
        agentId: null,
        timestamp: RECEIVED_AT.toISOString(),
        toolCallId: "toolu_9",
        name: "Bash",
        rawInput: { command: "rm -rf dist" },
    });
});

test("an event as first contact rebuilds the file first; notifications and subagent denials are recorded", async () => {
    let finishRead = () => {};
    const slowRead = new Promise<void>((resolve) => (finishRead = resolve));
    const { handle, reads, readRecords, file } = await setup([msg("user", "first")], { beforeRead: () => slowRead });

    const notified = handle(
        hook("Notification", { notification_type: "idle_prompt", message: "Claude is waiting\nfor your input" }),
    );
    await until(() => reads.count === 1);
    await assert.rejects(access(file));
    finishRead();
    await notified;
    await handle(
        hook("PermissionDenied", {
            tool_name: "Write",
            tool_input: { file_path: "/x" },
            tool_use_id: "toolu_7",
            agent_id: "a1b2c3",
        }),
    );

    const records = await readRecords();
    assert.deepEqual(
        records.map((r) => r.kind),
        ["message", "event", "event"],
    );
    const [, notification, denied] = records;
    assert.deepEqual(notification, {
        kind: "event",
        event: "notification",
        sessionId: SESSION,
        agentId: null,
        timestamp: RECEIVED_AT.toISOString(),
        notificationType: "idle_prompt",
        message: "Claude is waiting\nfor your input",
    });
    assert.deepEqual([denied.event, denied.agentId, denied.toolCallId], ["permission_denied", "a1b2c3", "toolu_7"]);
});

test("an event on a session with no messages yet is kept once messages appear", async () => {
    const transcript: SessionMessage[] = [];
    const { handle, readRecords } = await setup(transcript);

    await handle(hook("Notification", { notification_type: "idle_prompt", message: "waiting" }));
    transcript.push(msg("user", "first"));
    await handle(hook("UserPromptSubmit"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.kind),
        ["message", "event"],
    );
});

const eventLine = (message: string) =>
    JSON.stringify({
        kind: "event",
        event: "notification",
        sessionId: SESSION,
        agentId: null,
        timestamp: "t",
        message,
    });

test("a rebuild replaces the messages in an existing file but keeps its event records", async () => {
    const transcript = [msg("user", "first")];
    const { handle, readRecords, file } = await setup(transcript);
    const stale = { kind: "message", id: "stale" };
    await writeFile(file, `${JSON.stringify(stale)}\n${eventLine("waiting")}\n`);

    await handle(hook("SessionStart"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.id ?? r.message),
        [transcript[0]!.uuid, "waiting"],
    );
});

test("an event written after a failed rebuild survives the retry", async () => {
    let fail = true;
    const { handle, readRecords } = await setup([msg("user", "first")], { failReads: () => fail });

    await handle(hook("Notification", { notification_type: "idle_prompt", message: "waiting" }));
    fail = false;
    await handle(hook("UserPromptSubmit"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.kind),
        ["message", "event"],
    );
});

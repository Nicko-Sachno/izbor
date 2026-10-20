import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSessionFiles } from "../src/adapters/files/sessionFiles.js";
import type { MessageRecord } from "../src/domain/records.js";
import { eventMarker, hook, msg, setup } from "./support.js";
import { skipOnWindows } from "./helpers/fakeCommand.js";

test("first contact rebuilds the session file with the whole session", async () => {
    const transcript = [msg("user", "first"), msg("assistant", [{ type: "text", text: "second" }])];
    const { handle, readRecords, file } = await setup(transcript);
    await writeFile(file, `${JSON.stringify({ kind: "message", id: "stale" })}\n`);

    await handle(hook("UserPromptSubmit"));

    assert.deepEqual(
        (await readRecords()).map((r) => [r.kind, r.id, r.role, r.blocks]),
        [
            ["message", transcript[0]!.uuid, "user", [{ type: "text", text: "first" }]],
            ["message", transcript[1]!.uuid, "assistant", [{ type: "text", text: "second" }]],
        ],
    );
});

test("later hooks append only new messages to the file", async () => {
    const transcript = [msg("user", "first")];
    const { handle, readRecords } = await setup(transcript);
    await handle(hook("UserPromptSubmit"));
    await handle(eventMarker());

    transcript.push(msg("assistant", [{ type: "text", text: "second" }]));
    await handle(hook("Stop"));
    await handle(hook("Stop"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.id ?? r.event),
        [transcript[0]!.uuid, "permission_request", transcript[1]!.uuid],
    );
});

test("a failed rebuild keeps the old file, and the next hook retries the rebuild", async () => {
    let fail = true;
    const { handle, errors, readRecords, file } = await setup([msg("user", "first")], { failReads: () => fail });
    await writeFile(file, "old\n");

    await handle(hook("UserPromptSubmit"));
    assert.equal(await readFile(file, "utf8"), "old\n");

    fail = false;
    await handle(hook("Stop"));
    assert.equal((await readRecords()).length, 1);
    assert.deepEqual(errors(), ["1234abcd error: Error: sdk down"]);
});

test("a session the SDK doesn't know yet creates no file until it has messages", async () => {
    const transcript: SessionMessage[] = [];
    const { handle, readRecords, file } = await setup(transcript);

    await handle(hook("SessionStart"));
    await assert.rejects(access(file));

    transcript.push(msg("user", "first"));
    await handle(hook("UserPromptSubmit"));
    assert.equal((await readRecords()).length, 1);
});

test("if the SDK returns fewer messages than already written, the session is rebuilt and later messages append normally", async () => {
    const transcript = [msg("user", "first"), msg("assistant", [{ type: "text", text: "second" }])];
    const { handle, errors, readRecords } = await setup(transcript);
    await handle(hook("UserPromptSubmit"));

    transcript.pop();
    await handle(hook("PostToolUse"));
    assert.deepEqual(
        (await readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );

    await handle(eventMarker());
    transcript.push(msg("assistant", [{ type: "text", text: "third" }]));
    await handle(hook("PostToolUse"));
    assert.deepEqual(
        (await readRecords()).map((r) => r.id ?? r.event),
        [transcript[0]!.uuid, "permission_request", transcript[1]!.uuid],
    );
    assert.deepEqual(errors(), ["1234abcd warning: SDK returned 1 messages, already wrote 2; rebuilding"]);
});

test("a shrinking subagent is warned about with its agent marker", async () => {
    const subagents = new Map([["a1b2c3", [msg("user", "task"), msg("assistant", [{ type: "text", text: "done" }])]]]);
    const { handle, errors } = await setup([msg("user", "first")], { subagents });
    await handle(hook("UserPromptSubmit"));

    subagents.get("a1b2c3")!.pop();
    await handle(hook("PostToolUse"));

    assert.deepEqual(errors(), ["1234abcd/agent-a1b2 warning: SDK returned 1 messages, already wrote 2; rebuilding"]);
});

test("rebuild writes the main thread, then every subagent, each record tagged with its agent", async () => {
    const transcript = [msg("user", "first")];
    const subagents = new Map([
        [
            "a1b2c3",
            [msg("user", "task", "toolu_agent"), msg("assistant", [{ type: "text", text: "done" }], "toolu_agent")],
        ],
    ]);
    const { handle, readRecords } = await setup(transcript, { subagents });

    await handle(hook("SessionStart"));

    assert.deepEqual(
        (await readRecords()).map((r) => [r.agentId, r.parentToolCallId, r.blocks[0].text]),
        [
            [null, null, "first"],
            ["a1b2c3", "toolu_agent", "task"],
            ["a1b2c3", "toolu_agent", "done"],
        ],
    );
});

test("later hooks append new subagent messages, including from subagents started after the rebuild", async () => {
    const transcript = [msg("user", "first")];
    const subagents = new Map<string, SessionMessage[]>();
    const { handle, readRecords } = await setup(transcript, { subagents });
    await handle(hook("UserPromptSubmit"));
    await handle(eventMarker());

    transcript.push(msg("assistant", [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: {} }]));
    subagents.set("a1b2c3", [msg("user", "task", "toolu_agent")]);
    await handle(hook("PostToolUse"));
    subagents.get("a1b2c3")!.push(msg("assistant", [{ type: "text", text: "done" }], "toolu_agent"));
    await handle(hook("PostToolUse"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.event ?? r.agentId),
        [null, "permission_request", null, "a1b2c3", "a1b2c3"],
    );
});

test("an empty first read leaves a stale file alone, and the later rebuild doesn't duplicate it", async () => {
    const transcript: SessionMessage[] = [];
    const { handle, readRecords, file } = await setup(transcript);
    const first = msg("user", "first");
    await writeFile(file, `${JSON.stringify({ kind: "message", id: first.uuid })}\n`);

    await handle(hook("SessionStart"));
    transcript.push(first, msg("assistant", [{ type: "text", text: "second" }]));
    await handle(hook("UserPromptSubmit"));

    assert.deepEqual(
        (await readRecords()).map((r) => r.id),
        transcript.map((m) => m.uuid),
    );
});

test("a stale .tmp left by a crashed rebuild of an older Izbor is left alone, not merged", async () => {
    const { handle, readRecords, file, dir } = await setup([msg("user", "first")]);
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, "half-written garbage");

    await handle(hook("SessionStart"));

    assert.equal((await readRecords()).length, 1);
    assert.equal(await readFile(`${file}.tmp`, "utf8"), "half-written garbage");
});

test("two replaces of one session file at once both resolve, and the file holds one whole set of records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-"));
    const files = createSessionFiles(dir);
    const record = (id: string, text: string): MessageRecord => ({
        kind: "message",
        id,
        sessionId: "s1",
        agentId: null,
        parentToolCallId: null,
        timestamp: null,
        role: "user",
        blocks: [{ type: "text", text }],
    });
    const short = [record("a1", "a")];
    const long = Array.from({ length: 200 }, (_, i) => record(`b${i}`, "b".repeat(2000)));

    await Promise.all([files.replaceMessages("s1", short), files.replaceMessages("s1", long)]);

    const saved = (await readFile(join(dir, "s1.ndjson"), "utf8")).trimEnd().split("\n");
    const ids = saved.map((line) => (JSON.parse(line) as MessageRecord).id);
    assert.ok(
        [short, long].some((set) => JSON.stringify(set.map((r) => r.id)) === JSON.stringify(ids)),
        `the file holds ${ids.length} records, of neither set`,
    );
    assert.deepEqual(
        (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
        [],
    );
});

test(
    "a replace of a session file that cannot be read rejects, and the file keeps its event records",
    skipOnWindows("Windows chmod cannot make a file unreadable"),
    async () => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-"));
        const file = join(dir, "s1.ndjson");
        const content = `${JSON.stringify({ kind: "message", id: "old" })}\n${JSON.stringify({ kind: "event", event: "notification" })}\n`;
        await writeFile(file, content);
        await chmod(file, 0o000);

        await assert.rejects(createSessionFiles(dir).replaceMessages("s1", []), { code: "EACCES" });

        await chmod(file, 0o600);
        assert.equal(await readFile(file, "utf8"), content);
        assert.deepEqual(await readdir(dir), ["s1.ndjson"]);
    },
);

test("a session file deleted after the first rebuild is rebuilt in full", async () => {
    const transcript = [msg("user", "first")];
    const { handle, readRecords, file } = await setup(transcript);
    await handle(hook("UserPromptSubmit"));

    await rm(file);
    transcript.push(msg("assistant", [{ type: "text", text: "second" }]));
    await handle(hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }));

    assert.deepEqual(
        (await readRecords()).map((r) => r.kind),
        ["message", "message", "event"],
    );
});

test("if the SDK suddenly returns no messages, the file is kept and the warning says so", async () => {
    const transcript = [msg("user", "first")];
    const { handle, errors, readRecords } = await setup(transcript);
    await handle(hook("UserPromptSubmit"));

    transcript.pop();
    await handle(hook("PostToolUse"));

    assert.equal((await readRecords()).length, 1);
    assert.deepEqual(errors(), ["1234abcd warning: SDK returned 0 messages, already wrote 1; keeping the file"]);
});

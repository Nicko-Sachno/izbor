import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { toMessageRecord } from "../src/adapters/agents/claude/messageRecord.js";
import { describeTool } from "../src/domain/toolCalls.js";

const msg = (type: SessionMessage["type"], message: unknown, extra: object = {}): SessionMessage => ({
    type,
    uuid: "uuid-1",
    session_id: "sess-1234-abcd",
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
});

test("a plain-string user prompt becomes a message record with one text block", () => {
    assert.deepEqual(toMessageRecord(msg("user", { role: "user", content: "hello" }), null), {
        kind: "message",
        id: "uuid-1",
        sessionId: "sess-1234-abcd",
        agentId: null,
        parentToolCallId: null,
        timestamp: null,
        role: "user",
        blocks: [{ type: "text", text: "hello" }],
    });
});

test("an assistant message keeps text, non-empty thinking, tool calls, model, usage and timestamp", () => {
    const record = toMessageRecord(
        msg(
            "assistant",
            {
                role: "assistant",
                model: "claude-opus-5-5",
                usage: {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_read_input_tokens: 30,
                    cache_creation_input_tokens: 40,
                },
                content: [
                    { type: "thinking", thinking: "", signature: "sig" },
                    { type: "thinking", thinking: "hmm", signature: "sig" },
                    { type: "text", text: "hi" },
                    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
                ],
            },
            { timestamp: "2026-10-01T10:00:00.000Z" },
        ),
        null,
    );

    assert.equal(record.role, "assistant");
    assert.equal(record.model, "claude-opus-5-5");
    assert.deepEqual(record.usage, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
    assert.equal(record.timestamp, "2026-10-01T10:00:00.000Z");
    assert.deepEqual(record.blocks, [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "hi" },
        {
            type: "toolCall",
            toolCallId: "toolu_1",
            name: "Bash",
            rawInput: { command: "ls" },
            kind: "execute",
            title: "ls",
            display: "Bash",
            argument: "ls",
        },
    ]);
});

test("tool results keep their full original output, with their first line, a failed command's exit code and a subagent's counts; unknown blocks become 'other'", () => {
    const big = "x".repeat(40_000);
    const arrayOutput = [
        { type: "text", text: "found" },
        { type: "tool_reference", tool_name: "Grep" },
    ];
    const refused = "<tool_use_error>boom</tool_use_error>";
    const listed = "\nnotes.txt  \nsrc\n";
    const failed = "Exit code 1\n\nls: /nope: No such file or directory";
    const subagent = [
        { type: "text", text: "Two callers: login and logout." },
        {
            type: "text",
            text:
                "agentId: a1b2c3d4e5f6a7b8c (use SendMessage with to: 'a1b2c3d4e5f6a7b8c', summary: '<5-10 word recap>' " +
                "to continue this agent)\n<usage>subagent_tokens: 18234\ntool_uses: 4\nduration_ms: 62000</usage>",
        },
    ];
    const image = { type: "image", source: { type: "base64", data: "AAAA" } };
    const record = toMessageRecord(
        msg(
            "user",
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "toolu_1", content: big },
                    { type: "tool_result", tool_use_id: "toolu_2", content: arrayOutput },
                    { type: "tool_result", tool_use_id: "toolu_3", content: refused, is_error: true },
                    { type: "tool_result", tool_use_id: "toolu_4", content: listed },
                    { type: "tool_result", tool_use_id: "toolu_5", content: failed, is_error: true },
                    { type: "tool_result", tool_use_id: "toolu_6", content: subagent },
                    image,
                ],
            },
            { parent_tool_use_id: "toolu_parent" },
        ),
        null,
    );

    assert.equal(record.parentToolCallId, "toolu_parent");
    assert.deepEqual(record.blocks, [
        { type: "toolResult", toolCallId: "toolu_1", status: "completed", rawOutput: big, firstLine: big },
        { type: "toolResult", toolCallId: "toolu_2", status: "completed", rawOutput: arrayOutput, firstLine: "found" },
        { type: "toolResult", toolCallId: "toolu_3", status: "failed", rawOutput: refused, firstLine: "boom" },
        { type: "toolResult", toolCallId: "toolu_4", status: "completed", rawOutput: listed, firstLine: "notes.txt" },
        {
            type: "toolResult",
            toolCallId: "toolu_5",
            status: "failed",
            rawOutput: failed,
            firstLine: "ls: /nope: No such file or directory",
            exitCode: 1,
        },
        {
            type: "toolResult",
            toolCallId: "toolu_6",
            status: "completed",
            rawOutput: subagent,
            firstLine: "Two callers: login and logout.",
            counts: { toolUses: 4, durationMs: 62000 },
        },
        { type: "other", originalType: "image", raw: image },
    ]);
});

function toolCall(name: string, input: unknown) {
    const [block] = toMessageRecord(
        msg("assistant", { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] }),
        null,
    ).blocks;
    assert.ok(block?.type === "toolCall");
    return block;
}

test("a PowerShell call, Claude Code's shell tool on Windows, reads as a Bash one: 'execute', titled with its command", () => {
    assert.deepEqual(describeTool("PowerShell", { command: "npm test" }), { kind: "execute", title: "npm test" });
});

test("built-in tools get their ACP kind and a short title from their input: a Bash call is 'execute' titled with its command, a plan approval 'switch_mode' titled with the plan's first line", () => {
    const cases: [string, unknown, string, string][] = [
        ["Read", { file_path: "/repo/src/a.ts" }, "read", "/repo/src/a.ts"],
        ["Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" }, "edit", "/repo/src/a.ts"],
        ["Write", { file_path: "/repo/b.md", content: "hi" }, "edit", "/repo/b.md"],
        ["NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "x" }, "edit", "/repo/n.ipynb"],
        ["Grep", { pattern: "TODO", path: "src" }, "search", "TODO"],
        ["Glob", { pattern: "**/*.ts" }, "search", "**/*.ts"],
        ["WebFetch", { url: "https://example.com", prompt: "summarize" }, "fetch", "https://example.com"],
        ["WebSearch", { query: "node 24 release" }, "fetch", "node 24 release"],
        ["Agent", { description: "Find callers", prompt: "…" }, "think", "Find callers"],
        ["Task", { description: "Find callers", prompt: "…" }, "think", "Find callers"],
        ["Bash", { command: "npm test", description: "Run tests" }, "execute", "npm test"],
        ["ExitPlanMode", { plan: "1. Edit the router\n2. Run the tests" }, "switch_mode", "1. Edit the router …"],
    ];
    for (const [name, input, kind, title] of cases) {
        const block = toolCall(name, input);
        assert.deepEqual([block.kind, block.title], [kind, title], name);
    }
});

test("unknown tools are 'other', and a missing title field falls back to the tool name", () => {
    const mcp = toolCall("mcp__github__create_issue", { title: "Bug" });
    const noInput = toolCall("Bash", undefined);
    assert.deepEqual([mcp.kind, mcp.title], ["other", "mcp__github__create_issue"]);
    assert.deepEqual([noInput.kind, noInput.title], ["execute", "Bash"]);
});

test("titles are short: first line only, at most 100 characters", () => {
    assert.equal(toolCall("Bash", { command: "cat <<EOF > a.txt\nhello\nEOF" }).title, "cat <<EOF > a.txt …");
    assert.equal(toolCall("Bash", { command: "x".repeat(150) }).title, `${"x".repeat(99)}…`);
});

test("content that is neither a string nor a block array is kept as 'other', never dropped", () => {
    const weird = { unexpected: true };
    assert.deepEqual(toMessageRecord(msg("user", { role: "user", content: weird }), null).blocks, [
        { type: "other", originalType: "object", raw: weird },
    ]);
    assert.deepEqual(toMessageRecord(msg("user", { role: "user" }), null).blocks, []);
});

test("a user message keeps who submitted it, when the SDK says so: the kind, and a plugin's name and its as-the-user mark", () => {
    const content = { role: "user", content: "fix the login redirect" };
    const origin = (extra: object) => toMessageRecord(msg("user", content, extra), null).origin;
    assert.deepEqual(origin({ origin: { kind: "human" } }), { kind: "human" });
    assert.deepEqual(origin({ origin: { kind: "task-notification", producer: "session-task" } }), {
        kind: "task-notification",
    });
    assert.deepEqual(origin({ origin: { kind: "plugin", name: "izbor", asUser: true } }), {
        kind: "plugin",
        name: "izbor",
        asUser: true,
    });
    assert.deepEqual(origin({ origin: { kind: "plugin", name: 3, asUser: "yes" } }), { kind: "plugin" });
    assert.equal("origin" in toMessageRecord(msg("user", content), null), false);
});

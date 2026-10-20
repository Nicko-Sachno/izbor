import { test } from "node:test";
import assert from "node:assert/strict";
import { toMessageRecord } from "../src/adapters/agents/claude/messageRecord.js";
import type { Block, MessageRecord } from "../src/domain/records.js";
import { transcriptFixture, transcriptFixtureNames, type TranscriptRow } from "./helpers/transcripts.js";

function fixture(name: string): { source: string; records: MessageRecord[]; rows: TranscriptRow[] } {
    const { source, messages, rows } = transcriptFixture(name);
    return { source, records: messages.map((message) => toMessageRecord(message, null)), rows };
}

const denialKinds = (rows: TranscriptRow[]) => rows.flatMap((row) => (row.toolDenialKind ? [row.toolDenialKind] : []));

type ToolResult = Extract<Block, { type: "toolResult" }>;

function toolResultOf(records: MessageRecord[]): ToolResult {
    const results = records
        .flatMap((record) => record.blocks)
        .filter((block): block is ToolResult => block.type === "toolResult");
    assert.equal(results.length, 1);
    return results[0]!;
}

test("every transcript fixture describes its recording and normalization", () => {
    const names = transcriptFixtureNames();
    assert.ok(names.length > 0);
    for (const name of names) {
        const { source } = fixture(name);
        assert.match(source, /Derived from a recording made \d{4}-\d{2}-\d{2}.*Claude Code \d+\.\d+\.\d+/s, name);
        assert.match(source, /derived from a recording/i, name);
        assert.match(source, /identifiers and example paths have been normalized/i, name);
    }
});

test("deny with the interrupt flag: Claude Code drops the message and writes its own No", () => {
    const { records, rows } = fixture("deny-interrupt");
    const { status, rawOutput } = toolResultOf(records);
    assert.deepEqual(
        { status, rawOutput },
        {
            status: "failed",
            rawOutput:
                "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        },
    );
    assert.deepEqual(records.at(-1)!.blocks, [{ type: "text", text: "[Request interrupted by user for tool use]" }]);
    assert.doesNotMatch(JSON.stringify(records), /Izbor/);
    assert.deepEqual(denialKinds(rows), ["user-rejected"]);
});

test("deny without the flag: the tool result is the message as given, and Claude goes on", () => {
    const { records, rows } = fixture("deny-with-words");
    const { status, rawOutput } = toolResultOf(records);
    assert.deepEqual(
        { status, rawOutput },
        { status: "failed", rawOutput: "The user said no in Izbor: write the file with printf instead of echo" },
    );
    assert.equal(records.at(-1)!.role, "assistant");
    assert.deepEqual(denialKinds(rows), ["permission-rule"]);
});

test("a Question answered through the hook's answers reads as answered in Claude Code", () => {
    const { status, rawOutput } = toolResultOf(fixture("question-answered").records);
    assert.deepEqual(
        { status, rawOutput },
        {
            status: "completed",
            rawOutput:
                'Your questions have been answered: "Which color?"="Blue". You can now continue with these answers in mind.',
        },
    );
});

test("a plugin's prompt submitted as the user: the row names the plugin and the mark, and the adapter keeps both with the kind", () => {
    const { records, rows } = fixture("plugin-prompt");
    assert.deepEqual(rows[0]!.origin, { kind: "plugin", name: "fixture-probe", asUser: true });
    assert.equal(rows[0]!.promptSource, "system");
    const prompt = records[0]!;
    assert.equal(prompt.role, "user");
    assert.deepEqual(prompt.origin, { kind: "plugin", name: "fixture-probe", asUser: true });
    assert.deepEqual(prompt.blocks, [
        { type: "text", text: "Reply with exactly these words and nothing else: plugin prompt one" },
    ]);
});

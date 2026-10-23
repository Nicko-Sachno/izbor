import { test } from "node:test";
import assert from "node:assert/strict";
import type { BriefEvent } from "../src/domain/streamEvent.js";
import { toTerminalBrief } from "../src/terminal/live/brief.js";
import { wrapText } from "../src/terminal/presentation.js";

const PING: BriefEvent = {
    type: "brief",
    sessionId: "f957ff0e-6ae1-45bd-bac2-0125de4fbbd9",
    task: {
        text: "Run `ping -c 10 127.0.0.1`. When it has finished, read src/b.ts. Then run `ping -c 5 127.0.0.1`. Then tell me both average round-trip times. One step at a time, in this order. Do not edit any file.",
        at: "2026-10-06T04:47:56.833Z",
        from: "hook",
    },
    status: { state: "busy" },
    latestActivity: { what: "asked permission for Bash: ping -c 10 127.0.0.1", at: "2026-10-06T04:47:58.998Z" },
    needsYou: {
        state: "request",
        at: "2026-10-06T04:47:58.998Z",
        agentId: null,
        tool: "Bash",
        input: { command: "ping -c 10 127.0.0.1", description: "Run 10 pings to localhost" },
    },
    answerable: "not an acting project",
    lastObserved: { at: "2026-10-06T04:47:58.998Z", from: "hook", lastHookAt: "2026-10-06T04:47:58.998Z" },
    explanation: { state: "unknown" },
};

const screenBrief = (event: Partial<BriefEvent>) => toTerminalBrief({ ...PING, ...event });

test("the guide's real brief, a pending ping request, becomes the screen brief", () => {
    assert.deepEqual(toTerminalBrief(PING), {
        task: {
            text: "Run `ping -c 10 127.0.0.1`. When it has finished, read src/b.ts. Then run `ping -c 5 127.0.0.1`. Then tell me both average round-trip times. One step at a time, in this order. Do not edit any file.",
            at: "2026-10-06T04:47:56.833Z",
            from: "hook",
        },
        status: "busy",
        explanation: null,
        latestActivity: { text: "asked permission for Bash: ping -c 10 127.0.0.1", at: "2026-10-06T04:47:58.998Z" },
        needsYou: {
            state: "request",
            text: "Bash: ping -c 10 127.0.0.1",
            detail: "Bash: ping -c 10 127.0.0.1",
            at: "2026-10-06T04:47:58.998Z",
        },
        answerable: "not an acting project",
        lastObserved: { at: "2026-10-06T04:47:58.998Z", from: "hook" },
    });
});

test("answerable passes through beside Needs you: true, or the reason Izbor cannot answer; null leaves it out", () => {
    assert.equal(screenBrief({ answerable: true }).answerable, true);
    assert.equal(screenBrief({ answerable: "expired" }).answerable, "expired");
    assert.ok(!("answerable" in screenBrief({ answerable: null })), "nothing waits: no answerable");
});

test("with no Status reading yet, the Status is unknown and says so", () => {
    const brief = screenBrief({ status: null });
    assert.equal(brief.status, "unknown");
    assert.equal(brief.statusDetail, "No Status reading yet");
});

test("every Status reading passes through as it is: busy, idle, waiting, not listed or unknown", () => {
    const readings = [
        { state: "busy" },
        { state: "idle" },
        { state: "waiting", waitingFor: "permission prompt" },
        { state: "not listed" },
        { state: "unknown", error: "Error: claude agents --json gave no answer in 5000 ms" },
    ] as const;
    assert.deepEqual(
        readings.map((status) => screenBrief({ status }).status),
        ["busy", "idle", "waiting", "not listed", "unknown"],
    );
});

test("an explanation keeps its text and time, and its outdated mark word for word", () => {
    const explained = {
        state: "explained",
        text: "Claude waits for permission to ping.",
        at: "2026-10-06T04:47:59.000Z",
    } as const;
    assert.deepEqual(screenBrief({ explanation: explained }).explanation, {
        text: "Claude waits for permission to ping.",
        at: "2026-10-06T04:47:59.000Z",
    });
    assert.deepEqual(
        (["reply finished", "request over", "request replaced"] as const).map(
            (outdated) => screenBrief({ explanation: { ...explained, outdated } }).explanation?.outdatedReason,
        ),
        ["reply finished", "request over", "request replaced"],
    );
});

test("no explanation is null, with the reason the summarizer gave none when there is one", () => {
    const brief = screenBrief({ explanation: { state: "unknown", reason: "the summarizer gave no answer in 30 s" } });
    assert.equal(brief.explanation, null);
    assert.equal(brief.explanationUnknownReason, "the summarizer gave no answer in 30 s");
    assert.equal("explanationUnknownReason" in screenBrief({ explanation: { state: "unknown" } }), false);
    assert.equal(
        "explanationUnknownReason" in screenBrief({ explanation: { state: "unknown", reason: " \n " } }),
        false,
    );
});

test("the latest activity is its words and time; none stays none", () => {
    const finished = { what: "reply finished", at: "2026-10-06T04:48:20.000Z", replyFinished: true } as const;
    assert.deepEqual(screenBrief({ latestActivity: finished }).latestActivity, {
        text: "reply finished",
        at: "2026-10-06T04:48:20.000Z",
    });
    assert.equal(screenBrief({ latestActivity: null }).latestActivity, null);
});

test("Needs you nothing stays nothing, and unknown stays unknown", () => {
    assert.deepEqual(screenBrief({ needsYou: { state: "nothing", at: "2026-10-06T04:48:00.000Z" } }).needsYou, {
        state: "nothing",
    });
    assert.deepEqual(screenBrief({ needsYou: { state: "unknown" } }).needsYou, { state: "unknown" });
    assert.deepEqual(screenBrief({ needsYou: { state: "unknown", at: "2026-10-06T04:48:00.000Z" } }).needsYou, {
        state: "unknown",
    });
});

test("a wait Izbor saw no request for keeps Claude Code's name for it and its time while Izbor gives a reason it cannot answer; with no reason it is plain unknown", () => {
    const wait = { state: "unknown", at: "2026-10-06T04:48:00.000Z", waitingFor: "permission prompt" } as const;
    for (const answerable of ["not running when it asked", "not an acting project"] as const)
        assert.deepEqual(screenBrief({ needsYou: wait, answerable }), {
            ...screenBrief({ needsYou: wait, answerable: null }),
            needsYou: { state: "unknown", waitingFor: "permission prompt", at: "2026-10-06T04:48:00.000Z" },
            answerable,
        });
    assert.deepEqual(screenBrief({ needsYou: wait, answerable: null }).needsYou, { state: "unknown" });
    assert.deepEqual(screenBrief({ needsYou: wait, answerable: true }).needsYou, { state: "unknown" });
    const long = screenBrief({ needsYou: { ...wait, waitingFor: `a\nb ${"x".repeat(600)}` } }).needsYou;
    assert.ok(long.state === "unknown" && long.waitingFor?.length === 500 && long.waitingFor.startsWith("a b x"));
});

const request = (tool: string, input?: unknown, agentId: string | null = null) => {
    const { needsYou } = screenBrief({
        needsYou: { state: "request", at: "2026-10-06T04:47:58.998Z", agentId, tool, input },
    });
    assert.ok(needsYou.state === "request");
    return needsYou;
};
const requestText = (tool: string, input?: unknown, agentId: string | null = null) =>
    request(tool, input, agentId).text;

test("a request's text is one headline per tool, from the tool's title field", () => {
    assert.deepEqual(
        [
            requestText("Bash", { command: "npm test", description: "run the tests" }),
            requestText("Read", { file_path: "src/a.ts" }),
            requestText("Edit", { file_path: "src/b.ts", old_string: "x", new_string: "y" }),
            requestText("Write", { file_path: "src/c.ts", content: "export {};" }),
            requestText("NotebookEdit", { notebook_path: "nb.ipynb", new_source: "1" }),
            requestText("Grep", { pattern: "redirect", path: "src" }),
            requestText("Glob", { pattern: "**/*.ts" }),
            requestText("WebFetch", { url: "https://example.com", prompt: "read it" }),
            requestText("WebSearch", { query: "node test runner" }),
            requestText("Agent", { description: "Find the bug", prompt: "look" }),
            requestText("Task", { description: "Write the docs", prompt: "write" }),
        ],
        [
            "Bash: npm test",
            "Read: src/a.ts",
            "Edit: src/b.ts",
            "Write: src/c.ts",
            "NotebookEdit: nb.ipynb",
            "Grep: redirect",
            "Glob: **/*.ts",
            "WebFetch: https://example.com",
            "WebSearch: node test runner",
            "Agent: Find the bug",
            "Task: Write the docs",
        ],
    );
});

test("a question is its question with no tool name, then its options numbered as an answer names them, one per line", () => {
    const questions = [
        { question: "Which file?", options: [{ label: "a.ts" }, { label: "b.ts" }], multiSelect: false },
    ];
    assert.deepEqual(request("AskUserQuestion", { questions }), {
        state: "request",
        text: "Which file?",
        detail: "1. a.ts\n2. b.ts",
        takes: "number",
        at: "2026-10-06T04:47:58.998Z",
    });
});

test("a question no number answers shows its questions, not numbered options: each further question on a line of its own", () => {
    const [file, why] = [
        { question: "Which file?", options: [{ label: "a.ts" }, { label: "b.ts" }] },
        { question: "Why?", options: [{ label: "speed" }] },
    ];
    const at = "2026-10-06T04:47:58.998Z";
    assert.deepEqual(request("AskUserQuestion", { questions: [file, why, { question: "When?" }] }), {
        state: "request",
        text: "Which file?",
        detail: "Why?\nWhen?",
        at,
    });
    const several = { state: "request", text: "Which file?", detail: "Which file?", at };
    assert.deepEqual(request("AskUserQuestion", { questions: [{ ...file, multiSelect: true }] }), several);
    assert.deepEqual(request("AskUserQuestion", { questions: [{ ...file, kind: "text" }] }), several);
    assert.deepEqual(request("AskUserQuestion", { questions: [{ question: "Which file?" }] }), several);
});

test("a subagent's question says that a subagent asks", () => {
    const questions = [{ question: "Which file?", options: [{ label: "a.ts" }] }];
    const asked = request("AskUserQuestion", { questions }, "a1b2c3d4e5f60718");
    assert.equal(asked.text, "a subagent asks: Which file?");
    assert.equal(asked.detail, "1. a.ts");
});

test("a tool with no title field, or a request with no input, reads as the tool's name; no tool name reads as a request", () => {
    assert.equal(requestText("TodoWrite", { todos: [{ content: "x" }] }), "TodoWrite");
    assert.equal(requestText("mcp__github__create_issue", { title: "Bug" }), "mcp__github__create_issue");
    assert.equal(requestText("Bash"), "Bash");
    assert.equal(requestText("Bash", null), "Bash");
    assert.equal(requestText("AskUserQuestion"), "AskUserQuestion");
    assert.equal(requestText("AskUserQuestion", { questions: "Which file?" }), "AskUserQuestion");
    assert.equal(requestText("", { command: "ls" }), "a request");
    assert.equal(requestText(" \n ", { command: "ls" }), "a request");
});

test("a subagent's request says that a subagent asks; the main thread's does not", () => {
    assert.equal(requestText("Bash", { command: "npm test" }, "a1b2c3d4e5f60718"), "a subagent asks: Bash: npm test");
    assert.equal(requestText("Bash", { command: "npm test" }, null), "Bash: npm test");
});

test("a request whose headline was shortened keeps the tool's whole input under it, line breaks kept; a subagent's too", () => {
    const multi = request("Bash", {
        command: "cd server\nnpm test invoices\ngit status",
        description: "Run the tests",
    });
    assert.equal(multi.text, "Bash: cd server …");
    assert.equal(multi.detail, "cd server\nnpm test invoices\ngit status");
    const long = "npm test " + "invoices ".repeat(20);
    assert.equal(request("Bash", { command: long }).detail, long.trim());
    assert.equal(request("Bash", { command: "a\nb" }, "a1b2c3d4e5f60718").detail, "a\nb");
    const write = request("Write", { file_path: "/tmp/a.ts", content: "line\n".repeat(500) });
    assert.equal(write.detail, write.text);
    const other = request("mcp__x__y", { a: "b\nc" });
    assert.equal(other.detail, other.text);
});

test("past 500 characters the whole input is cut between words, and its last line says how much is left out and where to read it", () => {
    const lines = request("Bash", { command: ("word ".repeat(30) + "\n").repeat(12) }).detail.split("\n");
    assert.equal(lines.at(-1), "… and 1 305 more characters: read it in the session");
    assert.ok(lines.slice(0, -1).join("\n").length < 500);
    assert.ok(
        lines.slice(0, -1).every((line) => /^(word )*word$/.test(line)),
        "no word is cut",
    );
    const one = request("Bash", { command: "x".repeat(1740) }).detail.split("\n");
    assert.deepEqual(one, ["x".repeat(499), "… and 1 241 more characters: read it in the session"]);
});

const HUGE = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n");

function assertOneLine(text: string | undefined) {
    assert.ok(text !== undefined);
    assert.ok(text.length <= 500, `${text.length} characters`);
    assert.doesNotMatch(text, /[\n\r\u2028\u2029]/);
}

function assertCut(text: string | undefined) {
    assertOneLine(text);
    assert.match(text!, /^line 0 line 1 line 2 .*…$/);
}

test("every text of a huge, many-line brief comes out as one line of at most 500 characters", () => {
    const brief = screenBrief({
        task: { text: HUGE, at: "2026-10-06T04:47:56.833Z", from: "transcript" },
        latestActivity: { what: HUGE, at: "2026-10-06T04:47:58.998Z" },
        explanation: { state: "explained", text: HUGE, at: "2026-10-06T04:47:59.000Z" },
    });
    assertCut(brief.task?.text);
    assertCut(brief.latestActivity?.text);
    assertCut(brief.explanation?.text);
    assertCut(screenBrief({ explanation: { state: "unknown", reason: HUGE } }).explanationUnknownReason);
});

test("a Task cut at 500 characters stops before a grapheme that would reach 500: an accented e, a flag and a family go whole or not at all", () => {
    const taskOf = (text: string) =>
        screenBrief({ task: { text, at: "2026-10-06T04:47:56.833Z", from: "hook" } }).task?.text;
    assert.equal(taskOf(`${"a".repeat(498)}e\u{0301}${"z".repeat(10)}`), `${"a".repeat(498)}…`);
    assert.equal(taskOf(`${"a".repeat(497)}\u{1F1FA}\u{1F1F8}${"z".repeat(10)}`), `${"a".repeat(497)}…`);
    assert.equal(
        taskOf(`${"a".repeat(494)}\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}${"z".repeat(10)}`),
        `${"a".repeat(494)}…`,
    );
    assert.equal(taskOf(`${"a".repeat(496)}e\u{0301}${"z".repeat(10)}`), `${"a".repeat(496)}e\u{0301}z…`);
});

test("a request with a huge tool name or input comes out as one line of at most 500 characters", () => {
    assertCut(requestText(HUGE, { command: "ls" }));
    const bySubagent = requestText(HUGE, { command: "ls" }, "a1b2c3d4e5f60718");
    assertOneLine(bySubagent);
    assert.match(bySubagent, /^a subagent asks: line 0 line 1 line 2 .*…$/);
    assertOneLine(requestText("Bash", { command: HUGE }));
    assertOneLine(requestText("Bash", { command: "x".repeat(1_000_000) }));
    const huge = request("AskUserQuestion", { questions: [{ question: HUGE, options: [{ label: HUGE }] }] });
    assertCut(huge.text);
    assert.match(huge.detail, /^1\. line 0 line 1 line 2 [^\n]*…$/);
    assert.ok(huge.detail.length <= 500 + 3);
    assertCut(request(HUGE, { command: "ls" }).detail);
});

test("a Write request of a 1 MB file takes 3 lines or fewer on the screen", () => {
    const text = requestText("Write", { file_path: `/tmp/${"d/".repeat(500_000)}c.ts`, content: HUGE });
    assert.ok(wrapText(`Needs you: ${text}`, 92).split("\n").length <= 3);
});

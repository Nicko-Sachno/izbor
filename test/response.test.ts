import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readHook } from "../src/adapters/agents/claude/hook.js";
import { toMessageRecord } from "../src/adapters/agents/claude/messageRecord.js";
import { needsYouAfterHook, type NeedsYou } from "../src/domain/brief.js";
import type {
    FullResponse,
    ResponseEnd,
    ResponseItem,
    ToolItem,
    ToolResult,
    ToolState,
} from "../src/domain/response.js";
import { fullResponse, NO_RESPONSE, responseAfterHook, responseAfterRecords } from "../src/domain/responseItems.js";
import { transcriptFixture } from "./helpers/transcripts.js";
import { dated, fakeAgents, fakeClock, hook, msg, prompt, setup, testClock, until } from "./support.js";

const at = (hms: string) => `2026-10-01T${hms}.000Z`;

/** A hook's time: a time of day on the test's date, or a whole time. */
const when = (time: string) => (time.includes("T") ? time : at(time));

/** A transcript row as the SDK gives it, with the time and the origin the transcript adds. */
function row(uuid: string, type: SessionMessage["type"], content: unknown, hms: string, origin?: object) {
    const fromTranscript = { timestamp: at(hms), ...(origin && { origin }) };
    return { ...msg(type, content), uuid, ...fromTranscript };
}

const asked = (uuid: string, hms: string, text: string) => row(uuid, "user", text, hms, { kind: "human" });
const said = (uuid: string, hms: string, text: string) => row(uuid, "assistant", [{ type: "text", text }], hms);
const called = (uuid: string, hms: string, id: string, name: string, input: object) =>
    row(uuid, "assistant", [{ type: "tool_use", id, name, input }], hms);
const answered = (uuid: string, hms: string, id: string, content: unknown, failed = false) =>
    row(uuid, "user", [{ type: "tool_result", tool_use_id: id, content, ...(failed && { is_error: true }) }], hms);

/** What a subagent started in the background returns at once, as its result's first line, for the model to read. */
const launched =
    "Async agent launched successfully. (This tool result is internal metadata \u2014 never quote or paste any part " +
    "of it, including the agentId below, into a user-facing reply.)";

const text = (id: string, hms: string, words: string): ResponseItem => ({ type: "text", id, at: at(hms), text: words });
const tool = (id: string, hms: string, call: Omit<ToolItem, "type" | "id" | "at">): ResponseItem => ({
    type: "tool",
    id,
    at: at(hms),
    ...call,
});

type Step = { read: SessionMessage[]; agentId?: string } | { hook: object; hms: string };

/** The full response after the steps, with the Needs you the hooks give and its log of changes, as the brief keeper
 *  keeps them. */
function responseAfter(steps: Step[]): FullResponse | null {
    let state = NO_RESPONSE;
    let needsYou: NeedsYou = { state: "unknown" };
    let needsYouLog: NeedsYou[] = [needsYou];
    for (const step of steps) {
        if ("hook" in step) {
            const { evidence, cwd } = readHook(JSON.stringify(step.hook), new Date(when(step.hms)))!;
            state = responseAfterHook(state, evidence, cwd);
            const next = needsYouAfterHook(needsYou, evidence);
            if (!isDeepStrictEqual(next, needsYou)) needsYouLog = [...needsYouLog, next];
            needsYou = next;
        } else {
            const records = step.read.map((message) => toMessageRecord(message, step.agentId ?? null));
            state = responseAfterRecords(state, records, needsYouLog);
        }
    }
    return fullResponse(state, needsYou, "transcript");
}

const itemsAfter = (steps: Step[]) => responseAfter(steps)?.items ?? null;

type Command = { command: string; description: string };
type Told = Pick<ToolItem, "result" | "summary">;

const bash = (id: string, hms: string, { command, description }: Command, state: ToolState, told: Told = {}) =>
    tool(id, hms, {
        name: "Bash",
        kind: "execute",
        title: command,
        display: "Bash",
        argument: command,
        description,
        state,
        ...told,
    });

const lint = { command: "npm run lint", description: "Lint the code" };
const tests = { command: "npm test", description: "Run the tests" };
const sleep = { command: "sleep 30", description: "Wait 30 seconds" };
const build = { command: "npm run build", description: "Build the app" };
const docs = { url: "https://example.com/docs", prompt: "Summarise the page" };

const fetched = (state: ToolState) =>
    tool("f1", "12:00:02", {
        name: "WebFetch",
        kind: "fetch",
        title: docs.url,
        display: "WebFetch",
        argument: docs.url,
        state,
    });

/** A Task with two Bash calls that run, as the transcript gives them. */
const lintThenTest: Step[] = [
    { hook: hook("UserPromptSubmit", { prompt: "lint and test" }), hms: "12:00:00" },
    {
        read: [
            asked("m1", "12:00:00", "lint and test"),
            called("m2", "12:00:02", "b1", "Bash", lint),
            called("m3", "12:00:03", "b2", "Bash", tests),
        ],
    },
];

/** A Task with one Bash call that runs. */
const sleeping: Step[] = [
    { hook: hook("UserPromptSubmit", { prompt: "wait a bit" }), hms: "12:00:00" },
    { read: [asked("m1", "12:00:00", "wait a bit"), called("m2", "12:00:02", "b1", "Bash", sleep)] },
];

/** A Task with one WebFetch call that runs. */
const fetching: Step[] = [
    { hook: hook("UserPromptSubmit", { prompt: "read the docs" }), hms: "12:00:00" },
    { read: [asked("m1", "12:00:00", "read the docs"), called("m2", "12:00:02", "f1", "WebFetch", docs)] },
];

const asks = (tool_name: string, tool_input: object, extra = {}) =>
    hook("PermissionRequest", { tool_name, tool_input, ...extra });

const INTERRUPT_LINE = "[Request interrupted by user for tool use]";

/** A PostToolUseFailure after Esc. No recording could be taken, so its fields are built from the bundled Claude Code's
 *  (2.1.286) program text: `is_interrupt` is true only when a tool stops by an abort error, whose `error` is the
 *  interrupt line. */
const abortedHook = (tool_use_id: string) =>
    hook("PostToolUseFailure", {
        tool_name: "WebFetch",
        tool_input: docs,
        tool_use_id,
        error: INTERRUPT_LINE,
        is_interrupt: true,
        duration_ms: 5021,
    });

/** A Bash command stopped by Esc fails with a shell error instead: `is_interrupt` false, and an `error` of the exit
 *  code and the interrupt line. Built from the same program text; the exit code 143 is a stand-in. */
const escInBashHook = (tool_use_id: string, input: Command) =>
    hook("PostToolUseFailure", {
        tool_name: "Bash",
        tool_input: input,
        tool_use_id,
        error: `Exit code 143\n${INTERRUPT_LINE}`,
        is_interrupt: false,
        duration_ms: 5021,
    });

/** The transcript rows Claude Code writes after Esc while a call runs, as recorded on 2026-10-02 (test/brief.test.ts). */
const endedByUser = (uuid: string, hms: string, id: string) => [
    answered(
        uuid,
        hms,
        id,
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        true,
    ),
    row(`${uuid}-marker`, "user", [{ type: "text", text: INTERRUPT_LINE }], hms),
];

const notification =
    "<task-notification>\n<task-id>b1x9i5zos</task-id>\n<status>completed</status>\n" +
    '<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';

const ROWS: [string, Step[], ResponseItem[] | null][] = [
    [
        "items come only from the main thread's records after the Task's last prompt, each named as the agent names it",
        [
            {
                read: [
                    asked("m1", "11:00:00", "tell me a story"),
                    said("m2", "11:00:05", "Once upon a time"),
                    asked("m3", "12:00:00", "fix the login redirect"),
                    row(
                        "m4",
                        "assistant",
                        [
                            { type: "text", text: "I'll fix the redirect." },
                            {
                                type: "tool_use",
                                id: "e1",
                                name: "Edit",
                                input: { file_path: "src/auth.ts", old_string: "/", new_string: "/home" },
                            },
                        ],
                        "12:00:03",
                    ),
                    answered("m5", "12:00:04", "e1", "The file src/auth.ts has been updated."),
                    called("m6", "12:00:05", "e2", "Edit", {
                        file_path: "src/home.ts",
                        old_string: "",
                        new_string: "x",
                    }),
                    answered("m7", "12:00:06", "e2", "File has not been read yet.", true),
                ],
            },
        ],
        [
            text("m4:0", "12:00:03", "I'll fix the redirect."),
            tool("e1", "12:00:03", {
                name: "Edit",
                kind: "edit",
                title: "src/auth.ts",
                display: "Update",
                argument: "src/auth.ts",
                state: "done",
                result: { kind: "first line", text: "The file src/auth.ts has been updated." },
                summary: "The file src/auth.ts has been updated.",
            }),
            tool("e2", "12:00:05", {
                name: "Edit",
                kind: "edit",
                title: "src/home.ts",
                display: "Create",
                argument: "src/home.ts",
                state: "failed",
                result: { kind: "failed", firstLine: "File has not been read yet." },
                summary: "File has not been read yet.",
            }),
        ],
    ],
    [
        "a call that left its work in the background reads so by its transcript row alone, never by its words for the model",
        [
            {
                read: [
                    asked("m1", "12:00:00", "run the tests"),
                    called("m2", "12:00:02", "b1", "Bash", { command: "npm test", run_in_background: true }),
                    answered("m3", "12:00:03", "b1", "Command running in background with ID: b4c1e2. Output is…"),
                    called("m4", "12:00:04", "b2", "Bash", { command: "npm run e2e" }),
                    answered(
                        "m5",
                        "12:02:04",
                        "b2",
                        "Command did not complete within its 120s timeout and was moved to the background (ID: c5d6). Output is…",
                    ),
                    called("m6", "12:02:05", "s1", "Agent", {
                        description: "Lint",
                        prompt: "Lint it.",
                        run_in_background: true,
                    }),
                    answered("m7", "12:02:06", "s1", [
                        { type: "text", text: `${launched}\nagentId: a1b2 (internal ID)` },
                    ]),
                ],
            },
        ],
        [
            tool("b1", "12:00:02", {
                name: "Bash",
                kind: "execute",
                title: "npm test",
                display: "Bash",
                argument: "npm test",
                state: "done",
                result: { kind: "background" },
                summary: "Running in the background",
            }),
            tool("b2", "12:00:04", {
                name: "Bash",
                kind: "execute",
                title: "npm run e2e",
                display: "Bash",
                argument: "npm run e2e",
                state: "done",
                result: { kind: "background" },
                summary: "Running in the background",
            }),
            {
                type: "subagent",
                id: "s1",
                at: at("12:02:05"),
                display: "Task",
                description: "Lint",
                state: "done",
                result: { kind: "background" },
                summary: "Running in the background",
            },
        ],
    ],
    [
        "thinking and a subagent's records give no item",
        [
            {
                read: [
                    asked("m1", "12:00:00", "fix the login redirect"),
                    row(
                        "m2",
                        "assistant",
                        [
                            { type: "thinking", thinking: "The router decides.", signature: "sig" },
                            { type: "text", text: "The router sends you home." },
                        ],
                        "12:00:02",
                    ),
                    called("m3", "12:00:03", "g1", "Grep", { pattern: "redirect", path: "src" }),
                ],
            },
            {
                agentId: "a1b2c3d4",
                read: [said("s1", "12:00:04", "Found it."), called("s2", "12:00:05", "r1", "Read", { file_path: "a" })],
            },
        ],
        [
            text("m2:1", "12:00:02", "The router sends you home."),
            tool("g1", "12:00:03", {
                name: "Grep",
                kind: "search",
                title: "redirect",
                display: "Search",
                argument: "redirect",
                state: "running",
            }),
        ],
    ],
    [
        "an Agent call is one subagent item, with its type and description",
        [
            {
                read: [
                    asked("m1", "12:00:00", "find the callers"),
                    called("m2", "12:00:02", "t1", "Agent", {
                        description: "Find callers",
                        prompt: "Find every caller of redirect().",
                        subagent_type: "Explore",
                    }),
                ],
            },
            { agentId: "a1b2c3d4", read: [said("s1", "12:00:03", "Two callers.")] },
            { read: [answered("m3", "12:01:00", "t1", "Two callers: login and logout.")] },
        ],
        [
            {
                type: "subagent",
                id: "t1",
                at: at("12:00:02"),
                agentType: "Explore",
                display: "Task",
                description: "Find callers",
                state: "done",
                result: { kind: "first line", text: "Two callers: login and logout." },
                summary: "Two callers: login and logout.",
            },
        ],
    ],
    [
        "a task notification adds a notice and starts no new response",
        [
            {
                read: [
                    asked("m1", "12:00:00", "run the tests"),
                    said("m2", "12:00:02", "The tests run in the background."),
                ],
            },
            { hook: hook("UserPromptSubmit", { prompt: notification }), hms: "12:01:00" },
            {
                read: [
                    row("m3", "user", notification, "12:01:00", {
                        kind: "task-notification",
                        producer: "session-task",
                    }),
                    said("m4", "12:01:02", "The tests pass."),
                ],
            },
        ],
        [
            text("m2:0", "12:00:02", "The tests run in the background."),
            { type: "notice", id: "m3:1", at: at("12:01:00"), text: "background task finished" },
            text("m4:0", "12:01:02", "The tests pass."),
        ],
    ],
    [
        "a late record stamped before the hook's Task is skipped",
        [
            { read: [asked("m1", "11:58:00", "tell me a story"), said("m2", "11:58:30", "Once upon a time")] },
            { hook: hook("UserPromptSubmit", { prompt: "fix the login redirect" }), hms: "12:00:00" },
            { read: [said("m3", "11:59:58", "The end."), said("m4", "12:00:02", "Looking at the router.")] },
        ],
        [text("m4:0", "12:00:02", "Looking at the router.")],
    ],
    [
        "resending every record, as a rebuild does, gives the same items, also when the prompt record came before the hook",
        [
            { hook: hook("UserPromptSubmit", { prompt: "file the bug" }), hms: "12:00:00" },
            ...[1, 2].map(() => ({
                read: [
                    asked("m1", "11:59:59", "file the bug"),
                    said("m2", "12:00:02", "Filing it."),
                    called("m3", "12:00:03", "i1", "mcp__github__create_issue", {
                        title: "Login loops",
                        body: "Steps",
                    }),
                    answered("m4", "12:00:05", "i1", "Created issue #12."),
                ],
            })),
        ],
        [
            text("m2:0", "12:00:02", "Filing it."),
            tool("i1", "12:00:03", {
                name: "mcp__github__create_issue",
                kind: "other",
                title: "mcp__github__create_issue",
                display: "github · create_issue",
                argument: "Login loops",
                state: "done",
                result: { kind: "first line", text: "Created issue #12." },
                summary: "Created issue #12.",
            }),
        ],
    ],
    [
        "a path inside the session's folder is relative to it, one outside it stays whole",
        [
            { hook: hook("UserPromptSubmit", { prompt: "read the auth code", cwd: "/repo" }), hms: "12:00:00" },
            {
                read: [
                    called("m1", "12:00:02", "r1", "Read", { file_path: "/repo/src/auth.ts" }),
                    called("m2", "12:00:03", "r2", "Read", { file_path: "/repository/notes.txt" }),
                    called("m3", "12:00:04", "b1", "Bash", {
                        command: "cat /repo/src/auth.ts",
                        description: "Show it",
                    }),
                ],
            },
        ],
        [
            tool("r1", "12:00:02", {
                name: "Read",
                kind: "read",
                title: "/repo/src/auth.ts",
                display: "Read",
                argument: "src/auth.ts",
                state: "running",
            }),
            tool("r2", "12:00:03", {
                name: "Read",
                kind: "read",
                title: "/repository/notes.txt",
                display: "Read",
                argument: "/repository/notes.txt",
                state: "running",
            }),
            tool("b1", "12:00:04", {
                name: "Bash",
                kind: "execute",
                title: "cat /repo/src/auth.ts",
                display: "Bash",
                argument: "cat /repo/src/auth.ts",
                description: "Show it",
                state: "running",
            }),
        ],
    ],
    ["while the Task is unknown there is no response", [{ read: [said("m1", "12:00:02", "Done.")] }], null],
    [
        "a main-thread request in Needs you marks the running call with its tool and input waiting",
        [...lintThenTest, { hook: asks("Bash", tests), hms: "12:00:04" }],
        [bash("b1", "12:00:02", lint, "running"), bash("b2", "12:00:03", tests, "waiting")],
    ],
    [
        "the request finds its call whatever the order of the input's keys: the hook's order is not the transcript's",
        [
            { hook: hook("UserPromptSubmit", { prompt: "build it" }), hms: "12:00:00" },
            {
                read: [
                    asked("m1", "12:00:00", "build it"),
                    called("m2", "12:00:02", "b1", "Bash", { ...build, timeout: 600000 }),
                ],
            },
            {
                hook: asks("Bash", { command: build.command, timeout: 600000, description: build.description }),
                hms: "12:00:03",
            },
        ],
        [bash("b1", "12:00:02", build, "waiting")],
    ],
    [
        "a subagent's request marks no main-thread call, even one with the same tool and input",
        [...lintThenTest, { hook: asks("Bash", tests, { agent_id: "a1b2c3d4" }), hms: "12:00:04" }],
        [bash("b1", "12:00:02", lint, "running"), bash("b2", "12:00:03", tests, "running")],
    ],
    [
        "PostToolUse ends the request and the call: it is done with its result before its transcript row is read",
        [
            ...lintThenTest,
            { hook: asks("Bash", tests), hms: "12:00:04" },
            {
                hook: hook("PostToolUse", {
                    tool_name: "Bash",
                    tool_input: tests,
                    tool_use_id: "b2",
                    tool_response: { stdout: "42 passing\n", stderr: "", interrupted: false, isImage: false },
                }),
                hms: "12:00:09",
            },
        ],
        [
            bash("b1", "12:00:02", lint, "running"),
            bash("b2", "12:00:03", tests, "done", {
                result: { kind: "ran", exitCode: 0, firstLine: "42 passing" },
                summary: "42 passing",
            }),
        ],
    ],
    [
        "PostToolUse ends a call whose result Izbor does not read: it is done, with no result yet",
        [
            ...fetching,
            {
                hook: hook("PostToolUse", {
                    tool_name: "WebFetch",
                    tool_input: docs,
                    tool_use_id: "f1",
                    tool_response: { bytes: 2048, code: 200, codeText: "OK", result: "The docs.", durationMs: 812 },
                }),
                hms: "12:00:05",
            },
        ],
        [fetched("done")],
    ],
    [
        "a PostToolUseFailure with no is_interrupt leaves the call to its transcript row: it runs, with no failure",
        [...sleeping, { hook: escInBashHook("b1", sleep), hms: "12:00:07" }],
        [bash("b1", "12:00:02", sleep, "running")],
    ],
    [
        "a PostToolUseFailure with is_interrupt reads interrupted at once, with no result",
        [...fetching, { hook: abortedHook("f1"), hms: "12:00:07" }],
        [fetched("interrupted")],
    ],
    [
        "is_interrupt wins over the Needs you log: a call granted in Claude Code, then stopped with Esc, is not rejected",
        [
            ...fetching,
            { hook: asks("WebFetch", docs), hms: "12:00:03" },
            { hook: abortedHook("f1"), hms: "12:00:09" },
            { read: endedByUser("m3", "12:00:08", "f1") },
        ],
        [fetched("interrupted")],
    ],
    [
        "Esc in Bash carries no is_interrupt: the transcript and the Needs you log decide, and the call shows no failure",
        [
            ...sleeping,
            { hook: escInBashHook("b1", sleep), hms: "12:00:07" },
            { read: endedByUser("m3", "12:00:06", "b1") },
        ],
        [bash("b1", "12:00:02", sleep, "interrupted")],
    ],
];

test("the full response holds the Task's response items in order, from the transcript and the hooks", () => {
    for (const [name, steps, expected] of ROWS) assert.deepEqual(itemsAfter(steps), expected, name);
});

type Ending = { event: "PostToolUse"; tool_response: object } | { event: "PostToolUseFailure"; error: string };

const ENDS = ["state", "result", "summary", "toolUses", "durationMs"];

/** The call's state, result, words and counts after its hook and then its transcript row, in the session's folder. */
function endedCall(tool: string, input: object, ending: Ending, output: unknown) {
    const { event, ...told } = ending;
    const [item] = itemsAfter([
        { hook: hook("UserPromptSubmit", { prompt: "tidy the notes", cwd: "/repo" }), hms: "12:00:00" },
        { read: [asked("m1", "12:00:00", "tidy the notes"), called("m2", "12:00:02", "c1", tool, input)] },
        { hook: hook(event, { tool_name: tool, tool_input: input, tool_use_id: "c1", ...told }), hms: "12:00:04" },
        { read: [answered("m3", "12:00:05", "c1", output, event === "PostToolUseFailure")] },
    ])!;
    return Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => ENDS.includes(key)));
}

const done = (result: ToolResult, summary: string) => ({ state: "done", result, summary });
const failed = (result: ToolResult, summary: string) => ({ state: "failed", result, summary });
const responded = (tool_response: object): Ending => ({ event: "PostToolUse", tool_response });
const notes = "one\ntwo\nthree\nfour\nfive\n";

const RESULTS: [string, string, object, Ending, unknown, object][] = [
    [
        "Read",
        "Read",
        { file_path: "/repo/notes.txt" },
        responded({
            type: "text",
            file: { filePath: "/repo/notes.txt", content: notes, numLines: 5, startLine: 1, totalLines: 5 },
        }),
        "     1\u2192one\n     2\u2192two\n     3\u2192three\n     4\u2192four\n     5\u2192five\n",
        done({ kind: "read", lines: 5 }, "Read 5 lines"),
    ],
    [
        "Write, a new file inside the session's folder",
        "Write",
        { file_path: "/repo/notes.txt", content: notes },
        responded({
            type: "create",
            filePath: "/repo/notes.txt",
            content: notes,
            structuredPatch: [],
            originalFile: null,
        }),
        "File created successfully at: /repo/notes.txt",
        done({ kind: "wrote", lines: 5, path: "notes.txt", created: true }, "Wrote 5 lines to notes.txt"),
    ],
    [
        "Create, an Edit whose old_string is empty",
        "Edit",
        { file_path: "/repo/src/csv.ts", old_string: "", new_string: 'export const SEPARATOR = ",";\n' },
        responded({
            filePath: "/repo/src/csv.ts",
            oldString: "",
            newString: 'export const SEPARATOR = ",";\n',
            originalFile: null,
            structuredPatch: [
                { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export const SEPARATOR = ",";'] },
            ],
            userModified: false,
            replaceAll: false,
        }),
        "The file /repo/src/csv.ts has been updated successfully.",
        done({ kind: "wrote", lines: 1, path: "src/csv.ts", created: true }, "Wrote 1 line to src/csv.ts"),
    ],
    [
        "a Write over a file, with the lines its patch added and removed",
        "Write",
        { file_path: "/repo/notes.txt", content: "uno\ndos\ntres\n" },
        responded({
            type: "update",
            filePath: "/repo/notes.txt",
            content: "uno\ndos\ntres\n",
            structuredPatch: [
                {
                    oldStart: 1,
                    oldLines: 5,
                    newStart: 1,
                    newLines: 3,
                    lines: ["-one", "-two", "-three", "-four", "-five", "+uno", "+dos", "+tres"],
                },
            ],
            originalFile: notes,
        }),
        "The file /repo/notes.txt has been updated. Here's the result of running `cat -n` on a snippet of the edited file:",
        done(
            { kind: "wrote", lines: 3, path: "notes.txt", created: false, added: 3, removed: 5 },
            "Wrote 3 lines to notes.txt",
        ),
    ],
    [
        "Edit",
        "Edit",
        { file_path: "/repo/notes.txt", old_string: "two", new_string: "TWO" },
        responded({
            filePath: "/repo/notes.txt",
            oldString: "two",
            newString: "TWO",
            originalFile: notes,
            structuredPatch: [
                { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] },
            ],
            userModified: false,
            replaceAll: false,
        }),
        "The file /repo/notes.txt has been updated successfully.",
        done({ kind: "changed", added: 1, removed: 1, path: "notes.txt" }, "Added 1 line, removed 1 line"),
    ],
    [
        "an Edit that only adds lines leaves out the removed part, as the agent does",
        "Edit",
        { file_path: "/repo/notes.txt", old_string: "five", new_string: "five\nsix\nseven" },
        responded({
            filePath: "/repo/notes.txt",
            oldString: "five",
            newString: "five\nsix\nseven",
            originalFile: notes,
            structuredPatch: [
                { oldStart: 4, oldLines: 2, newStart: 4, newLines: 4, lines: [" four", " five", "+six", "+seven"] },
            ],
            userModified: false,
            replaceAll: false,
        }),
        "The file /repo/notes.txt has been updated successfully.",
        done({ kind: "changed", added: 2, removed: 0, path: "notes.txt" }, "Added 2 lines"),
    ],
    [
        "an Edit that only removes lines leaves out the added part",
        "Edit",
        { file_path: "/repo/notes.txt", old_string: "four\nfive\n", new_string: "" },
        responded({
            filePath: "/repo/notes.txt",
            oldString: "four\nfive\n",
            newString: "",
            originalFile: notes,
            structuredPatch: [
                { oldStart: 3, oldLines: 3, newStart: 3, newLines: 1, lines: [" three", "-four", "-five"] },
            ],
            userModified: false,
            replaceAll: false,
        }),
        "The file /repo/notes.txt has been updated successfully.",
        done({ kind: "changed", added: 0, removed: 2, path: "notes.txt" }, "Removed 2 lines"),
    ],
    [
        "Grep",
        "Grep",
        { pattern: "three", path: "/repo", output_mode: "files_with_matches" },
        responded({ mode: "files_with_matches", numFiles: 1, filenames: ["/repo/notes.txt"] }),
        "Found 1 file\nnotes.txt",
        done({ kind: "found", files: 1 }, "Found 1 file"),
    ],
    [
        "Glob",
        "Glob",
        { pattern: "*.txt" },
        responded({ durationMs: 4, numFiles: 2, filenames: ["/repo/notes.txt", "/repo/todo.txt"], truncated: false }),
        "/repo/notes.txt\n/repo/todo.txt",
        done({ kind: "found", files: 2 }, "Found 2 files"),
    ],
    [
        "Bash with exit 0 reads by its first output line",
        "Bash",
        { command: "ls", description: "List the files" },
        responded({
            stdout: "notes.txt\nsrc\n",
            stderr: "",
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
        }),
        "notes.txt\nsrc",
        done({ kind: "ran", exitCode: 0, firstLine: "notes.txt" }, "notes.txt"),
    ],
    [
        "a failed Bash gives its exit code and the first line after the empty one",
        "Bash",
        { command: "ls /nope", description: "List a missing folder" },
        { event: "PostToolUseFailure", error: "Exit code 1\n\nls: /nope: No such file or directory" },
        "Exit code 1\nls: /nope: No such file or directory",
        failed(
            { kind: "failed", exitCode: 1, firstLine: "ls: /nope: No such file or directory" },
            "Failed with exit code 1 · ls: /nope: No such file or directory",
        ),
    ],
    [
        "another failed call gives its first error line",
        "Read",
        { file_path: "/repo/todo.txt" },
        {
            event: "PostToolUseFailure",
            error: "File does not exist. Note: your current working directory is /repo.\nDid you mean notes.txt?",
        },
        "<tool_use_error>File does not exist. Note: your current working directory is /repo.</tool_use_error>",
        failed(
            { kind: "failed", firstLine: "File does not exist. Note: your current working directory is /repo." },
            "File does not exist. Note: your current working directory is /repo.",
        ),
    ],
    [
        "an Agent result gives the subagent's tool uses and time",
        "Agent",
        { description: "Find callers", prompt: "Find every caller of redirect().", subagent_type: "Explore" },
        responded({
            status: "completed",
            agentId: "a1b2c3d4e5f6a7b8c",
            agentType: "Explore",
            content: [{ type: "text", text: "Two callers: login and logout." }],
            totalToolUseCount: 4,
            totalDurationMs: 62000,
            totalTokens: 18234,
            prompt: "Find every caller of redirect().",
        }),
        [{ type: "text", text: "Two callers: login and logout." }],
        {
            ...done({ kind: "first line", text: "Two callers: login and logout." }, "Two callers: login and logout."),
            toolUses: 4,
            durationMs: 62000,
        },
    ],
    [
        "an Agent started in the background has no counts",
        "Agent",
        { description: "Run the suite", prompt: "Run every test.", run_in_background: true },
        responded({
            status: "async_launched",
            isAsync: true,
            agentId: "b2c3d4e5f6a7b8c9d",
            description: "Run the suite",
            prompt: "Run every test.",
            outputFile: "/tmp/tasks/b2c3d4e5f6a7b8c9d.output",
        }),
        [{ type: "text", text: `${launched}\nagentId: b2c3d4e5f6a7b8c9d (internal ID - do not mention to user.)` }],
        done({ kind: "background" }, "Running in the background"),
    ],
    [
        "a command sent to the background runs on there, whatever its result's words",
        "Bash",
        { command: "npm test", description: "Run the suite", run_in_background: true },
        responded({ stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "b4c1e2" }),
        "Command running in background with ID: b4c1e2. Output is being written to: /tmp/tasks/b4c1e2.output",
        done({ kind: "background" }, "Running in the background"),
    ],
    [
        "a path outside the session's folder stays whole",
        "Write",
        { file_path: "/repository/notes.txt", content: "a\nb\n" },
        responded({
            type: "create",
            filePath: "/repository/notes.txt",
            content: "a\nb\n",
            structuredPatch: [],
            originalFile: null,
        }),
        "File created successfully at: /repository/notes.txt",
        done(
            { kind: "wrote", lines: 2, path: "/repository/notes.txt", created: true },
            "Wrote 2 lines to /repository/notes.txt",
        ),
    ],
];

test("a call that ends while watched carries the hook's result, worded as the agent words it, its path relative to the session's folder", () => {
    for (const [name, tool, input, ending, output, expected] of RESULTS)
        assert.deepEqual(endedCall(tool, input, ending, output), expected, name);
});

/** A message whose model ended its turn, as the transcript gives it. */
function saidLast(uuid: string, hms: string, words: string) {
    const said_ = said(uuid, hms, words);
    return { ...said_, message: { ...(said_.message as object), model: "claude-opus-5-5", stop_reason: "end_turn" } };
}

/** An API error Claude Code writes in the model's place, shaped as its program text (2.1.286) builds one. */
const apiError = (uuid: string, hms: string, words: string) => ({
    ...row(uuid, "assistant", [], hms),
    message: {
        model: "<synthetic>",
        role: "assistant",
        type: "message",
        stop_reason: "stop_sequence",
        stop_sequence: "",
        content: [{ type: "text", text: words }],
    },
});

const denied = transcriptFixture("deny-interrupt").messages;

const FIXING: Step[] = [
    { hook: hook("UserPromptSubmit", { prompt: "fix the login redirect" }), hms: "12:00:00" },
    { read: [asked("m1", "12:00:00", "fix the login redirect"), said("m2", "12:00:02", "Looking at the router.")] },
];

const REPLY_ENDS: [string, Step[], { end: ResponseEnd; texts: string[] }][] = [
    [
        "a call the user refused, then the interrupt line of a tool call: ended at that call, named by its label",
        [
            { read: denied.slice(0, 3) },
            {
                hook: asks("Bash", {
                    command: "echo denied > deny.txt",
                    description: 'Write "denied" into deny.txt in the current directory',
                }),
                hms: "2026-10-09T10:59:13.700Z",
            },
            { read: denied.slice(3) },
        ],
        {
            end: {
                state: "ended at a tool call",
                at: "2026-10-09T10:59:42.249Z",
                call: "Bash: echo denied > deny.txt",
            },
            texts: [],
        },
    ],
    [
        "the bare interrupt line after a text: interrupted",
        [
            ...FIXING,
            { read: [row("m3", "user", [{ type: "text", text: "[Request interrupted by user]" }], "12:00:05")] },
        ],
        { end: { state: "interrupted", at: at("12:00:05") }, texts: ["Looking at the router."] },
    ],
    [
        "a main-thread StopFailure: failed with the error the user sees, and its API error record gives no text item",
        [
            ...FIXING,
            { read: [apiError("m3", "12:00:05", "API Error: 529 overloaded")] },
            {
                hook: hook("StopFailure", {
                    error: "overloaded",
                    error_details: "529 overloaded",
                    last_assistant_message: "API Error: 529 overloaded",
                }),
                hms: "12:00:06",
            },
        ],
        {
            end: { state: "failed", at: at("12:00:06"), error: "API Error: 529 overloaded" },
            texts: ["Looking at the router."],
        },
    ],
    [
        "a subagent's StopFailure leaves the end as it is",
        [
            ...FIXING,
            {
                hook: hook("StopFailure", {
                    agent_id: "a1b2c3d4",
                    agent_type: "Explore",
                    error: "rate_limit",
                    last_assistant_message: "API Error: Rate limited",
                }),
                hms: "12:00:06",
            },
        ],
        { end: { state: "writing", at: at("12:00:02") }, texts: ["Looking at the router."] },
    ],
    [
        "a watch that begins after the reply: the record that ended the model's turn tells it finished, at its time",
        [
            {
                read: [
                    asked("m1", "11:00:00", "explain the retry logic"),
                    saidLast("m2", "11:00:20", "Retries back off exponentially, up to five times."),
                ],
            },
        ],
        {
            end: { state: "finished", at: at("11:00:20") },
            texts: ["Retries back off exponentially, up to five times."],
        },
    ],
];

test("the full response says how the reply ended, and when", () => {
    for (const [name, steps, expected] of REPLY_ENDS) {
        const response = responseAfter(steps);
        const texts = response?.items.flatMap((item) => (item.type === "text" ? [item.text] : []));
        assert.deepEqual({ end: response?.end, texts }, expected, name);
    }
});

const explore = { description: "Find callers", prompt: "Find every caller of redirect().", subagent_type: "Explore" };

const EXPLAINING: Step = { hook: hook("UserPromptSubmit", { prompt: "explain the retries" }), hms: "12:00:00" };

test("past 20,000 characters of text, the earliest text items drop whole until 20,000 are left and `cut` counts them; the newest text stays whole, and no tool, subagent or notice item drops", () => {
    const busy: Step[] = [
        EXPLAINING,
        {
            read: [
                asked("m1", "12:00:00", "explain the retries"),
                said("m2", "12:00:01", "a".repeat(3_000)),
                called("m3", "12:00:02", "b1", "Bash", lint),
                said("m4", "12:00:03", "b".repeat(1_000)),
                called("m5", "12:00:04", "s1", "Agent", explore),
                row("m6", "user", notification, "12:00:05", { kind: "task-notification", producer: "session-task" }),
                said("m7", "12:00:06", "c".repeat(5_000)),
                said("m8", "12:00:07", "d".repeat(8_000)),
                said("m9", "12:00:08", "e".repeat(7_000)),
            ],
        },
    ];
    assert.deepEqual(responseAfter(busy), {
        items: [
            bash("b1", "12:00:02", lint, "running"),
            {
                type: "subagent",
                id: "s1",
                at: at("12:00:04"),
                agentType: "Explore",
                display: "Task",
                description: "Find callers",
                state: "running",
            },
            { type: "notice", id: "m6:1", at: at("12:00:05"), text: "background task finished" },
            text("m7:0", "12:00:06", "c".repeat(5_000)),
            text("m8:0", "12:00:07", "d".repeat(8_000)),
            text("m9:0", "12:00:08", "e".repeat(7_000)),
        ],
        end: { state: "writing", at: at("12:00:08") },
        source: "transcript",
        cut: 4_000,
    });

    const oneLong: Step[] = [
        EXPLAINING,
        {
            read: [
                asked("m1", "12:00:00", "explain the retries"),
                said("m2", "12:00:01", "a".repeat(1_000)),
                said("m3", "12:00:02", "b".repeat(21_000)),
            ],
        },
    ];
    assert.deepEqual(responseAfter(oneLong), {
        items: [text("m3:0", "12:00:02", "b".repeat(21_000))],
        end: { state: "writing", at: at("12:00:02") },
        source: "transcript",
        cut: 1_000,
    });
});

const REPLY = "The redirect is fixed: login now sends you to /home.";

test("a Stop brings the agent's last message in the same brief as reply finished, before any read, and the transcript's copy takes its place", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const transcript = [prompt("fix the login redirect", clock.iso("12:00:01"))];
    const { start, handle, brief, reads } = await setup(transcript, { wait: timer.wait, now: clock.now });
    await start();
    const readsBefore = reads.count;

    clock.at("12:00:09");
    const stopped = handle(hook("Stop", { last_assistant_message: REPLY }));
    const finished = brief();
    assert.equal(reads.count, readsBefore);
    assert.equal(finished.latestActivity?.replyFinished, true);
    assert.deepEqual(finished.response, {
        items: [{ type: "text", id: "last message", at: clock.iso("12:00:09"), text: REPLY }],
        end: { state: "finished", at: clock.iso("12:00:09") },
        source: "transcript",
        cut: 0,
    });

    await timer.advance(300);
    await stopped;
    const last = dated(msg("assistant", [{ type: "text", text: REPLY }]), clock.iso("12:00:08"));
    transcript.push(last);
    await timer.advance(1000);
    await until(() => brief().response?.items[0]?.id !== "last message");

    assert.equal(reads.count, readsBefore + 2);
    assert.deepEqual(brief().response?.items, [
        { type: "text", id: `${last.uuid}:0`, at: clock.iso("12:00:08"), text: REPLY },
    ]);
    assert.deepEqual(brief().response?.end, { state: "finished", at: clock.iso("12:00:09") });
});

test("when a sync reads the agent's last message before the Stop, the Stop adds no second copy", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const agents = fakeAgents({ status: "busy" });
    const transcript = [prompt("fix the login redirect", clock.iso("12:00:01"))];
    const { start, handle, brief, readStatuses } = await setup(transcript, {
        wait: timer.wait,
        now: clock.now,
        ...agents,
    });
    await start();

    const last = dated(msg("assistant", [{ type: "text", text: REPLY }]), clock.iso("12:00:08"));
    transcript.push(last);
    agents.session = { status: "idle" };
    clock.at("12:00:08");
    await timer.advance(2000);
    await until(async () => (await readStatuses()).some((s) => s.status === "idle") && timer.dueWithin(300));
    await timer.advance(300);
    await until(() => brief().response?.items.length === 1);

    clock.at("12:00:09");
    void handle(hook("Stop", { last_assistant_message: REPLY }));
    assert.equal(brief().latestActivity?.replyFinished, true);
    assert.deepEqual(brief().response?.items, [
        { type: "text", id: `${last.uuid}:0`, at: clock.iso("12:00:08"), text: REPLY },
    ]);
    assert.deepEqual(brief().response?.end, { state: "finished", at: clock.iso("12:00:09") });
});

/** A watch whose transcript reads until `sdk.down` is set: the Task, a text and a running Bash call. */
async function readThenFail() {
    const timer = fakeClock();
    const clock = testClock();
    const sdk = { down: false };
    const transcript = [
        prompt("lint the code", clock.iso("12:00:01")),
        dated(msg("assistant", [{ type: "text", text: "I'll run the linter." }]), clock.iso("12:00:02")),
        dated(msg("assistant", [{ type: "tool_use", id: "b1", name: "Bash", input: lint }]), clock.iso("12:00:03")),
    ];
    const watch = await setup(transcript, { wait: timer.wait, now: clock.now, failReads: () => sdk.down });
    await watch.start();
    return { ...watch, timer, clock, sdk };
}

const OVERLOADED = "API Error: 529 overloaded";

/** Each hook that ends the reply, and the response it leaves while the reads fail, by the hook's time. */
const LAST_MESSAGE_ONLY: [string, object, (time: string) => Pick<FullResponse, "items" | "end">][] = [
    [
        "Stop",
        hook("Stop", { last_assistant_message: REPLY }),
        (time) => ({
            items: [{ type: "text", id: "last message", at: time, text: REPLY }],
            end: { state: "finished", at: time },
        }),
    ],
    [
        "StopFailure",
        hook("StopFailure", {
            error: "overloaded",
            error_details: "529 overloaded",
            last_assistant_message: OVERLOADED,
        }),
        (time) => ({ items: [], end: { state: "failed", at: time, error: OVERLOADED } }),
    ],
];

test("last message only: a failed read leaves no item at once; then a Stop gives the agent's last message as the one item, and a main-thread StopFailure no text item, its error in the end alone", async () => {
    for (const [name, ending, expected] of LAST_MESSAGE_ONLY) {
        const { handle, brief, stop, timer, clock, sdk, reads } = await readThenFail();
        assert.deepEqual(
            brief().response?.items.map(({ type }) => type),
            ["text", "tool"],
            name,
        );

        sdk.down = true;
        clock.at("12:00:04");
        const failed = handle(hook("PreToolUse", { tool_name: "Bash", tool_input: lint, tool_use_id: "b1" }));
        await timer.advance(300);
        await failed;
        assert.deepEqual(
            brief().response,
            { items: [], end: { state: "writing", at: clock.iso("12:00:03") }, source: "last message only", cut: 0 },
            name,
        );

        clock.at("12:00:09");
        const ended = handle(ending);
        const lastMessageOnly = { ...expected(clock.iso("12:00:09")), source: "last message only", cut: 0 };
        assert.deepEqual(brief().response, lastMessageOnly, name);
        const readsBefore = reads.count;
        await timer.advance(3300);
        await ended;
        await until(() => reads.count === readsBefore + 3, { what: `the three reads after the ${name}` });
        assert.deepEqual(brief().response, lastMessageOnly, name);

        sdk.down = false;
        clock.at("12:00:20");
        const read = handle(hook("PreToolUse", { tool_name: "Bash", tool_input: lint, tool_use_id: "b1" }));
        await timer.advance(300);
        await read;
        assert.equal(brief().response?.source, "transcript", name);
        assert.ok(
            brief().response?.items.some(({ type }) => type === "tool"),
            name,
        );
        await stop();
    }
});

test("a session watched after its turn ended, with no hook since, has its paths relative to the folder its session list names", async () => {
    const timer = fakeClock();
    const clock = testClock();
    const read = { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/repo/notes/today.md" } };
    const transcript = [
        prompt("read today's notes", clock.iso("12:00:01")),
        dated(msg("assistant", [read]), clock.iso("12:00:02")),
        dated(msg("user", [{ type: "tool_result", tool_use_id: "r1", content: "notes" }]), clock.iso("12:00:03")),
    ];
    const { start, brief } = await setup(transcript, {
        wait: timer.wait,
        now: clock.now,
        ...fakeAgents({ status: "idle" }),
    });
    await start();

    await until(() => brief().response?.items.length === 1);
    const [item] = brief().response!.items;
    assert.equal(item?.type === "tool" ? item.argument : item?.type, "notes/today.md");
});

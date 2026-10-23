import {
    resultInWords,
    type FullResponse,
    type ResponseEnd,
    type ResponseItem,
    type SubagentItem,
    type ToolItem,
    type ToolResult,
    type ToolState,
} from "../../src/domain/response.js";

// The PRD's sample turns (ui-reference §4: W3 writing, W3 waiting, C, L4, after a background task and the edge states)
// as the service's own wire values, for the sample cases and the frame recipes. Each takes the sample's clock:
// `at(-40)` is 40 s before the sample's now.

type At = (seconds: number) => string;
type Call = Pick<ToolItem, "name" | "kind" | "display" | "argument"> &
    Partial<Pick<ToolItem, "description" | "result" | "state">>;
/** One item of a turn, `t` seconds after its prompt. */
type Step = { t: number; item: (id: string, at: string) => ResponseItem };

const said = (t: number, text: string): Step => ({ t, item: (id, at) => ({ type: "text", id, at, text }) });

function called(t: number, { state = "done", result, ...call }: Call): Step {
    const words = result && { result, summary: resultInWords(result) };
    return { t, item: (id, at) => ({ type: "tool", id, at, title: call.argument, state, ...call, ...words }) };
}

/** A call as one item with its own id and time, its result in words, for a recipe that builds its own turn. */
export const callItem = (id: string, at: string, call: Call): ResponseItem => called(0, call).item(id, at);

type Delegated = Pick<SubagentItem, "description" | "state" | "toolUses" | "durationMs"> & {
    firstLine?: string;
    background?: true;
};

/** A call that starts a subagent: done with counts once it finished, with its first line, or running on in the
 *  background, where it started. */
function delegated(t: number, { firstLine, background, ...call }: Delegated): Step {
    const result: ToolResult | undefined = background
        ? { kind: "background" }
        : firstLine === undefined
          ? undefined
          : { kind: "first line", text: firstLine };
    const words = result && { result, summary: resultInWords(result) };
    const subagent = { type: "subagent", agentType: "general-purpose", display: "Task" } as const;
    return { t, item: (id, at) => ({ ...subagent, id, at, ...call, ...words }) };
}

export const read = (path: string, lines: number): Call => ({
    name: "Read",
    kind: "read",
    display: "Read",
    argument: path,
    result: { kind: "read", lines },
});
export const search = (pattern: string, files: number): Call => ({
    name: "Grep",
    kind: "search",
    display: "Search",
    argument: pattern,
    result: { kind: "found", files },
});
const update = (path: string, added: number, removed: number): Call => ({
    name: "Edit",
    kind: "edit",
    display: "Update",
    argument: path,
    result: { kind: "changed", added, removed, path },
});
const write = (path: string, lines: number): Call => ({
    name: "Write",
    kind: "edit",
    display: "Write",
    argument: path,
    result: { kind: "wrote", lines, path, created: true },
});
const create = (path: string, lines: number): Call => ({
    ...write(path, lines),
    name: "Edit",
    display: "Create",
});
export function bash(command: string, firstLine: string, description?: string, state: ToolState = "done"): Call {
    return {
        name: "Bash",
        kind: "execute",
        display: "Bash",
        argument: command,
        ...(description !== undefined && { description }),
        state,
        ...(state === "done" && { result: { kind: "ran", exitCode: 0, firstLine } }),
    };
}

/** A task notification: a background task finished. */
const noticed = (t: number): Step => ({
    t,
    item: (id, at) => ({ type: "notice", id, at, text: "background task finished" }),
});

/** How a turn ended: its state, or, for a turn that ended at a tool call or failed, its own words too. */
type Ended =
    | Exclude<ResponseEnd, { call: string } | { error: string }>["state"]
    | { state: "ended at a tool call"; call: string }
    | { state: "failed"; error: string };

/** The steps as a full response seen `now` seconds after the prompt, read from the transcript with no text cut unless
 *  `read` says otherwise; the end is timed by its last step, or by the prompt while there is none. */
function turn(
    name: string,
    steps: readonly Step[],
    at: At,
    now: number,
    ended: Ended,
    read: Partial<Pick<FullResponse, "source" | "cut">> = {},
): FullResponse {
    const items = steps.map(({ t, item }, index) => item(`${name}-${index + 1}`, at(t - now)));
    const when = at((steps.at(-1)?.t ?? 0) - now);
    const end = typeof ended === "string" ? { state: ended, at: when } : { ...ended, at: when };
    return { items, end, source: "transcript", cut: 0, ...read };
}

const RETRY_START: readonly Step[] = [
    said(4, "I'll find where the retry limit is set today, then make it an option of each client."),
    called(6, search("maxRetries|MAX_RETRIES", 4)),
    called(9, read("src/request/send.ts", 118)),
    called(11, read("src/billing/client.ts", 64)),
    called(12, read("src/sync/client.ts", 51)),
    said(
        30,
        "The limit is a constant, `MAX_RETRIES = 3` in `src/request/send.ts`, and every client sends through " +
            "`sendWithRetry()`. I'll read it from the client's options instead and keep 3 as the default, so a " +
            "client that sets nothing behaves as before.",
    ),
    called(40, update("src/request/send.ts", 12, 4)),
    called(52, update("src/billing/client.ts", 2, 1)),
    called(60, read("test/request.test.ts", 210)),
    called(85, update("test/request.test.ts", 28, 2)),
    said(
        100,
        [
            "`sendWithRetry()` now reads the limit from the client's options:",
            "",
            "```ts",
            "const limit = client.options.maxRetries ?? 3;",
            "return send(req, { retries: limit });",
            "```",
        ].join("\n"),
    ),
];

const TESTS = "npm test -- request";
const PASSED = "Tests: 42 passed, 42 total";
const COMMIT = 'git add -A && git commit -m "Make the retry limit per client"';
const COMMITTED = "Commit the per-client retry limit";

const RETRY_TESTED: readonly Step[] = [
    ...RETRY_START,
    called(102, bash(TESTS, PASSED, "Run the request tests")),
    called(128, bash("npx tsc --noEmit", "", "Type-check the project")),
    said(160, "All 42 request tests pass. I'll commit the change on this branch:"),
    called(161, bash(TESTS, PASSED, "Run the request tests")),
];

const RETRY_ANSWER = [
    "All 42 request tests pass. Each client now passes its own limit:",
    "",
    "| Client | Limit | Source |",
    "| --- | --- | --- |",
    "| billing | 5 | `src/billing/client.ts` |",
    "| sync | 3 | `src/sync/client.ts` |",
    "| payments | 0 | `src/payments/client.ts` |",
    "",
    "A client that sets no limit keeps the old default of 3, and a limit of 0 turns retries off.",
    "",
    "- `src/request/send.ts`: `sendWithRetry()` reads `client.options.maxRetries`.",
    "- `src/billing/client.ts`: billing sets 5, for its provider's bursts.",
    "- `test/request.test.ts`: tests for a client's own limit, the default and 0.",
    "",
    "The change is committed on this branch as `4f2a9c1`; nothing is pushed.",
].join("\n");

/** W3 · the agent writes: its newest text 40 s ago, then the request tests running. */
export const writingTurn = (at: At) =>
    turn(
        "retry",
        [...RETRY_START, called(102, bash(TESTS, "", "Run the request tests", "running"))],
        at,
        140,
        "writing",
    );

/** What the agent goes on to do after W3, one item each sample tick: a tool call and a text item in turn. */
const WRITING_ON: readonly Step[] = [
    called(0, bash("npx tsc --noEmit", "", "Type-check the project")),
    said(
        0,
        "The request tests pass and the project type-checks. The sync client still reads `MAX_RETRIES`, so I'll " +
            "make it read the client's options too.",
    ),
    called(0, update("src/sync/client.ts", 3, 1)),
    said(0, "The sync client reads its own limit now. I'll cover it with a test of its own."),
];

/** W3 · the agent writes on, `tick` sample ticks after W3, at `at`: the request tests' call done, and one more item,
 *  a tool call and a text item in turn. */
export function writtenOn(response: FullResponse, tick: number, at: string): FullResponse {
    const tested = called(0, bash(TESTS, PASSED, "Run the request tests"));
    const items = response.items.map((item) =>
        item.type === "tool" && item.state === "running" ? tested.item(item.id, item.at) : item,
    );
    const next = WRITING_ON[(tick - 1) % WRITING_ON.length]!.item(`retry-on-${tick}`, at);
    return { ...response, items: [...items, next], end: { state: "writing", at } };
}

/** W3 · the agent writes: after its newest text it reads two files at once, and both reads still run. */
export const readingTurn = (at: At) =>
    turn(
        "retry",
        [
            ...RETRY_START,
            called(102, { ...read("src/request/options.ts", 0), result: undefined, state: "running" }),
            called(102, { ...read("src/sync/client.ts", 0), result: undefined, state: "running" }),
        ],
        at,
        104,
        "writing",
    );

/** W3 · waiting on a permission: its newest text 12 s ago, the tests passed, then the commit waits for you, 6 s on. */
export const waitingTurn = (at: At) =>
    turn("retry", [...RETRY_TESTED, called(166, bash(COMMIT, "", COMMITTED, "waiting"))], at, 172, "waiting");

/** L4 · the turn is over, 2 min ago: 14 tool calls changed 3 files, +42 −7, and the answer is the last item. */
export const finishedTurn = (at: At) =>
    turn(
        "retry",
        [
            ...RETRY_TESTED,
            called(170, bash(COMMIT, "[retry-limit 4f2a9c1] Make the retry limit per client", COMMITTED)),
            called(200, bash("git log --oneline -1", "4f2a9c1 Make the retry limit per client")),
            called(202, bash("git status --short", "")),
            said(210, RETRY_ANSWER),
        ],
        at,
        330,
        "finished",
    );

/** C · waiting with no text yet: the reads, the writes, then the invoice tests wait for you. */
export const noTextTurn = (at: At) =>
    turn(
        "invoices",
        [
            called(3, search("invoiceNumber", 3)),
            called(4, search("customerName", 2)),
            called(6, read("src/invoices/model.ts", 48)),
            called(7, read("src/invoices/routes.ts", 92)),
            called(8, read("src/invoices/format.ts", 37)),
            called(9, read("test/invoices.test.ts", 120)),
            called(40, write("src/invoices/csv.ts", 64)),
            called(55, update("src/invoices/routes.ts", 3, 1)),
            called(60, bash("npm test invoices", "", "Run the invoice tests", "waiting")),
        ],
        at,
        75,
        "waiting",
    );

/** A new Task, 3 s after its prompt: the agent has not started on it, so the full response holds no item yet. */
export const nothingYetTurn = (at: At) => turn("flag", [], at, 3, "nothing yet");

/** A recorded fixture's path inside the session's folder, 300 characters long. */
const LONG_PATH =
    "test/fixtures/retry-log/recorded/2026-10-08/billing/eu-west-1/burst-rate-limit/client-sdk-v4/" +
    "after-429-with-jitter/attempts-1-to-5/with-retry-after-header/without-idempotency-keys/" +
    "sandbox-provider-with-throttling-on/session-6f2a91c4ab12/requests-0001-0412/" +
    "billing-eu-west-1-burst-429-retry-log.ndjson";

export const INSTALL = "npm install --save-exact csv-stringify@6.5.2";

/** Every tool row in one turn: each kind of call and each state, with the newest text before nearly all of them, and
 *  at the end the installer waits for you while a subagent runs. The lint's first line still holds its colour codes. */
export const toolsTurn = (at: At) =>
    turn(
        "export",
        [
            said(5, "I'll see how the retry log is kept, then add the CSV export beside it."),
            called(8, search("retryLog", 3)),
            called(20, update("src/request/retryLog.ts", 6, 1)),
            said(60, "The log is kept per client. Adding the export, its test and an issue:"),
            delegated(62, {
                description: "Find every reader of the retry log",
                state: "done",
                toolUses: 12,
                durationMs: 62_000,
                firstLine: "Three readers: the CLI export, the log rotation and the request tests.",
            }),
            called(130, bash("npm run lint", "\x1b[1m\x1b[32mLint passed\x1b[39m\x1b[22m: 0 problems in 6 files")),
            called(140, { ...update("src/cli/commands/export.ts", 9, 2), result: undefined, state: "rejected" }),
            called(150, bash("npm run bench -- retries", "", "Time the retries", "interrupted")),
            called(160, read(LONG_PATH, 412)),
            called(170, write("src/request/retryLogCsv.ts", 58)),
            called(180, create("test/retryLogCsv.test.ts", 41)),
            called(190, {
                ...bash("node scripts/export-sample.js", "", "Export a sample", "failed"),
                result: { kind: "failed", exitCode: 1, firstLine: "Error: Cannot find module 'csv-stringify'" },
            }),
            called(200, {
                name: "mcp__github__create_issue",
                kind: "other",
                display: "github · create_issue",
                argument: "Billing retries burst past the provider's limit",
                result: { kind: "first line", text: "Created issue #142 in acme/billing" },
            }),
            delegated(210, {
                description: "Run the whole suite in the background",
                state: "done",
                background: true,
            }),
            delegated(220, { description: "Check the other clients for their own retry limit", state: "running" }),
            called(230, bash(INSTALL, "", "Install the CSV writer", "waiting")),
        ],
        at,
        236,
        "waiting",
    );

/** Interrupted: the agent found the bug, then the user pressed Esc while its edit ran. */
export const interruptedTurn = (at: At) =>
    turn(
        "token",
        [
            said(
                60,
                "Found it: isExpired() in src/auth/token.ts compares expiresAt, which is in seconds, with Date.now(), " +
                    "in milliseconds. Fixing the unit first.",
            ),
            called(62, { ...update("src/auth/token.ts", 1, 1), result: undefined, state: "interrupted" }),
        ],
        at,
        120,
        "interrupted",
    );

/** Ended at a tool call: the user said no to the command that clears the old build. */
export const rejectedTurn = (at: At) =>
    turn(
        "build",
        [
            said(20, "I'll clear the old output first, then rebuild."),
            called(22, bash("rm -rf build/", "", "Remove the old build output", "rejected")),
        ],
        at,
        60,
        { state: "ended at a tool call", call: "Bash: rm -rf build/" },
    );

/** Failed: the edit and the tests went through, then the agent provider's next answer was an error. */
export const failedTurn = (at: At) =>
    turn(
        "budget",
        [
            said(5, "I'll add a retry budget to the sync client's options, then run its tests."),
            called(30, update("src/sync/client.ts", 14, 3)),
            called(45, bash("npm test -- sync", "Tests: 18 passed, 18 total", "Run the sync tests")),
        ],
        at,
        100,
        { state: "failed", error: "API Error: 529 overloaded" },
    );

/** No transcript: Izbor could not read it, so the Stop hook's last message is all the full response holds. */
export const lastMessageTurn = (at: At) =>
    turn(
        "backoff",
        [
            said(
                40,
                "The sync client waits 200 ms before its first retry and doubles the wait each time, up to 5 s; a " +
                    "`Retry-After` header from the server wins over its own wait.",
            ),
        ],
        at,
        160,
        "finished",
        { source: "last message only" },
    );

const REGIONS = [
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "ca-central-1",
    "sa-east-1",
    "ap-south-1",
    "ap-northeast-1",
    "ap-southeast-2",
];
const SERVICES = (
    "billing sync search export ledger notify orders payouts reports media " +
    "invoices accounts catalog shipping refunds audit tax quotes pricing webhooks " +
    "sessions storage identity metrics alerts uploads receipts returns coupons loyalty"
).split(" ");

/** The agent's second list of every client's limit, about 16,300 characters; its first list, 4,210 characters, was
 *  the earliest text, so it is the text the 20,000-character limit left out. */
const OTHER_REGIONS = [
    "The clients outside the EU, region by region:",
    "",
    ...REGIONS.flatMap((region, r) =>
        SERVICES.map((service, s) => {
            const own = (r * SERVICES.length + s) % 15 === 7;
            return `- \`src/clients/${region}/${service}.ts\`: ${own ? "sets `maxRetries: 5`" : "no limit of its own, keeps 3"}`;
        }),
    ),
].join("\n");

/** Over 20,000 characters: the agent listed every client in two long messages, then summed the list up. */
export const cutTurn = (at: At) =>
    turn(
        "limits",
        [
            said(60, OTHER_REGIONS),
            called(70, search("maxRetries", 20)),
            said(100, "Of the 302 clients, 20 set their own limit; the other 282 keep the default of 3."),
        ],
        at,
        280,
        "finished",
        { cut: 4210 },
    );

/** After a background task: the suite ran in the background, its notification came, and the agent said how it went. */
export const afterTaskTurn = (at: At) =>
    turn(
        "suite",
        [
            called(4, { ...bash("npm test", "", "Run the whole suite"), result: { kind: "background" } }),
            noticed(170),
            said(172, "The suite passed: 312 tests in 2m 41s, and none failed."),
        ],
        at,
        352,
        "finished",
    );

/** The agent's answer with code in three languages Izbor has syntax colours for: TypeScript with a comment over three
 *  lines, then a shell command and a JSON object. */
const SYNTAX_ANSWER = [
    "Each retry waits longer, to a cap:",
    "",
    "```ts",
    "/**",
    " * Waits 200 ms before the first retry, then doubles the wait, up to 5 s.",
    " */",
    "export function backoff(attempt: number): number {",
    "  return Math.min(200 * 2 ** attempt, 5_000);",
    "}",
    "```",
    "",
    "```bash",
    "export MAX_RETRIES=5",
    'npm test -- request && echo "retries ok"',
    "```",
    "",
    "```json",
    '{ "billing": { "maxRetries": 5, "backoff": "200ms", "jitter": true } }',
    "```",
].join("\n");

/** Syntax colours: the turn is over, 30 s ago, and its one item is an answer with code in three known languages. */
export const syntaxTurn = (at: At) => turn("syntax", [said(30, SYNTAX_ANSWER)], at, 60, "finished");

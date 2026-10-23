import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import stringWidth from "string-width";
import type { NotAnswerable } from "../src/domain/answer.js";
import type { FullResponse, ResponseItem } from "../src/domain/response.js";
import type { SampleScenario } from "./helpers/sampleSessions.js";
import type {
    Abilities,
    Observation,
    ObservationSource,
    RunningSession,
    SessionList,
    Snapshot,
    TerminalBrief,
    TerminalSize,
    ViewportLayout,
} from "../src/terminal/model.js";
import { NO_WRITES, writersOf } from "./helpers/projectWriters.js";

process.env.TZ = "UTC";
process.env.FORCE_COLOR = "3";
const { default: chalk } = await import("chalk");
const { NOW, frameFile, renderFrame, runs } = await import("./helpers/frameFile.js");
const { createTerminalController } = await import("../src/terminal/controller.js");
const { DETAIL_FOCUS } = await import("../src/terminal/focus.js");
const { askingQuestion, createSampleSource, createSampleWorld, SAMPLE_IDS, SAMPLE_SCENARIOS, withoutPlugin } =
    await import("./helpers/sampleSessions.js");
const { listedSessions } = await import("../src/terminal/model.js");
const { toTerminalBrief } = await import("../src/terminal/live/brief.js");
const { clip } = await import("../src/terminal/presentation.js");
const { fieldText, fieldWindow } = await import("../src/terminal/field-window.js");
const { FIELD_BYTES } = await import("../src/terminal/line-editor.js");
const { FIELD_TEXT_ROWS } = await import("../src/terminal/layout.js");
const { createFakeStore } = await import("./helpers/fakeStore.js");
const { fromBeforeIzborStarted } = await import("./helpers/unseenWait.js");
const { bash, callItem, read, readingTurn, search, syntaxTurn } = await import("./helpers/sampleResponses.js");
const { CI_LOG } = await import("./helpers/keys.js");
const { setHighlighters } = await import("../src/terminal/words/rows.js");
const { addHighlighters } = await import("../src/terminal/words/highlight.js");

// The terminal app fills the syntax colours before its first frame; so do the frames, once, before the first case.
setHighlighters(addHighlighters);

const FRAMES = join(import.meta.dirname, "frames");
const UPDATE = process.execArgv.includes("--test-update-snapshots");

type Window = ReturnType<typeof createTerminalController>;
type Recipe = {
    name: string;
    about: string;
    color?: boolean;
    store?: Partial<Snapshot> | (() => ObservationSource);
    empty?: boolean;
    scenario?: SampleScenario;
    after?: SampleScenario;
    steps?: (app: Window, render: () => ViewportLayout) => void | Promise<void>;
    offset?: number;
    oldBuild?: boolean;
    abilities?: Abilities;
};
const CASES: { id: string; recipe: Recipe; size: TerminalSize; color: boolean }[] = [];
function add(sizes: readonly `${number}x${number}`[], recipe: Recipe) {
    const color = recipe.color ?? true;
    for (const size of sizes) {
        const [columns = 0, rows = 0] = size.split("x").map(Number);
        CASES.push({ id: `${recipe.name}.${size}${color ? "" : ".no-color"}`, recipe, size: { columns, rows }, color });
    }
}

function openWindow(
    { store, empty = false, scenario = "overview", after, oldBuild, abilities }: Recipe,
    { columns, rows }: TerminalSize,
): { app: Window; scene: () => void } {
    if (store) {
        const source = typeof store === "function" ? store() : createFakeStore(store);
        const app = createTerminalController(source, {
            ...NO_WRITES,
            columns,
            rows,
            oldBuild,
            abilities,
            changed() {},
        });
        return { app, scene: () => {} };
    }
    const source = createSampleSource({ scenario: after ? "overview" : scenario, animate: false });
    const app = createTerminalController(source, {
        ...writersOf(source.setup),
        initialIds: empty ? [] : SAMPLE_IDS,
        columns,
        rows,
        oldBuild,
        abilities,
        changed() {},
    });
    return {
        app,
        scene: () => {
            if (after) source.setScenario(after);
        },
    };
}

function press(app: Window, render: () => ViewportLayout, name: "pagedown" | "down") {
    const layout = render();
    const pane = app.view.focused === DETAIL_FOCUS ? (layout.detail ?? layout) : layout;
    app.keypress(undefined, { name }, pane.maxScroll, pane.step);
}

function pageDown(app: Window, render: () => ViewportLayout) {
    press(app, render, "pagedown");
}

function tab(app: Window, times: number, shift = false) {
    for (let time = 0; time < times; time++) app.keypress(undefined, { name: "tab", shift });
}

function metadataSecond(app: Window) {
    app.openSession(SAMPLE_IDS[1]);
    app.toggleMetadata();
}

function metadataRestored(app: Window, render: () => ViewportLayout) {
    app.openSession(SAMPLE_IDS[2]);
    press(app, render, "down");
    app.toggleMetadata();
    app.toggleMetadata();
}

const SCREENS: Recipe[] = [
    { name: "home-empty", about: "the sample sessions, none observed: Home", empty: true },
    {
        name: "home-observed",
        about: "the three sample sessions observed, then Ctrl-O: Home",
        steps: (app) => app.showScreen("home"),
    },
    { name: "sessions", about: "the three sample sessions observed: Sessions, the first row selected" },
    {
        name: "brief-second",
        about: "the second session opened: its Brief page, or the side Brief from 140x20 up",
        steps: (app) => app.openSession(SAMPLE_IDS[1]),
    },
    { name: "metadata-second", about: "the second session opened, then m: its Metadata open", steps: metadataSecond },
    { name: "help", about: "Ctrl-G on Sessions: Help", steps: (app) => app.toggleHelp() },
];
// Home and Help have no split. Sessions, the Brief and Metadata are drawn at the split's thresholds too, and
// without color, where the selected row reads Selected ·.
const SPLIT_SIZES: Record<string, readonly `${number}x${number}`[]> = {
    sessions: ["140x20"],
    "brief-second": ["140x20", "160x19"],
    "metadata-second": ["140x20", "160x19"],
};
const NO_COLOR_SIZES: Record<string, readonly `${number}x${number}`[]> = {
    sessions: ["80x24", "42x24", "160x32"],
    "brief-second": ["42x24", "160x32"],
    "metadata-second": ["42x24", "160x32"],
};
for (const screen of SCREENS) {
    add(["80x24", ...(SPLIT_SIZES[screen.name] ?? []), "160x32", "40x24"], screen);
    add(NO_COLOR_SIZES[screen.name] ?? [], { ...screen, color: false });
}

add(["80x24"], {
    name: "focused-second-row",
    about: "Tab, Tab on Sessions: the second row has focus, the first is selected",
    color: false,
    steps: (app) => tab(app, 2),
});

add(["39x24", "80x11"], {
    name: "too-small",
    about: "the sample sessions in a window under 40x12: the resize notice",
});

add(["40x24", "80x12"], { name: "sessions-scrolled", about: "Sessions, Page Down", steps: pageDown });
add(["80x12"], {
    name: "home-scrolled",
    about: "the sample sessions, none observed, Page Down: Home scrolled",
    empty: true,
    steps: pageDown,
});
add(["40x24"], {
    name: "help-scrolled",
    about: "Help at 40 columns, Page Down: its last rows",
    steps: (app, render) => {
        app.toggleHelp();
        pageDown(app, render);
    },
});

add(["80x12", "140x20"], {
    name: "metadata-restored",
    about: "the sample case question, the third session's Brief one row down, m, then m again: no Metadata, and one row down as before",
    scenario: "question",
    steps: metadataRestored,
});

add(["160x24"], {
    name: "brief-hidden",
    about: "the second session's side Brief, then h: Sessions alone in a wide window",
    steps: (app) => {
        app.openSession(SAMPLE_IDS[1]);
        app.hideBrief();
    },
});
add(["80x24"], {
    name: "sessions-empty",
    about: "the sample sessions, none observed, then Ctrl-O: Sessions with no row",
    empty: true,
    steps: (app) => app.showScreen("sessions"),
});
// The side Brief at 160x32 only for the cases whose hit targets or colors no other case shows there.
const THIRD_WIDE: ReadonlySet<SampleScenario> = new Set([
    "overview",
    "unknown",
    "disconnected",
    "stopped",
    "connecting",
    "gap",
    "answer-sent",
    "answer-not-taken",
    "question",
    "fresh-wait",
    "response-finished",
]);
for (const scenario of SAMPLE_SCENARIOS) {
    if (scenario !== "overview")
        add(["80x24"], {
            name: `scenario-${scenario}.sessions`,
            about: `the sample case ${scenario}: Sessions`,
            scenario,
        });
    add(THIRD_WIDE.has(scenario) ? ["80x24", "160x32"] : ["80x24"], {
        name: `scenario-${scenario}.third`,
        about: `the sample case ${scenario}: the third session opened`,
        after: scenario,
        steps: (app) => app.openSession(SAMPLE_IDS[2]),
    });
}

add(["80x24"], {
    name: "scenario-disconnected-at-retry",
    about: "the sample case disconnected at its retry time: no countdown, never in 0 s",
    after: "disconnected",
    steps: (app) => app.openSession(SAMPLE_IDS[2]),
    offset: 10_000,
});

function freshWaitList(): SessionList {
    const { list } = createSampleWorld();
    assert.equal(list.state, "listed");
    const since = new Date(NOW).toISOString();
    return {
        ...list,
        sessions: list.sessions.map((session) =>
            session.id === SAMPLE_IDS[1] ? { ...session, waitingSince: since } : session,
        ),
    };
}
add(["80x24"], {
    name: "blink-home.off",
    about: "Home 1 s after the list first showed izbor-e8 waiting: its ! hidden in the blink's second second",
    store: () => createFakeStore({ list: freshWaitList() }),
    offset: 1000,
});

const FOCUS: Recipe[] = [
    { name: "focus-row-sessions", about: "Tab on Sessions: the first row has focus", steps: (app) => tab(app, 1) },
    {
        name: "focus-help-control-sessions",
        about: "Shift-Tab on Sessions: the Help control has focus, bold",
        steps: (app) => tab(app, 1, true),
    },
    {
        name: "focus-help-control-home",
        about: "Shift-Tab on Home: the Help control has focus, bold",
        empty: true,
        steps: (app) => tab(app, 1, true),
    },
    {
        name: "focus-project-add",
        about: "Tab x5 on Home: example-api's line, which has no hooks, with its Add hooks ›",
        empty: true,
        steps: (app) => tab(app, 5),
    },
    {
        name: "focus-home-unobserved",
        about: "Tab x2 on Home: a session not observed, its Observe › on the line",
        empty: true,
        steps: (app) => tab(app, 2),
    },
    {
        name: "focus-home-observed",
        about: "Ctrl-O, Tab x2: an observed session on Home, its Open › sage",
        steps: (app) => {
            app.showScreen("home");
            tab(app, 2);
        },
    },
];
for (const focus of FOCUS) add(["80x24"], focus);
add(["160x32"], {
    name: "focus-help-page-home",
    about: "Ctrl-G on Home: Help, whose Esc goes home",
    empty: true,
    steps: (app) => app.toggleHelp(),
});

const ADDRESS = "127.0.0.1:4319";
const CHECKOUT = join(homedir(), "code", "app");
const running = { cwd: CHECKOUT, checkout: CHECKOUT, hooks: true, acting: false };
const UNNAMED = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
const THREE: RunningSession[] = [
    { ...running, id: UNNAMED, name: "" },
    { ...running, id: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", name: "release", status: "compacting" },
    {
        ...running,
        id: "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e",
        name: "docs",
        status: "waiting",
        waitingFor: "your answer",
    },
];
const listed = (sessions: readonly RunningSession[]): SessionList => ({
    state: "listed",
    sessions,
    at: "2026-10-09T11:59:00.000Z",
});
function observed(status: TerminalBrief["status"], at: string): Snapshot["observations"] {
    const brief: TerminalBrief = {
        task: { text: "Ship the release", at, from: "hook" },
        status,
        explanation: { text: "Packaging the build.", at },
        latestActivity: { text: "Ran npm pack", at },
        needsYou: { state: "nothing" },
        lastObserved: { at, from: "hook" },
    };
    return [{ id: UNNAMED, brief, connection: { state: "live" } }];
}
add(["80x24"], {
    name: "live-up.home",
    about: "izbor with Izbor up: Home lists an unnamed session with no status, one compacting and one waiting",
    store: { izbor: { state: "up", address: ADDRESS }, list: listed(THREE) },
});
add(["80x24"], {
    name: "live-stopping.list-loading",
    about: "izbor with Izbor stopping, before the first list",
    store: { izbor: { state: "stopping", address: ADDRESS }, list: { state: "loading" } },
});
add(["80x24"], {
    name: "live-not-running.list-retrying",
    about: "izbor with Izbor not running: no list; it runs again at the next tick, and no line counts down",
    store: {
        izbor: { state: "not running", address: ADDRESS },
        list: { state: "no list", reason: "Izbor is not running", last: [] },
    },
});
add(["80x24"], {
    name: "live-not-answering.list-failed",
    about: "izbor with Izbor not answering: the list failed, the last one still shown under ▲ No list",
    store: {
        izbor: { state: "not answering", address: ADDRESS },
        list: { state: "no list", reason: "claude agents --json exited with code 3: Not logged in", last: THREE },
    },
});
add(["80x24"], {
    name: "live-foreign.list-empty",
    about: "izbor with another program on Izbor's port: a list with no running session",
    store: { izbor: { state: "foreign", address: ADDRESS }, list: listed([]) },
});
add(["160x32"], {
    name: "live-not-listed",
    about: "izbor with Izbor up: an observed session claude agents no longer lists, opened",
    store: {
        izbor: { state: "up", address: ADDRESS },
        list: listed([]),
        observations: observed("not listed", "2026-10-09T11:58:00.000Z"),
    },
    steps: (app) => app.openSession(UNNAMED),
});
add(["160x32"], {
    name: "live-time-unknown",
    about: "izbor with Izbor up: a Brief whose every time is not a time, opened with its Metadata",
    store: {
        izbor: { state: "up", address: ADDRESS },
        list: listed(THREE),
        observations: observed("busy", "not a time"),
    },
    steps: (app) => {
        app.openSession(UNNAMED);
        app.toggleMetadata();
    },
});

add(["80x24", "40x24"], {
    name: "old-build.up",
    about: "izbor on an old build with Izbor up: the notice whole at the top line's left end, ▲ old build at 40 columns",
    store: { izbor: { state: "up", address: ADDRESS }, list: listed(THREE) },
    oldBuild: true,
});
add(["80x24"], {
    name: "old-build.not-running",
    about: "izbor on an old build with Izbor not running: ▲ old build at the left, the trouble text whole with its port",
    store: {
        izbor: { state: "not running", address: ADDRESS },
        list: { state: "no list", reason: "Izbor is not running", last: THREE },
    },
    oldBuild: true,
});

const ENTER = { name: "return" };
const typedInField =
    (text: string, id: string = SAMPLE_IDS[1]) =>
    (app: Window) => {
        app.openSession(id);
        app.keypress(undefined, ENTER);
        app.keypress(text, {});
    };
function down(app: Window, render: () => ViewportLayout, times: number) {
    for (let time = 0; time < times; time++) {
        const { maxScroll, pageSize } = render();
        app.keypress(undefined, { name: "down" }, maxScroll, pageSize);
    }
}
async function sent(app: Window) {
    app.keypress(undefined, ENTER);
    await new Promise((done) => setImmediate(done));
}
const samples = () => {
    const world = createSampleWorld();
    return { list: world.list, observations: SAMPLE_IDS.map((id) => world.row(id)) };
};
function longExplanation(): ObservationSource {
    const { list, observations } = samples();
    const third = observations[2]!;
    const text =
        "Traced the retry logic in request.ts and explained where its limit is configured, which errors trigger another attempt, how the backoff grows between attempts, why a timeout counts as a retryable error while a 4xx response does not, and when failed requests stop retrying automatically.";
    return createFakeStore({
        list,
        observations: [
            ...observations.slice(0, 2),
            { ...third, brief: { ...third.brief!, explanation: { ...third.brief!.explanation!, text } } },
        ],
    });
}
add(["80x24"], {
    name: "sessions-explanation-cut",
    about: "Sessions with a third row whose explanation needs more than three lines: three, the third ending with …",
    store: longExplanation,
    steps: (app) => app.showScreen("sessions"),
});
add(["80x30", "40x30"], {
    name: "field-answer",
    about: "M1, N7: the Waiting session's Brief page, Brief focused: its field in answer mode, empty",
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["160x40"], {
    name: "field-answer",
    about: "C2: the Waiting session's side Brief focused, its field empty, without color",
    color: false,
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["80x30"], {
    name: "field-answer-typed",
    about: "M2: Enter on the Waiting session's Brief page, an answer typed: the field has the cursor",
    steps: typedInField("no, run only the export tests"),
});
add(["80x30"], {
    name: "field-answer-kept",
    about: "X2: Esc from the field with an answer typed: the Brief has focus again, the text stays",
    steps: (app) => {
        typedInField("no, run only the export tests")(app);
        app.keypress(undefined, { name: "escape" });
    },
});
const ANSWER_WORDS = "no, run only the export tests\nand keep the old ones\nthen tell me which ones failed";
add(["80x24"], {
    name: "field-answer-words",
    about: "F4: a no with words over three lines in the Waiting session's Answer field: the box grows a row per line, Send → on its last, and the title counts the lines",
    steps: typedInField(ANSWER_WORDS),
});
add(["40x24"], {
    name: "field-answer-words",
    about: "F4 at 40 columns: the three-line no in the Answer field, the box a row per line with no Send →, and the title counting the lines",
    steps: typedInField(ANSWER_WORDS),
});
add(["80x30"], {
    name: "field-reply",
    about: "M3, M6: the idle session's Brief, Brief focused: its field in reply mode, empty",
    steps: (app) => app.openSession(SAMPLE_IDS[2]),
});
add(["40x24"], {
    name: "field-reply-busy",
    about: "N5: the busy session's Brief page at 40 columns: the busy placeholder cut with …",
    steps: (app) => app.openSession(SAMPLE_IDS[0]),
});
add(["80x30"], {
    name: "field-reply-busy-typed",
    about: "M4: the busy session's Brief page, a prompt typed in its field",
    steps: typedInField("also add a test for refresh races", SAMPLE_IDS[0]),
});
add(["160x40", "40x24"], {
    name: "field-yes",
    about: "M5, N1: yes typed in the Waiting session's field; no Send → at 40 columns",
    steps: typedInField("yes"),
});
add(["80x30"], {
    name: "field-yes",
    about: "C1: yes typed in the Waiting session's field, without color",
    color: false,
    steps: typedInField("yes"),
});
add(["80x30"], {
    name: "field-sent",
    about: "E6: Enter on yes with the sample store: The sample sends nothing. on the field's line, yes kept",
    steps: async (app) => {
        typedInField("yes")(app);
        await sent(app);
    },
});
add(["40x12"], {
    name: "field-scrolled",
    about: "N3: the Waiting session's Brief page scrolled to Needs you, Brief focused",
    steps: (app, render) => {
        app.openSession(SAMPLE_IDS[1]);
        down(app, render, 6);
    },
});
add(["40x12"], {
    name: "field-scrolled-yes",
    about: "N4: the same, then Enter and yes: the field has the cursor",
    steps: (app, render) => {
        app.openSession(SAMPLE_IDS[1]);
        down(app, render, 6);
        app.keypress(undefined, ENTER);
        app.keypress("yes", {});
    },
});
/** The third session's Brief (the idle one in the overview), Enter, then `lines` typed into the field in one keypress
 *  (not a paste, so never a block), which keeps their new lines and leaves the cursor after them. */
const fieldLines = (lines: readonly string[]) => (app: Window) => {
    app.openSession(SAMPLE_IDS[2]);
    app.keypress(undefined, ENTER);
    app.keypress(lines.join("\n"), {});
};
const THREE_LINES = [
    "After the tests pass:",
    "1. expose the limit as a --retries flag on the CLI",
    "2. update the README section on retries",
];
add(["80x24"], {
    name: "field-lines",
    about: "F2: three lines in the idle session's field, the cursor after them: the box grows upward a row per row of text, Send → on its last row, and the Brief above gives up the same rows; its title counts the lines and its bottom edge, muted, reads Ctrl-J new line · Enter sends",
    steps: fieldLines(THREE_LINES),
});
add(["40x24"], {
    name: "field-lines",
    about: "F2 at 40 columns: the three lines in the idle session's field, the long ones wrapped, the box a row per row of text with no Send →, and the Brief above giving up the same rows; its title counts the lines and its bottom edge reads Ctrl-J new line · Enter sends",
    steps: fieldLines(THREE_LINES),
});
add(["40x12"], {
    name: "field-lines-response",
    about: "F2 over L4: the three lines in the field of the third session's Brief, which shows a full response: the box leaves the body 3 rows, for the response's view and its footer, so at 40×12 it keeps one row and shows the last",
    scenario: "response-finished",
    steps: fieldLines(THREE_LINES),
});
add(["80x24", "40x12"], {
    name: "field-lines-scrolled",
    about: "F2: nine lines in the field, the cursor after them: the box stops at six rows and shows the last ones, its title reading · 9 lines · 3 above; at 40×12 it stops short of the body's last row, and the title, too long, drops · N above",
    steps: fieldLines([
        ...THREE_LINES,
        "3. add a test for a limit of 0",
        "4. log each retry at debug level",
        "5. keep the default at 3",
        "6. note the change in CHANGELOG.md",
        "7. run the whole suite once more",
        "Then open a pull request.",
    ]),
});
const RETRY_LOG = Array.from(
    { length: 1500 },
    (_, n) => `retry ${n + 1} of 1500: GET /invoices/export timed out after 30 s`,
).join("\n");
add(["80x24"], {
    name: "field-cap",
    about: "F5: a log typed into the idle session's field up to its 64 KB cap, 65,536 bytes (a paste that long would be one block), then one more key: the key is not added, the box shows the log's last 6 rows, and the field's own line says so, muted",
    steps: (app) => {
        fieldLines([RETRY_LOG.slice(0, FIELD_BYTES)])(app);
        app.keypress("x", {});
    },
});
const pastedLog = {
    name: "field-paste",
    steps: (app: Window) => {
        app.openSession(SAMPLE_IDS[2]);
        app.keypress(undefined, ENTER);
        app.keypress("CI fails on the same branch too; here is its log:", {});
        app.keypress("\n", {});
        app.keypress(CI_LOG, { paste: true });
    },
};
add(["80x24", "40x24"], {
    ...pastedLog,
    about: "F3: a typed line, Ctrl-J, then a 42-line log pasted into the idle session's field, the cursor after it: the paste stands as one block, Pasted 42 lines · 1.9 KB in sage on its dark sage fill, the title counts it as one line, · 2 lines, and the bottom edge reads Backspace removes the paste · Enter sends; at 40 columns the typed line wraps and · Enter sends drops",
});
add(["80x24"], {
    ...pastedLog,
    color: false,
    about: "F3 with colour off: the same paste block in brackets, [Pasted 42 lines · 1.9 KB], as wide as on its fill",
});
add(["80x30"], {
    name: "brief-no-hooks",
    about: "X7: the idle session's Brief page in a project without Izbor's hooks: no field, the row above the last line empty",
    store: () => {
        const { list, observations } = samples();
        const sessions = listedSessions(list).map((session) => ({ ...session, hooks: false }));
        return createFakeStore({ list: { state: "listed", sessions, at: new Date().toISOString() }, observations });
    },
    steps: (app) => app.openSession(SAMPLE_IDS[2]),
});
add(["40x24", "42x24"], {
    name: "field-refusal-wrapped",
    about: "a refusal fits on the field's own line above the box at 42 columns and wraps to two rows at 40, rose and bold behind its ×",
    store: () => createFakeStore(samples(), { refused: "Type yes, no, or no and your words." }),
    steps: async (app) => {
        typedInField("yes")(app);
        await sent(app);
    },
});

add(["80x30"], {
    name: "brief-no-plugin",
    about: "R6: the Waiting session's Brief in a project without the plugin: the muted closing line under the request, the field's placeholder",
    store: () => {
        const { list, observations } = samples();
        return createFakeStore({
            list: withoutPlugin(list),
            observations: observations.map((row) =>
                row.id === SAMPLE_IDS[1] && row.brief
                    ? { ...row, brief: { ...row.brief, answerable: "not an acting project" } }
                    : row,
            ),
        });
    },
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});

type Fake = ReturnType<typeof createFakeStore>;
let fake: Fake;
const fakeIzbor =
    (
        send: Parameters<typeof createFakeStore>[1],
        change: (row: Observation) => Observation = (row) => row,
        shown: (list: SessionList) => SessionList = (list) => list,
    ) =>
    () => {
        const { list, observations } = samples();
        return (fake = createFakeStore({ list: shown(list), observations: observations.map(change) }, send));
    };
const saidOf = (answerable: NotAnswerable) => (row: Observation) =>
    row.id === SAMPLE_IDS[1] && row.brief ? { ...row, brief: { ...row.brief, answerable } } : row;
function setWaiting(change: (row: Observation) => Observation) {
    const observations = fake.getSnapshot().observations.map((row) => (row.id === SAMPLE_IDS[1] ? change(row) : row));
    fake.set({ observations });
}
const sentFromHere =
    (text: string, seconds: number, stillWaits = false) =>
    async (app: Window) => {
        typedInField(text)(app);
        await sent(app);
        const sentAt = new Date(NOW - seconds * 1000).toISOString();
        setWaiting((row) => ({
            ...row,
            brief: { ...row.brief!, answerable: "answered" },
            sent: { ...row.sent!, sentAt, ...(stillWaits && { stillWaits }) },
        }));
    };
add(["80x30"], {
    name: "field-answer-sent",
    about: "E1, E2: yes sent from this window 3 s ago: Sent from Izbor closes Needs you, the field empty with no placeholder, the Sent sentence on its line",
    store: fakeIzbor("sent"),
    steps: sentFromHere("yes", 3),
});
add(["160x40"], {
    name: "field-answer-sent-words",
    about: "S6: no, run only the export tests sent 2 s ago beside a side Brief: the Sent sentence wraps over two rows above the field's box",
    store: fakeIzbor("sent"),
    steps: sentFromHere("no, run only the export tests", 2),
});
add(["80x24", "40x24"], {
    name: "field-answer-words-sent",
    about: "F4: the three-line no sent from this window 2 s ago: Sent from Izbor and the field's own line each read it as one sentence, wrapped, with no line break, and the field's line names the agent",
    store: fakeIzbor("sent"),
    steps: sentFromHere(ANSWER_WORDS, 2),
});
add(["80x30"], {
    name: "field-answer-still-waits",
    about: "E3: yes sent 8 s ago and the request still waits: the rose × warning under Sent from Izbor, the Sent sentence gone from the field's line",
    store: fakeIzbor("sent"),
    steps: sentFromHere("yes", 8, true),
});
add(["80x30"], {
    name: "field-refused-typo",
    about: "E4: yse sent: Izbor's refusal on the field's line, rose behind its ×, yse kept",
    store: fakeIzbor({ refused: "Type yes, no, or no and your words." }),
    steps: async (app) => {
        typedInField("yse")(app);
        await sent(app);
    },
});
add(["80x30"], {
    name: "field-refused-request-over",
    about: "E9: the request ended while yes sat in the field: the label holds still, Enter refuses and nothing is sent",
    store: fakeIzbor("sent"),
    steps: async (app) => {
        typedInField("yes")(app);
        const at = new Date(NOW - 1000).toISOString();
        setWaiting((row) => {
            const { answerable: _held, ...brief } = row.brief!;
            return {
                ...row,
                brief: {
                    ...brief,
                    status: "busy",
                    needsYou: { state: "nothing" },
                    latestActivity: { text: "Bash: npm test invoices", at },
                    lastObserved: { at, from: "hook" },
                },
            };
        });
        await sent(app);
    },
});
const yesRefused = async (app: Window) => {
    typedInField("yes")(app);
    await sent(app);
};
add(["80x30"], {
    name: "brief-not-running",
    about: "R1: a request Izbor was not running for: the muted closing line under the request, the field's placeholder",
    store: fakeIzbor("sent", saidOf("not running when it asked")),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
const beforeIzbor = (row: Observation) => (row.id === SAMPLE_IDS[1] ? fromBeforeIzborStarted(row) : row);
add(["80x30"], {
    name: "wait-before-izbor",
    about: "a request from before Izbor started: Unknown and the wait's name under the badge, the muted closing line, the field titled Answer and its placeholder",
    store: fakeIzbor("sent", beforeIzbor),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["160x40"], {
    name: "brief-no-longer-held",
    about: "S3: a request Izbor no longer holds, in the side Brief: the muted closing line on two rows",
    store: fakeIzbor("sent", saidOf("expired")),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["160x40", "40x24"], {
    name: "brief-no-longer-held-refused",
    about: "S4, N2: S3 after Enter on yes: the refusal wraps over two rows above the field, at 160 and at 40 columns",
    store: fakeIzbor("sent", saidOf("expired")),
    steps: yesRefused,
});
add(["80x30"], {
    name: "brief-answered-elsewhere",
    about: "X3: another Izbor window answered the request: That request has an answer already. closes Needs you",
    store: fakeIzbor("sent", saidOf("answered")),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["80x30"], {
    name: "brief-plan-approval",
    about: "X4: a plan approval, which Izbor does not answer: Plan approval, the plan's first line, the closing line, and the field titled Answer",
    store: fakeIzbor("sent", (row) =>
        row.id === SAMPLE_IDS[1] && row.brief
            ? {
                  ...row,
                  brief: {
                      ...row.brief,
                      explanation: {
                          ...row.brief.explanation!,
                          text: "Planned the CSV export for invoices: an export route, a CSV writer and tests. Waiting for you to approve the plan.",
                      },
                      needsYou: {
                          state: "request",
                          text: "Plan approval",
                          detail: "Add CSV export for invoices: an export route, a CSV writer and tests.",
                          at: row.brief.latestActivity!.at,
                      },
                      answerable: "plan approval not supported",
                      latestActivity: { ...row.brief.latestActivity!, text: "asked to approve a plan" },
                  },
              }
            : row,
    ),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["80x30"], {
    name: "brief-request-detail",
    about: "a request whose headline was shortened: the tool call cut under the badge, then the command whole on its three lines",
    store: fakeIzbor("sent", (row) =>
        row.id === SAMPLE_IDS[1] && row.brief
            ? {
                  ...row,
                  brief: {
                      ...row.brief,
                      needsYou: {
                          state: "request",
                          text: "Bash: cd server …",
                          detail: "cd server\nnpm test invoices -- --reporter dot\ngit status --short",
                          at: row.brief.latestActivity!.at,
                      },
                  },
              }
            : row,
    ),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});

const question = (row: Observation) =>
    row.id === SAMPLE_IDS[1] && row.brief
        ? askingQuestion(
              row,
              row.brief.latestActivity!.at,
              "The CSV export is implemented. Waiting for you to pick the export's date format.",
          )
        : row;
const twoQuestions = (row: Observation) => {
    const asking = question(row);
    if (asking === row) return row;
    const { text, at } = asking.brief!.needsYou as { text: string; at: string };
    const second = "Should totals include tax?";
    const needsYou = { state: "request", text, detail: second, at } as const;
    return { ...asking, brief: { ...asking.brief!, needsYou, answerable: "question not supported" as const } };
};
add(["80x30", "40x24"], {
    name: "brief-question",
    about: "R3, N6: a Question: the question under the badge, its options numbered, the field titled Answer and the placeholder an option's number, or no",
    store: fakeIzbor("sent", question),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});
add(["160x40"], {
    name: "field-question-typed",
    about: "R4: a Question in the side Brief, 2 typed in the focused field",
    store: fakeIzbor("sent", question),
    steps: typedInField("2"),
});
add(["80x30"], {
    name: "brief-question-not-supported",
    about: "R5: a Question of two questions, which Izbor cannot answer: both questions, no numbers, the muted closing line, the field titled Answer and the placeholder answer this one in Claude Code",
    store: fakeIzbor("sent", twoQuestions),
    steps: (app) => app.openSession(SAMPLE_IDS[1]),
});

const prompted = (text: string, id: string) => async (app: Window) => {
    typedInField(text, id)(app);
    await sent(app);
};
add(["80x30"], {
    name: "field-prompt-sent",
    about: "X1: a prompt sent to the idle session: the field empty with its placeholder back, Sent to this session. on its line, the heading still Idle",
    store: fakeIzbor("sent"),
    steps: prompted("run the tests again", SAMPLE_IDS[2]),
});
add(["80x30"], {
    name: "field-prompt-queued",
    about: "E7: a prompt sent while Claude is busy: Sent. It runs when this turn ends. on the field's line, and the placeholder just your next prompt",
    store: fakeIzbor("sent"),
    steps: prompted("also add a test for refresh races", SAMPLE_IDS[0]),
});
add(["160x40"], {
    name: "field-reply-refused",
    about: "E5: a reply Izbor refused because the session has not loaded the plugin: the sentence wraps over two rows above the side Brief's field, rose behind its ×, the text kept",
    store: fakeIzbor({ refused: "Type /reload-plugins in this session once to send messages from here." }),
    steps: prompted("run the tests again", SAMPLE_IDS[2]),
});
add(["80x30"], {
    name: "field-prompt-dropped",
    about: "E8: a prompt the plugin dropped before it ran: its text back in the field, the Brief focused, the rose × line above the field",
    store: fakeIzbor("sent"),
    steps: async (app) => {
        await prompted("also add a test for refresh races", SAMPLE_IDS[2])(app);
        app.keypress(undefined, { name: "escape" });
        const observations = fake.getSnapshot().observations.map((row) =>
            row.prompt
                ? {
                      ...row,
                      prompt: { ...row.prompt, state: "dropped", reason: "it was taken off the session's queue" },
                  }
                : row,
        ) satisfies Observation[];
        fake.set({ observations });
    },
});
add(["80x30"], {
    name: "field-reply-no-plugin",
    about: "R7: the idle session's Brief in a project the list shows without the plugin: the placeholder this project has no plugin",
    store: fakeIzbor("sent", undefined, withoutPlugin),
    steps: (app) => app.openSession(SAMPLE_IDS[2]),
});

const openThird = (app: Window) => app.openSession(SAMPLE_IDS[2]);
add(["40x24"], {
    name: "response-writing",
    about: "W3 at 40 columns: the third session's Brief page, its label in the medium form under Stop observing",
    scenario: "response-writing",
    steps: openThird,
});
add(["40x24"], {
    name: "response-finished",
    about: "L4 at 40 columns: the third session's Brief page, the answer first under its label's long form; the Brief above leaves no row for the table's records, which response-finished-paged.40x24 shows after one Page Down",
    scenario: "response-finished",
    steps: openThird,
});
add(["60x24"], {
    name: "response-finished",
    about: "L4 at 60 columns: the footer's medium form, the files and their lines left out where the long form does not fit",
    scenario: "response-finished",
    steps: openThird,
});
add(["80x24", "40x24"], {
    name: "response-finished-paged",
    about: "L4, then Page Down: the old page's last row stands first, and the footer counts the rows below, from inside the turn at 80 columns and the answer's rest at 40",
    scenario: "response-finished",
    steps: (app, render) => {
        openThird(app);
        pageDown(app, render);
    },
});
add(["160x19"], {
    name: "response-finished",
    about: "L4 on a single-pane Brief page 160 columns wide, Page Down: the answer's prose still wraps at 82 columns",
    scenario: "response-finished",
    steps: (app, render) => {
        openThird(app);
        pageDown(app, render);
    },
});
add(["80x24"], {
    name: "response-finished",
    about: "L4 without colour: the full response's rows in attributes only",
    color: false,
    scenario: "response-finished",
    steps: openThird,
});
add(["80x24", "40x24"], {
    name: "response-metadata",
    about: "L4, then m: Metadata's last row one row above the footer, the full response under it, not the page's end",
    scenario: "response-finished",
    steps: (app) => {
        openThird(app);
        app.toggleMetadata();
    },
});
/** Scrolls the Brief page so the full response's row `row` (its label is row 0) stands first in the view. */
function scrollToResponse(app: Window, render: () => ViewportLayout, row: number) {
    const { responseTop = 0, maxScroll } = render();
    app.scrollBy(responseTop + row, maxScroll);
}
/** Opens the third session's Brief page and scrolls it down to its full response, as far as the page goes. */
function atResponse(app: Window, render: () => ViewportLayout) {
    openThird(app);
    scrollToResponse(app, render, 0);
}
add(["80x24"], {
    name: "response-waiting",
    about: "W3 waiting, scrolled to the full response: the waiting call whole on one row, and its result row, both amber",
    scenario: "response-waiting",
    steps: atResponse,
});
add(["40x24"], {
    name: "response-waiting",
    about: "W3 waiting at 40 columns, scrolled to the full response: the waiting call whole, wrapped onto a second row, its rows amber",
    scenario: "response-waiting",
    steps: atResponse,
});
add(["40x24"], {
    name: "response-tools",
    about: "the tool rows at 40 columns, from the subagent's call down to the footer over the failed call's row: a path's end, paths out of Wrote, the lint's colour codes gone",
    scenario: "response-tools",
    steps: (app, render) => {
        openThird(app);
        scrollToResponse(app, render, 4);
    },
});
// Windows just tall enough for the whole response-tools turn, its label on the view's first row and its last row on
// the view's last, so every tool row and state shows once in colour at each width.
add(["80x43", "40x47"], {
    name: "response-tools",
    about: "the whole turn in colour: every tool row and state, its counts bold, the background subagent running there, the waiting call last",
    scenario: "response-tools",
    steps: atResponse,
});
add(["80x24"], {
    name: "response-tools",
    about: "the tool rows without colour, from the 300-character Read's result down: ✓ * ! × in the dot's cell, the waiting call's rows bold",
    color: false,
    scenario: "response-tools",
    steps: (app, render) => {
        openThird(app);
        scrollToResponse(app, render, 12);
    },
});
// One text item as the stream sends it, through toTerminalBrief: an OSC title, a CSI colour, a CR LF, a lone CR, a tab.
const DIRTY =
    "\x1b]0;izbor-6f\x07Retries stop after \x1b[31mthree\x1b[39m attempts.\r\nThe limit is set in request.ts:\r\tconst MAX_RETRIES = 3;";
/** The third session's Brief, through toTerminalBrief, on the retry question, its reply finished 30 s ago with `items`. */
function retryAnswer(items: (at: string) => ResponseItem[]): ObservationSource {
    const { list, observations } = samples();
    const [first, second, third] = observations;
    const at = new Date(NOW - 30_000).toISOString();
    const brief = toTerminalBrief({
        type: "brief",
        sessionId: SAMPLE_IDS[2],
        task: { text: "Explain how request retries work and where the retry limit is configured.", at, from: "hook" },
        status: { state: "idle" },
        latestActivity: { what: "Reply finished", at },
        needsYou: { state: "nothing", at },
        answerable: null,
        lastObserved: { at, from: "hook", lastHookAt: at },
        explanation: { state: "explained", text: "Explained where the retry limit is set.", at },
        response: { items: items(at), end: { state: "finished", at }, source: "transcript", cut: 0 },
    });
    return createFakeStore({ list, observations: [first!, second!, { ...third!, brief }] });
}
add(["80x24"], {
    name: "response-cleaning",
    about: "a text item holding escapes, CR LF, a lone CR and a tab: three plain rows, the tab as 4 spaces",
    store: () => retryAnswer((at) => [{ type: "text", id: "dirty", at, text: DIRTY }]),
    steps: openThird,
});
const readCall = (id: string, at: string, path: string, lines: number) => callItem(id, at, read(path, lines));
/** A short turn on the retry question: one Read, then a two-line answer. */
const oneReadAnswer = (at: string): ResponseItem[] => [
    readCall("one-read", at, "src/request/send.ts", 118),
    {
        type: "text",
        id: "one-answer",
        at,
        text:
            "Retries stop after three attempts, as `MAX_RETRIES = 3` in `send.ts` says.\n" +
            "Each attempt waits twice as long as the one before it, from 200 ms.",
    },
];
// A page exactly one body tall: the Brief, then a two-line answer and a Read under Earlier in this turn down to Reply
// finished fill the 16 body rows of 80x24, so a footer on the last body row would hide only that one row.
add(["80x24"], {
    name: "response-one-hidden",
    about: "a finished turn exactly one body tall: Reply finished shows on the last body row, no footer over it (T11)",
    store: () => retryAnswer(oneReadAnswer),
    steps: openThird,
});
const READ_ONLY_ANSWER = [
    "Retries live in `src/request/send.ts`, where `sendWithRetry()` calls `send()` up to `MAX_RETRIES` times:",
    "",
    "- The limit is the constant `MAX_RETRIES = 3`, and no client can change it.",
    "- A timeout or a 5xx response is tried again; a 4xx response is not.",
    "- The wait doubles each time: 200 ms, then 400 ms, then 800 ms.",
    "- After the last attempt, that attempt's error goes to the caller.",
    "",
    "To make the limit configurable, `sendWithRetry()` would read it from the client's options and keep 3 as the default.",
    "",
    "Nothing changed: I only searched and read.",
].join("\n");
add(["80x24"], {
    name: "response-reads-only",
    about: "a turn that searched and read but changed no file: the footer sums its work up as the tool-call count alone",
    store: () =>
        retryAnswer((at) => [
            {
                type: "text",
                id: "reads-plan",
                at,
                text: "I'll find where the retry limit is set, then read the code around it.",
            },
            callItem("reads-search", at, search("MAX_RETRIES", 2)),
            readCall("reads-send", at, "src/request/send.ts", 118),
            readCall("reads-test", at, "test/request.test.ts", 210),
            { type: "text", id: "reads-answer", at, text: READ_ONLY_ANSWER },
        ]),
    steps: openThird,
});

add(["80x30"], {
    name: "response-no-text",
    about: "C, waiting with no text yet: the divider in the label's place counts all seven rows of the turn in view, then the reads and searches folded into one row",
    scenario: "response-no-text",
    steps: openThird,
});
add(["40x24"], {
    name: "response-no-text",
    about: "C at 40 columns, scrolled to the full response: the divider's words in its long form still fit, the folded row clipped",
    scenario: "response-no-text",
    steps: atResponse,
});
add(["40x24"], {
    name: "response-nothing-yet",
    about: "a new Task the agent has not started on: the two Nothing yet lines under Stop observing, wrapped at 36 columns",
    scenario: "response-nothing-yet",
    steps: openThird,
});
add(["80x24"], {
    name: "response-no-text-finished",
    about: "a reply that finished with no text: the divider's count alone, no `· no text yet`, above Reply finished",
    store: () =>
        retryAnswer((at) => [
            callItem("quiet-search", at, search("MAX_RETRIES", 2)),
            readCall("quiet-send", at, "src/request/send.ts", 118),
            readCall("quiet-test", at, "test/request.test.ts", 210),
            callItem(
                "quiet-log",
                at,
                bash("git log --oneline -1 -- src/request/send.ts", "9b1e0d2 Retry timeouts and 5xx responses"),
            ),
        ]),
    steps: openThird,
});
/** The sample sessions with the third in the case `scenario`, its full response `turn` on the sample's clock. */
function inCase(scenario: SampleScenario, turn: (at: (seconds: number) => string) => FullResponse): ObservationSource {
    const world = createSampleWorld();
    const third = world.setScenario(scenario)!;
    const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
    const [first, second] = SAMPLE_IDS.map((id) => world.row(id));
    const reading = { ...third, brief: { ...third.brief!, response: turn(at) } };
    return createFakeStore({ list: world.list, observations: [first!, second!, reading] });
}
add(["80x24"], {
    name: "response-no-transcript-working",
    about: "W3 while Izbor cannot read the transcript and the agent works: the No transcript line alone under Stop observing, and Latest: kept above it, the Brief's one live line",
    store: () =>
        inCase("response-writing", (at) => ({
            items: [],
            end: { state: "writing", at: at(-5) },
            source: "last message only",
            cut: 0,
        })),
    steps: openThird,
});
add(["80x24"], {
    name: "response-reading",
    about: "W3, scrolled to the full response, its turn ending in two reads that still run: one folded row in the present tense",
    store: () => inCase("response-writing", readingTurn),
    steps: atResponse,
});
add(["40x24"], {
    name: "response-rejected",
    about: "a reply that ended at a rejected call, at 40 columns, scrolled to the full response: the rose call, then the long end line wrapped under it",
    scenario: "response-rejected",
    steps: atResponse,
});
add(["40x24"], {
    name: "response-no-transcript",
    about: "a session whose transcript Izbor cannot read, at 40 columns, scrolled to the full response: its line wrapped first, then the last message",
    scenario: "response-no-transcript",
    steps: atResponse,
});
add(["40x24"], {
    name: "response-after-task",
    about: "a last message after a background task, at 40 columns, scrolled to the full response: the label's short form, then the notice row in the turn",
    scenario: "response-after-task",
    steps: atResponse,
});
/** The sample sessions in a project without Izbor's hooks, the idle third one's full response the short retry
 *  answer, its end as the transcript reads it, `state`. */
const withoutHooks = (state: "finished" | "writing") => () => {
    const { list, observations } = samples();
    const sessions = listedSessions(list).map((session) => ({ ...session, hooks: false }));
    const [first, second, third] = observations;
    const at = new Date(NOW - 30_000).toISOString();
    const response: FullResponse = { items: oneReadAnswer(at), end: { state, at }, source: "transcript", cut: 0 };
    return createFakeStore({
        list: { state: "listed", sessions, at: new Date().toISOString() },
        observations: [first!, second!, { ...third!, brief: { ...third!.brief!, response } }],
    });
};
add(["80x24"], {
    name: "response-no-hooks",
    about: "the idle session's finished reply in a project without Izbor's hooks: the No hooks line in the place of Reply finished",
    store: withoutHooks("finished"),
    steps: openThird,
});
add(["80x24"], {
    name: "response-no-hooks-writing",
    about: "the same idle session without hooks, whose transcript does not hold its reply's end yet and reads writing: the label reads as a turn that is over, Agent's last message, above the No hooks line",
    store: withoutHooks("writing"),
    steps: openThird,
});

// One text item that holds every element of the agent's prose, as the stream sends it, with escape sequences left in:
// an OSC title, CSI colours, a line erase and a bell, which the words remove before they parse.
const PROSE = [
    "# Retry limits per client",
    "## What changed",
    "The limit is now **set per client**, and *only* the sync client keeps the default. `sendWithRetry()` reads " +
        "it from `client.options.maxRetries`, and ***nothing else*** changed.",
    "",
    "The first wait is 200 ms at attempt 1. Each one after it doubles, up to 5 s.",
    "",
    "账单客户端现在最多重试五次，因为它的服务商会突发限流 🙂🚀，同步客户端仍然只重试三次。",
    "",
    "> A client that sets no limit behaves as before: **three** tries, then `send()` gives up.",
    "",
    "---",
    "",
    "The ~~old~~ constant is gone, and a full run takes about ~5 min (3~8 min on a slow link).",
    "To stop a run, press <kbd>Ctrl</kbd>&nbsp;C; &amp;, &#8212;, &lt;br&gt; and a bare & stay as written.",
    "",
    "\x1b]0;izbor-6f\x07The bench printed \x1b[32mdone\x1b[39m in 4.2 s\x1b[2K, then rang\x07 once.",
].join("\n");
/** A finished turn whose one item is `text`, written 30 s before the sample's now. */
const saidOnly =
    (id: string, text: string) =>
    (at: (seconds: number) => string): FullResponse => ({
        items: [{ type: "text", id, at: at(-30), text }],
        end: { state: "finished", at: at(-30) },
        source: "transcript",
        cut: 0,
    });
const proseTurn = saidOnly("prose", PROSE);
add(["80x24", "40x24"], {
    name: "words-prose",
    about: "the agent's prose, scrolled to the full response: headings with no `#`, the first underlined, bold and italic with no markers, inline code in the code tone with no backticks, and at 36 columns `1.` kept with the word before it",
    store: () => inCase("response-finished", proseTurn),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-prose",
    about: "the agent's prose without colour, scrolled to the full response: `#` and the backticks back, bold and italic kept",
    color: false,
    store: () => inCase("response-finished", proseTurn),
    steps: atResponse,
});
// The item is taller than one body at both sizes, so a second frame stands one Page Down on: at 80 columns it shows
// the item's rest, at 40 its middle.
function proseOnePageDown(app: Window, render: () => ViewportLayout) {
    atResponse(app, render);
    pageDown(app, render);
}
add(["80x24"], {
    name: "words-prose-paged",
    about: "the agent's prose one Page Down on: the CJK and emoji wrapped, the quote muted and italic, the rule, `~~old~~` and `~5 min` as written, raw HTML and its entities as written but `&nbsp;`, the escapes gone",
    store: () => inCase("response-finished", proseTurn),
    steps: proseOnePageDown,
});
add(["40x24"], {
    name: "words-prose-paged",
    about: "the agent's prose one Page Down on at 36 columns: the CJK and emoji wrapped, the quote muted and italic, the rule, `~~old~~` and `~5 min` as written",
    store: () => inCase("response-finished", proseTurn),
    steps: proseOnePageDown,
});
add(["80x24"], {
    name: "words-prose-paged",
    about: "the agent's prose without colour one Page Down on: `> ` on every quote row, italic, and `---` as written",
    color: false,
    store: () => inCase("response-finished", proseTurn),
    steps: proseOnePageDown,
});

// Bullets three deep, a list that starts at 9, and two task items; the deepest bullet and item 9 wrap at 36 columns,
// the deepest bullet at 76 too.
const LISTS = [
    "- Every client reads its own limit:",
    "  - billing sets 5, for its bursts",
    "    - each wait doubles from 200 ms up to 5 s, and a `Retry-After` header wins over it",
    "  - sync keeps 3",
    "",
    "9. Read the limit in `sendWithRetry()`",
    "10. Keep 3 as the default",
    "",
    "- [ ] Test the sync client's limit",
    "- [x] Drop the `MAX_RETRIES` constant",
].join("\n");
add(["80x24", "40x24"], {
    name: "words-lists",
    about: "the agent's lists, scrolled to the full response: `- ` at every depth, 2 columns a level, wrapped rows hanging under the text, 9 and 10 right-aligned, and the task boxes after their marker",
    store: () => inCase("response-finished", saidOnly("lists", LISTS)),
    steps: atResponse,
});

/** The bench's settings: 17 lines, more than a code block takes rows at any size here, so it is cut. */
const BENCH_SETTINGS = ["billing", "sync"].flatMap((client, index) => [
    ...(index ? [""] : []),
    `client "${client}" {`,
    `  max_retries = ${index ? 3 : 5}`,
    "  backoff {",
    '    first  = "200ms"',
    "    factor = 2",
    '    cap    = "5s"',
    "  }",
    "}",
]);
// A long block in a language Izbor has no colours for, then a fence with none whose one line is 88 columns long.
const CODE = [
    "```hcl",
    ...BENCH_SETTINGS,
    "```",
    "",
    "```",
    "npm run bench -- retries --config bench.hcl --clients billing,sync --report bench.ndjson",
    "```",
].join("\n");
add(["80x24", "40x24", "160x19"], {
    name: "words-code",
    about: "the agent's code blocks, scrolled to the full response: the language's muted row, the code 2 columns in, in the code tone, its leading spaces kept, cut after its first lines with the exact count of the rest, and the 88-column command wrapped at the pane's width, not at 82",
    store: () => inCase("response-finished", saidOnly("code", CODE)),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-code",
    about: "the agent's code blocks without colour, scrolled to the full response: the fence lines back as written, 2 columns in, with no language row, and the count of the lines cut over the closing fence",
    color: false,
    store: () => inCase("response-finished", saidOnly("code", CODE)),
    steps: atResponse,
});
// At 80×24 a block takes at most 8 rows: this one takes 9, since its last line wraps over two, so only that line
// would be left out.
const CODE_ONE_LINE = [
    "The sync client's part:",
    "",
    "```hcl",
    'client "sync" {',
    "  max_retries = 3",
    "  backoff {",
    '    first = "200ms"',
    "  }",
    "}",
    "# sync keeps the default of 3: the service behind it has never rate-limited a burst of retries",
    "```",
].join("\n");
add(["80x24"], {
    name: "words-code-one-line",
    about: "a code block one row taller than the 8 rows a block takes at 80×24, its last line wrapped over two: the line shows whole, with no `… 1 more line`",
    store: () => inCase("response-finished", saidOnly("code-one-line", CODE_ONE_LINE)),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-syntax",
    about: "code fenced as ts, bash and json, scrolled to the full response: no language row, each block 2 columns in, in syntax colours: keywords, literals and class names blue, built-ins cyan, numbers green, strings red, functions yellow, the comment muted on each of its three rows, the rest in the terminal's own text colour",
    store: () => inCase("response-finished", syntaxTurn),
    steps: atResponse,
});
add(["40x24"], {
    name: "words-syntax",
    about: "the same code at 36 columns, scrolled to the full response: its lines wrapped at the pane's width with their colours on every row, and the TypeScript block, taller than 8 rows, cut after its colours with the count of the lines left out",
    store: () => inCase("response-finished", syntaxTurn),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-syntax",
    about: "the same code without colour while Izbor has the syntax colours, scrolled to the full response: none of them, and each block's fence lines back as written, 2 columns in",
    color: false,
    store: () => inCase("response-finished", syntaxTurn),
    steps: atResponse,
});

// A table whose cells take 104 columns, Limit right-aligned and First wait centred: wider than the prose's 82, so it
// stands as a grid at full width only in a window 160 columns wide. At 80 its cells wrap inside their columns.
const TABLE = [
    "The retry settings per client, after this change:",
    "",
    "| Client | Limit | First wait | Source | Why |",
    "| --- | ---: | :---: | --- | --- |",
    "| billing | 5 | 200 ms | `src/billing/client.ts` | Its provider rate-limits in bursts |",
    "| sync | 3 | 200 ms | `src/sync/client.ts` | The old default: the sync service never rate-limits |",
    "| payments | 0 | — | `src/payments/client.ts` | A retried charge could bill a customer twice |",
].join("\n");
add(["160x19"], {
    name: "words-table",
    about: "a table 104 columns wide, scrolled to the full response: a grid in the pane's width, not the prose's 82 columns, with no borders, its header bold over one rule row, Limit right-aligned, First wait centred and the paths in the code tone",
    store: () => inCase("response-finished", saidOnly("table", TABLE)),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-table",
    about: "the same table without colour, scrolled to the full response: each column keeps its longest word and its cells wrap inside it, the backticks back round the paths, the header still bold",
    color: false,
    store: () => inCase("response-finished", saidOnly("table", TABLE)),
    steps: atResponse,
});

// Links of every kind, then `~~old~~` beside a single `~`: a label that wraps over two rows at 36 columns, a bare URL,
// a label equal to its URL, and marked's `www.` and email autolinks, whose URLs add `http://` and `mailto:`.
const LINKS = [
    "Each limit follows [the retry options in the marked docs](https://marked.js.org/using_advanced#options), and " +
        "the provider's status page is https://status.example.com/retries.",
    "",
    "[https://ci.example.com/runs/4821](https://ci.example.com/runs/4821) has the whole run. The package is at " +
        "www.npmjs.com/package/marked, and questions go to retries@example.com.",
    "",
    "The ~~old~~ constant is gone, and ~old~ with one tilde stays as written.",
].join("\n");
const linksTurn = saidOnly("links", LINKS);
const BOTH_ON: Abilities = { links: true, strike: true };
add(["80x24", "40x24"], {
    name: "words-links",
    about: "the agent's links and `~~old~~` in a terminal that shows both, scrolled to the full response: each label, a bare URL too, an OSC 8 link in the link tone, underlined, opened again on each row it wraps over at 36 columns, `www.` and the email address linked with `http://` and `mailto:`, `old` struck through and `~old~` as written",
    store: () => inCase("response-finished", linksTurn),
    steps: atResponse,
    abilities: BOTH_ON,
});
add(["80x24"], {
    name: "words-links-plain",
    about: "the same links and `~~old~~` in a terminal that shows neither, scrolled to the full response: `label (url)`, the URL muted, a URL the label already says shown once, and `~~old~~` as written",
    store: () => inCase("response-finished", linksTurn),
    steps: atResponse,
});
add(["80x24"], {
    name: "words-links",
    about: "the same links and `~~old~~` without colour, in a terminal that shows both, scrolled to the full response: no OSC 8 link, `label (url)` with the label underlined, a URL the label already says shown once, and `~~old~~` as written",
    color: false,
    store: () => inCase("response-finished", linksTurn),
    steps: atResponse,
    abilities: BOTH_ON,
});

const TEXTS = [
    ["ascii", "observe session a7312ce4"],
    ["wide", "界".repeat(10)],
    ["emoji", "ok 🙂🙂🙂🙂 go"],
    ["combining", "cafe\u0301 cafe\u0301 cafe\u0301"],
    ["flags", "🇺🇸🇯🇵🇫🇷 x"],
    ["control", "add hooks ~/a\x1b[31mb\x01c"],
] as const;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TABLES: Record<string, () => string[]> = {
    "table.fieldWindow": () => [
        `fieldWindow(fieldText(text, cursor, columns), ${FIELD_TEXT_ROWS}, rows above at the cursor before): rows, rows above, cursor row,column, indices of each row`,
        "The cursor steps right from the text's start, and the box keeps its rows above while the cursor's row shows.",
        "",
        ...[...TEXTS, ["lines", "run\tall\nthe tests"] as const, ["hanging", "aaaa bbbb "] as const].flatMap(
            ([name, text]) => {
                const cells = Math.max(...text.split("\n").map((line) => stringWidth(line.replaceAll("\t", "    "))));
                const edges = [...Array.from(graphemes.segment(text), ({ index }) => index), text.length];
                const lines = [`${name} ${JSON.stringify(text)} (${text.length} code units, ${cells} cells)`];
                const widths = new Set([1, 2, 3, 4, cells - 1, cells, cells + 1, cells + 2]);
                for (const columns of [...widths].sort((a, b) => a - b)) {
                    let from = 0;
                    for (const cursor of edges) {
                        const window = fieldWindow(fieldText(text, cursor, columns), FIELD_TEXT_ROWS, from);
                        const { rows, above, cursor: at } = window;
                        from = above;
                        const texts = JSON.stringify(rows.map(({ text }) => text));
                        const indices = rows.map(({ indices }) => runs(indices)).join(" / ");
                        lines.push(`  ${columns} ${cursor}  ${texts}  ${above}  ${at.row},${at.column}  ${indices}`);
                    }
                }
                return [...lines, ""];
            },
        ),
    ],
    "table.clip": () => [
        "clip(text, columns)",
        "",
        ...TEXTS.flatMap(([name, text]) => {
            const lines = [`${name} ${JSON.stringify(text)}`];
            for (let columns = 0; columns <= stringWidth(text) + 1; columns++)
                lines.push(`  ${columns}  ${JSON.stringify(clip(text, columns))}`);
            return [...lines, ""];
        }),
    ],
};

test("the corpus renders in truecolor and UTC", () => {
    assert.equal(chalk.level, 3);
    assert.equal(new Date(NOW).getHours(), 12);
});

test("test/frames holds one file per case", () => {
    const ids = new Set([...CASES.map(({ id }) => id), ...Object.keys(TABLES)]);
    const files = existsSync(FRAMES) ? readdirSync(FRAMES) : [];
    const strays = files.filter((name) => name.endsWith(".txt") && !ids.has(name.slice(0, -4)));
    if (UPDATE) for (const name of strays) rmSync(join(FRAMES, name));
    else assert.deepEqual(strays, [], "no case writes these files");
});

for (const { id, recipe, size, color } of CASES) {
    test(id, async (t) => {
        t.mock.timers.enable({ apis: ["Date"], now: NOW });
        const { app, scene } = openWindow(recipe, size);
        try {
            const now = new Date(NOW + (recipe.offset ?? 0));
            const render = () => renderFrame(app.view, size, color, now);
            await recipe.steps?.(app, () => render().layout);
            scene();
            const { raw, layout } = render();
            t.assert.fileSnapshot(
                frameFile({ id, about: recipe.about, size, color, now, raw, layout }),
                join(FRAMES, `${id}.txt`),
                { serializers: [(text) => text] },
            );
        } finally {
            app.dispose();
        }
    });
}

for (const [id, table] of Object.entries(TABLES)) {
    test(id, (t) => {
        t.assert.fileSnapshot(table().join("\n"), join(FRAMES, `${id}.txt`), { serializers: [(text) => text] });
    });
}

import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import stringWidth from "string-width";
import type { NotAnswerable } from "../src/domain/answer.js";
import type { SampleScenario } from "./helpers/sampleSessions.js";
import type {
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
const { clip, commandWindow } = await import("../src/terminal/presentation.js");
const { createFakeStore } = await import("./helpers/fakeStore.js");
const { fromBeforeIzborStarted } = await import("./helpers/unseenWait.js");

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
    { store, empty = false, scenario = "overview", after, oldBuild }: Recipe,
    { columns, rows }: TerminalSize,
): { app: Window; scene: () => void } {
    if (store) {
        const source = typeof store === "function" ? store() : createFakeStore(store);
        const app = createTerminalController(source, { ...NO_WRITES, columns, rows, oldBuild, changed() {} });
        return { app, scene: () => {} };
    }
    const source = createSampleSource({ scenario: after ? "overview" : scenario, animate: false });
    const app = createTerminalController(source, {
        ...writersOf(source.setup),
        initialIds: empty ? [] : SAMPLE_IDS,
        columns,
        rows,
        oldBuild,
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
    app.keypress(undefined, { name }, pane.maxScroll, pane.pageSize);
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
    "table.commandWindow": () => [
        "commandWindow(command, cursor, columns): text, cursor, indices",
        "",
        ...TEXTS.flatMap(([name, text]) => {
            const cells = stringWidth(text);
            const edges = [...Array.from(graphemes.segment(text), ({ index }) => index), text.length];
            const lines = [`${name} ${JSON.stringify(text)} (${text.length} code units, ${cells} cells)`];
            const widths = new Set([1, 2, 3, 4, cells - 1, cells, cells + 1, cells + 2]);
            for (const columns of [...widths].sort((a, b) => a - b))
                for (const cursor of edges) {
                    const window = commandWindow(text, cursor, columns);
                    const shown = `${JSON.stringify(window.text)}  ${window.cursor}  ${runs(window.indices)}`;
                    lines.push(`  ${columns} ${cursor}  ${shown}`);
                }
            return [...lines, ""];
        }),
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

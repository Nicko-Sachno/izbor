import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { mergeIzborHooks } from "../src/adapters/agents/claude/setup/izborHooks.js";
import { HOOK_RUNNER } from "./helpers/answerHook.js";
import type { ActingChange, HooksChange, HooksRequest } from "../src/domain/projectSetup.js";
import { createTerminalController } from "../src/terminal/controller.js";
import { projectFocus } from "../src/terminal/focus.js";
import type { RunningSession, Snapshot } from "../src/terminal/model.js";
import { renderTerminal } from "../src/terminal/render.js";
import { createFakeStore } from "./helpers/fakeStore.js";

chalk.level = 0;

const HOME = "/Users/me";
const CHECKOUT = "/Users/me/code/example-api";
const LONG_CHECKOUT = "/Users/me/code/example-api-abcdef";

const SESSION: RunningSession = {
    id: "0f6c9a52-3c1e-4b8e-9d42-1a2b3c4d5e6f",
    name: "Orders API review",
    status: "idle",
    checkout: CHECKOUT,
    hooks: false,
    acting: false,
};

function hooksWindow(
    t: TestContext,
    answer: (request: HooksRequest) => HooksChange,
    { columns = 80, rows = 24, snapshot = {} }: { columns?: number; rows?: number; snapshot?: Partial<Snapshot> } = {},
) {
    const fake = createFakeStore({
        izbor: { state: "up", address: "127.0.0.1:5123" },
        list: { state: "listed", sessions: [SESSION], at: "2026-10-08T12:00:00.000Z" },
        ...snapshot,
    });
    const refreshes: number[] = [];
    const store = {
        ...fake,
        refreshSessions() {
            refreshes.push(1);
            return fake.refreshSessions();
        },
    };
    const requests: HooksRequest[] = [];
    const pluginRequests: HooksRequest[] = [];
    const pluginAdded = ({ folder }: HooksRequest): ActingChange => ({
        done: "added",
        checkout: folder,
        file: `${folder}/.claude/settings.local.json`,
    });
    const app = createTerminalController(store, {
        columns,
        rows,
        hooks: {
            port: 5123,
            write: (request) => (requests.push(request), answer(request)),
        },
        plugin: { port: 5123, change: async (request) => (pluginRequests.push(request), pluginAdded(request)) },
        home: HOME,
        changed() {},
    });
    t.after(() => app.dispose());
    const frame = () => renderTerminal(app.view, { columns, rows }, false).lines;
    return { app, store, requests, pluginRequests, refreshes, frame };
}

const done =
    (outcome: "added" | "already" | "removed" | "none", checkout = CHECKOUT) =>
    (): HooksChange => ({ done: outcome, checkout, file: `${checkout}/.claude/settings.local.json` });

const ADDED = "Added Izbor's hooks to example-api.";

test("the answers name the project and fit the feedback line at 80 columns; success asks for the list once per write, on the screen you were on", (t) => {
    const acting: Partial<Snapshot> = {
        list: { state: "listed", sessions: [{ ...SESSION, acting: true }], at: "2026-10-08T12:00:00.000Z" },
    };
    const cases: ["added" | "already", string, string, boolean, Partial<Snapshot>][] = [
        ["added", CHECKOUT, ADDED, true, {}],
        ["already", CHECKOUT, "example-api already has Izbor's hooks.", false, {}],
        ["added", LONG_CHECKOUT, "Added Izbor's hooks to example-api-abcdef.", true, {}],
        ["already", LONG_CHECKOUT, "example-api-abcdef already has Izbor's hooks.", false, {}],
        ["added", CHECKOUT, ADDED, true, acting],
    ];
    for (const [outcome, checkout, words, wrote, snapshot] of cases) {
        const { app, refreshes, frame } = hooksWindow(t, done(outcome, checkout), { snapshot });
        assert.equal(app.view.screen, "home");
        app.addHooks(checkout);
        const label = `${outcome} ${checkout}${snapshot === acting ? " acting" : ""}`;
        assert.deepEqual(
            { feedback: app.view.feedback, error: app.view.feedbackIsError, refreshes, screen: app.view.screen },
            { feedback: words, error: false, refreshes: wrote ? [1] : [], screen: "home" },
            label,
        );
        assert.ok(stringWidth(words) <= 61, `${words} is ${stringWidth(words)} cells`);
        assert.ok(
            frame().some((line) => line.includes(words)),
            `the whole answer shows at 80 columns:\n${frame().join("\n")}`,
        );
    }
});

test("on Sessions, a hooks command leaves you on Sessions", (t) => {
    const row = { id: SESSION.id, brief: null, connection: { state: "live" } } as const;
    const { app } = hooksWindow(t, done("added"), { snapshot: { observations: [row] } });
    app.showScreen("sessions");
    app.addHooks(CHECKOUT);
    assert.equal(app.view.screen, "sessions");
    assert.equal(app.view.feedback, ADDED);
});

function why(text: string): string {
    const merge = mergeIzborHooks(text, 5123, HOOK_RUNNER);
    assert.ok("refused" in merge, text);
    return merge.refused;
}

test("a refusal names the act and its bare cause, and asks for no list", (t) => {
    const at = { checkout: LONG_CHECKOUT, file: `${LONG_CHECKOUT}/.claude/settings.local.json` };
    const cases: [HooksChange, string][] = [
        [{ refused: "no folder", folder: "/Users/me/code/missing" }, "Could not add hooks: no folder ~/code/missing."],
        [{ refused: "no folder", folder: "/srv/missing" }, "Could not add hooks: no folder /srv/missing."],
        [{ refused: "home folder" }, "Could not add hooks: not in your home folder or a drive root."],
        [
            { refused: "no access", folder: "/Users/me/Desktop", why: "EACCES" },
            "Could not add hooks: Izbor may not look in ~/Desktop.",
        ],
        [{ refused: "link", ...at, link: `${LONG_CHECKOUT}/.claude` }, "Could not add hooks: .claude is a link."],
        [{ refused: "link", ...at, link: at.file }, "Could not add hooks: settings.local.json is a link."],
        [
            { refused: "settings", ...at, why: why("{ hooks") },
            "Could not add hooks: settings.local.json is not valid JSON.",
        ],
        [{ refused: "settings", ...at, why: why("[]") }, "Could not add hooks: settings.local.json is not an object."],
        [
            { refused: "settings", ...at, why: why('{ "hooks": [] }') },
            'Could not add hooks: odd "hooks" in settings.local.json.',
        ],
        [
            { refused: "settings", ...at, why: why('{ "hooks": { "PostToolUseFailure": {} } }') },
            'Could not add hooks: odd "hooks" in settings.local.json.',
        ],
        [
            { refused: "write", ...at, why: "EACCES: permission denied, open '…'" },
            "Could not add hooks: could not write settings.local.json.",
        ],
    ];
    for (const [answer, words] of cases) {
        const { app, refreshes, frame } = hooksWindow(t, () => answer);
        app.addHooks(LONG_CHECKOUT);
        assert.deepEqual(
            { feedback: app.view.feedback, error: app.view.feedbackIsError, refreshes },
            { feedback: words, error: true, refreshes: [] },
            JSON.stringify(answer),
        );
        assert.ok(stringWidth(words) <= 61, `${words} is ${stringWidth(words)} cells`);
        assert.ok(
            frame().some((line) => line.includes(words)),
            `the whole answer shows at 80 columns:\n${frame().join("\n")}`,
        );
    }
});

function listing(checkout: string, hooks = false): Partial<Snapshot> {
    return {
        list: {
            state: "listed",
            sessions: [{ ...SESSION, checkout, hooks }],
            at: "2026-10-08T12:00:00.000Z",
        },
    };
}

test("Enter on a project line adds Izbor's hooks at once with its checkout", (t) => {
    const { app, requests, refreshes } = hooksWindow(t, done("added"));
    app.keypress(undefined, { name: "tab" });
    assert.equal(app.view.focused, projectFocus(CHECKOUT), "Tab from nothing: the project line comes first");
    app.keypress(undefined, { name: "return" });
    assert.deepEqual(requests, [{ change: "add", folder: CHECKOUT, port: 5123 }]);
    assert.deepEqual([app.view.feedback, refreshes], [ADDED, [1]]);
    assert.equal(app.view.focused, projectFocus(CHECKOUT), "focus stays on the line");
});

test("a project with Izbor's hooks and no plugin: Enter runs the plugin change, not the hooks", (t) => {
    const { app, requests, pluginRequests } = hooksWindow(t, done("added"), { snapshot: listing(CHECKOUT, true) });
    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "return" });
    assert.deepEqual(pluginRequests, [{ change: "add", folder: CHECKOUT, port: 5123 }]);
    assert.deepEqual(requests, []);
});

test("Enter on a project line reaches the writer with the very checkout: spaces, outside home, a trailing space", (t) => {
    for (const checkout of ["/Users/me/My Projects/example api", "/srv/app", "/Users/me/code/app "]) {
        const { app, requests } = hooksWindow(t, done("added", checkout), { snapshot: listing(checkout) });
        app.keypress(undefined, { name: "tab" });
        app.keypress(undefined, { name: "return" });
        assert.deepEqual(requests, [{ change: "add", folder: checkout, port: 5123 }], checkout);
    }
});

test("a project in the home folder: Enter gets the home folder's refusal", (t) => {
    const { app, requests } = hooksWindow(t, () => ({ refused: "home folder" }), { snapshot: listing(HOME) });
    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "return" });
    assert.deepEqual(requests, [{ change: "add", folder: HOME, port: 5123 }]);
    assert.deepEqual(
        [app.view.feedback, app.view.feedbackIsError],
        ["Could not add hooks: not in your home folder or a drive root.", true],
    );
});

test("actOnProjectLine writes nothing on a project with both, nor on a checkout the list has dropped, and the feedback stays", (t) => {
    const both: Partial<Snapshot> = {
        list: {
            state: "listed",
            sessions: [{ ...SESSION, hooks: true, acting: true }],
            at: "2026-10-08T12:00:00.000Z",
        },
    };
    const { app, store, requests, pluginRequests } = hooksWindow(t, done("added"), { snapshot: both });
    app.showError("as it was");
    app.actOnProjectLine(CHECKOUT);
    store.set({ list: { state: "listed", sessions: [], at: "2026-10-08T12:00:05.000Z" } });
    app.actOnProjectLine(CHECKOUT);
    assert.deepEqual([requests, pluginRequests], [[], []]);
    assert.deepEqual([app.view.feedback, app.view.feedbackIsError], ["as it was", true]);
});

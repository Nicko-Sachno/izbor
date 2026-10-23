import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import chalk from "chalk";
import stringWidth from "string-width";
import { changeActing, type RunPluginCommand } from "../src/adapters/agents/claude/setup/plugin.js";
import type { ActingChange, HooksRequest } from "../src/domain/projectSetup.js";
import { createTerminalController } from "../src/terminal/controller.js";
import { projectFocus } from "../src/terminal/focus.js";
import type { RunningSession, Snapshot } from "../src/terminal/model.js";
import { renderTerminal } from "../src/terminal/render.js";
import { HOOK_RUNNER } from "./helpers/answerHook.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

chalk.level = 0;

const HOME = "/Users/me";
const CHECKOUT = "/Users/me/code/example-api";
const LONG_CHECKOUT = "/Users/me/code/example-api-abcdef";

const SESSION: RunningSession = {
    id: "0f6c9a52-3c1e-4b8e-9d42-1a2b3c4d5e6f",
    name: "Orders API review",
    status: "idle",
    checkout: CHECKOUT,
    hooks: true,
    acting: false,
};

function pluginWindow(
    t: TestContext,
    answer: (request: HooksRequest) => ActingChange,
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
    let renders = 0;
    const app = createTerminalController(store, {
        columns,
        rows,
        hooks: {
            port: 5123,
            write() {
                assert.fail("no hooks command here");
            },
        },
        plugin: { port: 5123, change: async (request) => (requests.push(request), answer(request)) },
        home: HOME,
        changed: () => renders++,
    });
    t.after(() => app.dispose());
    const frame = () => renderTerminal(app.view, { columns, rows }, false).lines;
    return { app, store, requests, refreshes, frame, renders: () => renders };
}

const answered = () => delay(0);

const done =
    (outcome: "added" | "updated" | "already", checkout = CHECKOUT) =>
    (): ActingChange => ({ done: outcome, checkout, file: `${checkout}/.claude/settings.local.json` });

test("while Claude Code's CLI runs, the feedback line says so; then the answer names the project, and a change asks for the list once", async (t) => {
    const cases: ["added" | "updated" | "already", string, boolean][] = [
        ["added", "Added Izbor's plugin to example-api.", true],
        ["updated", "Updated Izbor's answer hook in example-api.", true],
        ["already", "example-api already has Izbor's plugin.", false],
    ];
    for (const [outcome, words, wrote] of cases) {
        const { app, refreshes, renders } = pluginWindow(t, done(outcome));
        app.addPlugin(CHECKOUT);
        const view = () => ({ feedback: app.view.feedback, error: app.view.feedbackIsError, screen: app.view.screen });
        assert.deepEqual(view(), { feedback: "Adding Izbor's plugin…", error: false, screen: "home" }, outcome);
        assert.deepEqual(refreshes, [], outcome);
        const before = renders();
        await answered();
        assert.deepEqual(view(), { feedback: words, error: false, screen: "home" }, outcome);
        assert.deepEqual(refreshes, wrote ? [1] : [], outcome);
        assert.ok(renders() > before, `${outcome}: the answer renders`);
    }
});

test("a refusal is short, an error for the rose × line, and asks for no list", async (t) => {
    const at = { checkout: LONG_CHECKOUT, file: `${LONG_CHECKOUT}/.claude/settings.local.json` };
    const cases: [ActingChange, string][] = [
        [
            { refused: "no folder", folder: "/Users/me/code/missing" },
            "Could not add the plugin: no folder ~/code/missing.",
        ],
        [{ refused: "home folder" }, "Could not add the plugin: not in your home folder or a drive root."],
        [
            { refused: "no access", folder: "/Users/me/Desktop", why: "EACCES" },
            "Could not add the plugin: Izbor may not look in ~/Desktop.",
        ],
        [{ refused: "link", ...at, link: `${LONG_CHECKOUT}/.claude` }, "Could not add the plugin: .claude is a link."],
        [
            { refused: "settings", ...at, why: "is not valid JSON" },
            "Could not add the plugin: settings.local.json is not valid JSON.",
        ],
        [
            { refused: "write", ...at, why: "EACCES: permission denied, open '…'" },
            "Could not add the plugin: could not write settings.local.json.",
        ],
        [
            { refused: "plugin", checkout: LONG_CHECKOUT, why: "Path does not exist: /x" },
            "Could not add the plugin: claude could not install it.",
        ],
    ];
    for (const [answer, words] of cases) {
        const { app, refreshes, frame } = pluginWindow(t, () => answer);
        app.addPlugin(LONG_CHECKOUT);
        await answered();
        assert.deepEqual(
            { feedback: app.view.feedback, error: app.view.feedbackIsError, refreshes },
            { feedback: words, error: true, refreshes: [] },
            JSON.stringify(answer),
        );
        assert.ok(stringWidth(words) <= 76, `${words} is ${stringWidth(words)} cells`);
        assert.ok(
            frame().some((line) => line.includes(words)),
            `the whole answer shows at 80 columns:\n${frame().join("\n")}`,
        );
    }
});

test("every answer for a 21-character project fits the feedback line at 80 columns", async (t) => {
    for (const outcome of ["added", "updated", "already"] as const) {
        const { app, frame } = pluginWindow(t, done(outcome, LONG_CHECKOUT));
        app.addPlugin(LONG_CHECKOUT);
        await answered();
        assert.ok(app.view.feedback.includes("example-api-abcdef"), app.view.feedback);
        assert.ok(stringWidth(app.view.feedback) <= 61, app.view.feedback);
        assert.ok(
            frame().some((line) => line.includes(app.view.feedback)),
            frame().join("\n"),
        );
    }
});

function fakeClaudePlugin(calls: string[]): RunPluginCommand {
    return async (args, cwd) => {
        calls.push(`${basename(cwd)}: claude plugin ${args.join(" ")}`);
        const file = join(cwd, ".claude", "settings.local.json");
        const settings = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
        const [verb, what, source] = args;
        if (verb === "marketplace" && what === "add")
            settings.extraKnownMarketplaces = { izbor: { source: { source: "directory", path: source } } };
        if (verb === "install") settings.enabledPlugins = { "izbor@izbor": true };
        if (verb === "uninstall") settings.enabledPlugins = {};
        if (verb === "marketplace" && what === "remove") settings.extraKnownMarketplaces = {};
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
        return { outcome: "ok" };
    };
}

const doneBy = (change: ActingChange) => ("done" in change ? change.done : change);

test("a marketplace declared from Izbor's plugin folder with another drive-letter case is already there: izbor plugin does not add it again", async (t) => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "izbor-drive-")));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const project = join(tmp, "app");
    await mkdir(join(project, ".claude"), { recursive: true });
    const settings = {
        extraKnownMarketplaces: { izbor: { source: { source: "directory", path: "c:\\izbor\\plugin" } } },
        enabledPlugins: { "izbor@izbor": true },
    };
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify(settings));
    const calls: string[] = [];

    const change = await changeActing({
        change: "add",
        folder: project,
        port: 5123,
        home: join(tmp, "home"),
        platform: hostPlatform(),
        pluginDir: "C:\\izbor\\plugin",
        runner: HOOK_RUNNER,
        run: fakeClaudePlugin(calls),
    });

    assert.equal(doneBy(change), "added");
    assert.deepEqual(calls, []);
});

const HOOKS_ONLY = "/Users/me/code/izbor";
const ACTING = "/Users/me/code/invoice-api";
const session = (id: string, checkout: string, hooks: boolean, acting: boolean): RunningSession => ({
    id,
    name: `${checkout.split("/").at(-1)}-${id.slice(0, 2)}`,
    status: "idle",
    checkout,
    hooks,
    acting,
});
const A1 = session("a1000000-0000-4000-8000-000000000000", HOOKS_ONLY, true, false);
const C1 = session("c1000000-0000-4000-8000-000000000000", ACTING, true, true);
const listed = (...sessions: RunningSession[]): Partial<Snapshot> => ({
    list: { state: "listed", sessions, at: "2026-10-08T12:00:00.000Z" },
});

test("a refresh that takes a project's hooks away turns its cue into Add hooks ›, and focus on a line it keeps stays", (t) => {
    const { app, store, frame } = pluginWindow(t, done("added"), { snapshot: listed(A1, C1), rows: 30 });
    const line = (start: string) =>
        frame()
            .find((line) => line.startsWith(start))
            ?.trimEnd() ?? "";
    app.showScreen("home");
    for (let tab = 0; tab < 3; tab++) app.keypress(undefined, { name: "tab" });
    assert.equal(app.view.focused, projectFocus(ACTING));
    assert.equal(line("     invoice-api"), "     invoice-api");
    store.set(listed(A1, { ...C1, hooks: false }));
    assert.match(line("     invoice-api"), /^ {5}invoice-api · Briefs update late +Add hooks ›$/);
    assert.ok(!frame().some((line) => /plugin added|no plugin ·/.test(line)), "no plugin line");
    assert.equal(app.view.focused, projectFocus(ACTING), "a line that stays keeps focus");
    store.set(listed(A1, C1));
    assert.equal(line("     invoice-api"), "     invoice-api");
    assert.equal(app.view.focused, projectFocus(ACTING));
});

test("actOnProjectLine while a plugin change is out for that checkout starts no second change; once it has answered, it may start one", async (t) => {
    const { app, requests } = pluginWindow(t, done("added"));
    app.actOnProjectLine(CHECKOUT);
    app.actOnProjectLine(CHECKOUT);
    assert.deepEqual(requests, [{ change: "add", folder: CHECKOUT, port: 5123 }]);
    await answered();
    assert.equal(app.view.feedback, "Added Izbor's plugin to example-api.");
    app.actOnProjectLine(CHECKOUT);
    assert.equal(requests.length, 2, "the first change has answered");
});

test("disposing while plugin setup is pending ignores its late result and starts no refresh", async () => {
    const store = createFakeStore();
    let complete = (_result: ActingChange) => {};
    let refreshes = 0;
    let renders = 0;
    store.refreshSessions = async () => (refreshes++, store.getSnapshot().list);
    const app = createTerminalController(store, {
        ...NO_WRITES,
        plugin: { port: 5123, change: () => new Promise((resolve) => (complete = resolve)) },
        changed: () => renders++,
    });
    app.addPlugin(CHECKOUT);
    app.dispose();
    const before = renders;
    complete(done("added")());
    await answered();
    assert.equal(refreshes, 0);
    assert.equal(renders, before);
    assert.equal(app.view.feedback, "Adding Izbor's plugin…");
});

test("a refresh cancelled after adding hooks is handled without repainting a disposed window", async () => {
    const store = createFakeStore();
    let cancelRefresh = (_reason: Error) => {};
    let renders = 0;
    store.refreshSessions = () => new Promise((_resolve, reject) => (cancelRefresh = reject));
    const app = createTerminalController(store, {
        ...NO_WRITES,
        hooks: {
            port: 5123,
            write: () => ({ done: "added", checkout: CHECKOUT, file: `${CHECKOUT}/.claude/settings.local.json` }),
        },
        changed: () => renders++,
    });
    app.addHooks(CHECKOUT);
    app.dispose();
    const before = renders;
    cancelRefresh(new DOMException("Disposed", "AbortError"));
    await answered();
    assert.equal(renders, before);
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import { checkoutOf } from "../src/adapters/agents/claude/setup/projectFiles.js";
import { forConsole, MOUSE_OFF, VS_CODE_TITLE } from "../src/cli/commands/open.js";
import { readCliArgs } from "../src/cli/args.js";
import { PROJECT_DIR, type ScreenFlags } from "../src/config.js";
import type { SessionsAnswer } from "../src/domain/wire.js";
import { fakeTerminal } from "./helpers/fakeTerminal.js";
import { KEYS } from "./helpers/keys.js";
import { hostLive, startIzborServer } from "./helpers/izborServer.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { sampleRun } from "./helpers/sampleSessions.js";
import { ONE_SESSION_HERE, SESSION, until } from "./support.js";

process.env.FORCE_COLOR = "1";
const { createLiveStore, runTerminal } = await import("../src/terminal/main.js");

const PROCESS_EVENTS = [
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
    "SIGBREAK",
    "uncaughtException",
    "unhandledRejection",
    "exit",
] as const;
const listenerCounts = () => PROCESS_EVENTS.map((name) => process.listenerCount(name));

function screenOf(argv: string[]): ScreenFlags {
    const args = readCliArgs(argv, {});
    assert.ok(!("error" in args), JSON.stringify(args));
    if (!("screen" in args)) throw new Error(`${args.command} has no screen flags`);
    return args.screen;
}

const CTRL_C = KEYS["ctrl-c"];
const CTRL_G = KEYS["ctrl-g"];

async function liveApp(t: TestContext) {
    const server = await startIzborServer(t);
    const window = fakeTerminal(t);
    const source = createLiveStore({
        client: createIzborClient({ port: server.port }),
        izbor: "older",
        port: server.port,
        run: async () => ONE_SESSION_HERE,
        platform: hostPlatform(),
        ...hostLive(),
    });
    const setup = {
        port: server.port,
        hooks: () => assert.fail("no hooks command here"),
        plugin: () => assert.fail("no plugin command here"),
    };
    const resizeListeners = window.io.stdout.listenerCount("resize");
    const exit = runTerminal({ screen: screenOf([]), source, setup }, window.io);
    t.after(async () => {
        window.type(CTRL_C);
        await exit;
    });
    await window.shows(`${basename(checkoutOf(PROJECT_DIR, hostPlatform()))} · Briefs update late`);
    await window.shows("izbor-b8 · Idle");
    return { ...window, server, exit, resizeListeners };
}

test("the bell rings once as a fresh wait arrives, not for the wait the window opens on, and never with --no-bell", async (t) => {
    for (const argv of [["fresh-wait"], ["question"], ["question", "--no-bell"]] as const) {
        const window = fakeTerminal(t);
        const run = sampleRun({ scenario: argv[0] });
        const exit = runTerminal({ screen: screenOf(argv.slice(1)), ...run }, window.io);
        await window.shows("Explain how request retries");
        if (argv[0] === "question") {
            run.source.setScenario("fresh-wait");
            await window.shows("Bash: npm test retries");
        }
        window.type(CTRL_C);
        assert.equal(await exit, 0);
        await window.screen();
        assert.equal(window.bells(), argv.length === 1 && argv[0] === "question" ? 1 : 0, argv.join(" "));
    }
});

test("the old console's mouse note, and in VS Code's terminal the tab-title hint, shows whole on the first frame's feedback line", async (t) => {
    const notes: [boolean, Record<string, string>, string, string][] = [
        [true, {}, "Mouse is off: this may be the old console window.", MOUSE_OFF],
        [false, { TERM_PROGRAM: "vscode" }, "In VS Code, set terminal.integrated.tabs.title", VS_CODE_TITLE],
    ];
    const squeezed = (text: string) => text.replace(/\s+/g, "");
    for (const [oldConsole, env, start, note] of notes) {
        const window = fakeTerminal(t);
        const exit = runTerminal({ ...forConsole(screenOf([]), "", oldConsole, env), ...sampleRun() }, window.io);
        await window.shows(start);
        const lines = await window.screen();
        assert.ok(squeezed(lines.join("")).includes(squeezed(note)), lines.join("\n"));
        window.type(CTRL_C);
        assert.equal(await exit, 0, start);
    }
});

async function sampleApp(t: TestContext, columns: number, rows: number) {
    const window = fakeTerminal(t, columns, rows);
    const exit = runTerminal({ screen: screenOf([]), ...sampleRun() }, window.io);
    t.after(async () => {
        window.type(CTRL_C);
        await exit;
    });
    await window.shows("Fix the token refresh bug");
    return window;
}

const SIDE_BRIEF = "Hide · h";

async function framesOfResize(
    window: ReturnType<typeof fakeTerminal>,
    columns: number,
    rows: number,
    settled: (screen: string) => boolean,
) {
    await delay(100);
    const frames = window.record();
    await window.resize(columns, rows);
    await until(async () => settled((await window.screen()).join("\n")));
    await delay(100);
    return frames;
}

test("growing the window past the split moves an open Brief to the side, and no frame shows it twice", async (t) => {
    const window = await sampleApp(t, 100, 30);
    window.type("\t");
    window.type("\r");
    await window.shows("Back · Esc  Fix the token");

    const frames = await framesOfResize(
        window,
        160,
        30,
        (screen) => screen.includes(SIDE_BRIEF) && !screen.includes("Back · Esc"),
    );
    for (const frame of frames)
        assert.ok(
            !(frame.includes("Back · Esc") && frame.includes(SIDE_BRIEF)),
            `a frame shows the Brief twice:\n${frame}`,
        );
    const last = frames.at(-1)!.split("\n");
    assert.match(
        last[1]!,
        /^ {2}\[ Home \] {2}Sessions · 3 {2}Ctrl-O +│ {2}Fix the token refresh bug and add a regression test {2}Hide · h$/,
    );
    assert.match(last[2]!, /│ {2}for expired access tokens\. *$/, "no Status after the heading's last word");
    assert.match(last.at(-1)!, /^ +Help · Ctrl-G$/);
    assert.equal(last.at(-1)!.trimEnd().length, 158);
});

test("shrinking the window below the split shows the side Brief in no frame", async (t) => {
    const window = await sampleApp(t, 160, 30);
    await window.shows(SIDE_BRIEF);

    const frames = await framesOfResize(window, 100, 30, (screen) => /^ {85}Help · Ctrl-G/m.test(screen));
    for (const frame of frames)
        assert.ok(!frame.includes(SIDE_BRIEF), `a frame 100 columns wide shows the side Brief:\n${frame}`);
    const last = frames.at(-1)!.split("\n");
    assert.match(last[3]!, /^ {3}\* Fix the token refresh bug .* Open ›$/);
    assert.match(last.at(-1)!, /^ +Help · Ctrl-G$/);
});

const NO_SIZE = { columns: 0, rows: 0 };

function inkFallsBack(t: TestContext) {
    const { COLUMNS, LINES } = process.env;
    Object.assign(process.env, { COLUMNS: "80", LINES: "24" });
    t.after(() => {
        for (const [name, value] of Object.entries({ COLUMNS, LINES }))
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
    });
}

test("a TTY that reports no size opens on Sessions at Ink's fallback size, 80 × 24", async (t) => {
    inkFallsBack(t);
    const window = fakeTerminal(t, 80, 24);
    Object.assign(window.io.stdout, NO_SIZE);
    const exit = runTerminal({ screen: screenOf([]), ...sampleRun() }, window.io);
    t.after(async () => {
        window.type(CTRL_C);
        await exit;
    });
    await window.shows("Fix the token refresh bug");
    const lines = await window.screen();
    assert.match(lines[0]!, /^\s*Izbor ● up\s*$/);
    assert.match(lines[3]!, /^ {3}\* .*Fix the token refresh bug .* Open ›$/);
    assert.match(lines[23]!, /^ +Help · Ctrl-G$/);
});

test("a resize that reports no size keeps Sessions at Ink's fallback size: no frame shows the too-small screen", async (t) => {
    inkFallsBack(t);
    const window = await sampleApp(t, 100, 30);
    await delay(100);
    const frames = window.record();
    Object.assign(window.io.stdout, NO_SIZE);
    window.io.stdout.emit("resize");
    await until(() => frames.length > 0);
    await delay(100);
    for (const frame of frames)
        assert.ok(frame.includes("Sessions · 3"), `a frame after the resize is not Sessions:\n${frame}`);
    const last = frames.at(-1)!.trimEnd().split("\n");
    assert.equal(last.length, 24);
    assert.match(last[0]!, /^\s*Izbor ● up\s*$/);
    assert.match(last[3]!, /^ {3}\* .*Fix the token refresh bug .* Open ›$/);
    assert.match(last.at(-1)!, /^ +Help · Ctrl-G$/);
});

test("an error nobody caught shows on the feedback line, as an error, and the app keeps running", async (t) => {
    const runner = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    t.after(() => runner.forEach((listener) => process.on("unhandledRejection", listener)));

    const { type, shows, exit } = await liveApp(t);
    void Promise.reject(new Error("the list broke"));
    await shows("Unexpected error: the list broke");
    type(CTRL_G);
    await shows("A click or Enter on a line");
    type(CTRL_C);
    assert.equal(await exit, 0);
    assert.equal(process.listenerCount("unhandledRejection"), 0);
});

test("Ctrl-C quits with 0: every stream ends, and every process handler and stdout resize listener the app and Ink added is gone", async (t) => {
    const before = listenerCounts();
    const { type, shows, server, exit, errors, io, resizeListeners } = await liveApp(t);
    assert.equal(
        process.listenerCount("unhandledRejection"),
        before[PROCESS_EVENTS.indexOf("unhandledRejection")]! + 1,
    );
    assert.ok(io.stdout.listenerCount("resize") > resizeListeners);
    type(KEYS.tab);
    type(KEYS.tab);
    type("\r");
    await shows("Back · Esc  Task unknown");
    await shows("Last change");

    type(CTRL_C);
    assert.equal(await exit, 0);
    assert.deepEqual(listenerCounts(), before);
    assert.equal(io.stdout.listenerCount("resize"), resizeListeners);
    assert.equal(errors(), "");
    const listeners = async () => {
        const answer = (await (await fetch(`${server.base}/sessions`)).json()) as SessionsAnswer;
        return answer.sessions.map(({ sessionId, listeners }) => ({ sessionId, listeners }));
    };
    await until(async () => (await listeners())[0]?.listeners === 0);
    assert.deepEqual(await listeners(), [{ sessionId: SESSION, listeners: 0 }]);
    await delay(50);
});

test("SIGINT, SIGTERM or SIGHUP quits with 0 as Ctrl-C does: nothing sends the signal again to kill the app", async (t) => {
    const resent = t.mock.method(process, "kill", () => true);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const window = fakeTerminal(t);
        const exit = runTerminal({ screen: screenOf([]), ...sampleRun() }, window.io);
        t.after(async () => {
            window.type(CTRL_C);
            await exit;
        });
        await window.shows("Fix the token refresh bug");
        process.emit(signal);
        assert.equal(await exit, 0, signal);
    }
    assert.deepEqual(
        resent.mock.calls.map(({ arguments: args }) => args),
        [],
    );
});

test("the window title says Izbor · needs you while an observed session waits, izbor with none, and izbor after Ctrl-C", async (t) => {
    const window = fakeTerminal(t, 80, 24);
    const exit = runTerminal({ screen: screenOf([]), ...sampleRun() }, window.io);
    t.after(async () => {
        window.type(CTRL_C);
        await exit;
    });
    await window.shows("Sessions · 3");
    assert.equal(window.title(), "Izbor · needs you", "the second sample session waits");
    window.type(CTRL_C);
    assert.equal(await exit, 0);
    await window.screen();
    assert.equal(window.title(), "izbor", "reset as the app quits");

    const live = await liveApp(t);
    assert.equal(live.title(), "izbor", "a live window that observes nothing");
});

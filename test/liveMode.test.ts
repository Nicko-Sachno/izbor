import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import { basename } from "node:path";
import { checkoutOf } from "../src/adapters/agents/claude/setup/projectFiles.js";
import { readCliArgs } from "../src/cli/args.js";
import { PROJECT_DIR } from "../src/config.js";
import { createTerminalController } from "../src/terminal/controller.js";
import { projectFocus } from "../src/terminal/focus.js";
import { createLiveStore, type LiveOptions } from "../src/terminal/main.js";
import { renderTerminal } from "../src/terminal/render.js";
import { hostLive, startIzborServer } from "./helpers/izborServer.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { noAnswer, ONE_SESSION_HERE, OTHER_SESSION, SESSION, until } from "./support.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

chalk.level = 0;

type StoreOptions = Omit<LiveOptions, "hooks" | "plugin">;

function liveWindow(t: TestContext, live: StoreOptions, columns = 80, rows = 24) {
    const frames: string[] = [];
    const frame = () => renderTerminal(app.view, { columns, rows }).lines;
    const app = createTerminalController(createLiveStore(live), {
        ...NO_WRITES,
        columns,
        rows,
        changed: () => frames.push(frame().join("\n")),
    });
    t.after(() => app.dispose());
    return { app, frame, frames, text: () => frame().join("\n") };
}

function liveOn(argv: string[]): StoreOptions {
    const args = readCliArgs(argv, {});
    assert.ok(!("error" in args));
    if (!("port" in args)) throw new Error(`${args.command} has no port`);
    const client = { ...createIzborClient({ port: args.port }), getIzbor: async () => ({ up: "older" as const }) };
    return { client, izbor: "older", port: args.port, run: noAnswer, platform: hostPlatform(), ...hostLive() };
}

test("a live window's top line holds Izbor ● up alone at its right end, on the default port and on --port 5000: no address, no count", (t) => {
    const { app, frame } = liveWindow(t, liveOn([]));
    assert.match(frame()[0]!, /^\s*Izbor ● up\s*$/);
    assert.deepEqual(app.view.izbor, { state: "up", address: "127.0.0.1:4319" });
    const { app: other, frame: otherFrame } = liveWindow(t, liveOn(["--port", "5000"]));
    assert.match(otherFrame()[0]!, /^\s*Izbor ● up\s*$/);
    assert.deepEqual(other.view.izbor, { state: "up", address: "127.0.0.1:5000" });
});

async function windowOnIzbor(t: TestContext) {
    const server = await startIzborServer(t);
    const client = createIzborClient({ port: server.port });
    assert.deepEqual(await client.getIzbor(), { up: server.info });
    const window = liveWindow(
        t,
        {
            client,
            izbor: server.info,
            port: server.port,
            run: async () => ONE_SESSION_HERE,
            platform: hostPlatform(),
            ...hostLive(),
        },
        160,
        40,
    );
    await until(() => window.app.view.list.state === "listed");
    return { ...window, server };
}

const press = (app: ReturnType<typeof createTerminalController>, name: string) => app.keypress(undefined, { name });

test("a live window lists the running session under its project line; Tab reaches it, Enter observes it and opens its Brief", async (t) => {
    const { app, frame, text, frames, server } = await windowOnIzbor(t);
    const home = frame();
    const lines = home.map((line) => line.trim());
    const project = lines.findIndex((line) =>
        line.startsWith(`${basename(checkoutOf(PROJECT_DIR, hostPlatform()))} · Briefs update late `),
    );
    assert.ok(project >= 0, text());
    assert.ok(lines[project]!.endsWith(" Add hooks ›"), lines[project]);
    assert.equal(home[project]!.trimEnd().length, 2 + 156);
    assert.equal(lines[project + 1], "izbor-b8 · Idle");
    assert.ok(!text().includes(SESSION.slice(0, 8)), "Home shows no id");
    assert.equal(app.view.sessions.length, 0);

    press(app, "tab");
    assert.equal(app.view.focused, projectFocus(checkoutOf(PROJECT_DIR, hostPlatform())));
    press(app, "tab");
    assert.equal(app.view.focused, SESSION);
    const before = frames.length;
    press(app, "return");
    assert.equal(app.view.sessions[0]?.id, SESSION, "the row is in the view when Enter returns");
    assert.equal(app.view.feedback, "Observing izbor-b8.");
    await until(() => app.view.sessions[0]?.connection.state === "live");
    const after = frames.slice(before);
    const catchingUp = after.findIndex((frame) => frame.includes("Catching up…"));
    const brief = after.findIndex((frame) => frame.includes("Last change") && /Task unknown +Hide · h/.test(frame));
    assert.ok(catchingUp !== -1, after.join("\n\n"));
    assert.ok(brief > catchingUp, after.at(-1));
    assert.ok(server.requests.some(({ path }) => path === `/sessions/${SESSION}/events`));
});

test("a live window observes a UUID the list lacks at once, then it goes live", async (t) => {
    const { app } = await windowOnIzbor(t);
    app.observe(OTHER_SESSION);
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [OTHER_SESSION],
        "the row is in the view when observe returns",
    );
    await until(() => app.view.sessions[0]?.connection.state === "live");
    assert.equal(app.view.feedback, `Observing ${OTHER_SESSION.slice(0, 8)}.`);
});

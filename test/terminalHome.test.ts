import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import chalk from "chalk";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import { PROJECT_DIR } from "../src/config.js";
import { createTerminalController } from "../src/terminal/controller.js";
import { createLiveStore } from "../src/terminal/main.js";
import type { RunningSession } from "../src/terminal/model.js";
import { renderTerminal } from "../src/terminal/render.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { hostLive } from "./helpers/izborServer.js";
import { agentsList, ONE_SESSION_HERE, OTHER_SESSION, SESSION } from "./support.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

chalk.level = 0;

const running = (id: string, checkout: string): RunningSession => ({
    id,
    name: id,
    checkout,
    hooks: true,
    acting: false,
});

function homeFrame(t: TestContext, checkouts: [string, string], home?: string): string {
    const sessions = [running(SESSION, checkouts[0]), running(OTHER_SESSION, checkouts[1])];
    const store = createFakeStore({ list: { state: "listed", sessions, at: "2026-10-09T12:00:00.000Z" } });
    const app = createTerminalController(store, {
        ...NO_WRITES,
        columns: 100,
        rows: 24,
        ...(home === undefined ? {} : { home }),
        changed() {},
    });
    t.after(() => app.dispose());
    return renderTerminal(app.view, { columns: 100, rows: 24 }, false).lines.join("\n");
}

test("Home names two projects that share a folder name by their folders, ~ for your home folder", (t) => {
    const frame = homeFrame(t, [join(homedir(), "a", "app"), join(homedir(), "b", "app")]);
    assert.ok(frame.includes(join("~", "a", "app")) && frame.includes(join("~", "b", "app")), frame);
});

test("a window given a home folder names Home's projects from it, not from the machine's", (t) => {
    const frame = homeFrame(t, ["/Users/me/a/app", "/Users/me/b/app"], "/Users/me");
    assert.ok(frame.includes("~/a/app") && frame.includes("~/b/app"), frame);
});

test(
    "a home folder written with \\ names Home's projects under it with ~",
    { skip: process.platform !== "win32" && "Windows only: a path there is written with \\" },
    (t) => {
        const frame = homeFrame(t, ["C:\\Users\\me\\a\\app", "C:\\Users\\me\\b\\app"], "C:\\Users\\me");
        assert.ok(frame.includes("~\\a\\app") && frame.includes("~\\b\\app"), frame);
    },
);

async function liveList(t: TestContext, dataDir: string, output: string) {
    const before = process.env.IZBOR_DATA_DIR;
    process.env.IZBOR_DATA_DIR = dataDir;
    t.after(() => {
        if (before === undefined) delete process.env.IZBOR_DATA_DIR;
        else process.env.IZBOR_DATA_DIR = before;
    });
    const client = { ...createIzborClient({ port: 1 }), getIzbor: async () => ({ up: "older" as const }) };
    const store = createLiveStore({
        client,
        izbor: "older",
        port: 1,
        run: async () => output,
        platform: hostPlatform(),
        ...hostLive(),
    });
    t.after(() => store.dispose());
    return store.refreshSessions();
}

test("the live list leaves out the summarizer's sessions in the data folder IZBOR_DATA_DIR names", async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const list = await liveList(
        t,
        dataDir,
        agentsList([
            { sessionId: OTHER_SESSION, cwd: join(dataDir, "summarizer"), status: "busy" },
            { sessionId: SESSION, cwd: PROJECT_DIR, status: "idle" },
        ]),
    );
    assert.deepEqual(list.state === "listed" ? list.sessions.map(({ id }) => id) : list, [SESSION]);
});

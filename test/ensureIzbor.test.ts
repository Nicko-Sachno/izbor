import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { closeSync, existsSync, realpathSync, statSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import stringWidth from "string-width";
import type { IzborClient } from "../src/adapters/izbor/client.js";
import { createSummarizer } from "../src/adapters/summarizer/summarizer.js";
import type { Spawned } from "../src/core/ports.js";
import { izborLog } from "../src/adapters/files/izborLogFile.js";
import { whichIzbor } from "../src/cli/commands/checkout.js";
import {
    type Ensured,
    ensureIzbor,
    forConsole,
    MOUSE_OFF,
    type OpenArgs,
    VS_CODE_TITLE,
} from "../src/cli/commands/open.js";
import { startService } from "../src/service.js";
import {
    npmLinkFolder,
    openIzbor,
    IZBOR_BIN,
    izborBinThroughLink,
    izborPid,
    stopIzborAfter,
    upOn,
} from "./helpers/bin.js";
import { skipOnWindows } from "./helpers/fakeCommand.js";
import { fakePlatform, hostPlatform } from "./helpers/fakePlatform.js";
import { fakeProvider } from "./helpers/fakeProvider.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { SKIP_WITHOUT_PTY } from "./helpers/pty.js";
import { freePort, isolatedIzborEnv, portAnswering, until } from "./support.js";
import { FOREIGN, INFO, type IzborAnswer, inTurn, NOT_RUNNING, PORT, runsUntil } from "./helpers/izborInfo.js";

const OLDER_NOTE = `An older Izbor runs on 127.0.0.1:${PORT}.`;
const STOPPING = { away: "stopping" } as const;
const LOCK_LINE = `Another Izbor is using this data folder (${INFO.dataDir}). Izbor did not start.`;
const FEEDBACK_CELLS = 61;

const OPEN: OpenArgs = {
    command: "open",
    port: PORT,
    screen: {
        color: true,
        mouse: true,
        bell: true,
        oldBuild: false,
    },
};

async function ensure(
    answer: IzborAnswer[] | ((at: number) => IzborAnswer),
    {
        spawns = [],
        alive = () => true,
        onPath,
        builtAt,
    }: { spawns?: Spawned[]; alive?: (pid: number, at: number) => boolean; onPath?: string; builtAt?: number } = {},
) {
    const answerAt = Array.isArray(answer) ? inTurn(answer) : answer;
    let at = 0;
    const calls: string[] = [];
    const spawnedAt: number[] = [];
    const call = (name: string) => async () => {
        calls.push(name);
        return NOT_RUNNING;
    };
    const client: IzborClient = {
        async getIzbor() {
            calls.push("getIzbor");
            return answerAt(at);
        },
        getSessions: call("getSessions"),
        readStream: call("readStream"),
        sendAnswer: call("sendAnswer"),
        sendPrompt: call("sendPrompt"),
        async requestStop() {
            calls.push("requestStop");
            return false;
        },
    };
    const platform = fakePlatform({ isAlive: (pid) => alive(pid, at) });
    const result = await ensureIzbor(OPEN, {
        client,
        platform: {
            isAlive: platform.isAlive,
            endIzbor(pid) {
                calls.push(`terminate ${pid}`);
                platform.endIzbor(pid);
            },
        },
        which() {
            calls.push("which");
            return onPath;
        },
        async wait(ms) {
            calls.push(`wait ${ms}`);
            at += ms;
        },
        nowMs: () => at,
        async startInBackground() {
            calls.push("spawnServe");
            spawnedAt.push(at);
            return spawns.shift() ?? { error: "the test gave no more spawns" };
        },
        lastLogLine: () => LOCK_LINE,
        builtAt: () => builtAt,
    });
    return { result, calls, spawnedAt, endedAt: at };
}

test("up: reuse, with no note; the probe and the PATH check are the only calls", async () => {
    assert.deepEqual(await ensure([{ up: INFO }]), {
        result: { info: INFO, feedback: "", notes: [] },
        calls: ["getIzbor", "which"],
        spawnedAt: [],
        endedAt: 0,
    });
});

test("an older Izbor: reuse, with a note that it is older", async () => {
    const { result, calls } = await ensure([{ up: "older" }]);
    assert.deepEqual(result, { info: "older", feedback: OLDER_NOTE, notes: [OLDER_NOTE] });
    assert.deepEqual(calls, ["getIzbor", "which"]);
});

test("stopping, then up: it waits 100 ms between probes, then reuses", async () => {
    const { result, calls } = await ensure([STOPPING, STOPPING, { up: INFO }]);
    assert.deepEqual(result, { info: INFO, feedback: "", notes: [] });
    assert.deepEqual(calls, ["getIzbor", "wait 100", "getIzbor", "wait 100", "getIzbor", "which"]);
});

test("stopping for 6 s: one line says so, and nothing else is asked", async () => {
    const { result, calls, endedAt } = await ensure([STOPPING]);

    assert.deepEqual(result, { error: `Izbor on ${PORT} is still stopping after 6 s. Izbor did not start.` });
    assert.equal(endedAt, 6000);
    const waits = calls.filter((name) => name.startsWith("wait ")).length;
    assert.equal(calls.filter((name) => name === "getIzbor").length, waits + 1);
    assert.equal(calls.at(-1), "getIzbor");
    assert.ok(!calls.includes("which") && !calls.includes("spawnServe"));
});

test("another program on the port: the 'not as Izbor' line and where to look; getIzbor is the only call", async () => {
    const { result, calls } = await ensure([{ foreign: FOREIGN }]);
    assert.deepEqual(result, {
        error: `Port ${PORT} answers, but not as Izbor. Izbor did not start.\n${FOREIGN}; see lsof -nP -iTCP:${PORT} (Windows: netstat -ano | findstr :${PORT})`,
    });
    assert.deepEqual(calls, ["getIzbor"]);
});

test("a Izbor that does not answer: the 'does not answer' line; getIzbor is the only call", async () => {
    const { result, calls } = await ensure([{ away: "not answering" }]);
    assert.deepEqual(result, {
        error: `Izbor on ${PORT} does not answer (hung, or paused?). Izbor did not start.`,
    });
    assert.deepEqual(calls, ["getIzbor"]);
});

test("nothing on the port: one start, and the Izbor it started answers: started, with the start note whole and short", async () => {
    const mine = { ...INFO, pid: 99999 };
    const { result, calls } = await ensure((at) => (at < 300 ? NOT_RUNNING : { up: mine }), {
        spawns: [{ pid: 99999 }],
    });

    assert.deepEqual(result, {
        info: mine,
        feedback: "Started Izbor in the background · pid 99999",
        notes: [
            `Started Izbor in the background · pid 99999 · 127.0.0.1:${PORT} · log ${join(INFO.dataDir, "izbor.log")}`,
            "It keeps running when you close this window. Stop it with: izbor stop",
        ],
    });
    assert.deepEqual(calls, [
        "getIzbor",
        "spawnServe",
        ...["wait 100", "getIzbor", "wait 100", "getIzbor", "wait 100", "getIzbor"],
        "which",
    ]);
    assert.ok(stringWidth((result as { feedback: string }).feedback) <= FEEDBACK_CELLS);
});

test("the start note comes first, and the other notes follow it, on the feedback line and after you quit", async () => {
    const elsewhere = "/opt/homebrew/Cellar/other-program/1.2.0/bin/other-program";
    const { result } = await ensure([NOT_RUNNING, { up: { ...INFO, pid: 51234 } }], {
        spawns: [{ pid: 51234 }],
        onPath: elsewhere,
    });
    const pathNote = `izbor on PATH is not this checkout: ${elsewhere}`;

    assert.equal(
        (result as { feedback: string }).feedback,
        `Started Izbor in the background · pid 51234 · ${pathNote}`,
    );
    assert.deepEqual((result as { notes: string[] }).notes.slice(1), [
        "It keeps running when you close this window. Stop it with: izbor stop",
        pathNote,
    ]);
});

test("a started Izbor that is gone, as one that met the lock: probing goes on, one start a second at most, none while the last runs or the port says stopping", async () => {
    const answer = (at: number) =>
        at >= 3000 ? { up: { ...INFO, pid: 103 } } : at >= 900 && at < 1300 ? STOPPING : NOT_RUNNING;
    const { result, spawnedAt } = await ensure(answer, {
        spawns: [{ pid: 101 }, { pid: 102 }, { pid: 103 }],
        alive: runsUntil({ 101: 400, 102: 2600 }),
    });

    assert.deepEqual(spawnedAt, [0, 1300, 2600]);
    assert.match((result as Ensured).feedback, /^Started Izbor in the background/);
});

test("a started Izbor that is gone, then a Izbor with another pid answers: reuse, with no start note", async () => {
    const { result, spawnedAt } = await ensure((at) => (at < 400 ? NOT_RUNNING : { up: INFO }), {
        spawns: [{ pid: 101 }],
        alive: runsUntil({ 101: 300 }),
    });

    assert.deepEqual(result, { info: INFO, feedback: "", notes: [] });
    assert.deepEqual(spawnedAt, [0]);
});

test("a started Izbor that is gone, then another program: the 'not as Izbor' line and no second start", async () => {
    const { result, calls, endedAt } = await ensure((at) => (at < 300 ? NOT_RUNNING : { foreign: FOREIGN }), {
        spawns: [{ pid: 101 }, { pid: 102 }],
        alive: runsUntil({ 101: 200 }),
    });

    assert.equal(endedAt, 300);
    assert.match((result as { error: string }).error, /^Port 4400 answers, but not as Izbor\. Izbor did not start\./);
    assert.equal(calls.filter((name) => name === "spawnServe").length, 1);
    assert.ok(!calls.some((name) => name.startsWith("terminate")), calls.join());
});

test("a started Izbor still runs when the port stops answering: it is terminated, then the 'does not answer' line", async () => {
    const { result, calls } = await ensure((at) => (at < 300 ? NOT_RUNNING : { away: "not answering" }), {
        spawns: [{ pid: 101 }],
    });

    assert.match((result as { error: string }).error, /^Izbor on 4400 does not answer/);
    assert.deepEqual(calls.slice(-2), ["getIzbor", "terminate 101"]);
});

test("spawnServe fails: its error at once, with no probe after it", async () => {
    const { result, calls } = await ensure([NOT_RUNNING], { spawns: [{ error: "spawn node ENOENT" }] });

    assert.deepEqual(result, { error: "spawn node ENOENT" });
    assert.deepEqual(calls, ["getIzbor", "spawnServe"]);
});

test("no Izbor after 8 s: the Izbor log's last line, once a started Izbor that still runs is terminated", async () => {
    const running = await ensure([NOT_RUNNING], { spawns: [{ pid: 101 }] });
    assert.deepEqual(running.result, { error: LOCK_LINE });
    assert.deepEqual(running.spawnedAt, [0]);
    assert.equal(running.calls.at(-1), "terminate 101");
    assert.ok(running.endedAt >= 8000 && running.endedAt < 8100, `${running.endedAt}`);

    const pids = Array.from({ length: 20 }, (_, index) => ({ pid: 200 + index }));
    const gone = await ensure([NOT_RUNNING], { spawns: pids, alive: () => false });
    assert.deepEqual(gone.result, { error: LOCK_LINE });
    assert.deepEqual(gone.spawnedAt, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    assert.ok(!gone.calls.some((name) => name.startsWith("terminate")));
});

test("stopping, then another answer: that answer's rule; nothing on the port at last: a start", async () => {
    const foreign = await ensure([STOPPING, { foreign: FOREIGN }]);
    assert.deepEqual(foreign.calls, ["getIzbor", "wait 100", "getIzbor"]);
    assert.match((foreign.result as { error: string }).error, /^Port 4400 answers, but not as Izbor\./);

    const gone = await ensure([STOPPING, NOT_RUNNING, { up: { ...INFO, pid: 101 } }], { spawns: [{ pid: 101 }] });
    assert.deepEqual(gone.calls.slice(0, 4), ["getIzbor", "wait 100", "getIzbor", "spawnServe"]);
    assert.match((gone.result as Ensured).feedback, /^Started Izbor in the background/);
});

test("another izbor first on PATH: a note says where it points; this checkout's bin, or none, gives no note", async () => {
    const elsewhere = "/opt/homebrew/Cellar/other-program/1.2.0/bin/other-program";
    const note = `izbor on PATH is not this checkout: ${elsewhere}`;
    assert.deepEqual((await ensure([{ up: INFO }], { onPath: elsewhere })).result, {
        info: INFO,
        feedback: note,
        notes: [note],
    });
    assert.deepEqual((await ensure([{ up: "older" }], { onPath: elsewhere })).result, {
        info: "older",
        feedback: `${OLDER_NOTE} · ${note}`,
        notes: [OLDER_NOTE, note],
    });

    for (const onPath of [IZBOR_BIN, await izborBinThroughLink(), undefined])
        assert.deepEqual((await ensure([{ up: INFO }], { onPath })).result, {
            info: INFO,
            feedback: "",
            notes: [],
        });
});

test("a Izbor that started before your last build: the stale-build note on the feedback line and after you quit; started after, no note", async () => {
    const stale = "Izbor started before your last build: izbor stop, then izbor";
    const startedAt = Date.parse(INFO.startedAt);
    assert.deepEqual((await ensure([{ up: INFO }], { builtAt: startedAt + 1 })).result, {
        info: INFO,
        feedback: stale,
        notes: [stale],
    });
    for (const builtAt of [startedAt, startedAt - 60_000, undefined])
        assert.deepEqual(
            (await ensure([{ up: INFO }], { builtAt })).result,
            { info: INFO, feedback: "", notes: [] },
            String(builtAt),
        );
    assert.deepEqual(((await ensure([{ up: "older" }], { builtAt: Date.now() })).result as Ensured).notes, [
        OLDER_NOTE,
    ]);

    const elsewhere = "/opt/homebrew/Cellar/other-program/1.2.0/bin/other-program";
    const { result } = await ensure([{ up: INFO }], { builtAt: startedAt + 1, onPath: elsewhere });
    assert.deepEqual((result as Ensured).notes, [stale, `izbor on PATH is not this checkout: ${elsewhere}`]);
    assert.ok(stringWidth(stale) <= FEEDBACK_CELLS);
});

test("the Izbor log's last line: only what came since izbor first opened it, without Node's closing version line", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
    const path = join(dataDir, "izbor.log");
    await writeFile(path, "a line of an earlier run\n");
    const log = izborLog(path);

    assert.equal(log.lastLine(), `Izbor wrote nothing to ${path}`);
    closeSync(log.open());
    assert.equal(log.lastLine(), `Izbor wrote nothing to ${path}`);

    await appendFile(path, `${LOCK_LINE}\n\nNode.js v24.3.0\n\n`);
    assert.equal(log.lastLine(), LOCK_LINE);
    closeSync(log.open());
    assert.equal(log.lastLine(), LOCK_LINE);
    assert.equal(await readFile(path, "utf8"), `a line of an earlier run\n${LOCK_LINE}\n\nNode.js v24.3.0\n\n`);
});

test("the Izbor log: past 5 MB it becomes izbor.log.old when izbor opens it; at 5 MB it stays", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
    const path = join(dataDir, "izbor.log");
    await writeFile(path, "");
    await truncate(path, 5 * 1024 * 1024);
    closeSync(izborLog(path).open());
    assert.equal(statSync(path).size, 5 * 1024 * 1024);
    assert.ok(!existsSync(`${path}.old`));

    await appendFile(path, "x\n");
    closeSync(izborLog(path).open());
    assert.equal(statSync(`${path}.old`).size, 5 * 1024 * 1024 + 2);
    assert.equal(statSync(path).size, 0);
});

test(
    "whichIzbor finds the first izbor on PATH that may be run, as a real path, as the shell does",
    skipOnWindows("Windows has no execute bit; whichIzbor reads izbor.cmd there"),
    async () => {
        const root = await mkdtemp(join(tmpdir(), "izbor-path-"));
        const dir = (name: string) => join(root, name);
        for (const name of ["notRun", "folder", "linked", "later", "real"]) await mkdir(dir(name));
        await writeFile(join(dir("notRun"), "izbor"), "#!/bin/sh\n");
        await mkdir(join(dir("folder"), "izbor"));
        await writeFile(join(dir("real"), "izbor-cli"), "#!/bin/sh\n");
        await chmod(join(dir("real"), "izbor-cli"), 0o755);
        await symlink(join(dir("real"), "izbor-cli"), join(dir("linked"), "izbor"));
        await writeFile(join(dir("later"), "izbor"), "#!/bin/sh\n");
        await chmod(join(dir("later"), "izbor"), 0o755);

        const path = ["notRun", "folder", "linked", "later"].map(dir).join(delimiter);
        assert.equal(whichIzbor(path), realpathSync(join(dir("real"), "izbor-cli")));
        assert.equal(
            whichIzbor([dir("notRun"), dir("later")].join(delimiter)),
            realpathSync(join(dir("later"), "izbor")),
        );
        assert.equal(whichIzbor(dir("notRun")), undefined);
        assert.equal(whichIzbor(""), undefined);
    },
);

test("whichIzbor reads npm's izbor.cmd first in a PATH folder: its .js target, through npm link's junction, as a real path", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "izbor-checkout-"));
    await mkdir(join(checkout, "bin"));
    await writeFile(join(checkout, "bin", "izbor.js"), "#!/usr/bin/env node\n");
    const npm = await npmLinkFolder(checkout);
    await writeFile(join(npm, "izbor"), "#!/bin/sh\n");
    await chmod(join(npm, "izbor"), 0o755);

    assert.equal(whichIzbor(npm), realpathSync.native(join(checkout, "bin", "izbor.js")));
});

test("a izbor.cmd with no .js target: whichIzbor looks for izbor in that folder as before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-path-"));
    await writeFile(join(dir, "izbor.cmd"), "@ECHO off\r\nother-program.exe %*\r\n");
    assert.equal(whichIzbor(dir), undefined);
    await writeFile(join(dir, "izbor"), "#!/bin/sh\n");
    await chmod(join(dir, "izbor"), 0o755);
    assert.equal(whichIzbor(dir), realpathSync(join(dir, "izbor")));
});

test("a console that drops mouse clicks opens with the mouse off and says so on the feedback line, after what izbor found; --no-mouse, or a console that keeps clicks, changes nothing", () => {
    const screen = { ...OPEN.screen, mouse: true };
    assert.deepEqual(forConsole(screen, "", true, {}), { screen: { ...screen, mouse: false }, feedback: MOUSE_OFF });
    assert.deepEqual(forConsole(screen, "An older Izbor runs on 127.0.0.1:4319.", true, {}), {
        screen: { ...screen, mouse: false },
        feedback: `An older Izbor runs on 127.0.0.1:4319. · ${MOUSE_OFF}`,
    });
    assert.deepEqual(forConsole(screen, "", false, {}), { screen, feedback: "" });
    const noMouse = { ...screen, mouse: false };
    assert.deepEqual(forConsole(noMouse, "", true, {}), { screen: noMouse, feedback: "" });
});

test("in VS Code's terminal the first feedback line adds, once, how to see in the tab when a session needs you; elsewhere nothing", () => {
    const screen = { ...OPEN.screen, mouse: true };
    const vscode = { TERM_PROGRAM: "vscode" };
    assert.match(VS_CODE_TITLE, /terminal\.integrated\.tabs\.title to \$\{sequence\}/);
    assert.deepEqual(forConsole(screen, "", false, vscode), { screen, feedback: VS_CODE_TITLE });
    assert.deepEqual(forConsole(screen, "An older Izbor runs on 127.0.0.1:4319.", false, vscode), {
        screen,
        feedback: `An older Izbor runs on 127.0.0.1:4319. · ${VS_CODE_TITLE}`,
    });
    for (const env of [{}, { TERM_PROGRAM: "Apple_Terminal" }, { WT_SESSION: "1" }])
        assert.deepEqual(forConsole(screen, "", false, env), { screen, feedback: "" }, JSON.stringify(env));
});

const run = promisify(execFile);

const SHORT_NOTE = /Started Izbor in the background · pid (\d+)/;
const STOP_LINE = "It keeps running when you close this window. Stop it with: izbor stop";
const START_MS = 15_000;

test(
    "nothing on the port: izbor starts Izbor by a double fork; the start note shows short, then whole after Ctrl-C; Izbor outlives the app, and a second izbor reuses it",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const port = await freePort();
        stopIzborAfter(t, port);
        const dataDir = join(await mkdtemp(join(tmpdir(), "izbor-data-")), "not-yet");
        const log = join(dataDir, "izbor.log");
        const izbor = await openIzbor(t, port, { env: { IZBOR_DATA_DIR: dataDir } });

        await izbor.until("the app opens on the Izbor it started", () => upOn(port).test(izbor.frame()[0]!), START_MS);
        const pid = await izborPid(port);
        assert.ok(pid !== undefined);
        assert.equal(izbor.screen().match(SHORT_NOTE)?.[1], String(pid), izbor.screen());
        assert.equal((await run("ps", ["-o", "ppid=", "-p", String(pid)])).stdout.trim(), "1");

        assert.equal(await izbor.quit(), 0);
        const rows = izbor.frame().join("");
        assert.ok(
            rows.includes(`Started Izbor in the background · pid ${pid} · 127.0.0.1:${port} · log ${log}`),
            izbor.screen(),
        );
        assert.ok(rows.includes(STOP_LINE), izbor.screen());
        assert.equal(await izborPid(port), pid);
        await until(async () => (await readFile(log, "utf8")).includes(`  data:  ${dataDir}\n`), {
            what: "the start lines",
            ms: 5000,
        });
        assert.match(await readFile(log, "utf8"), /^izbor watches no session yet\. Tune in to one by its id:\n/);

        const second = await openIzbor(t, port, { env: { IZBOR_DATA_DIR: dataDir } });
        await second.until(
            "the second app opens on the same Izbor",
            () => upOn(port).test(second.frame()[0]!),
            START_MS,
        );
        assert.doesNotMatch(second.screen(), /Started Izbor/);
        assert.equal(await second.quit(), 0);
        assert.doesNotMatch(second.screen(), /Started Izbor/);
        assert.equal(await izborPid(port), pid);
    },
);

test(
    "two izbor at once on one data folder: one Izbor answers, exactly one window says it started it, and the Izbor log holds the loser's line",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const port = await freePort();
        stopIzborAfter(t, port);
        const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
        const windows = await Promise.all([
            openIzbor(t, port, { env: { IZBOR_DATA_DIR: dataDir } }),
            openIzbor(t, port, { env: { IZBOR_DATA_DIR: dataDir } }),
        ]);
        await Promise.all(
            windows.map((window) =>
                window.until("each app opens on Izbor", () => upOn(port).test(window.frame()[0]!), START_MS),
            ),
        );

        const pid = await izborPid(port);
        assert.ok(pid !== undefined);
        const notes = windows.map((window) => window.screen().match(SHORT_NOTE)?.[1]);
        assert.deepEqual(notes.filter(Boolean), [String(pid)], windows.map((window) => window.screen()).join("\n"));

        const log = join(dataDir, "izbor.log");
        const lost = new RegExp(
            `Another Izbor is using this data folder \\(${dataDir}\\)\\. Izbor did not start\\.|` +
                `Izbor already runs in the background \\(pid ${pid}\\)\\. Run izbor stop first\\.`,
        );
        await until(async () => lost.test(await readFile(log, "utf8")), { what: "the loser's line", ms: 10_000 });
        for (const window of windows) assert.equal(await window.quit(), 0);
    },
);

test(
    "a held data folder: izbor starts Izbor again, at most once a second, until 8 s pass; then exit 1 with the lock line",
    { skip: SKIP_WITHOUT_PTY, timeout: 30_000 },
    async (t) => {
        const { dataDir, env } = await isolatedIzborEnv();
        const platform = hostPlatform();
        const holder = await startService({
            port: 0,
            dataDir,
            userDir: join(dataDir, "user"),
            providers: { fake: fakeProvider() },
            platform,
            log: () => {},
            summarize: createSummarizer({
                dir: join(dataDir, "summarizer"),
                command: env.IZBOR_SUMMARIZER_COMMAND,
                platform,
                env: process.env,
            }),
        });
        t.after(() => holder.stop());
        const port = await freePort();
        const lockLine = `Another Izbor is using this data folder (${dataDir}). Izbor did not start.`;
        const log = join(dataDir, "izbor.log");

        const izbor = await openIzbor(t, port, { env });
        await until(() => existsSync(log), { what: "the first start opens the Izbor log", ms: 15_000 });
        const started = Date.now();
        await izbor.until("the app exits after its startup deadline", () => izbor.exited() !== undefined, 15_000);
        assert.equal(izbor.exited()!.code, 1);
        const took = Date.now() - started;

        assert.match(izbor.screen(), /Another Izbor is using this data folder/);
        assert.ok(took >= 7500 && took <= 12_000, `izbor gave up after ${took} ms`);
        const starts = (await readFile(log, "utf8")).split(lockLine).length - 1;
        assert.ok(starts >= 2 && starts <= 9, `${starts} lock lines`);
    },
);

test(
    "a web server on the port: izbor says it answers, but not as Izbor, and where to look; exit 1, and nothing starts",
    { skip: SKIP_WITHOUT_PTY },
    async (t) => {
        const port = await portAnswering(t, (_, response) =>
            response.writeHead(200, { "content-type": "text/html" }).end("<html></html>"),
        );
        const { dataDir, env } = await isolatedIzborEnv();
        const izbor = await openIzbor(t, port, { env });
        await izbor.until("the app exits for a foreign service", () => izbor.exited() !== undefined);
        assert.equal(izbor.exited()!.code, 1);
        assert.ok(
            izbor.frame().join("").includes(`Port ${port} answers, but not as Izbor. Izbor did not start.`),
            izbor.screen(),
        );
        assert.match(izbor.screen(), /GET \/izbor answered 200 OK, not JSON/);
        assert.ok(izbor.screen().includes(`lsof -nP -iTCP:${port}`), izbor.screen());
        assert.deepEqual(await readdir(dataDir), []);
    },
);

test(
    "a server that takes the connection and never answers: the 'does not answer' line after about 3 s; exit 1",
    { skip: SKIP_WITHOUT_PTY },
    async (t) => {
        let requestedAt: number | undefined;
        const port = await portAnswering(t, () => (requestedAt ??= performance.now()));
        const launchedAt = performance.now();
        const izbor = await openIzbor(t, port);
        await izbor.until("the probe reaches the server", () => requestedAt !== undefined, START_MS);
        await izbor.until("the app exits after its connection timeout", () => izbor.exited() !== undefined, 5_000);
        assert.equal(izbor.exited()!.code, 1);
        const exitedAt = performance.now();
        assert.ok(
            izbor
                .frame()
                .join("")
                .includes(`Izbor on ${port} does not answer (hung, or paused?). Izbor did not start.`),
            izbor.screen(),
        );
        assert.ok(exitedAt - launchedAt >= 3000, "the request is not abandoned before its 3 s timeout");
        assert.ok(exitedAt - requestedAt! < 5000, `the request waited ${exitedAt - requestedAt!} ms`);
    },
);

test(
    "an older Izbor: its note shows on the first frame's feedback line, and on stdout after Ctrl-C",
    { skip: SKIP_WITHOUT_PTY, timeout: 20000 },
    async (t) => {
        const older = await portAnswering(t, (request, response) =>
            request.url === "/sessions"
                ? response.writeHead(200, { "content-type": "application/json" }).end('{"sessions":[]}')
                : response
                      .writeHead(404, { "content-type": "application/json" })
                      .end('{"error":"not_found","message":"no such route"}'),
        );
        const note = `An older Izbor runs on 127.0.0.1:${older}.`;
        const izbor = await openIzbor(t, older);

        await izbor.until("the app opens on the older Izbor", () => upOn(older).test(izbor.frame()[0]!));
        assert.ok(izbor.screen().includes(note), izbor.screen());
        assert.equal(await izbor.quit(), 0);
        assert.ok(izbor.screen().includes(`original shell prompt$ ${note}`), izbor.screen());
    },
);

test(
    "another izbor first on PATH: a note says where it points, on the first frame and on stdout after Ctrl-C",
    { skip: SKIP_WITHOUT_PTY, timeout: 20000 },
    async (t) => {
        const server = await startIzborServer(t);
        const other = await mkdtemp(join(tmpdir(), "izbor-other-"));
        await writeFile(join(other, "izbor"), "#!/bin/sh\n");
        await chmod(join(other, "izbor"), 0o755);
        const note = `izbor on PATH is not this checkout: ${realpathSync(join(other, "izbor"))}`;
        const izbor = await openIzbor(t, server.port, { first: other });

        await izbor.until("the app opens on Izbor", () => upOn(server.port).test(izbor.frame()[0]!));
        const squeezed = (text: string) => text.replace(/\s+/g, "");
        assert.ok(squeezed(izbor.screen()).includes(squeezed(note)), izbor.screen());
        assert.equal(await izbor.quit(), 0);
        assert.ok(izbor.frame().join("").includes(note), izbor.screen());
    },
);

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IzborClient } from "../src/adapters/izbor/client.js";
import { runStatus, type StatusArgs } from "../src/cli/commands/status.js";
import { runStop, type StopArgs } from "../src/cli/commands/stop.js";
import {
    npmLinkFolder,
    openIzbor,
    IZBOR_BIN,
    izborBinThroughLink,
    izborPid,
    runIzborBin,
    startServe,
} from "./helpers/bin.js";
import { pathFirst, skipOnWindows, withPath } from "./helpers/fakeCommand.js";
import { fakePlatform } from "./helpers/fakePlatform.js";
import { SKIP_WITHOUT_PTY } from "./helpers/pty.js";
import { PROJECT_DIR } from "../src/config.js";
import { fakeClaude, freePort, isolatedIzborEnv, isRunning, ONE_SESSION_HERE, until } from "./support.js";
import { KEYS } from "./helpers/keys.js";
import { FOREIGN, INFO, type IzborAnswer, inTurn, NOT_RUNNING, PORT, runsUntil } from "./helpers/izborInfo.js";

const STARTED_AT = Date.parse(INFO.startedAt);

type SessionsAnswer = Awaited<ReturnType<IzborClient["getSessions"]>>;

const NOBODY: SessionsAnswer = { sessions: [] };
const A = "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff";
const B = "13c81eb6-5d7e-4c11-8a90-2b6f0e4d3c71";
const C = "9f3c1a2b-5d7e-4c11-8a90-2b6f0e4d3c71";
const STALE = "Izbor started before your last build: izbor stop, then izbor";
const DATA_FOLDER = join("~", "izbor", ".izbor");

const KEY = "k3y";

async function stop(
    izbor: IzborAnswer[],
    {
        yes,
        answer,
        sessions = NOBODY,
        alive = () => true,
        unreadableKey = false,
        taken = true,
    }: {
        yes?: boolean;
        answer?: string;
        sessions?: SessionsAnswer;
        alive?: (pid: number, at: number) => boolean;
        unreadableKey?: boolean;
        taken?: boolean;
    } = {},
) {
    let at = 0;
    const calls: string[] = [];
    const next = inTurn(izbor);
    const platform = fakePlatform({ isAlive: (pid) => alive(pid, at) });
    const args: StopArgs = { command: "stop", port: PORT, yes: yes ?? false };
    const result = await runStop(args, {
        client: {
            async getIzbor() {
                calls.push("getIzbor");
                return next();
            },
            async getSessions() {
                calls.push("getSessions");
                return sessions;
            },
            async requestStop(key) {
                calls.push(`requestStop ${key}`);
                return taken;
            },
        },
        async readKey(path) {
            calls.push(`readKey ${path}`);
            if (unreadableKey) throw new Error(`EACCES: permission denied, open '${path}'`);
            return `${KEY}\n`;
        },
        ask:
            answer === undefined
                ? null
                : async (question) => {
                      calls.push(`ask ${question}`);
                      return answer;
                  },
        platform: {
            isAlive: platform.isAlive,
            endIzbor(pid) {
                calls.push(`endIzbor ${pid}`);
                platform.endIzbor(pid);
            },
        },
        async wait(ms) {
            calls.push(`wait ${ms}`);
            at += ms;
        },
        nowMs: () => at,
    });
    return { result, calls, endedAt: at, ended: platform.ended };
}

const withoutWaits = (calls: string[]) => calls.filter((call) => !call.startsWith("wait "));

const QUESTION = (listeners: string, sessions: string) =>
    `ask Izbor has ${listeners} on ${sessions}. Stop Izbor for every window? [y/N]`;
const STOPPED = { lines: ["Izbor stopped."], code: 0 };
const ENDED = { lines: ["Izbor stopped without being asked: records still waiting may be lost."], code: 0 };
const ASKED = [`readKey ${INFO.sendKeyPath}`, `requestStop ${KEY}`];
const KEEPS_RUNNING = { lines: ["Izbor keeps running."], code: 1 };

test("izbor stop with nothing on the port: Izbor is not running., exit 0; nothing else is asked or signalled", async () => {
    assert.deepEqual(await stop([NOT_RUNNING], { answer: "y" }), {
        result: { lines: ["Izbor is not running."], code: 0 },
        calls: ["getIzbor"],
        endedAt: 0,
        ended: [],
    });
});

test("izbor stop on a Izbor that is stopping already: it says so, exit 0, and signals nothing", async () => {
    const { result, calls } = await stop([{ away: "stopping" }], { answer: "y" });
    assert.deepEqual(result, { lines: [`Izbor on ${PORT} is already stopping.`], code: 0 });
    assert.deepEqual(calls, ["getIzbor"]);
});

test("izbor stop refuses an older Izbor, another program and a Izbor that does not answer: exit 1, with nothing signalled", async () => {
    const cases: [IzborAnswer, string[]][] = [
        [
            { up: "older" },
            [`An older Izbor runs on 127.0.0.1:${PORT}. It names no pid: stop it with Ctrl-C where it runs.`],
        ],
        [
            { foreign: FOREIGN },
            [
                `Port ${PORT} answers, but not as Izbor. izbor stop stopped nothing.`,
                `${FOREIGN}; see lsof -nP -iTCP:${PORT} (Windows: netstat -ano | findstr :${PORT})`,
            ],
        ],
        [
            { away: "not answering" },
            [`Izbor on ${PORT} does not answer (hung, or paused?). izbor stop stopped nothing.`],
        ],
    ];
    for (const [answer, lines] of cases) {
        const { result, calls } = await stop([answer], {
            answer: "y",
            sessions: { sessions: [{ sessionId: A, listeners: 2 }] },
        });
        assert.deepEqual(result, { lines, code: 1 }, JSON.stringify(answer));
        assert.deepEqual(calls, ["getIzbor"], JSON.stringify(answer));
    }
});

test("izbor stop with nobody listening, in a terminal: no question; it asks Izbor to stop with the send key GET /izbor names; Izbor stopped. once the pid GET /izbor names is gone", async () => {
    const lingering = { sessions: [{ sessionId: A, listeners: 0 }] };
    for (const sessions of [NOBODY, lingering]) {
        const { result, calls, endedAt } = await stop([{ up: INFO }], {
            answer: "y",
            sessions,
            alive: runsUntil({ [INFO.pid]: 2350 }),
        });
        assert.deepEqual(result, STOPPED);
        assert.deepEqual(withoutWaits(calls), ["getIzbor", "getSessions", ...ASKED]);
        assert.equal(endedAt, 2400);
    }
});

test("izbor stop with listeners, in a terminal: it asks first, with the counts; only y or yes stops Izbor, anything else sends no stop request", async () => {
    const sessions = {
        sessions: [
            { sessionId: A, listeners: 2 },
            { sessionId: B, listeners: 0 },
        ],
    };
    const question = QUESTION("2 listeners", "1 session");

    for (const answer of ["y", "Y", " yes ", "YES"]) {
        const { result, calls } = await stop([{ up: INFO }], {
            answer,
            sessions,
            alive: runsUntil({ [INFO.pid]: 100 }),
        });
        assert.deepEqual(result, STOPPED, answer);
        assert.deepEqual(withoutWaits(calls), ["getIzbor", "getSessions", question, "getIzbor", ...ASKED], answer);
    }
    for (const answer of ["", "n", "no", "N", "yep", "y please", "q"]) {
        const { result, calls } = await stop([{ up: INFO }], { answer, sessions });
        assert.deepEqual(result, KEEPS_RUNNING, JSON.stringify(answer));
        assert.deepEqual(calls, ["getIzbor", "getSessions", question], JSON.stringify(answer));
    }
});

test("izbor stop's question counts listeners and the sessions they listen to, one or many", async () => {
    const asked = async (sessions: SessionsAnswer) =>
        (await stop([{ up: INFO }], { answer: "n", sessions })).calls.find((call) => call.startsWith("ask "));
    assert.equal(await asked({ sessions: [{ sessionId: A, listeners: 1 }] }), QUESTION("1 listener", "1 session"));
    assert.equal(
        await asked({
            sessions: [
                { sessionId: A, listeners: 1 },
                { sessionId: B, listeners: 2 },
                { sessionId: C, listeners: 0 },
            ],
        }),
        QUESTION("3 listeners", "2 sessions"),
    );
    for (const sessions of [{ away: "not answering" }, { refused: 403, message: "forbidden" }] as SessionsAnswer[])
        assert.equal(
            await asked(sessions),
            "ask Izbor did not say who listens. Stop Izbor for every window? [y/N]",
            JSON.stringify(sessions),
        );
});

test("izbor stop --yes, or with stdin not a terminal: no question, and no GET /sessions", async () => {
    const sessions = { sessions: [{ sessionId: A, listeners: 2 }] };
    const alive = runsUntil({ [INFO.pid]: 100 });
    const withYes = await stop([{ up: INFO }], { yes: true, answer: "n", sessions, alive });
    const noTerminal = await stop([{ up: INFO }], { sessions, alive });
    for (const { result, calls } of [withYes, noTerminal]) {
        assert.deepEqual(result, STOPPED);
        assert.deepEqual(withoutWaits(calls), ["getIzbor", ...ASKED]);
    }
});

test("izbor stop waits for the pid to be gone, not for the port: no GET /izbor after the stop request, though the port is closed", async () => {
    const { result, calls, endedAt } = await stop([{ up: INFO }, NOT_RUNNING], {
        alive: runsUntil({ [INFO.pid]: 3200 }),
    });
    assert.deepEqual(result, STOPPED);
    assert.equal(endedAt, 3200);
    assert.deepEqual(calls.slice(0, 3), ["getIzbor", ...ASKED]);
    assert.ok(
        calls.slice(3).every((call) => call === "wait 100"),
        calls.join(),
    );
});

test("izbor stop, with the pid still alive 7 s after it was asked to stop: it says so, exit 1, and ends it at most once", async () => {
    const hung = {
        lines: [`Izbor (pid ${INFO.pid}) still runs 7 s after it was asked to stop: hung, or another user's.`],
        code: 1,
    };
    for (const [given, ends] of [
        [{}, 0],
        [{ taken: false }, 1],
        [{ unreadableKey: true }, 1],
    ] as const) {
        const { result, endedAt, ended } = await stop([{ up: INFO }], given);
        assert.deepEqual(result, hung, JSON.stringify(given));
        assert.equal(endedAt, 7000, JSON.stringify(given));
        assert.deepEqual(ended, Array(ends).fill(INFO.pid), JSON.stringify(given));
    }
});

test("izbor stop, when Izbor does not take the stop request: endIzbor once, then Izbor stopped without being asked once the pid is gone", async () => {
    const { result, calls, ended } = await stop([{ up: INFO }], {
        taken: false,
        alive: runsUntil({ [INFO.pid]: 300 }),
    });
    assert.deepEqual(result, ENDED);
    assert.deepEqual(withoutWaits(calls), ["getIzbor", ...ASKED, "getIzbor", `endIzbor ${INFO.pid}`]);
    assert.deepEqual(ended, [INFO.pid]);
});

test("izbor stop, when the send key cannot be read: no stop request, endIzbor once, then Izbor stopped without being asked", async () => {
    const { result, calls, ended } = await stop([{ up: INFO }], {
        unreadableKey: true,
        alive: runsUntil({ [INFO.pid]: 300 }),
    });
    assert.deepEqual(result, ENDED);
    assert.deepEqual(withoutWaits(calls), [
        "getIzbor",
        `readKey ${INFO.sendKeyPath}`,
        "getIzbor",
        `endIzbor ${INFO.pid}`,
    ]);
    assert.deepEqual(ended, [INFO.pid]);
});

test("izbor stop, when its request finds the port closed by a Izbor stop already running: endIzbor is never called, and Izbor stopped.", async () => {
    for (const away of [NOT_RUNNING, { away: "stopping" } as const]) {
        const { result, calls, ended } = await stop([{ up: INFO }, away], {
            taken: false,
            alive: runsUntil({ [INFO.pid]: 300 }),
        });
        assert.deepEqual(result, STOPPED, away.away);
        assert.deepEqual(withoutWaits(calls), ["getIzbor", ...ASKED, "getIzbor"], away.away);
        assert.deepEqual(ended, [], away.away);
    }
});

test("izbor stop, when Izbor changed while you answered: another pid, or none, is never signalled", async () => {
    const sessions = { sessions: [{ sessionId: A, listeners: 1 }] };
    const other = await stop([{ up: INFO }, { up: { ...INFO, pid: 812 } }], { answer: "y", sessions });
    assert.deepEqual(other.result, {
        lines: [`Another Izbor (pid 812) runs on ${PORT} now. izbor stop stopped nothing.`],
        code: 1,
    });
    const gone = await stop([{ up: INFO }, NOT_RUNNING], { answer: "y", sessions });
    assert.deepEqual(gone.result, { lines: ["Izbor is not running."], code: 0 });
    for (const { calls } of [other, gone])
        assert.ok(!calls.some((call) => /^(readKey|requestStop|endIzbor) /.test(call)), calls.join());
});

const STATUS: StatusArgs = { command: "status", port: PORT, diskUsage: false };

async function status(
    izbor: IzborAnswer,
    {
        sessions = NOBODY,
        onPath = IZBOR_BIN,
        builtAt,
        now = STARTED_AT + 45_000,
        home = "/Users/me",
        diskUsage = false,
    }: {
        diskUsage?: boolean;
        sessions?: SessionsAnswer;
        onPath?: string;
        builtAt?: number;
        now?: number;
        home?: string;
    } = {},
) {
    const calls: string[] = [];
    const result = await runStatus(
        { ...STATUS, diskUsage },
        {
            client: {
                async getIzbor() {
                    calls.push("getIzbor");
                    return izbor;
                },
                async getSessions() {
                    calls.push("getSessions");
                    return sessions;
                },
            },
            which: () => onPath,
            builtAt: () => builtAt,
            now: () => now,
            home,
        },
    );
    return { ...result, calls };
}

async function dataFolder(bytes: number, { log = true } = {}) {
    const home = await mkdtemp(join(tmpdir(), "izbor-home-"));
    const dataDir = join(home, "izbor", ".izbor");
    await mkdir(join(dataDir, "sessions"), { recursive: true });
    await writeFile(join(dataDir, "sessions", "a.jsonl"), "");
    await truncate(join(dataDir, "sessions", "a.jsonl"), bytes);
    if (log) await writeFile(join(dataDir, "izbor.log"), "");
    return { home, dataDir };
}

test("izbor status on a running Izbor: S10, exit 0", async () => {
    const { home, dataDir } = await dataFolder(Math.round(14.3 * 1024 * 1024));
    const { lines, code } = await status(
        { up: { ...INFO, pid: 51234, dataDir } },
        {
            sessions: {
                sessions: [
                    { sessionId: A, listeners: 2 },
                    { sessionId: B, listeners: 0 },
                ],
            },
            now: STARTED_AT + (2 * 60 + 14) * 60_000 + 30_000,
            home,
        },
    );
    assert.deepEqual(lines, [
        `Izbor runs · pid 51234 · 127.0.0.1:${PORT} · up 2 h 14 min`,
        `Data folder ${DATA_FOLDER} · log izbor.log`,
        "Watches: 4a979d7e (2 listening), 13c81eb6 (nobody listening, ends within 30 s)",
        "izbor on PATH → this checkout",
    ]);
    assert.equal(code, 0);
});

test("izbor status: the stale-build line when Izbor started before your last build, as its last line; not when it started at it or after", async () => {
    assert.deepEqual((await status({ up: INFO }, { builtAt: STARTED_AT + 1 })).lines.slice(-2), [
        "izbor on PATH → this checkout",
        STALE,
    ]);
    for (const builtAt of [STARTED_AT, STARTED_AT - 60_000, undefined])
        assert.ok(!(await status({ up: INFO }, { builtAt })).lines.includes(STALE), String(builtAt));
    assert.ok(!(await status({ up: "older" }, { builtAt: Date.now() })).lines.includes(STALE));
});

test("izbor status --disk-usage: the data folder in MB, with one decimal under 10 MB and ~ for home; the log only when it is there", async () => {
    const line = async (bytes: number, { log = true, inHome = true } = {}) => {
        const { home, dataDir } = await dataFolder(bytes, { log });
        return (await status({ up: { ...INFO, dataDir } }, { home: inHome ? home : "/Users/someone", diskUsage: true }))
            .lines[1];
    };
    assert.equal(await line(0), `Data folder ${DATA_FOLDER} (0.0 MB) · log izbor.log`);
    assert.equal(await line(3 * 1024 * 1024 + 300_000), `Data folder ${DATA_FOLDER} (3.3 MB) · log izbor.log`);
    assert.equal(await line(10 * 1024 * 1024), `Data folder ${DATA_FOLDER} (10 MB) · log izbor.log`);
    assert.equal(await line(1024 * 1024, { log: false }), `Data folder ${DATA_FOLDER} (1.0 MB)`);
    assert.match((await line(0, { inHome: false }))!, /^Data folder [\\/].+[\\/]izbor[\\/]\.izbor \(0\.0 MB\)/);
    const home = await mkdtemp(join(tmpdir(), "izbor-home-"));
    const gone = { ...INFO, dataDir: join(home, "izbor", ".izbor") };
    assert.equal((await status({ up: gone }, { home, diskUsage: true })).lines[1], `Data folder ${DATA_FOLDER}`);
});

test(
    "izbor status --disk-usage: the data folder's size follows no link, out of it or back into it, and skips a subfolder it cannot read",
    skipOnWindows("Windows: links need Developer Mode, and chmod does not deny reading"),
    async () => {
        const { home, dataDir } = await dataFolder(1024 * 1024);
        const outside = await mkdtemp(join(tmpdir(), "izbor-outside-"));
        await writeFile(join(outside, "big"), "");
        await truncate(join(outside, "big"), 50 * 1024 * 1024);
        await symlink(outside, join(dataDir, "sessions", "elsewhere"));
        await symlink(dataDir, join(dataDir, "sessions", "loop"));
        await symlink(join(outside, "big"), join(dataDir, "big"));
        const closed = join(dataDir, "closed");
        await mkdir(closed);
        await writeFile(join(closed, "c.jsonl"), "x".repeat(1000));
        await chmod(closed, 0o000);
        try {
            const { lines } = await status({ up: { ...INFO, dataDir } }, { home, diskUsage: true });
            assert.equal(lines[1], "Data folder ~/izbor/.izbor (1.0 MB) · log izbor.log");
        } finally {
            await chmod(closed, 0o755);
        }
    },
);

test("izbor status: how long Izbor is up, in s, min, or h and min", async () => {
    const up = async (ms: number) => (await status({ up: INFO }, { now: STARTED_AT + ms })).lines[0];
    assert.equal(await up(45_900), `Izbor runs · pid ${INFO.pid} · 127.0.0.1:${PORT} · up 45 s`);
    assert.match((await up(14 * 60_000 + 59_000))!, / · up 14 min$/);
    assert.match((await up(60 * 60_000))!, / · up 1 h 0 min$/);
    assert.match((await up(26 * 60 * 60_000 + 3 * 60_000))!, / · up 26 h 3 min$/);
    assert.match((await up(-5_000))!, / · up 0 s$/);
});

test("izbor status: one entry per watch from GET /sessions, nobody listening for 0, none, or why it is not known", async () => {
    const watches = async (sessions: SessionsAnswer) => (await status({ up: INFO }, { sessions })).lines[2];
    assert.equal(await watches(NOBODY), "Watches: none");
    assert.equal(await watches({ sessions: [{ sessionId: A, listeners: 1 }] }), "Watches: 4a979d7e (1 listening)");
    assert.equal(
        await watches({ sessions: [{ sessionId: C, listeners: 0 }] }),
        "Watches: 9f3c1a2b (nobody listening, ends within 30 s)",
    );
    assert.equal(await watches({ away: "not answering" }), "Watches: unknown (Izbor is not answering)");
    assert.equal(
        await watches({ refused: 403, error: "forbidden", message: "Host is not allowed" }),
        "Watches: unknown (Host is not allowed)",
    );
    const invalid = await status(
        { up: INFO },
        { sessions: { refused: 200, message: "Izbor answered 200 with invalid data" } },
    );
    assert.deepEqual([invalid.code, invalid.lines[2]], [0, "Watches: unknown (Izbor answered 200 with invalid data)"]);
});

test("izbor status: the PATH line says this checkout, where else izbor points, or that there is none", async () => {
    const elsewhere = "/opt/homebrew/Cellar/other-program/1.2.0/bin/other-program";
    const pathLine = async (onPath: string | undefined) => (await status(NOT_RUNNING, { onPath })).lines[1];
    assert.equal(await pathLine(IZBOR_BIN), "izbor on PATH → this checkout");
    assert.equal(await pathLine(await izborBinThroughLink()), "izbor on PATH → this checkout");
    assert.equal(await pathLine(elsewhere), `izbor on PATH → ${elsewhere}, not this checkout`);
    const none = await runStatus(STATUS, {
        client: { getIzbor: async () => NOT_RUNNING, getSessions: async () => NOBODY },
        which: () => undefined,
        builtAt: () => undefined,
        now: () => STARTED_AT + 45_000,
        home: "/Users/me",
    });
    assert.deepEqual(none.lines, ["Izbor is not running.", "No izbor on PATH"]);
});

test("izbor status when Izbor does not run (exit 3), another program or a Izbor that does not answer (exit 1), stopping or older (exit 0)", async () => {
    const cases: [IzborAnswer, string[], number][] = [
        [NOT_RUNNING, ["Izbor is not running."], 3],
        [
            { foreign: FOREIGN },
            [
                `Port ${PORT} answers, but not as Izbor.`,
                `${FOREIGN}; see lsof -nP -iTCP:${PORT} (Windows: netstat -ano | findstr :${PORT})`,
            ],
            1,
        ],
        [{ away: "not answering" }, [`Izbor on ${PORT} does not answer (hung, or paused?).`], 1],
        [{ away: "stopping" }, [`Izbor on ${PORT} is stopping.`], 0],
    ];
    for (const [answer, lines, code] of cases) {
        const result = await status(answer, { builtAt: Date.now() });
        assert.deepEqual(
            { lines: result.lines, code: result.code, calls: result.calls },
            { lines: [...lines, "izbor on PATH → this checkout"], code, calls: ["getIzbor"] },
            JSON.stringify(answer),
        );
    }
    const older = await status({ up: "older" }, { sessions: { sessions: [{ sessionId: A, listeners: 1 }] } });
    assert.deepEqual(older.lines, [
        `An older Izbor runs on 127.0.0.1:${PORT}. It names no pid, data folder or start time.`,
        "Watches: 4a979d7e (1 listening)",
        "izbor on PATH → this checkout",
    ]);
    assert.equal(older.code, 0);
});

async function runIzbor(port: number, args: string[], env: Record<string, string>) {
    const { output, exited } = await runIzborBin([...args, "--port", String(port)], { env });
    const [code] = await exited;
    return { stdout: output.stdout, stderr: output.stderr, code };
}

function stopIzborLeftOn(t: TestContext, port: number) {
    t.after(async () => {
        const pid = await izborPid(port);
        if (pid !== undefined) process.kill(pid, "SIGTERM");
    });
}

test(
    "real processes: status says not running (3); izbor starts Izbor; status shows S10 (0); stop --yes says Izbor stopped. only once the pid is gone; status: 3 again",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const port = await freePort();
        const { dataDir, env } = await isolatedIzborEnv();
        const izborEnv = {
            ...withPath(env, await npmLinkFolder(PROJECT_DIR)),
            PORT: String(await freePort()),
        };
        const notRunning = { stdout: "Izbor is not running.\nizbor on PATH → this checkout\n", stderr: "", code: 3 };
        stopIzborLeftOn(t, port);

        assert.deepEqual(await runIzbor(port, ["status"], izborEnv), notRunning);

        const opened = await openIzbor(t, port, { env: izborEnv });
        await opened.until("Izbor starts", () => opened.screen().includes("Izbor ● up"), 15_000);
        const pid = await izborPid(port);
        assert.ok(pid !== undefined, opened.screen());
        assert.equal(await opened.quit(), 0);

        const running = await runIzbor(port, ["status", "--disk-usage"], izborEnv);
        assert.equal(running.code, 0, running.stderr);
        const lines = running.stdout.split("\n");
        assert.match(lines[0]!, new RegExp(`^Izbor runs · pid ${pid} · 127\\.0\\.0\\.1:${port} · up \\d+ s$`));
        assert.match(lines[1]!, /^Data folder (.+) \(\d+\.\d MB\) · log izbor\.log$/);
        assert.equal(lines[1]!.match(/^Data folder (.+) \(/)?.[1], dataDir);
        assert.deepEqual(lines.slice(2), ["Watches: none", "izbor on PATH → this checkout", ""]);

        const stopping = await runIzborBin(["stop", "--yes", "--port", String(port)], { env: izborEnv });
        let aliveAtLine: boolean | undefined;
        stopping.child.stdout.on("data", () => {
            if (aliveAtLine === undefined && stopping.output.stdout.includes("Izbor stopped."))
                aliveAtLine = isRunning(pid);
        });
        const [code] = await stopping.exited;
        assert.deepEqual([stopping.output.stdout, stopping.output.stderr, code], ["Izbor stopped.\n", "", 0]);
        assert.equal(aliveAtLine, false, "Izbor stopped. came while the pid still ran");

        assert.deepEqual(await runIzbor(port, ["status"], izborEnv), notRunning);
    },
);

test(
    "real processes, no PTY: izbor stop --yes stops a listening izbor serve over POST /izbor/stop: Izbor stopped., exit 0, serve exits 0 with izbor stopped",
    { timeout: 60_000 },
    async (t) => {
        const port = await freePort();
        const serve = await startServe(t, ["--port", String(port)]);
        await serve.listening();

        const stopping = await runIzborBin(["stop", "--yes", "--port", String(port)]);
        const [code] = await stopping.exited;

        assert.deepEqual([stopping.output.stdout, stopping.output.stderr, code], ["Izbor stopped.\n", "", 0]);
        assert.deepEqual(await serve.exited, [0, null]);
        assert.match(serve.output.stdout, /izbor stopped\n$/);
    },
);

test(
    "a live window observes a session while izbor stop runs in another terminal: it asks, n or Ctrl-C keeps Izbor, --yes stops it unasked, and the Brief says ▲ Stopped · Izbor stopped",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const claude = await fakeClaude(`process.stdout.write(${JSON.stringify(`${ONE_SESSION_HERE}\n`)});`);
        const port = await freePort();
        const serve = await startServe(t, ["--port", String(port)], pathFirst(claude.dir));
        await serve.listening();
        const window = await openIzbor(t, port, { first: claude.dir });

        await window.until(
            "the list shows the running session",
            () => window.screen().includes("izbor-b8 · Idle"),
            15_000,
        );
        await window.openFirstBrief(100);
        await window.until("the Brief is live", () => window.screen().includes("Back · Esc  Task unknown"), 8000);

        const question = "Izbor has 1 listener on 1 session. Stop Izbor for every window? [y/N]";
        for (const no of [`n${KEYS.enter}`, KEYS["ctrl-c"]]) {
            const declined = await openIzbor(t, port, { args: ["stop"] });
            await declined.until("izbor stop asks", () => declined.screen().includes(question), 15_000);
            declined.input(no);
            await declined.until("izbor stop exits", () => declined.exited() !== undefined, 5000);
            assert.deepEqual(declined.exited(), { code: 1, modesRestored: true }, JSON.stringify(no));
            assert.ok(declined.screen().includes("Izbor keeps running."), declined.screen());
            assert.equal(await izborPid(port), serve.child.pid);
        }

        const confirmed = await openIzbor(t, port, { args: ["stop", "--yes"] });
        await confirmed.until("izbor stop --yes exits", () => confirmed.exited() !== undefined, 15_000);
        assert.equal(confirmed.exited()!.code, 0, confirmed.screen());
        assert.ok(confirmed.screen().includes("Izbor stopped."), confirmed.screen());
        assert.doesNotMatch(confirmed.screen(), /\[y\/N\]/);
        assert.deepEqual(await serve.exited, [0, null]);
        assert.match(serve.output.stdout, /izbor stopped\n$/);

        await window.until(
            "the Brief says Izbor stopped",
            () => window.screen().includes("▲ Stopped · Izbor stopped · last known Brief"),
            5000,
        );
        assert.equal(await window.quit(), 0);
        await until(async () => (await izborPid(port)) === undefined, {
            what: "nothing answers on the port",
            ms: 1000,
        });
    },
);

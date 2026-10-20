import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
    anotherIzbor,
    checkedLock,
    createRun,
    readRegularFileWith,
    replaceFile,
    replaceFileWith,
} from "../src/adapters/platform/portable.js";
import { onPath, win32 } from "../src/adapters/platform/win32.js";
import { PROJECT_DIR } from "../src/config.js";
import { codeOf } from "../src/domain/text.js";
import type { DataFolderLock, Platform } from "../src/core/ports.js";
import { TSX_LOADER } from "./helpers/bin.js";
import { HANGING, withPath, writeFakeCommand } from "./helpers/fakeCommand.js";
import { platformContract } from "./helpers/platformContract.js";
import { fakeClaude, isRunning, until } from "./support.js";

const PRINTS = 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;';

const WIN32 = pathToFileURL(join(PROJECT_DIR, "src", "adapters", "platform", "win32.ts")).href;

function moduleChild(t: TestContext, script: string) {
    const loader = pathToFileURL(TSX_LOADER).href;
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    t.after(() => child.kill("SIGKILL"));
    let printed = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (printed += text));
    return { child, printed: () => printed };
}

suite("win32", { skip: process.platform !== "win32" && "runs on Windows only" }, () => {
    platformContract(
        "win32",
        async () => ({
            platform: win32,
            commands: {
                prints: { command: process.execPath, args: ["-e", PRINTS] },
                missing: { command: join(tmpdir(), "izbor-nonexistent", "command"), args: [] },
                hanging: { command: (await fakeClaude(HANGING)).command, args: [] },
            },
        }),
        { realProcesses: true },
    );

    test("run finds a bare name that is only a .cmd on the path, and runs it", async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-command-"));
        await writeFile(join(dir, "only-cmd.js"), 'process.stdout.write("ran");\n');
        await writeFile(join(dir, "only-cmd.cmd"), '@node "%~dp0only-cmd.js" %*\r\n');
        const before = { ...process.env };
        Object.assign(process.env, withPath(process.env, dir));
        t.after(() => {
            for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
            Object.assign(process.env, before);
        });

        const ran = await win32.run("only-cmd", [], { timeoutMs: 10_000 });

        assert.deepEqual(ran, { outcome: "exited", code: 0, signal: null, stdout: "ran", stderr: "" });
    });

    test("run of an extensionless path with its .cmd beside it runs the command", async () => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-command-"));
        await writeFakeCommand(dir, "claude", 'process.stdout.write("ran");');

        const ran = await win32.run(join(dir, "claude"), [], { timeoutMs: 10_000 });

        assert.deepEqual(ran, { outcome: "exited", code: 0, signal: null, stdout: "ran", stderr: "" });
    });

    test("run of a command under a path with spaces and parentheses runs it", async () => {
        const dir = join(await mkdtemp(join(tmpdir(), "izbor-command-")), "Program Files (x86)", "Claude Code");
        await mkdir(dir, { recursive: true });
        await writeFakeCommand(dir, "claude", 'process.stdout.write("ran");');

        const ran = await win32.run(join(dir, "claude"), [], { timeoutMs: 10_000 });

        assert.deepEqual(ran, { outcome: "exited", code: 0, signal: null, stdout: "ran", stderr: "" });
    });
});

test("win32's platform constants", () => {
    const drops: [Record<string, string>, boolean, string][] = [
        [{}, true, "the old console window: no WT_SESSION and no TERM_PROGRAM"],
        [{ WT_SESSION: "a3b2c1d0-0000-4000-8000-000000000000" }, false, "Windows Terminal"],
        [{ TERM_PROGRAM: "vscode" }, false, "VS Code's terminal"],
    ];
    for (const [env, dropped, terminal] of drops) assert.equal(win32.dropsMouseClicks(env), dropped, terminal);
    // A refused connect is retried for about 2 s.
    assert.equal(win32.refusedConnectMs, 500, "a loopback connect not finished in 500 ms counts as refused");
    // So Claude Code reads a session's settings in the folder it started in.
    assert.equal(win32.ownsFilesByUid, false, "a file has no owner uid");
});

test("importing win32.ts starts no process, and leaves nothing that keeps Node running", async (t) => {
    const { child, printed } = moduleChild(
        t,
        `await import(${JSON.stringify(WIN32)});
process.stdout.write(JSON.stringify(process.getActiveResourcesInfo()));`,
    );

    const [code] = await once(child, "exit");

    assert.equal(code, 0);
    assert.ok(!JSON.parse(printed()).includes("ProcessWrap"), printed());
});

function fakeLock(holds: boolean) {
    const held = new Set<string>();
    const counted = { released: 0 };
    const lock: Platform["lockDataFolder"] = async (dataDir) => {
        if (holds && held.has(dataDir)) throw new Error(anotherIzbor(dataDir));
        held.add(dataDir);
        return {
            writeHolder: async () => {},
            release: async () => {
                held.delete(dataDir);
                counted.released++;
            },
        } satisfies DataFolderLock;
    };
    return { lock, counted, held };
}

test("checkedLock of a lock that holds gives the first lock, which still holds the folder", async () => {
    const { lock, counted, held } = fakeLock(true);

    const first = await checkedLock(lock)("/data");

    assert.equal(counted.released, 0);
    assert.ok(held.has("/data"));
    await first.release();
    assert.ok(!held.has("/data"));
});

test("checkedLock of a lock that never holds releases both and refuses, naming the folder", async () => {
    const { lock, counted } = fakeLock(false);

    await assert.rejects(checkedLock(lock)("/data"), {
        message: "This Windows did not lock the data folder (/data). Izbor did not start: please report this.",
    });
    assert.equal(counted.released, 2);
});

test("checkedLock throws any other error of the second lock as it is, after releasing the first", async () => {
    let calls = 0;
    let releases = 0;
    const lock: Platform["lockDataFolder"] = async () => {
        if (++calls === 2) throw new Error("EPERM: the folder is read-only");
        return { writeHolder: async () => {}, release: async () => void releases++ };
    };

    await assert.rejects(checkedLock(lock)("/data"), { message: "EPERM: the folder is read-only" });
    assert.equal(releases, 1);
});

function runReachingLiveTreeOnly() {
    const killed: (number | undefined)[] = [];
    const run = createRun(
        (command, args, cwd) => spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }),
        { killTree: (pid) => void killed.push(pid), reachesTreeAfterExit: false },
    );
    return { run, killed };
}

test("run past its time, on a platform whose kill reaches a live tree only, kills a child that still runs", async (t) => {
    const { run, killed } = runReachingLiveTreeOnly();
    const controller = new AbortController();
    const ran = run(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        timeoutMs: 60_000,
        signal: controller.signal,
    });
    t.after(() => killed.filter((pid) => pid && isRunning(pid)).forEach((pid) => process.kill(pid!, "SIGKILL")));

    controller.abort(new Error("stopped"));
    await until(() => killed.length === 1);
    process.kill(killed[0]!, "SIGKILL");

    assert.deepEqual(await ran, { outcome: "cancelled", why: "stopped" });
    assert.equal(killed.length, 1);
});

test("run past its time, on a platform whose kill reaches a live tree only, kills nothing once the child exited, and does not wait for what it left", async (t) => {
    const { run, killed } = runReachingLiveTreeOnly();
    const claude = await fakeClaude(`${HANGING}\ngrandchild.unref();`);
    t.after(async () => (await claude.pids()).filter(isRunning).forEach((pid) => process.kill(pid, "SIGKILL")));
    const started = Date.now();

    const ran = await run(process.execPath, [claude.command], { timeoutMs: 1000 });

    assert.deepEqual(ran, { outcome: "timed_out", why: "no answer in 1000 ms" });
    assert.deepEqual(killed, []);
    assert.ok(Date.now() - started < 10_000, `the run took ${Date.now() - started} ms`);
});

test("onPath finds a bare name in PATH's absolute folders by PATHEXT, never in the working directory or a relative folder", () => {
    const files = new Set(["c:\\tools\\claude.cmd", "c:\\bin\\claude.exe", "c:\\bin\\node.v1.exe", "c:\\bin\\node.v1"]);
    const env = { Path: '.;bin;"C:\\tools";C:\\bin', PATHEXT: ".exe;.cmd" };
    const isFile = (file: string) => files.has(file.toLowerCase());

    assert.equal(onPath("claude", env, isFile), "C:\\tools\\claude.cmd");
    assert.equal(onPath("claude", { ...env, Path: "C:\\bin;C:\\tools" }, isFile), "C:\\bin\\claude.exe");
    assert.equal(onPath("node.v1", env, isFile), "C:\\bin\\node.v1");
    assert.equal(onPath("C:\\project\\claude", env, isFile), "C:\\project\\claude");
    assert.equal(onPath("./claude", env, isFile), "./claude");
    assert.equal(onPath("claude", { PATH: "C:\\tools" }, isFile), "C:\\tools\\claude.CMD");
    assert.throws(() => onPath("claude", { PATH: ".;bin" }, () => true), { message: "claude is not on PATH" });
});

function refusingRename(code: string, refuse: () => boolean) {
    let tries = 0;
    const rename = (from: string, to: string) => {
        tries++;
        if (refuse()) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
        renameSync(from, to);
    };
    return { rename, tries: () => tries };
}

test("replaceFile retries a rename refused with EPERM, EBUSY or EACCES, and writes the file once it is let through", async () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
        const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
        const file = join(dir, "settings.json");
        await writeFile(file, "old");
        let refusals = 2;
        const { rename, tries } = refusingRename(code, () => refusals-- > 0);

        replaceFileWith(rename)(file, "new");

        assert.equal(await readFile(file, "utf8"), "new", code);
        assert.equal(tries(), 3, code);
        assert.deepEqual(await readdir(dir), ["settings.json"], code);
    }
});

test("replaceFile gives up on a rename refused for longer than 1 s, throws its EPERM and leaves no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
    const file = join(dir, "settings.json");
    await writeFile(file, "old");
    const { rename } = refusingRename("EPERM", () => true);
    const started = performance.now();

    assert.throws(() => replaceFileWith(rename)(file, "new"), { code: "EPERM" });

    const took = performance.now() - started;
    assert.ok(took >= 800 && took <= 1500, `took ${took} ms`);
    assert.equal(await readFile(file, "utf8"), "old");
    assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("replaceFile does not retry a rename that fails for another reason, such as ENOENT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
    const { rename, tries } = refusingRename("ENOENT", () => true);

    assert.throws(() => replaceFileWith(rename)(join(dir, "settings.json"), "new"), { code: "ENOENT" });

    assert.equal(tries(), 1);
    assert.deepEqual(await readdir(dir), []);
});

function lstatThen(between: () => void) {
    let calls = 0;
    const lstat = (file: string) => {
        const seen = lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (calls++ === 0) between();
        return seen;
    };
    return { lstat, calls: () => calls };
}

test("readRegularFile reads a file renamed over between its lstat and its open, as Claude Code writes one, by looking again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
    const file = join(dir, "settings.json");
    await writeFile(file, "old");
    const { lstat, calls } = lstatThen(() => replaceFile(file, "new"));

    assert.equal(readRegularFileWith(lstat)(file)?.text, "new");
    assert.equal(calls(), 2);
});

test("readRegularFile refuses a link swapped in between its lstat and its open with `it is a link`", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, "old");
    writeFileSync(join(dir, "other.json"), "other");
    try {
        symlinkSync(join(dir, "other.json"), join(dir, "probe-link"));
    } catch (error) {
        if (codeOf(error) === "EPERM") return t.skip("no link to a file without Developer Mode");
        throw error;
    }
    const { lstat } = lstatThen(() => {
        rmSync(file);
        symlinkSync(join(dir, "other.json"), file);
    });

    assert.throws(() => readRegularFileWith(lstat)(file), { message: "it is a link" });
});

test("readRegularFile gives up on a file replaced each time it is read, after three tries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
    const file = join(dir, "settings.json");
    await writeFile(file, "text");
    await writeFile(join(dir, "other.json"), "other");
    let calls = 0;
    const stale = () => {
        calls++;
        return lstatSync(join(dir, "other.json"), { bigint: true });
    };

    assert.throws(() => readRegularFileWith(stale)(file), { message: "it was replaced each time it was read" });
    assert.equal(calls, 3);
});

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { darwin } from "../src/adapters/platform/darwin.js";
import { selectPlatform } from "../src/adapters/platform/select.js";
import { win32 } from "../src/adapters/platform/win32.js";
import { platformContract } from "./helpers/platformContract.js";
import { HANGING } from "./helpers/fakeCommand.js";
import { fakeClaude, isRunning, until } from "./support.js";

const PRINTS = 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;';

const started = (claude: { pids(): Promise<number[]> }) =>
    until(async () => (await claude.pids()).length === 2, { what: "the fake claude and its child start", ms: 10_000 });

const ended = (pids: number[]) =>
    until(() => !pids.some(isRunning), { what: "the fake claude and its child end", ms: 5000 });

suite("darwin", { skip: process.platform !== "darwin" && "runs on darwin only" }, () => {
    platformContract(
        "darwin",
        async () => ({
            platform: darwin,
            commands: {
                prints: { command: process.execPath, args: ["-e", PRINTS] },
                missing: { command: "/nonexistent/command", args: [] },
                hanging: { command: (await fakeClaude(HANGING)).command, args: [] },
            },
        }),
        { realProcesses: true },
    );

    test("run that comes back timed_out has ended the command and what it started", async (t) => {
        const claude = await fakeClaude(HANGING);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const running = darwin.run(claude.command, [], { timeoutMs: 2000 });
        // The run's timer must not fire before the tree is up, so time stands still; poll on setImmediate.
        const end = Date.now() + 10_000;
        while ((await claude.pids()).length !== 2) {
            assert.ok(Date.now() < end, "the fake claude and its child start: not within 10000 ms");
            await setImmediate();
        }
        const pids = await claude.pids();
        assert.deepEqual(pids.filter(isRunning), pids);

        t.mock.timers.tick(2000);
        t.mock.timers.reset();

        assert.deepEqual(await running, { outcome: "timed_out", why: "no answer in 2000 ms" });
        await ended(pids);
    });

    test("run that comes back cancelled has ended the command and what it started", async () => {
        const claude = await fakeClaude(HANGING);
        const abort = new AbortController();

        const running = darwin.run(claude.command, [], { timeoutMs: 10_000, signal: abort.signal });
        await started(claude);
        const pids = await claude.pids();
        assert.deepEqual(pids.filter(isRunning), pids);
        abort.abort(new Error("the caller left"));

        assert.deepEqual(await running, { outcome: "cancelled", why: "the caller left" });
        await ended(pids);
    });

    test("run that times out while the command is starting processes comes back, and has ended them all", async (t) => {
        // A process forked while the group SIGKILL is delivered can miss it, and holds the output pipes open.
        // This command forks back to back, so most rounds kill it mid-fork.
        const file = join(await mkdtemp(join(tmpdir(), "izbor-forks-")), "pids");
        const forks = `const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const start = () => {
    const child = spawn("/bin/sleep", ["20"], { stdio: ["ignore", "inherit", "inherit"] });
    appendFileSync(process.argv[1], \`\${child.pid} \`);
    setImmediate(start);
};
start();`;
        writeFileSync(file, "");
        const pids = () => readFileSync(file, "utf8").split(" ").filter(Boolean).map(Number);
        t.after(() =>
            pids()
                .filter(isRunning)
                .forEach((pid) => process.kill(pid, "SIGKILL")),
        );

        for (let round = 1; round <= 5; round++) {
            const running = darwin.run(process.execPath, ["-e", forks, file], { timeoutMs: 500 });
            const ran = await Promise.race([running, setTimeout(10_000, { outcome: "still running" }, { ref: false })]);

            assert.deepEqual(ran, { outcome: "timed_out", why: "no answer in 500 ms" }, `round ${round}`);
        }
        await until(() => !pids().some(isRunning), { what: "what it started ends", ms: 5000 });
    });

    test("run hands an argument with a space to the command as one argument, and runs it in `cwd`", async () => {
        const cwd = await realpath(await mkdtemp(join(tmpdir(), "izbor-run-")));
        const claude = await fakeClaude(
            'const args = process.argv.slice(2);\nprocess.stdout.write(`${args.length} ${args[0] ?? ""} ${process.cwd()}\\n`);',
        );

        const ran = await darwin.run(claude.command, ["two words; echo no"], { timeoutMs: 10_000, cwd });

        assert.deepEqual(ran, {
            outcome: "exited",
            code: 0,
            signal: null,
            stdout: `1 two words; echo no ${cwd}\n`,
            stderr: "",
        });
    });

    test("writeHolder(port) leaves `<pid> <port>` in `izbor.holder`, in place of what it held", async (t) => {
        const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
        const lock = await darwin.lockDataFolder(dataDir);
        t.after(() => lock.release());

        await lock.writeHolder(45678);
        await lock.writeHolder(4567);

        assert.equal(readFileSync(join(dataDir, "izbor.holder"), "utf8"), `${process.pid} 4567`);
    });

    test("replaceFile gives the file the given mode whatever the umask, in place of what it held, and leaves no temp file", async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
        const file = join(dir, "settings.json");
        writeFileSync(file, "old");
        const umask = process.umask(0o077);
        t.after(() => process.umask(umask));

        darwin.replaceFile(file, "new", 0o664);

        assert.equal(readFileSync(file, "utf8"), "new");
        assert.equal(statSync(file).mode & 0o777, 0o664);
        assert.deepEqual(readdirSync(dir), ["settings.json"]);
    });

    test("replaceFile with no mode gives a new file the default mode, and throws with no temp file left when it cannot rename", async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
        const umask = process.umask(0o022);
        t.after(() => process.umask(umask));

        darwin.replaceFile(join(dir, "port"), "4317\n");

        assert.equal(readFileSync(join(dir, "port"), "utf8"), "4317\n");
        assert.equal(statSync(join(dir, "port")).mode & 0o777, 0o644);

        mkdirSync(join(dir, "taken"));
        assert.throws(() => darwin.replaceFile(join(dir, "taken"), "text"));
        assert.deepEqual(readdirSync(dir).sort(), ["port", "taken"]);
    });

    test("readRegularFile gives null for no file, the text and the mode of a file, and throws `it is not a file` for a folder", async () => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
        const file = join(dir, "settings.json");

        assert.equal(darwin.readRegularFile(file), null);

        writeFileSync(file, '{ "permissions": {} }');
        chmodSync(file, 0o640);
        assert.deepEqual(darwin.readRegularFile(file), { text: '{ "permissions": {} }', mode: 0o640 });

        assert.throws(() => darwin.readRegularFile(dir), { message: "it is not a file" });
    });

    test("writePrivateFile makes the folder when missing, for this OS user only (0700), and the file 0600, with no temp file left", async (t) => {
        const dir = join(await mkdtemp(join(tmpdir(), "izbor-files-")), "user");
        const umask = process.umask(0o022);
        t.after(() => process.umask(umask));

        darwin.writePrivateFile(join(dir, "send-key-4317"), "key\n");

        assert.equal(readFileSync(join(dir, "send-key-4317"), "utf8"), "key\n");
        assert.equal(statSync(join(dir, "send-key-4317")).mode & 0o777, 0o600);
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(dir), ["send-key-4317"]);

        darwin.writePrivateFile(join(dir, "send-key-4317"), "next\n");
        assert.equal(readFileSync(join(dir, "send-key-4317"), "utf8"), "next\n");
    });
});

test("selectPlatform gives darwin for darwin and win32 for win32, and refuses any other OS by name", () => {
    assert.equal(selectPlatform("darwin"), darwin);
    assert.equal(selectPlatform("win32"), win32);
    assert.throws(() => selectPlatform("linux"), { message: "Izbor does not run on linux yet." });
});

test("darwin's platform constants", () => {
    for (const env of [{}, { WT_SESSION: "1" }, { TERM_PROGRAM: "Apple_Terminal" }])
        assert.equal(darwin.dropsMouseClicks(env), false, `no terminal drops mouse clicks: ${JSON.stringify(env)}`);
    // A refused loopback connect fails at once, and one that hangs is a Izbor that does not answer.
    assert.equal(darwin.refusedConnectMs, Infinity, "a loopback connect is never cut short");
    // So Claude Code reads a checkout's settings at its git root.
    assert.equal(darwin.ownsFilesByUid, true, "a file has an owner uid");
});

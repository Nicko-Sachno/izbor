import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { PROJECT_DIR } from "../../src/config.js";
import type { Platform } from "../../src/core/ports.js";
import { codeOf } from "../../src/domain/text.js";
import { fakeClaude, isRunning, until } from "../support.js";
import { TSX_LOADER } from "./bin.js";
import { HANGING, writeFakeCommand } from "./fakeCommand.js";

type ContractCommands = {
    prints: { command: string; args: readonly string[] };
    missing: { command: string; args: readonly string[] };
    hanging: { command: string; args: readonly string[] };
};

type ContractOptions = {
    realProcesses: boolean;
};

const SELECT = pathToFileURL(join(PROJECT_DIR, "src", "adapters", "platform", "select.ts")).href;

export function platformContract(
    name: string,
    build: (
        t: TestContext,
    ) =>
        | { platform: Platform; commands: ContractCommands }
        | Promise<{ platform: Platform; commands: ContractCommands }>,
    { realProcesses }: ContractOptions,
) {
    const real = { skip: !realProcesses && "needs real processes" };

    suite(`${name} keeps the Platform's rules`, () => {
        test("a second lock of one data folder is refused, naming the folder; release() frees it", async (t) => {
            const { platform } = await build(t);
            const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
            const first = await platform.lockDataFolder(dataDir);

            try {
                await assert.rejects(platform.lockDataFolder(dataDir), {
                    message: `Another Izbor is using this data folder (${dataDir}). Izbor did not start.`,
                });
            } finally {
                await first.release();
            }
            const second = await platform.lockDataFolder(dataDir);
            await second.release();
        });

        test("a lock held by a child process that is then killed is free again", real, async (t) => {
            const { platform } = await build(t);
            const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
            const script = `const { selectPlatform } = await import(${JSON.stringify(SELECT)});
await selectPlatform(process.platform).lockDataFolder(${JSON.stringify(dataDir)});
process.stdout.write("locked\\n");
setInterval(() => {}, 1000);`;
            const loader = pathToFileURL(TSX_LOADER).href;
            const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", script], {
                stdio: ["ignore", "pipe", "inherit"],
            });
            t.after(() => child.kill("SIGKILL"));
            let printed = "";
            child.stdout.setEncoding("utf8").on("data", (text: string) => (printed += text));
            await until(() => printed === "locked\n", { what: "the child holds the lock", ms: 10_000 });

            await assert.rejects(platform.lockDataFolder(dataDir), {
                message: `Another Izbor is using this data folder (${dataDir}). Izbor did not start.`,
            });

            child.kill("SIGKILL");
            await once(child, "exit");
            const lock = await platform.lockDataFolder(dataDir);
            await lock.release();
        });

        test("killTree does nothing for undefined, and does not throw", async (t) => {
            const { platform } = await build(t);
            assert.doesNotThrow(() => platform.killTree(undefined));
        });

        test("killTree does nothing for a pid that is gone, and does not throw", async (t) => {
            const { platform } = await build(t);
            const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore", windowsHide: true });
            await once(child, "exit");
            assert.doesNotThrow(() => platform.killTree(child.pid));
        });

        test("endIzbor does nothing for a pid that is gone, and does not throw", async (t) => {
            const { platform } = await build(t);
            const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
            await once(child, "exit");
            assert.doesNotThrow(() => platform.endIzbor(child.pid!));
        });

        test("killTree ends a detached child and the process it started within 5 s", real, async (t) => {
            const { platform } = await build(t);
            const claude = await fakeClaude(HANGING);
            const child = spawn(process.execPath, [claude.command], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
            });
            t.after(() => platform.killTree(child.pid));
            await until(async () => (await claude.pids()).length === 2, {
                what: "the fake claude and its child start",
                ms: 10_000,
            });
            const pids = await claude.pids();
            assert.deepEqual(pids.filter(isRunning), pids);

            platform.killTree(child.pid);

            await until(() => pids.filter(isRunning).length === 0, { what: "killTree ends both", ms: 5000 });
        });

        test("endIzbor ends a running Node child within 5 s", real, async (t) => {
            const { platform } = await build(t);
            const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
            t.after(() => child.kill("SIGKILL"));
            let exited = false;
            child.once("exit", () => (exited = true));
            await once(child, "spawn");

            platform.endIzbor(child.pid!);

            await until(() => exited, { what: "the child exits", ms: 5000 });
        });

        test("isAlive is true for this process and false for a child that has exited", real, async (t) => {
            const { platform } = await build(t);
            const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
            await once(child, "exit");

            assert.equal(platform.isAlive(process.pid), true);
            assert.equal(platform.isAlive(child.pid!), false);
        });

        test("run of a command that ends comes back exited, with its code and what it printed", async (t) => {
            const { platform, commands } = await build(t);
            const { command, args } = commands.prints;

            const ran = await platform.run(command, args, { timeoutMs: 10_000 });

            assert.deepEqual(ran, { outcome: "exited", code: 3, signal: null, stdout: "out", stderr: "err" });
        });

        test("run of a command that cannot start comes back not_started, and run does not reject", async (t) => {
            const { platform, commands } = await build(t);
            const { command, args } = commands.missing;

            const ran = await platform.run(command, args, { timeoutMs: 10_000 });

            assert.equal(ran.outcome, "not_started");
        });

        test("run of a command that passes its limit comes back timed_out, and run does not reject", async (t) => {
            const { platform, commands } = await build(t);
            const { command, args } = commands.hanging;

            const ran = await platform.run(command, args, { timeoutMs: 300 });

            assert.equal(ran.outcome, "timed_out");
        });

        test("run with a signal aborted before it starts comes back cancelled", async (t) => {
            const { platform, commands } = await build(t);
            const { command, args } = commands.hanging;

            const ran = await platform.run(command, args, { timeoutMs: 10_000, signal: AbortSignal.abort() });

            assert.equal(ran.outcome, "cancelled");
        });

        test("run with a signal aborted while the command runs comes back cancelled", async (t) => {
            const { platform, commands } = await build(t);
            const { command, args } = commands.hanging;
            const abort = new AbortController();

            const running = platform.run(command, args, { timeoutMs: 10_000, signal: abort.signal });
            setTimeout(() => abort.abort(), 300);

            assert.equal((await running).outcome, "cancelled");
        });

        test(
            'run hands a written command an argument with spaces, ( ), &, ^, % and " byte for byte',
            real,
            async (t) => {
                const { platform } = await build(t);
                const dir = await mkdtemp(join(tmpdir(), "izbor-command-"));
                await writeFakeCommand(dir, "echoes", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
                const argument = 'two words (and) & ^caret %PATH% "quoted"';

                const ran = await platform.run(join(dir, "echoes"), [argument], { timeoutMs: 10_000 });

                assert.deepEqual(ran, {
                    outcome: "exited",
                    code: 0,
                    signal: null,
                    stdout: JSON.stringify([argument]),
                    stderr: "",
                });
            },
        );

        test("replaceFile writes over a file, and readRegularFile reads it back", async (t) => {
            const { platform } = await build(t);
            const file = join(await mkdtemp(join(tmpdir(), "izbor-files-")), "settings.json");

            platform.replaceFile(file, "old");
            platform.replaceFile(file, "new");

            assert.equal(platform.readRegularFile(file)?.text, "new");
        });

        test("replaceFile that cannot write throws, and leaves no temp file", async (t) => {
            const { platform } = await build(t);
            const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
            mkdirSync(join(dir, "taken"));

            assert.throws(() => platform.replaceFile(join(dir, "taken"), "text"));
            assert.deepEqual(readdirSync(dir), ["taken"]);
        });

        test("readRegularFile gives null for no file, and throws `it is not a file` for a folder", async (t) => {
            const { platform } = await build(t);
            const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));

            assert.equal(platform.readRegularFile(join(dir, "missing")), null);
            assert.throws(() => platform.readRegularFile(dir), { message: "it is not a file" });
        });

        test("readRegularFile refuses a link, to a file or a folder (a junction on Windows), with `it is a link`", async (t) => {
            const { platform } = await build(t);
            const dir = await mkdtemp(join(tmpdir(), "izbor-files-"));
            writeFileSync(join(dir, "settings.json"), "{}");
            symlinkSync(dir, join(dir, "folder-link"), "junction");
            assert.throws(() => platform.readRegularFile(join(dir, "folder-link")), { message: "it is a link" });
            try {
                symlinkSync(join(dir, "settings.json"), join(dir, "file-link"));
            } catch (error) {
                if (codeOf(error) === "EPERM") return;
                throw error;
            }
            assert.throws(() => platform.readRegularFile(join(dir, "file-link")), { message: "it is a link" });
        });

        test("writePrivateFile makes its folder when missing, and the file reads back", async (t) => {
            const { platform } = await build(t);
            const file = join(await mkdtemp(join(tmpdir(), "izbor-files-")), "user", "send-key-4317");

            platform.writePrivateFile(file, "key\n");

            assert.equal(platform.readRegularFile(file)?.text, "key\n");
        });
    });
}

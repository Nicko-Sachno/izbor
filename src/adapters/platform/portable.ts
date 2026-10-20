import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    type BigIntStats,
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { BackgroundStart, DataFolderLock, Platform, Ran, RunOptions, Spawned } from "../../core/ports.js";
import { codeOf, messageOf } from "../../domain/text.js";

export type SpawnChild = (
    command: string,
    args: readonly string[],
    cwd: string | undefined,
) => ChildProcessByStdio<null, Readable, Readable>;

export const anotherIzbor = (dataDir: string) =>
    `Another Izbor is using this data folder (${dataDir}). Izbor did not start.`;

export function lockWith(exclusiveFlag: number, busyCode: "EAGAIN" | "EBUSY"): Platform["lockDataFolder"] {
    return async (dataDir: string): Promise<DataFolderLock> => {
        await mkdir(dataDir, { recursive: true });
        let file: FileHandle;
        try {
            file = await open(
                join(dataDir, "izbor.lock"),
                constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | exclusiveFlag,
            );
        } catch (err) {
            if (codeOf(err) === busyCode) throw new Error(anotherIzbor(dataDir));
            throw err;
        }
        return {
            async writeHolder(port) {
                replaceFile(join(dataDir, "izbor.holder"), `${process.pid} ${port}`);
            },
            release: () => file.close(),
        };
    };
}

export function checkedLock(lock: Platform["lockDataFolder"]): Platform["lockDataFolder"] {
    return async (dataDir: string): Promise<DataFolderLock> => {
        const first = await lock(dataDir);
        let second: DataFolderLock;
        try {
            second = await lock(dataDir);
        } catch (error) {
            if (messageOf(error) === anotherIzbor(dataDir)) return first;
            await first.release();
            throw error;
        }
        await second.release();
        await first.release();
        throw new Error(
            `This Windows did not lock the data folder (${dataDir}). Izbor did not start: please report this.`,
        );
    };
}

export function createRun(
    spawnChild: SpawnChild,
    { killTree, reachesTreeAfterExit }: Pick<Platform, "killTree" | "reachesTreeAfterExit">,
): Platform["run"] {
    return (command: string, args: readonly string[], { timeoutMs, cwd, signal }: RunOptions): Promise<Ran> =>
        new Promise((resolve) => {
            const cancelled = (): Ran => ({ outcome: "cancelled", why: messageOf(signal?.reason) });
            if (signal?.aborted) return resolve(cancelled());
            let child: ReturnType<SpawnChild>;
            try {
                child = spawnChild(command, args, cwd);
            } catch (error) {
                return resolve({ outcome: "not_started", why: messageOf(error) });
            }
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));

            let killedAs: Ran | undefined;
            const kill = (ran: Ran) => {
                killedAs ??= ran;
                if (reachesTreeAfterExit || (child.exitCode === null && child.signalCode === null))
                    return killTree(child.pid);
                child.stdout.destroy();
                child.stderr.destroy();
                done(killedAs);
            };
            const timer = setTimeout(
                () => kill({ outcome: "timed_out", why: `no answer in ${timeoutMs} ms` }),
                timeoutMs,
            );
            const onAbort = () => kill(cancelled());
            signal?.addEventListener("abort", onAbort, { once: true });
            const done = (ran: Ran) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve(ran);
            };

            child.on("error", (error) => done({ outcome: "not_started", why: error.message }));
            child.on("close", (code, killSignal) =>
                done(killedAs ?? { outcome: "exited", code, signal: killSignal, stdout, stderr }),
            );
        });
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return codeOf(error) !== "ESRCH";
    }
}

export async function startInBackground({ args, cwd, env, logFile }: BackgroundStart): Promise<Spawned> {
    let middle: ReturnType<typeof spawn>;
    try {
        middle = spawn(process.execPath, [...process.execArgv, ...args], {
            detached: true,
            cwd,
            env,
            stdio: ["ignore", "pipe", logFile],
            windowsHide: true,
        });
    } catch (error) {
        return { error: messageOf(error) };
    }
    let printed = "";
    middle.stdout!.setEncoding("utf8").on("data", (text: string) => (printed += text));
    const failed = await new Promise<Error | undefined>((resolve) => {
        middle.once("error", resolve);
        middle.once("close", () => resolve(undefined));
    });
    if (failed) return { error: `izbor could not start Izbor: ${failed.message}` };
    return /^[1-9]\d*\n$/.test(printed) ? { pid: Number(printed) } : { error: "" };
}

export const readRegularFile = readRegularFileWith((file) => lstatSync(file, { bigint: true, throwIfNoEntry: false }));

export function readRegularFileWith(lstat: (file: string) => BigIntStats | undefined): Platform["readRegularFile"] {
    return (file) => {
        for (let tries = 1; ; tries++) {
            const seen = lstat(file);
            if (seen === undefined) return null;
            if (seen.isSymbolicLink()) throw new Error("it is a link");
            const read = readIfSame(file, seen);
            if (read !== "replaced") return read;
            if (tries === 3) throw new Error("it was replaced each time it was read");
        }
    };
}

function readIfSame(file: string, seen: BigIntStats): { text: string; mode: number } | null | "replaced" {
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if (codeOf(error) === "ENOENT") return null;
        if (codeOf(error) === "ELOOP") return "replaced";
        throw error;
    }
    try {
        const stats = fstatSync(fd, { bigint: true });
        if (stats.dev !== seen.dev || stats.ino !== seen.ino) return "replaced";
        if (!stats.isFile()) throw new Error("it is not a file");
        return { mode: Number(stats.mode) & 0o777, text: readFileSync(fd, "utf8") };
    } finally {
        closeSync(fd);
    }
}

export const replaceFile = replaceFileWith(renameSync);

export function replaceFileWith(rename: (from: string, to: string) => void): Platform["replaceFile"] {
    return (file, text, mode) => {
        const temp = join(dirname(file), `.${basename(file)}.izbor-${process.pid}-${randomBytes(4).toString("hex")}`);
        const fd = openSync(temp, "wx", mode);
        try {
            try {
                writeFileSync(fd, text);
                if (mode !== undefined) fchmodSync(fd, mode);
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            renameRetried(rename, temp, file);
        } catch (error) {
            try {
                rmSync(temp, { force: true });
            } catch {}
            throw error;
        }
    };
}

const HELD_OFF = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_MS = 1_000;

function renameRetried(rename: (from: string, to: string) => void, from: string, to: string): void {
    const deadline = performance.now() + RENAME_RETRY_MS;
    for (let pause = 10; ; pause = Math.min(pause * 2, 100)) {
        try {
            return rename(from, to);
        } catch (error) {
            if (!HELD_OFF.has(codeOf(error) ?? "") || performance.now() + pause > deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
        }
    }
}

export function writePrivateFile(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    replaceFile(file, text, 0o600);
}

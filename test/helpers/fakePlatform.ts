import { selectPlatform } from "../../src/adapters/platform/select.js";
import type { BackgroundStart, Platform, Ran, RunOptions, Spawned } from "../../src/core/ports.js";

export const hostPlatform = (): Platform => selectPlatform(process.platform);

export const runAs =
    (command: string): Platform["run"] =>
    (_command, args, options) =>
        hostPlatform().run(command, args, options);

// Runs a fake command's .js through this node rather than exec'ing the fresh executable: macOS assesses a
// newly written executable on its first exec, and under load that alone outlasts a 5 s command deadline.
export const runScript =
    (script: string): Platform["run"] =>
    (_command, args, options) =>
        hostPlatform().run(process.execPath, [script, ...args], options);

export const OWNS_FILES_BY_UID = { ownsFilesByUid: true } as const;

type FakePlatformOptions = {
    runs?: Record<string, Ran | "hangs">;
    isAlive?: (pid: number) => boolean;
    spawns?: Spawned[];
    reachesTreeAfterExit?: boolean;
    ownsFilesByUid?: boolean;
    dropsMouseClicks?: boolean;
};

type FakePlatformHandles = {
    ran: readonly { command: string; args: readonly string[]; options: RunOptions }[];
    killed: readonly (number | undefined)[];
    ended: readonly number[];
    started: readonly BackgroundStart[];
};

export function fakePlatform({
    runs = {},
    isAlive = () => false,
    spawns = [],
    reachesTreeAfterExit = true,
    ownsFilesByUid = true,
    dropsMouseClicks = false,
}: FakePlatformOptions = {}): Platform & FakePlatformHandles {
    const ran: { command: string; args: readonly string[]; options: RunOptions }[] = [];
    const killed: (number | undefined)[] = [];
    const ended: number[] = [];
    const started: BackgroundStart[] = [];
    const left = [...spawns];
    const host = hostPlatform();
    return {
        lockDataFolder: host.lockDataFolder,
        run(command, args, options) {
            ran.push({ command, args, options });
            const { timeoutMs, signal } = options;
            const cancelled: Ran = { outcome: "cancelled", why: "the test aborted the signal" };
            if (signal?.aborted) return Promise.resolve(cancelled);
            const answer = runs[command];
            if (answer === undefined)
                return Promise.resolve({ outcome: "not_started", why: `the test named no command ${command}` });
            if (answer !== "hangs") return Promise.resolve(answer);
            return new Promise((resolve) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    resolve(cancelled);
                };
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve({ outcome: "timed_out", why: `no answer in ${timeoutMs} ms` });
                }, timeoutMs);
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        },
        killTree: (pid) => void killed.push(pid),
        reachesTreeAfterExit,
        isAlive,
        endIzbor: (pid) => void ended.push(pid),
        async startInBackground(start) {
            started.push(start);
            return left.shift() ?? { error: "the test gave no more spawns" };
        },
        writePrivateFile: host.writePrivateFile,
        replaceFile: host.replaceFile,
        readRegularFile: host.readRegularFile,
        ownsFilesByUid,
        dropsMouseClicks: () => dropsMouseClicks,
        refusedConnectMs: host.refusedConnectMs,
        ran,
        killed,
        ended,
        started,
    };
}

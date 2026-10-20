import { spawn } from "node:child_process";
import type { Platform } from "../../core/ports.js";
import { codeOf } from "../../domain/text.js";
import {
    createRun,
    isAlive,
    lockWith,
    readRegularFile,
    replaceFile,
    type SpawnChild,
    startInBackground,
    writePrivateFile,
} from "./portable.js";

const O_EXLOCK = 0x20;

const spawnChild: SpawnChild = (command, args, cwd) =>
    spawn(command, [...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });

const REKILL_MS = 50;
const REKILLS = 100;

// A process forked while the group SIGKILL is delivered can miss it: it stays in the group and holds the
// pipes open. So kill the group again until it is gone.
function killTree(pid: number | undefined): void {
    if (pid) killGroup(pid, REKILLS);
}

function killGroup(pid: number, rekills: number): void {
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        return;
    }
    if (rekills > 0) setTimeout(() => killGroup(pid, rekills - 1), REKILL_MS).unref();
}

function endIzbor(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch (error) {
        if (codeOf(error) !== "ESRCH" && codeOf(error) !== "EPERM") throw error;
    }
}

const reachesTreeAfterExit = true;

export const darwin: Platform = {
    lockDataFolder: lockWith(O_EXLOCK, "EAGAIN"),
    run: createRun(spawnChild, { killTree, reachesTreeAfterExit }),
    killTree,
    reachesTreeAfterExit,
    isAlive,
    endIzbor,
    startInBackground,
    writePrivateFile,
    replaceFile,
    readRegularFile,
    ownsFilesByUid: true,
    dropsMouseClicks: () => false,
    refusedConnectMs: Infinity,
};

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { win32 as windowsPath } from "node:path";
import crossSpawn from "cross-spawn";
import type { Platform } from "../../core/ports.js";
import {
    checkedLock,
    createRun,
    isAlive,
    lockWith,
    readRegularFile,
    replaceFile,
    type SpawnChild,
    startInBackground,
    writePrivateFile,
} from "./portable.js";

const EXCLUSIVE = 0x10000000;

const variable = (env: NodeJS.ProcessEnv, name: string) =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

export function onPath(command: string, env: NodeJS.ProcessEnv, isFile: (file: string) => boolean): string {
    if (/[\\/]/.test(command)) return command;
    const extensions = (variable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    if (command.includes(".")) extensions.unshift("");
    for (const entry of (variable(env, "PATH") ?? "").split(";")) {
        const folder = entry.replace(/^"(.*)"$/, "$1");
        if (!windowsPath.isAbsolute(folder)) continue;
        for (const extension of extensions) {
            const file = windowsPath.join(folder, command + extension);
            if (isFile(file)) return file;
        }
    }
    throw new Error(`${command} is not on PATH`);
}

const isFile = (file: string) => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

const spawnChild: SpawnChild = (command, args, cwd) =>
    crossSpawn.spawn(onPath(command, process.env, isFile), [...args], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });

function killTree(pid: number | undefined): void {
    if (!pid) return;
    const taskkill = windowsPath.join(variable(process.env, "SYSTEMROOT") ?? "C:\\Windows", "System32", "taskkill.exe");
    spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
}

const reachesTreeAfterExit = false;

export const win32: Platform = {
    lockDataFolder: checkedLock(lockWith(EXCLUSIVE, "EBUSY")),
    run: createRun(spawnChild, { killTree, reachesTreeAfterExit }),
    killTree,
    reachesTreeAfterExit,
    isAlive,
    endIzbor: killTree,
    startInBackground,
    writePrivateFile,
    replaceFile,
    readRegularFile,
    ownsFilesByUid: false,
    dropsMouseClicks: (env) => !env.WT_SESSION && !env.TERM_PROGRAM,
    refusedConnectMs: 500,
};

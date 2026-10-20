import { join } from "node:path";
import type { IzborAnswer, IzborClient } from "../../adapters/izbor/client.js";
import type { CliArgs } from "../args.js";
import { LOG_FILE, izborAddress, type ScreenFlags, STOP_TIMEOUT_MS } from "../../config.js";
import type { Platform, Spawned, Wait } from "../../core/ports.js";
import type { IzborInfo } from "../../domain/wire.js";
import { isThisBin, STALE_BUILD_NOTE, startedBeforeBuild } from "./checkout.js";
import { notAnswering, notIzbor } from "./report.js";

export type Ensured = { info: IzborInfo | "older"; feedback: string; notes: string[] };

export type OpenArgs = Extract<CliArgs, { command: "open" }>;

export const PROBE_EVERY_MS = 100;
export const MOUSE_OFF =
    "Mouse is off: this may be the old console window. For the mouse, open Izbor in a new Windows Terminal tab.";
export const VS_CODE_TITLE =
    "In VS Code, set terminal.integrated.tabs.title to ${sequence} to see when a session needs you.";

const STOPPING_WAIT_MS = STOP_TIMEOUT_MS + 1_000;
const START_WAIT_MS = 8_000;
const START_EVERY_MS = 1_000;

export async function ensureIzbor({ port }: OpenArgs, deps: OpenDeps): Promise<Ensured | { error: string }> {
    const izbor = await waitForPendingStop(port, deps);
    if ("error" in izbor) {
        return izbor;
    }

    const ready = await startOrReuseIzbor(izbor, port, deps);
    if ("error" in ready) {
        return ready;
    }

    return describeIzbor(ready.info, ready.spawnedPid, port, deps);
}

export function forConsole(
    screen: ScreenFlags,
    feedback: string,
    dropsMouseClicks: boolean,
    env: Record<string, string | undefined>,
) {
    const mouseOff = screen.mouse && dropsMouseClicks;
    const lines = [feedback];
    if (mouseOff) {
        lines.push(MOUSE_OFF);
    }
    if (env.TERM_PROGRAM === "vscode") {
        lines.push(VS_CODE_TITLE);
    }

    return {
        screen: mouseOff ? { ...screen, mouse: false } : screen,
        feedback: lines.filter((line) => line !== "").join(" · "),
    };
}

async function waitForPendingStop(
    port: number,
    { client, wait, nowMs: now }: Pick<OpenDeps, "client" | "wait" | "nowMs">,
): Promise<IzborAnswer | { error: string }> {
    let izbor = await client.getIzbor();
    const stoppingSince = now();

    while ("away" in izbor && izbor.away === "stopping") {
        if (now() - stoppingSince >= STOPPING_WAIT_MS) {
            return {
                error: `Izbor on ${port} is still stopping after ${STOPPING_WAIT_MS / 1000} s. Izbor did not start.`,
            };
        }
        await wait(PROBE_EVERY_MS);
        izbor = await client.getIzbor();
    }

    return izbor;
}

async function startOrReuseIzbor(
    izbor: IzborAnswer,
    port: number,
    { client, platform, wait, nowMs: now, startInBackground, lastLogLine }: OpenDeps,
): Promise<{ info: IzborInfo | "older"; spawnedPid: number | undefined } | { error: string }> {
    const startsSince = now();
    let spawned: { pid: number; at: number } | undefined;

    while ("away" in izbor && izbor.away !== "not answering") {
        if (now() - startsSince >= START_WAIT_MS) {
            endSpawnedIzbor(spawned?.pid, platform);
            return { error: lastLogLine() };
        }

        const mayStart = !spawned || (!platform.isAlive(spawned.pid) && now() - spawned.at >= START_EVERY_MS);
        if (izbor.away === "not running" && mayStart) {
            const at = now();
            const started = await startInBackground();
            if ("error" in started) {
                return started;
            }
            spawned = { pid: started.pid, at };
        }

        await wait(PROBE_EVERY_MS);
        izbor = await client.getIzbor();
    }

    switch (true) {
        case "foreign" in izbor:
            endSpawnedIzbor(spawned?.pid, platform);
            return { error: notIzbor(port, izbor.foreign, "Izbor did not start.").join("\n") };
        case "away" in izbor:
            endSpawnedIzbor(spawned?.pid, platform);
            return { error: notAnswering(port, "Izbor did not start.") };
        default:
            return { info: izbor.up, spawnedPid: spawned?.pid };
    }
}

function endSpawnedIzbor(pid: number | undefined, platform: OpenDeps["platform"]): void {
    if (pid !== undefined && platform.isAlive(pid)) {
        platform.endIzbor(pid);
    }
}

function describeIzbor(
    info: IzborInfo | "older",
    spawnedPid: number | undefined,
    port: number,
    { builtAt, which }: Pick<OpenDeps, "builtAt" | "which">,
): Ensured {
    const feedback: string[] = [];
    const notes: string[] = [];
    const addNote = (text: string) => {
        feedback.push(text);
        notes.push(text);
    };

    if (info !== "older" && info.pid === spawnedPid) {
        const started = `Started Izbor in the background · pid ${info.pid}`;
        feedback.push(started);
        notes.push(
            `${started} · ${izborAddress(port)} · log ${join(info.dataDir, LOG_FILE)}`,
            "It keeps running when you close this window. Stop it with: izbor stop",
        );
    }

    if (info === "older") {
        addNote(`An older Izbor runs on ${izborAddress(port)}.`);
    }
    if (startedBeforeBuild(info, builtAt())) {
        addNote(STALE_BUILD_NOTE);
    }
    const onPath = which();
    if (onPath !== undefined && !isThisBin(onPath)) {
        addNote(`izbor on PATH is not this checkout: ${onPath}`);
    }

    return { info, feedback: feedback.join(" · "), notes };
}

type OpenDeps = {
    client: Pick<IzborClient, "getIzbor">;
    platform: Pick<Platform, "isAlive" | "endIzbor">;
    which: () => string | undefined;
    wait: Wait;
    nowMs: () => number;
    startInBackground: () => Promise<Spawned>;
    lastLogLine: () => string;
    builtAt: () => number | undefined;
};

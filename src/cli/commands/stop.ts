import type { IzborClient } from "../../adapters/izbor/client.js";
import type { CliArgs } from "../args.js";
import { izborAddress, STOP_TIMEOUT_MS } from "../../config.js";
import type { Platform, Wait } from "../../core/ports.js";
import { PROBE_EVERY_MS } from "./open.js";
import { counted } from "../../domain/text.js";
import { notAnswering, notIzbor, type CommandReport } from "./report.js";

export type StopArgs = Extract<CliArgs, { command: "stop" }>;

const STOP_WAIT_MS = STOP_TIMEOUT_MS + 2_000;
const STOPPED_NOTHING = "izbor stop stopped nothing.";
const STOPPED_UNASKED = "Izbor stopped without being asked: records still waiting may be lost.";

export async function runStop(
    { port, yes }: StopArgs,
    { client, readKey, platform, ask, wait, nowMs: now }: StopDeps,
): Promise<CommandReport<0 | 1>> {
    const found = await findIzborToStop(port, client);
    if (!("pid" in found)) {
        return found;
    }
    const { pid, sendKeyPath } = found;

    if (ask && !yes) {
        const confirmation = await confirmStop(port, pid, client, ask);
        if (confirmation !== undefined) {
            return confirmation;
        }
    }

    const asked = await requestStop({ client, readKey }, sendKeyPath);
    if (!asked) {
        platform.endIzbor(pid);
    }

    const since = now();
    while (platform.isAlive(pid)) {
        if (now() - since >= STOP_WAIT_MS) {
            return { lines: [stillRuns(pid)], code: 1 };
        }
        await wait(PROBE_EVERY_MS);
    }
    return { lines: [asked ? "Izbor stopped." : STOPPED_UNASKED], code: 0 };
}

async function findIzborToStop(
    port: number,
    client: Pick<IzborClient, "getIzbor">,
): Promise<StopTarget | CommandReport<0 | 1>> {
    const izbor = await client.getIzbor();
    if ("foreign" in izbor) {
        return { lines: notIzbor(port, izbor.foreign, STOPPED_NOTHING), code: 1 };
    }
    if ("away" in izbor) {
        switch (izbor.away) {
            case "not running":
                return { lines: ["Izbor is not running."], code: 0 };
            case "stopping":
                return { lines: [`Izbor on ${port} is already stopping.`], code: 0 };
            case "not answering":
                return { lines: [notAnswering(port, STOPPED_NOTHING)], code: 1 };
        }
    }
    if (izbor.up === "older") {
        return {
            lines: [
                `An older Izbor runs on ${izborAddress(port)}. It names no pid: stop it with Ctrl-C where it runs.`,
            ],
            code: 1,
        };
    }
    return { pid: izbor.up.pid, sendKeyPath: izbor.up.sendKeyPath };
}

async function confirmStop(
    port: number,
    pid: number,
    client: Pick<IzborClient, "getIzbor" | "getSessions">,
    ask: (question: string) => Promise<string>,
): Promise<CommandReport<0 | 1> | undefined> {
    const question = await stopQuestion(client);
    if (question === undefined) {
        return undefined;
    }

    const answer = (await ask(question)).trim();
    if (!/^y(es)?$/i.test(answer)) {
        return { lines: ["Izbor keeps running."], code: 1 };
    }

    const again = await findIzborToStop(port, client);
    if (!("pid" in again)) {
        return again;
    }
    if (again.pid !== pid) {
        return {
            lines: [`Another Izbor (pid ${again.pid}) runs on ${port} now. ${STOPPED_NOTHING}`],
            code: 1,
        };
    }
    return undefined;
}

async function stopQuestion(client: Pick<IzborClient, "getSessions">): Promise<string | undefined> {
    const sessions = await client.getSessions();
    if (!("sessions" in sessions)) {
        return "Izbor did not say who listens. Stop Izbor for every window? [y/N]";
    }

    const listened = sessions.sessions.filter(({ listeners }) => listeners > 0);
    const listeners = listened.reduce((sum, { listeners }) => sum + listeners, 0);
    if (listeners === 0) {
        return undefined;
    }
    return (
        `Izbor has ${counted(listeners, "listener")} on ${counted(listened.length, "session")}. ` +
        "Stop Izbor for every window? [y/N]"
    );
}

async function requestStop({ client, readKey }: Pick<StopDeps, "client" | "readKey">, sendKeyPath: string) {
    const taken = await readKey(sendKeyPath).then(
        (key) => client.requestStop(key.trim()),
        () => false,
    );
    if (taken) {
        return true;
    }
    const izbor = await client.getIzbor();
    return "away" in izbor && izbor.away !== "not answering";
}

function stillRuns(pid: number): string {
    return `Izbor (pid ${pid}) still runs ${STOP_WAIT_MS / 1000} s after it was asked to stop: hung, or another user's.`;
}

type StopTarget = { pid: number; sendKeyPath: string };

type StopDeps = {
    client: Pick<IzborClient, "getIzbor" | "getSessions" | "requestStop">;
    readKey: (path: string) => Promise<string>;
    platform: Pick<Platform, "isAlive" | "endIzbor">;
    ask: ((question: string) => Promise<string>) | null;
    wait: Wait;
    nowMs: () => number;
};

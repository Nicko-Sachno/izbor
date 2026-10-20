import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IzborAnswer, IzborClient } from "../../adapters/izbor/client.js";
import type { CliArgs } from "../args.js";
import { LOG_FILE, izborAddress, tilde } from "../../config.js";
import { shortId } from "../../domain/text.js";
import { isThisBin, STALE_BUILD_NOTE, startedBeforeBuild } from "./checkout.js";
import { notAnswering, notIzbor, type CommandReport } from "./report.js";

export type StatusArgs = Extract<CliArgs, { command: "status" }>;

export async function runStatus(
    { port, diskUsage }: StatusArgs,
    { client, which, builtAt, now, home }: StatusDeps,
): Promise<CommandReport<0 | 1 | 3>> {
    const izbor = await client.getIzbor();
    const onPath = pathLine(which());
    if ("foreign" in izbor) {
        return { lines: [...notIzbor(port, izbor.foreign), onPath], code: 1 };
    }
    if ("away" in izbor) {
        return unavailableReport(port, izbor.away, onPath);
    }

    const info = izbor.up;
    const lines: string[] = [];
    if (info === "older") {
        lines.push(`An older Izbor runs on ${izborAddress(port)}. It names no pid, data folder or start time.`);
    } else {
        const uptime = duration(now() - Date.parse(info.startedAt));
        lines.push(`Izbor runs · pid ${info.pid} · ${izborAddress(port)} · up ${uptime}`);
        lines.push(dataFolderLine(info.dataDir, diskUsage, home));
    }

    const sessions = await client.getSessions();
    lines.push(watchesLine(sessions));
    lines.push(onPath);
    if (startedBeforeBuild(info, builtAt())) {
        lines.push(STALE_BUILD_NOTE);
    }

    return { lines, code: 0 };
}

function unavailableReport(port: number, reason: AwayReason, onPath: string): CommandReport<0 | 1 | 3> {
    switch (reason) {
        case "not running":
            return { lines: ["Izbor is not running.", onPath], code: 3 };
        case "stopping":
            return { lines: [`Izbor on ${port} is stopping.`, onPath], code: 0 };
        case "not answering":
            return { lines: [notAnswering(port), onPath], code: 1 };
    }
}

function dataFolderLine(folder: string, diskUsage: boolean, home: string): string {
    const bytes = diskUsage ? folderBytes(folder) : undefined;
    const log = existsSync(join(folder, LOG_FILE)) ? ` · log ${LOG_FILE}` : "";
    const size = bytes === undefined ? "" : ` (${megabytes(bytes)})`;
    return `Data folder ${tilde(folder, home)}${size}${log}`;
}

function watchesLine(result: SessionsResult): string {
    if (!("sessions" in result)) {
        const reason = "away" in result ? `Izbor is ${result.away}` : result.message;
        return `Watches: unknown (${reason})`;
    }
    if (result.sessions.length === 0) {
        return "Watches: none";
    }

    const watches = result.sessions.map(({ sessionId, listeners }) => {
        const listening = listeners === 0 ? "nobody listening, ends within 30 s" : `${listeners} listening`;
        return `${shortId(sessionId)} (${listening})`;
    });
    return `Watches: ${watches.join(", ")}`;
}

function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return `${seconds} s`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min`;
    }

    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function megabytes(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function folderBytes(dir: string): number | undefined {
    const folders = [dir];
    let bytes = 0;
    while (true) {
        const folder = folders.pop();
        if (folder === undefined) {
            return bytes;
        }

        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            if (folder === dir) {
                return undefined;
            }
            continue;
        }

        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                folders.push(path);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }

            try {
                bytes += statSync(path).size;
            } catch {}
        }
    }
}

function pathLine(onPath: string | undefined): string {
    if (onPath === undefined) {
        return "No izbor on PATH";
    }

    return isThisBin(onPath) ? "izbor on PATH → this checkout" : `izbor on PATH → ${onPath}, not this checkout`;
}

type StatusDeps = {
    client: Pick<IzborClient, "getIzbor" | "getSessions">;
    which: () => string | undefined;
    builtAt: () => number | undefined;
    now: () => number;
    home: string;
};

type AwayReason = Extract<IzborAnswer, { away: string }>["away"];
type SessionsResult = Awaited<ReturnType<IzborClient["getSessions"]>>;

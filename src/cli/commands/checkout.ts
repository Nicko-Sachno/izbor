import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { PROJECT_DIR } from "../../config.js";
import type { IzborInfo } from "../../domain/wire.js";
import type { CommandReport } from "./report.js";

export const THIS_BIN = join(PROJECT_DIR, "bin", "izbor.js");
export const DETACH = join(PROJECT_DIR, "bin", "detach.js");
export const STALE_BUILD_NOTE = "Izbor started before your last build: izbor stop, then izbor";

const BUILT_CLI = join(PROJECT_DIR, "dist", "cli", "main.js");

export function whichIzbor(path: string): string | undefined {
    for (const dir of path.split(delimiter)) {
        const folder = dir || ".";
        const shimmed = cmdShimTarget(join(folder, "izbor.cmd"));
        if (shimmed !== undefined) {
            return shimmed;
        }

        const executable = executablePath(join(folder, "izbor"));
        if (executable !== undefined) {
            return executable;
        }
    }

    return undefined;
}

export function isThisBin(onPath: string): boolean {
    const [pathFile, checkoutFile] = [onPath, THIS_BIN].map((file) =>
        statSync(file, { bigint: true, throwIfNoEntry: false }),
    );
    return (
        pathFile !== undefined &&
        checkoutFile !== undefined &&
        pathFile.dev === checkoutFile.dev &&
        pathFile.ino === checkoutFile.ino
    );
}

export function lastBuildAt(): number | undefined {
    try {
        return statSync(BUILT_CLI).mtimeMs;
    } catch {
        return undefined;
    }
}

export const startedBeforeBuild = (info: IzborInfo | "older", builtAt: number | undefined) =>
    info !== "older" && builtAt !== undefined && Date.parse(info.startedAt) < builtAt;

export function versionReport(builtAt: number | undefined): CommandReport<0 | 1> {
    if (builtAt === undefined) {
        return { lines: ["izbor has no build: run npm run build"], code: 1 };
    }

    const built = new Date(builtAt);
    const day = `${built.getFullYear()}-${twoDigits(built.getMonth() + 1)}-${twoDigits(built.getDate())}`;
    const time = `${twoDigits(built.getHours())}:${twoDigits(built.getMinutes())}`;
    return { lines: [`izbor built ${day} ${time}`], code: 0 };
}

function cmdShimTarget(shim: string): string | undefined {
    try {
        const target = /"%dp0%\\([^"]*\.js)"/i.exec(readFileSync(shim, "utf8"))?.[1];
        if (target === undefined) {
            return undefined;
        }

        return realpathSync.native(join(dirname(shim), ...target.split("\\")));
    } catch {
        return undefined;
    }
}

function executablePath(file: string): string | undefined {
    try {
        if (!statSync(file).isFile()) {
            return undefined;
        }

        accessSync(file, constants.X_OK);
        return realpathSync(file);
    } catch {
        return undefined;
    }
}

const twoDigits = (part: number) => String(part).padStart(2, "0");

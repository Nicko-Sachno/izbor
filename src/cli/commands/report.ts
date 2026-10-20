import { realpathSync } from "node:fs";
import { tilde } from "../../config.js";
import type { SettingsChange } from "../../domain/projectSetup.js";

export type CommandReport<Code extends number> = { lines: string[]; code: Code };

export function notIzbor(port: number, foreign: string, outcome = ""): string[] {
    const outcomeSuffix = outcome ? ` ${outcome}` : "";
    return [
        `Port ${port} answers, but not as Izbor.${outcomeSuffix}`,
        `${foreign}; see lsof -nP -iTCP:${port} (Windows: netstat -ano | findstr :${port})`,
    ];
}

export function notAnswering(port: number, outcome = ""): string {
    const outcomeSuffix = outcome ? ` ${outcome}` : "";
    return `Izbor on ${port} does not answer (hung, or paused?).${outcomeSuffix}`;
}

export const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function settingsReport<Done extends string>(
    command: string,
    result: SettingsChange<Done>,
    home: string,
    describeChange: (done: Done, file: string, checkout: string) => string | string[],
): CommandReport<0 | 1> {
    const realHome = realPathOrOriginal(home);
    const displayPath = (path: string) => tilde(tilde(path, realHome), home);
    const refused = (line: string): CommandReport<1> => ({ lines: [line], code: 1 });

    if ("done" in result) {
        const lines = describeChange(result.done, displayPath(result.file), displayPath(result.checkout));
        return { lines: [lines].flat(), code: 0 };
    }

    switch (result.refused) {
        case "no folder":
            return refused(`No folder ${displayPath(result.folder)}.`);
        case "no access":
            return refused(`Izbor may not look in ${displayPath(result.folder)}: ${result.why}`);
        case "home folder":
            return refused(`${command} needs a project folder, not your home folder.`);
        case "link":
            return refused(`${displayPath(result.link)} is a link; Izbor changed nothing.`);
        case "settings":
            return refused(`${displayPath(result.file)} ${result.why}; Izbor changed nothing.`);
        case "write":
            return refused(`Izbor could not write ${displayPath(result.file)}: ${result.why}`);
    }
}

function realPathOrOriginal(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

import { lstatSync, mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import type { Platform } from "../../../../core/ports.js";
import type { SettingsChange } from "../../../../domain/projectSetup.js";
import { messageOf } from "../../../../domain/text.js";
import { checkoutOf, type FileOwnership, settingsFileOf } from "./projectFiles.js";

export type ProjectLocation = { checkout: string; file: string };

export function locateProject({ folder, home, platform }: LocateRequest): ProjectLocation | LocateRefusal {
    const requestedFolder = resolve(folder);
    const realFolder = realPathOrOriginal(requestedFolder);
    if (!isFolder(realFolder)) {
        return { refused: "no folder", folder: requestedFolder };
    }

    let checkout: string;
    try {
        checkout = checkoutOf(realFolder, platform);
        if ([realFolder, checkout].some((path) => isHomeOrRoot(path, home))) {
            return { refused: "home folder" };
        }
    } catch (error) {
        return { refused: "no access", folder: requestedFolder, why: messageOf(error) };
    }

    const file = settingsFileOf(checkout);
    for (const link of [dirname(file), file]) {
        if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
            return { refused: "link", checkout, file, link };
        }
    }

    return { checkout, file };
}

export function changeProjectSettings<Done extends string>({
    folder,
    home,
    edit,
    platform,
}: ChangeRequest<Done>): SettingsChange<Done> {
    const located = locateProject({ folder, home, platform });
    if ("refused" in located) {
        return located;
    }

    return editProjectSettings(platform, located, edit);
}

export function editProjectSettings<Done extends string>(
    platform: Pick<Platform, "readRegularFile" | "replaceFile">,
    location: ProjectLocation,
    edit: (text: string | null) => SettingsEdit<Done>,
    { preview = false } = {},
): SettingsChange<Done> {
    const { file } = location;
    const settingsFolder = dirname(file);
    let done: Done;

    try {
        const current = platform.readRegularFile(file);
        const next = edit(current?.text ?? null);
        if ("refused" in next) {
            return { refused: "settings", ...location, why: next.refused };
        }

        done = next.done;
        if (!("text" in next) || preview) {
            return { done, ...location };
        }

        replaceSettingsFile(platform, settingsFolder, file, next.text, current?.mode);
    } catch (error) {
        return { refused: "write", ...location, why: messageOf(error) };
    }

    return { done, ...location };
}

function replaceSettingsFile(
    platform: Pick<Platform, "replaceFile">,
    folder: string,
    file: string,
    text: string,
    mode: number | undefined,
): void {
    const createdFolder = !lstatSync(folder, { throwIfNoEntry: false });
    if (createdFolder) {
        mkdirSync(folder);
    }

    try {
        platform.replaceFile(file, text, mode);
    } catch (error) {
        if (createdFolder) {
            removeEmptyFolder(folder);
        }
        throw error;
    }
}

function removeEmptyFolder(folder: string): void {
    try {
        rmdirSync(folder);
    } catch {
        // Preserve the write failure if cleanup fails too.
    }
}

function realPathOrOriginal(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

function isFolder(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isHomeOrRoot(folder: string, home: string): boolean {
    return sameFolder(folder, parse(folder).root) || sameFolder(folder, home);
}

function sameFolder(first: string, second: string): boolean {
    const [firstFolder, secondFolder] = [first, second].map((path) =>
        statSync(path, { bigint: true, throwIfNoEntry: false }),
    );

    return (
        firstFolder !== undefined &&
        secondFolder !== undefined &&
        firstFolder.dev === secondFolder.dev &&
        firstFolder.ino === secondFolder.ino
    );
}

type SettingsEdit<Done extends string> = { text: string; done: Done } | { done: Done } | { refused: string };

type LocateRefusal = Extract<SettingsChange<never>, { refused: "no folder" | "no access" | "home folder" | "link" }>;

type LocateRequest = { folder: string; home: string; platform: FileOwnership };

type ChangeRequest<Done extends string> = {
    folder: string;
    home: string;
    edit: (text: string | null) => SettingsEdit<Done>;
    platform: Pick<Platform, "readRegularFile" | "replaceFile" | "ownsFilesByUid">;
};

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Platform } from "../../../../core/ports.js";
import { readJson } from "../../../../domain/text.js";

export type FileOwnership = Pick<Platform, "ownsFilesByUid">;

export function checkoutOf(cwd: string, platform: FileOwnership): string {
    const start = resolve(cwd);
    if (!platform.ownsFilesByUid) {
        return start;
    }

    for (let folder = start; ; folder = dirname(folder)) {
        if (isFolderOrFile(join(folder, ".git"))) {
            return mainCheckoutOf(folder, start);
        }
        if (dirname(folder) === folder) {
            return start;
        }
    }
}

export const settingsFileOf = (checkout: string) => join(checkout, ".claude", "settings.local.json");

export function readSettingsFile(file: string): unknown {
    try {
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
            return undefined;
        }
        return readJson(readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

function mainCheckoutOf(root: string, cwd: string): string {
    let pointer: string;
    try {
        pointer = readFileSync(join(root, ".git"), "utf8").trim();
    } catch {
        return root;
    }
    if (!pointer.startsWith("gitdir:")) {
        return root;
    }

    const gitDirectory = resolve(root, pointer.slice("gitdir:".length).trim());
    const commonText = plainFileText(join(gitDirectory, "commondir"));
    if (commonText === undefined) {
        return root;
    }

    const commonDirectory = resolve(gitDirectory, commonText);
    if (dirname(gitDirectory) !== join(commonDirectory, "worktrees")) {
        return root;
    }
    if (!pointsBackToCheckout(gitDirectory, root)) {
        return root;
    }

    if (basename(commonDirectory) !== ".git") {
        return existsSync(join(commonDirectory, ".git")) ? root : cwd;
    }
    return dirname(commonDirectory);
}

function pointsBackToCheckout(gitDirectory: string, root: string): boolean {
    const backPointer = plainFileText(join(gitDirectory, "gitdir"));
    const realRoot = realPath(root);
    if (backPointer === undefined || realRoot === undefined) {
        return false;
    }
    return realPath(resolve(gitDirectory, backPointer)) === join(realRoot, ".git");
}

function plainFileText(path: string): string | undefined {
    try {
        return lstatSync(path).isFile() ? readFileSync(path, "utf8").trim() : undefined;
    } catch {
        return undefined;
    }
}

function isFolderOrFile(path: string): boolean {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats !== undefined && (stats.isDirectory() || stats.isFile());
}

function realPath(path: string): string | undefined {
    try {
        return realpathSync.native(path);
    } catch {
        return undefined;
    }
}

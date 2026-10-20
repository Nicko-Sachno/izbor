#!/usr/bin/env node
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE_NEEDED = "24.3.0";

function recentEnough(version) {
    const have = version.split(".").map((part) => parseInt(part, 10));
    const need = NODE_NEEDED.split(".").map((part) => parseInt(part, 10));
    for (let part = 0; part < 3; part++) {
        if (have[part] > need[part]) return true;
        if (have[part] < need[part]) return false;
    }
    return true;
}

if (!recentEnough(process.versions.node)) {
    process.stderr.write(`izbor needs Node ${NODE_NEEDED} or later, found ${process.version}\n`);
    process.exit(1);
}

function newestFileMs(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    } catch {
        return 0;
    }
    let newest = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
            const { mtimeMs } = statSync(join(entry.parentPath, entry.name));
            if (mtimeMs > newest) newest = mtimeMs;
        } catch {}
    }
    return newest;
}

const repo = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
let cli = process.env.IZBOR_CLI;
if (!cli) {
    cli = join(repo, "dist", "cli", "main.js");
    let builtMs;
    try {
        builtMs = statSync(cli).mtimeMs;
    } catch {
        process.stderr.write(`izbor has no build to run: run npm run build in ${repo}\n`);
        process.exit(1);
    }
    if (builtMs < newestFileMs(join(repo, "src"))) process.env.IZBOR_OLD_BUILD = "1";
    else delete process.env.IZBOR_OLD_BUILD;
}
await import(pathToFileURL(cli).href);

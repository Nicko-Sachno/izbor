import { homedir } from "node:os";
import { selectPlatform } from "./adapters/platform/select.js";
import { type Config, PROJECT_DIR, readConfig } from "./config.js";
import type { Platform } from "./core/ports.js";
import { messageOf } from "./domain/text.js";
import { serveInForeground } from "./foreground.js";

function fail(why: unknown): never {
    process.stderr.write(`${messageOf(why)}\n`);
    process.exit(1);
}

function readStart(): { config: Config; platform: Platform } {
    try {
        return {
            config: readConfig(process.argv.slice(2), process.env, homedir(), PROJECT_DIR),
            platform: selectPlatform(process.platform),
        };
    } catch (err) {
        fail(err);
    }
}

const { config, platform } = readStart();

await serveInForeground({ ...config, platform }).catch(fail);

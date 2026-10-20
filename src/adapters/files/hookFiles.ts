import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HookFile } from "../../core/hookFile.js";

export function createHookFiles(dir: string): HookFile {
    let last: Promise<void> = Promise.resolve();

    return {
        append(record) {
            const write = last.then(async () => {
                await mkdir(dir, { recursive: true });
                await appendFile(join(dir, `${record.sessionId}.hooks.ndjson`), `${JSON.stringify(record)}\n`);
            });
            last = write.catch(() => {});
            return write;
        },
    };
}

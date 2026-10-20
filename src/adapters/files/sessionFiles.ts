import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionFiles } from "../../core/sessionSync.js";
import { codeOf, isObject, readJson } from "../../domain/text.js";

const toNdjson = (records: object[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

async function readEventRecords(file: string): Promise<string[]> {
    const content = await readFile(file, "utf8").catch((error: unknown) => {
        if (codeOf(error) !== "ENOENT") throw error;
        return "";
    });
    return content.split("\n").filter((line) => {
        const record = readJson(line);
        return isObject(record) && record.kind === "event";
    });
}

export function createSessionFiles(dir: string): SessionFiles {
    const fileOf = (sessionId: string) => join(dir, `${sessionId}.ndjson`);

    return {
        exists: (sessionId) =>
            access(fileOf(sessionId)).then(
                () => true,
                () => false,
            ),

        async append(sessionId, records) {
            await mkdir(dir, { recursive: true });
            await appendFile(fileOf(sessionId), toNdjson(records));
        },

        async replaceMessages(sessionId, messages) {
            const file = fileOf(sessionId);
            await mkdir(dir, { recursive: true });
            const events = await readEventRecords(file);
            const temp = `${file}.izbor-${randomBytes(4).toString("hex")}.tmp`;
            try {
                await writeFile(temp, toNdjson(messages) + events.map((json) => `${json}\n`).join(""));
                await rename(temp, file);
            } catch (err) {
                try {
                    await rm(temp, { force: true });
                } catch {}
                throw err;
            }
        },
    };
}

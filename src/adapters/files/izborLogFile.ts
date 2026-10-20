import { fstatSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { codeOf } from "../../domain/text.js";

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const NODE_VERSION_LINE = /^Node\.js v\d/;

export function izborLog(path: string) {
    let from: number | undefined;
    return {
        open(): number {
            let renamed = false;
            try {
                if (statSync(path).size > LOG_MAX_BYTES) {
                    renameSync(path, `${path}.old`);
                    renamed = true;
                }
            } catch (error) {
                if (codeOf(error) !== "ENOENT") throw error;
            }
            const file = openSync(path, "a");
            if (from === undefined || renamed) from = fstatSync(file).size;
            return file;
        },
        lastLine(): string {
            let text = "";
            try {
                if (from !== undefined) text = readFileSync(path).subarray(from).toString("utf8");
            } catch {}
            const lines = text.split("\n").filter((line) => line.trim() !== "" && !NODE_VERSION_LINE.test(line));
            return lines.at(-1)?.trimEnd() ?? `Izbor wrote nothing to ${path}`;
        },
    };
}

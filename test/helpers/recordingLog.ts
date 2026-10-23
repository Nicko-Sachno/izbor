import type { Log, LogEntry } from "../../src/core/ports.js";

export function recordingLog() {
    const entries: LogEntry[] = [];
    const log: Log = (level, text, fields = {}) => void entries.push({ level, text, fields });
    return { log, entries, errors: () => entries.filter((entry) => entry.level !== "info") };
}

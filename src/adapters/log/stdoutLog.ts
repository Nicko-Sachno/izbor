import type { Log, LogEntry } from "../../core/ports.js";
import { shortId } from "../../domain/text.js";

const prefix = (sessionId: string, agentId: string | null = null) =>
    shortId(sessionId) + (agentId ? `/agent-${agentId.slice(0, 4)}` : "");

export function toLine({ level, text, fields }: LogEntry): string {
    if (level === "info") return text;
    const mark = fields.sessionId === undefined ? "izbor" : prefix(fields.sessionId, fields.agentId);
    return `${mark} ${level}: ${text}`;
}

export function createStdoutLog(): Log {
    return (level, text, fields = {}) => console.log(toLine({ level, text, fields }));
}

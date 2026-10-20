import { posix, win32 } from "node:path";
import { NOT_ANSWERABLE, type NotAnswerable, type SentText } from "../../domain/answer.js";
import { fieldsOf } from "../../domain/text.js";
import {
    isSessionId,
    type CollectedPrompt,
    type ErrorCode,
    type IzborInfo,
    type SentAnswer,
    type SessionsAnswer,
} from "../../domain/wire.js";

const nonnegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const path = (value: unknown): value is string =>
    typeof value === "string" && !value.includes("\0") && (posix.isAbsolute(value) || win32.isAbsolute(value));

function timestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Decode once at the HTTP boundary, retaining additional fields from newer Izbor versions. */
export function readIzborInfo(body: unknown): IzborInfo | undefined {
    const fields = fieldsOf(body);
    const { service, pid, port, dataDir, startedAt, sendKeyPath } = fields;
    if (service !== "izbor" || !nonnegativeInteger(pid) || pid === 0 || pid > 0x7fffffff) return undefined;
    if (!nonnegativeInteger(port) || port === 0 || port > 65535) return undefined;
    if (!path(dataDir) || !path(sendKeyPath) || !timestamp(startedAt)) return undefined;
    return { ...fields, service, pid, port, dataDir, startedAt, sendKeyPath };
}

export function readSessionsAnswer(body: unknown): SessionsAnswer | undefined {
    const fields = fieldsOf(body);
    if (!Array.isArray(fields.sessions)) return undefined;
    const sessions: { sessionId: string; listeners: number }[] = [];
    for (const value of fields.sessions) {
        const entry = fieldsOf(value);
        const { sessionId, listeners } = entry;
        if (!isSessionId(sessionId) || !nonnegativeInteger(listeners)) return undefined;
        sessions.push({ ...entry, sessionId, listeners });
    }
    return { sessions };
}

function sentText(value: unknown): value is SentText {
    return (
        typeof value === "string" &&
        (value === "yes" ||
            value === "no" ||
            value.startsWith("no ") ||
            (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))))
    );
}

export function readSentAnswer(body: unknown): SentAnswer | undefined {
    const fields = fieldsOf(body);
    return sentText(fields.sent) ? { sent: fields.sent } : undefined;
}

export function readCollectedPrompt(body: unknown): CollectedPrompt | undefined {
    const fields = fieldsOf(body);
    return isSessionId(fields.collected) ? { collected: fields.collected } : undefined;
}

const ERROR_CODES = {
    forbidden: true,
    stopping: true,
    not_found: true,
    bad_id: true,
    not_watched: true,
    rejected_payload: true,
    unauthorized: true,
    bad_answer: true,
    request_changed: true,
    already_answered: true,
    not_answerable: true,
    bad_prompt: true,
    not_acting: true,
    request_pending: true,
    prompt_pending: true,
    no_plugin: true,
    unknown_prompt: true,
} satisfies Record<ErrorCode, true>;

export const isErrorCode = (value: unknown): value is ErrorCode =>
    typeof value === "string" && Object.hasOwn(ERROR_CODES, value);

export const isNotAnswerable = (value: unknown): value is NotAnswerable =>
    typeof value === "string" && Object.hasOwn(NOT_ANSWERABLE, value);

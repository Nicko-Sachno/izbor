import type { NotAnswerable, SentText } from "./answer.js";
import type { PromptState } from "./prompt.js";

export const LOOPBACK = "127.0.0.1";

export const izborAddress = (port: number) => `${LOOPBACK}:${port}`;

export const izborUrl = (port: number) => `http://${izborAddress(port)}`;

export const curlStream = (url: string) => `curl -N ${url} (Windows PowerShell: curl.exe -N ${url})`;

export function isSessionId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function lowerSessionId(sessionId: string): string {
    return sessionId.toLowerCase();
}

export type IzborInfo = {
    service: "izbor";
    pid: number;
    port: number;
    dataDir: string;
    startedAt: string;
    sendKeyPath: string;
};

export type SessionsAnswer = { sessions: readonly { sessionId: string; listeners: number }[] };

export type StoppedAnswer = { stopped: readonly string[] };

export type SentAnswer = { sent: SentText };

export type CollectedPrompt = { collected: string };

export type NextPrompt = { promptId: string; text: string };

export type ReportedPrompt = { reported: PromptState };

export type StoppingAnswer = { stopping: true };

export type ErrorCode =
    | "forbidden"
    | "stopping"
    | "not_found"
    | "bad_id"
    | "not_watched"
    | "rejected_payload"
    | "unauthorized"
    | "bad_answer"
    | "request_changed"
    | "already_answered"
    | "not_answerable"
    | "bad_prompt"
    | "not_acting"
    | "request_pending"
    | "prompt_pending"
    | "no_plugin"
    | "unknown_prompt";

export type ErrorAnswer = { error: ErrorCode; message: string; answerable?: NotAnswerable };

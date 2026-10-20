import type { StreamEvent } from "../../domain/streamEvent.js";
import type { NotAnswerable } from "../../domain/answer.js";
import { COLLECT_LIMIT_MS } from "../../domain/prompt.js";
import { fieldsOf, readJson } from "../../domain/text.js";
import {
    type CollectedPrompt,
    type ErrorCode,
    izborUrl,
    type IzborInfo,
    type SentAnswer,
    type SessionsAnswer,
} from "../../domain/wire.js";
import { readEvents, type StreamEnd } from "./stream.js";
import {
    isErrorCode,
    isNotAnswerable,
    readCollectedPrompt,
    readIzborInfo,
    readSentAnswer,
    readSessionsAnswer,
} from "./responses.js";

export type StreamAway = { away: "not running" | "stopping" };

type Away = StreamAway | { away: "not answering" };

export type IzborAnswer = { up: IzborInfo | "older" } | Away | { foreign: string };

export type Refused = { refused: number; error?: ErrorCode; message: string; answerable?: NotAnswerable };

const HEADERS = { connection: "close" };

const CLOSED_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

type Heard = { status: number; statusText: string; body?: unknown };

type NotHttp = { notHttp: string };

function failureOf(err: unknown): StreamAway | NotHttp | undefined {
    const cause = (err as { cause?: { code?: unknown; name?: unknown; message?: unknown } } | undefined)?.cause;
    if (cause?.code === "ECONNREFUSED") return { away: "not running" };
    if (typeof cause?.code === "string" && CLOSED_CODES.has(cause.code)) return { away: "stopping" };
    if (cause?.name === "HTTPParserError") return { notHttp: String(cause.message) };
    return undefined;
}

const withKey = (json: unknown, key: string) => ({ json, headers: { authorization: `Bearer ${key}` } });

function isJson(res: Response): boolean {
    return res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function discard(res: Response): void {
    res.body?.cancel().catch(() => {});
}

async function hear(res: Response): Promise<Heard | StreamAway> {
    const { status, statusText } = res;
    if (status === 503) {
        discard(res);
        return { away: "stopping" };
    }
    if (!isJson(res)) {
        discard(res);
        return { status, statusText };
    }
    const body = readJson(await res.text());
    return body === undefined ? { status, statusText } : { status, statusText, body };
}

const statusLine = ({ status, statusText }: Heard) => (statusText ? `${status} ${statusText}` : `${status}`);

const answered = (heard: Heard | NotHttp): heard is Heard =>
    "status" in heard && heard.status === 200 && heard.body !== undefined;

const accepted = (heard: Heard | NotHttp | Away) => "status" in heard && heard.status === 202;

const notFound = (heard: Heard | NotHttp) =>
    "status" in heard && heard.status === 404 && fieldsOf(heard.body).error === "not_found";

function refusal(heard: Heard): Refused {
    const { error, message, answerable } = fieldsOf(heard.body);
    return {
        refused: heard.status,
        ...(isErrorCode(error) && { error }),
        message: typeof message === "string" ? message : `Izbor answered ${statusLine(heard)}`,
        ...(isNotAnswerable(answerable) && { answerable }),
    };
}

function foreign(path: string, heard: Heard | NotHttp, why?: string): { foreign: string } {
    if ("notHttp" in heard) return { foreign: `GET ${path} answered, but not in HTTP: ${heard.notHttp}` };
    why ??= heard.body === undefined ? ", not JSON" : "";
    return { foreign: `GET ${path} answered ${statusLine(heard)}${why}` };
}

function serviceAnswer(heard: Heard): IzborAnswer {
    if (fieldsOf(heard.body).service !== "izbor") return foreign("/izbor", heard, ', with no "service":"izbor"');
    const info = readIzborInfo(heard.body);
    return info ? { up: info } : foreign("/izbor", heard, ", with invalid service information");
}

export type IzborClient = {
    readStream(
        id: string,
        on: { open(): void; event(event: StreamEvent): void },
        leave: AbortSignal,
    ): Promise<StreamEnd | StreamAway | Refused>;
    getIzbor(cancel?: AbortSignal): Promise<IzborAnswer>;
    getSessions(): Promise<SessionsAnswer | Away | Refused>;
    /** Rejects with the caller's abort reason when cancelled; transport failures resolve as values. */
    sendAnswer(
        id: string,
        answer: { at: string; answer: string },
        key: string,
        cancel?: AbortSignal,
    ): Promise<SentAnswer | Away | Refused>;
    /** Rejects with the caller's abort reason when cancelled; transport failures resolve as values. */
    sendPrompt(
        id: string,
        prompt: { text: string },
        key: string,
        cancel?: AbortSignal,
    ): Promise<CollectedPrompt | Away | Refused>;
    requestStop(key: string): Promise<boolean>;
};

export function createIzborClient({
    port,
    fetch = globalThis.fetch,
    silenceMs = 65_000,
    timeoutMs = 3_000,
}: {
    port: number;
    fetch?: typeof globalThis.fetch;
    silenceMs?: number;
    timeoutMs?: number;
}): IzborClient {
    const base = izborUrl(port);

    async function ask(
        method: "GET" | "POST",
        path: string,
        cancel?: AbortSignal,
        send?: { json: unknown; headers: Record<string, string> },
        limitMs = timeoutMs,
    ): Promise<Heard | Away | NotHttp> {
        try {
            cancel?.throwIfAborted();
            const timeout = AbortSignal.timeout(limitMs);
            const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
            const headers = send ? { ...HEADERS, "content-type": "application/json", ...send.headers } : HEADERS;
            const body = send && JSON.stringify(send.json);
            return await hear(await fetch(`${base}${path}`, { method, headers, body, signal }));
        } catch (err) {
            const failure = failureOf(err);
            if (send && failure && "away" in failure && failure.away === "stopping") return { away: "not answering" };
            return failure ?? { away: "not answering" };
        }
    }

    async function answer<T>(
        method: "GET" | "POST",
        path: string,
        read: (body: unknown) => T | undefined,
        send?: { json: unknown; headers: Record<string, string> },
        limitMs?: number,
        cancel?: AbortSignal,
    ): Promise<T | Away | Refused> {
        cancel?.throwIfAborted();
        const heard = await ask(method, path, cancel, send, limitMs);
        cancel?.throwIfAborted();
        if ("away" in heard) return heard;
        if ("notHttp" in heard) return { away: "not answering" };
        if (!answered(heard)) return refusal(heard);
        return (
            read(heard.body) ?? {
                refused: heard.status,
                message: `Izbor answered ${statusLine(heard)} with invalid data`,
            }
        );
    }

    async function getIzbor(cancel?: AbortSignal): Promise<IzborAnswer> {
        const izbor = await ask("GET", "/izbor", cancel);
        if ("away" in izbor) return izbor;
        if (answered(izbor)) return serviceAnswer(izbor);
        if (!notFound(izbor)) return foreign("/izbor", izbor);
        const sessions = await ask("GET", "/sessions", cancel);
        if ("away" in sessions) return sessions;
        if (!answered(sessions)) return foreign("/sessions", sessions);
        return readSessionsAnswer(sessions.body)
            ? { up: "older" }
            : foreign("/sessions", sessions, ", with an invalid session list");
    }

    async function readStream(
        id: string,
        on: { open(): void; event(event: StreamEvent): void },
        leave: AbortSignal,
    ): Promise<StreamEnd | StreamAway | Refused> {
        const silent = new AbortController();
        const timer = setTimeout(() => silent.abort(), silenceMs);
        const signal = AbortSignal.any([leave, silent.signal]);
        try {
            let res: Response;
            try {
                res = await fetch(`${base}/sessions/${id}/events`, { headers: HEADERS, signal });
            } catch (err) {
                if (leave.aborted) return "left";
                const failure = failureOf(err);
                return failure && "away" in failure ? failure : "broken";
            }
            if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
                const heard = await hear(res);
                return "away" in heard ? heard : refusal(heard);
            }
            on.open();
            return await readEvents(res.body!, on, leave, () => timer.refresh());
        } catch {
            return leave.aborted ? "left" : "broken";
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        readStream,
        getIzbor,
        getSessions: () => answer("GET", "/sessions", readSessionsAnswer),
        sendAnswer: (id, { at, answer: typed }, key, cancel) =>
            answer(
                "POST",
                `/sessions/${id}/answer`,
                readSentAnswer,
                withKey({ at, answer: typed }, key),
                timeoutMs,
                cancel,
            ),
        sendPrompt: (id, { text }, key, cancel) =>
            answer(
                "POST",
                `/sessions/${id}/prompts`,
                readCollectedPrompt,
                withKey({ text }, key),
                COLLECT_LIMIT_MS + timeoutMs,
                cancel,
            ),
        requestStop: async (key: string) => accepted(await ask("POST", "/izbor/stop", undefined, withKey({}, key))),
    };
}

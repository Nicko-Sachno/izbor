import type { IncomingMessage, ServerResponse } from "node:http";
import type {
    CollectedPrompt,
    ErrorAnswer,
    ErrorCode,
    NextPrompt,
    IzborInfo,
    ReportedPrompt,
    SentAnswer,
    SessionsAnswer,
    StoppedAnswer,
    StoppingAnswer,
} from "../../domain/wire.js";
import { showsSendKey } from "./sendKey.js";
import type { HttpServerDeps } from "./server.js";

export function answerJson(
    res: ServerResponse,
    status: number,
    body:
        | IzborInfo
        | SessionsAnswer
        | StoppedAnswer
        | SentAnswer
        | CollectedPrompt
        | NextPrompt
        | ReportedPrompt
        | StoppingAnswer
        | ErrorAnswer,
): void {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export const STATUS = {
    forbidden: 403,
    stopping: 503,
    not_found: 404,
    bad_id: 400,
    not_watched: 404,
    rejected_payload: 400,
    unauthorized: 401,
    bad_answer: 400,
    request_changed: 409,
    already_answered: 409,
    not_answerable: 409,
    bad_prompt: 400,
    not_acting: 409,
    request_pending: 409,
    prompt_pending: 409,
    no_plugin: 409,
    unknown_prompt: 404,
} satisfies Record<ErrorCode, number>;

export const STOPPING = "Izbor is stopping";

export function answerError(res: ServerResponse, error: ErrorCode, message: string): void {
    answerJson(res, STATUS[error], { error, message });
}

export function closeWhileStopping(res: ServerResponse, { izbor }: HttpServerDeps): void {
    if (izbor.tracker.closing()) res.setHeader("Connection", "close");
}

export function refusedWithoutKey(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): boolean {
    if (showsSendKey(req.headers.authorization, deps.sendKey)) return false;
    req.resume();
    answerError(
        res,
        "unauthorized",
        "Send Izbor's send key as Authorization: Bearer <key>, the key in the file GET /izbor names",
    );
    return true;
}

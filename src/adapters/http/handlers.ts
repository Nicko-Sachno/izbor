import type { IncomingMessage, ServerResponse } from "node:http";
import { NOT_ANSWERABLE, REQUEST_CHANGED } from "../../domain/answer.js";
import {
    BAD_PROMPT_BODY,
    NO_PLUGIN,
    notActing,
    PROMPT_PENDING,
    type PromptState,
    REQUEST_PENDING,
} from "../../domain/prompt.js";
import { fieldsOf, readJson } from "../../domain/text.js";
import { answerError, answerJson, closeWhileStopping, STATUS, STOPPING } from "./answers.js";
import type { HttpServerDeps } from "./server.js";
import { openStream } from "./sse.js";

export type Handler = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, deps: HttpServerDeps) => void;

function readBody(req: IncomingMessage, then: (body: string) => void): void {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => then(body));
}

function readBodyUnlessStopping(
    req: IncomingMessage,
    res: ServerResponse,
    deps: HttpServerDeps,
    then: (body: string) => void,
): void {
    readBody(req, (body) => {
        if (deps.izbor.tracker.closing()) {
            closeWhileStopping(res, deps);
            return answerError(res, "stopping", STOPPING);
        }
        then(body);
    });
}

export const holdAnswerHook: Handler = (req, res, _match, deps) => {
    readBody(req, (body) => {
        const closed = new AbortController();
        res.once("close", () => closed.abort());
        const hook = deps.readHook(body, new Date());
        const held =
            hook && !deps.izbor.tracker.closing() ? deps.izbor.holdAnswer(hook, closed.signal) : Promise.resolve(null);
        held.then((decision) => {
            if (closed.signal.aborted || res.writableEnded) return;
            closeWhileStopping(res, deps);
            if (!decision) return void res.writeHead(200).end();
            res.writeHead(200, { "Content-Type": "application/json" }).end(deps.answerHook.output(decision));
        }).catch(deps.onBug);
    });
};

function textField(body: string, name: string): string | undefined {
    const value = fieldsOf(readJson(body))[name];
    return typeof value === "string" ? value : undefined;
}

function readAnswerBody(body: string): { at: string; answer: string } | undefined {
    const { at, answer } = fieldsOf(readJson(body));
    return typeof at === "string" && typeof answer === "string" ? { at, answer } : undefined;
}

export const receiveAnswer: Handler = (req, res, match, deps) => {
    const sessionId = match[1]!;
    readBodyUnlessStopping(req, res, deps, (body) => {
        const answer = readAnswerBody(body);
        const outcome = answer && deps.izbor.answer(sessionId, answer.at, answer.answer);
        if (answer && !outcome) return answerError(res, "not_watched", `${sessionId} is not watched`);
        if (!outcome)
            return answerError(res, "bad_answer", 'Izbor could not read this as an answer: send {"at", "answer"}');
        if ("sent" in outcome) return answerJson(res, 200, { sent: outcome.sent });
        switch (outcome.refused) {
            case "request_changed":
                return answerError(res, "request_changed", REQUEST_CHANGED);
            case "already_answered":
                return answerError(res, "already_answered", NOT_ANSWERABLE.answered);
            case "bad_answer":
                return answerError(res, "bad_answer", outcome.message);
            case "not_answerable":
                return answerJson(res, STATUS.not_answerable, {
                    error: "not_answerable",
                    message: NOT_ANSWERABLE[outcome.answerable],
                    answerable: outcome.answerable,
                });
            default:
                return assertNever(outcome);
        }
    });
};

const readPromptBody = (body: string): string | undefined => textField(body, "text");

export const receivePrompt: Handler = (req, res, match, deps) => {
    const sessionId = match[1]!;
    readBodyUnlessStopping(req, res, deps, (body) => {
        const text = readPromptBody(body);
        if (text === undefined) return answerError(res, "bad_prompt", BAD_PROMPT_BODY);
        deps.izbor.prompts
            .send(sessionId, text)
            .then((outcome) => {
                closeWhileStopping(res, deps);
                if ("collected" in outcome) return answerJson(res, 200, outcome);
                switch (outcome.refused) {
                    case "bad_prompt":
                        return answerError(res, "bad_prompt", outcome.message);
                    case "not_watched":
                        return answerError(res, "not_watched", `${sessionId} is not watched`);
                    case "not_acting":
                        return answerError(res, "not_acting", notActing(outcome.folder));
                    case "request_pending":
                        return answerError(res, "request_pending", REQUEST_PENDING);
                    case "stopping":
                        return answerError(res, "stopping", STOPPING);
                    case "prompt_pending":
                        return answerError(res, "prompt_pending", PROMPT_PENDING);
                    case "no_plugin":
                        return answerError(res, "no_plugin", NO_PLUGIN);
                    default:
                        return assertNever(outcome);
                }
            })
            .catch(deps.onBug);
    });
};

function assertNever(outcome: never): never {
    throw new Error(`an outcome no route maps: ${JSON.stringify(outcome)}`);
}

export const nextPrompt: Handler = (req, res, match, deps) => {
    const sessionId = match[1]!;
    req.resume();
    const closed = new AbortController();
    res.once("close", () => closed.abort());
    deps.izbor.prompts
        .next(sessionId, closed.signal)
        .then((prompt) => {
            if (closed.signal.aborted) return;
            closeWhileStopping(res, deps);
            if (!prompt) return void res.writeHead(204).end();
            answerJson(res, 200, { promptId: prompt.promptId, text: prompt.text });
        })
        .catch(deps.onBug);
};

const readReportBody = (body: string): string | undefined => textField(body, "reason");

export const receiveReport: Handler = (req, res, match, deps) => {
    const promptId = match[1]!;
    const state = match[2] as PromptState;
    readBodyUnlessStopping(req, res, deps, (body) => {
        const reason = state === "dropped" ? readReportBody(body) : undefined;
        if (!deps.izbor.prompts.report(promptId, state, reason))
            return answerError(res, "unknown_prompt", `${promptId} is not a prompt Izbor handed to a plugin`);
        answerJson(res, 200, { reported: state });
    });
};

export const receiveHook: Handler = (req, res, _match, deps) => {
    readBody(req, (body) => {
        closeWhileStopping(res, deps);
        const hook = deps.readHook(body, new Date());
        if (!hook) {
            answerError(res, "rejected_payload", "Izbor could not read this as a hook");
            deps.izbor.handleRejected(body).catch(deps.onBug);
            return;
        }
        res.writeHead(200).end();
        deps.izbor.handleHook(hook).catch(deps.onBug);
    });
};

export const tuneIn: Handler = (_req, res, match, deps) => {
    const sessionId = match[1]!;
    const listener = openStream(res);
    deps.izbor.tracker.tuneIn(sessionId, listener);
};

export const tuneInAll: Handler = (_req, res, _match, deps) => {
    const listener = openStream(res);
    deps.izbor.tracker.tuneInAll(listener);
};

export const listSessions: Handler = (_req, res, _match, deps) => {
    answerJson(res, 200, { sessions: deps.izbor.tracker.list() });
};

export const sayWhoIzborIs: Handler = (_req, res, _match, deps) => {
    answerJson(res, 200, deps.info());
};

export const requestStop: Handler = (req, res, _match, deps) => {
    req.resume();
    closeWhileStopping(res, deps);
    answerJson(res, 202, { stopping: true });
    deps.requestStop();
};

export const stopWatch: Handler = (_req, res, match, deps) => {
    const id = match[1]!;
    if (deps.izbor.tracker.stop(id)) answerJson(res, 200, { stopped: [id] });
    else answerError(res, "not_watched", `${id} is not watched`);
};

export const stopEveryWatch: Handler = (_req, res, _match, deps) => {
    answerJson(res, 200, { stopped: deps.izbor.tracker.stopAll("deleted").stopped });
};

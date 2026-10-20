import {
    type Handler,
    holdAnswerHook,
    listSessions,
    nextPrompt,
    receiveAnswer,
    receiveHook,
    receivePrompt,
    receiveReport,
    requestStop,
    sayWhoIzborIs,
    stopEveryWatch,
    stopWatch,
    tuneIn,
    tuneInAll,
} from "./handlers.js";

type Route = {
    method: "GET" | "POST" | "DELETE";
    path: RegExp;
    whileStopping?: true;
    sessionId?: true;
    sendKey?: true;
    run: Handler;
};

const EVENTS_PATH = /^\/sessions\/([^/]+)\/events$/;

const SESSION_PATH = /^\/sessions\/([^/]+)$/;

const ANSWER_PATH = /^\/sessions\/([^/]+)\/answer$/;

const PROMPTS_PATH = /^\/sessions\/([^/]+)\/prompts$/;

const NEXT_PROMPT_PATH = /^\/sessions\/([^/]+)\/prompts\/next$/;

const REPORT_PATH = /^\/prompts\/([^/]+)\/(delivered|dropped)$/;

export const ROUTES: readonly Route[] = [
    { method: "GET", path: EVENTS_PATH, sessionId: true, run: tuneIn },
    { method: "GET", path: /^\/events$/, run: tuneInAll },
    { method: "GET", path: /^\/sessions$/, run: listSessions },
    { method: "GET", path: /^\/izbor$/, run: sayWhoIzborIs },
    { method: "POST", path: /^\/izbor\/stop$/, sendKey: true, whileStopping: true, run: requestStop },
    { method: "POST", path: ANSWER_PATH, sessionId: true, sendKey: true, run: receiveAnswer },
    { method: "POST", path: PROMPTS_PATH, sessionId: true, sendKey: true, run: receivePrompt },
    { method: "GET", path: NEXT_PROMPT_PATH, sessionId: true, sendKey: true, run: nextPrompt },
    { method: "POST", path: REPORT_PATH, sendKey: true, run: receiveReport },
    { method: "DELETE", path: SESSION_PATH, sessionId: true, run: stopWatch },
    { method: "DELETE", path: /^\/sessions$/, run: stopEveryWatch },
    { method: "POST", path: /^\/hook$/, whileStopping: true, run: receiveHook },
    { method: "POST", path: /^\/hook\/answer$/, whileStopping: true, run: holdAnswerHook },
];

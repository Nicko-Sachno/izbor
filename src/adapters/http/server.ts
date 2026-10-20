import { createServer, type IncomingMessage } from "node:http";
import type { AgentProvider, IzborRoutes } from "../../core/ports.js";
import { isSessionId, LOOPBACK, lowerSessionId, type IzborInfo } from "../../domain/wire.js";
import { answerError, closeWhileStopping, refusedWithoutKey, STOPPING } from "./answers.js";
import { ROUTES } from "./routes.js";

export type HttpServerDeps = {
    izbor: IzborRoutes;
    readHook: AgentProvider["readHook"];
    answerHook: AgentProvider["answerHook"];
    info: () => IzborInfo;
    sendKey: string;
    onBug: (error: unknown) => void;
    requestStop: () => void;
};

const OWN_NAMES = new Set([LOOPBACK, "localhost"]);

function refusal({ headers }: IncomingMessage): string | undefined {
    const name = headers.host?.replace(/:\d*$/, "").toLowerCase();
    if (!name || !OWN_NAMES.has(name)) return `Izbor answers only requests addressed to ${LOOPBACK} or localhost`;
    const site = headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") {
        return "Izbor refuses requests a browser sends for another website";
    }
    return undefined;
}

export function createHttpServer(deps: HttpServerDeps) {
    return createServer((req, res) => {
        const { method, url = "" } = req;
        closeWhileStopping(res, deps);
        const refused = refusal(req);
        if (refused) return answerError(res, "forbidden", refused);
        const route = ROUTES.find((row) => row.method === method && row.path.test(url));
        if (deps.izbor.tracker.closing() && !route?.whileStopping) return answerError(res, "stopping", STOPPING);
        if (!route) return answerError(res, "not_found", `${method} ${url} is not an address Izbor knows`);
        const match = route.path.exec(url)!;
        if (route.sessionId && !isSessionId(match[1]))
            return answerError(res, "bad_id", `${match[1]} is not a session id`);
        if (route.sessionId) match[1] = lowerSessionId(match[1]!);
        if (route.sendKey && refusedWithoutKey(req, res, deps)) return;
        route.run(req, res, match, deps);
    });
}

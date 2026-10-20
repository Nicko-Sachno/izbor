import type { TestContext } from "node:test";
import { createHttpServer } from "../../src/adapters/http/server.js";
import type { IzborRoutes } from "../../src/core/ports.js";
import type { Listener } from "../../src/core/watchTracker.js";
import type { IzborInfo } from "../../src/domain/wire.js";
import { fakeProvider } from "./fakeProvider.js";

export const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";

export const OTHER_ID = "73205487-0000-4000-8000-000000000000";

const INFO: IzborInfo = {
    service: "izbor",
    pid: 71494,
    port: 4319,
    dataDir: "/Users/me/izbor/.izbor",
    startedAt: "2026-10-06T09:12:03.000Z",
    sendKeyPath: "/Users/me/.config/izbor/send-key-4319",
};

export async function startServer(
    t: TestContext,
    {
        onTuneIn = (_listener: Listener) => {},
        closing = false as boolean | (() => boolean),
        holdAnswer = (async () => null) as IzborRoutes["holdAnswer"],
        send = (async () => ({ refused: "not_watched" })) as IzborRoutes["prompts"]["send"],
        next = (async () => undefined) as IzborRoutes["prompts"]["next"],
    } = {},
) {
    const hooks: unknown[] = [];
    const { readHook, answerHook } = fakeProvider();
    const rejected: string[] = [];
    const tunedIn: { sessionId: string; listener: Listener }[] = [];
    const tunedInAll: Listener[] = [];
    const stops: string[] = [];
    const stopAlls: string[] = [];
    const bugs: unknown[] = [];
    const stopRequests = { count: 0 };
    const server = createHttpServer({
        izbor: {
            tracker: {
                tuneIn(sessionId, listener) {
                    tunedIn.push({ sessionId, listener });
                    onTuneIn(listener);
                },
                tuneInAll: (stream) => void tunedInAll.push(stream),
                list: () => [
                    { sessionId: SESSION_ID, listeners: 2 },
                    { sessionId: OTHER_ID, listeners: 0 },
                ],
                stop(sessionId) {
                    stops.push(sessionId);
                    return [SESSION_ID, OTHER_ID].includes(sessionId.toLowerCase());
                },
                stopAll(why) {
                    stopAlls.push(why);
                    return { stopped: [SESSION_ID, OTHER_ID], done: Promise.resolve() };
                },
                closing: typeof closing === "function" ? closing : () => closing,
            },
            handleHook: async (hook) => void hooks.push(hook.record.payload),
            handleRejected: async (body) => void rejected.push(body),
            holdAnswer,
            answer: () => undefined,
            prompts: { send, next, report: () => false },
        },
        readHook,
        answerHook,
        info: () => INFO,
        sendKey: "0".repeat(64),
        onBug: (error) => bugs.push(error),
        requestStop: () => void stopRequests.count++,
    }).listen(0, "127.0.0.1");
    t.after(async () => {
        server.closeAllConnections();
        server.close();
        await Promise.all([...tunedIn.map(({ listener }) => listener.gone), ...tunedInAll.map(({ gone }) => gone)]);
    });
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    return { hooks, rejected, tunedIn, tunedInAll, stops, stopAlls, bugs, stopRequests, base, url: `${base}/hook` };
}

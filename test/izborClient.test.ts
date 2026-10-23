import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { createIzborClient, type IzborClient } from "../src/adapters/izbor/client.js";
import { runStatus } from "../src/cli/commands/status.js";
import { runStop } from "../src/cli/commands/stop.js";
import { connectLimited } from "../src/adapters/izbor/connectLimited.js";
import type { StreamEvent } from "../src/domain/streamEvent.js";
import { fullBacklog } from "./helpers/fullBacklog.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { portAnswering } from "./support.js";
import { INFO, PORT } from "./helpers/izborInfo.js";

const STATUS_ARGS = { command: "status" as const, port: PORT, diskUsage: false };
const ID = "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff";

type Call = { url: string; method: string; headers: Headers; signal: AbortSignal | undefined };

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
        const call = {
            url: String(input),
            method: init.method ?? "GET",
            headers: new Headers(init.headers),
            signal: init.signal ?? undefined,
        };
        calls.push(call);
        return answer(call);
    };
    return { fetch: fetch as typeof globalThis.fetch, calls };
}

const failed = (code: string) =>
    Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }));

const neverAnswers = ({ signal }: Call) =>
    new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

function sseStream({ signal }: Call) {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => void (body = controller) }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
    signal?.addEventListener("abort", () => body.error(signal.reason));
    const bytes = new TextEncoder();
    return {
        response,
        send: (text: string) => body.enqueue(bytes.encode(text)),
        end: () => body.close(),
        fail: () => body.error(new TypeError("terminated")),
    };
}

function fakeStreams() {
    const streams: ReturnType<typeof sseStream>[] = [];
    const fake = fakeFetch((call) => {
        const stream = sseStream(call);
        streams.push(stream);
        return stream.response;
    });
    return { ...fake, streams };
}

const frame = ({ type, ...data }: StreamEvent) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

const WATCHING: StreamEvent = { type: "session", sessionId: ID, state: "watching" };
const ACTION: StreamEvent = {
    type: "action",
    sessionId: ID,
    at: "2026-10-06T09:12:03.000Z",
    what: "started Bash: npm test",
};
const STOPPED: StreamEvent = { type: "session", sessionId: ID, state: "stopped", why: "deleted" };

function read(client: IzborClient, leave = new AbortController().signal) {
    const log: unknown[] = [];
    const end = client.readStream(ID, { open: () => log.push("open"), event: (e) => log.push(e) }, leave);
    return { log, end };
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const empty = (status: number, statusText: string) => new Response(null, { status, statusText });

const htmlPage = () =>
    new Response("<html></html>", { status: 200, statusText: "OK", headers: { "Content-Type": "text/html" } });

const IZBOR_NOT_FOUND = { error: "not_found", message: "GET /izbor is not an address Izbor knows" };

const asked = (calls: Call[]) => calls.map(({ url, method, headers }) => [method, url, headers.get("connection")]);

test("getSessions answers the watched sessions, asked of 127.0.0.1 with `Connection: close`", async () => {
    const answer = { sessions: [{ sessionId: ID, listeners: 2 }] };
    const { fetch, calls } = fakeFetch(() => json(200, answer));

    assert.deepEqual(await createIzborClient({ port: PORT, fetch }).getSessions(), answer);
    assert.deepEqual(asked(calls), [["GET", `http://127.0.0.1:${PORT}/sessions`, "close"]]);
});

test("an answer that is not JSON is never parsed: an empty 400 is Refused with no error code", async () => {
    const nodeRefusal = fakeFetch(() => empty(400, "Bad Request"));
    assert.deepEqual(await createIzborClient({ port: PORT, fetch: nodeRefusal.fetch }).getSessions(), {
        refused: 400,
        message: "Izbor answered 400 Bad Request",
    });

    const plain = fakeFetch(
        () =>
            new Response('{"error":"bad_id","message":"x"}', {
                status: 400,
                headers: { "Content-Type": "text/plain" },
            }),
    );
    assert.deepEqual(await createIzborClient({ port: PORT, fetch: plain.fetch }).getSessions(), {
        refused: 400,
        message: "Izbor answered 400",
    });
});

test("a connection closed under an answer or a prompt is `not answering`: Izbor may have read the body and acted; a 503 is `stopping`, a refused connection `not running`", async () => {
    for (const [answer, away] of [
        [() => failed("ECONNRESET"), "not answering"],
        [() => failed("EPIPE"), "not answering"],
        [() => failed("UND_ERR_SOCKET"), "not answering"],
        [() => json(503, { error: "stopping", message: "Izbor is stopping" }), "stopping"],
        [() => failed("ECONNREFUSED"), "not running"],
    ] as const) {
        const client = createIzborClient({ port: PORT, fetch: fakeFetch(answer).fetch });
        assert.deepEqual(await client.sendAnswer(ID, { at: "2026-10-11T09:00:00.000Z", answer: "yes" }, "key"), {
            away,
        });
        assert.deepEqual(await client.sendPrompt(ID, { text: "go on" }, "key"), { away });
    }
});

test("with connectLimited at 500 ms, as on Windows, a port whose connect has not finished in 500 ms is `not running`, as a refused connect is, for a request and a stream, well before the time limit", async (t) => {
    const port = await fullBacklog(t);
    const client = createIzborClient({
        port,
        fetch: connectLimited(globalThis.fetch, port, 500),
        timeoutMs: 5_000,
        silenceMs: 5_000,
    });
    for (const [what, call] of [
        ["getIzbor", () => client.getIzbor()],
        ["readStream", () => client.readStream(ID, { open() {}, event() {} }, new AbortController().signal)],
    ] as const) {
        const started = Date.now();
        assert.deepEqual(await call(), { away: "not running" }, what);
        const took = Date.now() - started;
        assert.ok(took >= 400 && took < 1500, `${what} took ${took} ms`);
    }
});

test("with connectLimited at 500 ms, a POST whose connect has not finished is never cut short: Izbor may have taken it, so it is `not answering` at its own time limit", async (t) => {
    const port = await fullBacklog(t);
    const client = createIzborClient({ port, fetch: connectLimited(globalThis.fetch, port, 500), timeoutMs: 1_500 });
    const started = Date.now();
    assert.deepEqual(await client.sendAnswer(ID, { at: "x", answer: "yes" }, "k3y"), { away: "not answering" });
    const took = Date.now() - started;
    assert.ok(took >= 1_400, `sendAnswer took ${took} ms`);
});

test(
    "by default, as on macOS, a port whose connect never finishes is a Izbor that does not answer: `not answering` at the time limit, never `not running`",
    {
        skip:
            process.platform === "win32" &&
            "on Windows a connect to a full queue is refused after its retries, about 2 s",
    },
    async (t) => {
        const port = await fullBacklog(t);
        const client = createIzborClient({ port, timeoutMs: 1_500 });
        const started = Date.now();
        assert.deepEqual(await client.getIzbor(), { away: "not answering" });
        const took = Date.now() - started;
        assert.ok(took >= 1_400, `getIzbor took ${took} ms`);
    },
);

test("getIzbor: a 200 JSON from `GET /izbor` is Izbor, up, with its info", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, INFO));

    assert.deepEqual(await createIzborClient({ port: PORT, fetch }).getIzbor(), { up: INFO });
    assert.deepEqual(asked(calls), [["GET", `http://127.0.0.1:${PORT}/izbor`, "close"]]);
});

test('getIzbor: a 200 JSON from `GET /izbor` without `"service":"izbor"` is another program on the port', async () => {
    for (const body of [{ ...INFO, service: "other" }, { pid: 1 }, [INFO], "izbor", null]) {
        const { fetch, calls } = fakeFetch(() => json(200, body));
        assert.deepEqual(
            await createIzborClient({ port: PORT, fetch }).getIzbor(),
            { foreign: 'GET /izbor answered 200, with no "service":"izbor"' },
            JSON.stringify(body),
        );
        assert.equal(calls.length, 1);
    }
});

const INVALID_INFO = [
    { service: "izbor" },
    ...["pid", "port", "dataDir", "startedAt", "sendKeyPath"].map((field) => ({ ...INFO, [field]: undefined })),
    ...[0, -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER + 1, "123"].map((pid) => ({ ...INFO, pid })),
    ...[0, -1, 65536, 1.5, "4400"].map((port) => ({ ...INFO, port })),
    ...[null, 7, "", "relative/path", "/bad\0path"].flatMap((path) => [
        { ...INFO, dataDir: path },
        { ...INFO, sendKeyPath: path },
    ]),
    ...[null, 0, "", "yesterday", "2026-02-30T09:12:03.000Z"].map((startedAt) => ({ ...INFO, startedAt })),
];

test("getIzbor rejects incomplete or malformed service information without probing older Izbor", async () => {
    for (const body of INVALID_INFO) {
        const { fetch, calls } = fakeFetch(() => json(200, body));
        assert.deepEqual(
            await createIzborClient({ port: PORT, fetch }).getIzbor(),
            {
                foreign: "GET /izbor answered 200, with invalid service information",
            },
            JSON.stringify(body),
        );
        assert.equal(calls.length, 1);
    }
});

test("malformed service information cannot reach status paths or stop's key and process operations", async () => {
    for (const body of [{ ...INFO, pid: "123" }]) {
        const calls: string[] = [];
        const { fetch } = fakeFetch(() => json(200, body));
        const client = createIzborClient({ port: PORT, fetch });
        const status = await runStatus(STATUS_ARGS, {
            client,
            which: () => undefined,
            builtAt: () => undefined,
            now: () => Date.parse(INFO.startedAt),
            home: "/Users/me",
        });
        assert.equal(status.code, 1, JSON.stringify(body));
        const stopped = await runStop(
            { command: "stop", port: PORT, yes: true },
            {
                client,
                readKey: async () => {
                    calls.push("readKey");
                    return "key";
                },
                platform: {
                    isAlive: () => {
                        calls.push("isAlive");
                        return false;
                    },
                    endIzbor: () => {
                        calls.push("endIzbor");
                    },
                },
                ask: null,
                wait: async () => {
                    calls.push("wait");
                },
                nowMs: () => 0,
            },
        );
        assert.equal(stopped.code, 1, JSON.stringify(body));
        assert.deepEqual(calls, []);
    }
});

const INVALID_SESSIONS = [
    null,
    [],
    {},
    { sessions: null },
    { sessions: {} },
    ...[
        null,
        [],
        {},
        { sessionId: ID },
        { listeners: 0 },
        { sessionId: "bad", listeners: 0 },
        ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((listeners) => ({ sessionId: ID, listeners })),
    ].map((session) => ({ sessions: [session] })),
];

test("malformed session lists are refused and never identify an older Izbor", async () => {
    for (const body of INVALID_SESSIONS) {
        const { fetch } = fakeFetch(({ url }) =>
            url.endsWith("/izbor") ? json(404, IZBOR_NOT_FOUND) : json(200, body),
        );
        const client = createIzborClient({ port: PORT, fetch });
        assert.deepEqual(
            await client.getSessions(),
            { refused: 200, message: "Izbor answered 200 with invalid data" },
            JSON.stringify(body),
        );
        assert.deepEqual(
            await client.getIzbor(),
            { foreign: "GET /sessions answered 200, with an invalid session list" },
            JSON.stringify(body),
        );
    }
});

test("getIzbor: a field Izbor's info does not have yet, such as the summarizer's, changes nothing: up", async () => {
    const info = { ...INFO, summarizer: { model: "haiku", timeLimitMs: 30000 } };
    const { fetch } = fakeFetch(() => json(200, info));

    assert.deepEqual(await createIzborClient({ port: PORT, fetch }).getIzbor(), { up: info });
});

test("getIzbor: a JSON `not_found` for `GET /izbor`, then a 200 JSON from `GET /sessions`, is an older Izbor", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
        url.endsWith("/izbor") ? json(404, IZBOR_NOT_FOUND) : json(200, { sessions: [] }),
    );

    assert.deepEqual(await createIzborClient({ port: PORT, fetch }).getIzbor(), { up: "older" });
    assert.deepEqual(
        calls.map(({ url }) => url),
        [`http://127.0.0.1:${PORT}/izbor`, `http://127.0.0.1:${PORT}/sessions`],
    );
});

test("getIzbor: an empty 404 or an HTML page is another program on the port", async () => {
    const empty404 = fakeFetch(() => empty(404, "Not Found"));
    assert.deepEqual(await createIzborClient({ port: PORT, fetch: empty404.fetch }).getIzbor(), {
        foreign: "GET /izbor answered 404 Not Found, not JSON",
    });
    assert.equal(empty404.calls.length, 1);

    const html = fakeFetch(htmlPage);
    assert.deepEqual(await createIzborClient({ port: PORT, fetch: html.fetch }).getIzbor(), {
        foreign: "GET /izbor answered 200 OK, not JSON",
    });

    const notSessions = fakeFetch(({ url }) =>
        url.endsWith("/izbor") ? json(404, IZBOR_NOT_FOUND) : empty(404, "Not Found"),
    );
    assert.deepEqual(await createIzborClient({ port: PORT, fetch: notSessions.fetch }).getIzbor(), {
        foreign: "GET /sessions answered 404 Not Found, not JSON",
    });
});

test("readStream runs `open` on the 200 head, before the first stream event", async () => {
    const { fetch, calls, streams } = fakeStreams();
    const { log, end } = read(createIzborClient({ port: PORT, fetch }));

    await settle();
    assert.deepEqual(log, ["open"]);
    streams[0]!.send(frame(WATCHING));
    streams[0]!.end();

    assert.equal(await end, "ended");
    assert.deepEqual(log, ["open", WATCHING]);
    assert.deepEqual(asked(calls), [["GET", `http://127.0.0.1:${PORT}/sessions/${ID}/events`, "close"]]);
});

test("readStream joins a frame split across chunks, splits frames that share one, and skips the keep-alive", async () => {
    const { fetch, streams } = fakeStreams();
    const { log, end } = read(createIzborClient({ port: PORT, fetch }));
    const stream = streams[0]!;

    const watching = frame(WATCHING);
    stream.send(watching.slice(0, 20));
    stream.send(watching.slice(20));
    stream.send(`: keep-alive\n\n${frame(ACTION)}${frame(STOPPED)}`);
    stream.end();

    assert.equal(await end, "ended");
    assert.deepEqual(log, ["open", WATCHING, ACTION, STOPPED]);
});

test("readStream splits frames on `\\n` only: a `data` line holding U+2028 arrives whole, the character kept", async () => {
    const { fetch, streams } = fakeStreams();
    const { log, end } = read(createIzborClient({ port: PORT, fetch }));
    const action: StreamEvent = { ...ACTION, what: "started Bash: echo a\u2028b\u2029c" };

    streams[0]!.send(frame(action));
    streams[0]!.end();

    assert.equal(await end, "ended");
    assert.deepEqual(log, ["open", action]);
});

test("readStream: a body cut in the middle of a frame is `broken`, whether it ends or its read fails", async () => {
    for (const cut of ["end", "fail"] as const) {
        const { fetch, streams } = fakeStreams();
        const { log, end } = read(createIzborClient({ port: PORT, fetch }));

        streams[0]!.send(frame(WATCHING) + frame(ACTION).slice(0, 15));
        await settle();
        streams[0]![cut]();

        assert.equal(await end, "broken", cut);
        assert.deepEqual(log, ["open", WATCHING], cut);
    }
});

test("readStream: a `data` line that is not JSON is `broken`: the stream events before it are passed on, none after", async () => {
    const { fetch, streams } = fakeStreams();
    const { log, end } = read(createIzborClient({ port: PORT, fetch }));

    streams[0]!.send(`${frame(WATCHING)}event: action\ndata: {"sessionId"\n\n${frame(STOPPED)}`);

    assert.equal(await end, "broken");
    assert.deepEqual(log, ["open", WATCHING]);
});

test("readStream: no bytes for `silenceMs` is `broken`, also when the head never comes", async () => {
    const quiet = fakeStreams();
    const opened = read(createIzborClient({ port: PORT, fetch: quiet.fetch, silenceMs: 200 }));
    for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 100));
        quiet.streams[0]!.send(": keep-alive\n\n");
    }
    const started = Date.now();
    assert.equal(await opened.end, "broken");
    assert.ok(Date.now() - started >= 150, "broken only after 200 ms with no bytes");
    assert.deepEqual(opened.log, ["open"]);
    assert.equal(quiet.calls[0]?.signal?.aborted, true, "the connection is closed");

    const hung = fakeFetch(neverAnswers);
    const unopened = read(createIzborClient({ port: PORT, fetch: hung.fetch, silenceMs: 200 }));
    assert.equal(await unopened.end, "broken");
    assert.deepEqual(unopened.log, []);
});

test("readStream: aborting `leave`, before the head or while reading, is `left`", async () => {
    const hung = fakeFetch(neverAnswers);
    const beforeHead = new AbortController();
    const unopened = read(createIzborClient({ port: PORT, fetch: hung.fetch }), beforeHead.signal);
    beforeHead.abort();
    assert.equal(await unopened.end, "left");
    assert.deepEqual(unopened.log, []);

    const { fetch, streams, calls } = fakeStreams();
    const whileReading = new AbortController();
    const opened = read(createIzborClient({ port: PORT, fetch }), whileReading.signal);
    streams[0]!.send(frame(WATCHING));
    await settle();
    whileReading.abort();
    assert.equal(await opened.end, "left");
    assert.deepEqual(opened.log, ["open", WATCHING]);
    assert.equal(calls[0]?.signal?.aborted, true, "the connection is closed");
});

const BAD_ID = { error: "bad_id", message: "4a97 is not a session id" };
const FORBIDDEN = { error: "forbidden", message: "Izbor answers only requests addressed to 127.0.0.1 or localhost" };
const NOT_FOUND = { error: "not_found", message: "GET /x is not an address Izbor knows" };

const garbled = () =>
    Promise.reject(
        new TypeError("fetch failed", {
            cause: Object.assign(new Error("Expected HTTP/"), { name: "HTTPParserError" }),
        }),
    );

const FAILURES: {
    failure: string;
    answer: (call: Call) => Response | Promise<Response>;
    calls: unknown;
    stream?: unknown;
    izbor: unknown;
    closes?: boolean;
}[] = [
    {
        failure: "a refused connection",
        answer: () => failed("ECONNREFUSED"),
        calls: { away: "not running" },
        izbor: { away: "not running" },
    },
    {
        failure: "a reset connection",
        answer: () => failed("ECONNRESET"),
        calls: { away: "stopping" },
        izbor: { away: "stopping" },
    },
    {
        failure: "a broken pipe",
        answer: () => failed("EPIPE"),
        calls: { away: "stopping" },
        izbor: { away: "stopping" },
    },
    {
        failure: "a closed socket",
        answer: () => failed("UND_ERR_SOCKET"),
        calls: { away: "stopping" },
        izbor: { away: "stopping" },
    },
    {
        failure: "no answer",
        answer: neverAnswers,
        calls: { away: "not answering" },
        stream: "broken",
        izbor: { away: "not answering" },
        closes: true,
    },
    {
        failure: "503",
        answer: () => json(503, { error: "stopping", message: "Izbor is stopping" }),
        calls: { away: "stopping" },
        izbor: { away: "stopping" },
    },
    {
        failure: "400",
        answer: () => json(400, BAD_ID),
        calls: { refused: 400, ...BAD_ID },
        izbor: { foreign: "GET /izbor answered 400" },
    },
    {
        failure: "403",
        answer: () => json(403, FORBIDDEN),
        calls: { refused: 403, ...FORBIDDEN },
        izbor: { foreign: "GET /izbor answered 403" },
    },
    {
        failure: "404",
        answer: () => json(404, NOT_FOUND),
        calls: { refused: 404, ...NOT_FOUND },
        izbor: { foreign: "GET /sessions answered 404" },
    },
    {
        failure: "an empty body",
        answer: () => empty(400, "Bad Request"),
        calls: { refused: 400, message: "Izbor answered 400 Bad Request" },
        izbor: { foreign: "GET /izbor answered 400 Bad Request, not JSON" },
    },
    {
        failure: "an HTML page",
        answer: htmlPage,
        calls: { refused: 200, message: "Izbor answered 200 OK" },
        izbor: { foreign: "GET /izbor answered 200 OK, not JSON" },
    },
    {
        failure: "an answer that is not HTTP",
        answer: garbled,
        calls: { away: "not answering" },
        stream: "broken",
        izbor: { foreign: "GET /izbor answered, but not in HTTP: Expected HTTP/" },
    },
    {
        failure: "another failure",
        answer: () => Promise.reject(new TypeError("fetch failed", { cause: new Error("bad port") })),
        calls: { away: "not answering" },
        stream: "broken",
        izbor: { away: "not answering" },
    },
];

test("no call rejects: each of the three calls answers every failure with a value", async () => {
    for (const { failure, answer, calls, stream = calls, izbor, closes } of FAILURES) {
        const fake = fakeFetch(answer);
        const client = createIzborClient({ port: PORT, fetch: fake.fetch, timeoutMs: 50, silenceMs: 50 });

        assert.deepEqual(await client.getSessions(), calls, `getSessions, ${failure}`);
        if (closes) assert.equal(fake.calls[0]?.signal?.aborted, true, `getSessions closes the connection, ${failure}`);
        assert.deepEqual(await read(client).end, stream, `readStream, ${failure}`);
        assert.deepEqual(await client.getIzbor(), izbor, `getIzbor, ${failure}`);
    }
});

test("readStream: leaving inside `event` passes no later stream event, even one already received", async () => {
    const { fetch, streams } = fakeStreams();
    const leave = new AbortController();
    const log: unknown[] = [];
    const end = createIzborClient({ port: PORT, fetch }).readStream(
        ID,
        {
            open() {},
            event(event) {
                log.push(event);
                leave.abort();
            },
        },
        leave.signal,
    );
    streams[0]!.send(frame(WATCHING) + frame(ACTION));

    assert.equal(await end, "left");
    assert.deepEqual(log, [WATCHING]);
});

test("readStream: an `event` that throws ends the read as `broken`, not as a rejection", async () => {
    const { fetch, streams } = fakeStreams();
    const end = createIzborClient({ port: PORT, fetch }).readStream(
        ID,
        {
            open() {},
            event() {
                throw new Error("a bug in the caller");
            },
        },
        new AbortController().signal,
    );
    streams[0]!.send(frame(WATCHING));

    assert.equal(await end, "broken");
});

test(
    "against a real Izbor: a stream opens and gets `session`, then `brief`, until a delete stops its watch",
    { timeout: 2000 },
    async (t) => {
        const { port } = await startIzborServer(t, { agents: [{ sessionId: ID, cwd: "/repo", status: "busy" }] });
        const client = createIzborClient({ port });
        const log: unknown[] = [];
        let briefed!: () => void;
        const brief = new Promise<void>((resolve) => (briefed = resolve));
        const end = client.readStream(
            ID,
            {
                open: () => log.push("open"),
                event(event) {
                    log.push(event);
                    if (event.type === "brief") briefed();
                },
            },
            new AbortController().signal,
        );

        await brief;
        assert.deepEqual(log.slice(0, 2), ["open", WATCHING]);
        assert.equal((log[2] as StreamEvent).type, "brief");

        assert.deepEqual(await client.getSessions(), { sessions: [{ sessionId: ID, listeners: 1 }] });

        const stopped = await fetch(`http://127.0.0.1:${port}/sessions/${ID}`, { method: "DELETE" });
        assert.deepEqual(await stopped.json(), { stopped: [ID] });
        assert.equal(await end, "ended");
        assert.deepEqual(log.at(-1), STOPPED);
    },
);

test("sendAnswer and sendPrompt post JSON with the send key, once; a refusal keeps its code, message and reason", async (t) => {
    const id = "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff";
    const cases = [
        {
            send: (client: IzborClient) =>
                client.sendAnswer(id, { at: "2026-10-09T12:00:00.000Z", answer: "yes" }, "k3y"),
            path: `/sessions/${id}/answer`,
            body: '{"at":"2026-10-09T12:00:00.000Z","answer":"yes"}',
            refusal: {
                error: "not_answerable",
                message: "That request has an answer already.",
                answerable: "answered",
            },
        },
        {
            send: (client: IzborClient) => client.sendPrompt(id, { text: "run the tests" }, "k3y"),
            path: `/sessions/${id}/prompts`,
            body: '{"text":"run the tests"}',
            refusal: {
                error: "no_plugin",
                message: "Type /reload-plugins in this session once to send messages from here.",
            },
        },
    ];
    for (const { send, path, body, refusal } of cases) {
        const received: { method?: string; url?: string; type?: string; authorization?: string; body: string }[] = [];
        const port = await portAnswering(t, (req, res) => {
            let text = "";
            req.on("data", (chunk) => (text += chunk));
            req.on("end", () => {
                const { method, url, headers } = req;
                received.push({
                    method,
                    url,
                    type: headers["content-type"],
                    authorization: headers.authorization,
                    body: text,
                });
                res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify(refusal));
            });
        });

        assert.deepEqual(await send(createIzborClient({ port })), { refused: 409, ...refusal }, path);
        assert.deepEqual(
            received,
            [{ method: "POST", url: path, type: "application/json", authorization: "Bearer k3y", body }],
            path,
        );
    }
});

test("requestStop posts `POST /izbor/stop` with the send key as `Authorization: Bearer <key>`; true only for a 202", async () => {
    const { fetch, calls } = fakeFetch(() => json(202, { stopping: true }));

    assert.equal(await createIzborClient({ port: PORT, fetch }).requestStop("k3y"), true);
    assert.deepEqual(asked(calls), [["POST", `http://127.0.0.1:${PORT}/izbor/stop`, "close"]]);
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer k3y");
});

test("requestStop is false for anything but a 202: an older Izbor's 404, a refused key, a 503, a 200, no Izbor, no answer", async () => {
    for (const answer of [
        () => json(404, { error: "not_found", message: "POST /izbor/stop is not an address Izbor knows" }),
        () => json(401, { error: "unauthorized", message: "Send Izbor's send key" }),
        () => json(503, { error: "stopping", message: "Izbor is stopping" }),
        () => json(200, { stopping: true }),
        htmlPage,
        () => failed("ECONNREFUSED"),
        () => failed("ECONNRESET"),
        neverAnswers,
    ]) {
        const { fetch } = fakeFetch(answer);
        assert.equal(await createIzborClient({ port: PORT, fetch, timeoutMs: 50 }).requestStop("k3y"), false);
    }
});

test("successful sends require a valid answer or collected prompt id", async () => {
    for (const body of [null, [], {}, { sent: 3 }, { sent: "unexpected" }, { collected: 3 }, { collected: "" }]) {
        const client = createIzborClient({ port: PORT, fetch: fakeFetch(() => json(200, body)).fetch });
        assert.deepEqual(await client.sendAnswer(ID, { at: "now", answer: "yes" }, "key"), {
            refused: 200,
            message: "Izbor answered 200 with invalid data",
        });
        assert.deepEqual(await client.sendPrompt(ID, { text: "run tests" }, "key"), {
            refused: 200,
            message: "Izbor answered 200 with invalid data",
        });
    }
    for (const sent of ["yes", "no", "no please stop", "1", "24"]) {
        const client = createIzborClient({ port: PORT, fetch: fakeFetch(() => json(200, { sent })).fetch });
        assert.deepEqual(await client.sendAnswer(ID, { at: "now", answer: sent }, "key"), { sent });
    }
    const client = createIzborClient({ port: PORT, fetch: fakeFetch(() => json(200, { collected: ID })).fetch });
    assert.deepEqual(await client.sendPrompt(ID, { text: "run tests" }, "key"), { collected: ID });
});

test("unknown refusal codes and answerability reasons do not become trusted union members", async () => {
    const client = createIzborClient({
        port: PORT,
        fetch: fakeFetch(() =>
            json(409, {
                error: "new_error",
                answerable: "new_reason",
                message: "A newer Izbor refused this request.",
            }),
        ).fetch,
    });
    assert.deepEqual(await client.sendAnswer(ID, { at: "now", answer: "yes" }, "key"), {
        refused: 409,
        message: "A newer Izbor refused this request.",
    });
});

test("an already cancelled send never starts an HTTP request", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { sent: "yes", collected: ID }));
    const client = createIzborClient({ port: PORT, fetch });
    const cancel = new AbortController();
    const reason = new Error("the source was disposed");
    cancel.abort(reason);
    await assert.rejects(
        client.sendAnswer(ID, { at: "now", answer: "yes" }, "key", cancel.signal),
        (error) => error === reason,
    );
    await assert.rejects(
        client.sendPrompt(ID, { text: "run tests" }, "key", cancel.signal),
        (error) => error === reason,
    );
    assert.deepEqual(calls, []);
});

test("cancelling a send aborts the HTTP request and rejects with the caller's reason", async () => {
    for (const operation of ["answer", "prompt"] as const) {
        const { fetch, calls } = fakeFetch(neverAnswers);
        const client = createIzborClient({ port: PORT, fetch });
        const cancel = new AbortController();
        const reason = new Error("the source was disposed");
        const sent =
            operation === "answer"
                ? client.sendAnswer(ID, { at: "now", answer: "yes" }, "key", cancel.signal)
                : client.sendPrompt(ID, { text: "run tests" }, "key", cancel.signal);
        cancel.abort(reason);
        await assert.rejects(sent, (error) => error === reason);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.signal?.aborted, true);
    }
});

test("successful replies expose only their own result fields, ignoring foreign union discriminants", async () => {
    const { fetch } = fakeFetch(() =>
        json(200, {
            sessions: [],
            sent: "yes",
            collected: ID,
            away: "not running",
            refused: 403,
            message: "Nothing was sent.",
        }),
    );
    const client = createIzborClient({ port: PORT, fetch });
    assert.deepEqual(await client.getSessions(), { sessions: [] });
    assert.deepEqual(await client.sendAnswer(ID, { at: "now", answer: "yes" }, "key"), { sent: "yes" });
    assert.deepEqual(await client.sendPrompt(ID, { text: "run tests" }, "key"), { collected: ID });
});

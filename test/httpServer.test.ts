import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "../src/domain/streamEvent.js";
import { OTHER_ID, SESSION_ID, startServer } from "./helpers/fakeTrackerServer.js";
import { assertJson, FORBIDDEN_HOST, FORBIDDEN_SITE, postInTwoPieces, withHost } from "./helpers/http.js";
import { readUntil, until } from "./support.js";

const WATCHING: StreamEvent = { type: "session", sessionId: SESSION_ID, state: "watching" };

const HOOK = { session_id: SESSION_ID, hook_event_name: "Stop" };

const EVERY_ROUTE = [
    ["POST", "/hook"],
    ["GET", `/sessions/${SESSION_ID}/events`],
    ["GET", "/events"],
    ["GET", "/sessions"],
    ["GET", "/izbor"],
    ["DELETE", `/sessions/${SESSION_ID}`],
    ["DELETE", "/sessions"],
    ["GET", "/other"],
] as const;

const REJECTED_PAYLOAD = { error: "rejected_payload", message: "Izbor could not read this as a hook" };

const bodyOf = (method: string) => (method === "POST" ? JSON.stringify(HOOK) : undefined);

function fromSite(base: string, method: string, path: string, site: string) {
    return fetch(`${base}${path}`, { method, headers: { "Sec-Fetch-Site": site }, body: bodyOf(method) });
}

async function openStream(t: TestContext, base: string, path = `/sessions/${SESSION_ID}/events`) {
    const closing = new AbortController();
    t.after(() => closing.abort());
    const response = await fetch(`${base}${path}`, { signal: closing.signal });
    return { response, close: () => closing.abort() };
}

test("GET /sessions/<id>/events tunes in to the id and streams each stream event as SSE, named on its `event:` line", async (t) => {
    const { tunedIn, base } = await startServer(t);

    const { response } = await openStream(t, base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(
        tunedIn.map(({ sessionId }) => sessionId),
        [SESSION_ID],
    );

    const action: StreamEvent = { type: "action", sessionId: SESSION_ID, at: "2026-10-04T12:00:05.123Z", what: "a\nb" };
    tunedIn[0]!.listener.send(WATCHING);
    tunedIn[0]!.listener.send(action);

    assert.equal(
        await readUntil(response.body!, "a\\nb"),
        `event: session\ndata: {"sessionId":"${SESSION_ID}","state":"watching"}\n\n` +
            `event: action\ndata: {"sessionId":"${SESSION_ID}","at":"2026-10-04T12:00:05.123Z","what":"a\\nb"}\n\n`,
    );
});

test("GET /events tunes in to every session and streams the stream events of each, and tunes in to no one session", async (t) => {
    const { tunedIn, tunedInAll, base } = await startServer(t);

    const { response } = await openStream(t, base, "/events");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(tunedInAll.length, 1);
    assert.deepEqual(tunedIn, []);

    const other: StreamEvent = { type: "session", sessionId: OTHER_ID, state: "not listed" };
    tunedInAll[0]!.send(WATCHING);
    tunedInAll[0]!.send(other);

    assert.equal(
        await readUntil(response.body!, OTHER_ID),
        `event: session\ndata: {"sessionId":"${SESSION_ID}","state":"watching"}\n\n` +
            `event: session\ndata: {"sessionId":"${OTHER_ID}","state":"not listed"}\n\n`,
    );
});

test("a quiet stream gets a comment line every 30 s, which SSE readers skip, so a `fetch` reader does not give up on it", async (t) => {
    const { base } = await startServer(t);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { response } = await openStream(t, base);

    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);

    assert.equal(
        await readUntil(response.body!, ": keep-alive\n\n: keep-alive\n\n"),
        ": keep-alive\n\n: keep-alive\n\n",
    );
});

test("a stream event sent inside the tune-in goes out after the head", async (t) => {
    const { base } = await startServer(t, { onTuneIn: (listener) => listener.send(WATCHING) });

    const { response } = await openStream(t, base);

    assert.equal(response.status, 200);
    assert.match(await readUntil(response.body!, "\n\n"), /^event: session\ndata: /);
});

test("closing the stream from the other end settles the listener's `gone`", async (t) => {
    const { tunedIn, base } = await startServer(t);
    const stream = await openStream(t, base);

    stream.close();

    await tunedIn[0]!.listener.gone;
});

test("a listener Izbor ends ends its stream, and its `gone` settles", async (t) => {
    const { tunedIn, base } = await startServer(t);
    const { response } = await openStream(t, base);

    tunedIn[0]!.listener.send(WATCHING);
    tunedIn[0]!.listener.end();

    assert.match(await readUntil(response.body!, "never sent"), /^event: session\n[^\n]+\n\n$/);
    await tunedIn[0]!.listener.gone;
});

test("DELETE /sessions/<id> stops the watch of the id in lower case: 200 with it when watched, else 404 `not_watched`; an id that is not a session id gets 400 `bad_id` and stops nothing", async (t) => {
    const unwatched = "00000000-0000-4000-8000-00000000000a";
    const lowerUnwatched = "00000000-0000-4000-8000-000000000003";
    const cases: [string, number, unknown, string[]][] = [
        [SESSION_ID.toUpperCase(), 200, { stopped: [SESSION_ID] }, [SESSION_ID]],
        [unwatched.toUpperCase(), 404, { error: "not_watched", message: `${unwatched} is not watched` }, [unwatched]],
        [lowerUnwatched, 404, { error: "not_watched", message: `${lowerUnwatched} is not watched` }, [lowerUnwatched]],
        ["abc", 400, { error: "bad_id", message: "abc is not a session id" }, []],
    ];
    for (const [id, status, body, stopped] of cases) {
        const { stops, base } = await startServer(t);
        await assertJson(await fetch(`${base}/sessions/${id}`, { method: "DELETE" }), status, body, id);
        assert.deepEqual(stops, stopped, id);
    }
});

test("DELETE /sessions stops every watch with `deleted` and answers the ids it stopped", async (t) => {
    const { stopAlls, base } = await startServer(t);

    const response = await fetch(`${base}/sessions`, { method: "DELETE" });

    await assertJson(response, 200, { stopped: [SESSION_ID, OTHER_ID] });
    assert.deepEqual(stopAlls, ["deleted"]);
});

test("a hook still arriving when Izbor begins to stop is handed over, and its answer closes the connection", async (t) => {
    let stopping = false;
    const { hooks, url } = await startServer(t, { closing: () => stopping });
    const body = JSON.stringify(HOOK);

    const answer = await postInTwoPieces(url, body.slice(0, 10), body.slice(10), () => (stopping = true));

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("connection"), "close");
    assert.deepEqual(hooks, [HOOK]);
});

test("a hook whose body arrives in two pieces, split inside a character, is read whole", async (t) => {
    const { hooks, url } = await startServer(t);
    const payload = { ...HOOK, last_assistant_message: "Готово: café ☕" };
    const body = Buffer.from(JSON.stringify(payload));
    const inside = body.indexOf(Buffer.from("☕")) + 1;

    const answer = await postInTwoPieces(url, body.subarray(0, inside), body.subarray(inside));

    assert.equal(answer.status, 200);
    assert.deepEqual(hooks, [payload]);
});

test("GET /sessions answers each watched session with its number of listeners", async (t) => {
    const { base } = await startServer(t);

    const response = await fetch(`${base}/sessions`);

    await assertJson(response, 200, {
        sessions: [
            { sessionId: SESSION_ID, listeners: 2 },
            { sessionId: OTHER_ID, listeners: 0 },
        ],
    });
});

test("an id that is not a session id gets 400 `bad_id`, and tunes in to nothing", async (t) => {
    const { tunedIn, base } = await startServer(t);

    const response = await fetch(`${base}/sessions/abc/events`);

    await assertJson(response, 400, { error: "bad_id", message: "abc is not a session id" });
    assert.deepEqual(tunedIn, []);
});

test("an address Izbor does not know, or a wrong method on a known one, gets 404 `not_found`", async (t) => {
    const { base } = await startServer(t);

    for (const [method, path] of [
        ["GET", "/other"],
        ["GET", "/hook"],
        ["GET", `/sessions/${SESSION_ID}`],
        ["GET", "/sessions/abc"],
        ["GET", `/sessions/${SESSION_ID}/events/more`],
        ["GET", "/events/more"],
        ["DELETE", "/events"],
        ["DELETE", `/sessions/${SESSION_ID}/events`],
        ["POST", "/sessions"],
        ["PUT", `/sessions/${SESSION_ID}`],
    ] as const) {
        const response = await fetch(`${base}${path}`, { method });
        await assertJson(
            response,
            404,
            { error: "not_found", message: `${method} ${path} is not an address Izbor knows` },
            path,
        );
    }
});

test("POST /hook answers 200 with no body and hands the hook over", async (t) => {
    const { hooks, url } = await startServer(t);

    const ok = await fetch(url, { method: "POST", body: JSON.stringify(HOOK) });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "");
    assert.deepEqual(hooks, [HOOK]);
});

test("a hook that is not JSON, has no session_id, or a malformed one is rejected with 400 `rejected_payload` before it can reach the file writer", async (t) => {
    const { hooks, url } = await startServer(t);

    const malformedIds = [
        "",
        "s1",
        "../outside",
        "..\\outside",
        "/tmp/outside",
        `${SESSION_ID}/../../outside`,
        `${SESSION_ID}\n`,
        ` ${SESSION_ID}`,
        `${SESSION_ID}\u0000`,
        "123e4567-e89b-12d3-a456-42661417400g",
        "123e4567-e89b-12d3-a456-42661417400",
    ];
    for (const body of [
        "not json",
        "null",
        "42",
        JSON.stringify({ hook_event_name: "Stop" }),
        JSON.stringify({ session_id: 7 }),
        ...malformedIds.map((sessionId) => JSON.stringify({ session_id: sessionId, hook_event_name: "Notification" })),
    ]) {
        await assertJson(await fetch(url, { method: "POST", body }), 400, REJECTED_PAYLOAD, body);
    }
    assert.deepEqual(hooks, []);
});

test("a payload with a session_id and no hook_event_name is answered 200 and handed over", async (t) => {
    const { hooks, rejected, url } = await startServer(t);
    const payload = { session_id: SESSION_ID };

    const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });

    assert.equal(response.status, 200);
    assert.deepEqual(hooks, [payload]);
    assert.deepEqual(rejected, []);
});

test("a payload with a typed field of the wrong type is rejected: 400 `rejected_payload`, handed over as rejected and never as a hook", async (t) => {
    const { hooks, rejected, url } = await startServer(t);
    const body = JSON.stringify({ session_id: SESSION_ID, cwd: 7 });

    await assertJson(await fetch(url, { method: "POST", body }), 400, REJECTED_PAYLOAD);

    assert.deepEqual(hooks, []);
    assert.deepEqual(rejected, [body]);
});

test("POST /hook/answer with a typed field of the wrong type gets the empty 200 at once: it is never held", async (t) => {
    const held: unknown[] = [];
    const holdAnswer = async (hook: unknown) => {
        held.push(hook);
        return null;
    };
    const { hooks, rejected, base } = await startServer(t, { holdAnswer });

    const response = await fetch(`${base}/hook/answer`, {
        method: "POST",
        body: JSON.stringify({ session_id: SESSION_ID, cwd: 7 }),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.deepEqual([held, hooks, rejected], [[], [], []]);
});

test("uppercase UUID session IDs are accepted without changing the payload", async (t) => {
    const { hooks, url } = await startServer(t);
    const payload = { session_id: SESSION_ID.toUpperCase(), hook_event_name: "Notification" };

    const response = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.deepEqual(hooks, [payload]);
});

test("a rejected payload is handed over as it arrived; an accepted hook and a wrong address are not", async (t) => {
    const { rejected, base, url } = await startServer(t);
    const noSessionId = JSON.stringify({ hook_event_name: "Stop" });

    await fetch(url, { method: "POST", body: "not json" });
    await fetch(url, { method: "POST", body: noSessionId });
    await fetch(url, { method: "POST", body: JSON.stringify(HOOK) });
    await fetch(`${base}/other`, { method: "POST", body: "elsewhere" });

    assert.deepEqual(rejected, ["not json", noSessionId]);
});

test("a request a browser sends for another website gets 403 `forbidden` on every route, `/hook` included, and reaches nothing", async (t) => {
    const { hooks, rejected, tunedIn, tunedInAll, stops, stopAlls, base } = await startServer(t);

    for (const site of ["cross-site", "same-site"]) {
        for (const [method, path] of EVERY_ROUTE) {
            const response = await fromSite(base, method, path, site);
            await assertJson(response, 403, FORBIDDEN_SITE, `${site}: ${method} ${path}`);
        }
    }
    assert.deepEqual([hooks, rejected, tunedIn, tunedInAll, stops, stopAlls], [[], [], [], [], [], []]);
});

test("a request a browser sends for no website, or for Izbor itself, passes", async (t) => {
    const { hooks, base } = await startServer(t);

    for (const site of ["none", "same-origin"]) {
        assert.equal((await fromSite(base, "GET", "/sessions", site)).status, 200, site);
        assert.equal((await fromSite(base, "POST", "/hook", site)).status, 200, site);
    }
    assert.equal(hooks.length, 2);
});

test("a request addressed to a name other than 127.0.0.1 or localhost gets 403 `forbidden` on every route, and reaches nothing", async (t) => {
    const { hooks, rejected, tunedIn, tunedInAll, stops, stopAlls, base } = await startServer(t);

    for (const host of ["evil.example:4319", "evil.example", "localhost.evil.example:4319", "127.0.0.1.evil.example"]) {
        for (const [method, path] of EVERY_ROUTE) {
            const response = await withHost(base, method, path, host, bodyOf(method));
            await assertJson(response, 403, FORBIDDEN_HOST, `${host}: ${method} ${path}`);
        }
    }
    assert.deepEqual([hooks, rejected, tunedIn, tunedInAll, stops, stopAlls], [[], [], [], [], [], []]);
});

test("a request addressed to 127.0.0.1 or localhost passes", async (t) => {
    const { hooks, base } = await startServer(t);

    for (const host of ["127.0.0.1:4319", "localhost:4319", "localhost", "LOCALHOST:4319"]) {
        assert.equal((await withHost(base, "GET", "/sessions", host)).status, 200, host);
        assert.equal((await withHost(base, "POST", "/hook", host, bodyOf("POST"))).status, 200, host);
    }
    assert.equal(hooks.length, 4);
});

test("checks run in order: the guard (403), Izbor stopping (503, not for POST /hook), the route (404), the id (400)", async (t) => {
    const stopping = await startServer(t, { closing: true });
    const running = await startServer(t);

    await assertJson(await fromSite(stopping.base, "PUT", "/sessions/abc", "cross-site"), 403, FORBIDDEN_SITE);
    await assertJson(await fromSite(stopping.base, "POST", "/hook", "cross-site"), 403, FORBIDDEN_SITE);
    await assertJson(await fetch(`${stopping.base}/sessions/abc`, { method: "PUT" }), 503, {
        error: "stopping",
        message: "Izbor is stopping",
    });
    await assertJson(await fetch(`${running.base}/sessions/abc`, { method: "PUT" }), 404, {
        error: "not_found",
        message: "PUT /sessions/abc is not an address Izbor knows",
    });
    await assertJson(await fetch(`${running.base}/sessions/abc`, { method: "DELETE" }), 400, {
        error: "bad_id",
        message: "abc is not a session id",
    });
});

test("no answer carries an Access-Control-* header, so no web page can read one", async (t) => {
    const { tunedIn, base, url } = await startServer(t);
    const stopping = await startServer(t, { closing: true });
    const headers = { Origin: "https://evil.example" };

    const stream = await openStream(t, base);
    const answers = [
        stream.response,
        await fetch(url, {
            method: "OPTIONS",
            headers: {
                ...headers,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        }),
        await fetch(url, { method: "POST", headers, body: JSON.stringify(HOOK) }),
        await fetch(url, { method: "POST", headers, body: "not json" }),
        await fetch(`${base}/sessions`, { headers }),
        await fetch(`${base}/sessions/abc/events`, { headers }),
        await fetch(`${base}/other`, { headers }),
        await fromSite(base, "GET", "/sessions", "cross-site"),
        await fetch(`${stopping.base}/sessions`, { headers }),
    ];

    for (const response of answers) {
        assert.deepEqual(
            [...response.headers.keys()].filter((name) => name.startsWith("access-control-")),
            [],
            `${response.status} ${response.url}`,
        );
    }
    assert.equal(tunedIn.length, 1);
});

const BEARER = { authorization: `Bearer ${"0".repeat(64)}` };

const UNAUTHORIZED = {
    error: "unauthorized",
    message: "Send Izbor's send key as Authorization: Bearer <key>, the key in the file GET /izbor names",
};

const SEND_KEY_ROUTES_WITH_ID = [
    ["POST", "/answer", JSON.stringify({ at: "2026-10-04T12:00:05.123Z", answer: "yes" })],
    ["POST", "/prompts", JSON.stringify({ text: "run the tests" })],
    ["GET", "/prompts/next", undefined],
] as const;

test("while Izbor stops, every address but POST /hook gets 503 `stopping` before the id and the send key are checked, every answer closes its connection, and nothing is tuned in or stopped", async (t) => {
    const { tunedIn, tunedInAll, stops, stopAlls, hooks, base, url } = await startServer(t, { closing: true });
    const promptId = "00000000-0000-4000-8000-000000000000";

    for (const [method, path] of [
        ...EVERY_ROUTE.filter(([, path]) => path !== "/hook"),
        ["GET", "/sessions/abc/events"],
        ...SEND_KEY_ROUTES_WITH_ID.map(([method, rest]) => [method, `/sessions/${SESSION_ID}${rest}`] as const),
        ...SEND_KEY_ROUTES_WITH_ID.map(([method, rest]) => [method, `/sessions/abc${rest}`] as const),
        ["POST", `/prompts/${promptId}/delivered`],
        ["POST", `/prompts/${promptId}/dropped`],
    ] as const) {
        const response = await fetch(`${base}${path}`, { method });
        await assertJson(response, 503, { error: "stopping", message: "Izbor is stopping" }, `${method} ${path}`);
        assert.equal(response.headers.get("connection"), "close", `${method} ${path}`);
    }
    assert.deepEqual(tunedIn, []);
    assert.deepEqual(tunedInAll, []);
    assert.deepEqual(stops, []);
    assert.deepEqual(stopAlls, []);

    const hook = await fetch(url, { method: "POST", body: JSON.stringify(HOOK) });
    assert.equal(hook.status, 200);
    assert.equal(hook.headers.get("connection"), "close");
    await hook.text();
    assert.deepEqual(hooks, [HOOK]);
    const rejected = await fetch(url, { method: "POST", body: "not json" });
    assert.equal(rejected.headers.get("connection"), "close");
    await rejected.text();
    const refused = await fromSite(base, "GET", "/sessions", "cross-site");
    assert.equal(refused.headers.get("connection"), "close");
    await refused.text();
});

test("while Izbor stops, POST /hook/answer is received: it gets the empty 200, no decision, at once, and its connection closes", async (t) => {
    const { hooks, rejected, base } = await startServer(t, { closing: true });

    for (const body of [JSON.stringify(HOOK), "not json"]) {
        const response = await fetch(`${base}/hook/answer`, { method: "POST", body });
        assert.equal(response.status, 200, body);
        assert.equal(response.headers.get("connection"), "close", body);
        assert.equal(await response.text(), "", body);
    }
    assert.deepEqual([hooks, rejected], [[], []]);
});

test("on a route with an id and the send key, the id is checked first: 400 `bad_id` without the key, then 401 `unauthorized` for a session id", async (t) => {
    const { base } = await startServer(t);

    for (const [method, rest, body] of SEND_KEY_ROUTES_WITH_ID) {
        const badId = await fetch(`${base}/sessions/abc${rest}`, { method, body });
        await assertJson(badId, 400, { error: "bad_id", message: "abc is not a session id" }, `${method} ${rest}`);

        const noKey = await fetch(`${base}/sessions/${SESSION_ID}${rest}`, { method, body });
        await assertJson(noKey, 401, UNAUTHORIZED, `${method} ${rest}`);
    }
});

test("with the send key, the answer route says 404 `not_watched` to a session nobody watches", async (t) => {
    const { base } = await startServer(t);
    const answer = JSON.stringify({ at: "2026-10-04T12:00:05.123Z", answer: "yes" });

    await assertJson(
        await fetch(`${base}/sessions/${SESSION_ID}/answer`, { method: "POST", headers: BEARER, body: answer }),
        404,
        { error: "not_watched", message: `${SESSION_ID} is not watched` },
    );
});

test("with the send key, the answer route says 400 `bad_answer` to a body it cannot read or JSON that is no answer: `null`, a list, a text, and an `at` that is no text", async (t) => {
    const { base } = await startServer(t);

    for (const body of ["not json", "null", "[]", '"x"', '{"at": 1}']) {
        const response = await fetch(`${base}/sessions/${SESSION_ID}/answer`, {
            method: "POST",
            headers: BEARER,
            body,
        });
        await assertJson(
            response,
            400,
            { error: "bad_answer", message: 'Izbor could not read this as an answer: send {"at", "answer"}' },
            body,
        );
    }
});

test("a route whose promise rejects hands the error to `onBug` once and answers nothing, and Izbor goes on answering: a rejecting `holdAnswer`, `prompts.send` and `prompts.next`", async (t) => {
    const [holdBug, sendBug, nextBug] = [new Error("hold"), new Error("send"), new Error("next")];
    const { bugs, base } = await startServer(t, {
        holdAnswer: () => Promise.reject(holdBug),
        send: () => Promise.reject(sendBug),
        next: () => Promise.reject(nextBug),
    });
    const leaving = new AbortController();
    t.after(() => leaving.abort());
    const send = (method: string, path: string, body?: string) =>
        fetch(`${base}${path}`, { method, headers: BEARER, body, signal: leaving.signal }).then(
            ({ status }) => `answered ${status}`,
            () => "left unanswered",
        );

    const failed = [];
    for (const [method, path, body] of [
        ["POST", "/hook/answer", JSON.stringify(HOOK)],
        ["POST", `/sessions/${SESSION_ID}/prompts`, JSON.stringify({ text: "run the tests" })],
        ["GET", `/sessions/${SESSION_ID}/prompts/next`, undefined],
    ] as const) {
        failed.push(send(method, path, body));
        const reached = failed.length;
        await until(() => bugs.length >= reached);
        assert.equal((await fetch(`${base}/izbor`)).status, 200, `${method} ${path}`);
    }

    assert.deepEqual(bugs, [holdBug, sendBug, nextBug]);
    leaving.abort();
    assert.deepEqual(await Promise.all(failed), ["left unanswered", "left unanswered", "left unanswered"]);
});

test("POST /izbor/stop without the send key, or with another key, gets 401 `unauthorized`, and no stop is requested", async (t) => {
    const { stopRequests, base } = await startServer(t);

    const refused: Record<string, string>[] = [{}, { authorization: `Bearer ${"1".repeat(64)}` }];
    for (const headers of refused) {
        const response = await fetch(`${base}/izbor/stop`, { method: "POST", headers });
        await assertJson(response, 401, UNAUTHORIZED, JSON.stringify(headers));
    }
    assert.equal(stopRequests.count, 0);
});

test("POST /izbor/stop with the send key gets 202 `{stopping: true}`, then requests the Izbor stop once", async (t) => {
    const { stopRequests, base } = await startServer(t);

    const response = await fetch(`${base}/izbor/stop`, { method: "POST", headers: BEARER });

    await assertJson(response, 202, { stopping: true });
    assert.equal(stopRequests.count, 1);
});

test("while Izbor stops, POST /izbor/stop with the send key still gets 202, and its connection closes", async (t) => {
    const { stopRequests, base } = await startServer(t, { closing: true });

    const response = await fetch(`${base}/izbor/stop`, { method: "POST", headers: BEARER });

    await assertJson(response, 202, { stopping: true });
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(stopRequests.count, 1);
});

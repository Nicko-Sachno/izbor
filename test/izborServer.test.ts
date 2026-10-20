import { test } from "node:test";
import assert from "node:assert/strict";
import { assertJson } from "./helpers/http.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { hook, readUntil, SESSION } from "./support.js";

const frames = (text: string) =>
    [...text.matchAll(/^event: (\S+)\ndata: (.*)\n\n/gm)].map(([, event, data]) => [event, JSON.parse(data!)]);

test("a hook posted to the server reaches the Izbor: the watch streams its action", async (t) => {
    const { base } = await startIzborServer(t);
    const response = await fetch(`${base}/sessions/${SESSION}/events`);
    await readUntil(response.body!, "event: brief");

    const posted = await fetch(`${base}/hook`, {
        method: "POST",
        body: JSON.stringify(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } })),
    });
    assert.equal(posted.status, 200);

    const [action] = frames(await readUntil(response.body!, "event: action"));
    assert.equal(action?.[0], "action");
    assert.equal(action[1].what, "started Bash: npm test");
});

test("a payload the server rejects reaches the Izbor, which writes an error to the Izbor log", async (t) => {
    const { base, izbor } = await startIzborServer(t);

    const posted = await fetch(`${base}/hook`, { method: "POST", body: "not a hook" });
    assert.equal(posted.status, 400);
    await posted.text();

    assert.deepEqual(izbor.errors(), ["izbor error: answered 400 to a payload without a session id: not a hook"]);
});

const STOPPING = { error: "stopping", message: "Izbor is stopping" };

test("GET /izbor says who this Izbor is: exactly its service, pid, port, data folder, listen time and send key's file", async (t) => {
    const began = Date.now();
    const { base, port, info } = await startIzborServer(t);

    const response = await fetch(`${base}/izbor`);

    await assertJson(response, 200, info);
    assert.deepEqual(Object.keys(info).sort(), ["dataDir", "pid", "port", "sendKeyPath", "service", "startedAt"]);
    assert.equal(info.service, "izbor");
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, port);
    assert.equal(typeof info.dataDir, "string");
    assert.equal(new Date(info.startedAt).toISOString(), info.startedAt);
    assert.ok(Date.parse(info.startedAt) >= began, `${info.startedAt} is before the test began`);
});

test("only GET on exactly /izbor answers: `/izbor/`, HEAD and POST get 404 `not_found`; once the Izbor stop begins, 503 `stopping`", async (t) => {
    const { base, izbor } = await startIzborServer(t);

    for (const [method, path] of [
        ["GET", "/izbor/"],
        ["POST", "/izbor"],
        ["DELETE", "/izbor"],
        ["GET", "/izbor?pid"],
    ] as const) {
        await assertJson(
            await fetch(`${base}${path}`, { method }),
            404,
            { error: "not_found", message: `${method} ${path} is not an address Izbor knows` },
            `${method} ${path}`,
        );
    }
    const head = await fetch(`${base}/izbor`, { method: "HEAD" });
    assert.equal(head.status, 404);
    assert.equal(head.headers.get("content-type"), "application/json");

    izbor.tracker.close();
    await assertJson(await fetch(`${base}/izbor`), 503, STOPPING);
    await assertJson(await fetch(`${base}/izbor/`), 503, STOPPING);
    assert.equal((await fetch(`${base}/izbor`, { method: "HEAD" })).status, 503);
});

test("GET /izbor has no side effect: it starts no watch, adds no listener and saves no file", async (t) => {
    const { base, izbor } = await startIzborServer(t);
    const sessions = async () => (await fetch(`${base}/sessions`)).json();

    assert.deepEqual(await sessions(), { sessions: [] });
    assert.equal((await fetch(`${base}/izbor`)).status, 200);
    assert.deepEqual(await sessions(), { sessions: [] });

    const listener = izbor.tuneIn(SESSION);
    await listener.caughtUp();
    const files = await izbor.files();
    const before = await sessions();
    assert.deepEqual(before, { sessions: [{ sessionId: SESSION, listeners: 1 }] });
    assert.equal((await fetch(`${base}/izbor`)).status, 200);
    assert.deepEqual(await sessions(), before);
    assert.deepEqual(await izbor.files(), files);
    assert.equal(listener.events.length, 2);
});

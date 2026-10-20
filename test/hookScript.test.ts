import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { PROJECT_DIR } from "../src/config.js";
import { LOOPBACK } from "../src/domain/wire.js";
import { fullBacklog } from "./helpers/fullBacklog.js";
import { freePort, portAnswering } from "./support.js";

const SCRIPT = join(PROJECT_DIR, "bin", "post-hook.js");

async function postHook(args: string[], stdin: string) {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.stdin.end(stdin);
    const [code] = await once(child, "exit");
    return { code: code as number | null, stdout, stderr, tookMs: Date.now() - started };
}

async function recording(t: TestContext, answer: (body: string) => [number, string]) {
    const got: { method?: string; type?: string; body: string }[] = [];
    const listener: RequestListener = (request, response) => {
        let body = "";
        request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            got.push({ method: request.method, type: request.headers["content-type"], body });
            const [status, text] = answer(body);
            response.writeHead(status).end(text);
        });
    };
    const port = await portAnswering(t, listener);
    return { got, url: (path: string) => `http://${LOOPBACK}:${port}${path}` };
}

const PAYLOAD = JSON.stringify({ session_id: "s-1", hook_event_name: "Stop", text: 'naïve ✓ "quoted"\n' });

test("the hook runner POSTs its stdin as JSON to the URL, byte for byte, and prints nothing without print", async (t) => {
    const server = await recording(t, () => [200, "ignored"]);
    const ran = await postHook([server.url("/hook"), "2"], PAYLOAD);
    assert.deepEqual(server.got, [{ method: "POST", type: "application/json", body: PAYLOAD }]);
    assert.deepEqual(ran, { ...ran, code: 0, stdout: "", stderr: "" });
});

test("with print, the hook runner prints a 2xx body, and nothing for a 404", async (t) => {
    const server = await recording(t, (body) => (body === "{}" ? [404, "no such route"] : [200, `{"decision":1}`]));
    const answered = await postHook([server.url("/hook/answer"), "2", "print"], PAYLOAD);
    assert.deepEqual([answered.code, answered.stdout, answered.stderr], [0, `{"decision":1}`, ""]);
    const older = await postHook([server.url("/hook/answer"), "2", "print"], "{}");
    assert.deepEqual([older.code, older.stdout, older.stderr], [0, "", ""]);
});

test("with nothing on the port, the hook runner exits 0 at once, silent", async () => {
    const ran = await postHook([`http://${LOOPBACK}:${await freePort()}/hook`, "30", "print"], PAYLOAD);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, "", ""]);
    assert.ok(ran.tookMs < 1500, `took ${ran.tookMs} ms`);
});

test("a port whose connect never completes: the hook runner gives up connecting after 1 s, before its limit, and exits 0, silent", async (t) => {
    const port = await fullBacklog(t);
    const ran = await postHook([`http://${LOOPBACK}:${port}/hook/answer`, "30", "print"], PAYLOAD);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, "", ""]);
    assert.ok(ran.tookMs >= 900 && ran.tookMs < 1900, `took ${ran.tookMs} ms`);
});

test("a server that never answers: the hook runner gives up after its limit and exits 0, silent", async (t) => {
    const server = createServer(() => {}).listen(0, LOOPBACK);
    await once(server, "listening");
    t.after(() => server.close());
    t.after(() => server.closeAllConnections());
    const { port } = server.address() as { port: number };
    const ran = await postHook([`http://${LOOPBACK}:${port}/hook/answer`, "1", "print"], PAYLOAD);
    assert.deepEqual([ran.code, ran.stdout, ran.stderr], [0, "", ""]);
    assert.ok(ran.tookMs >= 900 && ran.tookMs < 2500, `took ${ran.tookMs} ms`);
});

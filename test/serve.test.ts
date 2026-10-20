import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IzborInfo } from "../src/domain/wire.js";
import { startServe } from "./helpers/bin.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { homeEnv, skipOnWindows } from "./helpers/fakeCommand.js";
import { readSendKey } from "./helpers/answerHook.js";
import { stopTestIzbor } from "./helpers/stopTestIzbor.js";
import { freePort, portAnswering } from "./support.js";

const whoAnswers = (port: number) =>
    fetch(`http://127.0.0.1:${port}/izbor`).then((response) => response.json() as Promise<IzborInfo>);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(
        signal === "SIGINT"
            ? `izbor serve --port listens there, not on PORT, and prints the five start lines; ${signal} runs the Izbor stop: exit 0`
            : `${signal} runs the Izbor stop of izbor serve: exit 0`,
        skipOnWindows("Windows has no soft signals to a child"),
        async (t) => {
            const port = await freePort();
            const ambient = await freePort();
            const { child, dataDir, output, exited, listening } = await startServe(t, ["--port", String(port)], {
                PORT: String(ambient),
            });
            await listening();

            if (signal === "SIGINT") {
                assert.deepEqual(output.stdout.trimEnd().split("\n"), [
                    "izbor watches no session yet. Tune in to one by its id:",
                    `  curl -N http://127.0.0.1:${port}/sessions/SESSION_ID/events (Windows PowerShell: curl.exe -N http://127.0.0.1:${port}/sessions/SESSION_ID/events)`,
                    `  every watched session at once: curl -N http://127.0.0.1:${port}/events (Windows PowerShell: curl.exe -N http://127.0.0.1:${port}/events)`,
                    `  hooks: http://127.0.0.1:${port}/hook`,
                    `  data:  ${dataDir}`,
                ]);
                const info = await whoAnswers(port);
                assert.deepEqual(
                    [info.service, info.pid, info.port, info.dataDir],
                    ["izbor", child.pid, port, dataDir],
                );
                await assert.rejects(fetch(`http://127.0.0.1:${ambient}/izbor`), "nothing listens on PORT");
            }

            child.kill(signal);

            assert.deepEqual(await exited, [0, null], output.text);
            assert.match(output.stdout, /\nizbor stopped\n$/);
            assert.equal(output.stderr, "");
            await assert.rejects(fetch(`http://127.0.0.1:${port}/izbor`));
        },
    );
}

test("with no --port, serve listens on IZBOR_PORT; a port that is not a port and a data folder that is not absolute are refused with one line, exit 1", async (t) => {
    const port = await freePort();
    const serve = await startServe(t, [], { IZBOR_PORT: String(port) });
    await serve.listening();
    assert.equal((await whoAnswers(port)).port, port);
    await stopTestIzbor(port);
    assert.deepEqual(await serve.exited, [0, null], serve.output.text);

    const notPort = await startServe(t, ["--port", "0"]);
    assert.deepEqual(await notPort.exited, [1, null]);
    assert.deepEqual(
        [notPort.output.stdout, notPort.output.stderr],
        ["", '--port must be a port from 1 to 65535, not "0".\n'],
    );

    const relative = await startServe(t, ["--port", String(await freePort())], { IZBOR_DATA_DIR: ".izbor" });
    assert.deepEqual(await relative.exited, [1, null]);
    assert.deepEqual(
        [relative.output.stdout, relative.output.stderr],
        ["", "IZBOR_DATA_DIR must be an absolute path, got: .izbor\n"],
    );
});

test("serve refuses while a Izbor answers on the port, naming its pid, and that Izbor keeps running; an older Izbor is named as such; a port another program holds cannot be listened on", async (t) => {
    const server = await startIzborServer(t);
    const refused = await startServe(t, ["--port", String(server.port)]);
    assert.deepEqual(await refused.exited, [1, null], refused.output.text);
    assert.deepEqual(
        [refused.output.stdout, refused.output.stderr],
        ["", `Izbor already runs in the background (pid ${server.info.pid}). Run izbor stop first.\n`],
    );
    assert.deepEqual(await whoAnswers(server.port), server.info);

    const older = await portAnswering(t, (request, response) =>
        request.url === "/sessions"
            ? response.writeHead(200, { "content-type": "application/json" }).end('{"sessions":[]}')
            : response
                  .writeHead(404, { "content-type": "application/json" })
                  .end('{"error":"not_found","message":"no such route"}'),
    );
    const olderRun = await startServe(t, ["--port", String(older)]);
    assert.deepEqual(await olderRun.exited, [1, null], olderRun.output.text);
    assert.equal(
        olderRun.output.stderr,
        `An older Izbor already runs on 127.0.0.1:${older}. Stop it with Ctrl-C where it runs.\n`,
    );

    const foreign = await portAnswering(t, (_, response) =>
        response.writeHead(404, { "content-type": "text/html" }).end("<h1>"),
    );
    const cannot = await startServe(t, ["--port", String(foreign)]);
    assert.deepEqual(await cannot.exited, [1, null], cannot.output.text);
    assert.match(cannot.output.stderr, new RegExp(`^izbor cannot listen on port ${foreign}: `));
});

test("seam 4: at each start izbor serve makes a new send key and writes its port; GET /izbor names the key's file, one per port; the key is readable by its owner only (0600), in a folder for its owner only (0700)", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "izbor-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const dir = join(home, ".config", "izbor");
    const keys: string[] = [];
    const ports = [await freePort(), await freePort()];
    for (const port of ports) {
        const { exited, listening } = await startServe(t, ["--port", String(port)], homeEnv(home));
        await listening();

        const info = await whoAnswers(port);
        assert.equal(info.sendKeyPath, join(dir, `send-key-${port}`));
        const key = await readSendKey(info.sendKeyPath);
        assert.match(key, /^[0-9a-f]{64}$/);
        keys.push(key);
        assert.equal(await readFile(join(dir, "port"), "utf8"), `${port}\n`);
        // Windows has no POSIX file modes.
        if (process.platform !== "win32") {
            assert.equal((await stat(info.sendKeyPath)).mode & 0o777, 0o600);
            assert.equal((await stat(dir)).mode & 0o777, 0o700);
        }

        await stopTestIzbor(port);
        assert.deepEqual(await exited, [0, null]);
    }
    assert.notEqual(keys[0], keys[1]);
    assert.equal(await readSendKey(join(dir, `send-key-${ports[0]}`)), keys[0]);
    assert.equal(await readFile(join(dir, "port"), "utf8"), `${ports[1]}\n`);
});

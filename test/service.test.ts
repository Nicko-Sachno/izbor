import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toLine } from "../src/adapters/log/stdoutLog.js";
import { createSummarizer } from "../src/adapters/summarizer/summarizer.js";
import { type ServiceOptions, startService } from "../src/service.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { fakeProvider } from "./helpers/fakeProvider.js";
import { recordingLog } from "./helpers/recordingLog.js";
import { freePort } from "./support.js";

async function options(port: number) {
    const dataDir = await mkdtemp(join(tmpdir(), "izbor-data-"));
    const summarize = createSummarizer({
        dir: join(dataDir, "summarizer"),
        platform: hostPlatform(),
        env: process.env,
    });
    return {
        port,
        dataDir,
        userDir: join(dataDir, "user"),
        providers: { fake: fakeProvider() },
        platform: hostPlatform(),
        log: () => {},
        summarize,
    };
}

test("startService starts Izbor: it says who it is at `url`, on the port it listens on; stop() is safe twice and frees the data folder", async (t) => {
    const began = Date.now();
    const given = await options(0);

    const { url, info, stop } = await startService(given);
    t.after(stop);

    assert.notEqual(info.port, 0);
    assert.equal(url, `http://127.0.0.1:${info.port}`);
    assert.deepEqual(info, {
        service: "izbor",
        pid: process.pid,
        port: info.port,
        dataDir: given.dataDir,
        startedAt: info.startedAt,
        sendKeyPath: join(given.userDir, `send-key-${info.port}`),
    });
    assert.equal(new Date(info.startedAt).toISOString(), info.startedAt);
    assert.ok(Date.parse(info.startedAt) >= began);
    assert.deepEqual(await (await fetch(`${url}/izbor`)).json(), info);

    await Promise.all([stop(), stop()]);
    await stop();
    await assert.rejects(fetch(`${url}/izbor`));
    await (await startService(given)).stop();
});

test("startService rejects on a port that is taken, with the port and why, and frees the data folder: the next start on a free port works", async (t) => {
    const taken = createServer().listen(0, "127.0.0.1");
    t.after(() => taken.close());
    await once(taken, "listening");
    const { port } = taken.address() as { port: number };
    const given = await options(port);

    await assert.rejects(startService(given), {
        message: `izbor cannot listen on port ${port}: listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
    });

    const next = await startService({ ...given, port: 0 });
    await next.stop();
});

test("startService on a port the system reserves (listen fails with EACCES) says so in one line, with a port to try and how Windows lists reserved ports", async (t) => {
    const port = await freePort();
    const why = `listen EACCES: permission denied 127.0.0.1:${port}`;
    t.mock.method(Server.prototype, "listen", function (this: Server) {
        process.nextTick(() => this.emit("error", Object.assign(new Error(why), { code: "EACCES" })));
        return this;
    });
    const given = await options(port);

    await assert.rejects(startService(given), {
        message:
            `izbor cannot listen on port ${port}: ${why}. The system may reserve this port: try izbor --port 5000 ` +
            "(on Windows, netsh int ipv4 show excludedportrange protocol=tcp lists reserved ports).",
    });

    t.mock.restoreAll();
    const next = await startService({ ...given, port: 0 });
    await next.stop();
});

function refusedStart(t: TestContext, given: ServiceOptions) {
    const start = startService(given);
    t.after(async () => (await start.catch(() => undefined))?.stop());
    return start;
}

test("a second startService on the same data folder, on another free port, is refused, naming the folder; the first keeps answering; once it stops, a third starts", async (t) => {
    const given = await options(0);
    const first = await startService(given);
    t.after(first.stop);

    await assert.rejects(refusedStart(t, { ...given, port: await freePort() }), {
        message: `Another Izbor is using this data folder (${given.dataDir}). Izbor did not start.`,
    });

    assert.deepEqual(await (await fetch(`${first.url}/izbor`)).json(), first.info);
    assert.equal(readFileSync(join(given.dataDir, "izbor.holder"), "utf8"), `${process.pid} ${first.info.port}`);
    await first.stop();
    const third = await startService(given);
    await third.stop();
});

test("with a per-user folder that cannot be written, startService still listens, and logs one warning that names the send key and the port file", async (t) => {
    const given = await options(0);
    const notAFolder = join(given.dataDir, "not-a-folder");
    await writeFile(notAFolder, "");
    const { log, entries } = recordingLog();
    const printed = () => entries.map(toLine);

    const { url, info, stop } = await startService({
        ...given,
        userDir: join(notAFolder, "user"),
        log,
    });
    t.after(stop);

    assert.deepEqual(await (await fetch(`${url}/izbor`)).json(), info);
    assert.equal(printed().length, 1);
    assert.match(printed()[0]!, /^izbor warning: cannot write the send key and the port file: \S/);
});

test("startService never exits the process, and reads no argv and no env: its caller does", async () => {
    const source = await readFile(new URL("../src/service.ts", import.meta.url), "utf8");

    for (const name of ["process.exit", "process.argv", "process.env"]) assert.ok(!source.includes(name), name);
});

async function requestStop(port: number, userDir: string): Promise<number> {
    const key = await readFile(join(userDir, `send-key-${port}`), "utf8");
    const response = await fetch(`http://127.0.0.1:${port}/izbor/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
    });
    await response.arrayBuffer();
    return response.status;
}

test("a POST /izbor/stop with the send key resolves stopRequested; a second one is harmless", async (t) => {
    const given = await options(0);
    const { info, stop, stopRequested } = await startService(given);
    t.after(stop);

    assert.equal(await requestStop(info.port, given.userDir), 202);
    await stopRequested;
    assert.equal(await requestStop(info.port, given.userDir), 202);
});

test("a POST /izbor/stop sent as soon as Izbor listens, before startService resolves, resolves stopRequested too", async (t) => {
    const given = await options(0);
    const host = hostPlatform();
    const statuses: number[] = [];
    const { stop, stopRequested } = await startService({
        ...given,
        platform: {
            ...host,
            async lockDataFolder(dataDir) {
                const lock = await host.lockDataFolder(dataDir);
                return {
                    ...lock,
                    async writeHolder(port) {
                        statuses.push(await requestStop(port, given.userDir));
                        return lock.writeHolder(port);
                    },
                };
            },
        },
    });
    t.after(stop);

    assert.deepEqual(statuses, [202]);
    await stopRequested;
});

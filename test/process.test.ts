import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { IzborInfo } from "../src/domain/wire.js";
import { HANGING, homeEnv, skipOnWindows } from "./helpers/fakeCommand.js";
import { stopTestIzbor } from "./helpers/stopTestIzbor.js";
import { freePort, isolatedIzborEnv, isRunning, readNdjson, readUntil, until } from "./support.js";

const NO_SOFT_SIGNALS = skipOnWindows("Windows has no soft signals to a child");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

async function startIzbor(
    args: string[],
    env: Record<string, string> = {},
    claudeScript = 'process.stdout.write("[]\\n");',
    nodeArgs: string[] = [],
) {
    const { dataDir, claude, env: izborEnv } = await isolatedIzborEnv(claudeScript);
    const port = await freePort();
    const home = await mkdtemp(join(tmpdir(), "izbor-home-"));
    const child = spawn(process.execPath, [...nodeArgs, "--import", "tsx", "src/main.ts", ...args], {
        env: { ...process.env, ...izborEnv, ...homeEnv(home), PORT: String(port), ...env },
    });
    const output = { text: "", stderr: "" };
    child.stdout.on("data", (chunk) => (output.text += chunk));
    child.stderr.on("data", (chunk) => {
        output.text += chunk;
        output.stderr += chunk;
    });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    return { child, dataDir, home, port, output, exited, claude, url: `http://127.0.0.1:${port}/hook` };
}

async function tuneIn(port: number) {
    const leave = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events`, { signal: leave.signal });
    assert.equal(response.status, 200);
    return {
        caughtUp: () => readUntil(response.body!, "event: brief"),
        rest: () => readUntil(response.body!, "never sent"),
        until: async (pattern: RegExp) => {
            let read = "";
            while (!pattern.test(read)) {
                const more = await readUntil(response.body!, "\n\n");
                if (more === "") break;
                read += more;
            }
            return read;
        },
        leave: () => leave.abort(),
    };
}

async function halfSent(port: number, start: string) {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    let response = "";
    socket.on("data", (chunk) => (response += chunk));
    socket.on("error", () => {});
    socket.write(start);
    return { socket, response: () => response };
}

const halfSentHook = (port: number, body: string) =>
    halfSent(
        port,
        `POST /hook HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 10)}`,
    );

const readHookFile = (dataDir: string) => readNdjson(join(dataDir, "sessions", `${SESSION_ID}.hooks.ndjson`));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(
        `Izbor starts with no session id; ${signal} right after a hook of a watched session loses no record`,
        NO_SOFT_SIGNALS,
        async (t) => {
            const { child, dataDir, port, output, exited, url } = await startIzbor([]);
            t.after(() => child.kill("SIGKILL"));
            await until(() => output.text.includes("data:"));
            assert.ok(output.text.includes(dataDir), output.text);

            const stream = await tuneIn(port);
            const caughtUp = await stream.caughtUp();
            assert.match(
                caughtUp,
                new RegExp(
                    `^event: session\ndata: \\{"sessionId":"${SESSION_ID}","state":"[a-z ]+"\\}\n\nevent: brief\n`,
                ),
            );
            // The catch-up gives `claude agents --json` 5 s; a slower one shows up as a later session event.
            if (!caughtUp.includes(`"state":"not listed"`)) await stream.until(/"state":"not listed"/);
            stream.leave();

            const hook = {
                session_id: SESSION_ID,
                hook_event_name: "PermissionRequest",
                tool_name: "Bash",
                tool_input: {},
            };
            assert.equal((await fetch(url, { method: "POST", body: JSON.stringify(hook) })).status, 200);
            child.kill(signal);

            assert.deepEqual(await exited, [0, null]);
            assert.match(output.text, /izbor stopped/);
            const records = await readNdjson(join(dataDir, "sessions", `${SESSION_ID}.ndjson`));
            assert.deepEqual(
                records.map((r) => r.event),
                ["permission_request"],
            );
            const last = (await readHookFile(dataDir)).at(-1);
            assert.deepEqual({ event: last.event, why: last.why }, { event: "stopped", why: "izbor stopping" });
            await assert.rejects(fetch(url, { method: "POST", body: JSON.stringify(hook) }));
        },
    );
}

test("SIGBREAK, which Ctrl-Break sends on Windows, runs the Izbor stop: exit 0", async (t) => {
    const emitOnLine = `process.stdin.once("data", () => { if (!process.emit("SIGBREAK")) process.exit(2); });`;
    const { child, output, exited } = await startIzbor([], {}, undefined, [
        "--import",
        `data:text/javascript,${encodeURIComponent(emitOnLine)}`,
    ]);
    t.after(() => child.kill("SIGKILL"));
    await until(() => output.text.includes("data:"));

    child.stdin.write("\n");

    assert.deepEqual(await exited, [0, null], output.text);
    assert.match(output.text, /izbor stopped/);
});

test("GET /izbor says who this Izbor is: the pid of `npm run dev`'s process, its port, its data folder, its listen time, its send key's file in HOME", async (t) => {
    const began = Date.now();
    const { child, dataDir, home, port, output, exited } = await startIzbor([]);
    t.after(() => child.kill("SIGKILL"));
    await until(() => output.text.includes("data:"));

    const response = await fetch(`http://127.0.0.1:${port}/izbor`);

    assert.equal(response.status, 200);
    const info = (await response.json()) as IzborInfo;
    assert.deepEqual(info, {
        service: "izbor",
        pid: child.pid,
        port,
        dataDir,
        startedAt: info.startedAt,
        sendKeyPath: join(home, ".config", "izbor", `send-key-${port}`),
    });
    assert.equal(new Date(info.startedAt).toISOString(), info.startedAt);
    assert.ok(Date.parse(info.startedAt) >= began);
    await stopTestIzbor(port);
    assert.deepEqual(await exited, [0, null]);
});

test(
    "with IZBOR_SUMMARIZER_COMMAND a fake that exits 1, an action hook of a watched session gives an explanation `unknown`, with a reason, within 7 s",
    { timeout: 15_000 },
    async (t) => {
        const { child, port, output, exited, url } = await startIzbor([]);
        t.after(() => child.kill("SIGKILL"));
        await until(() => output.text.includes("data:"));
        const stream = await tuneIn(port);
        await stream.caughtUp();

        const hook = {
            session_id: SESSION_ID,
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_input: {},
        };
        const posted = performance.now();
        assert.equal((await fetch(url, { method: "POST", body: JSON.stringify(hook) })).status, 200);
        const read = await stream.until(/"explanation":\{"state":"unknown","reason":/);
        const took = performance.now() - posted;

        const explanation = [...read.matchAll(/^event: brief\ndata: (.*)$/gm)]
            .map(([, data]) => JSON.parse(data!).explanation)
            .find((explained) => explained.reason !== undefined);
        assert.equal(explanation.state, "unknown");
        assert.match(explanation.reason, /exited with code 1/);
        assert.ok(took < 7000, `the explanation took ${Math.round(took)} ms`);

        stream.leave();
        await stopTestIzbor(port);
        assert.deepEqual(await exited, [0, null], output.text);
    },
);

test(
    "a signal that arrives during a Izbor stop does not cut it short; a hook still being received is written",
    NO_SOFT_SIGNALS,
    async (t) => {
        const { child, dataDir, port, output, exited } = await startIzbor([]);
        t.after(() => child.kill("SIGKILL"));
        await until(() => output.text.includes("data:"));
        const stream = await tuneIn(port);
        await stream.caughtUp();
        stream.leave();

        const body = JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Notification", message: "waiting" });
        const hook = await halfSentHook(port, body);

        child.kill("SIGINT");
        await sleep(100);
        child.kill("SIGTERM");
        await sleep(100);
        assert.equal(child.exitCode, null, output.text);

        hook.socket.end(body.slice(10));
        assert.deepEqual(await exited, [0, null]);
        assert.match(hook.response(), /^HTTP\/1\.1 200/);
        const records = await readNdjson(join(dataDir, "sessions", `${SESSION_ID}.ndjson`));
        assert.deepEqual(
            records.map((r) => r.message),
            ["waiting"],
        );
    },
);

test("connections a client keeps open do not hold up the Izbor stop: neither one answered during it nor one that sends nothing", async (t) => {
    const { child, dataDir, port, output, exited } = await startIzbor([]);
    t.after(() => child.kill("SIGKILL"));
    await until(() => output.text.includes("data:"));
    const stream = await tuneIn(port);
    await stream.caughtUp();
    stream.leave();

    const body = JSON.stringify({ session_id: SESSION_ID, hook_event_name: "Notification", message: "waiting" });
    const hook = await halfSentHook(port, body);
    const silent = await halfSent(port, "");
    t.after(() => [hook, silent].forEach(({ socket }) => socket.destroy()));

    const stopBegan = performance.now();
    await stopTestIzbor(port);
    await sleep(100);
    hook.socket.write(body.slice(10));

    assert.deepEqual(await exited, [0, null], output.text);
    assert.ok(performance.now() - stopBegan < 2500, `the stop took ${Math.round(performance.now() - stopBegan)} ms`);
    assert.match(hook.response(), /^HTTP\/1\.1 200 [^]*\r\nConnection: close\r\n/);
    const hookFile = await readHookFile(dataDir);
    assert.equal(hookFile.at(-2).payload.message, "waiting");
    assert.deepEqual(
        { event: hookFile.at(-1).event, why: hookFile.at(-1).why },
        { event: "stopped", why: "izbor stopping" },
    );
});

test("the hook file holds every hook, a rejected payload, and each watch start and stop; a restart adds to it", async (t) => {
    const first = await startIzbor([]);
    t.after(() => first.child.kill("SIGKILL"));
    await until(() => first.output.text.includes("data:"));
    const stream = await tuneIn(first.port);
    await stream.caughtUp();

    const hook = {
        session_id: SESSION_ID,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_1",
    };
    assert.equal((await fetch(first.url, { method: "POST", body: JSON.stringify(hook) })).status, 200);
    assert.equal((await fetch(first.url, { method: "POST", body: "not a hook" })).status, 400);
    stream.leave();
    await stopTestIzbor(first.port);
    assert.deepEqual(await first.exited, [0, null]);

    const restarted = await startIzbor([], { IZBOR_DATA_DIR: first.dataDir });
    t.after(() => restarted.child.kill("SIGKILL"));
    await until(() => restarted.output.text.includes("data:"));
    const again = await tuneIn(restarted.port);
    await again.caughtUp();
    again.leave();
    await stopTestIzbor(restarted.port);
    assert.deepEqual(await restarted.exited, [0, null]);

    const file = join(first.dataDir, "sessions", `${SESSION_ID}.hooks.ndjson`);
    const records = (await readNdjson(file)).filter((r) => r.kind !== "status");
    assert.deepEqual(
        records.map((r) => r.event ?? r.kind),
        ["started", "hook", "rejected_payload", "stopped", "started", "stopped"],
    );
    assert.deepEqual(records[1].payload, hook);
    assert.equal(records[2].body, "not a hook");
    for (const { timestamp } of records) assert.equal(new Date(timestamp).toISOString(), timestamp);
});

test("a Izbor stop with a stream open, and one of every session, ends them, the first with `stopped`, and leaves no `claude agents` process running, nor anything that process started", async (t) => {
    const { child, dataDir, port, output, exited, claude } = await startIzbor([], {}, HANGING);
    t.after(() => child.kill("SIGKILL"));
    await until(() => output.text.includes("data:"));
    const stream = await tuneIn(port);
    const all = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(all.status, 200);
    await until(async () => (await claude.pids()).length === 2);
    const pids = await claude.pids();
    assert.deepEqual(pids.map(isRunning), [true, true]);

    await stopTestIzbor(port);

    await readUntil(all.body!, "never sent");

    assert.match(
        await stream.rest(),
        new RegExp(
            `event: session\ndata: \\{"sessionId":"${SESSION_ID}","state":"stopped","why":"izbor stopping"\\}\n\n$`,
        ),
    );
    assert.deepEqual(await exited, [0, null], output.text);
    assert.match(output.text, /izbor stopped/);
    assert.deepEqual(pids.map(isRunning), [false, false]);
    const file = join(dataDir, "sessions", `${SESSION_ID}.hooks.ndjson`);
    const records = await readNdjson(file);
    assert.deepEqual(
        records.map((r) => r.event ?? r.kind),
        ["started", "stopped"],
    );
    assert.equal(records[1]!.why, "izbor stopping");
});

test("given a session id, Izbor prints how to tune in instead and exits with code 1", async () => {
    const { output, exited } = await startIzbor([SESSION_ID]);

    assert.deepEqual(await exited, [1, null]);
    assert.match(output.text, /usage: npm run dev\n[\s\S]*\/sessions\/SESSION_ID\/events/);
});

test("a port that is already taken is reported and Izbor exits with code 1", async (t) => {
    const taken = createServer().listen(0, "127.0.0.1");
    t.after(() => taken.close());
    await once(taken, "listening");
    const { port } = taken.address() as { port: number };

    const { output, exited } = await startIzbor([], { PORT: String(port) });

    assert.deepEqual(await exited, [1, null]);
    assert.match(output.text, new RegExp(`cannot listen on port ${port}`));
});

test("`npm run dev` beside another one on the same IZBOR_DATA_DIR and another PORT says another Izbor is using the data folder, on stderr, and exits with code 1; the first keeps running", async (t) => {
    const first = await startIzbor([]);
    t.after(() => first.child.kill("SIGKILL"));
    await until(() => first.output.text.includes("data:"));

    const second = await startIzbor([], { IZBOR_DATA_DIR: first.dataDir });
    t.after(() => second.child.kill("SIGKILL"));

    assert.deepEqual(await second.exited, [1, null], second.output.text);
    const line = `Another Izbor is using this data folder (${first.dataDir}). Izbor did not start.\n`;
    assert.deepEqual([second.output.stderr, second.output.text], [line, line], "on stderr, and nothing on stdout");
    await assert.rejects(fetch(`http://127.0.0.1:${second.port}/izbor`));
    const info = (await (await fetch(`http://127.0.0.1:${first.port}/izbor`)).json()) as IzborInfo;
    assert.equal(info.pid, first.child.pid);
    await stopTestIzbor(first.port);
    assert.deepEqual(await first.exited, [0, null], first.output.text);
});

test("`kill -9` of the Izbor that holds the data folder frees it, though a `claude agents` it started still runs: a new start on that folder works", async (t) => {
    const killed = await startIzbor([], {}, HANGING);
    t.after(() => killed.child.kill("SIGKILL"));
    await until(() => killed.output.text.includes("data:"));
    const stream = await tuneIn(killed.port);
    await until(async () => (await killed.claude.pids()).length === 2);
    const pids = await killed.claude.pids();
    t.after(() => pids.filter(isRunning).forEach((pid) => process.kill(pid, "SIGKILL")));

    killed.child.kill("SIGKILL");
    assert.deepEqual(await killed.exited, [null, "SIGKILL"]);
    stream.leave();
    assert.deepEqual(pids.map(isRunning), [true, true]);

    const next = await startIzbor([], { IZBOR_DATA_DIR: killed.dataDir });
    t.after(() => next.child.kill("SIGKILL"));
    await until(() => next.output.text.includes("data:"));
    const info = (await (await fetch(`http://127.0.0.1:${next.port}/izbor`)).json()) as IzborInfo;
    assert.deepEqual([info.pid, info.dataDir], [next.child.pid, killed.dataDir]);
    await stopTestIzbor(next.port);
    assert.deepEqual(await next.exited, [0, null], next.output.text);
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { LOOPBACK } from "../../src/domain/wire.js";

export async function fullBacklog(t: TestContext) {
    const listen = `const s = require("node:net").createServer().listen({ port: 0, host: ${JSON.stringify(LOOPBACK)}, backlog: 1 }, () => {
        console.log(String(s.address().port));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });`;
    const listener = spawn(process.execPath, ["-e", listen], { stdio: ["ignore", "pipe", "ignore"] });
    t.after(() => listener.kill("SIGKILL"));
    const [line] = await once(listener.stdout.setEncoding("utf8"), "data");
    const port = Number(line);
    const queued: Socket[] = [];
    t.after(() => queued.forEach((socket) => socket.destroy()));
    for (let tries = 0; tries < 64; tries++) {
        const socket = connect(port, LOOPBACK).on("error", () => {});
        queued.push(socket);
        const connected = await Promise.race([
            once(socket, "connect").then(() => true),
            new Promise((resolve) => setTimeout(resolve, 300, false)),
        ]);
        if (!connected) return port;
    }
    throw new Error("the listener's queue never filled");
}

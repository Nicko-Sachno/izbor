import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastBuildAt, versionReport } from "../src/cli/commands/checkout.js";
import { homeEnv } from "./helpers/fakeCommand.js";
import { portAnswering } from "./support.js";

async function runCli(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args], {
        env: { ...process.env, ...homeEnv(await mkdtemp(join(tmpdir(), "izbor-home-"))), ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = (await once(child, "exit")) as [number];
    return { code, stdout, stderr };
}

test("a program that is not Izbor on IZBOR_PORT: the lines name that port, then exit 1", async (t) => {
    const foreign = await portAnswering(t, (_, res) => res.writeHead(404, { "content-type": "text/html" }).end("<h1>"));
    assert.deepEqual(await runCli(["status"], { IZBOR_PORT: String(foreign), PATH: "" }), {
        code: 1,
        stdout:
            `Port ${foreign} answers, but not as Izbor.\n` +
            `GET /izbor answered 404 Not Found, not JSON; see lsof -nP -iTCP:${foreign} (Windows: netstat -ano | findstr :${foreign})\nNo izbor on PATH\n`,
        stderr: "",
    });
});

test("a flag the terminal app cannot take: its one sentence, exit 1, and Izbor is never asked", async (t) => {
    let asked = 0;
    const port = await portAnswering(t, (_, res) => (asked++, res.writeHead(503).end()));
    assert.deepEqual(await runCli(["--yes", "--port", String(port)]), {
        code: 1,
        stdout: "",
        stderr: "--yes works only with stop.\n",
    });
    assert.deepEqual(await runCli(["--port", "0"]), {
        code: 1,
        stdout: "",
        stderr: '--port must be a port from 1 to 65535, not "0".\n',
    });
    assert.equal(asked, 0);
});

test("--version prints when npm run build last built this checkout, local to the minute; with no build, how to make one, exit 1", async () => {
    const { lines, code } = versionReport(lastBuildAt());
    const printed = `${lines[0]}\n`;
    assert.deepEqual(await runCli(["--version"]), { code, stdout: code ? "" : printed, stderr: code ? printed : "" });
    assert.deepEqual(versionReport(new Date(2026, 9, 13, 14, 2, 59).getTime()), {
        lines: ["izbor built 2026-10-13 14:02"],
        code: 0,
    });
    assert.deepEqual(versionReport(undefined), { lines: ["izbor has no build: run npm run build"], code: 1 });
});

test("importing the terminal app does nothing: no output, no process handler, and the process ends by itself", async () => {
    const child = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `await import("./src/terminal/main.ts");
            const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK", "uncaughtException", "unhandledRejection", "exit"];
            process.stderr.write(JSON.stringify(events.map((name) => process.listenerCount(name))));`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "exit");
    assert.deepEqual({ code, stdout, stderr }, { code: 0, stdout: "", stderr: "[0,0,0,0,0,0,0]" });
});

test("redirected live input fails before contacting Izbor or creating its data folder", async (t) => {
    let asked = 0;
    const port = await portAnswering(t, (_, res) => (asked++, res.writeHead(503).end()));
    assert.deepEqual(await runCli(["--port", String(port)], { IZBOR_DATA_DIR: "invalid-relative-path" }), {
        code: 1,
        stdout: "",
        stderr: "Interactive mode needs a terminal.\n",
    });
    assert.equal(asked, 0);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { changeIzborHooks } from "../../src/adapters/agents/claude/setup/project.js";
import { createIzborClient } from "../../src/adapters/izbor/client.js";
import { HOOK_RUNNER, PROJECT_DIR } from "../../src/config.js";
import { agentsList, fakeClaude, freePort, isolatedIzborEnv, SESSION, until } from "../support.js";
import { homeEnv, withPath } from "./fakeCommand.js";
import { hostPlatform } from "./fakePlatform.js";
import { startPty } from "./pty.js";
import { KEYS } from "./keys.js";

export const IZBOR_BIN = join(PROJECT_DIR, "bin", "izbor.js");
export const TSX_LOADER = join(PROJECT_DIR, "node_modules", "tsx", "dist", "loader.mjs");
const CLI_SOURCE = join(PROJECT_DIR, "src", "cli", "main.ts");

export const COLOR_TERMINAL = { NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined };

export async function claudeListing(project: string, port: number, status: object) {
    const added = changeIzborHooks({
        change: "add",
        folder: project,
        port,
        home: homedir(),
        platform: hostPlatform(),
        runner: HOOK_RUNNER,
    });
    assert.ok("done" in added, JSON.stringify(added));
    const list = agentsList([{ sessionId: SESSION, cwd: project, name: "", ...status }]);
    return (await fakeClaude(`process.stdout.write(${JSON.stringify(`${list}\n`)});`)).dir;
}

const SEAM = { IZBOR_CLI: CLI_SOURCE, TSX_TSCONFIG_PATH: join(PROJECT_DIR, "tsconfig.json") };

const npmCmdShim = (target: string) =>
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n" +
    'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n' +
    "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n" +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

export async function npmLinkFolder(checkout: string) {
    const dir = await mkdtemp(join(tmpdir(), "izbor-npm-"));
    await mkdir(join(dir, "node_modules"));
    await symlink(checkout, join(dir, "node_modules", "izbor"), "junction");
    await writeFile(join(dir, "izbor.cmd"), npmCmdShim("node_modules\\izbor\\bin\\izbor.js"));
    return dir;
}

export const izborBinThroughLink = async () =>
    join(await npmLinkFolder(PROJECT_DIR), "node_modules", "izbor", "bin", "izbor.js");

const binArgs = (args: string[], { nodeArgs = [], bin = IZBOR_BIN }: Omit<BinOptions, "env"> = {}) => [
    "--import",
    pathToFileURL(TSX_LOADER).href,
    ...nodeArgs,
    bin,
    ...args,
];

type BinOptions = {
    env?: Record<string, string | undefined>;
    nodeArgs?: string[];
    bin?: string;
};

export async function runIzborBin(args: string[], { env = {}, nodeArgs = [], bin = IZBOR_BIN }: BinOptions = {}) {
    const cwd = await mkdtemp(join(tmpdir(), "izbor-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "izbor-home-"));
    const child = spawn(process.execPath, binArgs(args, { nodeArgs, bin }), {
        cwd,
        env: { ...process.env, ...homeEnv(home), DISABLE_AUTOUPDATER: "1", ...SEAM, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "", text: "" };
    child.stdout.on("data", (chunk) => {
        output.stdout += chunk;
        output.text += chunk;
    });
    child.stderr.on("data", (chunk) => {
        output.stderr += chunk;
        output.text += chunk;
    });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    return { child, cwd, home, output, exited };
}

export async function startServe(t: TestContext, args: string[], env: Record<string, string | undefined> = {}) {
    const { dataDir, env: izborEnv } = await isolatedIzborEnv();
    const run = await runIzborBin(["serve", ...args], { env: { ...izborEnv, ...env } });
    t.after(() => run.child.kill("SIGKILL"));
    const listening = () => until(() => run.output.text.includes(`  data:  ${dataDir}\n`));
    return { ...run, dataDir, listening };
}

export async function openIzbor(
    t: TestContext,
    port: number,
    { first, env = {}, args = [] }: { first?: string; env?: Record<string, string | undefined>; args?: string[] } = {},
) {
    const isolated = await isolatedIzborEnv();
    const pty = await startPty([process.execPath, ...binArgs([...args, "--port", String(port)])], {
        cwd: await mkdtemp(join(tmpdir(), "izbor-cwd-")),
        env: {
            ...SEAM,
            ...(first ? withPath(isolated.env, first) : isolated.env),
            ...homeEnv(await mkdtemp(join(tmpdir(), "izbor-home-"))),
            PORT: String(await freePort()),
            ...env,
        },
        cols: 80,
        rows: 30,
    });
    t.after(pty.close);
    const screen = () => pty.frame().join("\n");
    async function quit() {
        pty.input(KEYS["ctrl-c"]);
        await pty.until("Ctrl-C quits the app", () => pty.exited() !== undefined);
        return pty.exited()!.code;
    }
    return { ...pty, screen, quit, dataDir: env.IZBOR_DATA_DIR ?? isolated.dataDir };
}

export const upOn = (port: number) => new RegExp(`Izbor ● up( 127\\.0\\.0\\.1:${port})?\\s*$`);

export async function izborPid(port: number): Promise<number | undefined> {
    const izbor = await createIzborClient({ port }).getIzbor();
    return "up" in izbor && izbor.up !== "older" ? izbor.up.pid : undefined;
}

export function stopIzborAfter(t: TestContext, port: number) {
    t.after(async () => {
        const end = Date.now() + 10_000;
        let pid = await izborPid(port);
        while (pid === undefined && Date.now() < end) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            pid = await izborPid(port);
        }
        if (pid !== undefined) process.kill(pid, "SIGTERM");
    });
}

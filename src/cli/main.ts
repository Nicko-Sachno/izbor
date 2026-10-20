import { closeSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { izborLog } from "../adapters/files/izborLogFile.js";
import { createIzborClient } from "../adapters/izbor/client.js";
import { connectLimited } from "../adapters/izbor/connectLimited.js";
import { selectPlatform } from "../adapters/platform/select.js";
import { DETACH, lastBuildAt, THIS_BIN, versionReport, whichIzbor } from "./commands/checkout.js";
import type { OpenArgs } from "./commands/open.js";
import type { CommandReport } from "./commands/report.js";
import type { ServeArgs } from "./commands/serve.js";
import { readCliArgs } from "./args.js";
import {
    LOG_FILE,
    type IzborEnv,
    izborChildEnv,
    PROJECT_DIR,
    providerContextOf,
    readDataDir,
    readIzborEnv,
} from "../config.js";
import type { Platform, Spawned, Wait } from "../core/ports.js";
import { messageOf } from "../domain/text.js";

async function main(argv: string[]): Promise<number> {
    const args = readCliArgs(argv, process.env);
    if ("error" in args) {
        process.stderr.write(`${args.error}\n`);
        return 1;
    }
    switch (args.command) {
        case "serve":
            return serve(args);
        case "stop": {
            const { runStop } = await import("./commands/stop.js");
            const client = izborClient(args.port);
            const ask = process.stdin.isTTY ? askTerminal : null;
            return print(await runStop(args, { client, readKey, platform: thisPlatform(), ask, wait, nowMs }));
        }
        case "status": {
            const { runStatus } = await import("./commands/status.js");
            const client = izborClient(args.port);
            const now = () => Date.now();
            const deps = { client, which, builtAt: lastBuildAt, now, home: homedir() };
            return print(await runStatus(args, deps), process.stdout);
        }
        case "hooks": {
            const { runHooks } = await import("./commands/hooks.js");
            const { project } = await loadCliProvider(thisPlatform());
            return print(await runHooks(args, { ...project, home: homedir() }));
        }
        case "plugin": {
            const { runPlugin } = await import("./commands/plugin.js");
            const { project } = await loadCliProvider(thisPlatform());
            return print(await runPlugin(args, { changeActing: project.changeActing, home: homedir() }));
        }
        case "help": {
            const { HELP } = await import("./help.js");
            process.stdout.write(HELP);
            return 0;
        }
        case "version":
            return print(versionReport(lastBuildAt()));
        case "open":
            return openTerminal(args);
        default:
            return assertNever(args);
    }
}

async function openTerminal(args: OpenArgs): Promise<number> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write("Interactive mode needs a terminal.\n");
        return 1;
    }
    const { ensureIzbor, forConsole } = await import("./commands/open.js");
    const { createLiveStore, runTerminal } = await import("../terminal/main.js");
    const platform = thisPlatform();
    const client = izborClient(args.port);
    const izbor = await ensureIzbor(args, {
        client,
        platform,
        which,
        wait,
        nowMs,
        ...backgroundStart(args.port, platform.startInBackground),
        builtAt: lastBuildAt,
    });
    if ("error" in izbor) {
        process.stderr.write(`${izbor.error}\n`);
        return 1;
    }
    const {
        project: { changeHooks: hooks, changeActing: plugin },
        run,
    } = await loadCliProvider(platform);
    return runTerminal({
        ...forConsole(args.screen, izbor.feedback, platform.dropsMouseClicks(process.env), process.env),
        source: createLiveStore({
            client,
            izbor: izbor.info,
            port: args.port,
            run,
            platform,
            readKey,
            env: process.env,
        }),
        setup: { port: args.port, hooks, plugin },
        notes: izbor.notes,
    });
}

const wait: Wait = (ms, signal) => sleep(ms, undefined, { signal }).then(undefined, () => undefined);

const which = () => whichIzbor(process.env.PATH ?? "");

const readKey = (path: string, signal?: AbortSignal) => readFile(path, { encoding: "utf8", signal });

const nowMs = () => performance.now();

const thisPlatform = (): Platform => selectPlatform(process.platform);

const izborClient = (port: number) =>
    createIzborClient({ port, fetch: connectLimited(globalThis.fetch, port, thisPlatform().refusedConnectMs) });

async function loadCliProvider(platform: Platform) {
    const { CLI_PROVIDER } = await import("../adapters/agents/projects.js");
    return {
        project: CLI_PROVIDER.project(providerContextOf({ platform, home: homedir() })),
        run: CLI_PROVIDER.agentsList({ run: platform.run }),
    };
}

async function serve(args: ServeArgs): Promise<number> {
    const { runServe } = await import("./commands/serve.js");
    const izborEnv = () => readIzborEnv(process.env, homedir(), PROJECT_DIR);
    const client = izborClient(args.port);
    return print(await runServe(args, { izborEnv, client, serve: serveInThisTerminal }));
}

type ServeOptions = { port: number } & IzborEnv;

async function serveInThisTerminal(options: ServeOptions): Promise<unknown> {
    const { serveInForeground } = await import("../foreground.js");
    return serveInForeground({ ...options, platform: thisPlatform() });
}

function print({ lines, code }: CommandReport<number>, stream = code === 0 ? process.stdout : process.stderr): number {
    stream.write(lines.map((line) => `${line}\n`).join(""));
    return code;
}

function askTerminal(question: string): Promise<string> {
    return new Promise((resolve) => {
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        let answered = false;
        const answer = (line: string) => {
            if (answered) return;
            answered = true;
            terminal.close();
            resolve(line);
        };
        terminal.on("SIGINT", () => {
            process.stderr.write("\n");
            answer("");
        });
        terminal.on("close", () => answer(""));
        terminal.question(`${question} `, answer);
    });
}

function backgroundStart(port: number, start: Platform["startInBackground"]) {
    let log: ReturnType<typeof izborLog> | undefined;
    return {
        async startInBackground(): Promise<Spawned> {
            try {
                const dataDir = readDataDir(process.env, PROJECT_DIR);
                mkdirSync(dataDir, { recursive: true });
                log ??= izborLog(join(dataDir, LOG_FILE));
                const logFile = log.open();
                try {
                    const started = await start({
                        args: [DETACH, THIS_BIN, "serve", "--port", String(port)],
                        cwd: PROJECT_DIR,
                        env: izborChildEnv(process.env, dataDir),
                        logFile,
                    });
                    return "error" in started && started.error === "" ? { error: log.lastLine() } : started;
                } finally {
                    closeSync(logFile);
                }
            } catch (error) {
                return { error: messageOf(error) };
            }
        },
        lastLogLine: () => log?.lastLine() ?? "Izbor did not start.",
    };
}

function assertNever(value: never): never {
    throw new Error(`izbor has no case for ${JSON.stringify(value)}`);
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`izbor stopped: ${messageOf(error)}\n`);
    return 1;
});

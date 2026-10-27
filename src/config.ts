import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Platform, ProviderContext } from "./core/ports.js";
import { curlStream, izborUrl } from "./domain/wire.js";

export { izborAddress } from "./domain/wire.js";

export type IzborEnv = {
    dataDir: string;
    userDir: string;
    summarizerCommand: string | undefined;
};

export type Config = IzborEnv & { port: number };

export const STOP_TIMEOUT_MS = 5000;

export const tuneInCommand = (port: number) => curlStream(`${izborUrl(port)}/sessions/SESSION_ID/events`);

const usage = (port: number) => `usage: npm run dev
  Izbor takes no session id. Tune in to a session with:
  ${tuneInCommand(port)}
  SESSION_ID  the sessionId of a Claude Code session, as listed by: claude agents --json
  Every watched session at once: ${curlStream(`${izborUrl(port)}/events`)}`;

export const PROJECT_DIR = resolve(import.meta.dirname, "..");

export const LOG_FILE = "izbor.log";

export const IZBOR_PLUGIN_DIR = join(PROJECT_DIR, "plugin");

export const HOOK_RUNNER = { node: "node", script: join(PROJECT_DIR, "bin", "post-hook.js") };

export function providerContextOf({ platform, home }: { platform: Platform; home: string }): ProviderContext {
    return { platform, home, pluginDir: IZBOR_PLUGIN_DIR, hookRunner: HOOK_RUNNER };
}

export const IZBOR_PORT = 4319;

export const isPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

export function isInside(dir: string, parent: string): boolean {
    const path = relative(parent.toLowerCase(), dir.toLowerCase());
    return path.split(sep)[0] !== ".." && !isAbsolute(path);
}

export const izborUserDir = (env: Record<string, string | undefined>, home: string) =>
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "izbor") : join(home, ".config", "izbor");

export const tilde = (path: string, home: string) =>
    path.startsWith(`${home}/`) || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;

export const pluginOffer = (folder: string, port: number) => {
    const quoted = `'${folder.replaceAll("'", sep === "\\" ? "''" : "'\"'\"'")}'`;
    return `Install the plugin if you want to answer sessions from Izbor: izbor plugin ${quoted}${port === IZBOR_PORT ? "" : ` --port ${port}`}.`;
};

export function readDataDir(env: Record<string, string | undefined>, projectDir: string): string {
    const dataDir = env.IZBOR_DATA_DIR ?? join(projectDir, ".izbor");
    if (!isAbsolute(dataDir)) throw new Error(`IZBOR_DATA_DIR must be an absolute path, got: ${dataDir}`);
    return resolve(dataDir);
}

function readSummarizerCommand(env: Record<string, string | undefined>): string | undefined {
    return env.IZBOR_SUMMARIZER_COMMAND || undefined;
}

export function readIzborEnv(env: Record<string, string | undefined>, home: string, projectDir: string): IzborEnv {
    return {
        dataDir: readDataDir(env, projectDir),
        userDir: izborUserDir(env, home),
        summarizerCommand: readSummarizerCommand(env),
    };
}

export const INHERITED_FROM_CLAUDE = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_EFFORT|CLAUDE_PID|AI_AGENT)$/;

export function izborChildEnv(
    env: Record<string, string | undefined>,
    dataDir: string,
): Record<string, string | undefined> {
    const kept = Object.entries(env).filter(([name]) => name !== "PORT" && !INHERITED_FROM_CLAUDE.test(name));
    return { ...Object.fromEntries(kept), IZBOR_DATA_DIR: dataDir };
}

export type ScreenFlags = {
    color: boolean;
    mouse: boolean;
    bell: boolean;
    oldBuild: boolean;
    /** TERM=dumb: such a terminal draws no attribute either, so colour off draws plain text there. */
    dumb?: true;
    /** The terminal opens OSC 8 links, so the agent's links are drawn as links. */
    links?: boolean;
    /** The terminal shows strikethrough, so the agent's `~~struck~~` text is struck through. */
    strike?: boolean;
    /** The terminal reports keys under the kitty keyboard protocol, so Shift-Enter in the field starts a new line. */
    keys?: "kitty";
    /** It reports Shift-Enter with no setting of the user's, so the field's bottom edge names Shift-Enter, not Ctrl-J. */
    shiftEnter?: true;
};

export function readConfig(
    argv: string[],
    env: Record<string, string | undefined>,
    home: string,
    projectDir: string,
): Config {
    const { dataDir, userDir, summarizerCommand } = readIzborEnv(env, home, projectDir);

    const port = Number(env.PORT ?? IZBOR_PORT);
    if (!isPort(port)) throw new Error(`PORT must be a port number, got: ${env.PORT}`);

    if (argv.length > 0) throw new Error(usage(port));

    return { dataDir, userDir, port, summarizerCommand };
}

import type { ScreenFlags } from "../config.js";
import { portOption } from "./portOption.js";

export type CliArgs =
    | (PortArgs & { command: "open"; screen: ScreenFlags })
    | (PortArgs & { command: "serve" })
    | (PortArgs & { command: "status"; diskUsage: boolean })
    | (PortArgs & { command: "stop"; yes: boolean })
    | (PortArgs & { command: "hooks" | "plugin"; folder?: string; remove: boolean })
    | { command: "help" }
    | { command: "version" };

const SCREEN_OPTIONS = ["--no-color", "--no-mouse", "--no-bell"];
const COMMAND_OPTIONS: Record<Command, readonly string[]> = {
    open: ["--port", ...SCREEN_OPTIONS],
    serve: ["--port"],
    stop: ["--port", "--yes"],
    status: ["--port", "--disk-usage"],
    hooks: ["--port", "--remove"],
    plugin: ["--port", "--remove"],
};
const KNOWN_OPTIONS = new Set([...Object.values(COMMAND_OPTIONS).flat(), "--help", "-h", "--version"]);
const OPTIONS_WITH_VALUES = new Set(["--port"]);

export function readCliArgs(argv: string[], env: Record<string, string | undefined>): CliArgs | ArgError {
    const tokens = tokenize(argv);
    if ("error" in tokens) {
        return tokens;
    }

    const command = resolveCommand(tokens);
    if (typeof command !== "string") {
        return command;
    }

    switch (command) {
        case "help":
        case "version":
            return { command };
        default:
            return readPortCommandArgs(command, tokens, env);
    }
}

function tokenize(argv: readonly string[]): Tokens | ArgError {
    let state: ParseState = {
        command: "open",
        options: new Map(),
        optionsEnded: false,
        pendingOption: undefined,
    };

    for (const arg of argv) {
        const next = parseArgument(state, arg);

        if ("error" in next) {
            return next;
        }

        state = next;
    }

    const { command, options, folder } = state;
    return { command, options, folder };
}

function parseArgument(state: ParseState, arg: string): ParseState | ArgError {
    const startsOption = arg.startsWith("--") || arg === "-h";
    const nextState: ParseState = { ...state, pendingOption: undefined };

    switch (true) {
        case state.pendingOption !== undefined && !startsOption:
            return parseOptionValue(state, state.pendingOption, arg);
        case !state.optionsEnded && arg === "--":
            return { ...nextState, optionsEnded: true };
        case !state.optionsEnded && arg.startsWith("-"):
            return parseOption(nextState, arg);
        case takesFolder(state.command):
            return parseFolder(nextState, arg);
        default:
            return parseCommand(nextState, arg);
    }
}

function parseOptionValue(state: ParseState, option: string, value: string): ParseState {
    const options = new Map(state.options);
    options.set(option, value);
    return { ...state, options, pendingOption: undefined };
}

function parseOption(state: ParseState, arg: string): ParseState | ArgError {
    if (!KNOWN_OPTIONS.has(arg)) {
        return { error: `Unknown option ${arg}. Use --help.` };
    }

    const options = new Map(state.options);
    options.set(arg, "");
    const pendingOption = OPTIONS_WITH_VALUES.has(arg) ? arg : undefined;
    return { ...state, options, pendingOption };
}

function parseFolder(state: ParseState, arg: string): ParseState | ArgError {
    if (state.folder !== undefined) {
        return { error: `${state.command} takes one folder.` };
    }

    return { ...state, folder: arg };
}

function parseCommand(state: ParseState, arg: string): ParseState | ArgError {
    if (state.optionsEnded || !isSubcommand(arg)) {
        return { error: `Unknown command ${arg}. Use --help.` };
    }
    if (state.command !== "open") {
        return { error: `${arg} does not go with ${state.command}.` };
    }

    return { ...state, command: arg };
}

const isSubcommand = (word: string): word is Exclude<Command, "open"> =>
    ["serve", "stop", "status", "hooks", "plugin"].includes(word);
const takesFolder = (command: Command) => command === "hooks" || command === "plugin";

function optionProblem(option: string, command: Command): string {
    switch (true) {
        case SCREEN_OPTIONS.includes(option):
            return `${option} works only in the terminal app.`;
        case option === "--yes":
            return "--yes works only with stop.";
        case option === "--remove":
            return "--remove works only with hooks and plugin.";
        case option === "--disk-usage":
            return "--disk-usage works only with status.";
        default:
            return `${option} does not go with ${command}.`;
    }
}

function screenOptions(options: Map<string, string>, env: Record<string, string | undefined>): ScreenFlags {
    return {
        color: !options.has("--no-color") && env.NO_COLOR === undefined && env.TERM !== "dumb",
        mouse: !options.has("--no-mouse"),
        bell: !options.has("--no-bell"),
        oldBuild: env.IZBOR_OLD_BUILD === "1",
    };
}

function resolveCommand(tokens: Tokens): CliArgs["command"] | ArgError {
    const { options } = tokens;
    if (options.has("--help") || options.has("-h")) {
        return "help";
    }
    if (options.has("--version")) {
        return "version";
    }
    const { command } = tokens;
    for (const option of options.keys()) {
        if (!COMMAND_OPTIONS[command].includes(option)) {
            return { error: optionProblem(option, command) };
        }
    }

    return command;
}

function readPortCommandArgs(
    command: Command,
    { options, folder }: Tokens,
    env: Record<string, string | undefined>,
): CliArgs | ArgError {
    const common = portOption(options.get("--port"), env.IZBOR_PORT);
    if ("error" in common) {
        return common;
    }

    switch (command) {
        case "hooks":
        case "plugin":
            return { ...common, command, folder, remove: options.has("--remove") };
        case "stop":
            return { ...common, command, yes: options.has("--yes") };
        case "status":
            return { ...common, command, diskUsage: options.has("--disk-usage") };
        case "serve":
            return { ...common, command };
        case "open":
            return { ...common, command, screen: screenOptions(options, env) };
    }
}

type PortArgs = { port: number };
type Command = Exclude<CliArgs["command"], "help" | "version">;
type ArgError = { error: string };
type Tokens = { command: Command; options: Map<string, string>; folder?: string };
type ParseState = Tokens & { optionsEnded: boolean; pendingOption: string | undefined };

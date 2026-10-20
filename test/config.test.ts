import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { izborChildEnv, izborUserDir, pluginOffer, readConfig, readIzborEnv } from "../src/config.js";
import { type CliArgs, readCliArgs } from "../src/cli/args.js";

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000";
const HOME = "/Users/someone";
const PROJECT = "/Users/someone/code/izbor";

test("plugin suggestions quote the absolute folder, including spaces, apostrophes and shell syntax", () => {
    assert.equal(
        pluginOffer("/Users/someone/my project", 4319),
        "Install the plugin if you want to answer sessions from Izbor: izbor plugin '/Users/someone/my project'.",
    );
    const apostrophe = sep === "\\" ? "''" : "'\"'\"'";
    assert.equal(
        pluginOffer("/work/it's $HOME; $(echo nope)", 5123),
        `Install the plugin if you want to answer sessions from Izbor: izbor plugin '/work/it${apostrophe}s $HOME; $(echo nope)' --port 5123.`,
    );
});

test("Izbor takes no argument; the data folder is `.izbor` in the project's folder, and the port has a default", () => {
    assert.deepEqual(readConfig([], {}, HOME, PROJECT), {
        dataDir: resolve(PROJECT, ".izbor"),
        userDir: join(HOME, ".config", "izbor"),
        port: 4319,
        summarizerCommand: undefined,
    });
});

test("IZBOR_SUMMARIZER_COMMAND names the summarizer's command; unset or empty, it is the SDK's bundled `claude`", () => {
    const command = (env: Record<string, string>) => readConfig([], env, HOME, PROJECT).summarizerCommand;

    assert.equal(command({ IZBOR_SUMMARIZER_COMMAND: "/tmp/fake/claude" }), "/tmp/fake/claude");
    for (const env of [{}, { IZBOR_SUMMARIZER_COMMAND: "" }] as Record<string, string>[]) {
        assert.equal(command(env), undefined, JSON.stringify(env));
    }
});

test("readIzborEnv is what `izbor serve` runs Izbor with beside its port: the data folder, the per-user folder in HOME and the summarizer's command, never PORT", () => {
    assert.deepEqual(
        readIzborEnv(
            { PORT: "4400", IZBOR_DATA_DIR: "/tmp/izbor-test", IZBOR_SUMMARIZER_COMMAND: "/tmp/fake/claude" },
            HOME,
            PROJECT,
        ),
        {
            dataDir: resolve("/tmp/izbor-test"),
            userDir: join(HOME, ".config", "izbor"),
            summarizerCommand: "/tmp/fake/claude",
        },
    );
    assert.deepEqual(readIzborEnv({}, HOME, PROJECT), {
        dataDir: resolve(PROJECT, ".izbor"),
        userDir: join(HOME, ".config", "izbor"),
        summarizerCommand: undefined,
    });
    assert.throws(
        () => readIzborEnv({ IZBOR_DATA_DIR: ".izbor" }, HOME, PROJECT),
        /IZBOR_DATA_DIR must be an absolute path/,
    );
});

test("the per-user folder is <LOCALAPPDATA>/izbor when LOCALAPPDATA is set, else <home>/.config/izbor; an empty LOCALAPPDATA counts as unset", () => {
    assert.equal(izborUserDir({}, HOME), join(HOME, ".config", "izbor"));
    assert.equal(izborUserDir({ LOCALAPPDATA: "" }, HOME), join(HOME, ".config", "izbor"));
    assert.equal(
        izborUserDir({ LOCALAPPDATA: "/Users/someone/AppData/Local" }, HOME),
        join("/Users/someone/AppData/Local", "izbor"),
    );
});

test("an argument, such as a session id, is refused, with how to tune in to a session instead", () => {
    for (const argv of [[SESSION_ID], ["extra"]]) {
        assert.throws(
            () => readConfig(argv, { PORT: "4400" }, HOME, PROJECT),
            /^Error: usage: npm run dev\n[\s\S]*127\.0\.0\.1:4400\/sessions\/SESSION_ID\/events/,
            argv.join(" "),
        );
    }
});

test("IZBOR_DATA_DIR and PORT replace the defaults", () => {
    const config = readConfig([], { IZBOR_DATA_DIR: "/tmp/izbor-test", PORT: "4400" }, HOME, PROJECT);
    assert.deepEqual([config.dataDir, config.port], [resolve("/tmp/izbor-test"), 4400]);
});

test("a relative data folder and a PORT that is not a port are refused", () => {
    const refused = (env: Record<string, string>, message: RegExp) =>
        assert.throws(() => readConfig([], env, HOME, PROJECT), message, JSON.stringify(env));

    refused({ IZBOR_DATA_DIR: ".izbor" }, /IZBOR_DATA_DIR must be an absolute path/);
    refused({ PORT: "http" }, /PORT must be a port number/);
});

type CommandAndPort = { command: CliArgs["command"]; port?: number };

function commandAndPort(argv: string[], env: Record<string, string> = {}): CommandAndPort {
    const args = readCliArgs(argv, env);
    assert.ok(!("error" in args), JSON.stringify(args));
    if (!("port" in args)) return { command: args.command };
    return { command: args.command, port: args.port };
}

type ProjectArgs = Extract<CliArgs, { command: "hooks" | "plugin" }>;

function projectArgs(argv: string[], env: Record<string, string> = {}): ProjectArgs {
    const args = readCliArgs(argv, env);
    assert.ok(!("error" in args), JSON.stringify(args));
    assert.ok(args.command === "hooks" || args.command === "plugin", args.command);
    return args;
}

test("serve, --help, --version and nothing: each case's command, port and where the port came from: --port, else IZBOR_PORT, else 4319; an empty IZBOR_PORT is unset, and PORT is never read", () => {
    const cases: [string[], Record<string, string>, CommandAndPort][] = [
        [[], {}, { command: "open", port: 4319 }],
        [["--port", "5000"], {}, { command: "open", port: 5000 }],
        [[], { IZBOR_PORT: "5001" }, { command: "open", port: 5001 }],
        [["--port", "5000"], { IZBOR_PORT: "5001" }, { command: "open", port: 5000 }],
        [[], { PORT: "3000" }, { command: "open", port: 4319 }],
        [[], { IZBOR_PORT: "" }, { command: "open", port: 4319 }],
        [["serve"], {}, { command: "serve", port: 4319 }],
        [["serve", "--port", "5000"], {}, { command: "serve", port: 5000 }],
        [["--port", "5000", "serve"], {}, { command: "serve", port: 5000 }],
        [["serve"], { IZBOR_PORT: "5001" }, { command: "serve", port: 5001 }],
        [["serve"], { PORT: "3000" }, { command: "serve", port: 4319 }],
        [["serve", "--port", "5000"], { IZBOR_PORT: "5001", PORT: "3000" }, { command: "serve", port: 5000 }],
        [["--help"], { IZBOR_PORT: "5001" }, { command: "help" }],
        [["-h"], {}, { command: "help" }],
        [["--no-color", "-h"], {}, { command: "help" }],
        [["serve", "--help"], {}, { command: "help" }],
        [["--version"], {}, { command: "version" }],
        [["serve", "--version", "--port", "5000"], {}, { command: "version" }],
        [["--version", "--help"], {}, { command: "help" }],
    ];
    for (const [argv, env, expected] of cases)
        assert.deepEqual(commandAndPort(argv, env), expected, JSON.stringify({ argv, env }));
});

test("a word that is no command is refused, with one sentence", () => {
    assert.deepEqual(readCliArgs(["restart"], {}), { error: "Unknown command restart. Use --help." });
    assert.deepEqual(readCliArgs(["serve", "now"], {}), { error: "Unknown command now. Use --help." });
});

test("stop, stop --yes and status: each case's command, port and --yes; --yes without stop, or two commands, is refused", () => {
    const cases: [string[], Record<string, string>, CommandAndPort & { yes?: boolean; diskUsage?: boolean }][] = [
        [["stop"], {}, { command: "stop", port: 4319, yes: false }],
        [["stop", "--yes"], {}, { command: "stop", port: 4319, yes: true }],
        [["--yes", "stop"], {}, { command: "stop", port: 4319, yes: true }],
        [["stop", "--port", "5000"], {}, { command: "stop", port: 5000, yes: false }],
        [["stop"], { IZBOR_PORT: "5001", PORT: "3000" }, { command: "stop", port: 5001, yes: false }],
        [["status"], {}, { command: "status", port: 4319, diskUsage: false }],
        [["status", "--port", "5000"], {}, { command: "status", port: 5000, diskUsage: false }],
        [["status"], { PORT: "3000" }, { command: "status", port: 4319, diskUsage: false }],
        [["stop", "--yes", "--help"], {}, { command: "help" }],
    ];
    for (const [argv, env, expected] of cases) {
        const args = readCliArgs(argv, env);
        assert.ok(!("error" in args), JSON.stringify(args));
        assert.deepEqual(args, expected, JSON.stringify({ argv, env }));
    }

    const refused: [string[], string][] = [
        [["--yes"], "--yes works only with stop."],
        [["status", "--yes"], "--yes works only with stop."],
        [["serve", "--yes"], "--yes works only with stop."],
        [["--no-color", "--yes"], "--yes works only with stop."],
        [["stop", "status"], "status does not go with stop."],
        [["serve", "stop"], "stop does not go with serve."],
        [["stop", "--port", "0"], '--port must be a port from 1 to 65535, not "0".'],
        [["stop", "now"], "Unknown command now. Use --help."],
    ];
    for (const [argv, error] of refused) assert.deepEqual(readCliArgs(argv, {}), { error }, argv.join(" "));
});

test("screen options are refused by commands that never open a screen", () => {
    for (const command of ["serve", "stop", "status", "hooks", "plugin"])
        for (const option of ["--no-mouse", "--no-color", "--no-bell"])
            assert.deepEqual(readCliArgs([command, option], {}), {
                error: `${option} works only in the terminal app.`,
            });
});

test("project folders may match command names; -- makes option-like names literal", () => {
    for (const command of ["hooks", "plugin"])
        for (const folder of ["status", "serve", "hooks", "plugin", "--help", "--no-color", "--remove", "-project"])
            for (const separator of folder.startsWith("-") ? [["--"]] : [[], ["--"]])
                assert.deepEqual(projectArgs([command, ...separator, folder]), {
                    command,
                    folder,
                    port: 4319,
                    remove: false,
                });
});

test("status computes disk usage only when requested", () => {
    assert.deepEqual(readCliArgs(["status", "--disk-usage"], {}), {
        command: "status",
        port: 4319,
        diskUsage: true,
    });
    assert.deepEqual(readCliArgs(["serve", "--disk-usage"], {}), {
        error: "--disk-usage works only with status.",
    });
});

test("a missing option value does not consume the next option or positional separator", () => {
    assert.deepEqual(readCliArgs(["--port", "-h"], {}), { command: "help" });
    assert.deepEqual(readCliArgs(["hooks", "--port", "--", "status"], {}), {
        error: '--port must be a port from 1 to 65535, not "".',
    });
});

test("hooks takes one folder, as typed, and izbor's port; a second folder, --yes or another command is refused", () => {
    const cases: [string[], Record<string, string>, Pick<ProjectArgs, "command" | "port" | "folder">][] = [
        [["hooks"], {}, { command: "hooks", port: 4319, folder: undefined }],
        [["hooks", "/x", "--port", "5123"], {}, { command: "hooks", port: 5123, folder: "/x" }],
        [["--port", "5123", "hooks", "/x"], {}, { command: "hooks", port: 5123, folder: "/x" }],
        [["hooks", "/x"], { IZBOR_PORT: "5124", PORT: "3000" }, { command: "hooks", port: 5124, folder: "/x" }],
        [["hooks", "../a b"], {}, { command: "hooks", port: 4319, folder: "../a b" }],
    ];
    for (const [argv, env, expected] of cases) {
        const { command, port, folder } = projectArgs(argv, env);
        assert.deepEqual({ command, port, folder }, expected, JSON.stringify({ argv, env }));
    }

    const refused: [string[], string][] = [
        [["hooks", "a", "b"], "hooks takes one folder."],
        [["hooks", "--yes"], "--yes works only with stop."],
        [["stop", "hooks"], "hooks does not go with stop."],
        [["status", "/x"], "Unknown command /x. Use --help."],
        [["/x", "hooks"], "Unknown command /x. Use --help."],
    ];
    for (const [argv, error] of refused) assert.deepEqual(readCliArgs(argv, {}), { error }, argv.join(" "));
    assert.equal("folder" in (readCliArgs(["stop"], {}) as CliArgs), false, "only hooks has a folder");
});

test("hooks --remove sets remove, before or after hooks and its folder; --remove without hooks is refused", () => {
    const cases: [string[], Pick<ProjectArgs, "command" | "folder" | "remove">][] = [
        [["hooks"], { command: "hooks", folder: undefined, remove: false }],
        [["hooks", "--remove", "/x"], { command: "hooks", folder: "/x", remove: true }],
        [["hooks", "/x", "--remove"], { command: "hooks", folder: "/x", remove: true }],
        [["--remove", "hooks"], { command: "hooks", folder: undefined, remove: true }],
        [["--remove", "--port", "5123", "hooks", "/x"], { command: "hooks", folder: "/x", remove: true }],
    ];
    for (const [argv, expected] of cases) {
        const { command, folder, remove } = projectArgs(argv);
        assert.deepEqual({ command, folder, remove }, expected, argv.join(" "));
    }

    const refused: [string[], string][] = [
        [["stop", "--remove"], "--remove works only with hooks and plugin."],
        [["--remove"], "--remove works only with hooks and plugin."],
        [["status", "--remove"], "--remove works only with hooks and plugin."],
        [["--no-color", "--remove"], "--remove works only with hooks and plugin."],
        [["hooks", "--remove", "a", "b"], "hooks takes one folder."],
    ];
    for (const [argv, error] of refused) assert.deepEqual(readCliArgs(argv, {}), { error }, argv.join(" "));
    assert.equal("remove" in (readCliArgs(["stop"], {}) as CliArgs), false, "only hooks has remove");
});

test("plugin takes one folder and --remove, as hooks does, and izbor's port; a second folder is refused", () => {
    const cases: [string[], Pick<ProjectArgs, "command" | "port" | "folder" | "remove">][] = [
        [["plugin"], { command: "plugin", port: 4319, folder: undefined, remove: false }],
        [["plugin", "/x", "--port", "5123"], { command: "plugin", port: 5123, folder: "/x", remove: false }],
        [["plugin", "--remove", "/x"], { command: "plugin", port: 4319, folder: "/x", remove: true }],
        [["--remove", "plugin", "../a b"], { command: "plugin", port: 4319, folder: "../a b", remove: true }],
    ];
    for (const [argv, expected] of cases) {
        const { command, port, folder, remove } = projectArgs(argv);
        assert.deepEqual({ command, port, folder, remove }, expected, argv.join(" "));
    }

    const refused: [string[], string][] = [
        [["plugin", "a", "b"], "plugin takes one folder."],
        [["plugin", "--yes"], "--yes works only with stop."],
    ];
    for (const [argv, error] of refused) assert.deepEqual(readCliArgs(argv, {}), { error }, argv.join(" "));
});

test("what is not a port is refused, from --port or from IZBOR_PORT", () => {
    const refused = (argv: string[], env: Record<string, string>, error: string) =>
        assert.deepEqual(readCliArgs(argv, env), { error }, JSON.stringify({ argv, env }));

    refused(["serve", "--port", "0"], {}, `--port must be a port from 1 to 65535, not "0".`);
    for (const port of ["0", "65536", "http", "4319.5", "-1", ""])
        refused(["--port", port], {}, `--port must be a port from 1 to 65535, not "${port}".`);
    refused(["--port"], {}, `--port must be a port from 1 to 65535, not "".`);
    refused([], { IZBOR_PORT: "http" }, `IZBOR_PORT must be a port from 1 to 65535, not "http".`);
    assert.equal(commandAndPort(["--port", "65535"]).port, 65535);
    assert.equal(commandAndPort(["--port", "1"]).port, 1);
});

test("--no-color, NO_COLOR and a dumb terminal turn color off; --no-mouse leaves the mouse to the terminal", () => {
    const screen = (argv: string[], env: Record<string, string> = {}) => {
        const args = readCliArgs(argv, env);
        assert.ok(!("error" in args) && "screen" in args, JSON.stringify(args));
        return { color: args.screen.color, mouse: args.screen.mouse };
    };
    assert.deepEqual(screen([]), { color: true, mouse: true });
    assert.deepEqual(screen(["--no-color", "--no-mouse"]), { color: false, mouse: false });
    assert.deepEqual(screen([], { NO_COLOR: "" }), { color: false, mouse: true });
    assert.deepEqual(screen([], { TERM: "dumb" }), { color: false, mouse: true });
});

test("the bell rings in the terminal app unless --no-bell; no environment variable turns it off", () => {
    const bell = (argv: string[], env: Record<string, string> = {}) => {
        const args = readCliArgs(argv, env);
        assert.ok(!("error" in args) && "screen" in args, JSON.stringify(args));
        return args.screen.bell;
    };
    assert.equal(bell([]), true);
    assert.equal(bell(["--no-bell"]), false);
    assert.equal(bell(["--no-bell", "--no-color"]), false);
    assert.equal(bell([], { IZBOR_BELL: "0", NO_COLOR: "1" }), true, "the flag is the bell's only switch");
});

test("IZBOR_OLD_BUILD=1, which bin/izbor.js sets on an old build, is the screen's oldBuild; any other value is not", () => {
    const oldBuild = (argv: string[], value?: string) => {
        const args = readCliArgs(argv, value === undefined ? {} : { IZBOR_OLD_BUILD: value });
        assert.ok("screen" in args, JSON.stringify(args));
        return args.screen.oldBuild;
    };
    assert.deepEqual(
        [oldBuild([], "1"), oldBuild(["--no-color"], "1"), oldBuild([]), oldBuild([], "0"), oldBuild([], "")],
        [true, true, false, false, false],
    );
});

test("an unknown flag is refused", () => {
    assert.deepEqual(readCliArgs(["--watch"], {}), { error: "Unknown option --watch. Use --help." });
    assert.deepEqual(readCliArgs(["--no-color", "4a979d7e"], {}), { error: "Unknown command 4a979d7e. Use --help." });
});

test("a background Izbor's environment: Claude Code's own variables and PORT go, IZBOR_DATA_DIR names its data folder", () => {
    const env = {
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_SSE_PORT: "12345",
        CLAUDE_EFFORT: "high",
        CLAUDE_PID: "4242",
        AI_AGENT: "claude-code",
        PORT: "5050",
        CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
        PATH: "/usr/bin:/bin",
        IZBOR_DATA_DIR: "/somewhere/else",
        HOME,
    };

    assert.deepEqual(izborChildEnv(env, "/tmp/izbor-data"), {
        CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
        PATH: "/usr/bin:/bin",
        IZBOR_DATA_DIR: "/tmp/izbor-data",
        HOME,
    });
    assert.equal(env.PORT, "5050");
});

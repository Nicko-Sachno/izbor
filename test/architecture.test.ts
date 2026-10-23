import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";

type Import = { file: string; named: string };

function sourceFile(root: string, path: string): string {
    if (!path.endsWith(".js")) return path;
    const tsx = path.replace(/\.js$/, ".tsx");
    return existsSync(join(root, tsx)) ? tsx : path.replace(/\.js$/, ".ts");
}

async function importsIn(root: string): Promise<Import[]> {
    const files = (await readdir(join(root, "src"), { recursive: true })).filter((f) => /\.tsx?$/.test(f));
    const imports = await Promise.all(
        files.map(async (name) => {
            const file = join("src", name).split(sep).join("/");
            const source = await readFile(join(root, file), "utf8");
            return [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((m) => ({
                file,
                named: sourceFile(root, posix.join(posix.dirname(file), m[1]!)),
            }));
        }),
    );
    return imports.flat();
}

const under = (dir: string) => (path: string) => path.startsWith(`${dir}/`);
const inDomain = under("src/domain");
const inTerminal = under("src/terminal");
const inIzborClient = under("src/adapters/izbor");
const inCli = under("src/cli");
const CLI_ENTRY = "src/cli/main.ts";
const inCommands = under("src/cli/commands");
const COMMANDS_MAY_IMPORT = ["src/core/ports.ts", "src/config.ts", "src/cli/args.ts"];

const SHARED_WITH_TERMINAL = [
    "src/config.ts",
    "src/adapters/agents/claude/setup/izborHooks.ts",
    "src/adapters/agents/claude/setup/answerHook.ts",
    "src/adapters/agents/claude/setup/projectFiles.ts",
    "src/adapters/agents/claude/setup/hookSettings.ts",
];

const isProviderFile = under("src/adapters/agents/claude");

const adapterFolder = (path: string) => /^src\/adapters\/[^/]+(?=\/)/.exec(path)?.[0];

const COMPOSITION = ["src/service.ts", "src/izbor.ts", "src/watch.ts"];
const inSrcRoot = (path: string) => /^src\/[^/]+$/.test(path);

const inPlatform = under("src/adapters/platform");
const PLATFORM_SELECTOR = "src/adapters/platform/select.ts";
const CHOOSES_PLATFORM = ["src/main.ts", CLI_ENTRY];

const inLog = under("src/adapters/log");
const BUILDS_LOG = ["src/foreground.ts"];

const PROVIDER_REGISTRY = "src/adapters/agents/registry.ts";
const BUILDS_PROVIDERS = ["src/foreground.ts"];

const PROJECT_SETUPS = "src/adapters/agents/projects.ts";

const RULES = {
    "the domain imports nothing outside the domain": ({ file, named }) => inDomain(file) && !inDomain(named),
    "the core never imports adapters": ({ file, named }) => under("src/core")(file) && under("src/adapters")(named),
    "the terminal app imports only itself, the domain, the Izbor client and the files it shares": ({ file, named }) =>
        inTerminal(file) &&
        !(inTerminal(named) || inDomain(named) || inIzborClient(named) || SHARED_WITH_TERMINAL.includes(named)),
    "in src/, only src/cli imports the terminal app": ({ file, named }) =>
        inTerminal(named) && !inTerminal(file) && !inCli(file),
    "the Izbor client imports only the domain": ({ file, named }) =>
        inIzborClient(file) && !(inIzborClient(named) || inDomain(named)),
    "in src/, only the terminal app, src/cli/commands and the CLI entry import the Izbor client": ({ file, named }) =>
        inIzborClient(named) && !(inIzborClient(file) || inTerminal(file) || inCommands(file) || file === CLI_ENTRY),
    "src/cli/commands imports only the domain, src/core/ports.ts, src/config.ts, src/cli/args.ts, the Izbor client and src/cli/commands":
        ({ file, named }) =>
            inCommands(file) &&
            !(inDomain(named) || inIzborClient(named) || inCommands(named) || COMMANDS_MAY_IMPORT.includes(named)),
    "adapters import only adapters, the core and the domain": ({ file, named }) =>
        under("src/adapters")(file) && !(under("src/adapters")(named) || under("src/core")(named) || inDomain(named)),
    "an adapter folder imports no sibling adapter folder": ({ file, named }) => {
        const folder = adapterFolder(file);
        return folder !== undefined && under("src/adapters")(named) && !under(folder)(named);
    },
    "the core imports only the core and the domain": ({ file, named }) =>
        under("src/core")(file) && !(under("src/core")(named) || inDomain(named)),
    "the composition files import no other file of the src root": ({ file, named }) =>
        COMPOSITION.includes(file) && inSrcRoot(named) && !COMPOSITION.includes(named),
    "only src/main.ts and src/cli/main.ts import the platform selector, and only the selector imports a platform file":
        ({ file, named }) =>
            named === PLATFORM_SELECTOR ? !CHOOSES_PLATFORM.includes(file) : inPlatform(named) && !inPlatform(file),
    "only src/foreground.ts imports src/adapters/log/": ({ file, named }) =>
        inLog(named) && !(inLog(file) || BUILDS_LOG.includes(file)),
    "outside src/adapters/agents, only a provider file imports a provider file, and the terminal app only one it shares":
        ({ file, named }) =>
            isProviderFile(named) &&
            !(under("src/adapters/agents")(file) || (inTerminal(file) && SHARED_WITH_TERMINAL.includes(named))),
    "only src/foreground.ts imports src/adapters/agents/registry.ts": ({ file, named }) =>
        named === PROVIDER_REGISTRY && !BUILDS_PROVIDERS.includes(file),
    "only src/cli/main.ts imports src/adapters/agents/projects.ts": ({ file, named }) =>
        named === PROJECT_SETUPS && file !== CLI_ENTRY,
} satisfies Record<string, (i: Import) => boolean>;
type Rule = keyof typeof RULES;

const broken = (imports: Import[], rule: Rule) =>
    imports.filter(RULES[rule]).map(({ file, named }) => `${file} imports ${named}`);

const KNOWN: Partial<Record<Rule, string[]>> = {};

for (const rule of Object.keys(RULES) as Rule[]) {
    test(rule, async () => {
        assert.deepEqual(broken(await importsIn("."), rule).sort(), (KNOWN[rule] ?? []).sort());
    });
}

test("importsIn reads static, type-only and dynamic imports in nested .ts and .tsx files, and names a .tsx file when one exists", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "izbor-architecture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src/terminal/live"), { recursive: true });
    await mkdir(join(root, "src/cli"), { recursive: true });
    await writeFile(join(root, "src/terminal/view.tsx"), "");
    await writeFile(
        join(root, "src/terminal/live/planted.tsx"),
        `import type { Listener } from "../../core/watchTracker.js";\nimport { View } from "../view.js";\nimport { toTerminalBrief } from "./brief.js";\n`,
    );
    await writeFile(
        join(root, "src/cli/main.ts"),
        `const { PROVIDERS } = await import("../adapters/agents/registry.js");\n`,
    );

    const key = ({ file, named }: Import) => `${file} imports ${named}`;
    assert.deepEqual((await importsIn(root)).map(key).sort(), [
        "src/cli/main.ts imports src/adapters/agents/registry.ts",
        "src/terminal/live/planted.tsx imports src/core/watchTracker.ts",
        "src/terminal/live/planted.tsx imports src/terminal/live/brief.ts",
        "src/terminal/live/planted.tsx imports src/terminal/view.tsx",
    ]);
});

const imports = (file: string, ...named: string[]): Import[] => named.map((path) => ({ file, named: path }));

const ADAPTERS_AND_CORE = [
    ...imports("src/adapters/planted.ts", "src/config.ts", "src/adapters/log/stdoutLog.ts"),
    ...imports(
        "src/adapters/http/planted.ts",
        "src/adapters/hooks/payload.ts",
        "src/adapters/sendKey.ts",
        "src/adapters/http/sse.ts",
        "src/core/ports.ts",
        "src/domain/brief.ts",
    ),
    ...imports(
        "src/adapters/agents/claude/planted.ts",
        "src/adapters/agents/command.ts",
        "src/adapters/agents/claude/status.ts",
    ),
    ...imports("src/core/planted.ts", "src/config.ts", "src/core/watchTracker.ts", "src/domain/brief.ts"),
    ...imports("src/service.ts", "src/foreground.ts", "src/izbor.ts", "src/adapters/http/server.ts"),
    ...imports("src/main.ts", "src/config.ts"),
];

const PLANTED: { rule: Rule; imports: Import[]; expected: string[] }[] = [
    {
        rule: "the terminal app imports only itself, the domain, the Izbor client and the files it shares",
        imports: [
            ...imports("src/terminal/planted.tsx", "src/core/watchTracker.ts"),
            ...imports("src/terminal/live/planted.tsx", "src/core/watchTracker.ts", "src/terminal/live/brief.ts"),
        ],
        expected: [
            "src/terminal/live/planted.tsx imports src/core/watchTracker.ts",
            "src/terminal/planted.tsx imports src/core/watchTracker.ts",
        ],
    },
    {
        rule: "adapters import only adapters, the core and the domain",
        imports: ADAPTERS_AND_CORE,
        expected: ["src/adapters/planted.ts imports src/config.ts"],
    },
    {
        rule: "an adapter folder imports no sibling adapter folder",
        imports: ADAPTERS_AND_CORE,
        expected: [
            "src/adapters/http/planted.ts imports src/adapters/hooks/payload.ts",
            "src/adapters/http/planted.ts imports src/adapters/sendKey.ts",
        ],
    },
    {
        rule: "the core imports only the core and the domain",
        imports: ADAPTERS_AND_CORE,
        expected: ["src/core/planted.ts imports src/config.ts"],
    },
    {
        rule: "the composition files import no other file of the src root",
        imports: ADAPTERS_AND_CORE,
        expected: ["src/service.ts imports src/foreground.ts"],
    },
    {
        rule: "src/cli/commands imports only the domain, src/core/ports.ts, src/config.ts, src/cli/args.ts, the Izbor client and src/cli/commands",
        imports: [
            ...imports(
                "src/cli/commands/planted.ts",
                "src/adapters/platform/select.ts",
                "src/core/watchTracker.ts",
                "src/service.ts",
                "src/adapters/izbor/client.ts",
                "src/config.ts",
                "src/core/ports.ts",
                "src/domain/wire.ts",
                "src/cli/commands/report.ts",
            ),
            ...imports("src/cli/main.ts", "src/adapters/izbor/client.ts"),
        ],
        expected: [
            "src/cli/commands/planted.ts imports src/adapters/platform/select.ts",
            "src/cli/commands/planted.ts imports src/core/watchTracker.ts",
            "src/cli/commands/planted.ts imports src/service.ts",
        ],
    },
    {
        rule: "only src/main.ts and src/cli/main.ts import the platform selector, and only the selector imports a platform file",
        imports: [
            ...imports("src/main.ts", "src/adapters/platform/select.ts"),
            ...imports("src/cli/main.ts", "src/adapters/platform/select.ts"),
            ...imports("src/adapters/platform/select.ts", "src/adapters/platform/darwin.ts"),
            ...imports(
                "src/service.ts",
                "src/adapters/platform/select.ts",
                "src/adapters/platform/darwin.ts",
                "src/core/ports.ts",
            ),
            ...imports("src/adapters/summarizer/planted.ts", "src/adapters/platform/darwin.ts", "src/core/ports.ts"),
        ],
        expected: [
            "src/adapters/summarizer/planted.ts imports src/adapters/platform/darwin.ts",
            "src/service.ts imports src/adapters/platform/darwin.ts",
            "src/service.ts imports src/adapters/platform/select.ts",
        ],
    },
    {
        rule: "outside src/adapters/agents, only a provider file imports a provider file, and the terminal app only one it shares",
        imports: [
            ...imports("src/watch.ts", "src/adapters/agents/claude/hook.ts", "src/izbor.ts"),
            ...imports(
                "src/adapters/http/planted.ts",
                "src/adapters/agents/claude/payload.ts",
                "src/adapters/http/sse.ts",
            ),
            ...imports("src/adapters/agents/registry.ts", "src/adapters/agents/claude/provider.ts"),
            ...imports(
                "src/adapters/agents/claude/hook.ts",
                "src/adapters/agents/claude/payload.ts",
                "src/core/ports.ts",
            ),
            ...imports(
                "src/terminal/planted.ts",
                SHARED_WITH_TERMINAL.find((path) => path.endsWith("/projectFiles.ts"))!,
                "src/adapters/agents/claude/payload.ts",
            ),
        ],
        expected: [
            "src/adapters/http/planted.ts imports src/adapters/agents/claude/payload.ts",
            "src/terminal/planted.ts imports src/adapters/agents/claude/payload.ts",
            "src/watch.ts imports src/adapters/agents/claude/hook.ts",
        ],
    },
    {
        rule: "only src/foreground.ts imports src/adapters/agents/registry.ts",
        imports: [
            ...imports("src/foreground.ts", "src/adapters/agents/registry.ts"),
            ...imports("src/cli/main.ts", "src/adapters/agents/registry.ts"),
            ...imports("src/service.ts", "src/adapters/agents/registry.ts", "src/core/ports.ts"),
            ...imports("src/adapters/http/planted.ts", "src/adapters/agents/registry.ts"),
            ...imports("src/adapters/agents/registry.ts", "src/adapters/agents/claude/provider.ts"),
        ],
        expected: [
            "src/adapters/http/planted.ts imports src/adapters/agents/registry.ts",
            "src/cli/main.ts imports src/adapters/agents/registry.ts",
            "src/service.ts imports src/adapters/agents/registry.ts",
        ],
    },
    {
        rule: "only src/cli/main.ts imports src/adapters/agents/projects.ts",
        imports: [
            ...imports("src/cli/main.ts", "src/adapters/agents/projects.ts"),
            ...imports("src/main.ts", "src/adapters/agents/projects.ts"),
            ...imports("src/service.ts", "src/adapters/agents/projects.ts", "src/core/ports.ts"),
            ...imports("src/adapters/http/planted.ts", "src/adapters/agents/projects.ts"),
            ...imports("src/adapters/agents/projects.ts", "src/adapters/agents/claude/setup/project.ts"),
        ],
        expected: [
            "src/adapters/http/planted.ts imports src/adapters/agents/projects.ts",
            "src/main.ts imports src/adapters/agents/projects.ts",
            "src/service.ts imports src/adapters/agents/projects.ts",
        ],
    },
];

test("a planted import breaks its rule, and only from the files the rule forbids", () => {
    for (const { rule, imports, expected } of PLANTED) assert.deepEqual(broken(imports, rule).sort(), expected, rule);
});

const SRC_ROOT = ["config.ts", "foreground.ts", "main.ts", "izbor.ts", "service.ts", "watch.ts"];

test("the src root holds its six named files, and no other .ts file", async () => {
    const files = (await readdir("src")).filter((name) => /\.tsx?$/.test(name));
    assert.deepEqual(files.sort(), [...SRC_ROOT].sort());
});

test("nothing in the terminal app or the CLI writes with console: Ink takes over the console while it runs", async () => {
    const sources = async (dir: string) =>
        (await readdir(dir, { recursive: true })).filter((name) => /\.tsx?$/.test(name)).map((name) => join(dir, name));
    const writers: string[] = [];
    for (const file of [...(await sources("src/terminal")), ...(await sources("src/cli"))])
        if (/\bconsole\s*\./.test(await readFile(file, "utf8"))) writers.push(file);
    assert.deepEqual(writers, []);
});

test("no file in src or scripts writes a curl hook line: Izbor's hook runs through node, on every platform", async () => {
    const sources = async (dir: string) =>
        (await readdir(dir, { recursive: true }))
            .filter((name) => /\.(tsx?|js|sh)$/.test(name))
            .map((name) => join(dir, name));
    const curls: string[] = [];
    for (const file of [...(await sources("src")), ...(await sources("scripts"))])
        if ((await readFile(file, "utf8")).includes("curl -s")) curls.push(file);
    assert.deepEqual(curls, []);
});

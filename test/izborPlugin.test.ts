import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerHookEntry, mergeAnswerHook, removeAnswerHook } from "../src/adapters/agents/claude/setup/answerHook.js";
import { eventHookEntry } from "../src/adapters/agents/claude/setup/izborHooks.js";
import {
    changeActing,
    createPluginCommand,
    type RunPluginCommand,
} from "../src/adapters/agents/claude/setup/plugin.js";
import { PROJECT_DIR } from "../src/config.js";
import { hasIzborHooks, HOOK_RUNNER } from "./helpers/answerHook.js";
import { runIzborBin } from "./helpers/bin.js";
import { homeEnv, pathFirst, skipOnWindows } from "./helpers/fakeCommand.js";
import { hostPlatform, runAs } from "./helpers/fakePlatform.js";
import { fakeClaude, freePort } from "./support.js";

async function tempProject(t: TestContext) {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "izbor-plugin-")));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const home = join(tmp, "home");
    const global = join(home, ".claude", "settings.json");
    const globalText = '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "izbor-hook" }] }] } }\n';
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(global, globalText);
    const repo = join(tmp, "repo");
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
    return { tmp, home, global, globalText, repo, file: join(repo, ".claude", "settings.local.json") };
}

async function izbor(t: TestContext, home: string, port: number, args: string[], first?: string) {
    const run = await runIzborBin(args, {
        env: {
            ...homeEnv(home),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            IZBOR_PORT: String(port),
            ...(first && pathFirst(first)),
        },
    });
    t.after(() => Promise.all([run.cwd, run.home].map((dir) => rm(dir, { recursive: true, force: true }))));
    const hung = setTimeout(() => run.child.kill("SIGKILL"), 10_000);
    const [code] = await run.exited;
    clearTimeout(hung);
    return { code, stdout: run.output.stdout, stderr: run.output.stderr };
}

const permissionRequest = (text: string) => JSON.parse(text).hooks.PermissionRequest as { hooks: object[] }[];

const answerEntries = (text: string) =>
    permissionRequest(text)
        .flatMap((group) => group.hooks)
        .filter((hook) => JSON.stringify(hook).includes("/hook/answer"));

const TAKES =
    "Sessions there, running ones too, can take answers from Izbor from their next request; new sessions take prompts from Izbor too, a running one after /reload-plugins.";
const STOPS = "Sessions there, running ones too, answer and take prompts only in Claude Code from now on.";

const PLUGIN_DIR = join(PROJECT_DIR, "plugin");

test("a partial install preserves the marketplace, adds no answer hook, and a retry resumes at installation", async (t) => {
    const { home, repo, file } = await tempProject(t);
    const calls: string[][] = [];
    let failInstall = true;
    const marketplace = { extraKnownMarketplaces: { izbor: { source: { source: "directory", path: PLUGIN_DIR } } } };
    const run: RunPluginCommand = async (args) => {
        calls.push(args);
        if (args[0] === "marketplace") {
            await mkdir(join(repo, ".claude"), { recursive: true });
            await writeFile(file, JSON.stringify(marketplace));
        } else if (failInstall) return { outcome: "failed", message: "installation failed" };
        else await writeFile(file, JSON.stringify({ ...marketplace, enabledPlugins: { "izbor@izbor": true } }));
        return { outcome: "ok" };
    };
    const install = () =>
        changeActing({
            change: "add",
            folder: repo,
            port: 4319,
            home,
            platform: hostPlatform(),
            pluginDir: PLUGIN_DIR,
            run,
            runner: HOOK_RUNNER,
        });
    assert.deepEqual(await install(), { refused: "plugin", checkout: repo, why: "installation failed" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), marketplace);
    failInstall = false;
    assert.deepEqual(await install(), { done: "added", checkout: repo, file });
    assert.deepEqual(calls, [
        ["marketplace", "add", PLUGIN_DIR, "--scope", "local"],
        ["install", "izbor@izbor", "--scope", "local"],
        ["install", "izbor@izbor", "--scope", "local"],
    ]);
    assert.equal(answerEntries(await readFile(file, "utf8")).length, 1);
});

test("a hook write failure after installation preserves the plugin and a retry only writes the hook", async (t) => {
    const { home, repo, file } = await tempProject(t);
    const calls: string[][] = [];
    const run: RunPluginCommand = async (args) => {
        calls.push(args);
        await mkdir(join(repo, ".claude"), { recursive: true });
        await writeFile(file, JSON.stringify(DECLARED));
        return { outcome: "ok" };
    };
    const platform = hostPlatform();
    const request = {
        change: "add",
        folder: repo,
        port: 4319,
        home,
        pluginDir: PLUGIN_DIR,
        run,
        runner: HOOK_RUNNER,
    } as const;
    assert.deepEqual(
        await changeActing({
            ...request,
            platform: {
                ...platform,
                replaceFile() {
                    throw new Error("disk full");
                },
            },
        }),
        { refused: "write", checkout: repo, file, why: "disk full" },
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), DECLARED);
    assert.deepEqual(await changeActing({ ...request, platform }), { done: "added", checkout: repo, file });
    assert.equal(calls.length, 2, "the retry does not reinstall an already enabled plugin");
    assert.equal(answerEntries(await readFile(file, "utf8")).length, 1);
});

const DECLARED = {
    enabledPlugins: { "izbor@izbor": true },
    extraKnownMarketplaces: { izbor: { source: { source: "directory", path: PLUGIN_DIR } } },
};

const loggingClaude = (log: string) =>
    fakeClaude(
        `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(log)}, \`\${process.cwd()} \${process.argv.slice(2).join(" ")}\\n\`);\nprocess.stdout.write('{"outcome":"ok","message":"done"}\\n');`,
    );

// Stands in for Claude Code's plugin CLI: logs each call and makes the same edits to the checkout's
// settings.local.json that `claude plugin ... --scope local` makes, so seam 4 runs where claude is not installed.
const settingsClaude = (log: string) =>
    fakeClaude(`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, \`\${process.cwd()} \${args.join(" ")}\\n\`);
const file = path.join(process.cwd(), ".claude", "settings.local.json");
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const command = args.slice(1, args[1] === "marketplace" ? 3 : 2).join(" ");
if (command === "marketplace add") {
    settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, izbor: { source: { source: "directory", path: args[3] } } };
} else if (command === "install") {
    settings.enabledPlugins = { ...settings.enabledPlugins, [args[2]]: true };
} else if (command === "uninstall") {
    settings.enabledPlugins = { ...settings.enabledPlugins };
    delete settings.enabledPlugins[args[2]];
} else if (command === "marketplace remove") {
    settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces };
    delete settings.extraKnownMarketplaces[args[3]];
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\\n");
process.stdout.write('{"outcome":"ok","message":"done"}\\n');`);

test("seam 4: izbor plugin installs Izbor's plugin at local scope, through Claude Code's CLI (here a stand-in), and adds exactly one answer hook beside Izbor's 14 hooks; again, already; an outdated hook is replaced in place; --remove uninstalls the plugin, removes the marketplace and takes the hook out; izbor hooks leaves them; the global settings file is untouched", async (t) => {
    const { tmp, home, global, globalText, repo, file } = await tempProject(t);
    const port = await freePort();
    const entry = answerHookEntry(HOOK_RUNNER, port);
    const log = join(tmp, "claude.log");
    const claude = await settingsClaude(log);
    const plugin = (args: string[]) => izbor(t, home, port, ["plugin", ...args], claude.dir);
    const calls = async () => (await readFile(log, "utf8")).trim().split("\n");

    assert.equal((await izbor(t, home, port, ["hooks", repo])).code, 0);
    const withHooks = await readFile(file, "utf8");
    assert.deepEqual(await plugin([repo]), {
        code: 0,
        stdout: `Izbor's plugin and answer hook for port ${port} are in ${file}. ${TAKES}\n`,
        stderr: "",
    });
    const added = await readFile(file, "utf8");
    assert.equal(hasIzborHooks(added, port), true);
    const { hooks: _hooks, ...declared } = JSON.parse(added);
    assert.deepEqual(declared, DECLARED);
    assert.deepEqual(await calls(), [
        `${repo} plugin marketplace add ${PLUGIN_DIR} --scope local --json`,
        `${repo} plugin install izbor@izbor --scope local --json`,
    ]);
    assert.deepEqual(permissionRequest(added), [{ hooks: [eventHookEntry(HOOK_RUNNER, port)] }, { hooks: [entry] }]);
    assert.deepEqual(
        { ...JSON.parse(added).hooks, PermissionRequest: [] },
        {
            ...JSON.parse(withHooks).hooks,
            PermissionRequest: [],
        },
    );

    assert.deepEqual(await plugin([repo]), {
        code: 0,
        stdout: `${file} already has Izbor's plugin and answer hook.\n`,
        stderr: "",
    });
    assert.equal(await readFile(file, "utf8"), added);

    assert.equal((await izbor(t, home, port, ["hooks", "--remove", repo])).code, 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        hooks: { PermissionRequest: [{ hooks: [entry] }] },
        ...DECLARED,
    });
    assert.equal((await izbor(t, home, port, ["hooks", repo])).code, 0);
    const again = await readFile(file, "utf8");
    assert.equal(hasIzborHooks(again, port), true);
    assert.deepEqual(answerEntries(again), [entry]);

    const curl = (flags: string, path: string) =>
        `curl ${flags} --connect-timeout 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}${path} || true`;
    const outdated = { type: "command", command: curl("-sf -m 3630", "/hook/answer"), timeout: 3660 };
    const settings = JSON.parse(again);
    settings.hooks.PermissionRequest = [
        { matcher: "Bash", hooks: [outdated, { type: "command", command: "afplay Glass.aiff" }] },
        { hooks: [{ type: "command", command: curl("-s -o /dev/null -m 2", "/hook") }] },
    ];
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    assert.deepEqual(await plugin([repo]), {
        code: 0,
        stdout: `Updated Izbor's answer hook for port ${port} in ${file}, beside its plugin. ${TAKES}\n`,
        stderr: "",
    });
    const updated = await readFile(file, "utf8");
    assert.deepEqual(permissionRequest(updated)[0], {
        matcher: "Bash",
        hooks: [entry, { type: "command", command: "afplay Glass.aiff" }],
    });
    assert.deepEqual(answerEntries(updated), [entry]);

    assert.deepEqual(await plugin(["--remove", repo]), {
        code: 0,
        stdout: `Removed Izbor's plugin and answer hook for port ${port} from ${file}. ${STOPS}\n`,
        stderr: "",
    });
    const removed = await readFile(file, "utf8");
    assert.deepEqual(answerEntries(removed), []);
    const { hooks: _left, ...undeclared } = JSON.parse(removed);
    assert.deepEqual(undeclared, { enabledPlugins: {}, extraKnownMarketplaces: {} });
    assert.deepEqual((await calls()).slice(2), [
        `${repo} plugin uninstall izbor@izbor --scope local --json`,
        `${repo} plugin marketplace remove izbor --scope local --json`,
    ]);
    assert.equal(hasIzborHooks(removed, port), true);
    assert.deepEqual(permissionRequest(removed)[0], {
        matcher: "Bash",
        hooks: [{ type: "command", command: "afplay Glass.aiff" }],
    });
    assert.deepEqual(await plugin([repo, "--remove"]), {
        code: 0,
        stdout: `${file} has no Izbor plugin or answer hook for port ${port}.\n`,
        stderr: "",
    });

    assert.equal(await readFile(global, "utf8"), globalText);
    assert.deepEqual(await readdir(join(repo, ".claude")), ["settings.local.json"], "no temp file is left");
});

test("izbor plugin refuses what izbor hooks refuses, in the same words, and writes nothing", async (t) => {
    const { tmp, home, global, globalText } = await tempProject(t);
    const port = await freePort();
    const broken = join(tmp, "broken");
    await mkdir(join(broken, ".claude"), { recursive: true });
    await writeFile(join(broken, ".claude", "settings.local.json"), "{ hooks");

    assert.deepEqual(await izbor(t, home, port, ["plugin", home]), {
        code: 1,
        stdout: "",
        stderr: "izbor plugin needs a project folder, not your home folder.\n",
    });
    assert.deepEqual(await izbor(t, home, port, ["plugin", join(tmp, "missing")]), {
        code: 1,
        stdout: "",
        stderr: `No folder ${join(tmp, "missing")}.\n`,
    });
    assert.deepEqual(await izbor(t, home, port, ["plugin", "--remove", broken]), {
        code: 1,
        stdout: "",
        stderr: `${join(broken, ".claude", "settings.local.json")} is not valid JSON; Izbor changed nothing.\n`,
    });
    assert.equal(await readFile(join(broken, ".claude", "settings.local.json"), "utf8"), "{ hooks");
    assert.equal(await readFile(global, "utf8"), globalText);
});

test("the answer hook is known by its address: another port's stays, a lookalike address is not it, and two of one port become one", () => {
    const own = answerHookEntry(HOOK_RUNNER, 5123);
    const other = answerHookEntry(HOOK_RUNNER, 5124);
    const lookalike = { type: "command", command: "curl http://127.0.0.1:5123/hook/answers" };
    const text = (...hooks: object[]) => `${JSON.stringify({ hooks: { PermissionRequest: [{ hooks }] } }, null, 2)}\n`;

    const added = mergeAnswerHook(text(other, lookalike), 5123, HOOK_RUNNER);
    assert.deepEqual("text" in added && JSON.parse(added.text).hooks.PermissionRequest, [
        { hooks: [other, lookalike] },
        { hooks: [own] },
    ]);
    const twice = mergeAnswerHook(text(own, other, own), 5123, HOOK_RUNNER);
    assert.deepEqual("text" in twice && [twice.done, JSON.parse(twice.text).hooks.PermissionRequest], [
        "updated",
        [{ hooks: [own, other] }],
    ]);
    const removed = removeAnswerHook(text(own, other), 5123);
    assert.deepEqual("text" in removed && JSON.parse(removed.text), {
        hooks: { PermissionRequest: [{ hooks: [other] }] },
    });
    assert.deepEqual(removeAnswerHook(text(own), 5123), { text: "{}\n", done: "removed" });
    assert.deepEqual(removeAnswerHook(null, 5123), { done: "none" });
});

test("izbor plugin with a Claude Code CLI that fails refuses in its words, and nothing is written; --remove of a plugin that is not there says so", async (t) => {
    const { home, repo, file } = await tempProject(t);
    const port = await freePort();

    const failing = await fakeClaude(
        `process.stdout.write('{"outcome":"failed","message":"Path does not exist: /x","failureCode":"invalid_source"}\\n');\nprocess.exitCode = 1;`,
    );
    assert.deepEqual(await izbor(t, home, port, ["plugin", repo], failing.dir), {
        code: 1,
        stdout: "",
        stderr: `Izbor could not install its plugin in ${repo}: Path does not exist: /x\n`,
    });
    assert.equal(existsSync(file), false);

    const notThere = await fakeClaude(
        `const code = process.argv.slice(2).join(" ").includes("uninstall") ? "not_installed" : "not_configured";\nprocess.stdout.write(\`{"outcome":"failed","message":"not found","failureCode":"\${code}"}\\n\`);\nprocess.exitCode = 1;`,
    );
    assert.deepEqual(await izbor(t, home, port, ["plugin", "--remove", repo], notThere.dir), {
        code: 0,
        stdout: `${file} has no Izbor plugin or answer hook for port ${port}.\n`,
        stderr: "",
    });
});

test(
    "izbor plugin on a subfolder of a git repo runs Claude Code's CLI in the repo root and adds the hook to the root's file, which Claude Code reads for it",
    skipOnWindows("Windows reads the session folder's own settings"),
    async (t) => {
        const { tmp, home, repo, file } = await tempProject(t);
        const log = join(tmp, "claude.log");
        const claude = await loggingClaude(log);
        const inside = join(repo, "src");
        await mkdir(inside);

        assert.equal((await izbor(t, home, await freePort(), ["plugin", inside], claude.dir)).code, 0);
        assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
            `${repo} plugin marketplace add ${PLUGIN_DIR} --scope local --json`,
            `${repo} plugin install izbor@izbor --scope local --json`,
        ]);
        assert.deepEqual(answerEntries(await readFile(file, "utf8")).length, 1);
        assert.deepEqual(await readdir(inside), []);
    },
);

test("without claude on PATH, izbor plugin refuses and writes nothing", async (t) => {
    const { tmp, home, repo, file } = await tempProject(t);
    const empty = join(tmp, "empty");
    await mkdir(empty);
    const refused = await runIzborBin(["plugin", repo], {
        env: { ...homeEnv(home), CLAUDE_CONFIG_DIR: join(home, ".claude"), PATH: empty },
    });
    t.after(() => Promise.all([refused.cwd, refused.home].map((dir) => rm(dir, { recursive: true, force: true }))));
    const [code] = await refused.exited;
    assert.equal(code, 1);
    const said = `Izbor could not install its plugin in ${repo}: `;
    assert.ok(refused.output.stderr.startsWith(said), refused.output.stderr);
    assert.match(refused.output.stderr.slice(said.length), /claude/);
    assert.equal(await readFile(file, "utf8").catch(() => "none"), "none");
});

test("a `claude plugin` command that cannot be started is failed, naming claude and why", async () => {
    const run = createPluginCommand({ run: runAs("/nonexistent/claude") });
    const result = await run(["install", "izbor@izbor"], tmpdir());
    assert.deepEqual(result, {
        outcome: "failed",
        message: "cannot run claude: spawn /nonexistent/claude ENOENT",
    });
});

test("a `claude plugin` command that prints nothing and exits 1 is failed with its exit code", async () => {
    const claude = await fakeClaude("process.exitCode = 1;");
    const run = createPluginCommand({ run: runAs(claude.command) });
    const result = await run(["install", "izbor@izbor"], tmpdir());
    assert.deepEqual(result, { outcome: "failed", message: "exited with code 1" });
});

test("a `claude plugin` command that prints the `ok` line is ok", async () => {
    const claude = await fakeClaude(`process.stdout.write('Installing\\n{"outcome":"ok","message":"done"}\\n');`);
    const run = createPluginCommand({ run: runAs(claude.command) });
    const result = await run(["install", "izbor@izbor"], tmpdir());
    assert.deepEqual(result, { outcome: "ok" });
});

test("a `claude plugin` command that prints the `failed` line is failed with its message and its failureCode, whatever it exits with", async () => {
    const claude = await fakeClaude(
        `process.stdout.write('{"outcome":"failed","message":"Path does not exist: /x","failureCode":"invalid_source"}\\n');\nprocess.exitCode = 1;`,
    );
    const run = createPluginCommand({ run: runAs(claude.command) });
    const result = await run(["marketplace", "add", "/x"], tmpdir());
    assert.deepEqual(result, {
        outcome: "failed",
        message: "Path does not exist: /x",
        failureCode: "invalid_source",
    });
});

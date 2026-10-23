import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createClaudeProvider } from "../src/adapters/agents/claude/provider.js";
import {
    answerHookAt,
    answerHookEntry,
    mergeAnswerHook,
    removeAnswerHook,
} from "../src/adapters/agents/claude/setup/answerHook.js";
import { createIzborClient } from "../src/adapters/izbor/client.js";
import { IZBOR_PLUGIN_DIR, PROJECT_DIR } from "../src/config.js";
import type { HooksRequest } from "../src/domain/projectSetup.js";
import { changeIzborHooks, createClaudeProject } from "../src/adapters/agents/claude/setup/project.js";
import { runHooks } from "../src/cli/commands/hooks.js";
import { runPlugin } from "../src/cli/commands/plugin.js";
import { hasIzborHooks, HOOK_RUNNER } from "./helpers/answerHook.js";
import { runIzborBin } from "./helpers/bin.js";
import { homeEnv, skipOnWindows } from "./helpers/fakeCommand.js";
import { fakePlatform, hostPlatform, OWNS_FILES_BY_UID } from "./helpers/fakePlatform.js";
import { freePort, RECEIVED_AT, SESSION } from "./support.js";
import { transcriptFixture } from "./helpers/transcripts.js";
import {
    HOOK_EVENT_NAMES,
    eventHookEntry,
    mergeIzborHooks,
    missingIzborHooks,
    izborHooksAt,
    removeIzborHooks,
} from "../src/adapters/agents/claude/setup/izborHooks.js";
import { checkoutOf } from "../src/adapters/agents/claude/setup/projectFiles.js";
import { isIzborHook } from "../src/adapters/agents/claude/setup/hookEntry.js";

const CURL_4319 =
    "curl -s -o /dev/null --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4319/hook || true";

const ENTRY_4319 = eventHookEntry(HOOK_RUNNER, 4319);
const ENTRY_5123 = eventHookEntry(HOOK_RUNNER, 5123);

test("Izbor's hook entry for 4319 is this one: node, this checkout's bin/post-hook.js, the address and a 2 s limit", () => {
    assert.deepEqual(ENTRY_4319, {
        type: "command",
        command: "node",
        args: [HOOK_RUNNER.script, "http://127.0.0.1:4319/hook", "2"],
    });
    assert.equal(HOOK_RUNNER.script, join(PROJECT_DIR, "bin", "post-hook.js"));
});

const settingsWith = (groups: (name: string) => unknown) => ({
    hooks: Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, groups(name)])),
});

test("an entry counts when a group's hooks list runs Izbor's hook; other keys, other tools and a matcher do not matter", () => {
    const izbor = { ...ENTRY_5123, timeout: 5 };
    const other = { type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" };
    const settings = settingsWith((name) => [
        { hooks: [other] },
        { matcher: name === "PreToolUse" ? "Bash" : "", hooks: [other, izbor] },
    ]);
    assert.deepEqual(missingIzborHooks({ permissions: { allow: [] }, ...settings }, 5123), []);
    assert.deepEqual(missingIzborHooks(settings, 4319), HOOK_EVENT_NAMES, "another port's entry is no entry");
});

test("a hook is missing when its list holds no group running Izbor's hook as a command hook; text that is not JSON has none", () => {
    const entry = ENTRY_5123;
    const [script, url, limit] = entry.args;
    const shapes: Record<string, unknown> = {
        SessionStart: [{ hooks: [entry] }],
        UserPromptSubmit: { hooks: [entry] },
        PreToolUse: [{ hooks: entry }],
        PostToolUse: [entry],
        PostToolUseFailure: [{ hooks: [{ ...entry, type: "prompt" }] }],
        PostToolBatch: [{ hooks: [{ ...entry, args: [script, ` ${url}`, limit] }] }],
        SubagentStart: [null, "x", { hooks: [null, entry] }],
    };
    assert.deepEqual(missingIzborHooks({ hooks: shapes }, 5123), [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "PostToolBatch",
        "SubagentStop",
        "Stop",
        "StopFailure",
        "SessionEnd",
        "PermissionRequest",
        "PermissionDenied",
        "Notification",
    ]);
    for (const settings of [null, [], "hooks", { hooks: [] }, { hooks: "x" }, { hooks: null }])
        assert.deepEqual(missingIzborHooks(settings, 5123), HOOK_EVENT_NAMES, JSON.stringify(settings));
    assert.equal(hasIzborHooks(JSON.stringify(settingsWith(() => shapes.SessionStart)), 5123), true);
    assert.equal(hasIzborHooks("{ not json", 5123), false);
});

function merged(text: string | null, port: number): string {
    const result = mergeIzborHooks(text, port, HOOK_RUNNER);
    assert.ok("text" in result, JSON.stringify(result));
    return result.text;
}

const fileOf = (settings: unknown) => `${JSON.stringify(settings, null, 2)}\n`;

test("no file: the whole file, Izbor's 14 hooks in their order, 2-space indentation and a trailing newline", () => {
    const text = merged(null, 4319);
    const settings = JSON.parse(text);
    assert.equal(text, fileOf(settings));
    assert.deepEqual(Object.keys(settings), ["hooks"]);
    assert.deepEqual(Object.keys(settings.hooks), HOOK_EVENT_NAMES);
    for (const name of HOOK_EVENT_NAMES) assert.deepEqual(settings.hooks[name], [{ hooks: [ENTRY_4319] }], name);
    assert.equal(hasIzborHooks(text, 4319), true);
});

const GLASS = { type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" };

test("an existing file keeps every other key and entry in its place; Izbor's Stop entry comes after another tool's", () => {
    const before = {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: { Stop: [{ matcher: "", hooks: [GLASS] }], Custom: [{ hooks: [GLASS] }] },
        env: { FOO: "1" },
    };
    const after = JSON.parse(merged(JSON.stringify(before), 4319));
    assert.deepEqual(Object.keys(after), ["permissions", "hooks", "env"]);
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(after.env, before.env);
    const izbor = { hooks: [ENTRY_4319] };
    assert.deepEqual(after.hooks.Stop, [{ matcher: "", hooks: [GLASS] }, izbor]);
    assert.deepEqual(after.hooks.Custom, before.hooks.Custom);
    assert.deepEqual(Object.keys(after.hooks), [
        "Stop",
        "Custom",
        ...HOOK_EVENT_NAMES.filter((name) => name !== "Stop"),
    ]);
});

test("a missing hooks key comes after the other keys", () => {
    const after = JSON.parse(merged(`{ "permissions": {}, "env": {} }`, 4319));
    assert.deepEqual(Object.keys(after), ["permissions", "env", "hooks"]);
});

test("its own result, merged again, is already: no new text", () => {
    const once = merged(JSON.stringify({ permissions: {}, hooks: { Stop: [{ hooks: [GLASS] }] } }), 4319);
    assert.deepEqual(mergeIzborHooks(once, 4319, HOOK_RUNNER), { already: true });
    assert.deepEqual(mergeIzborHooks(merged(null, 5123), 5123, HOOK_RUNNER), { already: true });
});

test("13 of 14 hooks with Izbor's entry: only the missing one is added, the 13 lists stay as they were", () => {
    const lists = [{ hooks: [GLASS] }, { hooks: [ENTRY_4319] }];
    const before = { hooks: Object.fromEntries(HOOK_EVENT_NAMES.slice(0, 13).map((name) => [name, lists])) };
    const after = JSON.parse(merged(JSON.stringify(before), 4319));
    assert.deepEqual(after.hooks, { ...before.hooks, Notification: [{ hooks: [ENTRY_4319] }] });
});

test("Izbor's 4319 entries and port 5123: the 4319 entries stay, 5123 entries are appended", () => {
    const after = JSON.parse(merged(merged(null, 4319), 5123));
    for (const name of HOOK_EVENT_NAMES)
        assert.deepEqual(after.hooks[name], [{ hooks: [ENTRY_4319] }, { hooks: [ENTRY_5123] }], name);
});

const REFUSALS: [string, string][] = [
    ["{ hooks", "is not valid JSON"],
    ["", "is not valid JSON"],
    ['// mine\n{ "hooks": {} }', "is not valid JSON"],
    ['{ "hooks": [] }', 'has "hooks" that is not an object'],
    ['{ "hooks": "x" }', 'has "hooks" that is not an object'],
    ['{ "hooks": null }', 'has "hooks" that is not an object'],
    ["[]", "is not a JSON object"],
    ["null", "is not a JSON object"],
    ['"x"', "is not a JSON object"],
    ['{ "hooks": { "Stop": {} } }', 'has "hooks.Stop" that is not a list'],
    ['{ "hooks": { "Notification": "x" } }', 'has "hooks.Notification" that is not a list'],
];

test("a file it cannot read as settings is refused with why, and nothing is merged", () => {
    for (const [text, refused] of REFUSALS)
        assert.deepEqual(mergeIzborHooks(text, 4319, HOOK_RUNNER), { refused }, text);
});

test("another tool's hook that is not a list is not Izbor's to refuse", () => {
    const after = JSON.parse(merged('{ "hooks": { "Custom": {} } }', 4319));
    assert.deepEqual(after.hooks.Custom, {});
});

function removed(text: string | null, port: number): unknown {
    const result = removeIzborHooks(text, port);
    assert.ok("text" in result, JSON.stringify(result));
    assert.ok(result.text.endsWith("}\n"), "2-space JSON and a trailing newline");
    return JSON.parse(result.text);
}

test("remove: a mixed file loses only Izbor's entries for the port; other keys, other tools, other events and their order stay", () => {
    const izbor = ENTRY_4319;
    const before = {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
            Stop: [{ hooks: [GLASS] }, { hooks: [izbor] }],
            Custom: [{ hooks: [izbor] }],
            Notification: [{ hooks: [izbor] }, { hooks: [GLASS] }],
            PreToolUse: [{ hooks: [{ ...ENTRY_4319, type: "prompt" }] }],
        },
        env: { FOO: "1" },
    };
    const after = removed(JSON.stringify(before), 4319) as typeof before;
    assert.deepEqual(after, {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
            Stop: [{ hooks: [GLASS] }],
            Custom: [{ hooks: [izbor] }],
            Notification: [{ hooks: [GLASS] }],
            PreToolUse: [{ hooks: [{ ...ENTRY_4319, type: "prompt" }] }],
        },
        env: { FOO: "1" },
    });
    assert.deepEqual(Object.keys(after), ["permissions", "hooks", "env"]);
    assert.deepEqual(Object.keys(after.hooks), ["Stop", "Custom", "Notification", "PreToolUse"]);
});

test("remove: a group holding Izbor's entry and another command keeps the other one; Izbor's entry with a timeout goes too", () => {
    const before = { hooks: { Stop: [{ hooks: [GLASS, { ...ENTRY_4319, timeout: 5 }, GLASS] }] } };
    assert.deepEqual(removed(JSON.stringify(before), 4319), { hooks: { Stop: [{ hooks: [GLASS, GLASS] }] } });
});

test("remove: a group with a matcher is kept, with its matcher, even when Izbor's entry was its only hook", () => {
    const izbor = ENTRY_4319;
    const before = {
        hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [GLASS, izbor] }],
            PostToolUse: [{ matcher: "Edit", hooks: [izbor] }],
        },
    };
    assert.deepEqual(removed(JSON.stringify(before), 4319), {
        hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [GLASS] }],
            PostToolUse: [{ matcher: "Edit", hooks: [] }],
        },
    });
});

test("remove: with 4319 and 5123 entries, removing 5123 keeps 4319's, byte for byte", () => {
    const only4319 = merged(null, 4319);
    const both = merged(only4319, 5123);
    assert.deepEqual(removeIzborHooks(both, 5123), { text: only4319 });
    assert.deepEqual(removeIzborHooks(only4319, 5123), { none: true });
});

test("remove: nothing to remove is none, and no text", () => {
    for (const text of [null, "{}", '{ "hooks": {} }', fileOf({ hooks: { Stop: [{ hooks: [GLASS] }] } })])
        assert.deepEqual(removeIzborHooks(text, 4319), { none: true }, String(text));
});

test("remove refuses what the merge refuses, with the same words", () => {
    for (const [text, refused] of REFUSALS) assert.deepEqual(removeIzborHooks(text, 4319), { refused }, text);
});

test("add, then remove, gives the original back over the merge tests' files, byte for byte; only an empty hooks object goes", () => {
    const originals: [unknown, number][] = [
        [
            {
                permissions: { allow: ["Bash(npm test)"] },
                hooks: { Stop: [{ matcher: "", hooks: [GLASS] }], Custom: [{ hooks: [GLASS] }] },
                env: { FOO: "1" },
            },
            4319,
        ],
        [{ permissions: {}, env: {} }, 4319],
        [{ permissions: {}, hooks: { Stop: [{ hooks: [GLASS] }] } }, 4319],
        [{ hooks: { Custom: {} } }, 4319],
        [{}, 4319],
        [JSON.parse(merged(null, 4319)), 5123],
    ];
    for (const [settings, port] of originals) {
        const text = fileOf(settings);
        assert.deepEqual(removeIzborHooks(merged(text, port), port), { text }, text);
    }
    assert.deepEqual(removeIzborHooks(merged('{ "hooks": {} }', 4319), 4319), { text: "{}\n" });
    assert.deepEqual(removeIzborHooks(merged(null, 4319), 4319), { text: "{}\n" }, "no file comes back as {}");
});

test("the round trip's two limits: an empty list of Izbor's hooks goes, and so does an entry of Izbor's that was there before", () => {
    assert.deepEqual(removed(merged(fileOf({ hooks: { Custom: [], Stop: [] } }), 4319), 4319), {
        hooks: { Custom: [] },
    });
    const lists = [{ hooks: [GLASS] }, { hooks: [ENTRY_4319] }];
    const before = { hooks: Object.fromEntries(HOOK_EVENT_NAMES.slice(0, 13).map((name) => [name, lists])) };
    assert.deepEqual(removed(merged(JSON.stringify(before), 4319), 4319), {
        hooks: Object.fromEntries(HOOK_EVENT_NAMES.slice(0, 13).map((name) => [name, [{ hooks: [GLASS] }]])),
    });
});

const allWith = (entry: object) => settingsWith(() => [{ hooks: [entry] }]);

const ANSWER_4319 = answerHookEntry(HOOK_RUNNER, 4319);
const CURL_EVENT_4319 = { type: "command", command: CURL_4319 };
const CURL_ANSWER_4319 = {
    type: "command",
    command:
        "curl -sf --connect-timeout 1 -m 3630 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4319/hook/answer || true",
    timeout: 3660,
};

test("isIzborHook knows Izbor's hook by its address: a curl line, the entry, another node or another script are it; another port, the answer hook's address, a lookalike, another tool's or a prompt hook are not", () => {
    const url = "http://127.0.0.1:4319/hook";
    const its = [
        CURL_EVENT_4319,
        { type: "command", command: ` ${CURL_4319}` },
        ENTRY_4319,
        { ...ENTRY_4319, timeout: 5 },
        { ...ENTRY_4319, command: "/opt/homebrew/opt/node@22/bin/node" },
        { ...ENTRY_4319, args: ["/Users/me/old-izbor/bin/post-hook.js", url, "2"] },
    ];
    for (const entry of its) assert.equal(isIzborHook(entry, url), true, JSON.stringify(entry));
    const not = [
        ENTRY_5123,
        { type: "command", command: CURL_4319.replace("4319", "5123") },
        ANSWER_4319,
        CURL_ANSWER_4319,
        { type: "command", command: "curl http://127.0.0.1:4319/hooks" },
        { ...ENTRY_4319, args: [HOOK_RUNNER.script, `${url}/`, "2"] },
        GLASS,
        { ...ENTRY_4319, type: "prompt" },
        null,
        "x",
    ];
    for (const entry of not) assert.equal(isIzborHook(entry, url), false, JSON.stringify(entry));
});

test("has hooks counts a curl line of any age, and an entry only while its script is on disk: a moved checkout's has none", () => {
    assert.deepEqual(missingIzborHooks(allWith(CURL_EVENT_4319), 4319), []);
    assert.deepEqual(missingIzborHooks(allWith({ type: "command", command: ` ${CURL_4319}` }), 4319), []);
    assert.deepEqual(missingIzborHooks(allWith(ENTRY_4319), 4319), []);
    const moved = {
        ...ENTRY_4319,
        args: [join(tmpdir(), "no-such-izbor", "bin", "post-hook.js"), ...ENTRY_4319.args.slice(1)],
    };
    assert.deepEqual(missingIzborHooks(allWith(moved), 4319), HOOK_EVENT_NAMES);
    assert.equal(hasIzborHooks(fileOf(allWith(moved)), 4319), false);
});

test("merge brings every older Izbor entry up to date in place, a curl line, another node or a moved checkout's script, and adds none beside it", () => {
    const older = [
        CURL_EVENT_4319,
        { type: "command", command: ` ${CURL_4319}` },
        { ...ENTRY_4319, command: "/usr/local/bin/node" },
        { ...ENTRY_4319, args: ["/Users/me/old-izbor/bin/post-hook.js", ...ENTRY_4319.args.slice(1)] },
        { ...ENTRY_4319, timeout: 5 },
    ];
    const inGroup = (entry: object) => settingsWith(() => [{ matcher: "", hooks: [GLASS, entry, GLASS] }]);
    for (const entry of older) {
        const after = JSON.parse(merged(fileOf({ env: {}, ...inGroup(entry) }), 4319));
        assert.deepEqual(after, { env: {}, ...inGroup(ENTRY_4319) }, JSON.stringify(entry));
    }
    const twice = settingsWith(() => [{ hooks: [CURL_EVENT_4319] }, { hooks: [GLASS, CURL_EVENT_4319] }]);
    assert.deepEqual(
        JSON.parse(merged(fileOf(twice), 4319)),
        settingsWith(() => [{ hooks: [ENTRY_4319] }, { hooks: [GLASS] }]),
    );
    const other = { type: "command", command: CURL_4319.replace("4319", "5123") };
    assert.deepEqual(
        JSON.parse(merged(fileOf(allWith(other)), 4319)),
        settingsWith(() => [{ hooks: [other] }, { hooks: [ENTRY_4319] }]),
    );
});

test("merge leaves one Izbor entry in a hook that holds two, today's entry and a curl line, or two curl lines, and merges to already after", () => {
    const lists = [
        [{ hooks: [ENTRY_4319] }, { hooks: [CURL_EVENT_4319] }],
        [{ hooks: [CURL_EVENT_4319, ENTRY_4319] }],
        [{ hooks: [CURL_EVENT_4319] }, { hooks: [{ type: "command", command: ` ${CURL_4319}` }] }],
        [{ matcher: "", hooks: [CURL_EVENT_4319, GLASS] }, { hooks: [CURL_EVENT_4319] }],
    ];
    const once = [
        [{ hooks: [ENTRY_4319] }],
        [{ hooks: [ENTRY_4319] }],
        [{ hooks: [ENTRY_4319] }],
        [{ matcher: "", hooks: [ENTRY_4319, GLASS] }],
    ];
    lists.forEach((list, i) => {
        const after = merged(fileOf(settingsWith(() => list)), 4319);
        assert.deepEqual(
            JSON.parse(after),
            settingsWith(() => once[i]),
            JSON.stringify(list),
        );
        assert.deepEqual(mergeIzborHooks(after, 4319, HOOK_RUNNER), { already: true });
    });
});

test("Izbor's event hook and answer hook in one PermissionRequest group, of either age: each merge and remove changes only its own", () => {
    for (const [event, answer] of [
        [ENTRY_4319, ANSWER_4319],
        [CURL_EVENT_4319, CURL_ANSWER_4319],
    ] as const) {
        const text = fileOf({ hooks: { PermissionRequest: [{ hooks: [event, answer] }] } });
        const what = JSON.stringify(event);
        assert.deepEqual(removed(text, 4319), { hooks: { PermissionRequest: [{ hooks: [answer] }] } }, what);
        const noAnswer = removeAnswerHook(text, 4319);
        assert.deepEqual("text" in noAnswer && JSON.parse(noAnswer.text), {
            hooks: { PermissionRequest: [{ hooks: [event] }] },
        });
        const events = JSON.parse(merged(text, 4319));
        assert.deepEqual(events.hooks.PermissionRequest, [{ hooks: [ENTRY_4319, answer] }], what);
        const answers = mergeAnswerHook(text, 4319, HOOK_RUNNER);
        assert.deepEqual(
            "text" in answers ? JSON.parse(answers.text).hooks.PermissionRequest : answers,
            event === ENTRY_4319 ? { done: "already" } : [{ hooks: [event, ANSWER_4319] }],
            what,
        );
    }
});

async function tempTree(t: TestContext) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "izbor-hooks-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

async function snapshot(root: string) {
    const paths = (await readdir(root, { recursive: true })).sort();
    return Promise.all(
        paths.map(async (path) => {
            const file = join(root, path);
            const stats = await lstat(file);
            return { path, mode: stats.mode, bytes: stats.isFile() ? await readFile(file, "utf8") : null };
        }),
    );
}

const projectIn = (home: string) => ({
    changeHooks: (request: HooksRequest) =>
        changeIzborHooks({
            ...request,
            home,
            platform: { ...hostPlatform(), ...OWNS_FILES_BY_UID },
            runner: HOOK_RUNNER,
        }),
    isActing: (cwd: string, port: number) => answerHookAt(cwd, port, OWNS_FILES_BY_UID),
});

const hooks = (folder: string, home: string) =>
    runHooks({ command: "hooks", port: 4319, folder, remove: false }, { home, ...projectIn(home) });

const HOME_REFUSAL = "izbor hooks needs a project folder, not your home folder.";

const tilde = (...parts: string[]) => join("~", ...parts);

const added = (...settings: string[]) =>
    `Izbor's hooks are in ${tilde(...settings)}. Sessions there, running ones too, post to Izbor from their next hook.`;

const NEEDS_LINKS = skipOnWindows("Windows: links need Developer Mode");
const NEEDS_MODES = skipOnWindows("Windows has no POSIX file modes");

test("izbor hooks refuses /, the home folder and a folder whose checkout is the home folder, and creates nothing", async (t) => {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    await mkdir(join(home, ".git"), { recursive: true });
    await mkdir(join(home, "Downloads"));
    const before = await snapshot(tmp);
    for (const folder of ["/", home, join(home, "Downloads")])
        assert.deepEqual(await hooks(folder, home), { lines: [HOME_REFUSAL], code: 1 }, folder);
    assert.deepEqual(await snapshot(tmp), before);
});

test("izbor hooks refuses the root of the drive the temp folder is on, as it refuses /, and creates nothing there", async (t) => {
    const tmp = await tempTree(t);
    const root = parse(tmp).root;
    const before = await readdir(root);
    assert.deepEqual(await hooks(root, join(tmp, "home")), { lines: [HOME_REFUSAL], code: 1 }, root);
    assert.deepEqual(await readdir(root), before);
});

test("izbor hooks refuses the home folder by a link to it, and creates nothing", NEEDS_LINKS, async (t) => {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    await mkdir(join(home, ".git"), { recursive: true });
    await symlink(home, join(tmp, "home-link"));
    const before = await snapshot(tmp);
    assert.deepEqual(await hooks(join(tmp, "home-link"), home), { lines: [HOME_REFUSAL], code: 1 });
    assert.deepEqual(await snapshot(tmp), before);
});

test("a folder izbor hooks cannot look at, such as a loop of links, is no folder", NEEDS_LINKS, async (t) => {
    const tmp = await tempTree(t);
    await symlink(join(tmp, "b"), join(tmp, "a"));
    await symlink(join(tmp, "a"), join(tmp, "b"));
    const home = join(tmp, "home");
    assert.deepEqual(await hooks(join(tmp, "a"), home), {
        lines: [`No folder ${join(tmp, "a")}.`],
        code: 1,
    });
});

const DATA_VOLUME = "/System/Volumes/Data";

test(
    "the home folder by its data-volume path is still the home folder",
    { skip: !existsSync(join(DATA_VOLUME, realpathSync(tmpdir()))) && `no ${DATA_VOLUME} here` },
    async (t) => {
        const home = join(await tempTree(t), "home");
        await mkdir(home);
        const folder = join(DATA_VOLUME, home);
        assert.deepEqual(await hooks(folder, home), {
            lines: [HOME_REFUSAL],
            code: 1,
        });
        assert.deepEqual(await readdir(home), []);
    },
);

test("a subfolder of a checkout, as the first to run, writes the checkout's file and nothing under itself", async (t) => {
    const home = await tempTree(t);
    const project = join(home, "app");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(project, "src", "deep"), { recursive: true });
    assert.deepEqual(await hooks(join(project, "src", "deep"), home), {
        lines: [
            added("app", ".claude", "settings.local.json"),
            `Install the plugin if you want to answer sessions from Izbor: izbor plugin '${project}'.`,
        ],
        code: 0,
    });
    assert.equal(hasIzborHooks(await readFile(join(project, ".claude", "settings.local.json"), "utf8"), 4319), true);
    assert.deepEqual(await readdir(join(project, "src"), { recursive: true }), ["deep"]);
});

test("izbor hooks writes the file and names it with ~, and leaves no temp file", async (t) => {
    const home = await tempTree(t);
    const project = join(home, "code", "app");
    await mkdir(join(project, ".claude"), { recursive: true });
    const file = join(project, ".claude", "settings.local.json");
    await writeFile(file, '{ "permissions": {} }');

    assert.deepEqual(await hooks(project, home), {
        lines: [
            added("code", "app", ".claude", "settings.local.json"),
            `Install the plugin if you want to answer sessions from Izbor: izbor plugin '${project}'.`,
        ],
        code: 0,
    });
    assert.equal(hasIzborHooks(await readFile(file, "utf8"), 4319), true);
    assert.deepEqual(await readdir(join(project, ".claude")), ["settings.local.json"], "no temp file is left");
});

test("izbor hooks reads a settings file that starts with a byte order mark, and writes it back with none", async (t) => {
    const home = await tempTree(t);
    const project = join(home, "app");
    await mkdir(join(project, ".claude"), { recursive: true });
    const file = join(project, ".claude", "settings.local.json");
    await writeFile(file, '\uFEFF{ "permissions": {} }\r\n');

    assert.equal((await hooks(project, home)).code, 0);
    const text = await readFile(file, "utf8");
    assert.equal(text.startsWith("{"), true, "no byte order mark is written");
    assert.deepEqual(JSON.parse(text).permissions, {});
    assert.equal(hasIzborHooks(text, 4319), true);
});

test("izbor hooks leaves a file its mode, 600 or 664, whatever the umask", NEEDS_MODES, async (t) => {
    const home = await tempTree(t);
    for (const mode of [0o600, 0o664]) {
        const project = join(home, "code", `app-${mode.toString(8)}`);
        await mkdir(join(project, ".claude"), { recursive: true });
        const file = join(project, ".claude", "settings.local.json");
        await writeFile(file, '{ "permissions": {} }');
        await chmod(file, mode);

        assert.equal((await hooks(project, home)).code, 0);
        assert.equal((await stat(file)).mode & 0o777, mode);
        assert.equal(hasIzborHooks(await readFile(file, "utf8"), 4319), true);
    }
});

test("izbor hooks on a project with an older Izbor's curl lines replaces them in place and says what an add says", async (t) => {
    const home = await tempTree(t);
    const project = join(home, "app");
    await mkdir(join(project, ".claude"), { recursive: true });
    const file = join(project, ".claude", "settings.local.json");
    await writeFile(file, fileOf(allWith(CURL_EVENT_4319)));
    assert.deepEqual(await hooks(project, home), {
        lines: [
            added("app", ".claude", "settings.local.json"),
            `Install the plugin if you want to answer sessions from Izbor: izbor plugin '${project}'.`,
        ],
        code: 0,
    });
    assert.equal(await readFile(file, "utf8"), fileOf(allWith(ENTRY_4319)));
});

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Izbor Test", "-c", "user.email=izbor@example.com", ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
    });

test("a git worktree's checkout is its main checkout, as Claude Code reads settings; a .git file that fails a check keeps its own folder", async (t) => {
    const tmp = await tempTree(t);
    const repo = join(tmp, "repo");
    git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    git(repo, "worktree", "add", "-q", join(tmp, "wt"));
    git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "cw"));
    await mkdir(join(repo, "src"));
    await mkdir(join(tmp, "wt", "src"));
    await mkdir(join(tmp, "plain"));

    async function byHand(
        name: string,
        pointer: string,
        gitDir: string,
        files: { commondir?: string; gitdir?: string },
    ) {
        await mkdir(join(tmp, name));
        await writeFile(join(tmp, name, ".git"), `${pointer}\n`);
        await mkdir(gitDir, { recursive: true });
        for (const [file, text] of Object.entries(files)) await writeFile(join(gitDir, file), `${text}\n`);
    }
    const inRepo = (name: string) => join(repo, ".git", "worktrees", name);
    await byHand("relative", "gitdir: ../repo/.git/worktrees/relative", inRepo("relative"), {
        commondir: "../..",
        gitdir: "../../../../relative/.git",
    });
    await byHand("no-gitdir-word", "ref: refs/heads/main", inRepo("x"), {});
    await byHand("missing", `gitdir: ${join(tmp, "nowhere")}`, join(tmp, "unused"), {});
    await byHand("no-way-back", `gitdir: ${inRepo("no-way-back")}`, inRepo("no-way-back"), {
        commondir: "../..",
        gitdir: join(tmp, "elsewhere", ".git"),
    });
    await byHand(
        "not-in-worktrees",
        `gitdir: ${join(repo, ".git", "modules", "sub")}`,
        join(repo, ".git", "modules", "sub"),
        {
            commondir: "../..",
            gitdir: join(tmp, "not-in-worktrees", ".git"),
        },
    );
    await mkdir(join(tmp, "bare.git"));
    await byHand(
        "bare-wt",
        `gitdir: ${join(tmp, "bare.git", "worktrees", "bare-wt")}`,
        join(tmp, "bare.git", "worktrees", "bare-wt"),
        {
            commondir: "../..",
            gitdir: join(tmp, "bare-wt", ".git"),
        },
    );
    await mkdir(join(tmp, "bare-wt", "src"));
    const before = await snapshot(tmp);

    const folders = [
        "repo",
        "repo/src",
        "wt",
        "wt/src",
        "repo/.claude/worktrees/cw",
        "relative",
        "bare-wt",
        "bare-wt/src",
        "no-gitdir-word",
        "missing",
        "no-way-back",
        "not-in-worktrees",
        "plain",
    ];
    assert.deepEqual(
        Object.fromEntries(folders.map((folder) => [folder, checkoutOf(join(tmp, folder), OWNS_FILES_BY_UID)])),
        {
            repo: repo,
            "repo/src": repo,
            wt: repo,
            "wt/src": repo,
            "repo/.claude/worktrees/cw": repo,
            relative: repo,
            "bare-wt": join(tmp, "bare-wt"),
            "bare-wt/src": join(tmp, "bare-wt", "src"),
            "no-gitdir-word": join(tmp, "no-gitdir-word"),
            missing: join(tmp, "missing"),
            "no-way-back": join(tmp, "no-way-back"),
            "not-in-worktrees": join(tmp, "not-in-worktrees"),
            plain: join(tmp, "plain"),
        },
    );
    assert.deepEqual(await snapshot(tmp), before, "the look writes nothing");
});

test("a worktree whose commondir is a link fails the check and keeps its own folder", NEEDS_LINKS, async (t) => {
    const tmp = await tempTree(t);
    const repo = join(tmp, "repo");
    git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
    const gitDir = join(repo, ".git", "worktrees", "linked-commondir");
    await mkdir(join(tmp, "linked-commondir"));
    await writeFile(join(tmp, "linked-commondir", ".git"), `gitdir: ${gitDir}\n`);
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "gitdir"), `${join(tmp, "linked-commondir", ".git")}\n`);
    await writeFile(join(tmp, "commondir-text"), "../..\n");
    await symlink(join(tmp, "commondir-text"), join(gitDir, "commondir"));

    assert.equal(checkoutOf(join(tmp, "linked-commondir"), OWNS_FILES_BY_UID), join(tmp, "linked-commondir"));
});

test(
    "a worktree added by a path in another case still maps to its main checkout: Claude Code compares real paths",
    { skip: !existsSync(tmpdir().toUpperCase()) && "this file system minds case" },
    async (t) => {
        const tmp = await tempTree(t);
        const repo = join(tmp, "Proj", "repo");
        await mkdir(join(tmp, "Proj"));
        git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
        git(repo, "commit", "-q", "--allow-empty", "-m", "first");
        git(repo, "worktree", "add", "-q", join(tmp, "proj", "wt"));
        assert.equal(checkoutOf(join(tmp, "Proj", "wt"), OWNS_FILES_BY_UID), repo);
    },
);

test(
    "a .git that is neither a folder nor a file, a named pipe or a device, is passed over, as Claude Code does, and never read",
    skipOnWindows("Windows has no named pipes in the file system"),
    async (t) => {
        const tmp = await tempTree(t);
        await mkdir(join(tmp, "repo", ".git"), { recursive: true });
        await mkdir(join(tmp, "repo", "piped", "sub"), { recursive: true });
        execFileSync("mkfifo", [join(tmp, "repo", "piped", ".git")]);
        await mkdir(join(tmp, "repo", "device"));
        await symlink("/dev/null", join(tmp, "repo", "device", ".git"));
        await mkdir(join(tmp, "repo", ".claude"));
        execFileSync("mkfifo", [join(tmp, "repo", ".claude", "settings.local.json")]);
        const looked = execFileSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `import { izborHooksAt } from "./src/adapters/agents/claude/setup/izborHooks.ts";
            import { checkoutOf } from "./src/adapters/agents/claude/setup/projectFiles.ts";
            const [piped, device] = process.argv.slice(1);
            const ownsUid = { ownsFilesByUid: true };
            process.stdout.write(JSON.stringify([checkoutOf(piped, ownsUid), checkoutOf(device, ownsUid), izborHooksAt(piped, 4319, ownsUid)]));`,
                join(tmp, "repo", "piped", "sub"),
                join(tmp, "repo", "device"),
            ],
            { cwd: PROJECT_DIR, timeout: 10_000, encoding: "utf8" },
        );
        assert.deepEqual(JSON.parse(looked), [join(tmp, "repo"), join(tmp, "repo"), false]);
    },
);

const hooksProcess =
    (t: TestContext, home: string, port: number, dataDir: string) =>
    async (...args: string[]) => {
        const run = await runIzborBin(["hooks", ...args], {
            env: { ...homeEnv(home), IZBOR_PORT: String(port), IZBOR_DATA_DIR: dataDir },
        });
        t.after(() => Promise.all([run.cwd, run.home].map((dir) => rm(dir, { recursive: true, force: true }))));
        const hung = setTimeout(() => run.child.kill("SIGKILL"), 10_000);
        const [code] = await run.exited;
        clearTimeout(hung);
        return { code, stdout: run.output.stdout, stderr: run.output.stderr, cwd: await realpath(run.cwd) };
    };

const already = (file: string) => ({ code: 0, stdout: `${file} already has Izbor's hooks.\n`, stderr: "" });

const outcome = ({ code, stdout, stderr }: { code: number | null; stdout: string; stderr: string }) => ({
    code,
    stdout,
    stderr,
});

async function repoWithWorktree(t: TestContext) {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    await mkdir(home);
    const repo = join(tmp, "repo");
    const wt = join(tmp, "wt");
    git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    git(repo, "worktree", "add", "-q", wt);
    return { tmp, home, repo, wt };
}

test("izbor hooks as its own process: a repo, the current folder and every refusal", async (t) => {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    const userSettings = '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "izbor-hook" }] }] } }\n';
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), userSettings);
    const dataDir = join(tmp, "data");
    const repo = join(tmp, "repo");
    git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    const before = await snapshot(tmp);

    const port = await freePort();
    const hooks = hooksProcess(t, home, port, dataDir);
    const written = (file: string) => ({
        code: 0,
        stdout:
            `Izbor's hooks for port ${port} are in ${file}. Sessions there, running ones too, post to Izbor from their next hook.\n` +
            `Install the plugin if you want to answer sessions from Izbor: izbor plugin '${join(file, "..", "..")}' --port ${port}.\n`,
        stderr: "",
    });
    const refusal = (line: string) => ({ code: 1, stdout: "", stderr: `${line}\n` });

    const repoFile = join(repo, ".claude", "settings.local.json");
    assert.deepEqual(outcome(await hooks(repo)), written(repoFile));
    const repoBytes = await readFile(repoFile, "utf8");
    assert.equal(hasIzborHooks(repoBytes, port), true);
    assert.deepEqual(outcome(await hooks(repo)), already(repoFile));
    assert.equal(await readFile(repoFile, "utf8"), repoBytes);

    const here = await hooks();
    assert.deepEqual(outcome(here), written(join(here.cwd, ".claude", "settings.local.json")));
    assert.deepEqual((await readdir(here.cwd, { recursive: true })).sort(), [".claude", ".claude/settings.local.json"]);

    assert.deepEqual(outcome(await hooks(home)), refusal(HOME_REFUSAL));
    assert.deepEqual(outcome(await hooks(join(tmp, "missing"))), refusal(`No folder ${join(tmp, "missing")}.`));

    const after = await snapshot(tmp);
    const wrote = ["repo/.claude", "repo/.claude/settings.local.json"];
    assert.deepEqual(
        after.filter(({ path }) => !wrote.includes(path)),
        before,
    );
    assert.deepEqual(
        after
            .filter(({ path }) => wrote.includes(path))
            .map(({ path }) => path)
            .sort(),
        wrote.sort(),
    );
    assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), userSettings);
    assert.equal(existsSync(dataDir), false);
    assert.deepEqual(await createIzborClient({ port }).getIzbor(), { away: "not running" });
});

async function noUidProject(t: TestContext) {
    const { tmp, home, repo, wt } = await repoWithWorktree(t);
    const sub = join(repo, "sub");
    await mkdir(sub);
    const ok = { outcome: "exited", code: 0, signal: null, stdout: '{"outcome":"ok"}\n', stderr: "" } as const;
    const platform = fakePlatform({ ownsFilesByUid: false, runs: { claude: ok } });
    const project = createClaudeProject({
        platform,
        home,
        pluginDir: IZBOR_PLUGIN_DIR,
        hookRunner: HOOK_RUNNER,
    });
    return { tmp, home, repo, sub, wt, platform, project };
}

test("on an OS with no owner uids, izbor hooks and izbor plugin on a subfolder of a git repo write the subfolder's own settings file, not the root's", async (t) => {
    const { home, repo, sub, platform, project } = await noUidProject(t);
    const args = { port: 4319, folder: sub, remove: false } as const;
    assert.equal((await runHooks({ command: "hooks", ...args }, { home, ...project })).code, 0);
    assert.equal((await runPlugin({ command: "plugin", ...args }, { home, ...project })).code, 0);

    const file = join(sub, ".claude", "settings.local.json");
    const text = await readFile(file, "utf8");
    assert.equal(hasIzborHooks(text, 4319), true);
    assert.equal(answerHookAt(sub, 4319, platform), true);
    assert.equal(existsSync(join(repo, ".claude")), false, "nothing at the git root");
    assert.deepEqual(
        platform.ran.map(({ options }) => options.cwd),
        [sub, sub],
        "claude plugin runs in the subfolder",
    );
});

test("on an OS with no owner uids, a session in a subfolder or a linked worktree reads its own folder's settings: the git root's do not count for it", async (t) => {
    const { repo, sub, wt, platform } = await noUidProject(t);
    const all = fileOf(allWith(ENTRY_4319));
    const withAnswer = (text: string) => {
        const merged = mergeAnswerHook(text, 4319, HOOK_RUNNER);
        assert.ok("text" in merged);
        return merged.text;
    };
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.local.json"), withAnswer(all));

    for (const cwd of [sub, wt]) {
        assert.equal(checkoutOf(cwd, platform), cwd);
        assert.equal(checkoutOf(join(cwd, "."), platform), cwd, "resolved");
        assert.deepEqual([izborHooksAt(cwd, 4319, platform), answerHookAt(cwd, 4319, platform)], [false, false]);
    }
    assert.deepEqual([izborHooksAt(repo, 4319, platform), answerHookAt(repo, 4319, platform)], [true, true]);

    await mkdir(join(wt, ".claude"));
    await writeFile(join(wt, ".claude", "settings.local.json"), withAnswer(all));
    assert.deepEqual([izborHooksAt(wt, 4319, platform), answerHookAt(wt, 4319, platform)], [true, true]);
    assert.deepEqual([izborHooksAt(sub, 4319, platform), answerHookAt(sub, 4319, platform)], [false, false]);
});

const hooksIn =
    (home: string, port = 4319) =>
    (...args: string[]) =>
        runHooks(
            {
                command: "hooks",
                port,
                folder: args.find((arg) => arg !== "--remove"),
                remove: args.includes("--remove"),
            },
            { home, ...projectIn(home) },
        );

test(
    "izbor hooks refuses a linked settings file, a linked .claude and a named pipe, and each link's target stays",
    skipOnWindows("Windows: links need Developer Mode, and Windows has no named pipes in the file system"),
    async (t) => {
        const tmp = await tempTree(t);
        const home = join(tmp, "home");
        await mkdir(home);
        const target = join(tmp, "target");
        await mkdir(target);
        await writeFile(join(target, "settings.local.json"), "{}\n");
        const linkedFile = join(tmp, "linked-file");
        await mkdir(join(linkedFile, ".claude"), { recursive: true });
        await symlink(join(target, "settings.local.json"), join(linkedFile, ".claude", "settings.local.json"));
        const linkedDir = join(tmp, "linked-dir");
        await mkdir(linkedDir);
        await symlink(target, join(linkedDir, ".claude"));
        const piped = join(tmp, "piped");
        await mkdir(join(piped, ".claude"), { recursive: true });
        execFileSync("mkfifo", [join(piped, ".claude", "settings.local.json")]);
        const before = await snapshot(tmp);
        const hooks = hooksIn(home);
        const refusal = (line: string) => ({ lines: [line], code: 1 });

        assert.deepEqual(
            await hooks(linkedFile),
            refusal(`${join(linkedFile, ".claude", "settings.local.json")} is a link; Izbor changed nothing.`),
        );
        assert.deepEqual(
            await hooks(linkedDir),
            refusal(`${join(linkedDir, ".claude")} is a link; Izbor changed nothing.`),
        );
        assert.deepEqual(
            await hooks(piped),
            refusal(`Izbor could not write ${join(piped, ".claude", "settings.local.json")}: it is not a file`),
        );
        assert.deepEqual(await snapshot(tmp), before);
    },
);

test("seam 4: izbor hooks <folder> prints the setup offer as its second line, word for word, once it has added the hooks; not when they were there, not on --remove, and not when the project acts already", async (t) => {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    await mkdir(join(home, "code"), { recursive: true });
    const repo = join(home, "code", "my-app");
    git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
    const file = join(repo, ".claude", "settings.local.json");
    const hooks = hooksIn(home);
    const ADDED = added("code", "my-app", ".claude", "settings.local.json");

    assert.deepEqual(await hooks(repo), {
        lines: [ADDED, `Install the plugin if you want to answer sessions from Izbor: izbor plugin '${repo}'.`],
        code: 0,
    });
    assert.deepEqual(await hooks(repo), {
        lines: [`${tilde("code", "my-app", ".claude", "settings.local.json")} already has Izbor's hooks.`],
        code: 0,
    });
    const removed = await hooks("--remove", repo);
    assert.equal(removed.code, 0);
    assert.doesNotMatch(removed.lines.join("\n"), /Install the plugin/);
    assert.equal(removed.lines.length, 1);

    const acting = mergeAnswerHook(await readFile(file, "utf8"), 4319, HOOK_RUNNER);
    assert.ok("text" in acting);
    await writeFile(file, acting.text);
    assert.deepEqual(await hooks(repo), { lines: [ADDED], code: 0 });
});

test(
    "izbor hooks, then izbor hooks --remove: the seed comes back, byte for byte, and its mode",
    skipOnWindows("Windows has no POSIX file modes, and links need Developer Mode"),
    async (t) => {
        const tmp = await tempTree(t);
        const home = join(tmp, "home");
        const homeSettings =
            '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "izbor-hook" }] }] } }\n';
        await mkdir(join(home, ".claude"), { recursive: true });
        await writeFile(join(home, ".claude", "settings.json"), homeSettings);
        const repo = join(tmp, "repo");
        git(tmp, "-c", "init.defaultBranch=main", "init", "-q", repo);
        await mkdir(join(repo, ".claude"));
        const file = join(repo, ".claude", "settings.local.json");
        const seed = fileOf({
            permissions: { allow: ["Bash(npm test)"] },
            hooks: { Stop: [{ matcher: "", hooks: [GLASS] }] },
        });
        await writeFile(file, seed);
        await chmod(file, 0o600);
        await writeFile(join(tmp, "broken.json"), "{ hooks");

        const port = 5123;
        const hooks = hooksIn(home, port);
        const refusal = (line: string) => ({ lines: [line], code: 1 });

        assert.equal((await hooks(repo)).code, 0);
        assert.equal(hasIzborHooks(await readFile(file, "utf8"), port), true);
        assert.deepEqual(await hooks("--remove", repo), {
            lines: [
                `Removed Izbor's hooks for port ${port} from ${file}. Sessions there, running ones too, stop posting to Izbor from their next hook.`,
            ],
            code: 0,
        });
        assert.equal(await readFile(file, "utf8"), seed);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.deepEqual(await hooks(repo, "--remove"), {
            lines: [`${file} has no Izbor hooks for port ${port}.`],
            code: 0,
        });
        assert.equal(await readFile(file, "utf8"), seed);

        assert.deepEqual(await hooks("--remove", home), refusal(HOME_REFUSAL));
        const linked = join(tmp, "linked");
        await mkdir(join(linked, ".claude"), { recursive: true });
        await symlink(join(tmp, "broken.json"), join(linked, ".claude", "settings.local.json"));
        assert.deepEqual(
            await hooks("--remove", linked),
            refusal(`${join(linked, ".claude", "settings.local.json")} is a link; Izbor changed nothing.`),
        );
        const broken = join(tmp, "broken");
        await mkdir(join(broken, ".claude"), { recursive: true });
        await writeFile(join(broken, ".claude", "settings.local.json"), "{ hooks");
        assert.deepEqual(
            await hooks("--remove", broken),
            refusal(`${join(broken, ".claude", "settings.local.json")} is not valid JSON; Izbor changed nothing.`),
        );

        assert.deepEqual(await readdir(join(repo, ".claude")), ["settings.local.json"], "no temp file is left");
        assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), homeSettings);
        assert.equal(await readFile(join(tmp, "broken.json"), "utf8"), "{ hooks");
    },
);

test("a folder Izbor may not look inside is refused, not thrown: the app stays up", NEEDS_MODES, async (t) => {
    const tmp = await tempTree(t);
    const home = join(tmp, "home");
    const locked = join(tmp, "locked");
    const folder = join(locked, "app");
    await mkdir(folder, { recursive: true });
    await chmod(locked, 0o600);
    const platform = hostPlatform();
    try {
        const result = changeIzborHooks({
            change: "add",
            folder: locked,
            port: 4319,
            home,
            platform,
            runner: HOOK_RUNNER,
        });
        assert.equal("refused" in result && result.refused, "no access", JSON.stringify(result));
        const report = await hooks(locked, home);
        assert.equal(report.code, 1);
        assert.match(report.lines[0]!, new RegExp(`^Izbor may not look in ${locked}: EACCES`));
        assert.deepEqual(
            changeIzborHooks({ change: "remove", folder, port: 4319, home, platform, runner: HOOK_RUNNER }),
            {
                refused: "no folder",
                folder,
            },
        );
    } finally {
        await chmod(locked, 0o755);
    }
});

const claude = () =>
    createClaudeProvider({
        platform: hostPlatform(),
        home: "/Users/me",
        pluginDir: "/Users/me/izbor/plugin",
        hookRunner: HOOK_RUNNER,
    });

const COMMON = {
    session_id: SESSION,
    transcript_path: `/Users/me/.claude/projects/-repo/${SESSION}.jsonl`,
    cwd: "/repo",
    permission_mode: "default",
};

const AT = RECEIVED_AT.toISOString();

test("readHook reads a tool hook: its folder, what it says to the brief and the payload as it arrived; it is no event hook and ends nothing", () => {
    const payload = {
        ...COMMON,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_use_id: "toolu_01",
    };

    assert.deepEqual(claude().readHook(JSON.stringify(payload), RECEIVED_AT), {
        sessionId: SESSION,
        sessionOver: false,
        cwd: "/repo",
        ended: false,
        event: null,
        evidence: { at: AT, agentId: null, action: "started Bash: npm test" },
        record: { kind: "hook", sessionId: SESSION, timestamp: AT, payload },
    });
});

test("readHook reads SessionEnd as the session being over, and as a hook the final reply can come late after", () => {
    const payload = { ...COMMON, hook_event_name: "SessionEnd", reason: "prompt_input_exit" };

    assert.deepEqual(claude().readHook(JSON.stringify(payload), RECEIVED_AT), {
        sessionId: SESSION,
        sessionOver: true,
        cwd: "/repo",
        ended: true,
        event: null,
        evidence: { at: AT, agentId: null, action: "session ended: prompt_input_exit", ends: "all" },
        record: { kind: "hook", sessionId: SESSION, timestamp: AT, payload },
    });
});

test("readHook gives a session id in upper case in lower case, in the hook, its record and its event record; the payload stays as it arrived", () => {
    const payload = {
        ...COMMON,
        session_id: SESSION.toUpperCase(),
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
    };

    assert.deepEqual(claude().readHook(JSON.stringify(payload), RECEIVED_AT), {
        sessionId: SESSION,
        sessionOver: false,
        cwd: "/repo",
        ended: false,
        event: {
            kind: "event",
            sessionId: SESSION,
            agentId: null,
            timestamp: AT,
            event: "permission_request",
            toolCallId: undefined,
            name: "Bash",
            rawInput: { command: "npm test" },
        },
        evidence: {
            at: AT,
            agentId: null,
            action: "asked permission for Bash: npm test",
            request: { agentId: null, tool: "Bash", input: { command: "npm test" } },
        },
        record: { kind: "hook", sessionId: SESSION, timestamp: AT, payload },
    });
});

test("readHook gives undefined for a body that is not JSON, and never throws", () => {
    for (const body of ["", "not json", '{"session_id":', "null", "7", '"text"', "[]"])
        assert.equal(claude().readHook(body, RECEIVED_AT), undefined, body);
});

test("readHook gives undefined for a payload with no session_id, or with one that is no session id", () => {
    for (const payload of [
        { hook_event_name: "Stop", cwd: "/repo" },
        { ...COMMON, session_id: 7 },
        { ...COMMON, session_id: "../../etc/passwd" },
        { ...COMMON, session_id: `${SESSION}0` },
    ])
        assert.equal(claude().readHook(JSON.stringify(payload), RECEIVED_AT), undefined, JSON.stringify(payload));
});

test("readHook reads a background task whose description is no text as unnamed, and never throws", () => {
    const payload = { ...COMMON, hook_event_name: "Stop", background_tasks: [{ description: 5 }, null, "odd"] };

    assert.deepEqual(claude().readHook(JSON.stringify(payload), RECEIVED_AT)?.evidence, {
        at: AT,
        agentId: null,
        action: "reply finished (3 background tasks still running: unnamed, unnamed, unnamed)",
        replyFinished: true,
        ends: "all",
    });
});

test("readHook reads a tool named as a member of every object as an unknown tool, and never throws", () => {
    for (const tool_name of ["constructor", "toString", "__proto__"]) {
        const payload = { ...COMMON, hook_event_name: "PreToolUse", tool_name, tool_input: { command: "npm test" } };

        assert.deepEqual(
            claude().readHook(JSON.stringify(payload), RECEIVED_AT)?.evidence,
            { at: AT, agentId: null, action: `started ${tool_name}` },
            tool_name,
        );
    }
});

test("readHook reads a hook named as a member of every object as one with no action, no end and no event, and never throws", () => {
    for (const hook_event_name of ["__proto__", "constructor", "toString"]) {
        const body = JSON.stringify({ ...COMMON, hook_event_name });
        const hook = claude().readHook(body, RECEIVED_AT);

        assert.deepEqual(hook?.evidence, { at: AT, agentId: null, action: null }, hook_event_name);
        assert.equal(hook?.event, null, hook_event_name);
    }
});

test("readHook reads a failed reply whose error is no text as one with no detail, and never throws", () => {
    for (const error of [{ toString: 5 }, [{ toString: 5 }], { message: "overloaded" }, 5, null]) {
        const body = JSON.stringify({ ...COMMON, hook_event_name: "StopFailure", error });

        assert.deepEqual(
            claude().readHook(body, RECEIVED_AT)?.evidence,
            { at: AT, agentId: null, action: "reply failed", replyFailed: "unknown", ends: "all" },
            body,
        );
    }
});

test("answerHook.output is what Claude Code reads on the answer hook's stdout for a decision, byte for byte, and empty for no decision", () => {
    assert.equal(
        claude().answerHook.output({ behavior: "allow" }),
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
    assert.equal(
        claude().answerHook.output({ behavior: "deny", message: "The user said no in Izbor.", interrupt: true }),
        JSON.stringify(transcriptFixture("deny-interrupt").hookReply),
    );
    assert.equal(claude().answerHook.output(null), "");
});

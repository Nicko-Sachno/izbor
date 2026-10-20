import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { portFile, sendKeyFile } from "../src/adapters/files/userFiles.js";
import { IZBOR_PLUGIN } from "../src/domain/prompt.js";
import type { PluginSubmitResult } from "../plugin/hooks/izbor.js";
import { watchedSession } from "./helpers/izborPrompts.js";
import { standIn, startPlugin } from "./helpers/plugin.js";
import { freePort, SESSION, until } from "./support.js";

const PAUSE_AT_LEAST_MS = 1000;

test("seam 3: the plugin finds Izbor from the port and key files, collects a prompt, submits it as the user and reports delivered", async (t) => {
    const { izbor, key, client, promptEvents } = await watchedSession(t);
    const { $, submits } = standIn(t, izbor.home, async (text) => ({ text }));
    await startPlugin($);

    const sent = await client.sendPrompt(SESSION, { text: "run the tests" }, key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    await until(() => submits.length === 1);
    assert.deepEqual(submits, [{ text: "run the tests", asUser: true }]);
    await until(() => promptEvents().length === 1);
    assert.deepEqual(promptEvents(), [
        { type: "prompt", sessionId: SESSION, promptId: sent.collected, text: "run the tests", state: "delivered" },
    ]);
    const again = await client.sendPrompt(SESSION, { text: "and lint" }, key);
    assert.ok("collected" in again);
    await until(() => promptEvents().length === 2);
    assert.equal(submits.length, 2);
});

test("seam 3: a submit that resolves dropped, and one Claude Code refuses, are each reported dropped with the reason", async (t) => {
    const { izbor, key, client, promptEvents } = await watchedSession(t);
    const answers: (() => Promise<PluginSubmitResult>)[] = [
        async () => ({ drop: "the prompt was removed from the queue before it ran" }),
        async () => {
            throw new Error("takes { text } (a non-empty prompt)");
        },
    ];
    const { $, submits } = standIn(t, izbor.home, () => answers.shift()!());
    await startPlugin($);

    const first = await client.sendPrompt(SESSION, { text: "first" }, key);
    await until(() => promptEvents().length === 1);
    const second = await client.sendPrompt(SESSION, { text: "second" }, key);
    await until(() => promptEvents().length === 2);
    assert.ok("collected" in first && "collected" in second);
    assert.deepEqual(promptEvents(), [
        {
            type: "prompt",
            sessionId: SESSION,
            promptId: first.collected,
            text: "first",
            state: "dropped",
            reason: "the prompt was removed from the queue before it ran",
        },
        {
            type: "prompt",
            sessionId: SESSION,
            promptId: second.collected,
            text: "second",
            state: "dropped",
            reason: "takes { text } (a non-empty prompt)",
        },
    ]);
    assert.equal(submits.length, 2, "one prompt in, one submit: nothing is retried");
});

test("seam 3: after a poll that fails (no Izbor on the port) or gets 401 (another key), the plugin reads the port and the key again, after a pause, and finds Izbor", async (t) => {
    const { izbor, key, client, promptEvents } = await watchedSession(t);
    const { $, pauses } = standIn(t, izbor.home, async (text) => ({ text }));
    const files = { port: portFile(izbor.userDir), key: sendKeyFile(izbor.userDir, izbor.port) };
    const realPort = await readFile(files.port, "utf8");
    const realKey = await readFile(files.key, "utf8");
    const deadPort = await freePort();

    await writeFile(files.port, `${deadPort}\n`);
    await startPlugin($);
    await until(() => pauses.length >= 3);
    assert.ok(pauses.every((ms) => ms >= PAUSE_AT_LEAST_MS || ms === 0));
    assert.ok(
        pauses.some((ms) => ms >= PAUSE_AT_LEAST_MS),
        `a pause: ${pauses}`,
    );
    assert.deepEqual(
        izbor.requests.filter((r) => r.path.endsWith("/prompts/next")),
        [],
    );

    await writeFile(files.port, realPort);
    await writeFile(files.key, `${"f".repeat(64)}\n`);
    await until(() => izbor.requests.some((r) => r.path.endsWith("/prompts/next")));
    const polls = () => izbor.requests.filter((r) => r.path.endsWith("/prompts/next")).length;
    await until(() => polls() >= 2);
    assert.deepEqual(promptEvents(), []);

    await writeFile(files.key, realKey);
    await until(() => polls() > 2);
    const sent = await client.sendPrompt(SESSION, { text: "found again" }, key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    await until(() => promptEvents().length === 1);
    assert.equal(promptEvents()[0]!.state, "delivered");
});

test("seam 3: after the test Izbor stops and another starts on a new port with a new key, writing over the files of the same home, the plugin's next poll finds it with no step in the session and collects a prompt; one submit per prompt", async (t) => {
    const first = await watchedSession(t);
    const { $, submits, pauses } = standIn(t, first.izbor.home, async (text) => ({ text }));
    await startPlugin($);
    const sent = await first.client.sendPrompt(SESSION, { text: "before the restart" }, first.key);
    assert.ok("collected" in sent, JSON.stringify(sent));
    await until(() => first.promptEvents().length === 1);

    await first.izbor.stop();
    let port = await freePort();
    while (port === first.izbor.port) port = await freePort();
    const second = await watchedSession(t, { port, home: first.izbor.home });
    assert.notEqual(second.key, first.key);
    await until(() => second.izbor.requests.some((r) => r.path.endsWith("/prompts/next")));
    const again = await second.client.sendPrompt(SESSION, { text: "after the restart" }, second.key);
    assert.ok("collected" in again, JSON.stringify(again));
    await until(() => second.promptEvents().length === 1);
    assert.equal(second.promptEvents()[0]!.state, "delivered");
    assert.deepEqual(
        submits.map(({ text }) => text),
        ["before the restart", "after the restart"],
    );
    assert.ok(
        pauses.some((ms) => ms >= PAUSE_AT_LEAST_MS),
        `a pause while no Izbor answered: ${pauses}`,
    );
});

test("the plugin folder declares the plugin by the name Izbor knows its prompts by, in the plugin's manifest and the marketplace's", async () => {
    const manifest = (file: string) =>
        JSON.parse(readFileSync(new URL(`../plugin/.claude-plugin/${file}`, import.meta.url), "utf8")) as {
            name: string;
            plugins?: { name: string }[];
        };
    assert.equal(manifest("plugin.json").name, IZBOR_PLUGIN);
    assert.deepEqual(
        manifest("marketplace.json").plugins?.map(({ name }) => name),
        [IZBOR_PLUGIN],
    );
});

test("the plugin names each environment variable it reads or writes literally: Claude Code refuses to load a module that calls $.env.get or $.env.set with a variable, which this suite's stand-in does not", () => {
    const source = readFileSync(new URL("../plugin/hooks/izbor.js", import.meta.url), "utf8");
    const calls = [...source.matchAll(/\$\.env\.(?:get|set)\(\s*(.)/g)];
    assert.ok(calls.length > 0);
    for (const [call, first] of calls) assert.match(first!, /["'`]/, `${call} takes a literal name`);
});

type Izbor = Awaited<ReturnType<typeof watchedSession>>["izbor"];

for (const { title, via, env, inHome } of [
    {
        title: "IZBOR_USER_DIR in the session's environment names the per-user folder, before HOME: a test Izbor's files are found there",
        via: "the override",
        env: (izbor: Izbor) => ({ IZBOR_USER_DIR: izbor.userDir }),
        inHome: false,
    },
    {
        title: "LOCALAPPDATA in the session's environment, set and not empty, holds the per-user folder, before HOME: Izbor's files are found in <LOCALAPPDATA>/izbor",
        via: "LOCALAPPDATA",
        env: (izbor: Izbor) => ({ LOCALAPPDATA: dirname(izbor.userDir) }),
        inHome: false,
    },
    {
        title: "with no HOME, USERPROFILE is the home the per-user folder is in: Izbor's files are found in <USERPROFILE>/.config/izbor",
        via: "USERPROFILE",
        env: (izbor: Izbor) => ({ HOME: undefined, USERPROFILE: izbor.home }),
        inHome: true,
    },
])
    test(`seam 3: ${title}`, async (t) => {
        const { izbor, key, client, promptEvents } = await watchedSession(t);
        const elsewhere = await mkdtemp(join(tmpdir(), "izbor-elsewhere-"));
        t.after(() => rm(elsewhere, { recursive: true, force: true }));
        const { $, submits } = standIn(t, inHome ? izbor.home : elsewhere, async (text) => ({ text }), env(izbor));
        await startPlugin($);

        const sent = await client.sendPrompt(SESSION, { text: `found through ${via}` }, key);
        assert.ok("collected" in sent, JSON.stringify(sent));
        await until(() => promptEvents().length === 1);
        assert.deepEqual(submits, [{ text: `found through ${via}`, asUser: true }]);
    });

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PluginSubmitResult } from "../plugin/hooks/izbor.js";
import { actingProject } from "./helpers/answerHook.js";
import { claudeListing, COLOR_TERMINAL, openIzbor, upOn } from "./helpers/bin.js";
import { postHook } from "./helpers/izborPrompts.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { standIn, startPlugin } from "./helpers/plugin.js";
import { SKIP_WITHOUT_PTY } from "./helpers/pty.js";
import { type AgentsListEntry, SESSION, until } from "./support.js";
import { CI_LOG, KEYS, paste } from "./helpers/keys.js";

const REPLY_LABEL = /┌─ Reply to this session ─+┐/;
const PLAIN = /│ › your next prompt +Send → │/;

async function fieldOnIdleSession(t: TestContext, submit: (text: string) => Promise<PluginSubmitResult>) {
    const agents: AgentsListEntry[] = [{ sessionId: SESSION, cwd: "/repo", status: "idle" }];
    const izbor = await startIzborServer(t, { agents });
    const acting = await actingProject(t, izbor.port);
    const plugin = standIn(t, izbor.home, submit);
    await startPlugin(plugin.$);
    await until(() => izbor.requests.some((r) => r.path.endsWith("/prompts/next")));

    const first = await claudeListing(acting, izbor.port, { status: "idle" });
    const window = await openIzbor(t, izbor.port, { first, env: COLOR_TERMINAL });
    await window.until("the app opens on the test Izbor", () => upOn(izbor.port).test(window.frame()[0]!));
    // Initial discovery can use the 3s health probe followed by the 5s agents command.
    await window.until(
        "the list shows the running session",
        () => window.screen().includes("Unnamed session · Idle"),
        8000,
    );
    await window.openFirstBrief(100);
    await window.until("the Brief is live", () => /Back · Esc\s+Task unknown/.test(window.screen()), 8000);
    await postHook(izbor.base, "UserPromptSubmit", { cwd: acting, prompt: "hello" });
    await window.until("the Brief shows the hook", () => /Back · Esc\s+hello/.test(window.screen()));

    await window.until("the Brief page offers a reply", () => window.screen().includes("┌─ Reply to this session"));
    window.input(KEYS.enter);
    await window.until("the field has the cursor", window.fieldHasCursor);
    assert.match(window.screen(), REPLY_LABEL);
    assert.match(window.screen(), PLAIN);
    return { izbor, window, submits: plugin.submits };
}

test(
    "in a real terminal, a prompt typed in an idle session's field is collected by the plugin and the window says Sent to this session",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const { izbor, window, submits } = await fieldOnIdleSession(t, async (text) => ({ text }));
        const posts = () => izbor.requests.filter((r) => r.method === "POST" && r.path.endsWith("/prompts")).length;

        window.input("run the tests again");
        await window.until("the prompt is in the field", () =>
            /│ › run the tests again +Send → │/.test(window.screen()),
        );
        assert.equal(posts(), 0, "typing sends nothing");
        window.input(KEYS.enter);
        await until(() => submits.length === 1);
        assert.deepEqual(submits, [{ text: "run the tests again", asUser: true }], "the plugin collected it, as typed");
        await window.until("the Sent line shows", () => window.screen().includes("Sent to this session."));
        assert.match(window.screen(), PLAIN, "the field is empty and its placeholder is back");
        assert.match(
            window.screen(),
            /Back · Esc\s+hello/,
            "the heading keeps the old Task until Izbor sees the new turn",
        );
        assert.equal(posts(), 1);

        assert.deepEqual(
            izbor.requests.filter((r) => r.path.endsWith("/answer")),
            [],
            "a prompt never went as an answer",
        );
        assert.equal(await window.quit(), 0);
    },
);

test(
    "in a real terminal, Ctrl-J starts a new line in the field, a long paste after it stands as one block, and Enter sends it all: the plugin collects the text with its new lines and the paste's tabs",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const { window, submits } = await fieldOnIdleSession(t, async (text) => ({ text }));

        window.input("run the tests again");
        await window.until("the first line is in the field", () =>
            /│ › run the tests again +Send → │/.test(window.screen()),
        );
        window.input(KEYS["ctrl-j"]);
        await window.until("Ctrl-J starts a second row, Send → on it", () =>
            /│ › run the tests again +│ *\n +│ +Send → │/.test(window.screen()),
        );
        window.input("then open a pull request");
        await window.until("the second line is in the field", () =>
            /│ › run the tests again +│ *\n +│ {3}then open a pull request +Send → │/.test(window.screen()),
        );
        window.input(KEYS["ctrl-j"] + paste(CI_LOG));
        await window.until("the pasted log stands as one block on a third row", () =>
            /│ {3}then open a pull request +│ *\n +│ {3}.Pasted 42 lines · 1\.9 KB. +Send → │/.test(window.screen()),
        );
        assert.equal(submits.length, 0, "Ctrl-J and the paste send nothing");
        window.input(KEYS.enter);
        await until(() => submits.length === 1);
        assert.deepEqual(
            submits,
            [{ text: `run the tests again\nthen open a pull request\n${CI_LOG}`, asUser: true }],
            "the plugin collected every line, the new lines between them and the pasted log whole, its tabs included",
        );
        await window.until("the Sent line shows", () => window.screen().includes("Sent to this session."));
        assert.match(window.screen(), PLAIN, "the field is one empty row again");
        assert.equal(await window.quit(), 0);
    },
);

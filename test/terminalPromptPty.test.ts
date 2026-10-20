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
import { KEYS } from "./helpers/keys.js";

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
    await window.until("the Brief is live", () => window.screen().includes("Back · Esc  Task unknown"), 8000);
    await postHook(izbor.base, "UserPromptSubmit", { cwd: acting, prompt: "hello" });
    await window.until("the Brief shows the hook", () => window.screen().includes("Back · Esc  hello"));

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
            /Back · Esc {2}hello/,
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

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createIzborClient } from "../../src/adapters/izbor/client.js";
import type { PromptState } from "../../src/domain/prompt.js";
import { type AgentsListEntry, fakeClock, hook, SESSION, until } from "../support.js";
import { actingProject, readSendKey, tuneInOverHttp } from "./answerHook.js";
import { startIzborServer } from "./izborServer.js";

export async function postHook(base: string, name: string, extra: object) {
    const posted = await fetch(`${base}/hook`, { method: "POST", body: JSON.stringify(hook(name, extra)) });
    assert.equal(posted.status, 200);
    await posted.text();
}

export async function watchedSession(
    t: TestContext,
    {
        wait = fakeClock().wait,
        agents = undefined as AgentsListEntry[] | undefined,
        port = undefined as number | undefined,
        home = undefined as string | undefined,
    } = {},
) {
    const izbor = await startIzborServer(t, { session: { status: "idle" }, wait, agents, port, home });
    const acting = await actingProject(t, izbor.port);
    const stream = await tuneInOverHttp(t, izbor.port, SESSION);
    await postHook(izbor.base, "UserPromptSubmit", { cwd: acting, prompt: "hello" });
    await until(() => stream.latest().task?.text === "hello");
    const key = await readSendKey(izbor.info.sendKeyPath);
    const client = createIzborClient({ port: izbor.port });
    const promptEvents = () => stream.events.filter((event) => event.type === "prompt");
    return { izbor, acting, stream, key, client, ...pluginPrompts(izbor, key), promptEvents };
}

/** What the plugin does with a test Izbor's prompts: poll for the next one, and report it delivered or dropped. */
export function pluginPrompts(izbor: { base: string; requests: { path: string }[] }, key: string) {
    const bearer = { authorization: `Bearer ${key}` };
    const poll = (sessionId = SESSION) =>
        fetch(`${izbor.base}/sessions/${sessionId}/prompts/next`, { headers: bearer });
    const polled = (n: number) =>
        until(() => izbor.requests.filter((r) => r.path.endsWith("/prompts/next")).length >= n);
    const report = (promptId: string, state: PromptState, body?: object) =>
        fetch(`${izbor.base}/prompts/${promptId}/${state}`, {
            method: "POST",
            headers: { ...bearer, "content-type": "application/json" },
            body: body && JSON.stringify(body),
        });
    return { bearer, poll, polled, report };
}

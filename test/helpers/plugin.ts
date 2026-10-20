import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import {
    type PluginEngine,
    type PluginSubmitResult,
    register,
    type SessionStartHook,
} from "../../plugin/hooks/izbor.js";
import { SESSION } from "../support.js";

export function standIn(
    t: TestContext,
    home: string,
    submit: (text: string) => Promise<PluginSubmitResult>,
    env: Record<string, string | undefined> = {},
) {
    const submits: { text: string; asUser: true }[] = [];
    const pauses: number[] = [];
    const timers = new Set<NodeJS.Timeout>();
    let ended = false;
    t.after(() => {
        ended = true;
        timers.forEach((timer) => clearTimeout(timer));
    });
    const $: PluginEngine = {
        env: { get: async (name) => (name in env ? env[name] : name === "HOME" ? home : undefined) },
        fs: { read: (path) => readFile(path, "utf8") },
        http: {
            async fetch(url, init = {}) {
                const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body });
                return {
                    status: res.status,
                    ok: res.ok,
                    headers: Object.fromEntries(res.headers),
                    text: await res.text(),
                };
            },
        },
        session: { id: async () => SESSION },
        clock: {
            after(ms, fn) {
                pauses.push(ms);
                if (ended) return { cancel: () => {} };
                const timer = setTimeout(
                    () => {
                        timers.delete(timer);
                        fn();
                    },
                    Math.min(ms, 20),
                );
                timers.add(timer);
                return { cancel: () => clearTimeout(timer) };
            },
        },
        prompt: {
            submit: async (args) => {
                submits.push(args);
                return submit(args.text);
            },
        },
    };
    return { $, submits, pauses };
}

export async function startPlugin($: PluginEngine) {
    let start: SessionStartHook | undefined;
    register((event, hook) => {
        assert.equal(event, "session.start");
        start = hook;
    });
    assert.ok(start, "the module hooks session.start");
    const e = { cwd: "/repo" };
    assert.deepEqual(await start($, e, async (input) => input), e, "the hook passes session.start on");
}

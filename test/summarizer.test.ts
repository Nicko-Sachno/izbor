import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSummarizer } from "../src/adapters/summarizer/summarizer.js";
import { HANGING } from "./helpers/fakeCommand.js";
import { fakePlatform, hostPlatform } from "./helpers/fakePlatform.js";
import { fakeClaude, isRunning, until } from "./support.js";

const OPENING = `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const D = __dirname;
const save = (name, text) => fs.writeFileSync(path.join(D, name), text);
const input = readline.createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const line = async () => (await lines.next()).value ?? "";
const done = () => input.close();
save("args", \`\${process.argv.slice(2).join(" ")}\\n\`);
save("env", Object.entries(process.env).map(([name, value]) => \`\${name}=\${value}\\n\`).join(""));
save("cwd", \`\${process.cwd()}\\n\`);
const opening = await line();
save("opening", opening);
const id = /"request_id":"([^"]*)"/.exec(opening)?.[1] ?? "";
process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } }) + "\\n");`;

const sdkFake = (rest: string) => `(async () => {\n${OPENING}\n${rest}\n})();`;

const resultMessage = (fields: object) =>
    JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
        session_id: "fake",
        ...fields,
    });

const answering = (...messages: string[]) =>
    sdkFake(
        `save("prompt", await line());\nprocess.stdout.write(${JSON.stringify(`${messages.join("\n")}\n`)});\ndone();`,
    );

const HANGING_REQUEST = sdkFake(`done();\n${HANGING}`);

const INTERRUPTIBLE_REQUEST = sdkFake(`await line();
save("pids", \`\${process.pid}\\n\`);
save("interrupt", await line());
process.stdout.write(${JSON.stringify(`${resultMessage({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: [] })}\n`)});
setTimeout(() => {}, 30_000);`);

async function summarizerWith(script: string, { env = process.env, killAfterMs = 50, platform = hostPlatform() } = {}) {
    const claude = await fakeClaude(script);
    const dir = join(await mkdtemp(join(tmpdir(), "izbor-data-")), "summarizer");
    const request = createSummarizer({
        dir,
        command: claude.sdkCommand,
        env,
        killAfterMs,
        platform,
    });
    const cancel = new AbortController();
    const summarize = (input: string) =>
        request({ systemPrompt: "Say what the session is doing.", input }, cancel.signal);
    const saved = (name: string) => readFile(join(claude.dir, name), "utf8");
    return { cancel, summarize, claude, dir, saved };
}

test("a summary request answers with the summary Claude wrote", async () => {
    const { summarize } = await summarizerWith(
        answering(resultMessage({ result: "Claude is fixing the failing auth tests.\n" })),
    );

    assert.deepEqual(await summarize("npm test failed in auth.spec.ts; Claude read src/auth.ts"), {
        outcome: "summary",
        text: "Claude is fixing the failing auth tests.",
    });
});

test("a summary request is isolated: no settings, hooks, memory, transcript, tools or MCP servers, and no API key", async () => {
    const { summarize, dir, saved } = await summarizerWith(answering(resultMessage({ result: "ok" })), {
        env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-paid", ANTHROPIC_AUTH_TOKEN: "paid-token" },
    });

    await summarize("npm test failed in auth.spec.ts");

    const args = await saved("args");
    for (const option of [
        "--model haiku",
        "--tools  ",
        "--setting-sources= ",
        "--strict-mcp-config",
        "--no-session-persistence",
        '--settings {"disableAllHooks":true,"autoMemoryEnabled":false}',
        "--thinking disabled",
        "--max-turns 1",
    ])
        assert.ok(args.includes(option), `${option} is missing from: ${args}`);
    assert.ok(!args.includes("--mcp-config"), args);
    const opening = JSON.parse(await saved("opening")).request;
    assert.deepEqual(opening.systemPrompt, ["Say what the session is doing."]);
    assert.equal(opening.title, "izbor-summarizer");
    assert.match(await saved("prompt"), /npm test failed in auth\.spec\.ts/);
    assert.equal((await saved("cwd")).trim(), await realpath(dir));
    assert.deepEqual(await readdir(dir), []);
    assert.doesNotMatch(await saved("env"), /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/);
});

test("a used-up subscription is reported as a result, with out_of_credits as the reason", async () => {
    const { summarize } = await summarizerWith(
        answering(
            JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [] }, session_id: "fake" }),
            JSON.stringify({
                type: "rate_limit_event",
                rate_limit_info: {
                    status: "rejected",
                    rateLimitType: "five_hour",
                    overageStatus: "rejected",
                    overageDisabledReason: "out_of_credits",
                },
                session_id: "fake",
            }),
            resultMessage({ is_error: true, result: "You've hit your limit" }),
        ),
    );

    assert.deepEqual(await summarize("npm test failed"), {
        outcome: "unavailable",
        reason: "rate_limit: five_hour limit reached, no overage (out_of_credits): You've hit your limit",
    });
});

test("a `claude` that fails is reported as a result, with what it printed", async () => {
    const { summarize } = await summarizerWith('process.stderr.write("Not logged in\\n");\nprocess.exitCode = 3;');

    const result = await summarize("npm test failed");

    assert.equal(result.outcome, "unavailable");
    assert.match(result.outcome === "unavailable" ? result.reason : "", /exited with code 3.*Not logged in/s);
});

test("a `claude` that cannot be started is reported as a result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-summarizer-"));
    const summarize = createSummarizer({
        dir,
        command: "/nonexistent/claude",
        platform: hostPlatform(),
        env: process.env,
    });

    const result = await summarize({ systemPrompt: "Say it.", input: "npm test failed" }, new AbortController().signal);

    assert.equal(result.outcome, "unavailable");
});

const LINGERING_REQUEST = sdkFake(`await line();
save("pids", \`\${process.pid}\\n\`);
process.stdout.write(${JSON.stringify(`${resultMessage({ result: "ok" })}\n`)});
done();
setTimeout(() => {}, 300);`);

test("a summary request ends only once its `claude` process is gone, so its caller knows nothing of it is left", async () => {
    const { summarize, claude } = await summarizerWith(LINGERING_REQUEST);

    assert.deepEqual(await summarize("npm test failed"), { outcome: "summary", text: "ok" });

    const pids = await claude.pids();
    assert.equal(pids.length, 1);
    assert.deepEqual(pids.filter(isRunning), []);
});

test("after its `claude` exited, a summary request kills its tree on a platform whose kill still reaches it, and nothing on one whose kill reaches a live tree only", async () => {
    for (const reachesTreeAfterExit of [true, false]) {
        const label = reachesTreeAfterExit
            ? "a kill that still reaches the tree"
            : "a kill that reaches a live tree only";
        const platform = fakePlatform({ reachesTreeAfterExit });
        const { summarize, claude } = await summarizerWith(LINGERING_REQUEST, { platform });

        assert.deepEqual(await summarize("npm test failed"), { outcome: "summary", text: "ok" }, label);

        assert.deepEqual(platform.killed, reachesTreeAfterExit ? await claude.pids() : [], label);
    }
});

test("cancelling a summary request leaves no process of it running, nor anything that process started", async () => {
    const { cancel, summarize, claude } = await summarizerWith(HANGING_REQUEST);
    const result = summarize("npm test failed");
    await until(async () => (await claude.pids()).length === 2);
    const pids = await claude.pids();

    cancel.abort();

    assert.deepEqual(await result, { outcome: "cancelled" });
    await until(() => !pids.some(isRunning));
});

test("cancelling a summary request kills its `claude` while it runs, on a platform whose kill reaches a live tree only", async (t) => {
    const platform = fakePlatform({ reachesTreeAfterExit: false });
    const { cancel, summarize, claude } = await summarizerWith(HANGING_REQUEST, { platform });
    const result = summarize("npm test failed");
    await until(async () => (await claude.pids()).length === 2);
    const pids = await claude.pids();
    t.after(() => pids.filter(isRunning).forEach((pid) => process.kill(pid, "SIGKILL")));

    cancel.abort();
    await until(() => platform.killed.length > 0);
    process.kill(pids[0]!, "SIGKILL");

    assert.deepEqual(await result, { outcome: "cancelled" });
    assert.deepEqual(platform.killed, [pids[0]]);
});

test("cancelling interrupts the request, and does not wait for a `claude` that answered the interrupt to exit by itself", async () => {
    const { cancel, summarize, claude, saved } = await summarizerWith(INTERRUPTIBLE_REQUEST, { killAfterMs: 60_000 });
    const result = summarize("npm test failed");
    await until(async () => (await claude.pids()).length === 1);
    const pids = await claude.pids();

    const cancelled = Date.now();
    cancel.abort();

    assert.deepEqual(await result, { outcome: "cancelled" });
    assert.ok(Date.now() - cancelled < 5000, `the cancel took ${Date.now() - cancelled} ms`);
    assert.equal(JSON.parse(await saved("interrupt")).request.subtype, "interrupt");
    assert.deepEqual(pids.filter(isRunning), []);
});

test("a summary request that is cancelled before it is made does not start `claude`", async () => {
    const { cancel, summarize, saved } = await summarizerWith(answering(resultMessage({ result: "ok" })));
    cancel.abort();

    assert.deepEqual(await summarize("npm test failed"), { outcome: "cancelled" });
    await assert.rejects(saved("args"), /ENOENT/);
});

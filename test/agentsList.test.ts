import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentsList } from "../src/adapters/agents/claude/agentsList.js";
import { runAs, runScript } from "./helpers/fakePlatform.js";
import { fakeClaude } from "./support.js";

const never = new AbortController().signal;

test("the command is `claude agents --json`, and its output is the answer", async () => {
    const { sdkCommand } = await fakeClaude('process.stdout.write(`${process.argv.slice(2).join(" ")}\\n`);');

    assert.equal(await createAgentsList({ run: runScript(sdkCommand) })(never), "agents --json\n");
});

test("a command that exits with an error fails with what it printed", async () => {
    const { sdkCommand } = await fakeClaude('process.stderr.write("Not logged in\\n");\nprocess.exitCode = 3;');

    await assert.rejects(createAgentsList({ run: runScript(sdkCommand) })(never), /exited with code 3: Not logged in/);
});

test("a command that cannot be started fails", async () => {
    await assert.rejects(createAgentsList({ run: runAs("/nonexistent/claude") })(never), /ENOENT/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SKIP_WITHOUT_PTY, startPty } from "./helpers/pty.js";

const node = (script: string) => [process.execPath, "-e", script];

test("close ends the command's own process", { skip: SKIP_WITHOUT_PTY }, async (t) => {
    const pty = await startPty(node("console.log(`pid ${process.pid}`); setInterval(() => {}, 1000)"));
    t.after(pty.close);
    let pid = 0;
    await pty.until("the command shows its pid", () => {
        pid = Number(/pid (\d+)/.exec(pty.frame().join("\n"))?.[1] ?? 0);
        return pid > 0;
    });
    assert.doesNotThrow(() => process.kill(pid, 0), "the command runs until close");
    await pty.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "close ends the command");
});

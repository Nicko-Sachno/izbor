import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { PROJECT_DIR } from "../../src/config.js";
import { terminalLayout } from "../../src/terminal/layout.js";
import { click as clickKeys, KEYS } from "./keys.js";

const { Terminal } = xterm;
const hasPython = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;

export const SKIP_WITHOUT_PTY = !hasPython && "Requires a Unix PTY and Python 3";

export const SHELL_PROMPT = "original shell prompt$ ";

type PtyExit = { code: number; modesRestored: boolean };

type Point = { x: number; y: number };

type BridgeMessage = { type: "ready" } | { type: "output"; data: string } | ({ type: "exit" } & PtyExit);

// A CI runner's own variables: chalk turns colour on under CI when GITHUB_ACTIONS, GITEA_ACTIONS or CIRCLECI is set.
const RUNNER_ENV = {
    FORCE_COLOR: undefined,
    NODE_TEST_CONTEXT: undefined,
    GITHUB_ACTIONS: undefined,
    GITEA_ACTIONS: undefined,
    CIRCLECI: undefined,
};

const LAST_ROW_LABEL = /\s(Help|Close)( · Ctrl-G)?\s*$/;

type PtyOptions = {
    env?: Record<string, string | undefined>;
    cwd?: string;
    cols?: number;
    rows?: number;
    timeoutMs?: number;
};

export async function startPty(
    argv: string[],
    { env = {}, cwd = PROJECT_DIR, cols = 80, rows = 30, timeoutMs = 10_000 }: PtyOptions = {},
) {
    const terminal = new Terminal({ cols, rows, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(SHELL_PROMPT, resolve));
    const bridge = spawn(
        "python3",
        [fileURLToPath(new URL("./terminalPty.py", import.meta.url)), String(cols), String(rows), ...argv],
        {
            cwd,
            env: { ...process.env, ...RUNNER_ENV, TERM: "xterm-256color", NO_COLOR: "1", ...env },
            stdio: "pipe",
        },
    );
    let writes = Promise.resolve();
    let stderr = "";
    let failure: Error | undefined;
    let exit: PtyExit | undefined;
    const lines = createInterface({ input: bridge.stdout });
    const utf8 = new StringDecoder("utf8");
    lines.on("line", (line: string) => {
        const message = JSON.parse(line) as BridgeMessage;
        if (message.type === "output") {
            const text = utf8.write(Buffer.from(message.data, "base64"));
            writes = writes.then(() => new Promise<void>((resolve) => terminal.write(text, resolve)));
        } else if (message.type === "exit") {
            writes = writes.then(() => void (exit = { code: message.code, modesRestored: message.modesRestored }));
        }
    });
    bridge.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
    bridge.on("error", (error) => (failure = error));
    bridge.on("exit", (code) => {
        if (code && !failure) failure = new Error(`PTY bridge exited with ${code}: ${stderr}`);
    });

    async function close() {
        lines.close();
        bridge.stdin.end();
        if (bridge.exitCode === null) {
            await Promise.race([
                new Promise<void>((resolve) => bridge.once("exit", () => resolve())),
                delay(2500, undefined, { ref: false }),
            ]);
        }
        if (bridge.exitCode === null) bridge.kill("SIGKILL");
        terminal.dispose();
    }

    function send(message: object) {
        bridge.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function input(text: string) {
        send({ type: "input", data: Buffer.from(text).toString("base64") });
    }

    terminal.onData(input);

    function frame(): string[] {
        const buffer = terminal.buffer.active;
        return Array.from({ length: terminal.rows }, (_, row) =>
            (buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) ?? "").padEnd(
                terminal.cols,
            ),
        );
    }

    function frameReady(): boolean {
        if (terminal.buffer.active.type !== "alternate" || terminal.cols < 40 || terminal.rows < 12) return true;
        const last = (frame()[terminal.rows - 1] ?? "").trimEnd();
        const { inset } = terminalLayout(terminal.cols, terminal.rows);
        return LAST_ROW_LABEL.test(last) && last.length === terminal.cols - inset;
    }

    async function until(description: string, condition: () => boolean, timeout = timeoutMs) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            await writes;
            if (failure) throw failure;
            if (frameReady() && condition()) {
                await delay(25);
                await writes;
                if (failure) throw failure;
                if (frameReady() && condition()) return;
            }
            await delay(25);
        }
        assert.fail(`${description}\n${frame().join("\n")}\n${stderr}`);
    }

    function fieldRow(): { y: number; origin: number; end: number } {
        const cells = frame();
        const y = cells.findIndex((line) => line.includes("│ › "));
        assert.ok(y >= 0, `the Brief's field is visible\n${cells.join("\n")}`);
        const prompt = cells[y]!.indexOf("│ › ");
        return { y, origin: prompt + 4, end: cells[y]!.indexOf("│", prompt + 1) };
    }

    function assertFieldCursor(text?: string, offset = text?.length) {
        const { y, origin, end } = fieldRow();
        const buffer = terminal.buffer.active;
        assert.equal(buffer.cursorY, y, "the actual terminal cursor stays on the field's row");
        assert.ok(buffer.cursorX >= origin, "the cursor stays after the field's prompt");
        assert.ok(buffer.cursorX < end, "the cursor stays inside the field's border");
        if (text !== undefined && offset !== undefined) {
            assert.ok(frame()[y]!.includes(text));
            assert.equal(buffer.cursorX, fieldPoint(offset).x);
        }
    }

    function fieldHasCursor(): boolean {
        try {
            assertFieldCursor();
            return true;
        } catch {
            return false;
        }
    }

    function setSize(columns: number, rows: number) {
        terminal.resize(columns, rows);
        send({ type: "resize", columns, rows });
    }

    async function resize(columns: number, rows: number) {
        setSize(columns, rows);
        const { inset } = terminalLayout(columns, rows);
        if (columns < 40 || rows < 12) {
            await until(`the ${columns}×${rows} window requests a larger workspace`, () => {
                const visible = frame().join("\n");
                return /40 × 12/.test(visible);
            });
            return;
        }
        await until(
            `the screen reflows to ${columns}×${rows}`,
            () => (frame()[rows - 1] ?? "").trimEnd().length === columns - inset,
        );
        await settle();
    }

    function point(text: string): Point {
        const cells = frame();
        const y = cells.findIndex((line) => line.includes(text));
        assert.ok(y >= 0, `click target is visible: ${text}\n${cells.join("\n")}`);
        return { x: cells[y]!.indexOf(text), y };
    }

    function click(target: Point) {
        input(clickKeys(target.x, target.y));
    }

    function fieldPoint(offset = 0): Point {
        const { y, origin } = fieldRow();
        return { x: origin + offset, y };
    }

    async function settle(ms = 125) {
        await delay(ms);
        await writes;
        if (failure) throw failure;
    }

    // Tab, Tab, Enter from Home: the first session's Brief. Each caller waits for its own Brief.
    async function openFirstBrief(ms?: number) {
        input(KEYS.tab);
        await settle(ms);
        input(KEYS.tab);
        await settle(ms);
        input(KEYS.enter);
    }

    return {
        terminal,
        frame,
        input,
        click,
        point,
        fieldPoint,
        setSize,
        resize,
        settle,
        until,
        assertFieldCursor,
        fieldHasCursor,
        openFirstBrief,
        exited: () => exit,
        close,
    };
}

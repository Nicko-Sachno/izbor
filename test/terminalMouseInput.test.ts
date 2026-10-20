import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { createElement, useEffect } from "react";
import { render, useInput, usePaste } from "ink";
import { createMouseInput } from "../src/terminal/mouse-input.js";
import { createMouseParser, useMouse } from "../src/terminal/mouse.js";

function source() {
    const rawModes: boolean[] = [];
    const stream = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode(enabled: boolean) {
            rawModes.push(enabled);
        },
    });
    return { stream, rawModes };
}

const click = "\u001b[<0;12;7M";

test("the mouse input adapter preserves separate keyboard/report chunks and original text", async (t) => {
    const { stream, rawModes } = source();
    const adapter = createMouseInput(stream);
    t.after(() => adapter.dispose());
    assert.equal(stream.listenerCount("data"), 0, "creation must not begin consuming stdin");
    adapter.stdin.setEncoding("utf8");
    adapter.stdin.setRawMode!(true);
    const original = `abc${click}def\u001b[<0;12;7mghi`;
    stream.write(original);
    await nextTurn();
    const chunks: string[] = [];
    let chunk: string | null;
    while ((chunk = adapter.stdin.read() as string | null) !== null) chunks.push(chunk);
    assert.deepEqual(chunks, ["abc", click, "def", "\u001b[<0;12;7m", "ghi"]);
    assert.equal(chunks.join(""), original);
    assert.deepEqual(rawModes, [true]);
    adapter.stdin.setRawMode!(false);
    assert.deepEqual(rawModes, [true, false]);
    assert.equal(stream.listenerCount("data"), 0);
    assert.equal(stream.isPaused(), true);
    adapter.dispose();
    assert.deepEqual(rawModes, [true, false], "dispose does not release raw mode twice");
});

test("fragmented Unicode and mouse reports survive the adapter byte-for-byte", async (t) => {
    const { stream } = source();
    const adapter = createMouseInput(stream);
    t.after(() => adapter.dispose());
    adapter.stdin.setRawMode!(true);
    const original = `abc界🙂${click}e\u0301xyz`;
    for (const byte of Buffer.from(original)) stream.write(Buffer.from([byte]));
    await nextTurn();
    const chunks: string[] = [];
    let chunk: string | null;
    while ((chunk = adapter.stdin.read() as string | null) !== null) chunks.push(chunk);
    assert.equal(chunks.join(""), original);
    const parser = createMouseParser();
    assert.deepEqual(
        chunks.flatMap((part) => parser.push(part)),
        [{ type: "click", x: 11, y: 6 }],
    );
});

test("Ink handles typing before and after coalesced clicks in input order", async (t) => {
    const { stream } = source();
    const adapter = createMouseInput(stream);
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 30 });
    stdout.on("data", () => {});
    let focus = "command";
    let command = "";
    const seen: string[] = [];
    let mounted!: () => void;
    const ready = new Promise<void>((resolve) => (mounted = resolve));
    function App() {
        useMouse((event) => {
            focus = event.x === 0 ? "command" : "session";
            seen.push(`click ${focus}`);
        });
        useInput((input) => {
            seen.push(`input ${input} ${focus}`);
            if (focus === "command") command += input;
        });
        usePaste((text) => {
            seen.push("paste");
            if (focus === "command") command += text;
        });
        useEffect(mounted, []);
        return null;
    }
    const app = render(createElement(App), {
        stdin: adapter.stdin,
        stdout,
        stderr: stdout,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    t.after(() => {
        app.unmount();
        adapter.dispose();
        stdout.destroy();
    });
    await ready;
    stream.write(`abc${click}\u001b[<0;1;7Mdef`);
    await nextTurn();
    assert.equal(command, "abcdef");
    assert.deepEqual(seen, ["input abc command", "click session", "click command", "input def command"]);
    stream.write(`\u001b[200~pasted ${click}\u001b[201~`);
    await nextTurn();
    assert.equal(command, `abcdefpasted ${click}`);
    assert.equal(seen.at(-1), "paste");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { editLine, type EditKey, type Line } from "../src/terminal/line-editor.js";

const WIDE = "\u{754C}";
const FACE = "\u{1F642}";
const ACUTE_E = "e\u{0301}";
const LINE: Line = { text: `${WIDE}${FACE}${ACUTE_E}abc`, cursor: 5 };

const press = (key: EditKey, text?: string, line: Line = LINE) => editLine(line, text, key);

test("Left moves the caret back over the whole é, two code units, and is no edit", () => {
    assert.deepEqual(press({ name: "left" }), { text: LINE.text, cursor: 3, edited: false });
});

test("Right moves the caret forward over the a", () => {
    assert.deepEqual(press({ name: "right" }), { text: LINE.text, cursor: 6, edited: false });
});

test("Home and Ctrl-A put the caret at the start, End and Ctrl-E at the end; Ctrl-A as a control chunk sends it: a name and no text", () => {
    const cases: [string, EditKey, number][] = [
        ["Home", { name: "home" }, 0],
        ["End", { name: "end" }, 8],
        ["Ctrl-A", { name: "a", ctrl: true }, 0],
        ["Ctrl-E", { name: "e", ctrl: true }, 8],
    ];
    for (const [what, key, cursor] of cases)
        assert.deepEqual(press(key), { text: LINE.text, cursor, edited: false }, what);
});

test("Backspace before a combining mark deletes the whole é and is an edit", () => {
    assert.deepEqual(press({ name: "backspace" }), { text: `${WIDE}${FACE}abc`, cursor: 3, edited: true });
});

test("Backspace before a wide character deletes it whole: 界 is one code unit, 🙂 is two", () => {
    assert.deepEqual(press({ name: "backspace" }, undefined, { text: LINE.text, cursor: 1 }), {
        text: `${FACE}${ACUTE_E}abc`,
        cursor: 0,
        edited: true,
    });
    assert.deepEqual(press({ name: "backspace" }, undefined, { text: LINE.text, cursor: 3 }), {
        text: `${WIDE}${ACUTE_E}abc`,
        cursor: 1,
        edited: true,
    });
});

test("Delete takes the grapheme after the caret: the a, or the whole é when the caret is before it", () => {
    assert.deepEqual(press({ name: "delete" }), { text: `${WIDE}${FACE}${ACUTE_E}bc`, cursor: 5, edited: true });
    assert.deepEqual(press({ name: "delete" }, undefined, { text: LINE.text, cursor: 3 }), {
        text: `${WIDE}${FACE}abc`,
        cursor: 3,
        edited: true,
    });
});

test("Ctrl-U cuts everything before the caret and is no edit for the feedback line", () => {
    assert.deepEqual(press({ name: "u", ctrl: true }), { text: "abc", cursor: 0, edited: false });
});

test("typed text goes in at the caret and the caret follows it", () => {
    assert.deepEqual(press({}, "xy"), { text: `${WIDE}${FACE}${ACUTE_E}xyabc`, cursor: 7, edited: true });
});

test("typed text is cleaned first: a run of CR, LF and tab becomes one space, and an escape sequence, an OSC title sequence, a bidi override and a control character go", () => {
    assert.deepEqual(press({}, "a\r\n\tb\u{1B}[31mc\u{1B}]0;injected-title\u{07}\u{202E}\u{07}"), {
        text: `${WIDE}${FACE}${ACUTE_E}a bcabc`,
        cursor: 9,
        edited: true,
    });
    assert.deepEqual(press({}, "\u{07}"), { ...LINE, edited: true });
});

test("the line holds 2,048 characters: a paste past the cap keeps what fits, counted after cleaning, and a full line takes nothing", () => {
    const nearlyFull: Line = { text: "x".repeat(2040), cursor: 2040 };
    const capped = { text: `${"x".repeat(2040)}${"y".repeat(8)}`, cursor: 2048, edited: true };
    assert.deepEqual(press({}, "y".repeat(20), nearlyFull), capped);
    assert.deepEqual(press({}, `\u{1B}[31m${"y".repeat(20)}`, nearlyFull), capped);
    const full: Line = { text: "x".repeat(2048), cursor: 2048 };
    assert.deepEqual(press({}, "y", full), { ...full, edited: true });
});

test("Backspace on an empty line changes nothing and is still an edit: the feedback line clears", () => {
    assert.deepEqual(press({ name: "backspace" }, undefined, { text: "", cursor: 0 }), {
        text: "",
        cursor: 0,
        edited: true,
    });
});

test("a key the editor does not handle, Up or a bare key, returns the line as it is and is no edit", () => {
    assert.deepEqual(press({ name: "up" }), { ...LINE, edited: false });
    assert.deepEqual(press({}), { ...LINE, edited: false });
});

test("a named key wins over text that comes with it: Home and Ctrl-A as Ink sends them move the caret and insert nothing, and a Meta chord inserts nothing", () => {
    assert.deepEqual(press({ name: "home" }, "H"), { text: LINE.text, cursor: 0, edited: true });
    assert.deepEqual(press({ name: "a", ctrl: true }, "a"), { text: LINE.text, cursor: 0, edited: true });
    assert.deepEqual(press({ meta: true }, "x"), { ...LINE, edited: true });
});

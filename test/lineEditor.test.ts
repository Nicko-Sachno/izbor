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

test("typed text keeps its lines: Ctrl-J's LF stays, CR LF and a lone CR become LF, a tab stays, and an escape sequence, an OSC title sequence, a bidi override and a control character go", () => {
    assert.deepEqual(press({}, "\n"), { text: `${WIDE}${FACE}${ACUTE_E}\nabc`, cursor: 6, edited: true });
    assert.deepEqual(press({}, "a\r\nb\rc\td\u{1B}[31me\u{1B}]0;injected-title\u{07}\u{202E}\u{07}"), {
        text: `${WIDE}${FACE}${ACUTE_E}a\nb\nc\tdeabc`,
        cursor: 13,
        edited: true,
    });
    assert.deepEqual(press({}, "\u{07}"), { ...LINE, edited: true });
});

test("an OSC or DCS sequence a paste leaves open ends with its line: the lines after it stay", () => {
    const empty: Line = { text: "", cursor: 0 };
    const log = "step 1\u{1B}]0;half a title\nstep 2\u{1B}P1$r0m\nstep 3";
    assert.deepEqual(editLine(empty, log, { paste: true }), {
        text: "step 1\nstep 2\nstep 3",
        cursor: 20,
        edited: true,
    });
});

test("the field holds 64 KB, 65,536 UTF-8 bytes of the whole text: a paste past the cap keeps what fits, counted after cleaning and cut between graphemes, and says so; a full field takes nothing", () => {
    const nearlyFull: Line = { text: "x".repeat(65_530), cursor: 65_530 };
    const capped = { text: `${"x".repeat(65_530)}${FACE}`, cursor: 65_532, edited: true, capped: true };
    assert.deepEqual(press({}, `${FACE}${ACUTE_E}`, nearlyFull), capped, "🙂 is 4 bytes; é is 3, one too many");
    assert.deepEqual(press({}, `\u{1B}[31m${FACE}${ACUTE_E}`, nearlyFull), capped);
    assert.deepEqual(
        press({}, `${FACE}ab`, nearlyFull),
        { text: `${"x".repeat(65_530)}${FACE}ab`, cursor: 65_534, edited: true },
        "text that fits exactly is no cut",
    );
    const full: Line = { text: "x".repeat(65_536), cursor: 65_536 };
    assert.deepEqual(press({}, "y", full), { ...full, edited: true, capped: true });
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeOf, messageOf, oneLine, readJson } from "../src/domain/text.js";

test("a text stays on one line: every kind of line break is written as \\n", () => {
    assert.equal(oneLine("one\ntwo\r\nthree\rfour"), "one\\ntwo\\nthree\\nfour");
});

test("a text of up to 500 characters is kept whole, a longer one is cut there and says how much is left out", () => {
    assert.equal(oneLine("y".repeat(500)), "y".repeat(500));
    assert.equal(oneLine("y".repeat(600)), `${"y".repeat(500)}… (+100 chars)`);
});

test("the message of a caught value is an error's message, and any other value as text", () => {
    assert.equal(messageOf(new Error("the port is taken")), "the port is taken");
    assert.equal(messageOf("no such folder"), "no such folder");
    assert.equal(messageOf(undefined), "undefined");
});

test("the code of a caught value is its `code` when that is a text, and undefined for anything else", () => {
    assert.equal(codeOf(Object.assign(new Error("no such file"), { code: "ENOENT", errno: -2 })), "ENOENT");
    assert.equal(codeOf(new Error("no code")), undefined);
    assert.equal(codeOf(Object.assign(new Error("a number"), { code: 2 })), undefined);
    assert.equal(codeOf(null), undefined);
});

test("a JSON text is read as its value, and a text that is not JSON as undefined, with no throw", () => {
    assert.deepEqual(readJson('{"at": "one", "list": [1, 2]}'), { at: "one", list: [1, 2] });
    assert.equal(readJson("null"), null);
    assert.equal(readJson("7"), 7);
    assert.equal(readJson(""), undefined);
    assert.equal(readJson('{"at": "on'), undefined);
});

test("a JSON text that starts with one byte order mark, as Windows PowerShell writes UTF-8, is read as its value", () => {
    assert.deepEqual(readJson('\uFEFF{"at": "one"}'), { at: "one" });
    assert.equal(readJson("\uFEFF"), undefined);
    assert.equal(readJson('\uFEFF\uFEFF{"at": "one"}'), undefined, "only one mark is dropped");
});

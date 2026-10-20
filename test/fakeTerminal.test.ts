import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeTerminal } from "./helpers/fakeTerminal.js";

test("the fake terminal records neither a bell nor a title as a frame, and keeps a frame written with a title", async (t) => {
    const window = fakeTerminal(t, 40, 5);
    const frames = window.record();
    window.io.stdout.write("\x07");
    window.io.stdout.write("\x1b]0;Izbor · needs you\x07");
    window.io.stdout.write("\x1b]2;izbor\x1b\\Sessions · 1");
    await window.shows("Sessions · 1");
    assert.deepEqual(frames, ["Sessions · 1"]);
    assert.equal((await window.screen())[0], "Sessions · 1");
});

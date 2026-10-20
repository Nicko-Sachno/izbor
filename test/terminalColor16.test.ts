import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tone } from "../src/terminal/presentation.js";

process.env.FORCE_COLOR = "1";
const { default: chalk } = await import("chalk");
const { renderToString } = await import("ink");
const { createElement: h } = await import("react");
const { Badge, Copy, toneColor } = await import("../src/terminal/copy.js");
const { palette } = await import("../src/terminal/presentation.js");

test("chalk is at level 1 here", () => {
    assert.equal(chalk.level, 1);
});

test("at level 1 Copy draws needsYou, notice, error, done and reply by name, and the other tones in the terminal's own colour", () => {
    const BYTES: Record<Tone, string> = {
        text: "x",
        muted: "x",
        focus: "x",
        needsYou: "\x1b[33mx\x1b[39m",
        needsYouFill: "\x1b[33mx\x1b[39m",
        needsYouOnFill: "\x1b[30mx\x1b[39m",
        notice: "\x1b[36mx\x1b[39m",
        error: "\x1b[31mx\x1b[39m",
        done: "\x1b[32mx\x1b[39m",
        brand: "x",
        border: "x",
        reply: "\x1b[94mx\x1b[39m",
    };
    for (const tone of Object.keys(BYTES) as Tone[]) {
        assert.equal(
            renderToString(h(Copy, { color: true, tone, children: "x" }), { columns: 40 }),
            BYTES[tone],
            `the ${tone} tone`,
        );
    }
});

test("toneColor reads the level at each call: the hex from level 2, the 16-colour form at 0 and 1", (t) => {
    t.after(() => {
        chalk.level = 1;
    });
    chalk.level = 2;
    assert.equal(toneColor("needsYou"), palette.needsYou);
    chalk.level = 3;
    assert.equal(toneColor("needsYou"), palette.needsYou);
    chalk.level = 0;
    assert.equal(toneColor("needsYou"), "yellow");
    chalk.level = 1;
    assert.equal(toneColor("needsYou"), "yellow");
});

test("at level 1 the badge is black on yellow, bold", () => {
    assert.equal(
        renderToString(h(Badge, { color: true }), { columns: 40 }),
        "\x1b[1m\x1b[43m\x1b[30m ! Needs you \x1b[39m\x1b[49m\x1b[22m",
    );
});

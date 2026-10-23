import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FORCE_COLOR = "3";
const { NOW, frameFile } = await import("./helpers/frameFile.js");

function read(raw: string) {
    const lines = frameFile({
        id: "pin",
        about: "A raw row.",
        size: { columns: 20, rows: 1 },
        color: true,
        now: new Date(NOW),
        raw,
        layout: { maxScroll: 0, pageSize: 0, step: 0, scroll: 0 },
    }).split("\n");
    const legend = lines.indexOf("legend");
    const layout = lines.findIndex((line) => line.startsWith("layout  "));
    return {
        styles: lines.slice(lines.indexOf("styles") + 1, legend - 1),
        legend: lines.slice(legend + 1, layout - 1),
    };
}

test("a style the legend has no letter for, or an escape that is not SGR, throws", () => {
    for (const [raw, error] of [
        ["\x1b[38;2;1;2;3mx\x1b[39m", /^Error: color #010203 is not in the legend/],
        ["\x1b[48;2;1;2;3mx\x1b[49m", /^Error: background #010203 is not in the legend/],
        ["\x1b[38;2;31;22;0mx\x1b[39m", /^Error: #1F1600 is the fill's text colour and no fill is open/],
        [
            "\x1b[48;2;231;188;112m\x1b[38;2;230;230;219mx\x1b[39m\x1b[49m",
            /^Error: the fill with "text" text is not in the legend/,
        ],
        ["\x1b[48;2;231;188;112mx\x1b[49m", /^Error: the fill with "none" text is not in the legend/],
        ["\x1b[38;2;169;198;225m\x1b[7mx\x1b[27m\x1b[39m", /^Error: inverse with notice is not in the legend/],
        ["\x1b[2Kx", /^Error: an escape that is not SGR/],
    ] as const)
        assert.throws(() => read(raw), error, JSON.stringify(raw));
});

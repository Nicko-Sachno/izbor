import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FORCE_COLOR = "3";
const { SAMPLE_IDS } = await import("./helpers/sampleSessions.js");
const { sampleWindow } = await import("./helpers/sampleWindow.js");
const { palette } = await import("../src/terminal/presentation.js");
const { renderTerminal } = await import("../src/terminal/render.js");

function styleAt(line: string, text: string) {
    const at = line.indexOf(text);
    assert.ok(at >= 0, `${text} is on the line: ${JSON.stringify(line)}`);
    const style = { color: "", bold: false, underline: false };
    for (const [, codes] of line.slice(0, at).matchAll(/\x1b\[([\d;]*)m/g)) {
        const [code, , ...rgb] = codes!.split(";");
        if (code === "38") style.color = `#${rgb.map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
        else if (code === "39") style.color = "";
        else if (code === "1") style.bold = true;
        else if (code === "22") style.bold = false;
        else if (code === "4") style.underline = true;
        else if (code === "24") style.underline = false;
        else if (!code || code === "0") Object.assign(style, { color: "", bold: false, underline: false });
    }
    return { ...style, color: style.color.toUpperCase() };
}

test("in the split, the selected row stays marked sage and bold while another row has focus, and no Open › is drawn", (t) => {
    const { app } = sampleWindow(t, { columns: 80, rows: 30 });
    const plain = (line: string) => line.replace(/\x1b\[[\d;]*m/g, "");
    const lines = () => renderTerminal(app.view, { columns: 160, rows: 30 }, true).lines;
    const style = (text: string) =>
        styleAt(
            lines()
                .slice(2)
                .find((line) => line.includes(text)) ?? "",
            text,
        );

    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "tab" });
    app.resize(160, 30);
    assert.equal(app.view.focused, SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[0]);
    assert.ok(
        !lines().some((line) => plain(line).includes("Open ›")),
        "no cue while the Brief is open beside the list",
    );
    assert.deepEqual(style("Fix the token"), { color: palette.focus, bold: true, underline: false });
    assert.deepEqual(style("Add CSV"), { color: palette.text, bold: false, underline: false });
});

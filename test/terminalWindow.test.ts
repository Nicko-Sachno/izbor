import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { render, renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { createTerminalController } from "../src/terminal/controller.js";
import { DETAIL_FOCUS, FIELD_FOCUS, HELP_FOCUS, projectFocus } from "../src/terminal/focus.js";
import { createSampleSource, createSampleWorld, SAMPLE_IDS, SAMPLE_SCENARIOS } from "./helpers/sampleSessions.js";
import { terminalLayout } from "../src/terminal/layout.js";
import {
    type Connection,
    type Observation,
    type ObservationSource,
    type IzborState,
    type RunningSession,
    type SessionList,
    type Snapshot,
    type ViewportLayout,
} from "../src/terminal/model.js";
import { projectsOf } from "../src/terminal/projects.js";
import { clip, wrapCut } from "../src/terminal/presentation.js";
import { renderTerminal } from "../src/terminal/render.js";
import { contains, explanationUnknown, TerminalScreen } from "../src/terminal/screen.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { storeContract } from "./helpers/storeContract.js";
import { settle } from "./support.js";
import { NO_WRITES, writersOf } from "./helpers/projectWriters.js";

chalk.level = 0;

function sampleApp(initialIds: readonly string[] = SAMPLE_IDS, columns = 80, rows = 24) {
    const source = createSampleSource({ scenario: "overview", animate: false });
    const app = createTerminalController(source, {
        ...writersOf(source.setup),
        initialIds,
        columns,
        rows,
        changed() {},
    });
    return { source, app };
}

function tabTo(app: ReturnType<typeof createTerminalController>, target: string) {
    const visited = new Set<string | null>();
    while (app.view.focused !== target) {
        assert.ok(!visited.has(app.view.focused), `Tab cannot reach ${target}`);
        visited.add(app.view.focused);
        app.keypress(undefined, { name: "tab" });
    }
}

const nonBlankLines = (frame: string[]) => frame.map((line) => line.trimEnd()).filter((line) => line.trim());

storeContract("the sample store", () => ({
    source: createSampleSource({ scenario: "overview", animate: false }),
    id: SAMPLE_IDS[0],
}));
storeContract("the fake store", () => ({ source: createFakeStore(), id: SAMPLE_IDS[0] }));

const SAMPLE = createSampleWorld().row(SAMPLE_IDS[2]);

function frames(row: Observation, now: Date, izbor?: IzborState) {
    const store = createFakeStore({ observations: [row], ...(izbor && { izbor }) });
    const app = createTerminalController(store, { ...NO_WRITES, columns: 120, rows: 80, changed() {} });
    const text = () =>
        renderTerminal(app.view, { columns: 120, rows: 80 }, false, now).lines.join("\n").replace(/\s+/g, " ");
    const compact = text();
    app.openSession(row.id);
    app.toggleMetadata();
    const full = text();
    app.dispose();
    return { compact, full };
}

test("updates preserve session order, focus, expansion and the field's text", (t) => {
    const { app, source } = sampleApp();
    t.after(() => app.dispose());
    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "return" });
    app.keypress(undefined, { name: "tab" });
    app.keypress("typed", {});
    source.setScenario("outdated");
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [...SAMPLE_IDS],
    );
    assert.equal(app.view.expanded, SAMPLE_IDS[0]);
    assert.equal(app.view.focused, FIELD_FOCUS);
    assert.equal(app.view.field.text, "typed");
    app.keypress(undefined, { name: "escape" });
    assert.equal(app.view.expanded, SAMPLE_IDS[0], "Esc in the field steps back to the Brief");
    assert.equal(app.view.focused, SAMPLE_IDS[0]);
    app.keypress(undefined, { name: "escape" });
    assert.equal(app.view.expanded, null);
    assert.equal(app.view.focused, SAMPLE_IDS[0]);
    assert.equal(app.view.field.text, "typed");
});

test("wide selection stays stable across attention updates and responsive layout changes", (t) => {
    const { app, source } = sampleApp(SAMPLE_IDS, 140);
    t.after(() => app.dispose());
    assert.equal(app.view.wide, true);
    assert.equal(app.view.selected, SAMPLE_IDS[0], "the first Brief fills the side pane immediately");
    assert.equal(app.view.focused, null, "startup focuses nothing");
    app.keypress(undefined, { name: "return" });
    assert.equal(app.view.focused, null, "Enter with nothing focused does nothing");
    app.scrollBy(2 - app.view.scroll, 2);
    app.openSession(SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[1]);
    assert.equal(app.view.focused, DETAIL_FOCUS);
    assert.equal(app.view.expanded, null);
    assert.equal(app.view.scroll, 2, "opening a side Brief leaves the overview in place");
    app.scrollDetailBy(5, 20);
    source.setScenario("missing-request");
    assert.equal(app.view.selected, SAMPLE_IDS[1], "another session needing attention never takes selection");
    assert.equal(app.view.detailScroll, 5);
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [...SAMPLE_IDS],
    );
    app.resize(139);
    assert.equal(app.view.wide, false);
    assert.equal(app.view.expanded, null, "shrinking returns to the overview");
    assert.equal(app.view.selected, SAMPLE_IDS[1]);
    app.resize(140);
    assert.equal(app.view.wide, true);
    assert.equal(app.view.selected, SAMPLE_IDS[1], "widening restores the same side Brief");
    assert.equal(app.view.detailScroll, 5);
    assert.equal(app.view.expanded, null);
    app.resize(139);
    app.openSession(SAMPLE_IDS[1]);
    app.scrollBy(7 - app.view.scroll, 7);
    app.resize(160);
    assert.equal(app.view.expanded, null, "an open narrow Brief moves to the side when it fits");
    assert.equal(app.view.detailScroll, 7, "moving the Brief to the side keeps its reading position");
    assert.equal(app.view.selected, SAMPLE_IDS[1]);
});

test("the side Brief has independent focus and scroll, and Help returns to it", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160);
    t.after(() => app.dispose());
    app.scrollBy(3 - app.view.scroll, 3);
    app.focusDetail();
    app.scrollDetailBy(4, 20);
    assert.equal(app.view.focused, DETAIL_FOCUS);
    assert.equal(app.view.scroll, 3);
    assert.equal(app.view.detailScroll, 4);
    app.keypress(undefined, { name: "pagedown" }, 20, 6);
    assert.equal(app.view.detailScroll, 10, "keyboard paging scrolls the focused Brief");
    assert.equal(app.view.scroll, 3);
    app.keypress(undefined, { name: "g", ctrl: true });
    assert.equal(app.view.help, true);
    app.back();
    assert.equal(app.view.help, false);
    assert.equal(app.view.focused, DETAIL_FOCUS);
    assert.equal(app.view.scroll, 3);
    assert.equal(app.view.detailScroll, 10);
    app.back();
    assert.equal(app.view.focused, SAMPLE_IDS[0], "Escape focuses the selected row without hiding its side Brief");
    assert.equal(app.view.selected, SAMPLE_IDS[0]);
    app.focusDetail();
    app.keypress("s", {});
    assert.equal(app.view.selected, SAMPLE_IDS[1], "the side shortcut stops the selected observation");
});

test("stopping a selected observation chooses an adjacent Brief and never leaves a stale selection", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.stopObserving(SAMPLE_IDS[0]);
    assert.equal(app.view.selected, SAMPLE_IDS[1], "removing another row keeps the selected Brief");
    app.stopObserving(SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[2], "the next row replaces a removed selected row");
    app.stopObserving(SAMPLE_IDS[2]);
    assert.equal(app.view.selected, null);
    assert.equal(app.view.sessions.length, 0);
    app.observe(SAMPLE_IDS[0]);
    assert.equal(app.view.selected, SAMPLE_IDS[0], "observing from empty restores a valid side Brief");
    app.observe(SAMPLE_IDS[1]);
    app.openSession(SAMPLE_IDS[1]);
    app.stopObserving(SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[0], "removing the last row falls back to its previous neighbor");
});

test("the stop news names the session by its Task, cut to 28 cells in quotes, says that it keeps running and how to bring it back, and wraps to a second row; a full-screen Brief returns to Sessions with the next row selected", (t) => {
    const KEEPS = "The session keeps running. Observe › on Home brings it back.";
    const { app } = sampleApp(SAMPLE_IDS, 80, 30);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.keypress("s", {});
    assert.equal(app.view.feedback, `Stopped observing “Add CSV export for invoices…”. ${KEEPS}`);
    assert.equal(app.view.feedbackIsError, false);
    assert.equal(app.view.expanded, null, "a full-screen Brief returns to Sessions");
    assert.equal(app.view.selected, SAMPLE_IDS[2], "the next row is selected");
    const page = renderTerminal(app.view, { columns: 80, rows: 30 }).lines.map((line) => line.trimEnd());
    assert.deepEqual(page.slice(-3), [
        "  Stopped observing “Add CSV export for invoices…”. The session keeps running.",
        "  Observe › on Home brings it back.",
        "                                                                 Help · Ctrl-G",
    ]);
});

test("Help restores the open Brief and scroll position", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    app.scrollBy(4 - app.view.scroll, 4);
    app.openSession(SAMPLE_IDS[1]);
    app.scrollBy(3 - app.view.scroll, 3);
    app.keypress(undefined, { name: "g", ctrl: true });
    assert.equal(app.view.help, true);
    assert.equal(app.view.scroll, 0);
    app.keypress(undefined, { name: "escape" });
    assert.equal(app.view.help, false);
    assert.equal(app.view.expanded, SAMPLE_IDS[1]);
    assert.equal(app.view.focused, SAMPLE_IDS[1]);
    assert.equal(app.view.scroll, 3);
    app.back();
    assert.equal(app.view.scroll, 4, "returning from the Brief restores the overview position");
});

test("the detail stop shortcut closes only its observation", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    app.keypress("s", {});
    assert.equal(app.view.sessions.length, 3, "s with nothing focused does nothing");
    app.openSession(SAMPLE_IDS[2]);
    app.keypress("s", {});
    assert.equal(app.view.expanded, null);
    assert.equal(app.view.focused, null);
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        SAMPLE_IDS.slice(0, 2),
    );
});

test("frames stay inside resized windows and keep the last line's Help only when the workspace fits", (t) => {
    const { app, source } = sampleApp();
    t.after(() => app.dispose());
    for (const scenario of SAMPLE_SCENARIOS) {
        source.setScenario(scenario);
        app.scrollBy(-app.view.scroll, 0);
        for (const [columns, rows] of [
            [80, 30],
            [60, 24],
            [140, 20],
            [160, 19],
            [320, 40],
            [40, 12],
            [39, 16],
            [80, 11],
            [12, 5],
        ]) {
            app.resize(columns!, rows!);
            const frame = renderTerminal(app.view, { columns: columns!, rows: rows! }, true);
            assert.ok(frame.lines.length <= rows!);
            for (const line of frame.lines) assert.ok(stringWidth(line) <= columns!);
            const text = stripVTControlCharacters(frame.lines.join("\n"));
            if (columns! >= 40 && rows! >= 12) assert.match(text, /Help · Ctrl-G[ │]*$/);
            else
                assert.doesNotMatch(
                    text,
                    /Help · Ctrl-G/,
                    "undersized windows show the resize message instead of clipped controls",
                );
        }
    }
});

const FIRST_WORDS = ["Fix the token", "Add CSV export", "Explain how request"];

test("the overview shows every row in stable order, its explanation wrapped to three lines at most, with width given to the workspace, one glyph per row and Open › on the marked row", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    assert.deepEqual(
        app.view.sessions.map(({ brief }) => brief!.explanation!.text.split(/\s+/).length),
        [3, 13, 25],
    );
    for (const columns of [60, 80, 120, 160, 320]) {
        app.resize(columns, 24);
        const geometry = terminalLayout(columns, 24);
        const frame = renderTerminal(app.view, { columns, rows: 24 });
        const overview = frame.lines.map((line) => line.slice(geometry.inset, geometry.inset + geometry.width));
        const text = overview.join("\n");
        const positions = FIRST_WORDS.map((words) => overview.findIndex((line) => line.includes(words)));
        assert.ok(
            positions.every((row) => row >= 0),
            "all three rows remain visible",
        );
        assert.deepEqual(
            [...positions].sort((a, b) => a - b),
            positions,
            "session order stays fixed",
        );
        for (const row of positions.slice(1))
            assert.equal(overview[row - 1]!.trim(), "", "normal-height sessions retain one separating row");
        const badge = overview.findIndex((line) => line.includes("! Needs you"));
        assert.ok(
            badge > 0 && overview[badge + 1]!.trimStart().startsWith("Bash: npm test invoices"),
            "the request stands under the badge",
        );
        assert.doesNotMatch(text, /Latest:/);
        const texts = overview.map((line) => line.slice(3).trimEnd());
        for (const { brief } of app.view.sessions) {
            const wrapped = wrapCut(brief!.explanation!.text, geometry.width - 3, 3).split("\n");
            const first = texts.indexOf(wrapped[0]!);
            assert.deepEqual(
                texts.slice(first, first + wrapped.length),
                wrapped,
                "the explanation wraps at the row's text width, three lines at most",
            );
        }
        for (const [index, row] of positions.entries()) {
            const line = overview[row]!;
            const glyph = [" * ", " ! ", " ✓ "][index]!;
            assert.ok(line.startsWith(glyph), `row ${index + 1} starts with its glyph after the gutter cell`);
            assert.ok(!line.slice(glyph.length).includes("*"), "no other * on the row's first line");
            assert.equal(line.includes("Open ›"), index === 0 && columns < 140, "Open › on the marked row only");
            if (line.includes("Open ›"))
                assert.equal(line.trimEnd().length, geometry.width, "Open aligns with the session pane edge");
        }
        assert.equal(frame.maxScroll, 0);
    }
});

test("split mode requires both 140 columns and 20 rows", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    for (const [columns, rows, split] of [
        [139, 20, false],
        [140, 19, false],
        [140, 20, true],
        [320, 19, false],
        [320, 20, true],
    ] as const) {
        app.resize(columns, rows);
        const { lines, detail } = renderTerminal(app.view, { columns, rows });
        assert.equal(app.view.wide, split);
        assert.equal(Boolean(detail), split);
        assert.equal(
            lines.some((line) => line.includes("Hide · h")),
            split,
        );
        const HELP = "Help · Ctrl-G";
        const edge = lines.at(-1)!.indexOf(HELP) + HELP.length - 1;
        assert.equal(edge, columns - 3);
        if (split) {
            const divider = 2 + Math.floor((columns - 9) * 0.6) + 2;
            for (let row = 1; row <= rows - 2; row++) {
                assert.equal(lines[row]![divider], "│", `the independent divider stays continuous through row ${row}`);
                assert.equal(lines[row]!.slice(divider - 2, divider), "  ", "the left divider gutter remains clear");
            }
            assert.ok(!lines.at(-1)!.includes("│"), "the last row holds no bar");
        }
    }
});

function sideHeading(app: ReturnType<typeof createTerminalController>, row = 1): string {
    const { inset, width, gap } = terminalLayout(160, 30);
    return renderTerminal(app.view, { columns: 160, rows: 30 }).lines[row]!.slice(inset + width + gap);
}

test("the side Brief's heading is the Task alone, Hide · h on the right; no line says Session or the short ID", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160, 30);
    t.after(() => app.dispose());
    assert.match(sideHeading(app), /^Fix the token refresh bug and add a regression test {2}Hide · h$/);
    assert.equal(sideHeading(app, 2).trimEnd(), "for expired access tokens.", "no Status after the last word");
    assert.equal(sideHeading(app).length, terminalLayout(160, 30).detailWidth, "Hide · h ends at the pane's edge");
    const text = renderTerminal(app.view, { columns: 160, rows: 30 }).lines.join("\n");
    assert.doesNotMatch(text, /Full Brief|Overview ‹|Show Brief/);
    assert.doesNotMatch(text, /Session |0926995f/, "the ID is in Metadata only");
    assert.match(
        text,
        /│ {2}Running authentication tests\. *\n.*│ {2}Latest: Bash: npm test auth *\n/,
        "Latest right under Now",
    );
});

test("a narrow Brief's top line is Back · Esc and the Task alone; Help's top line is the word Help alone", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 100, 30);
    t.after(() => app.dispose());
    const frame = () => renderTerminal(app.view, { columns: 100, rows: 30 }).lines;
    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "return" });
    const open = frame();
    assert.equal(
        open[1]!.trim(),
        "Back · Esc  Fix the token refresh bug and add a regression test for expired access tokens.",
        "the Task alone fits one line, with no Status after it",
    );
    assert.equal(open[2]!.trim(), "", "no Status line under the heading");
    assert.doesNotMatch(open.join("\n"), /Full Brief/);
    assert.doesNotMatch(open.join("\n"), /Session |0926995f/, "the ID is in Metadata only");
    app.keypress(undefined, { name: "g", ctrl: true });
    assert.equal(frame()[1]!.trim(), "Help");
    assert.match(frame().join("\n").replace(/\s+/g, " "), /h hide the side Brief/);
});

test("before the first brief, the heading is the short ID alone, with no Status, in both layouts", (t) => {
    const store = createFakeStore({
        observations: [{ id: SAMPLE_IDS[2], brief: null, connection: { state: "live" } }],
    });
    const app = createTerminalController(store, { ...NO_WRITES, columns: 160, rows: 30, changed() {} });
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[2]);
    assert.match(sideHeading(app), /^c8219b07 +Hide · h$/);
    app.resize(100, 30);
    app.openSession(SAMPLE_IDS[2]);
    const narrow = renderTerminal(app.view, { columns: 100, rows: 30 }).lines;
    assert.equal(narrow[1]!.trim(), "Back · Esc  c8219b07");
});

test("h from the list hides the side Brief, with no Show Brief: with nothing focused, and from a focused row that is not the selected one; the selected row then has the focus, h again does nothing, Enter on it brings the Brief back, and so does a click on another row", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160, 30);
    t.after(() => app.dispose());
    assert.equal(app.view.focused, null, "a window opens with nothing focused");
    assert.match(sideHeading(app, 2), /^for expired access tokens\. *$/);
    app.keypress("h", {});
    assert.equal(app.view.briefHidden, true, "h with nothing focused hides the side Brief");
    assert.equal(app.view.focused, SAMPLE_IDS[0], "the selected row has the focus after h");
    assert.doesNotMatch(renderTerminal(app.view, { columns: 160, rows: 30 }).lines.join("\n"), /Show Brief|Hide · h/);
    app.keypress(undefined, { name: "return" });
    app.keypress(undefined, { name: "escape" });
    app.keypress(undefined, { name: "tab" });
    assert.equal(app.view.focused, SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[0], "Tab moves the focus, not the selection");
    assert.equal(app.view.briefHidden, false, "Enter brought the Brief back");
    app.keypress("h", {});
    assert.equal(app.view.briefHidden, true, "h from a focused row hides the side Brief");
    assert.equal(app.view.focused, SAMPLE_IDS[0], "the selected row takes the focus");
    app.keypress("h", {});
    assert.equal(app.view.briefHidden, true, "hidden already: h does nothing");
    assert.equal(app.view.focused, SAMPLE_IDS[0]);
    app.keypress(undefined, { name: "return" });
    assert.match(
        sideHeading(app, 2),
        /^for expired access tokens\. *$/,
        "Enter on the selected row brings its Brief back",
    );
    app.keypress("h", {});
    app.openSession(SAMPLE_IDS[2]);
    assert.match(
        sideHeading(app),
        /^Explain how request .* {2}Hide · h$/,
        "a click on another row brings its Brief back",
    );
    assert.match(sideHeading(app, 2), /configured\. *$/);
});

test("tight heights remove session gaps without changing order", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    for (const rows of [19, 20]) {
        app.resize(100, rows);
        const { lines } = renderTerminal(app.view, { columns: 100, rows });
        const firstExplanation = lines.findIndex((line) => line.includes("Running authentication tests."));
        const secondTask = lines.findIndex((line) => line.includes("Add CSV export"));
        assert.ok(firstExplanation >= 0 && secondTask >= 0);
        assert.equal(secondTask - firstExplanation - 1, rows < 20 ? 0 : 1);
    }
});

test("compact Brief prioritizes current work and reveals metadata explicitly", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160, 24);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    const geometry = terminalLayout(160, 24);
    const text = () =>
        renderTerminal(app.view, { columns: 160, rows: 24 })
            .lines.map((line) => line.slice(geometry.inset + geometry.width + geometry.gap))
            .join("\n");
    const compact = text();
    for (const label of ["Now", "Needs you", "Last change"]) assert.match(compact, new RegExp(label));
    assert.match(compact, /invoice tests/);
    assert.equal(
        compact.replace(/\s+/g, " ").match(/customer, and total\./g)?.length,
        1,
        "the Task once, in the heading",
    );
    assert.doesNotMatch(compact, /^Task *$/m, "no Task label under Needs you");
    assert.doesNotMatch(compact, /Latest:/, "Latest shows while Working only");
    assert.doesNotMatch(compact, /Metadata|Summary requested|From transcript|a7312ce4-782a/);
    app.toggleMetadata();
    assert.equal(app.view.metadataExpanded, true);
    let metadata = "";
    const first = renderTerminal(app.view, { columns: 160, rows: 24 });
    for (let scroll = 0; scroll <= (first.detail?.maxScroll ?? 0); scroll++) {
        app.scrollDetailBy(scroll - app.view.detailScroll, first.detail?.maxScroll ?? 0);
        metadata += text() + "\n";
    }
    assert.match(metadata, /a7312ce4-782a-45a0-a84c-e834c934b2a7/);
    assert.match(metadata, /transcript/);
    app.toggleMetadata();
    assert.equal(app.view.metadataExpanded, false);
});

test("m brings Metadata's last line into view, and m again restores the scroll the Brief had", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 80, 12);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    const frame = () => renderTerminal(app.view, { columns: 80, rows: 12 });
    const closed = frame().maxScroll;
    assert.ok(closed >= 2, "the Brief page scrolls at 12 rows");
    app.scrollBy(1 - app.view.scroll, 1);
    app.toggleMetadata();
    const open = frame();
    assert.ok(open.maxScroll > closed, "Metadata is under the control line");
    assert.match(open.lines.join("\n"), /From hook\s*\n.*┌─/, "its last line is the body's last row, above the field");
    app.toggleMetadata();
    assert.equal(app.view.scroll, 1);
    assert.equal(frame().maxScroll, closed);
});

test("wrapCut keeps a text of three lines or fewer whole, and ends a longer one's third line with …, never past the columns", () => {
    assert.equal(wrapCut("short", 20, 3), "short");
    assert.equal(wrapCut("one two three", 5, 3), "one\ntwo\nthree");
    assert.equal(wrapCut("one two three four", 5, 3), "one\ntwo\nthre…");
    assert.equal(wrapCut("aa bb cc dd", 3, 3), "aa\nbb\ncc…");
    assert.equal(wrapCut("one two three", 9, 3, 4), "one two\nthree");
    assert.equal(wrapCut("one two", 9, 3, 4), "one\ntwo");
    assert.equal(wrapCut("one two three four five", 9, 2, 4), "one two\nthre…");
    assert.equal(
        wrapCut("aaaa bbbb cccc dddd eeee ffff gggg hhhh", 20, 3, 12),
        "aaaa bbbb cccc dddd\neeee ffff gggg\nhhhh",
    );
    assert.equal(wrapCut("Short text here.", 37, 3, 33), "Short text here.\n");
    assert.equal(wrapCut("one two three", 9, 3, 9), "one two\nthree\n");
});

test("the heading cuts a Task at three lines with … and no Status after it, and Metadata then holds it whole", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 80, 60);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.view.sessions[1]!.brief!.task!.text = `First ${"word ".repeat(60)}last.`;
    const text = () => renderTerminal(app.view, { columns: 80, rows: 60 }).lines.join("\n");
    const lines = text().split("\n");
    assert.match(lines[1]!, /^ {2}Back · Esc {2}First word/);
    assert.match(lines[3]!, /^ {14}(word )+\S*… *$/, "the third line ends with …, no Status after it");
    assert.doesNotMatch(lines[4]!, /word/, "nothing of the Task follows it");
    assert.doesNotMatch(text(), /last\.|^ {2}Task *$/m);
    app.toggleMetadata();
    assert.match(text().replace(/\s+/g, " "), /Session ID .* Task First (word )+last\. Task source/);
});

test("a Sessions row's Task wraps over the row's width, three lines at most, the third ending with …, and its Status line follows", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 80, 30);
    t.after(() => app.dispose());
    app.view.sessions[2]!.brief!.task!.text = `First ${"word ".repeat(60)}last.`;
    const lines = renderTerminal(app.view, { columns: 80, rows: 30 }).lines;
    const first = lines.findIndex((line) => line.includes("First word"));
    assert.match(lines[first + 1]!, /^ {5}word/);
    assert.match(lines[first + 2]!, /… *$/, "the third line ends with …");
    assert.equal(lines[first + 3]!.trim(), "Idle", "the Status line under the Task's last line");
    assert.doesNotMatch(lines.join("\n"), /last\./);
});

test("a Sessions row's explanation wraps over the row's width, three lines at most, the third ending with …; an outdated one keeps its whole tail on its last line, and Explanation unknown stays one line", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 80, 30);
    t.after(() => app.dispose());
    const brief = app.view.sessions[2]!.brief!;
    const rows = () => renderTerminal(app.view, { columns: 80, rows: 30 }).lines;
    const at = (lines: string[], words: string) => lines.findIndex((line) => line.includes(words));

    brief.explanation = { text: `First ${"word ".repeat(60)}last.`, at: brief.explanation!.at };
    let lines = rows();
    let first = at(lines, "First word");
    assert.match(lines[first - 1]!, /^ {5}Idle/, "the explanation stands under the Status line");
    assert.match(lines[first + 1]!, /^ {5}word/);
    assert.match(lines[first + 2]!, /^ {5}word.*… *$/, "the third line ends with …");
    assert.equal(lines[first + 3]!.trim(), "", "nothing more of it");
    assert.doesNotMatch(lines.join("\n"), /last\./);

    brief.explanation = { text: `Second ${"word ".repeat(14)}end.`, at: brief.explanation.at };
    lines = rows();
    first = at(lines, "Second word");
    assert.match(lines[first + 1]!, /^ {5}word.*end\. *$/, "a shorter one is whole on two lines, with no …");
    assert.doesNotMatch(lines.join("\n"), /…/);

    const reason = "the request finished";
    brief.explanation = { text: `Third ${"word ".repeat(60)}last.`, at: brief.explanation.at, outdatedReason: reason };
    lines = rows();
    first = at(lines, "Third word");
    assert.match(
        lines[first + 2]!,
        new RegExp(`^ {5}word.*… · outdated: ${reason} *$`),
        "the tail ends the third line",
    );

    brief.explanation = { text: "Short text here.", at: brief.explanation.at, outdatedReason: reason };
    const narrow = renderTerminal(app.view, { columns: 40, rows: 30 }).lines;
    first = at(narrow, "Short text here.");
    assert.match(narrow[first]!, /^ {5}Short text here\. *$/);
    assert.match(narrow[first + 1]!, new RegExp(`^ {5}· outdated: ${reason} *$`), "the tail ends the last line");
    assert.doesNotMatch(narrow.join("\n"), /undefined/);
    assert.ok(narrow.every((line) => stringWidth(line) <= 40));

    brief.explanation = null;
    brief.explanationUnknownReason = `the summary request failed ${"badly ".repeat(30)}`;
    lines = rows();
    first = at(lines, "Explanation unknown");
    assert.match(lines[first]!, /… *$/, "Explanation unknown is cut on its one line");
    assert.equal(lines[first + 1]!.trim(), "");
});

test("Metadata focuses the Brief so its keyboard scrolling scrolls it", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160, 24);
    t.after(() => app.dispose());
    app.toggleMetadata();
    assert.equal(app.view.metadataExpanded, true);
    assert.equal(app.view.focused, DETAIL_FOCUS);
    app.measured({ maxScroll: 0, pageSize: 1, scroll: 0, detail: { maxScroll: 20, pageSize: 5, scroll: 20 } });
    app.keypress(undefined, { name: "pageup" }, 20, 5);
    assert.equal(app.view.detailScroll, 15);
    assert.equal(app.view.scroll, 0);
});

test("stopping another observation preserves the open narrow Brief's reading position", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.scrollBy(4 - app.view.scroll, 4);
    app.stopObserving(SAMPLE_IDS[0]);
    assert.equal(app.view.selected, SAMPLE_IDS[1]);
    assert.equal(app.view.expanded, SAMPLE_IDS[1]);
    assert.equal(app.view.scroll, 4);
});

test("hiding Brief and undersized windows preserve selection", (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 160, 24);
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.toggleMetadata();
    app.hideBrief();
    assert.equal(app.view.briefHidden, true);
    const hidden = renderTerminal(app.view, { columns: 160, rows: 24 });
    assert.equal(hidden.detail, undefined);
    assert.doesNotMatch(hidden.lines.join("\n"), /Hide · h/);
    const last = hidden.lines.at(-1)!.trimEnd();
    assert.ok(last.endsWith("Help · Ctrl-G"), last);
    assert.equal(last.length - 1, 157, "the last line takes the full width");
    for (const [columns, rows] of [
        [39, 24],
        [160, 11],
        [160, 24],
    ])
        app.resize(columns!, rows!);
    assert.equal(app.view.selected, SAMPLE_IDS[1]);
    assert.equal(app.view.metadataExpanded, true);
    assert.equal(app.view.briefHidden, true, "resizing does not undo the user's Hide choice");
    app.openSession(SAMPLE_IDS[1]);
    assert.equal(app.view.briefHidden, false);
    assert.equal(app.view.metadataExpanded, true, "opening the same session keeps its Metadata");
    assert.ok(renderTerminal(app.view, { columns: 160, rows: 24 }).detail);
});

test("keyboard focus does not masquerade as a second selected session", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    app.resize(160);
    app.keypress(undefined, { name: "tab" });
    app.keypress(undefined, { name: "tab" });
    const frame = renderTerminal(app.view, { columns: 160, rows: 24 });
    const text = frame.lines.join("\n");
    assert.equal(app.view.focused, SAMPLE_IDS[1]);
    assert.equal(app.view.selected, SAMPLE_IDS[0]);
    assert.equal(text.match(/Selected ·/g)?.length, 1);
    assert.doesNotMatch(text, /Focused ·/, "no Focused label");
    assert.doesNotMatch(text, /Open ›/, "no cue while the Brief is open beside the list");
    assert.match(text, / {2}Hide · h\n.*│ {2}for expired access tokens\. *\n/);
});

test("a short window scrolls the rows under the last line, each explanation cut at its third line", (t) => {
    const { app, source } = sampleApp();
    t.after(() => app.dispose());
    const compact = renderTerminal(app.view, { columns: 60, rows: 12 });
    assert.ok(compact.maxScroll > 0);
    let all = "";
    for (let scroll = 0; scroll <= compact.maxScroll; scroll++) {
        app.scrollBy(scroll - app.view.scroll, compact.maxScroll);
        const frame = renderTerminal(app.view, { columns: 60, rows: 12 });
        all += `${frame.lines.join("\n")}\n`;
        assert.match(frame.lines.join("\n"), /Help · Ctrl-G/, "the last line stays while the overview scrolls");
    }
    assert.doesNotMatch(
        all.replace(/\s+/g, " "),
        /stop retrying automatically\./,
        "a row's explanation is cut at its third line",
    );
    assert.match(
        all,
        /Traced the retry logic[^\n]*\n {5}[^\n]+\n {5}[^\n]*…/,
        "the cut explanation's third line ends with …",
    );
    app.scrollBy(-app.view.scroll, 0);
    source.setScenario("missing-request");
    const waiting = renderTerminal(app.view, { columns: 60, rows: 24 });
    assert.match(waiting.lines.join("\n"), /Unknown · Izbor reports waiting/);
});

test("an expanded Brief retains full text through scrolling and strips hostile control sequences", (t) => {
    const { app } = sampleApp();
    t.after(() => app.dispose());
    app.openSession(SAMPLE_IDS[1]);
    app.toggleMetadata();
    const session = app.view.sessions[1]!;
    session.brief!.task!.text = `Beginning ${"a long prompt ".repeat(35)} Ending\x1b[2J\x1b]0;injected-title\x07`;
    const first = renderTerminal(app.view, { columns: 80, rows: 40 }, false);
    assert.ok(first.maxScroll > 0);
    let all = "";
    for (let scroll = 0; scroll <= first.maxScroll; scroll += 1) {
        app.scrollBy(scroll - app.view.scroll, first.maxScroll);
        all += renderTerminal(app.view, { columns: 80, rows: 40 }, false).lines.join("\n");
    }
    assert.match(all, /Beginning/);
    assert.match(all, /Ending/);
    assert.match(all, /npm test invoices/);
    assert.match(all, /Updated|Last observed/);
    assert.ok(!all.includes("\x1b"));
    assert.ok(!all.includes("injected-title"));
});

test("every connection state shows its own label: the Brief's whole words, the row's short cause after its Status word; the Brief's retry is counted from the frame's time, rounded up, and once its time has come no count shows, never 0 s; the row never counts down", () => {
    const now = new Date("2026-10-06T14:00:00.000Z");
    const later = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
    const since = later(-6);
    const message = "GET /sessions/c8219b07/stream is not an address Izbor knows";
    const last = "▲ last known Brief";
    const catching = "▲ Catching up… · last known Brief";
    const disconnected = "▲ Disconnected · last known Brief";
    const labels: [Connection, string, string][] = [
        [{ state: "connecting" }, "Catching up…", catching],
        [{ state: "catching up" }, "Catching up…", catching],
        [
            { state: "stopped", why: "deleted" },
            "Stopped · a client stopped Izbor's watch of this session",
            "▲ Stopped · last known Brief",
        ],
        [{ state: "stopped", why: "izbor stopping" }, "Stopped · Izbor stopped", last],
        [{ state: "disconnected", since }, "Disconnected", disconnected],
        [{ state: "disconnected", since, retryAt: later(4) }, "Disconnected · retrying in 4 s", disconnected],
        [{ state: "disconnected", since, retryAt: later(0.4) }, "Disconnected · retrying in 1 s", disconnected],
        [{ state: "disconnected", since, retryAt: later(0) }, "Disconnected", disconnected],
        [{ state: "disconnected", since, retryAt: later(-3) }, "Disconnected", disconnected],
        [{ state: "izbor away", reason: "not running" }, "Izbor is not running", last],
        [
            { state: "izbor away", reason: "not running", retryAt: later(10) },
            "Izbor is not running · retrying in 10 s",
            last,
        ],
        [{ state: "izbor away", reason: "not running", retryAt: later(0) }, "Izbor is not running", last],
        [{ state: "izbor away", reason: "stopping" }, "Izbor is stopping", last],
        [{ state: "izbor away", reason: "stopping", retryAt: later(2) }, "Izbor is stopping · retrying in 2 s", last],
        [
            { state: "refused", status: 404, message },
            `Izbor refused · 404 · ${message}`,
            `▲ Izbor refused · 404 · ${message} · last known Brief`,
        ],
    ];
    for (const [connection, label, rowShown] of labels) {
        const { compact, full } = frames({ ...SAMPLE, connection }, now);
        const shown = `▲ ${label} · last known Brief`;
        assert.ok(compact.includes(`Idle · ${clip(rowShown, 106)}`), `the row says ${rowShown}: ${compact}`);
        assert.doesNotMatch(compact, /retrying in/, "the row never counts down");
        assert.ok(full.includes(shown), `the full Brief says ${shown}: ${full}`);
        if (!label.includes("retrying")) assert.doesNotMatch(full, /retrying in/);
        if (connection.state !== "disconnected") assert.doesNotMatch(compact + full, /Disconnected/);
    }
    const izborDown = { state: "not running", address: "127.0.0.1:4319" } as const;
    const down = frames({ ...SAMPLE, connection: { state: "disconnected", since } }, now, izborDown);
    assert.ok(down.compact.includes("Idle · ▲ last known Brief"), down.compact);
    assert.doesNotMatch(down.compact, /Disconnected/);
    const live = frames(SAMPLE, now);
    assert.ok(live.compact.includes(" Idle Traced the retry logic"), live.compact);
    assert.doesNotMatch(live.compact + live.full, /last known Brief|Catching up|Disconnected|Stopped|Izbor is|refused/);
});

test("Enter on a stopped row, a click on it, or Open › on its Home line reconnects it: the stopped sample goes live in place and its Brief opens", (t) => {
    const { app, source } = sampleApp(SAMPLE_IDS, 160, 32);
    t.after(() => app.dispose());
    const third = () => app.view.sessions[2]!.connection.state;
    source.setScenario("stopped");
    assert.equal(third(), "stopped");

    app.openSession(SAMPLE_IDS[2]);
    assert.equal(third(), "live");
    assert.equal(app.view.selected, SAMPLE_IDS[2]);
    const list = renderTerminal(app.view, { columns: 160, rows: 32 }).lines.map((line) => line.split("│")[0]!.trim());
    assert.equal(list[list.findIndex((line) => line.includes("Explain how request")) + 1], "Idle", list.join("\n"));
    assert.ok(!list.some((line) => line.includes("last known Brief")), list.join("\n"));

    source.setScenario("overview");
    source.setScenario("stopped");
    assert.equal(third(), "stopped");
    app.showScreen("home");
    app.observeAndOpen(SAMPLE_IDS[2]);
    assert.equal(third(), "live");
    assert.equal(app.view.screen, "sessions");

    const before = structuredClone(app.view.sessions[0]!.connection);
    app.openSession(SAMPLE_IDS[0]);
    assert.deepEqual(app.view.sessions[0]!.connection, before, "a row with an open stream is left alone");
});

test("a row with no brief yet says Catching up… and shows no unknown field", () => {
    const { compact, full } = frames(
        { id: SAMPLE_IDS[2], brief: null, connection: { state: "connecting" } },
        new Date(),
    );
    for (const text of [compact, full]) {
        assert.match(text, /Catching up…/);
        assert.doesNotMatch(text, /unknown/i, text);
    }
});

test("a row with a gap says when Izbor did not observe it, in local clock times", () => {
    const at = (second: number) => new Date(2026, 9, 6, 14, 2, second).toISOString();
    const { compact, full } = frames({ ...SAMPLE, gap: { from: at(10), to: at(31) } }, new Date());
    for (const text of [compact, full])
        assert.ok(text.includes("▲ Izbor did not observe this session between 14:02:10 and 14:02:31"), text);
});

const projectLine = (words: string, cue: string, width: number) => `${words.padEnd(width - cue.length)}${cue}`;

test("a project line's cue ends at the pane's right edge and keeps its words while the line fits one row: else the Briefs update late tail goes, then the cue is › alone", (t) => {
    for (const [columns, hooks, plugin] of [
        [80, "Add hooks ›", "Add plugin · answer from Izbor ›"],
        [44, "Add hooks ›", "›"],
        [43, "Add hooks ›", "›"],
        [40, "Add hooks ›", "›"],
    ] as const) {
        const { app } = sampleApp([], columns, 30);
        t.after(() => app.dispose());
        const frame = renderTerminal(app.view, { columns, rows: 30 }, false).lines;
        const { inset, width } = terminalLayout(columns, 30);
        for (const [name, cue] of [
            ["invoice-api", plugin],
            ["example-api", hooks],
        ]) {
            const line = frame.find((line) => line.startsWith(`     ${name} `))!.trimEnd();
            assert.ok(line.endsWith(` ${cue}`), `${columns}: ${line}`);
            assert.equal(line.length - 1, inset + width - 1, `${columns}: ${line}`);
            assert.equal(line.includes("Briefs update late"), name === "example-api" && columns === 80, line);
        }
        assert.ok(!frame.some((line) => /^ +(· )?(Briefs )?(update )?late/.test(line)), `${columns}: no wrapped tail`);
    }
});

test("Enter on a project line acts at once: Add hooks › adds the hooks, Add plugin · answer from Izbor › the plugin, a bare line nothing; each cue goes once the list shows the change", async (t) => {
    const { app } = sampleApp([], 80, 30);
    t.after(() => app.dispose());
    const cueOf = (name: string) =>
        renderTerminal(app.view, { columns: 80, rows: 30 })
            .lines.find((line) => line.trimEnd() === `     ${name}` || line.startsWith(`     ${name} `))
            ?.trimEnd();
    app.view.feedback = "";
    tabTo(app, projectFocus(join(homedir(), "izbor")));
    app.keypress(undefined, { name: "return" });
    assert.equal(app.view.feedback, "", "hooks and plugin both: nothing to add");
    tabTo(app, projectFocus(join(homedir(), "example-api")));
    app.keypress(undefined, { name: "return" });
    assert.deepEqual([app.view.feedback, app.view.feedbackIsError], ["Added Izbor's hooks to example-api.", false]);
    await settle();
    assert.match(cueOf("example-api")!, /Add plugin · answer from Izbor ›$/, "hooks there: the plugin is next");
    tabTo(app, projectFocus(join(homedir(), "invoice-api")));
    app.keypress(undefined, { name: "return" });
    assert.equal(app.view.feedback, "Adding Izbor's plugin…");
    await settle();
    assert.deepEqual([app.view.feedback, app.view.feedbackIsError], ["Added Izbor's plugin to invoice-api.", false]);
    assert.equal(cueOf("invoice-api"), "     invoice-api", "hooks and plugin both: a bare line");
    assert.equal(app.view.screen, "home");
});

test("a click on a project line's cue is that project's target and acts as Enter does; its name and the blank before the cue are no target; a bare line is its own target and acts nothing", (t) => {
    const { app } = sampleApp([], 80, 30);
    t.after(() => app.dispose());
    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, scroll: 0 };
    renderToString(
        createElement(TerminalScreen, {
            view: app.view,
            size: { columns: 80, rows: 30 },
            color: false,
            onLayout: (next) => (layout = next),
        }),
        { columns: 80 },
    );
    const frame = renderTerminal(app.view, { columns: 80, rows: 30 }).lines;
    for (const [name, cue] of [
        ["invoice-api", "Add plugin · answer from Izbor ›"],
        ["example-api", "Add hooks ›"],
    ] as const) {
        const checkout = join(homedir(), name);
        const y = frame.findIndex((line) => line.startsWith(`     ${name} `));
        const line = frame[y]!;
        for (const x of [line.indexOf(name), line.indexOf(cue) - 1]) {
            const target = layout.targets?.find(({ rect }) => contains(rect, x, y));
            assert.equal(target, undefined, `${name}, column ${x}`);
        }
        for (const x of [line.indexOf(cue), line.lastIndexOf("›")]) {
            const target = layout.targets?.find(({ rect }) => contains(rect, x, y));
            assert.deepEqual(target?.type === "project" && target.checkout, checkout, `${name}, column ${x}`);
        }
    }
    app.view.feedback = "";
    app.actOnProjectLine(join(homedir(), "example-api"));
    assert.equal(app.view.feedback, "Added Izbor's hooks to example-api.", "the cue acts as Enter does");
    const bare = frame.findIndex((line) => line.trimEnd() === "     izbor");
    const target = layout.targets?.find(({ rect }) => contains(rect, frame[bare]!.indexOf("izbor"), bare));
    assert.deepEqual(target?.type === "project" && target.checkout, join(homedir(), "izbor"), "the bare line");
    app.view.feedback = "";
    app.actOnProjectLine(join(homedir(), "izbor"));
    assert.equal(app.view.feedback, "", "hooks and plugin both: nothing to add");
    app.showError("as it was");
    app.actOnProjectLine(join(homedir(), "elsewhere"));
    assert.equal(app.view.feedback, "as it was", "a folder Home does not list acts nothing");
});

const IZBOR_UP = { state: "up", address: "127.0.0.1:4319" } as const;

const WAITING: RunningSession = {
    id: "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff",
    name: "izbor-b8",
    status: "waiting",
    waitingFor: "permission prompt",
    checkout: join(homedir(), "code", "izbor"),
    hooks: true,
    acting: false,
};

const NOT_LOGGED_IN = "claude agents --json exited with code 3: Not logged in";

const listed = (...sessions: RunningSession[]): SessionList => ({
    state: "listed",
    sessions,
    at: "2026-10-06T14:00:00.000Z",
});

function upWindow(t: TestContext, snapshot: Partial<Snapshot>, columns = 80, rows = 24) {
    const store = createFakeStore({ izbor: IZBOR_UP, ...snapshot });
    const hooks = {
        port: 4319,
        write: ({ folder }: { folder: string }) =>
            ({ done: "added", checkout: folder, file: join(folder, ".claude", "settings.local.json") }) as const,
    };
    const app = createTerminalController(store, { ...NO_WRITES, hooks, columns, rows, changed() {} });
    t.after(() => app.dispose());
    const frame = (now?: Date) => renderTerminal(app.view, { columns, rows }, false, now).lines;
    return { app, store, frame, text: () => frame().join("\n").replace(/\s+/g, " ") };
}

test("the Full Brief says Last change, counted from the frame's time; Metadata keeps Last observed", () => {
    const now = new Date("2026-10-06T14:00:00.000Z");
    const row = {
        ...SAMPLE,
        brief: { ...SAMPLE.brief!, lastObserved: { at: "2026-10-06T13:59:58.000Z", from: "hook" } },
    };
    const first = frames(row as Observation, now).full;
    const later = frames(row as Observation, new Date(now.getTime() + 5000)).full;
    assert.ok(first.includes("Last change 2s ago"), first);
    assert.ok(later.includes("Last change 7s ago"), later);
    assert.match(first, /Last observed/);
    assert.doesNotMatch(first + later, /Updated/);
    const never = frames({ ...SAMPLE, brief: { ...SAMPLE.brief!, lastObserved: null } }, now).full;
    assert.ok(never.includes("Last change unknown"), never);
    assert.doesNotMatch(never, /Update time unknown/);
});

test("a brief with no explanation and no reason shows no explanation line and no Now field; a reason gives the row and the Brief a muted line", () => {
    const now = new Date();
    const quiet = { ...SAMPLE.brief!, explanation: null };
    assert.equal(quiet.explanationUnknownReason, undefined);
    assert.equal(explanationUnknown(undefined), undefined);
    const silent = frames({ ...SAMPLE, brief: quiet }, now);
    assert.ok(silent.compact.includes("Idle Help · Ctrl-G"), silent.compact);
    assert.ok(silent.full.includes("configured. Last change "), silent.full);
    assert.doesNotMatch(silent.full, /Latest:/);
    assert.doesNotMatch(silent.full, / Now /);
    assert.doesNotMatch(silent.compact + silent.full, /Explanation unknown/);

    const reason = "the summary request failed";
    assert.deepEqual(explanationUnknown(reason), { text: `Explanation unknown · ${reason}`, tone: "muted" });
    const failed = frames({ ...SAMPLE, brief: { ...quiet, explanationUnknownReason: reason } }, now);
    assert.ok(failed.compact.includes(`Idle Explanation unknown · ${reason}`), failed.compact);
    assert.ok(failed.full.includes(`Now Explanation unknown · ${reason}`), failed.full);

    const explanation = { text: "Tracing the retry logic.", at: now.toISOString(), outdatedReason: "reply finished" };
    const outdated = frames({ ...SAMPLE, brief: { ...SAMPLE.brief!, explanation } }, now);
    assert.ok(outdated.compact.includes("Idle Tracing the retry logic. · outdated: reply finished"), outdated.compact);
    assert.ok(outdated.full.includes("Now Outdated: reply finished Tracing the retry logic."), outdated.full);
});

test("the list groups sessions by project, in the order each first appears; same folder names show ~ paths", () => {
    const session = (id: string, checkout: string, hooks = true): RunningSession => ({
        id,
        name: id,
        checkout,
        hooks,
        acting: false,
    });
    const projects = projectsOf(
        [
            session("a1", "/Users/me/a/app"),
            session("p1", "/Users/me/izbor"),
            session("b1", "/srv/b/app", false),
            session("a2", "/Users/me/a/app"),
            session("p2", "/Users/me/izbor"),
            session("h1", "/Users/me"),
        ],
        "/Users/me",
    );
    assert.deepEqual(
        projects.map(({ name, checkout, hooks, sessions }) => ({
            name,
            checkout,
            hooks,
            ids: sessions.map(({ id }) => id),
        })),
        [
            { name: "~/a/app", checkout: "/Users/me/a/app", hooks: true, ids: ["a1", "a2"] },
            { name: "izbor", checkout: "/Users/me/izbor", hooks: true, ids: ["p1", "p2"] },
            { name: "/srv/b/app", checkout: "/srv/b/app", hooks: false, ids: ["b1"] },
            { name: "me", checkout: "/Users/me", hooks: true, ids: ["h1"] },
        ],
    );
    assert.deepEqual(projectsOf([], "/Users/me"), []);
    assert.equal(projectsOf([session("r1", "/")], "/Users/me")[0]!.name, "/");
});

const LONG: RunningSession = {
    ...WAITING,
    name: "Fix the invoices CSV export so totals match the ledger, and dates read as ISO 8601",
};

test("a session line reads name · Status under its project's line on one line at every width: the worktree goes first, then the wait's name, then the name is cut, and the badge stays", (t) => {
    const session: RunningSession = { ...LONG, worktree: "invoices" };
    const drawn = (columns: number) => {
        const lines = nonBlankLines(upWindow(t, { list: listed(session) }, columns, 40).frame());
        const project = lines.findIndex((line) => /^ {5}izbor /.test(line));
        assert.ok(project > 0, lines.join("\n"));
        assert.match(lines[project + 2]!, /Help · Ctrl-G$/, `${columns}: one line, then the last line`);
        return { line: lines[project + 1]!.slice(2), width: terminalLayout(columns, 40).width };
    };
    const whole = ` !   ${LONG.name} ·  ! Needs you`;
    assert.equal(drawn(160).line, `${whole}  permission prompt · worktree invoices`);
    assert.equal(drawn(130).line, `${whole}  permission prompt`);
    assert.equal(drawn(110).line, whole);
    for (const columns of [40, 60, 80, 100]) {
        const { line, width } = drawn(columns);
        assert.match(line, /^ ! {3}Fix the .*… · {2}! Needs you$/, `${columns}: ${line}`);
        assert.equal(line.length, width - 1, `${columns}: the pane's width, less the badge's last blank`);
    }
});

test("a session line's Status is the Brief's word, or the badge while it waits; a worktree is named by its folder; text from the list is cleaned; a project without hooks says so on its line only, and a project with hooks shows Add plugin · answer from Izbor ›", (t) => {
    const row = (session: Partial<RunningSession>) => ({ ...WAITING, waitingFor: undefined, ...session });
    const cases: [RunningSession, string[]][] = [
        [row({ status: "busy" }), ["   izbor", "     izbor-b8 · Working"]],
        [row({ status: "idle" }), ["   izbor", "     izbor-b8 · Idle"]],
        [row({ status: "waiting" }), ["   izbor", " !   izbor-b8 ·  ! Needs you"]],
        [row({ status: undefined }), ["   izbor", "     izbor-b8 · Unknown"]],
        [row({ status: "busy", worktree: "invoices" }), ["   izbor", "     izbor-b8 · Working · worktree invoices"]],
        [
            row({ status: "busy", worktree: "invoices", hooks: false }),
            ["   izbor · Briefs update late", "     izbor-b8 · Working · worktree invoices"],
        ],
        [
            row({ status: "waiting", waitingFor: "a\x1b[31mb\nc", worktree: "x\ty" }),
            ["   izbor", " !   izbor-b8 ·  ! Needs you  ab c · worktree x y"],
        ],
    ];
    for (const [session, [project, line]] of cases) {
        const { frame } = upWindow(t, { list: listed(session) }, 160);
        const lines = nonBlankLines(frame()).map((line) => line.slice(2));
        const { width } = terminalLayout(160, 24, false);
        const words = [
            projectLine(project!, session.hooks ? "Add plugin · answer from Izbor ›" : "Add hooks ›", width),
            line,
        ];
        const at = lines.indexOf(words[0]!);
        assert.deepEqual(lines.slice(at, at + words.length), words, lines.join("\n"));
        assert.match(lines[at + 2]!, /Help · Ctrl-G$/, "the session line is one line");
        assert.ok(!frame().join("\n").includes("\x1b"), "no escape sequence reaches the screen");
    }
});

test("Tab past its project's line then Enter, or a click anywhere on a session line, observes the session and opens its Brief", (t) => {
    const { app, frame } = upWindow(t, { list: listed(LONG) });
    for (let tab = 0; tab < 2; tab++) app.keypress(undefined, { name: "tab" });
    assert.equal(app.view.focused, LONG.id);

    const first = frame().findIndex((line) => line.includes("Fix the invoices"));
    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, scroll: 0 };
    renderToString(
        createElement(TerminalScreen, {
            view: app.view,
            size: { columns: 80, rows: 24 },
            color: false,
            onLayout: (next) => (layout = next),
        }),
        { columns: 80 },
    );
    for (const x of [2, 6, 77]) {
        const target = layout.targets?.find(({ rect }) => contains(rect, x, first));
        assert.deepEqual(target?.type === "session" && target.id, LONG.id, `column ${x} of the session line`);
    }
    assert.ok(frame()[first - 1]!.includes("izbor"), "the project line is the line above");
    const project = layout.targets?.find(({ rect }) => contains(rect, frame()[first - 1]!.lastIndexOf("›"), first - 1));
    assert.deepEqual(project?.type === "project" && project.checkout, LONG.checkout, "its project's line");
    assert.equal(
        layout.targets?.some(({ rect }) => contains(rect, 4, first + 1)),
        false,
        "the line below is no line's",
    );

    app.keypress(undefined, { name: "return" });
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [LONG.id],
    );
    assert.deepEqual([app.view.screen, app.view.expanded], ["sessions", LONG.id]);
});

test("observeAndOpen on a line not observed observes it, says so by its name, and opens its Brief: its page, or the side Brief with focus", (t) => {
    const narrow = upWindow(t, { list: listed(WAITING) }).app;
    narrow.observeAndOpen(WAITING.id);
    assert.deepEqual(
        narrow.view.sessions.map(({ id }) => id),
        [WAITING.id],
    );
    assert.deepEqual([narrow.view.screen, narrow.view.expanded], ["sessions", WAITING.id]);
    assert.deepEqual([narrow.view.feedback, narrow.view.feedbackIsError], ["Observing izbor-b8.", false]);

    const wide = upWindow(t, { list: listed(WAITING) }, 160).app;
    wide.observeAndOpen(WAITING.id);
    assert.deepEqual(
        [wide.view.screen, wide.view.selected, wide.view.focused, wide.view.expanded],
        ["sessions", WAITING.id, DETAIL_FOCUS, null],
    );
    assert.equal(wide.view.feedback, "Observing izbor-b8.");
});

test("observeAndOpen on an observed line, or on a Sessions row, opens its Brief and leaves the feedback as it was", (t) => {
    const { app } = upWindow(t, { list: listed(WAITING), observations: [{ ...SAMPLE, id: WAITING.id }, SAMPLE] });
    app.showScreen("home");
    app.showError("as it was");
    app.observeAndOpen(WAITING.id);
    assert.deepEqual([app.view.screen, app.view.expanded], ["sessions", WAITING.id]);
    assert.deepEqual([app.view.feedback, app.view.feedbackIsError], ["as it was", true]);
    assert.equal(app.view.sessions.length, 2, "no second row");
    app.back();
    app.observeAndOpen(SAMPLE.id);
    assert.deepEqual([app.view.expanded, app.view.feedback], [SAMPLE.id, "as it was"]);
});

test("observeAndOpen names a session with no name Unnamed session", (t) => {
    const { app } = upWindow(t, { list: listed({ ...WAITING, name: "  " }) });
    app.observeAndOpen(WAITING.id);
    assert.equal(app.view.feedback, "Observing Unnamed session.");
});

const IDLE: RunningSession = {
    id: "9e1f0b2a-5c3d-4e6f-8a7b-0c1d2e3f4a5b",
    name: "izbor-c3",
    status: "idle",
    checkout: WAITING.checkout,
    hooks: true,
    acting: false,
};

const ELSEWHERE: RunningSession = {
    id: "7c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
    name: "example-api-3a",
    status: "busy",
    checkout: "/srv/example-api",
    hooks: false,
    acting: false,
};

test("on Home, Tab and Down visit each project's line, then its session lines, then Help; Shift-Tab and Up go back; Sessions' order is its rows", (t) => {
    const { app } = upWindow(t, { list: listed(WAITING, ELSEWHERE, IDLE) });
    const order = [
        projectFocus(WAITING.checkout),
        WAITING.id,
        IDLE.id,
        projectFocus(ELSEWHERE.checkout),
        ELSEWHERE.id,
        HELP_FOCUS,
    ];
    const visit = (names: string[], shift = false) =>
        names.map((name) => (app.keypress(undefined, { name, shift }), app.view.focused));
    assert.deepEqual(visit(["tab", "down", "tab", "down", "tab", "tab"]), order);
    assert.deepEqual(
        [...visit(["tab"], true), ...visit(["up"]), ...visit(["tab"], true), ...visit(["up"])],
        [ELSEWHERE.id, projectFocus(ELSEWHERE.checkout), IDLE.id, WAITING.id],
    );
    assert.deepEqual(visit(["tab", "tab"], true), [projectFocus(WAITING.checkout), HELP_FOCUS], "the ring wraps");

    tabTo(app, ELSEWHERE.id);
    app.keypress(undefined, { name: "return" });
    assert.equal(app.view.screen, "sessions");
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [ELSEWHERE.id],
    );
    app.back();
    assert.deepEqual(
        visit(["tab", "tab", "tab"]),
        [HELP_FOCUS, ELSEWHERE.id, HELP_FOCUS],
        "no project line on Sessions",
    );
});

test("a session with no name reads Unnamed session; no Home line holds <id8> · for a listed session", (t) => {
    const unnamed = { ...IDLE, name: "" };
    const blank = { ...ELSEWHERE, name: "  " };
    for (const columns of [40, 80, 160]) {
        const { frame, text } = upWindow(t, { list: listed(unnamed, WAITING, blank) }, columns, 30);
        assert.ok(text().includes("Unnamed session · Idle"), text());
        assert.ok(text().includes("Unnamed session · Working"), text());
        for (const { id } of [unnamed, WAITING, blank])
            assert.deepEqual(
                frame().filter((line) => line.includes(`${id.slice(0, 8)} · `)),
                [],
                `${columns} columns`,
            );
    }
});

const ORDERS_REVIEW: RunningSession = {
    ...ELSEWHERE,
    id: "5b0e7c1d-2f4a-4c8e-9d36-7a1f0b2c3d4e",
    name: "Orders API review",
    status: "idle",
};

function mainPane(frame: string[]) {
    const lines = nonBlankLines(frame).map((line) => line.trim().replace(/ {2,}/g, " "));
    return lines.slice(
        lines.findIndex((line) => /^(\[ Home \] Sessions|Home \[ Sessions)/.test(line)),
        lines.findIndex((line) => line.startsWith("Help · Ctrl-G")),
    );
}

const waitingRow = ({ id }: RunningSession, selected = false) => [
    `▲ ${selected ? "Selected · " : ""}${id.slice(0, 8)} Open ›`,
    "▲ Catching up…",
];

test("Home lists every running session, one observed here ending Open ›; Sessions shows the rows alone", (t) => {
    const { app, frame } = upWindow(t, { list: listed(WAITING, ELSEWHERE, IDLE) }, 80, 30);
    assert.equal(app.view.screen, "home", "a window with no row opens on Home");
    app.observe(WAITING.id);
    assert.equal(app.view.screen, "sessions", "an observe shows Sessions");
    const NEWS = "Observing 4a979d7e.";
    assert.deepEqual(mainPane(frame()), ["[ Home ] Sessions · 1 Ctrl-O", ...waitingRow(WAITING, true), NEWS]);

    app.keypress(undefined, { name: "o", ctrl: true });
    assert.deepEqual(mainPane(frame()), [
        "Home [ Sessions · 1 ] Ctrl-O",
        "izbor Add plugin · answer from Izbor ›",
        "! izbor-b8 · ! Needs you permission prompt · Open ›",
        "izbor-c3 · Idle",
        "example-api · Briefs update late Add hooks ›",
        "example-api-3a · Working",
        NEWS,
    ]);
    const list = mainPane(frame()).slice(0, -1);
    assert.ok(!list.some((line) => line.includes("4a979d7e")), "Home shows no row");

    app.resize(160, 30);
    const wide = () => renderTerminal(app.view, { columns: 160, rows: 30 }).lines.join("\n");
    assert.doesNotMatch(wide(), /Hide · h/, "wide Home is full width");
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.match(wide(), /│ {2}4a979d7e +Hide · h/, "wide Sessions has the Brief beside it");
});

test("Ctrl-O and the tabs switch screens, each with its scroll; Esc steps back Brief → Sessions → Home; the last leave shows Home", (t) => {
    const { app, frame } = upWindow(t, { list: listed(WAITING, ELSEWHERE, IDLE) }, 80, 30);
    app.observe(ELSEWHERE.id);
    app.scrollBy(3 - app.view.scroll, 3);
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.deepEqual([app.view.screen, app.view.scroll], ["home", 0]);
    app.scrollBy(2 - app.view.scroll, 2);
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.deepEqual([app.view.screen, app.view.scroll], ["sessions", 3], "Sessions keeps its scroll");
    app.showScreen("home");
    assert.deepEqual([app.view.screen, app.view.scroll], ["home", 2], "and so does Home");

    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, scroll: 0 };
    renderToString(
        createElement(TerminalScreen, {
            view: app.view,
            size: { columns: 80, rows: 30 },
            color: false,
            onLayout: (next) => (layout = next),
        }),
        { columns: 80 },
    );
    const tabs = frame()[1]!;
    for (const [label, screen] of [
        ["[ Sessions", "sessions"],
        ["Home", "home"],
    ] as const) {
        const target = layout.targets?.find(({ rect }) => contains(rect, tabs.indexOf(label) + 2, 1));
        assert.deepEqual(target?.type === "tab" && target.screen, screen, label);
    }

    app.scrollBy(-app.view.scroll, 0);
    app.openSession(ELSEWHERE.id);
    assert.deepEqual([app.view.screen, app.view.expanded], ["sessions", ELSEWHERE.id], "a Brief opens from Home");
    app.keypress(undefined, { name: "escape" });
    assert.deepEqual([app.view.screen, app.view.expanded, app.view.focused], ["sessions", null, ELSEWHERE.id]);
    app.keypress(undefined, { name: "escape" });
    assert.deepEqual([app.view.screen, app.view.focused], ["home", null]);
    app.keypress(undefined, { name: "escape" });
    assert.deepEqual(
        [app.view.screen, app.view.focused],
        ["home", null],
        "on Home, Esc with nothing focused does nothing",
    );

    app.resize(160, 30);
    app.openSession(ELSEWHERE.id);
    assert.deepEqual([app.view.screen, app.view.focused], ["sessions", DETAIL_FOCUS]);
    app.keypress(undefined, { name: "escape" });
    assert.equal(app.view.focused, ELSEWHERE.id);
    app.keypress(undefined, { name: "escape" });
    assert.equal(app.view.screen, "home");

    app.resize(80, 30);
    app.openSession(ELSEWHERE.id);
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.deepEqual([app.view.screen, app.view.expanded], ["home", null]);
    app.keypress(undefined, { name: "o", ctrl: true });
    app.stopObserving(ELSEWHERE.id);
    assert.equal(app.view.screen, "home", "the last row left: Home");
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.deepEqual(mainPane(frame()), [
        "[ Home ] Sessions · 0 Ctrl-O",
        "No session observed. Ctrl-O opens Home.",
        "Stopped observing 7c2d4e6f. The session keeps running. Observe › on Home",
        "brings it back.",
    ]);
});

test("on Home, Tab goes through every project line and session line, then Help; Enter observes a session and opens its Brief, or opens an observed one's", (t) => {
    const { app, frame } = upWindow(t, { list: listed(WAITING, ELSEWHERE, IDLE, ORDERS_REVIEW) }, 160, 30);
    app.observe(IDLE.id);
    app.keypress(undefined, { name: "o", ctrl: true });
    const visited: (string | null)[] = [];
    for (let tab = 0; tab < 8; tab++) {
        app.keypress(undefined, { name: "tab" });
        visited.push(app.view.focused);
    }
    assert.deepEqual(visited, [
        projectFocus(WAITING.checkout),
        WAITING.id,
        IDLE.id,
        projectFocus(ELSEWHERE.checkout),
        ELSEWHERE.id,
        ORDERS_REVIEW.id,
        HELP_FOCUS,
        projectFocus(WAITING.checkout),
    ]);

    tabTo(app, WAITING.id);
    app.keypress(undefined, { name: "return" });
    assert.deepEqual([app.view.screen, app.view.focused, app.view.selected], ["sessions", DETAIL_FOCUS, WAITING.id]);
    assert.equal(app.view.feedback, "Observing izbor-b8.", "Enter on a line not observed observes it");

    app.keypress(undefined, { name: "o", ctrl: true });
    tabTo(app, IDLE.id);
    app.keypress(undefined, { name: "return" });
    assert.deepEqual([app.view.screen, app.view.focused, app.view.selected], ["sessions", DETAIL_FOCUS, IDLE.id]);
    assert.match(frame().join("\n"), /│ {2}9e1f0b2a +Hide · h/);
    assert.equal(app.view.feedback, "Observing izbor-b8.", "an observed line opens and says nothing new");

    app.resize(100, 30);
    app.keypress(undefined, { name: "o", ctrl: true });
    tabTo(app, IDLE.id);
    app.keypress(undefined, { name: "return" });
    assert.deepEqual([app.view.screen, app.view.expanded], ["sessions", IDLE.id], "narrow: the Brief's own page");
    assert.equal(renderTerminal(app.view, { columns: 100, rows: 30 }).lines[1]!.trim(), "Back · Esc  9e1f0b2a");
});

test("an observe while a narrow Brief or Help is open shows Sessions; one that answers already stays put", (t) => {
    const { app } = upWindow(t, { list: listed(WAITING, ELSEWHERE, IDLE) }, 80, 30);
    app.observe(WAITING.id);
    app.openSession(WAITING.id);
    app.observe(ELSEWHERE.id);
    assert.deepEqual([app.view.screen, app.view.expanded], ["sessions", null], "the Brief's page closes");
    app.openSession(WAITING.id);
    app.toggleHelp();
    app.observe(IDLE.id);
    assert.deepEqual([app.view.screen, app.view.expanded, app.view.help], ["sessions", null, false]);
    app.keypress(undefined, { name: "o", ctrl: true });
    app.observe(IDLE.id);
    assert.equal(app.view.feedback, "9e1f0b2a is already in this view.");
    assert.equal(app.view.screen, "home", "already: Home stays");
});

function refreshedHome(t: TestContext, sessions: RunningSession[], focused: string) {
    const { app, store } = upWindow(t, { list: listed(...sessions) });
    tabTo(app, focused);
    return { app, refresh: (...next: RunningSession[]) => store.set({ list: listed(...next) }) };
}

test("on Home, a refresh that drops the focused session line focuses the line now at its index; Tab and Enter go from there", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], IDLE.id);
    refresh(WAITING, ELSEWHERE);
    assert.equal(app.view.focused, projectFocus(ELSEWHERE.checkout), "the third line is example-api's now");
    app.keypress(undefined, { name: "tab" });
    assert.equal(app.view.focused, ELSEWHERE.id, "Tab goes on to the next line, not the first");
    app.keypress(undefined, { name: "tab", shift: true });
    app.keypress(undefined, { name: "return" });
    assert.deepEqual(
        [app.view.feedback, app.view.focused],
        ["Added Izbor's hooks to example-api.", projectFocus(ELSEWHERE.checkout)],
    );
});

test("on Home, a refresh that drops the focused project, sessions and all, focuses the line now at its index", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], projectFocus(WAITING.checkout));
    refresh(ELSEWHERE);
    assert.equal(app.view.focused, projectFocus(ELSEWHERE.checkout));
});

test("on Home, a refresh that drops the focused last line focuses the new last line", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE, ORDERS_REVIEW], ORDERS_REVIEW.id);
    refresh(WAITING, ELSEWHERE, IDLE);
    assert.equal(app.view.focused, ELSEWHERE.id);
    refresh(WAITING, IDLE);
    assert.equal(app.view.focused, IDLE.id);
    app.keypress(undefined, { name: "return" });
    assert.deepEqual(
        app.view.sessions.map(({ id }) => id),
        [IDLE.id],
    );
});

test("on Home, a refresh that empties the list focuses nothing", (t) => {
    for (const focused of [projectFocus(WAITING.checkout), IDLE.id, ELSEWHERE.id]) {
        const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], focused);
        refresh();
        assert.equal(app.view.focused, null, focused);
    }
});

test("on Home, a refresh that keeps the focused line leaves focus on it, even when the lines before it move", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], ELSEWHERE.id);
    refresh(ELSEWHERE, ORDERS_REVIEW, IDLE);
    assert.equal(app.view.focused, ELSEWHERE.id);
    tabTo(app, projectFocus(IDLE.checkout));
    refresh(ORDERS_REVIEW, ELSEWHERE, WAITING, IDLE);
    assert.equal(app.view.focused, projectFocus(IDLE.checkout));
});

test("a refresh moves no focus off Help, nor off a row on Sessions whose session ended", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], HELP_FOCUS);
    refresh(WAITING);
    assert.equal(app.view.focused, HELP_FOCUS);
    app.back();
    refresh(ELSEWHERE);
    assert.equal(app.view.focused, null);
    app.observe(ELSEWHERE.id);
    tabTo(app, ELSEWHERE.id);
    refresh();
    assert.deepEqual([app.view.screen, app.view.focused], ["sessions", ELSEWHERE.id], "the row stays a row");
});

test("Esc from Help over Home lands on the line now at the index of the line a refresh dropped", (t) => {
    const { app, refresh } = refreshedHome(t, [WAITING, ELSEWHERE, IDLE], IDLE.id);
    app.toggleHelp();
    refresh(WAITING, ELSEWHERE);
    assert.equal(app.view.focused, HELP_FOCUS, "Help keeps focus while it is open");
    app.keypress(undefined, { name: "escape" });
    assert.deepEqual([app.view.help, app.view.focused], [false, projectFocus(ELSEWHERE.checkout)]);
});

function drawnWindow(t: TestContext, app: ReturnType<typeof createTerminalController>, columns: number, rows: number) {
    let frame = "";
    const stdout = Object.assign(new EventEmitter(), {
        columns,
        rows,
        write: (chunk: string) => ((frame = String(chunk)), true),
    });
    const tree = () =>
        createElement(TerminalScreen, {
            view: app.view,
            size: { columns, rows },
            color: false,
            onLayout: (layout) => app.measured(layout),
        });
    const instance = render(tree(), {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
    });
    t.after(() => instance.unmount());
    return async () => {
        instance.rerender(tree());
        await settle();
        return frame.split("\n");
    };
}

test("Esc from a Brief opened on Home shows its row on Sessions, when the scroll Sessions kept would hide it", async (t) => {
    const ids = Array.from(
        { length: 12 },
        (_, i) => `${(i + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const list = listed(...ids.map((id, i) => ({ ...IDLE, id, name: `session ${i + 1}` })));
    const app = createTerminalController(createFakeStore({ izbor: IZBOR_UP, list }), {
        ...NO_WRITES,
        initialIds: ids,
        columns: 80,
        rows: 24,
        changed() {},
    });
    t.after(() => app.dispose());
    const draw = drawnWindow(t, app, 80, 24);
    assert.ok(!(await draw()).some((line) => line.includes("0000000b")), "the 11th row is below the fold");
    app.keypress(undefined, { name: "o", ctrl: true });
    tabTo(app, ids[10]!);
    app.keypress(undefined, { name: "return" });
    await draw();
    assert.equal(app.view.expanded, ids[10]);
    app.keypress(undefined, { name: "escape" });
    const lines = await draw();
    assert.deepEqual([app.view.screen, app.view.focused], ["sessions", ids[10]]);
    assert.ok(
        lines.some((line) => line.includes("0000000b")),
        lines.join("\n"),
    );
});

test("the marked row stays in view when an explanation above it and its own grow to three lines", async (t) => {
    const { app } = sampleApp(SAMPLE_IDS, 80, 16);
    t.after(() => app.dispose());
    app.showScreen("sessions");
    tabTo(app, SAMPLE_IDS[2]);
    const draw = drawnWindow(t, app, 80, 16);
    await draw();
    const at = app.view.sessions[0]!.brief!.explanation!.at;
    app.view.sessions[0]!.brief!.explanation = { text: `Above ${"word ".repeat(60)}last.`, at };
    app.view.sessions[2]!.brief!.explanation = { text: `Marked ${"word ".repeat(60)}last.`, at };
    await draw();
    const lines = await draw();
    const first = lines.findIndex((line) => line.includes("Marked word"));
    assert.ok(first > 0, lines.join("\n"));
    assert.match(lines[first + 2]!, /word.*… *$/, `its third line, the row's last, shows: ${lines.join("\n")}`);
});

test("the list says when it is loading, when it failed, and when no session runs", (t) => {
    const states: [SessionList, string[]][] = [
        [{ state: "loading" }, ["Looking for running Claude Code sessions…"]],
        [
            { state: "no list", reason: NOT_LOGGED_IN, last: [WAITING] },
            [`▲ No list: ${NOT_LOGGED_IN}`, "izbor", "! izbor-b8 · ! Needs you permission prompt"],
        ],
        [listed(), ["No Claude Code session runs. Start one with claude."]],
        [listed(WAITING), ["izbor", "! izbor-b8 · ! Needs you permission prompt"]],
    ];
    for (const [list, words] of states) {
        const { frame, text } = upWindow(t, { list }, 100, 30);
        const shown = text();
        let from = 0;
        for (const expected of ["Home [ Sessions", ...words]) {
            const at = shown.indexOf(expected, from);
            assert.ok(at >= from, `${list.state}: "${expected}" in order in ${shown}`);
            from = at + expected.length;
        }
        assert.doesNotMatch(shown, /trying again|sample|No sessions in this view/);
        assert.deepEqual(
            frame().filter((line) => line.includes("in izbor")),
            [],
            list.state,
        );
    }
    const now = new Date("2026-10-06T14:00:00.000Z");
    const { frame } = upWindow(t, { list: { state: "no list", reason: NOT_LOGGED_IN, last: [WAITING] } }, 100, 30);
    for (const at of [now, new Date(now.getTime() + 5000)])
        assert.deepEqual(
            frame(at).filter((line) => line.includes("No list")),
            [`  ▲ No list: ${NOT_LOGGED_IN}`],
        );
});

test("Home still lists a session while every session is observed, ending Open ›", (t) => {
    const { app, text } = upWindow(t, { list: listed(WAITING) }, 100, 30);
    app.observe(WAITING.id);
    app.showScreen("home");
    assert.ok(text().includes("izbor-b8 · ! Needs you permission prompt · Open ›"), text());
});

test("the Sessions tab counts every observed row, stopped and disconnected ones too", (t) => {
    const { frame } = upWindow(t, {
        observations: [
            { ...SAMPLE, id: SAMPLE_IDS[0], connection: { state: "stopped", why: "deleted" } },
            { ...SAMPLE, id: SAMPLE_IDS[1], connection: { state: "disconnected", since: "2026-10-06T14:00:00.000Z" } },
            SAMPLE,
        ],
    });
    assert.match(frame()[0]!, /^\s*Izbor ● up\s*$/);
    assert.match(frame()[1]!, /\[ Home \] {2}Sessions · 3 {2}Ctrl-O/);
});

const NOT_RUNNING = { state: "not running", address: "127.0.0.1:4319" } as const;

const IZBOR_WORDS = [
    [IZBOR_UP, "Izbor ● up"],
    [{ state: "stopping", address: "127.0.0.1:4319" }, "▲ Izbor ○ stopping"],
    [NOT_RUNNING, "▲ Izbor ○ not running on port 4319 · run izbor"],
    [{ state: "not answering", address: "127.0.0.1:4319" }, "▲ Izbor ○ not answering"],
    [{ state: "foreign", address: "127.0.0.1:4319" }, "▲ Izbor ○ port 4319 held by another program"],
] as const satisfies readonly (readonly [IzborState, string])[];

const topLine = (line: string) => line.match(/^\s*(\S.*?)\s*$/)?.[1] ?? null;

test("the top line says every Izbor state in its words, whole at 80 columns; at 40, the two texts with a port end in …", (t) => {
    for (const [izbor, words] of IZBOR_WORDS) {
        const { frame } = upWindow(t, { izbor });
        assert.equal(topLine(frame()[0]!), words, frame()[0]);
    }
    for (const [izbor, words] of IZBOR_WORDS) {
        const { frame } = upWindow(t, { izbor }, 40);
        const shown = topLine(frame()[0]!);
        if (words.length <= 36) assert.equal(shown, words);
        else assert.ok(shown?.endsWith("…") && words.startsWith(shown.slice(0, -1)), `${words}: ${frame()[0]}`);
    }
    const { frame } = upWindow(t, { izbor: NOT_RUNNING }, 40);
    assert.equal(topLine(frame()[0]!), "▲ Izbor ○ not running on port 4319 …");
});

test("an old build's notice stands at the top line's left end, cut to ▲ old build or left out so the Izbor state keeps its words", (t) => {
    const top = (source: Parameters<typeof createTerminalController>[0], columns = 80) => {
        const app = createTerminalController(source, { ...NO_WRITES, columns, rows: 24, oldBuild: true, changed() {} });
        t.after(() => app.dispose());
        return renderTerminal(app.view, { columns, rows: 24 }).lines[0]!.trimEnd();
    };
    const live = (izbor: IzborState, columns = 80) => top(createFakeStore({ izbor }), columns);
    const foreign = { state: "foreign", address: "127.0.0.1:4319" } as const;
    assert.match(live(IZBOR_UP), /^ {2}▲ old build · run npm run build {35}Izbor ● up$/);
    assert.match(live(NOT_RUNNING), /^ {2}▲ old build {19}▲ Izbor ○ not running on port 4319 · run izbor$/);
    assert.match(live(foreign), /^ {2}▲ old build · run npm run build {2}▲ Izbor ○ port 4319 held by another program$/);
    assert.match(live(IZBOR_UP, 40), /^ {2}▲ old build {15}Izbor ● up$/);
    assert.equal(live(NOT_RUNNING, 40), "  ▲ Izbor ○ not running on port 4319 …");
});

test("up → not running → up puts Izbor is back on the feedback line once, not as an error; changes while up add none", (t) => {
    const store = createFakeStore({ izbor: IZBOR_UP, list: listed(WAITING) });
    const app = createTerminalController(store, { ...NO_WRITES, columns: 80, rows: 24, changed() {} });
    t.after(() => app.dispose());
    store.set({ izbor: NOT_RUNNING });
    assert.equal(app.view.feedback, "");
    store.set({ izbor: IZBOR_UP });
    assert.equal(app.view.feedback, "Izbor is back");
    assert.equal(app.view.feedbackIsError, false);

    app.view.feedback = "";
    store.set({ izbor: { ...IZBOR_UP } });
    store.set({ list: listed(WAITING, IDLE) });
    store.observe(WAITING.id);
    assert.equal(app.view.feedback, "", "Izbor stayed up: nothing to say");

    for (const [izbor] of IZBOR_WORDS.slice(1)) {
        store.set({ izbor });
        store.set({ izbor: IZBOR_UP });
        assert.equal(app.view.feedback, "Izbor is back", izbor.state);
        app.view.feedback = "";
    }
});

test("a store that starts up leaves the first frame's note in place", (t) => {
    const store = createFakeStore({ izbor: IZBOR_UP, list: listed(WAITING) });
    const note = "Started Izbor in the background · pid 51234";
    const app = createTerminalController(store, { ...NO_WRITES, columns: 80, rows: 24, note, changed() {} });
    t.after(() => app.dispose());
    store.set({ list: listed(WAITING, IDLE) });
    store.set({ izbor: { ...IZBOR_UP } });
    assert.equal(app.view.feedback, note);
});

for (const columns of [80, 160]) {
    for (const fromBrief of [false, true]) {
        test(`opening a session from Help over ${fromBrief ? "a Brief" : "Sessions"} at ${columns} columns dismisses Help and keeps the overview scroll`, (t) => {
            const { app } = sampleApp(SAMPLE_IDS, columns, 30);
            t.after(() => app.dispose());
            app.scrollBy(7, 100);
            if (fromBrief) {
                app.openSession(SAMPLE_IDS[0]);
                if (columns < 140) app.scrollBy(4, 100);
                else app.scrollDetailBy(4, 100);
            }
            app.toggleHelp();
            app.scrollBy(2, 100);
            app.openSession(SAMPLE_IDS[2]);
            assert.equal(app.view.help, false);
            assert.equal(app.view.selected, SAMPLE_IDS[2]);
            assert.equal(app.view.focused, columns < 140 ? SAMPLE_IDS[2] : DETAIL_FOCUS);
            app.back();
            assert.equal(app.view.screen, "sessions");
            assert.equal(app.view.expanded, null);
            assert.equal(app.view.focused, SAMPLE_IDS[2]);
            assert.equal(app.view.scroll, 7, "return to the overview's scroll, never Help's scroll");
        });
    }
}

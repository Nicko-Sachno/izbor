import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import chalk from "chalk";
import { createTerminalController, type TerminalController } from "../src/terminal/controller.js";
import { createSampleWorld, SAMPLE_IDS, withoutPlugin } from "./helpers/sampleSessions.js";
import { DETAIL_FOCUS, FIELD_FOCUS, HELP_FOCUS } from "../src/terminal/focus.js";
import type { FieldAnswer, Observation, SessionList, TerminalSize } from "../src/terminal/model.js";
import { renderTerminal } from "../src/terminal/render.js";
import { NO_PLUGIN_HERE } from "../src/terminal/reply.js";
import { sampleWindow } from "./helpers/sampleWindow.js";
import { createFakeStore } from "./helpers/fakeStore.js";
import { fromBeforeIzborStarted } from "./helpers/unseenWait.js";
import { NO_WRITES } from "./helpers/projectWriters.js";

chalk.level = 0;

const NO_HOOKS = "5b0e7c1d-2f4a-4c8e-9d36-7a1f0b2c3d4e";
const NARROW: TerminalSize = { columns: 80, rows: 30 };
const WIDE: TerminalSize = { columns: 160, rows: 40 };
const sampleNews = (session: string) => ({ text: "The sample sends nothing.", error: false, session });

const key = (app: TerminalController, name: string, shift = false) => app.keypress(undefined, { name, shift });
const type = (app: TerminalController, text: string) => app.keypress(text, {});
const lines = (app: TerminalController, size: TerminalSize) => renderTerminal(app.view, size).lines;
const lastLine = (app: TerminalController, size: TerminalSize) => lines(app, size).at(-1)!.trim();
const fieldRow = (app: TerminalController, size: TerminalSize) => lines(app, size).at(-5)!.trimEnd();
const sent = () => delay(0);

test("Enter on a narrow Brief page puts the cursor in the field, and Enter on a focused side Brief too", (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    assert.equal(app.view.focused, SAMPLE_IDS[1]);
    key(app, "return");
    assert.equal(app.view.focused, FIELD_FOCUS);
    assert.deepEqual(app.view.field, { text: "", cursor: 0, fixed: null, message: null }, "the field starts empty");
    app.resize(WIDE.columns, WIDE.rows);
    assert.equal(app.view.focused, FIELD_FOCUS, "widening keeps the field");
    app.openSession(SAMPLE_IDS[2]);
    assert.equal(app.view.focused, DETAIL_FOCUS);
    key(app, "return");
    assert.equal(app.view.focused, FIELD_FOCUS);
});

test("while the field has focus every key types, m, h and s included; Esc steps back to the Brief and keeps the text", (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    for (const letter of ["m", "h", "s"]) type(app, letter);
    assert.equal(app.view.field.text, "mhs");
    assert.equal(app.view.metadataExpanded, false);
    assert.equal(app.view.briefHidden, false);
    assert.equal(app.view.sessions.length, 3);
    assert.equal(app.view.expanded, SAMPLE_IDS[1]);
    key(app, "escape");
    assert.equal(app.view.focused, SAMPLE_IDS[1], "the Brief page has focus again");
    assert.equal(app.view.expanded, SAMPLE_IDS[1], "and stays open");
    assert.equal(app.view.field.text, "mhs");
    app.resize(WIDE.columns, WIDE.rows);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    type(app, "!");
    key(app, "escape");
    assert.equal(app.view.focused, DETAIL_FOCUS, "beside Sessions, Esc goes to the side Brief");
    assert.equal(app.view.field.text, "mhs!");
});

test("on a narrow Brief page the Tab order is Brief, field, Help; Shift-Tab goes back", (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    const order: (string | null)[] = [];
    for (let times = 0; times < 4; times++) {
        key(app, "tab");
        order.push(app.view.focused);
    }
    assert.deepEqual(order, [FIELD_FOCUS, HELP_FOCUS, SAMPLE_IDS[1], FIELD_FOCUS]);
    key(app, "tab", true);
    key(app, "tab", true);
    assert.equal(app.view.focused, HELP_FOCUS);
    key(app, "tab", true);
    assert.equal(app.view.focused, FIELD_FOCUS);
});

test("beside a side Brief the Tab order is the rows, Brief, field, Help; Shift-Tab goes back", (t) => {
    const { app } = sampleWindow(t, WIDE);
    app.openSession(SAMPLE_IDS[1]);
    const order: (string | null)[] = [];
    for (let times = 0; times < 7; times++) {
        key(app, "tab");
        order.push(app.view.focused);
    }
    assert.deepEqual(order, [FIELD_FOCUS, HELP_FOCUS, ...SAMPLE_IDS, DETAIL_FOCUS, FIELD_FOCUS]);
    key(app, "tab");
    key(app, "tab");
    assert.equal(app.view.focused, SAMPLE_IDS[0], "Help wraps to the first row");
    key(app, "tab", true);
    assert.equal(app.view.focused, HELP_FOCUS, "Shift-Tab from the first row reaches Help");
    key(app, "tab", true);
    assert.equal(app.view.focused, FIELD_FOCUS);
});

test("an empty field sends nothing and keeps the focus", async (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    key(app, "return");
    await sent();
    assert.equal(app.view.field.message, null, "an empty field sends nothing");
    assert.equal(app.view.focused, FIELD_FOCUS);
});

test("a click on the field puts the caret on a character's edge and the cursor in the field; a click on Send → focuses it and sends", async (t) => {
    const { app } = sampleWindow(t, WIDE);
    app.openSession(SAMPLE_IDS[2]);
    key(app, "return");
    type(app, "run 🙂 again");
    key(app, "escape");
    app.focusField(5);
    assert.equal(app.view.focused, FIELD_FOCUS);
    assert.equal(app.view.field.cursor, 4, "inside the emoji's two code units, the caret goes to its start");
    app.focusField();
    assert.equal(app.view.field.cursor, "run 🙂 again".length, "no caret given: the end");
    key(app, "escape");
    app.focusField();
    key(app, "return");
    await sent();
    assert.equal(app.view.focused, FIELD_FOCUS);
    assert.deepEqual(app.view.field.message, sampleNews(SAMPLE_IDS[2]));
    assert.deepEqual(app.view.field.fixed, { mode: "reply", session: SAMPLE_IDS[2] });
});

test("a Brief of a project without Izbor's hooks has no field: Enter on it opens nothing new, Tab goes to Help, a click on a field does nothing", (t) => {
    const { app, source } = sampleWindow(t, NARROW);
    source.observe(NO_HOOKS);
    app.openSession(NO_HOOKS);
    assert.equal(app.view.focused, NO_HOOKS);
    key(app, "return");
    assert.equal(app.view.focused, NO_HOOKS);
    app.focusField();
    assert.equal(app.view.focused, NO_HOOKS);
    key(app, "tab");
    assert.equal(app.view.focused, HELP_FOCUS);
    assert.doesNotMatch(lines(app, NARROW).join("\n"), /┌|Send →/, "no box on the page");
    assert.match(
        lines(app, NARROW).join("\n"),
        /^ {2}Briefs update late: add hooks for live updates *$/m,
        "the page says why, under its heading",
    );
    key(app, "tab", true);
    assert.equal(app.view.focused, NO_HOOKS);
    app.resize(WIDE.columns, WIDE.rows);
    app.openSession(NO_HOOKS);
    key(app, "return");
    assert.equal(app.view.focused, DETAIL_FOCUS, "Enter on a side Brief without a field does nothing");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /Reply to this session|Send →/);
    assert.match(
        lines(app, WIDE).join("\n"),
        /│ {2}Briefs update late: add hooks for live updates *$/m,
        "the side Brief says it too",
    );
    app.showError("x");
    const split = lines(app, WIDE).map((line) => line.trimEnd());
    assert.deepEqual(split.at(-2)!.split("│"), [" ".repeat(94), "  × x"]);
    app.resize(NARROW.columns, NARROW.rows);
    app.openSession(NO_HOOKS);
    assert.equal(lines(app, NARROW).at(-2)!.trimEnd(), "  × x", "on its page: the row above the last line");
});

test("an act on a list takes the field's own sentence off, so its line shows; an error that is no act leaves the sentence", async (t) => {
    const { app } = sampleWindow(t, WIDE);
    typeIn(app, SAMPLE_IDS[1], "yes");
    key(app, "return");
    await sent();
    const above = () => lines(app, WIDE).at(-5)!.trimEnd().split("│")[1];
    assert.equal(above(), "  The sample sends nothing.");
    app.showError("x");
    assert.deepEqual(app.view.field.message, sampleNews(SAMPLE_IDS[1]), "no act: the field's sentence stays");
    assert.equal(above(), "  The sample sends nothing.", "and keeps its line on its Brief");
    app.stopObserving(SAMPLE_IDS[0]);
    assert.equal(app.view.field.message, null, "the stop is an act: the field's sentence goes");
    assert.equal(app.view.field.text, "yes", "the typed text stays");
    assert.equal(
        lines(app, WIDE).at(-6)!.trimEnd().split("│")[1],
        "  Stopped observing “Fix the token refresh bug a…”. The session",
    );
    assert.equal(above(), "  keeps running. Observe › on Home brings it back.");
});

test("on a Brief page the line above the field shows the field's message, else the feedback, and a key in the field takes the feedback off; beside a side Brief the one line stands above the field's box and the left pane's row above the last line stays empty", async (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.showError("x");
    app.openSession(SAMPLE_IDS[1]);
    const page = () => lines(app, NARROW).map((line) => line.trimEnd());
    assert.match(page().at(-2)!, /^ {2}└─+┘$/, "the field's box ends right above the last line");
    assert.equal(fieldRow(app, NARROW), "  × x", "no message of the field's: the feedback, a refusal behind its ×");
    key(app, "return");
    type(app, "y");
    assert.equal(fieldRow(app, NARROW), "", "a key in the field takes the last act's line off");
    type(app, "es");
    key(app, "return");
    await sent();
    assert.equal(fieldRow(app, NARROW), "  The sample sends nothing.", "the field's message has its line");
    assert.equal(lastLine(app, NARROW), "Help · Ctrl-G");

    const wide = sampleWindow(t, WIDE).app;
    wide.showError("x");
    wide.openSession(SAMPLE_IDS[1]);
    const split = () => lines(wide, WIDE).map((line) => line.trimEnd());
    assert.equal(
        split().at(-5)!.split("│")[1],
        "  × x",
        "beside a side Brief the one line stands above the field's box",
    );
    assert.equal(split().at(-2)!.split("│")[0]!.trimEnd(), "", "the left pane's row above the last line stays empty");
    key(wide, "return");
    type(wide, "yes");
    assert.equal(split().at(-5)!.split("│")[1], "", "a key in the field takes it off");
    key(wide, "return");
    await sent();
    assert.equal(split().at(-5)!.split("│")[1], "  The sample sends nothing.", "the field's message has the same row");
    assert.equal(wide.view.feedback, "");
    assert.match(split().at(-2)!, /│ {2}└─+┘$/);
    assert.match(split().at(-1)!, /^ +Help · Ctrl-G$/, "the last row: Help alone, at the window's right end");
});

test("the mode is fixed when typing starts: the label holds while text sits in the field, whichever Brief shows", (t) => {
    const { app } = sampleWindow(t, WIDE);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    type(app, "yes");
    app.openSession(SAMPLE_IDS[2]);
    const text = lines(app, WIDE).join("\n");
    assert.match(text, /│ {2}Explain how request retries work .* {2}Hide · h/, "the third session's Brief shows");
    assert.match(text, /─ Answer ─/);
    assert.doesNotMatch(text, /Reply to this session/);
});

test("Page Up and Page Down with the field focused scroll the Brief it belongs to, and pane() is that Brief's", (t) => {
    const { app } = sampleWindow(t, WIDE);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    app.measured({ maxScroll: 9, pageSize: 5, scroll: 0, detail: { maxScroll: 20, pageSize: 6, scroll: 0 } });
    assert.equal(app.pane().pageSize, 6, "the side Brief's layout");
    app.keypress(undefined, { name: "pagedown" }, 20, 6);
    assert.equal(app.view.detailScroll, 6);
    assert.equal(app.view.scroll, 0);
    app.resize(NARROW.columns, NARROW.rows);
    assert.equal(app.view.focused, SAMPLE_IDS[1], "narrowing closes the side Brief: focus goes to its row");
});

test("Help opened from the field returns to the field; Ctrl-O from the field leaves the Brief and focuses nothing", (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    type(app, "yes");
    app.keypress(undefined, { name: "g", ctrl: true });
    assert.equal(app.view.focused, HELP_FOCUS);
    key(app, "escape");
    assert.equal(app.view.focused, FIELD_FOCUS);
    assert.equal(app.view.field.text, "yes");
    app.keypress(undefined, { name: "o", ctrl: true });
    assert.equal(app.view.screen, "home");
    assert.equal(app.view.focused, null);
    assert.equal(app.view.field.text, "yes", "the text waits for the next Brief");
});

test("the badge stands alone on its line above the request, on the page and in the side Brief, and no cue is drawn", (t) => {
    const { app } = sampleWindow(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    const noCue = (size: TerminalSize) => assert.doesNotMatch(lines(app, size).join("\n"), /Answer ›/);
    const page = lines(app, NARROW);
    const badge = page.findIndex((line) => line.includes("Needs you"));
    assert.match(page[badge]!, /^ {3}! Needs you *$/);
    assert.equal(page[badge + 1]!.trimEnd(), "  Bash: npm test invoices");
    noCue(NARROW);
    app.resize(WIDE.columns, WIDE.rows);
    const side = lines(app, WIDE).find((line) => /│ {3}! Needs you/.test(line))!;
    assert.match(side, /│ {3}! Needs you *$/);
    noCue(WIDE);
    app.openSession(SAMPLE_IDS[2]);
    assert.equal(
        lines(app, WIDE).some((line) => /│ {3}! Needs you/.test(line)),
        false,
        "no request, no badge in the side Brief",
    );
});

test("a request whose headline was shortened shows the tool's whole input under it, every line, on the page and in the side Brief", (t) => {
    const whole = ["cd server", "npm test invoices -- --reporter dot", "git status --short"];
    for (const size of [NARROW, WIDE]) {
        const { app } = answering(t, size, (row) =>
            row.id === SAMPLE_IDS[1]
                ? {
                      ...row,
                      brief: {
                          ...row.brief!,
                          needsYou: {
                              state: "request",
                              text: "Bash: cd server …",
                              detail: whole.join("\n"),
                              at: (row.brief!.needsYou as { at: string }).at,
                          },
                      },
                  }
                : row,
        );
        app.openSession(SAMPLE_IDS[1]);
        const all = lines(app, size).map((line) => line.trimEnd());
        const badge = all.findIndex((line) => /(^|│) {3}! Needs you$/.test(line));
        assert.ok(badge > 0, "the badge alone on its line");
        const under = all.slice(badge + 1, badge + 5);
        const expected = ["Bash: cd server …", ...whole];
        if (size === NARROW)
            assert.deepEqual(
                under,
                expected.map((text) => `  ${text}`),
            );
        else
            assert.deepEqual(
                under.map((line) => line.slice(line.lastIndexOf("│"))),
                expected.map((text) => `│  ${text}`),
            );
    }
});

function notActing(t: TestContext, size: TerminalSize) {
    const world = createSampleWorld();
    const sessions = world.list.state === "listed" ? world.list.sessions : [];
    const source = createFakeStore({
        list: {
            state: "listed",
            at: "2026-10-09T12:00:00.000Z",
            sessions: sessions.map((s) => ({ ...s, acting: false })),
        },
        observations: SAMPLE_IDS.map((id) => {
            const row = world.row(id);
            return id === SAMPLE_IDS[1]
                ? { ...row, brief: { ...row.brief!, answerable: "not an acting project" } }
                : row;
        }),
    });
    const app = createTerminalController(source, { ...NO_WRITES, ...size, changed() {} });
    t.after(() => app.dispose());
    return app;
}

test("a request in a project without the plugin has a closing line under Needs you and a placeholder that say to answer in Claude Code; a held request has neither", (t) => {
    const app = notActing(t, NARROW);
    app.openSession(SAMPLE_IDS[1]);
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    const at = page.indexOf("   ! Needs you");
    assert.deepEqual(page.slice(at, at + 3), [
        "   ! Needs you",
        "  Bash: npm test invoices",
        "  Answer in Claude Code: this project has no plugin.",
    ]);
    assert.match(page.join("\n"), /│ › answer this one in Claude Code +Send → │/);
    const held = sampleWindow(t, NARROW).app;
    held.openSession(SAMPLE_IDS[1]);
    assert.match(lines(held, NARROW).join("\n"), /! Needs you *\n {2}Bash: npm test invoices *\n {2}Last change /);
    assert.match(lines(held, NARROW).join("\n"), /│ › yes, no, or no and your words +Send → │/);
});

function answering(
    t: TestContext,
    size: TerminalSize,
    change: (row: Observation) => Observation = (row) => row,
    listed: (list: SessionList) => SessionList = (list) => list,
) {
    const world = createSampleWorld();
    const store = createFakeStore(
        { list: listed(world.list), observations: SAMPLE_IDS.map((id) => change(world.row(id))) },
        "sent",
    );
    const app = createTerminalController(store, { ...NO_WRITES, ...size, changed() {} });
    t.after(() => app.dispose());
    const at = (world.row(SAMPLE_IDS[1]).brief!.needsYou as { at: string }).at;
    return { app, store, at };
}
function typeIn(app: TerminalController, id: string, text: string) {
    app.openSession(id);
    key(app, "return");
    type(app, text);
}
const CHANGED = "That request is over or changed: check the Brief.";

test("yes in the field goes to the store once, with the request's time; the field empties, and the window says what it sent and nothing more", async (t) => {
    const { app, store, at } = answering(t, NARROW);
    typeIn(app, SAMPLE_IDS[1], "yes");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[1], at, text: "yes" }]);
    assert.deepEqual(app.view.field, { text: "", cursor: 0, fixed: null, message: null });
    assert.equal(app.view.focused, FIELD_FOCUS);
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    const needs = page.indexOf("   ! Needs you");
    assert.ok(needs > 0, "the badge stands in the window that answered");
    assert.match(page[needs + 2]!, /^ {2}Sent from Izbor: yes · \d+s ago$/);
    assert.match(page[needs + 3]!, /^ {2}Last change /, "nothing says Approved, and Needs you still holds the request");
    assert.match(page.at(-3)!, /^ {2}│ › +Send → │$/, "the field is empty, with no placeholder");
    assert.equal(page.at(-5), "  Sent yes. Needs you clears when Claude goes on.");
    assert.equal(page.at(-1)!.trim(), "Help · Ctrl-G");
    assert.doesNotMatch(page.join("\n"), /Approved|Allowed/);
});

test("no and words go as typed, and the Sent sentence leaves the field's line at the next key in the field", async (t) => {
    const { app, store, at } = answering(t, NARROW);
    typeIn(app, SAMPLE_IDS[1], "no, run only the export tests");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[1], at, text: "no, run only the export tests" }]);
    const page = lines(app, NARROW).join("\n");
    assert.match(page, /Sent from Izbor: no, run only the export tests · \d+s ago/);
    assert.match(page, /\n {2}Sent no, run only the export tests\. Needs you clears when Claude goes on\.\n/);
    type(app, "y");
    assert.equal(fieldRow(app, NARROW), "", "the next key in the field clears its line");
    assert.equal(lastLine(app, NARROW), "Help · Ctrl-G");
});

test("Enter twice sends once: while an answer is out, Enter sends nothing more", async (t) => {
    const { app, store } = answering(t, NARROW);
    let release = (_answer: { sent: string }) => {};
    const out = new Promise<{ sent: string }>((resolve) => (release = resolve));
    let calls = 0;
    store.answer = async () => {
        calls++;
        return out;
    };
    typeIn(app, SAMPLE_IDS[1], "yes");
    key(app, "return");
    key(app, "return");
    key(app, "return");
    await sent();
    assert.equal(calls, 1);
    assert.equal(app.view.field.text, "yes", "the text waits for the answer");
    release({ sent: "yes" });
    await sent();
    assert.equal(app.view.field.text, "");
    type(app, "no");
    key(app, "return");
    await sent();
    assert.equal(calls, 2, "the next send goes once the first has its answer");
});

test("a store whose answer or prompt rejects leaves the field usable: the text stays, the line claims nothing was proved, and the next Enter sends", async (t) => {
    const NO_REPLY = {
        text: "Izbor gave no reply: check the Brief before you answer again.",
        error: true,
        session: SAMPLE_IDS[1],
    };
    const { app, store } = answering(t, NARROW);
    const answer = store.answer;
    let calls = 0;
    store.answer = async () => {
        calls++;
        throw new Error("the store broke");
    };
    typeIn(app, SAMPLE_IDS[1], "yes");
    key(app, "return");
    await sent();
    assert.equal(calls, 1);
    assert.deepEqual(
        { text: app.view.field.text, message: app.view.field.message },
        { text: "yes", message: NO_REPLY },
    );
    assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sent /, "nothing says an answer went");
    key(app, "return");
    await sent();
    assert.equal(calls, 2, "Enter sends again: the field is not dead");
    store.answer = answer;
    key(app, "return");
    await sent();
    assert.equal(app.view.field.text, "", "and an answer that goes empties it");

    store.prompt = () => Promise.reject(new Error("the store broke"));
    typeIn(app, SAMPLE_IDS[0], "go on");
    key(app, "return");
    await sent();
    assert.deepEqual(
        { text: app.view.field.text, message: app.view.field.message },
        {
            text: "go on",
            message: {
                text: "Izbor gave no reply: check the Brief before you send again.",
                error: true,
                session: SAMPLE_IDS[0],
            },
        },
    );
});

test("a request that changes between the first key and Enter is refused, and nothing is sent", async (t) => {
    const { app, store } = answering(t, NARROW);
    typeIn(app, SAMPLE_IDS[1], "yes");
    const next = "2026-10-09T12:34:56.000Z";
    store.set({
        observations: store
            .getSnapshot()
            .observations.map((row) =>
                row.id === SAMPLE_IDS[1]
                    ? { ...row, brief: { ...row.brief!, needsYou: { ...row.brief!.needsYou, at: next } as never } }
                    : row,
            ),
    });
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [], "nothing reached the store");
    assert.deepEqual(app.view.field.message, { text: CHANGED, error: true, session: SAMPLE_IDS[1] });
    assert.equal(app.view.field.text, "yes", "the text is kept");
    assert.match(lines(app, NARROW).join("\n"), /─ Answer ─/, "the label held still");
    for (let i = 0; i < 3; i++) key(app, "backspace");
    type(app, "yes");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[1], at: next, text: "yes" }]);
});

test("a request that ended while yes sat in the field is refused, and so is the Brief of another session", async (t) => {
    const { app, store } = answering(t, WIDE);
    typeIn(app, SAMPLE_IDS[1], "yes");
    app.openSession(SAMPLE_IDS[2]);
    app.focusField();
    key(app, "return");
    await sent();
    assert.deepEqual(
        app.view.field.message,
        { text: CHANGED, error: true, session: SAMPLE_IDS[2] },
        "yes under c8219b07's Brief, and the sentence is that Brief's",
    );
    store.set({
        observations: store
            .getSnapshot()
            .observations.map((row) =>
                row.id === SAMPLE_IDS[1] ? { ...row, brief: { ...row.brief!, needsYou: { state: "nothing" } } } : row,
            ),
    });
    app.openSession(SAMPLE_IDS[1]);
    app.focusField();
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, { text: CHANGED, error: true, session: SAMPLE_IDS[1] });
    assert.deepEqual(store.sends, []);
    assert.equal(app.view.field.text, "yes");
});

test("a request from before Izbor started: Enter refuses with the reason and sends nothing, and the wait and Answer field stay when the status is unknown", async (t) => {
    const before = (row: Observation) => (row.id === SAMPLE_IDS[1] ? fromBeforeIzborStarted(row) : row);
    const { app, store } = answering(t, NARROW, before);
    app.openSession(SAMPLE_IDS[1]);
    key(app, "return");
    type(app, "yes");
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: "Answer it in the session: Izbor was not running when it asked.",
        error: true,
        session: SAMPLE_IDS[1],
    });
    assert.equal(app.view.field.text, "yes");
    assert.deepEqual(store.sends, [], "neither an answer nor a prompt");
    const refused = lines(app, NARROW).join("\n");
    assert.match(refused, /Answer it in the session: Izbor was not running when it/);
    assert.match(refused, /Answer in Claude Code: Izbor was not running when it asked\./, "the muted line stays");
    const unknown = answering(t, NARROW, (row) => {
        const held = before(row);
        return row.id === SAMPLE_IDS[1] ? { ...held, brief: { ...held.brief!, status: "unknown" as const } } : held;
    });
    unknown.app.openSession(SAMPLE_IDS[1]);
    const still = lines(unknown.app, NARROW).join("\n");
    assert.match(
        still,
        /! Needs you *(│.*)?\n.*Unknown · permission prompt *(│.*)?\n/,
        "the block stays while the field answers to the wait",
    );
    assert.match(still, /┌─ Answer ─/);
});

test("a prompt typed before a wait Izbor cannot answer came is not sent under it: the label holds still, Enter says to answer the request first, and nothing reaches the store", async (t) => {
    const { app, store } = answering(t, NARROW);
    typeIn(app, SAMPLE_IDS[2], "go on");
    setRow(store, SAMPLE_IDS[2], (row) => fromBeforeIzborStarted(row));
    assert.match(lines(app, NARROW).join("\n"), /┌─ Reply to this session ─/);
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: "Answer the request first.",
        error: true,
        session: SAMPLE_IDS[2],
    });
    assert.deepEqual(store.sends, []);
    assert.equal(app.view.field.text, "go on");
});

test("X1: a reply in a live Brief goes to the store's prompt call once, never to its answer call; the field empties, the placeholder is back and the line says Sent to this session", async (t) => {
    const { app, store } = answering(t, NARROW);
    let answers = 0;
    store.answer = async () => (answers++, { sent: "never" });
    typeIn(app, SAMPLE_IDS[2], "run the tests again");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[2], text: "run the tests again" }]);
    assert.equal(answers, 0, "a prompt is never an answer");
    assert.deepEqual(app.view.field, { text: "", cursor: 0, fixed: null, message: null });
    assert.equal(app.view.focused, FIELD_FOCUS);
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    assert.match(page.at(-4)!, /┌─ Reply to this session ─/);
    assert.match(page.at(-3)!, /^ {2}│ › your next prompt +Send → │$/);
    assert.equal(page.at(-5), "  Sent to this session.");
    assert.doesNotMatch(
        page.join("\n"),
        /it runs when this turn ends|Latest:/,
        "the Brief stays Idle until Izbor sees the new turn: no busy placeholder, no Latest",
    );
    app.openSession(SAMPLE_IDS[0]);
    assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sent to this session/);
    app.openSession(SAMPLE_IDS[2]);
    key(app, "return");
    type(app, "a");
    assert.equal(fieldRow(app, NARROW), "");
});

test("E7, S7: a prompt sent while Claude is busy says it runs when this turn ends, and meanwhile the placeholder is just your next prompt; the busy form is back once the line clears", async (t) => {
    const { app, store } = answering(t, WIDE);
    app.openSession(SAMPLE_IDS[0]);
    assert.match(lines(app, WIDE).join("\n"), /│ › your next prompt; it runs when this turn ends +Send → │/);
    key(app, "return");
    type(app, "also add a test for refresh races");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[0], text: "also add a test for refresh races" }]);
    const side = lines(app, WIDE).map((line) => line.trimEnd());
    assert.match(side.at(-3)!, /│ › your next prompt {2,}Send → │$/);
    assert.match(side.at(-5)!, /│ {2}Sent\. It runs when this turn ends\.$/);
    store.set({ observations: store.getSnapshot().observations.map(({ prompt: _over, ...row }) => row) });
    const after = lines(app, WIDE).join("\n");
    assert.doesNotMatch(after, /Sent\. It runs/);
    assert.match(after, /│ › your next prompt; it runs when this turn ends +Send → │/);
});

test("Enter twice sends a prompt once: while it is out the line says Sending, the text waits, and Enter sends nothing more", async (t) => {
    const { app, store } = answering(t, NARROW);
    let release = (_answer: { sent: string } | { refused: string }) => {};
    let calls = 0;
    store.prompt = () => {
        calls++;
        return new Promise((resolve) => (release = resolve));
    };
    typeIn(app, SAMPLE_IDS[2], "run the tests again");
    key(app, "return");
    key(app, "return");
    key(app, "return");
    await sent();
    assert.equal(calls, 1);
    assert.equal(app.view.field.text, "run the tests again", "the text waits for Izbor's word");
    assert.equal(fieldRow(app, NARROW), "  Sending…");
    assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sent /, "nothing says it went");
    release({ refused: "Type /reload-plugins in this session once to send messages from here." });
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: "Type /reload-plugins in this session once to send messages from here.",
        error: true,
        session: SAMPLE_IDS[2],
    });
    assert.equal(app.view.field.text, "run the tests again", "a refusal keeps the text");
    key(app, "return");
    await sent();
    assert.equal(calls, 2, "the next Enter sends again: one send per Enter");
    release({ sent: "run the tests again" });
    await sent();
    assert.equal(app.view.field.text, "");
});

test("a prompt goes only to the session it was typed for: under another session's Brief Enter refuses, and nothing reaches the store", async (t) => {
    const { app, store } = answering(t, WIDE);
    typeIn(app, SAMPLE_IDS[2], "run the tests again");
    app.openSession(SAMPLE_IDS[0]);
    app.focusField();
    assert.match(
        lines(app, WIDE).join("\n"),
        /│ {2}Fix the token refresh bug .* {2}Hide · h/,
        "the first session's Brief shows",
    );
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: "You typed this on another session's Brief: nothing was sent.",
        error: true,
        session: SAMPLE_IDS[0],
    });
    assert.deepEqual(store.sends, [], "0926995f got nothing");
    assert.equal(app.view.field.text, "run the tests again");
    app.openSession(SAMPLE_IDS[2]);
    app.focusField();
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[2], text: "run the tests again" }]);
});

function setRow(store: ReturnType<typeof answering>["store"], id: string, change: (row: Observation) => Observation) {
    store.set({ observations: store.getSnapshot().observations.map((row) => (row.id === id ? change(row) : row)) });
}
const asks = (row: Observation): Observation => ({
    ...row,
    brief: {
        ...row.brief!,
        status: "waiting",
        needsYou: {
            state: "request",
            text: "Bash: npm test",
            detail: "Bash: npm test",
            at: "2026-10-09T12:34:56.000Z",
        },
        answerable: true,
    },
});

test("a request that arrives while a prompt sits in the field is never answered by it: the label holds still, Enter refuses with Answer the request first, and nothing is sent, as a prompt or as an answer", async (t) => {
    const { app, store } = answering(t, NARROW);
    typeIn(app, SAMPLE_IDS[2], "yes please run them");
    setRow(store, SAMPLE_IDS[2], asks);
    assert.match(lines(app, NARROW).join("\n"), /┌─ Reply to this session ─/, "the label held still");
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: "Answer the request first.",
        error: true,
        session: SAMPLE_IDS[2],
    });
    assert.deepEqual(store.sends, []);
    assert.equal(app.view.field.text, "yes please run them");
    app.keypress(undefined, { name: "u", ctrl: true });
    assert.match(lines(app, NARROW).join("\n"), /┌─ Answer ─/);
});

test("R7: reply mode in a project without the plugin: the placeholder says so, and Enter refuses with Home's Add plugin cue before any store", async (t) => {
    const { app, store } = answering(t, NARROW, undefined, withoutPlugin);
    app.openSession(SAMPLE_IDS[2]);
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    assert.match(page.at(-4)!, /┌─ Reply to this session ─/);
    assert.match(page.at(-3)!, /^ {2}│ › this project has no plugin +Send → │$/);
    assert.equal(lastLine(app, NARROW), "Help · Ctrl-G");
    key(app, "return");
    type(app, "run the tests again");
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, {
        text: NO_PLUGIN_HERE,
        error: true,
        session: SAMPLE_IDS[2],
    });
    assert.deepEqual(store.sends, []);
    assert.equal(app.view.field.text, "run the tests again");
});

const drop = (store: ReturnType<typeof answering>["store"], id: string) =>
    setRow(store, id, (row) => ({
        ...row,
        prompt: { ...row.prompt!, state: "dropped", reason: "it was taken off the session's queue" },
    }));
const DID_NOT_RUN = "That prompt did not run: it was taken off the session's queue.";
async function prompted(app: TerminalController, id: string, text: string) {
    typeIn(app, id, text);
    key(app, "return");
    await sent();
    assert.equal(app.view.field.text, "", "the prompt went");
}

test("E8: a dropped prompt comes back into the empty field of its Brief, with the rose line; your next key clears the line", async (t) => {
    const { app, store } = answering(t, NARROW);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    key(app, "escape");
    drop(store, SAMPLE_IDS[2]);
    assert.deepEqual(app.view.field, {
        text: "also add a test for refresh races",
        cursor: 33,
        fixed: { mode: "reply", session: SAMPLE_IDS[2] },
        message: { text: DID_NOT_RUN, error: true, session: SAMPLE_IDS[2] },
    });
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    assert.match(page.at(-3)!, /^ {2}│ › also add a test for refresh races +Send → │$/);
    assert.equal(page.at(-5), `  × ${DID_NOT_RUN}`);
    key(app, "return");
    app.keypress(undefined, { name: "u", ctrl: true });
    type(app, "x");
    setRow(store, SAMPLE_IDS[1], (row) => ({ ...row }));
    assert.equal(app.view.field.text, "x");
    assert.equal(app.view.field.message, null, "the edit cleared the line");
});

test("E8: with a request waiting, a dropped prompt is only the rose line: it never lands in an answer field", async (t) => {
    const { app, store } = answering(t, NARROW);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    setRow(store, SAMPLE_IDS[2], asks);
    drop(store, SAMPLE_IDS[2]);
    assert.equal(app.view.field.text, "");
    assert.equal(app.view.field.fixed, null);
    const page = lines(app, NARROW).join("\n");
    assert.match(page, /┌─ Answer ─/);
    assert.match(page, /│ › yes, no, or no and your words +Send → │/, "the answer field is empty");
    assert.match(page, /That prompt did not run: it was taken off the session's/);
});

test("E8: under another session's Brief a dropped prompt puts nothing in the field, and its line shows only on its own Brief", async (t) => {
    const { app, store } = answering(t, WIDE);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    app.openSession(SAMPLE_IDS[1]);
    drop(store, SAMPLE_IDS[2]);
    assert.equal(app.view.field.text, "", "nothing lands under a7312ce4's Brief");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/);
    app.openSession(SAMPLE_IDS[2]);
    assert.match(lines(app, WIDE).join("\n"), /That prompt did not run: it was taken off the session's/);
});

test("E8: a prompt reported dropped before the store's reply to its send keeps its text in the field with the rose line: the send's own success does not empty it", async (t) => {
    const { app, store } = answering(t, NARROW);
    const collect = store.prompt;
    store.prompt = async (id, text) => {
        const answer = await collect(id, text);
        drop(store, id);
        return answer;
    };
    typeIn(app, SAMPLE_IDS[2], "also add a test for refresh races");
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field, {
        text: "also add a test for refresh races",
        cursor: 33,
        fixed: { mode: "reply", session: SAMPLE_IDS[2] },
        message: { text: DID_NOT_RUN, error: true, session: SAMPLE_IDS[2] },
    });
    const page = lines(app, NARROW).map((line) => line.trimEnd());
    assert.match(page.at(-3)!, /^ {2}│ › also add a test for refresh races +Send → │$/);
    assert.equal(page.at(-5), `  × ${DID_NOT_RUN}`);
    store.prompt = collect;
    key(app, "return");
    await sent();
    assert.equal(store.sends.length, 2);
    assert.equal(app.view.field.text, "");
    assert.equal(fieldRow(app, NARROW), "  Sent to this session.");
});

test("E8: a key typed under another session's Brief does not take a dropped prompt's line away: it shows on its own Brief until a key in the field there, and an answer sent later does not bring it back", async (t) => {
    const { app, store } = answering(t, WIDE);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    app.openSession(SAMPLE_IDS[1]);
    app.focusField();
    type(app, "ye");
    drop(store, SAMPLE_IDS[2]);
    type(app, "s");
    assert.equal(app.view.field.text, "yes");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/, "not under a7312ce4's Brief");
    key(app, "return");
    await sent();
    assert.equal(app.view.field.text, "");
    app.openSession(SAMPLE_IDS[2]);
    assert.match(lines(app, WIDE).join("\n"), /That prompt did not run: it was taken off the session's/);
    assert.equal(app.view.field.text, "", "the text comes back only at the report, on its own Brief");
    app.focusField();
    type(app, "x");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/);
    app.keypress(undefined, { name: "backspace" });
    setRow(store, SAMPLE_IDS[2], (row) => ({ ...row }));
    app.openSession(SAMPLE_IDS[1]);
    app.openSession(SAMPLE_IDS[2]);
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/);
});

test("E8: a prompt dropped while a list shows keeps its line for its own Brief, whatever is typed in another Brief's field first", async (t) => {
    const { app, store } = answering(t, NARROW);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    key(app, "escape");
    app.back();
    drop(store, SAMPLE_IDS[2]);
    typeIn(app, SAMPLE_IDS[0], "and lint");
    app.keypress(undefined, { name: "u", ctrl: true });
    app.back();
    app.openSession(SAMPLE_IDS[2]);
    assert.match(lines(app, NARROW).join("\n"), /That prompt did not run: it was taken off the session's/);
});

test("E8: a refusal under another session's Brief does not take a dropped prompt's line: it shows on the prompt's own Brief, where the refusal does not, until a key in the field there", async (t) => {
    const { app, store } = answering(t, WIDE);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    typeIn(app, SAMPLE_IDS[0], "and lint");
    drop(store, SAMPLE_IDS[2]);
    setRow(store, SAMPLE_IDS[0], asks);
    key(app, "return");
    await sent();
    assert.match(lines(app, WIDE).join("\n"), /Answer the request first\./);
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/);
    assert.deepEqual(store.sends.length, 1, "nothing more went");
    app.openSession(SAMPLE_IDS[2]);
    assert.match(lines(app, WIDE).join("\n"), /That prompt did not run: it was taken off the session's/);
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /Answer the request first\./, "not 0926995f's refusal");
    app.focusField();
    type(app, "!");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That prompt did not run/, "the key that saw it clears it");
});

test("a send's outcome shows only on the Brief of the session it was sent for: a prompt's refusal that comes back after another Brief opened, and an answer's refusal, do not show there", async (t) => {
    const { app, store } = answering(t, WIDE);
    let release: (answer: FieldAnswer) => void = () => {};
    store.prompt = () => new Promise((resolve) => (release = resolve));
    const RELOAD = "Type /reload-plugins in this session once to send messages from here.";
    typeIn(app, SAMPLE_IDS[2], "run the tests again");
    key(app, "return");
    app.openSession(SAMPLE_IDS[0]);
    release({ refused: RELOAD });
    await sent();
    assert.deepEqual(app.view.field.message, { text: RELOAD, error: true, session: SAMPLE_IDS[2] });
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /reload-plugins/, "0926995f was sent nothing");
    app.openSession(SAMPLE_IDS[2]);
    assert.match(lines(app, WIDE).join("\n"), /Type \/reload-plugins in this session once/);
    app.focusField();
    app.keypress(undefined, { name: "u", ctrl: true });
    typeIn(app, SAMPLE_IDS[1], "yes");
    setRow(store, SAMPLE_IDS[1], (row) => ({ ...row, brief: { ...row.brief!, needsYou: { state: "nothing" } } }));
    key(app, "return");
    await sent();
    assert.deepEqual(app.view.field.message, { text: CHANGED, error: true, session: SAMPLE_IDS[1] });
    assert.match(lines(app, WIDE).join("\n"), /That request is over or changed/);
    app.openSession(SAMPLE_IDS[0]);
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /That request is over or changed/);
});

test("a prompt's no-reply sentence that came back under another session's Brief is not lost to a sentence said there: a refusal under that Brief, or a prompt dropped there, leaves it, and it shows on its own Brief before Enter sends again", async (t) => {
    const { app, store } = answering(t, WIDE);
    const prompt = store.prompt;
    await prompted(app, SAMPLE_IDS[0], "and lint");
    let fail: (reason: Error) => void = () => {};
    store.prompt = () => new Promise((_resolve, reject) => (fail = reject));
    typeIn(app, SAMPLE_IDS[2], "delete the old branch");
    key(app, "return");
    app.openSession(SAMPLE_IDS[0]);
    fail(new Error("the store failed"));
    await sent();
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /gave no reply/, "0926995f was sent nothing");
    app.focusField();
    key(app, "return");
    await sent();
    assert.match(lines(app, WIDE).join("\n"), /× You typed this on another session's Brief: nothing was$/m);
    drop(store, SAMPLE_IDS[0]);
    assert.match(lines(app, WIDE).join("\n"), /That prompt did not run/);
    assert.deepEqual(store.sends, [{ id: SAMPLE_IDS[0], text: "and lint" }]);
    app.openSession(SAMPLE_IDS[2]);
    assert.equal(app.view.field.text, "delete the old branch");
    assert.match(lines(app, WIDE).join("\n"), /Izbor gave no reply: check the Brief before you send again\./);
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /nothing was sent|did not run/);
    app.openSession(SAMPLE_IDS[0]);
    assert.match(lines(app, WIDE).join("\n"), /That prompt did not run/);
    app.openSession(SAMPLE_IDS[2]);
    app.focusField();
    key(app, "right");
    assert.match(lines(app, WIDE).join("\n"), /Izbor gave no reply/, "a caret move keeps it");
    type(app, "!");
    assert.doesNotMatch(lines(app, WIDE).join("\n"), /gave no reply/);
    assert.equal(app.view.field.message, null);
    assert.equal(app.view.field.behind, undefined);
    store.prompt = prompt;
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends.at(-1), { id: SAMPLE_IDS[2], text: "delete the old branch!" });
});

test("E8: a key that clears another sentence from the field's line does not clear a dropped prompt's line under it: the line shows next, and the key typed while it shows clears it", async (t) => {
    const { app, store } = answering(t, NARROW);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    type(app, "and lint");
    drop(store, SAMPLE_IDS[2]);
    setRow(store, SAMPLE_IDS[2], asks);
    key(app, "return");
    await sent();
    assert.equal(fieldRow(app, NARROW), "  × Answer the request first.");
    type(app, "!");
    assert.match(lines(app, NARROW).join("\n"), /That prompt did not run: it was taken off the session's/);
    assert.equal(app.view.field.told, undefined, "it was not showing when that key was typed");
    type(app, "!");
    assert.doesNotMatch(lines(app, NARROW).join("\n"), /That prompt did not run/);
});

test("E8: a dropped prompt on another session's row does not hold back a prompt sent from this Brief: the field empties and says it went", async (t) => {
    const { app, store } = answering(t, NARROW);
    await prompted(app, SAMPLE_IDS[2], "also add a test for refresh races");
    drop(store, SAMPLE_IDS[2]);
    assert.equal(app.view.field.text, "also add a test for refresh races", "heard: the text is back");
    app.keypress(undefined, { name: "u", ctrl: true });
    typeIn(app, SAMPLE_IDS[0], "and lint");
    key(app, "return");
    await sent();
    assert.deepEqual(store.sends.at(-1), { id: SAMPLE_IDS[0], text: "and lint" });
    assert.equal(app.view.field.text, "", "the prompt went, so the field is empty");
    assert.equal(fieldRow(app, NARROW), "  Sent. It runs when this turn ends.");
    key(app, "return");
    await sent();
    assert.equal(store.sends.length, 2, "Enter does not send it twice");
});

for (const original of [SAMPLE_IDS[1], SAMPLE_IDS[2]]) {
    for (const destination of [original, SAMPLE_IDS[0]]) {
        test(`a delayed ${original === SAMPLE_IDS[1] ? "answer" : "prompt"} keeps identical text retyped on ${destination === original ? "its own" : "another"} Brief`, async (t) => {
            const { app, store } = answering(t, WIDE);
            let complete = (_answer: FieldAnswer) => {};
            const pending = new Promise<FieldAnswer>((resolve) => (complete = resolve));
            store.answer = () => pending;
            store.prompt = () => pending;
            typeIn(app, original, "yes");
            key(app, "return");
            app.keypress(undefined, { name: "u", ctrl: true });
            app.openSession(destination);
            app.focusField();
            type(app, "yes");
            complete({ sent: "yes" });
            await sent();
            assert.equal(app.view.field.text, "yes");
            assert.equal(app.view.field.fixed?.session, destination);
            assert.match(lines(app, WIDE).join("\n"), /› yes +Send/);
        });
    }
}

test("disposing the controller releases its subscriptions and ignores a late send result", async () => {
    const world = createSampleWorld();
    const store = createFakeStore({ observations: SAMPLE_IDS.map((id) => world.row(id)), list: world.list });
    let complete = (_answer: FieldAnswer) => {};
    let subscribed = 0;
    let changed = 0;
    const app = createTerminalController(
        {
            ...store,
            onChange(callback) {
                subscribed++;
                const stop = store.onChange(callback);
                return () => {
                    subscribed--;
                    stop();
                };
            },
            prompt: () => new Promise((resolve) => (complete = resolve)),
            dispose() {},
        },
        { ...NO_WRITES, ...NARROW, changed: () => changed++ },
    );
    typeIn(app, SAMPLE_IDS[2], "run tests");
    key(app, "return");
    app.dispose();
    const before = changed;
    assert.equal(subscribed, 0);
    complete({ sent: "run tests" });
    await sent();
    assert.equal(app.view.field.text, "run tests");
    assert.equal(changed, before);
});

for (const original of [SAMPLE_IDS[1], SAMPLE_IDS[2]]) {
    test(`a delayed ${original === SAMPLE_IDS[1] ? "answer" : "prompt"} preserves text edited and restored without emptying the field`, async (t) => {
        const { app, store } = answering(t, WIDE);
        let complete = (_answer: FieldAnswer) => {};
        const pending = new Promise<FieldAnswer>((resolve) => (complete = resolve));
        store.answer = () => pending;
        store.prompt = () => pending;
        typeIn(app, original, "yes");
        key(app, "return");
        key(app, "backspace");
        type(app, "s");
        complete({ sent: "yes" });
        await sent();
        assert.equal(app.view.field.text, "yes");
        assert.match(lines(app, WIDE).join("\n"), /› yes +Send/);
    });
}

for (const result of ["sent", "refused"] as const) {
    for (const cursor of [4, 9]) {
        test(`a ${result} prompt retires Sending after Ctrl-U changes its draft at column ${cursor}`, async (t) => {
            const { app, store } = answering(t, NARROW);
            let complete = (_answer: FieldAnswer) => {};
            store.prompt = () => new Promise((resolve) => (complete = resolve));
            typeIn(app, SAMPLE_IDS[2], "run tests");
            key(app, "return");
            app.focusField(cursor);
            app.keypress(undefined, { name: "u", ctrl: true });
            assert.match(lines(app, NARROW).join("\n"), /Sending…/);
            complete(result === "sent" ? { sent: "run tests" } : { refused: "The prompt was refused." });
            await sent();
            assert.equal(app.view.field.text, cursor === 4 ? "tests" : "");
            assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sending…/);
            if (result === "refused") assert.match(lines(app, NARROW).join("\n"), /The prompt was refused\./);
        });
    }

    for (const editDraft of [false, true]) {
        test(`a ${result} prompt retires Sending behind another session's feedback with ${editDraft ? "an edited" : "the original"} draft`, async (t) => {
            const { app, store } = answering(t, NARROW);
            await prompted(app, SAMPLE_IDS[0], "and lint");
            let complete = (_answer: FieldAnswer) => {};
            store.prompt = () => new Promise((resolve) => (complete = resolve));
            typeIn(app, SAMPLE_IDS[2], "run tests");
            key(app, "return");
            if (editDraft) {
                app.focusField(4);
                app.keypress(undefined, { name: "u", ctrl: true });
            }
            drop(store, SAMPLE_IDS[0]);
            setRow(store, SAMPLE_IDS[0], ({ prompt: _prompt, ...row }) => row);
            assert.match(lines(app, NARROW).join("\n"), /Sending…/);
            complete(result === "sent" ? { sent: "run tests" } : { refused: "The prompt was refused." });
            await sent();
            assert.equal(app.view.field.text, editDraft ? "tests" : result === "sent" ? "" : "run tests");
            assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sending…/);
            app.openSession(SAMPLE_IDS[0]);
            assert.equal(fieldRow(app, NARROW), `  × ${DID_NOT_RUN}`);
            assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sending…|The prompt was refused/);
            app.openSession(SAMPLE_IDS[2]);
            assert.doesNotMatch(lines(app, NARROW).join("\n"), /Sending…/);
        });
    }
}

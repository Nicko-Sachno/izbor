import assert from "node:assert/strict";
import { test } from "node:test";
import { createSampleWorld, SAMPLE_IDS, withoutPlugin } from "./helpers/sampleSessions.js";
import {
    acts,
    afterSend,
    closingLines,
    editField,
    emptyField,
    fieldTitle,
    fieldLine,
    fieldMode,
    fieldPlaceholder,
    hooked,
    modeOn,
    placeholderOn,
    sendRefusal,
    sentTo,
    shownMessage,
    shownMode,
} from "../src/terminal/field.js";
import { afterDrop, NO_PLUGIN_HERE, unsaid } from "../src/terminal/reply.js";
import {
    listedSessions,
    type Connection,
    type FieldMode,
    type FieldState,
    type FixedMode,
    type Observation,
    type SentAnswer,
    type SentPrompt,
    type SessionList,
    type TerminalBrief,
} from "../src/terminal/model.js";

const world = createSampleWorld();
const NO_PLUGIN = withoutPlugin(world.list);
const [BUSY, WAITING, IDLE] = SAMPLE_IDS.map((id) => world.row(id).brief!);
const AT = (WAITING!.needsYou as { at: string }).at;
const ANSWER_MODE: FieldMode = { mode: "answer", at: AT };
const ANSWER: FixedMode = { ...ANSWER_MODE, session: SAMPLE_IDS[1] };
const REPLY: FixedMode = { mode: "reply", session: SAMPLE_IDS[1] };
const NO_HOOKS = "5b0e7c1d-2f4a-4c8e-9d36-7a1f0b2c3d4e";

const typed = (field: FieldState, text: string) => editField(field, REPLY, text, {});
const key = (field: FieldState, name: string, mode: FixedMode = REPLY) => editField(field, mode, "", { name });

test("the field answers while Needs you holds a request, named by its time, and replies otherwise, with no Brief too", () => {
    assert.deepEqual(fieldMode(WAITING!), ANSWER_MODE);
    assert.deepEqual(fieldMode(BUSY!), { mode: "reply" });
    assert.deepEqual(fieldMode(IDLE!), { mode: "reply" });
    assert.deepEqual(fieldMode({ ...IDLE!, needsYou: { state: "unknown" } }), { mode: "reply" });
    assert.deepEqual(fieldMode(null), { mode: "reply" });
});

test("the title is Answer in answer mode and Reply to this session in reply mode, and never names the request; the placeholder asks for yes or no in answer mode and a prompt in reply mode, says a busy session runs it after this turn, and in answer mode says where to answer while Needs you has its closing line", () => {
    assert.equal(fieldTitle(ANSWER), "Answer");
    assert.equal(fieldTitle(REPLY), "Reply to this session");
    type Status = Parameters<typeof fieldPlaceholder>[1];
    const cases: [FixedMode, Status, boolean | undefined, string][] = [
        [ANSWER, "waiting", undefined, "yes, no, or no and your words"],
        [ANSWER, "busy", undefined, "yes, no, or no and your words"],
        [REPLY, "idle", undefined, "your next prompt"],
        [REPLY, "unknown", undefined, "your next prompt"],
        [REPLY, undefined, undefined, "your next prompt"],
        [REPLY, "busy", undefined, "your next prompt; it runs when this turn ends"],
        [ANSWER, "waiting", true, "answer this one in Claude Code"],
        [ANSWER, "waiting", false, "yes, no, or no and your words"],
        [REPLY, "idle", true, "your next prompt"],
        [REPLY, "busy", true, "your next prompt; it runs when this turn ends"],
    ];
    for (const [mode, status, closed, placeholder] of cases)
        assert.equal(fieldPlaceholder(mode, status, closed), placeholder, JSON.stringify([mode.mode, status, closed]));
});

const QUESTION = createSampleWorld("question").row(SAMPLE_IDS[2]).brief!;

test("a Question's field asks for an option's number, until Needs you has its closing line", () => {
    const mode = fieldMode(QUESTION);
    assert.deepEqual(mode, {
        mode: "answer",
        takes: "number",
        at: (QUESTION.needsYou as { at: string }).at,
    });
    assert.equal(fieldTitle(mode), "Answer");
    assert.equal(fieldPlaceholder(mode, "waiting"), "an option's number, or no");
    assert.equal(fieldPlaceholder(mode, "waiting", true), "answer this one in Claude Code");
});

const NO_PLUGIN_SESSION = "2b6f8d0c-9a47-4e15-b3c8-5d7e1f9a0b2c";

test("a project acts, and a Brief has a field, unless the list shows its session's checkout without Izbor's answer hook, or in a project without Izbor's hooks", () => {
    const failed: SessionList = { state: "no list", reason: "claude agents failed", last: listedSessions(world.list) };
    for (const [has, absent, beforeList, what] of [
        [acts, NO_PLUGIN_SESSION, SAMPLE_IDS[1], "acts: invoice-api has Izbor's hooks and no plugin"],
        [hooked, NO_HOOKS, NO_HOOKS, "hooked"],
    ] as const) {
        assert.equal(has(SAMPLE_IDS[1], world.list), true, what);
        assert.equal(has(absent, world.list), false, what);
        assert.equal(
            has("11111111-2222-4333-8444-555555555555", world.list),
            true,
            `${what}: a session the list lacks`,
        );
        assert.equal(has(beforeList, { state: "loading" }), true, `${what}: before the first list`);
        assert.equal(has(absent, failed), false, `${what}: a failed list's last sessions still count`);
    }
});

function waiting(answerable?: TerminalBrief["answerable"], sent?: SentAnswer): Observation {
    const { answerable: _held, ...unsaid } = WAITING!;
    return {
        id: SAMPLE_IDS[1],
        connection: { state: "live" },
        brief: { ...unsaid, ...(answerable !== undefined && { answerable }) },
        ...(sent && { sent }),
    };
}
const NOW = new Date(Date.parse(AT) + 60_000);
const muted = (text: string) => [{ text, tone: "muted" }];

test("Needs you closes with where to answer while a request waits in a project without the plugin and Izbor does not hold it", () => {
    const CLOSING = "Answer in Claude Code: this project has no plugin.";
    assert.deepEqual(closingLines(waiting("not an acting project"), false, NOW), muted(CLOSING));
    assert.deepEqual(closingLines(waiting(), false, NOW), muted(CLOSING), "an older Izbor says nothing of answerable");
    assert.deepEqual(closingLines(waiting("not an acting project"), true, NOW), muted(CLOSING), "Izbor's word wins");
    assert.deepEqual(closingLines(waiting(true), false, NOW), []);
    assert.deepEqual(closingLines(waiting(), true, NOW), [], "Izbor did not say, and the project acts");
    assert.deepEqual(closingLines({ id: SAMPLE_IDS[2], connection: { state: "live" }, brief: IDLE! }, false, NOW), []);
    const unknown = { ...waiting().brief!, needsYou: { state: "unknown" } as const };
    assert.deepEqual(closingLines({ ...waiting(), brief: unknown }, false, NOW), []);
    assert.deepEqual(
        closingLines({ id: SAMPLE_IDS[1], connection: { state: "connecting" }, brief: null }, false, NOW),
        [],
    );
});

test("Needs you closes with one fact for each reason Izbor cannot answer, word for word from the grill's table", () => {
    const lines = (answerable: TerminalBrief["answerable"]) => closingLines(waiting(answerable), true, NOW);
    assert.deepEqual(
        lines("not running when it asked"),
        muted("Answer in Claude Code: Izbor was not running when it asked."),
    );
    const noLonger = muted("Answer in Claude Code: Izbor is no longer holding this request.");
    assert.deepEqual(lines("expired"), noLonger);
    assert.deepEqual(lines("Izbor restarted"), noLonger);
    assert.deepEqual(
        lines("plan approval not supported"),
        muted("Answer in Claude Code: Izbor does not answer plan approvals."),
    );
    assert.deepEqual(
        lines("question not supported"),
        muted("Answer in Claude Code: Izbor answers only one question with one choice."),
    );
    assert.deepEqual(
        lines("subagent wait over"),
        muted("Answer in Claude Code: the subagent's wait for Izbor is over."),
    );
    assert.deepEqual(lines("answered"), muted("That request has an answer already."), "another window answered");
    assert.deepEqual(lines("something new" as TerminalBrief["answerable"]), muted("Answer in Claude Code."));
});

const SENT: SentAnswer = { at: AT, text: "yes", sentAt: new Date(Date.parse(AT) + 57_000).toISOString() };

test("in the window that answered, Needs you closes with Sent from Izbor and its age, then the rose × warning once the request still waits, on a live row only", () => {
    assert.deepEqual(closingLines(waiting("answered", SENT), true, NOW), muted("Sent from Izbor: yes · 3s ago"));
    assert.deepEqual(
        closingLines(waiting(true, SENT), true, NOW),
        muted("Sent from Izbor: yes · 3s ago"),
        "before Izbor's brief says answered",
    );
    assert.deepEqual(
        closingLines(waiting("answered", SENT), true, new Date(NOW.getTime() + 5_000)),
        muted("Sent from Izbor: yes · 8s ago"),
        "its age counts up",
    );
    assert.deepEqual(closingLines(waiting("answered", { ...SENT, stillWaits: true }), true, NOW), [
        { text: "Sent from Izbor: yes · 3s ago", tone: "muted" },
        { text: "× That request still waits: answer it in the session.", tone: "error" },
    ]);
    const dropped: Observation = {
        ...waiting("answered", { ...SENT, stillWaits: true }),
        connection: { state: "disconnected", since: AT },
    };
    assert.deepEqual(
        closingLines(dropped, true, NOW),
        muted("Sent from Izbor: yes · 3s ago"),
        "not under the Brief's ▲ notice: the stream is not live",
    );
    const words = { ...SENT, text: "no, run only the export tests" };
    assert.deepEqual(
        closingLines(waiting("answered", words), true, NOW),
        muted("Sent from Izbor: no, run only the export tests · 3s ago"),
    );
});

test("what this window sent counts only for the request it answered: another request, or none, shows nothing of it", () => {
    assert.equal(sentTo(waiting("answered", SENT)), SENT);
    const other = { ...SENT, at: "2026-01-01T00:00:00.000Z" };
    assert.equal(sentTo(waiting(true, other)), undefined);
    assert.deepEqual(closingLines(waiting(true, other), true, NOW), []);
    assert.equal(sentTo({ id: SAMPLE_IDS[2], connection: { state: "live" }, brief: IDLE!, sent: SENT }), undefined);
    assert.equal(sentTo(waiting("answered")), undefined);
});

test("the field's line says what was sent while the field is empty, until the request is over or the warning shows; a message of the field's own wins", () => {
    const SENTENCE = { text: "Sent yes. Needs you clears when the agent goes on.", error: false };
    assert.deepEqual(fieldLine(emptyField(), waiting("answered", SENT)), SENTENCE);
    const words = { ...SENT, text: "no, run only the export tests" };
    assert.deepEqual(fieldLine(emptyField(), waiting("answered", words)), {
        text: "Sent no, run only the export tests. Needs you clears when the agent goes on.",
        error: false,
    });
    assert.equal(fieldLine(emptyField(), waiting("answered", { ...SENT, stillWaits: true })), null, "the warning");
    assert.equal(fieldLine(emptyField(), waiting("answered")), null, "another window's answer");
    const over: Observation = { id: SAMPLE_IDS[1], connection: { state: "live" }, brief: IDLE!, sent: SENT };
    assert.equal(fieldLine(emptyField(), over), null, "Needs you cleared");
    const typing = editField(emptyField(), ANSWER, "n", {});
    assert.equal(fieldLine(typing, waiting("answered", SENT)), null, "your next key");
    const refused = { ...typing, message: { text: "That request has an answer already.", error: true } };
    assert.deepEqual(fieldLine(refused, waiting("answered", SENT)), refused.message);
});

const YES: FieldState = { text: "yes", cursor: 3, fixed: ANSWER, message: null };
const refusal = (row: Observation, field = YES, list: SessionList = NO_PLUGIN, izbor = "up" as const) =>
    sendRefusal(field, row, izbor, list);

test("Enter on a request Izbor holds sends: nothing refuses it", () => {
    assert.equal(refusal(waiting(true)), undefined);
    assert.equal(refusal(waiting(), YES, { state: "loading" }), undefined, "Izbor did not say, and no list says no");
});

test("a request that ended or changed between the first key and Enter is refused, and so is another session's Brief", () => {
    const CHANGED = "That request is over or changed: check the Brief.";
    assert.equal(refusal({ id: SAMPLE_IDS[1], connection: { state: "live" }, brief: BUSY! }), CHANGED, "E9");
    const next = waiting(true);
    next.brief = { ...next.brief!, needsYou: { ...ANSWER_NEEDS, at: "2026-01-01T00:00:00.000Z" } };
    assert.equal(refusal(next), CHANGED, "a new request of the same tool call");
    assert.equal(refusal({ ...waiting(true), id: SAMPLE_IDS[2] }), CHANGED, "the Brief of another session");
});
const ANSWER_NEEDS = WAITING!.needsYou as Extract<TerminalBrief["needsYou"], { state: "request" }>;

test("Enter on a request Izbor cannot answer is refused with the reason's sentence, and nothing is sent", () => {
    const of = (answerable: TerminalBrief["answerable"]) => refusal(waiting(answerable), YES, { state: "loading" });
    assert.equal(of("not running when it asked"), "Answer it in the session: Izbor was not running when it asked.");
    assert.equal(of("expired"), "Answer it in the session: Izbor is no longer holding this request.");
    assert.equal(of("Izbor restarted"), "Answer it in the session: Izbor is no longer holding this request.");
    assert.equal(of("plan approval not supported"), "Answer it in the session: Izbor does not answer plan approvals.");
    assert.equal(
        of("question not supported"),
        "Answer it in the session: Izbor answers only one question with one choice.",
    );
    assert.equal(of("subagent wait over"), "A subagent asks: answer it in the session.");
    assert.equal(of("answered"), "That request has an answer already.");
    assert.equal(of("something new" as TerminalBrief["answerable"]), "Answer it in the session.");
    assert.equal(of("not an acting project"), "Answer it in the session: this project has no plugin.", "no list");
});

function unseen(answerable?: TerminalBrief["answerable"], waitingFor: string | null = "permission prompt") {
    const { needsYou: _request, ...brief } = waiting(answerable).brief!;
    const needsYou = { state: "unknown", ...(waitingFor !== null && { waitingFor, at: AT }) } as const;
    return { ...waiting(), brief: { ...brief, needsYou } };
}

test("a wait Izbor saw no request for and cannot answer: the field is an answer field, Needs you closes with why, and Enter refuses with the reason", () => {
    const row = unseen("not running when it asked");
    assert.deepEqual(fieldMode(row.brief), { mode: "answer", at: AT });
    assert.equal(fieldTitle(fieldMode(row.brief)), "Answer");
    assert.deepEqual(
        closingLines(row, true, NOW),
        muted("Answer in Claude Code: Izbor was not running when it asked."),
    );
    const mode: FixedMode = { ...fieldMode(row.brief), session: row.id };
    const yes: FieldState = { ...YES, fixed: mode };
    const NOT_RUNNING = "Answer it in the session: Izbor was not running when it asked.";
    assert.equal(refusal(row, yes), NOT_RUNNING);
    assert.equal(refusal(row, yes, { state: "loading" }), NOT_RUNNING, "with no list too");
    const pluginless = unseen("not an acting project");
    assert.deepEqual(closingLines(pluginless, true, NOW), muted("Answer in Claude Code: this project has no plugin."));
    assert.equal(refusal(pluginless, yes), NO_PLUGIN_HERE);
    assert.equal(refusal(unseen("something new" as TerminalBrief["answerable"]), yes), "Answer it in the session.");
});

test("a wait Izbor gave no reason for, or one with no name, stays as it was: reply mode and no closing line, whatever the list says", () => {
    for (const row of [unseen(), unseen(true), unseen("not running when it asked", null)]) {
        assert.deepEqual(fieldMode(row.brief), { mode: "reply" });
        assert.deepEqual(closingLines(row, false, NOW), []);
    }
});

test("an answer typed for a wait is refused once the wait is over, a request took its place, or it is another wait; a yes typed for a request is refused under a wait", () => {
    const CHANGED = "That request is over or changed: check the Brief.";
    const row = unseen("not running when it asked");
    const yes: FieldState = { ...YES, fixed: { ...fieldMode(row.brief), session: row.id } };
    assert.equal(refusal({ ...row, brief: IDLE! }, yes), CHANGED);
    const later = { ...row.brief.needsYou, at: "2026-01-01T00:00:00.000Z" };
    assert.equal(refusal({ ...row, brief: { ...row.brief, needsYou: later } }, yes), CHANGED, "another wait");
    const asked = waiting(true);
    asked.brief = { ...asked.brief!, needsYou: { ...ANSWER_NEEDS, at: "2026-01-01T00:00:00.000Z" } };
    assert.equal(refusal(asked, yes), CHANGED, "the request came: the yes was not typed for it");
    assert.equal(refusal(unseen("not running when it asked", null), YES), CHANGED);
});

test("a reply typed before the wait came is not sent under it: Enter says to answer the request first", () => {
    const reply: FieldState = { text: "go on", cursor: 5, fixed: REPLY, message: null };
    assert.equal(refusal(unseen("not running when it asked"), reply), "Answer the request first.");
});

test("in a project without the plugin the refusal names Home's Add plugin cue and no typed command", () => {
    assert.equal(
        NO_PLUGIN_HERE,
        "This project has no plugin: answer in Claude Code, or add it with Add plugin › on Home.",
    );
    assert.equal(sendRefusal(YES, waiting("not an acting project"), "up", NO_PLUGIN), NO_PLUGIN_HERE);
    assert.equal(sendRefusal(YES, waiting(), "up", NO_PLUGIN), NO_PLUGIN_HERE, "Izbor did not say; the list does");
    assert.equal(sendRefusal(YES, waiting(true), "up", NO_PLUGIN), undefined, "a held request still answers");
});

test("a Brief that is not live refuses with one sentence per state, in either mode, and keeps the text", () => {
    const row = (connection: Connection, brief = IDLE!): Observation => ({ id: SAMPLE_IDS[2], connection, brief });
    const reply: FieldState = {
        text: "run the tests again",
        cursor: 19,
        fixed: { mode: "reply", session: SAMPLE_IDS[2] },
        message: null,
    };
    const of = (connection: Connection, izbor: "up" | "stopping" | "not running" = "up") =>
        sendRefusal(reply, row(connection), izbor, ACTS);
    const RECONNECTING = "Izbor is reconnecting: nothing was sent. Try again in a moment.";
    assert.equal(of({ state: "disconnected", since: AT }), RECONNECTING);
    assert.equal(of({ state: "catching up" }), RECONNECTING);
    assert.equal(of({ state: "connecting" }), RECONNECTING);
    assert.equal(of({ state: "stopped", why: "deleted" }), "Izbor is not watching this session: nothing was sent.");
    assert.equal(
        of({ state: "refused", status: 404, message: "no" }),
        "Izbor is not watching this session: nothing was sent.",
    );
    assert.equal(of({ state: "izbor away", reason: "not running" }), "Izbor is not running: nothing was sent.");
    assert.equal(of({ state: "izbor away", reason: "stopping" }), "Izbor is stopping: nothing was sent.");
    assert.equal(of({ state: "stopped", why: "izbor stopping" }), "Izbor is stopping: nothing was sent.");
    assert.equal(of({ state: "disconnected", since: AT }, "stopping"), "Izbor is stopping: nothing was sent.");
    assert.equal(of({ state: "disconnected", since: AT }, "not running"), "Izbor is not running: nothing was sent.");
    assert.equal(
        sendRefusal(reply, row({ state: "live" }, { ...IDLE!, status: "not listed" }), "up", ACTS),
        "The session has ended: nothing was sent.",
    );
    assert.equal(of({ state: "live" }), undefined, "a live Brief in reply mode: the store answers");
    assert.equal(
        refusal({ ...waiting(true), connection: { state: "disconnected", since: AT } }),
        RECONNECTING,
        "answer mode too, before any word on the request",
    );
});

test("typing fixes the mode at the first edit and keeps it while text sits in the field; emptying it lets the mode follow the Brief again", () => {
    const started = editField(emptyField(), ANSWER, "y", {});
    assert.deepEqual(started, { text: "y", cursor: 1, fixed: ANSWER, message: null });
    const kept = editField(started, REPLY, "es", {});
    assert.deepEqual(
        kept,
        { text: "yes", cursor: 3, fixed: ANSWER, message: null },
        "the Brief's mode changed; the label holds still",
    );
    assert.deepEqual(shownMode(kept, IDLE!), ANSWER);
    const one = key(key(kept, "backspace"), "backspace");
    assert.deepEqual(one.fixed, ANSWER, "text still sits in the field");
    const empty = key(one, "backspace");
    assert.deepEqual(empty, { text: "", cursor: 0, fixed: null, message: null });
    assert.deepEqual(shownMode(empty, IDLE!), { mode: "reply" });
    assert.deepEqual(shownMode(empty, WAITING!), ANSWER_MODE);
});

test("an edit clears the field's message; a caret move keeps it and the fixed mode", () => {
    const refused: FieldState = { text: "yse", cursor: 3, fixed: ANSWER, message: { text: "Type yes.", error: true } };
    const moved = key(refused, "left");
    assert.deepEqual(moved, { ...refused, cursor: 2 });
    assert.deepEqual(key(refused, "home").message, refused.message);
    assert.deepEqual(key(refused, "up"), refused, "a key the editor ignores changes nothing");
    assert.deepEqual(typed(refused, "!"), { text: "yse!", cursor: 4, fixed: ANSWER, message: null });
    assert.deepEqual(key(refused, "delete").message, null, "Delete at the end is still an edit");
});

test("Ctrl-U cuts the text before the caret, and an emptied field lets the mode follow the Brief again", () => {
    const typed3 = editField(emptyField(), ANSWER, "yes", {});
    const cut = editField(typed3, REPLY, undefined, { name: "u", ctrl: true });
    assert.deepEqual(cut, { text: "", cursor: 0, fixed: null, message: null });
    const refused: FieldState = { text: "yse", cursor: 2, fixed: ANSWER, message: { text: "Type yes.", error: true } };
    assert.deepEqual(editField(refused, REPLY, undefined, { name: "u", ctrl: true }), {
        text: "e",
        cursor: 0,
        fixed: ANSWER,
        message: refused.message,
    });
});

test("news goes on the field's line muted, a refusal rose, and the text stays; the sentence names the session the send was for, and shows only on its Brief", () => {
    assert.deepEqual(afterSend(YES, { news: "The sample sends nothing." }, SAMPLE_IDS[1], true), {
        ...YES,
        message: { text: "The sample sends nothing.", error: false, session: SAMPLE_IDS[1] },
    });
    const refused = afterSend(YES, { refused: "Type yes, no, or no and your words." }, SAMPLE_IDS[1], true);
    const message = { text: "Type yes, no, or no and your words.", error: true, session: SAMPLE_IDS[1] };
    assert.deepEqual(refused, { ...YES, message });
    assert.deepEqual(fieldLine(refused, waiting(true)), message);
    assert.equal(fieldLine(refused, idle()), null, "not under another session's Brief");
    const dropped = idle({ ...PROMPT, state: "dropped" });
    assert.equal(fieldLine(refused, dropped)?.text, "That prompt did not run.", "nor over its dropped prompt's line");
});

test("an answer that was sent empties the field and its line; text typed while it was out stays", () => {
    const stale = { ...YES, message: { text: "Type yes, no, or no and your words.", error: true } };
    assert.deepEqual(afterSend(stale, { sent: "yes" }, SAMPLE_IDS[1], true), emptyField());
    const more: FieldState = { ...stale, text: "yes please", cursor: 10 };
    assert.deepEqual(afterSend(more, { sent: "yes" }, SAMPLE_IDS[1], false), more);
});

const idle = (prompt?: SentPrompt): Observation => ({
    id: SAMPLE_IDS[2],
    connection: { state: "live" },
    brief: IDLE!,
    ...(prompt && { prompt }),
});
const busy = (prompt?: SentPrompt): Observation => ({
    id: SAMPLE_IDS[0],
    connection: { state: "live" },
    brief: BUSY!,
    ...(prompt && { prompt }),
});
const ACTS: SessionList = {
    state: "listed",
    at: AT,
    sessions: listedSessions(world.list).map((session) => ({ ...session, acting: true })),
};
const REPLY_MODE: FieldMode = { mode: "reply" };
const PROMPT: SentPrompt = { id: "p1", text: "run the tests again", sentAt: AT, state: "sent" };
const typedReply = (session: string, text = "run the tests again"): FieldState => ({
    text,
    cursor: text.length,
    fixed: { mode: "reply", session },
    message: null,
});

test("R7: in a project the list shows without the plugin, the reply field's placeholder says so; a project that acts and a session the list lacks keep your next prompt", () => {
    assert.equal(placeholderOn(REPLY_MODE, idle(), NO_PLUGIN, false), "this project has no plugin");
    assert.equal(placeholderOn(REPLY_MODE, busy(), NO_PLUGIN, false), "this project has no plugin");
    assert.equal(placeholderOn(REPLY_MODE, idle(), ACTS, false), "your next prompt");
    assert.equal(placeholderOn(REPLY_MODE, idle(), { state: "loading" }, false), "your next prompt");
    assert.equal(
        placeholderOn(REPLY_MODE, world.row(SAMPLE_IDS[2]), world.list, false),
        "your next prompt",
        "the sample list: izbor has the plugin",
    );
    assert.equal(
        placeholderOn(REPLY_MODE, world.row(SAMPLE_IDS[0]), world.list, false),
        "your next prompt; it runs when this turn ends",
        "the busy session of a project with the plugin",
    );
    assert.equal(
        placeholderOn(ANSWER_MODE, waiting(true), NO_PLUGIN, false),
        "yes, no, or no and your words",
        "answer mode is as it was",
    );
    assert.equal(placeholderOn(ANSWER_MODE, waiting("answered", SENT), ACTS, true), "", "none after an answer");
});

test("E7: a busy session says once that the prompt waits: while this window's prompt waits for the turn's end the placeholder is just your next prompt, and the busy form is back once that is over", () => {
    assert.equal(placeholderOn(REPLY_MODE, busy(), ACTS, false), "your next prompt; it runs when this turn ends");
    assert.equal(placeholderOn(REPLY_MODE, busy({ ...PROMPT, state: "queued" }), ACTS, false), "your next prompt");
    assert.equal(
        placeholderOn(REPLY_MODE, busy({ ...PROMPT, state: "dropped" }), ACTS, false),
        "your next prompt; it runs when this turn ends",
    );
    assert.equal(placeholderOn(REPLY_MODE, idle(PROMPT), ACTS, false), "your next prompt", "X1");
});

test("the field's line says a prompt went while the field is empty: Sent to this session, or that it runs when this turn ends, and your next key hides it", () => {
    assert.deepEqual(fieldLine(emptyField(), idle(PROMPT)), { text: "Sent to this session.", error: false });
    assert.deepEqual(fieldLine(emptyField(), busy({ ...PROMPT, state: "queued" })), {
        text: "Sent. It runs when this turn ends.",
        error: false,
    });
    assert.equal(fieldLine(emptyField(), idle()), null);
    assert.equal(fieldLine(typedReply(SAMPLE_IDS[2], "a"), idle(PROMPT)), null, "your next key");
    const refused = { ...typedReply(SAMPLE_IDS[2]), message: { text: "Answer the request first.", error: true } };
    assert.deepEqual(fieldLine(refused, idle(PROMPT)), refused.message, "a message of the field's own wins");
});

test("a dropped prompt's rose line shows on its own Brief from the row, with text in the field too, until an edit under that Brief; an edit under another Brief, a caret move and a sent answer leave it as it was", () => {
    const row = busy({ ...PROMPT, state: "dropped", reason: "it was taken off the session's queue" });
    const line = {
        text: "That prompt did not run: it was taken off the session's queue.",
        error: true,
        session: row.id,
    };
    assert.deepEqual(fieldLine(emptyField(), row), line);
    const elsewhere = editField(emptyField(), modeOn(idle()), "a", {}, idle());
    assert.deepEqual(
        elsewhere,
        typedReply(SAMPLE_IDS[2], "a"),
        "no prompt was dropped under this Brief: nothing is kept",
    );
    assert.deepEqual(fieldLine(elsewhere, row), line, "typed under another session's Brief");
    assert.deepEqual(fieldLine(editField(emptyField(), modeOn(row), undefined, { name: "left" }, row), row), line);
    const told = editField(emptyField(), modeOn(row), "a", {}, row);
    assert.deepEqual(told.told, [PROMPT.id]);
    assert.equal(fieldLine(told, row), null, "your next key in the field under its Brief");
    assert.deepEqual(editField(told, modeOn(row), "b", {}, row).told, [PROMPT.id], "once");
    const answered = afterSend(told, { sent: "a" }, row.id, true);
    assert.deepEqual(answered, { ...emptyField(), told: [PROMPT.id] });
    assert.equal(fieldLine(answered, row), null, "a send that empties the field does not bring it back");
    assert.deepEqual(fieldLine(told, { ...row, prompt: { ...row.prompt!, id: "the-next-one" } }), line);
});

test("a dropped prompt is told only by an edit typed while its line was the one showing: an edit that clears another sentence of that session leaves the dropped line, which shows next", () => {
    const row = idle({ ...PROMPT, state: "dropped" });
    const refusal = { text: "Answer the request first.", error: true, session: row.id };
    const refused = { ...typedReply(row.id, "and lint"), message: refusal };
    assert.deepEqual(fieldLine(refused, row), refusal, "the refusal is over the dropped line");
    const cleared = editField(refused, modeOn(row), "!", {}, row);
    assert.equal(cleared.told, undefined, "the dropped line was not showing");
    assert.equal(fieldLine(cleared, row)?.text, "That prompt did not run.");
    assert.deepEqual(editField(cleared, modeOn(row), "!", {}, row).told, [PROMPT.id], "now it was");
    const heard = afterDrop(typedReply(row.id, "and lint"), row, true);
    assert.deepEqual(editField(heard, modeOn(row), "!", {}, row).told, [PROMPT.id]);
});

test("a message that names its session shows only on that session's Brief", () => {
    const message = { text: "That prompt did not run.", error: true, session: SAMPLE_IDS[2] };
    const field = { ...emptyField(), message };
    assert.deepEqual(fieldLine(field, idle()), message);
    assert.equal(fieldLine(field, busy()), null, "not under another session's Brief");
    assert.deepEqual(
        fieldLine(field, busy({ ...PROMPT, state: "queued" })),
        { text: "Sent. It runs when this turn ends.", error: false },
        "where that Brief's own line shows",
    );
});

test("a reply goes only to the session it was typed for, never while a request waits, and not to a project without the plugin; otherwise nothing refuses it", () => {
    const of = (row: Observation, list: SessionList = ACTS, field = typedReply(SAMPLE_IDS[2])) =>
        sendRefusal(field, row, "up", list);
    assert.equal(of(idle()), undefined, "the store sends it");
    assert.equal(of(idle(), { state: "loading" }), undefined, "no list says no");
    assert.equal(of(busy()), "You typed this on another session's Brief: nothing was sent.");
    const asks: Observation = { ...waiting(true), id: SAMPLE_IDS[2] };
    assert.equal(of(asks), "Answer the request first.");
    assert.equal(of({ ...waiting("expired"), id: SAMPLE_IDS[2] }), "Answer the request first.", "answerable or not");
    assert.equal(sendRefusal(typedReply(SAMPLE_IDS[2]), idle(), "up", NO_PLUGIN), NO_PLUGIN_HERE, "R7");
    assert.equal(
        sendRefusal(typedReply(SAMPLE_IDS[2]), world.row(SAMPLE_IDS[2]), "up", world.list),
        undefined,
        "a project with the plugin: its store answers",
    );
    assert.equal(
        of({ ...idle(), connection: { state: "catching up" } }, NO_PLUGIN),
        "Izbor is reconnecting: nothing was sent. Try again in a moment.",
        "a Brief that is not live says so first",
    );
});

const DROPPED: SentPrompt = { ...PROMPT, state: "dropped", reason: "it was taken off the session's queue" };
const DID_NOT_RUN = {
    text: "That prompt did not run: it was taken off the session's queue.",
    error: true,
    session: SAMPLE_IDS[2],
};

test("E8: a dropped prompt comes back into an empty field with no request waiting, on its own session's Brief, with the rose line and the reply mode fixed on that session", () => {
    assert.deepEqual(afterDrop(emptyField(), idle(DROPPED), true), {
        text: "run the tests again",
        cursor: 19,
        fixed: { mode: "reply", session: SAMPLE_IDS[2] },
        message: DID_NOT_RUN,
    });
});

test("E8: with text in the field, a request waiting or another Brief shown, a dropped prompt is only the rose line: it never lands in an answer field", () => {
    const typing = typedReply(SAMPLE_IDS[2], "and lint");
    assert.deepEqual(afterDrop(typing, idle(DROPPED), true), { ...typing, message: DID_NOT_RUN });
    const asks: Observation = { ...waiting(true), id: SAMPLE_IDS[2], prompt: DROPPED };
    assert.deepEqual(afterDrop(emptyField(), asks, true), { ...emptyField(), message: DID_NOT_RUN });
    assert.deepEqual(afterDrop(emptyField(), idle(DROPPED), false), { ...emptyField(), message: DID_NOT_RUN });
});

test("a sentence of one session on the field's line is not lost to another session's: a refusal, news or a dropped prompt's line takes the line and the first stays behind it, shown on its own Brief; a session keeps its latest only, and an edit clears them all", () => {
    const noReply = { text: "Izbor gave no reply: check the Brief before you send again.", error: true };
    const mine = { ...noReply, session: SAMPLE_IDS[0] };
    const held: FieldState = { ...typedReply(SAMPLE_IDS[0], "and lint"), message: mine };
    const other = { text: "Answer the request first.", error: true, session: SAMPLE_IDS[1] };
    const refused = afterSend(held, { refused: other.text }, SAMPLE_IDS[1], true);
    assert.deepEqual(refused, { ...held, message: other, behind: [mine] });
    assert.deepEqual(fieldLine(refused, busy()), mine);
    assert.deepEqual(fieldLine(refused, waiting(true)), other);
    assert.equal(fieldLine(refused, idle()), null, "a third session's Brief has neither");
    const dropped = afterDrop(refused, idle(DROPPED), true);
    assert.deepEqual(dropped, { ...held, message: DID_NOT_RUN, behind: [mine, other] });
    assert.deepEqual(fieldLine(dropped, busy()), mine);
    assert.deepEqual(afterDrop(held, idle(DROPPED), true), { ...held, message: DID_NOT_RUN, behind: [mine] });
    const again = afterSend(dropped, { news: "The sample sends nothing." }, SAMPLE_IDS[0], true);
    assert.deepEqual(again, {
        ...held,
        message: { text: "The sample sends nothing.", error: false, session: SAMPLE_IDS[0] },
        behind: [other, DID_NOT_RUN],
    });
    const once = afterSend(held, { refused: noReply.text }, SAMPLE_IDS[0], true);
    assert.deepEqual(once, held, "nothing stays behind a session's own sentence");
    assert.deepEqual(key(refused, "left").behind, [mine]);
    assert.deepEqual(typed(refused, "!"), { ...typedReply(SAMPLE_IDS[0], "and lint!"), message: null });
});

test("a dropped prompt's line gives the plugin's reason as a sentence, or none when it gave none", () => {
    const line = (reason?: string) =>
        afterDrop(emptyField(), idle({ ...PROMPT, state: "dropped", ...(reason !== undefined && { reason }) }), false)
            .message?.text;
    assert.equal(line(), "That prompt did not run.");
    assert.equal(line(""), "That prompt did not run.");
    assert.equal(
        line("the prompt was removed from the queue before it ran"),
        "That prompt did not run: the prompt was removed from the queue before it ran.",
    );
    assert.equal(line("Already full."), "That prompt did not run: Already full.");
    assert.equal(line("two\nlines\u001b[31m "), "That prompt did not run: two lines.", "session data, on one line");
});

test("one message shows: on a Brief the field's own line, else the last act's feedback; an act takes the field's sentences off", () => {
    const row: Observation = { id: SAMPLE_IDS[2], connection: { state: "live" }, brief: IDLE! };
    const news = { text: "Observing izbor-e8.", error: false };
    const view = { feedback: news.text, feedbackIsError: false, field: emptyField() };
    assert.deepEqual(shownMessage(view, undefined), news, "a list, Help, or a Brief with no field");
    assert.deepEqual(shownMessage(view, row), news, "a Brief whose field says nothing");
    const refusal = { text: "Answer the request first.", error: true, session: SAMPLE_IDS[2] };
    const refused = { ...view, field: { ...emptyField(), message: refusal } };
    assert.deepEqual(shownMessage(refused, row), refusal, "the field's own line, on its Brief");
    assert.deepEqual(shownMessage(refused, undefined), news, "not where no field shows");
    assert.equal(shownMessage({ feedback: "", feedbackIsError: true, field: emptyField() }, row), null);
    const said = { ...refused.field, text: "go on", cursor: 5, behind: [{ ...refusal, session: SAMPLE_IDS[0] }] };
    assert.deepEqual(unsaid(said), { text: "go on", cursor: 5, fixed: null, message: null });
});

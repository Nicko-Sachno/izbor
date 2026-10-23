import stringWidth from "string-width";
import { NOT_ANSWERABLE, REQUEST_CHANGED, type NotAnswerable } from "../domain/answer.js";
import { editLine, type EditKey } from "./line-editor.js";
import {
    listedSession,
    unseenWait,
    type FieldAnswer,
    type FieldMessage,
    type FieldMode,
    type FieldState,
    type FixedMode,
    type Observation,
    type IzborState,
    type SentAnswer,
    type SessionList,
    type TerminalBrief,
    type TerminalView,
} from "./model.js";
import { refusalWords, relativeTime, singleLine, type Tone } from "./presentation.js";
import { droppedLine, NO_PLUGIN_HERE, pluginless, promptLine, replyRefusal, saidOn, saying, toldOf } from "./reply.js";

export const NO_REPLY = "Izbor gave no reply: check the Brief before you answer again.";

const FIELD_FULL = "The field holds 64 KB: the rest was not added.";

export const NOTHING_SENT = {
    stopping: "Izbor is stopping: nothing was sent.",
    "not running": "Izbor is not running: nothing was sent.",
    notWatching: "Izbor is not watching this session: nothing was sent.",
} as const;

export const emptyField = (): FieldState => ({ text: "", cursor: 0, fixed: null, message: null });

export function fieldMode(brief: TerminalBrief | null): FieldMode {
    const wait = unseenWait(brief);
    if (wait) return { mode: "answer", ...(wait.at !== undefined && { at: wait.at }) };
    if (brief?.needsYou.state !== "request") return { mode: "reply" };
    const { at, takes } = brief.needsYou;
    return { mode: "answer", ...(takes && { takes }), ...(at !== undefined && { at }) };
}

export const modeOn = (row: Observation | undefined): FixedMode => ({
    ...fieldMode(row?.brief ?? null),
    session: row?.id ?? "",
});

export const shownMode = (field: FieldState, brief: TerminalBrief | null): FieldMode => field.fixed ?? fieldMode(brief);

const SEPARATOR = " · ";

/** The field's title: its name, then from 2 lines up how many lines its text has, split at its new lines so a wrapped
 *  line is one, then while rows of its text are scrolled out above the box how many; `·` between them. */
export function fieldTitle(mode: FieldMode, { lines, above } = { lines: 1, above: 0 }): string {
    const counts = [...(lines > 1 ? [`${lines} lines`] : []), ...(above > 0 ? [`${above} above`] : [])];
    return [mode.mode === "answer" ? "Answer" : "Reply to this session", ...counts].join(SEPARATOR);
}

/** What the field's bottom edge says from its text's first new line, or while the field has the cursor: its keys. */
const FIELD_HINT = `Ctrl-J new line${SEPARATOR}Enter sends`;

/** What it says instead while the cursor stands right after a paste block. */
const PASTE_HINT = `Backspace removes the paste${SEPARATOR}Enter sends`;

/** The field's bottom edge for its text of `lines` lines (a paste block in none of them): the paste's keys while the
 *  field has the cursor right after a block, its own from the first new line or while it has the cursor, else none. */
export function fieldHint({ cursor, pasted }: FieldState, focused: boolean, lines: number): string {
    if (focused && pasted?.some(({ end }) => end === cursor)) return PASTE_HINT;
    return focused || lines > 1 ? FIELD_HINT : "";
}

/**
 * One edge of the field's box, `width` wide, between its two corners: `─ `, the words and a space, then the rule. Where
 * the words do not fit, their trailing `· …` parts drop, last first, and what is left may meet the corner, as the
 * title always could; no words, all rule. `draw` paints the words, which are measured as they are.
 */
export function fieldEdge(words: string, width: number, draw = (shown: string) => shown): string {
    const room = width - 5;
    let shown = words;
    while (stringWidth(shown) > room && shown.includes(SEPARATOR)) shown = shown.slice(0, shown.lastIndexOf(SEPARATOR));
    const rule = "─".repeat(Math.max(0, shown ? room - stringWidth(shown) : width - 2));
    return shown ? `─ ${draw(shown)} ${rule}` : rule;
}

export function fieldPlaceholder(mode: FieldMode, status: TerminalBrief["status"] | undefined, closed = false): string {
    if (mode.mode === "answer") {
        if (closed) return "answer this one in Claude Code";
        return mode.takes === "number" ? "an option's number, or no" : "yes, no, or no and your words";
    }
    return status === "busy" ? "your next prompt; it runs when this turn ends" : "your next prompt";
}

export function placeholderOn(
    mode: FieldMode,
    row: Observation | undefined,
    list: SessionList,
    closed: boolean,
): string {
    if (row && sentTo(row)) return "";
    if (mode.mode === "reply" && row && pluginless(row, list)) return "this project has no plugin";
    return fieldPlaceholder(mode, row?.prompt?.state === "queued" ? undefined : row?.brief?.status, closed);
}

export function hooked(id: string, list: SessionList): boolean {
    return listedSession(list, id)?.hooks ?? true;
}

export function acts(id: string, list: SessionList): boolean {
    return listedSession(list, id)?.acting ?? true;
}

export type BriefLine = { text: string; tone: Tone };

export function sentTo({ brief, sent }: Observation): SentAnswer | undefined {
    return brief?.needsYou.state === "request" && sent?.at === brief.needsYou.at ? sent : undefined;
}

const WHY_NOT: Record<NotAnswerable, string> = {
    "not an acting project": "Answer in Claude Code: this project has no plugin.",
    "not running when it asked": "Answer in Claude Code: Izbor was not running when it asked.",
    expired: "Answer in Claude Code: Izbor is no longer holding this request.",
    "Izbor restarted": "Answer in Claude Code: Izbor is no longer holding this request.",
    "subagent wait over": "Answer in Claude Code: the subagent's wait for Izbor is over.",
    answered: NOT_ANSWERABLE.answered,
    "plan approval not supported": "Answer in Claude Code: Izbor does not answer plan approvals.",
    "question not supported": "Answer in Claude Code: Izbor answers only one question with one choice.",
};

function whyNot(brief: TerminalBrief | null, acting: boolean): NotAnswerable | undefined {
    const wait = unseenWait(brief);
    if (wait) return wait.answerable;
    if (brief?.needsYou.state !== "request" || brief.answerable === true) return undefined;
    return brief.answerable ?? (acting ? undefined : "not an acting project");
}

export function closingLines(row: Observation, acting: boolean, now: Date): BriefLine[] {
    const sent = sentTo(row);
    if (sent) {
        const line = `Sent from Izbor: ${sent.text} · ${relativeTime(sent.sentAt, now)}`;
        const waits = refusalWords("That request still waits: answer it in the session.");
        const shown = sent.stillWaits && row.connection.state === "live";
        return [{ text: line, tone: "muted" }, ...(shown ? [{ text: waits, tone: "error" } as const] : [])];
    }
    const why = whyNot(row.brief, acting);
    return why === undefined ? [] : [{ text: WHY_NOT[why] ?? "Answer in Claude Code.", tone: "muted" }];
}

function notLive({ brief, connection }: Observation, izbor: IzborState["state"]): string | undefined {
    const { stopping, "not running": notRunning, notWatching } = NOTHING_SENT;
    switch (connection.state) {
        case "live":
            return brief?.status === "not listed" ? "The session has ended: nothing was sent." : undefined;
        case "izbor away":
            return connection.reason === "stopping" ? stopping : notRunning;
        case "stopped":
            return connection.why === "izbor stopping" ? stopping : notWatching;
        case "refused":
            return notWatching;
        default:
            if (izbor === "stopping") return stopping;
            if (izbor === "not running") return notRunning;
            return "Izbor is reconnecting: nothing was sent. Try again in a moment.";
    }
}

export function sendRefusal(
    field: FieldState,
    row: Observation,
    izbor: IzborState["state"],
    list: SessionList,
): string | undefined {
    const away = notLive(row, izbor);
    if (away !== undefined || !field.fixed) return away;
    const wait = unseenWait(row.brief);
    if (field.fixed.mode === "reply") return replyRefusal(field.fixed.session, row, list);
    const asked = row.brief?.needsYou.state === "request" ? row.brief.needsYou : wait;
    if (field.fixed.session !== row.id || !asked || asked.at !== field.fixed.at) return REQUEST_CHANGED;
    const listed = listedSession(list, row.id);
    const why = whyNot(row.brief, listed?.acting ?? true);
    if (why === undefined) return undefined;
    if (why === "not an acting project" && listed) return NO_PLUGIN_HERE;
    return NOT_ANSWERABLE[why] ?? "Answer it in the session.";
}

export function fieldLine(field: FieldState, row: Observation): FieldMessage | null {
    const said = saidOn(field, row.id);
    if (said) return said;
    const dropped = droppedLine(field, row);
    if (dropped || field.text) return dropped;
    const sent = sentTo(row);
    if (sent)
        return sent.stillWaits
            ? null
            : { text: `Sent ${singleLine(sent.text)}. Needs you clears when the agent goes on.`, error: false };
    return promptLine(row);
}

export function shownMessage(
    view: Pick<TerminalView, "feedback" | "feedbackIsError" | "field">,
    row: Observation | undefined,
): FieldMessage | null {
    const said = row ? fieldLine(view.field, row) : null;
    return said ?? (view.feedback ? { text: view.feedback, error: view.feedbackIsError } : null);
}

function showsDropped(field: FieldState, row: Observation): boolean {
    const dropped = droppedLine(field, row);
    return dropped !== null && fieldLine(field, row)?.text === dropped.text;
}

export function editField(
    field: FieldState,
    mode: FixedMode,
    text: string | undefined,
    key: EditKey,
    shown?: Observation,
    columns?: number,
): FieldState {
    const edit = editLine(field, text, key, columns);
    const seen = edit.edited && shown && showsDropped(field, shown) ? shown : undefined;
    const full = edit.capped ? { text: FIELD_FULL, error: false, session: mode.session } : null;
    return {
        text: edit.text,
        cursor: edit.cursor,
        fixed: edit.text ? (field.fixed ?? mode) : null,
        message: edit.edited ? full : field.message,
        ...(!edit.edited && field.behind && { behind: field.behind }),
        ...toldOf(field, seen),
        ...(edit.pasted && { pasted: edit.pasted }),
    };
}

export function afterSend(field: FieldState, answer: FieldAnswer, session: string, sameDraft: boolean): FieldState {
    if ("sent" in answer) {
        if (!sameDraft) return field;
        const others = (field.behind ?? []).filter((message) => message.session !== session);
        return {
            ...emptyField(),
            ...toldOf(field, undefined),
            message: field.message?.session && field.message.session !== session ? field.message : null,
            ...(others.length > 0 && { behind: others }),
        };
    }
    const said = "refused" in answer ? { text: answer.refused, error: true } : { text: answer.news, error: false };
    return saying(field, { ...said, session });
}

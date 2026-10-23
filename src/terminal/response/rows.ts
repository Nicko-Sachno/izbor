import stringWidth from "string-width";
import type { FullResponse, ResponseItem } from "../../domain/response.js";
import { counted } from "../../domain/text.js";
import { BRIEF_WIDTH } from "../layout.js";
import { paint, type Look } from "../paint.js";
import { MARK_COLUMNS, PART_MARKS } from "../parts.js";
import { clip, clockTime, spacedThousands, wrapText, type Tone } from "../presentation.js";
import { viewRows, type ResponsePane } from "../viewport.js";
import { wordsRows, type Room } from "../words/rows.js";
import { dividerWords, endWords, isLive, replyLabel, turnLabel } from "./labels.js";
import { callRows, foldRow, isCall, withFolds, type Fold } from "./tools.js";

/**
 * One terminal row of the full response: a key that names it, its painted text, whether it stands in the top part, the
 * label with the live edge or the last message (and the No transcript line over them), which the footer counts as the
 * message's rows, and where it stands in what it draws: `item`, an item's id or a line's name such as `earlier` for
 * its label, and `line`, its row there from 0, or a row before it from -1 back, such as the blank row that parts it
 * from what stands above or the label over the newest text item. What you read is kept by these two (T6).
 */
export type Row = { key: string; text: string; top: boolean; item: string; line: number };

/** Row `line` of `item`, keyed by both, outside the top part. */
const row = (item: string, line: number, text: string): Row => ({
    key: `${item}:${line}`,
    text,
    top: false,
    item,
    line,
});

/** Rows as rows of the top part. */
const onTop = (rows: readonly Row[]): Row[] => rows.map((shown) => ({ ...shown, top: true }));

type TextItem = Extract<ResponseItem, { type: "text" }>;
type NoticeItem = Extract<ResponseItem, { type: "notice" }>;

/** A text item's rows, its markdown laid out (T8, T9), at least one: nothing stands beside the words but the pane's
 *  margin (T2). */
function textRows({ text }: TextItem, room: Room, look: Look): readonly string[] {
    const rows = wordsRows(text, room, look);
    return rows.length ? rows : [""];
}

/** A notice's one row in the turn, in muted, at the local time it came: `─ background task finished 14:32 ─`. */
function noticeRow({ text, at }: NoticeItem, width: number, look: Look): string {
    const time = Number.isFinite(Date.parse(at)) ? ` ${clockTime(at, "minute")}` : "";
    return paint(clip(`─ ${text}${time} ─`, width), look, { tone: "muted" });
}

/** One item's rows: a text item's words, a call's tool row and result row, a fold's or a notice's one row. */
function itemRows(item: ResponseItem | Fold, room: Room, look: Look): readonly string[] {
    if (item.type === "fold") return [foldRow(item, room.text, look)];
    if (item.type === "text") return textRows(item, room, look);
    if (item.type === "notice") return [noticeRow(item, room.text, look)];
    return isCall(item) ? callRows(item, room.text, look) : [];
}

/** Items in order, keyed by item, each run of reads and searches folded: one blank row parts a text item from what
 *  stands next to it, while calls in a run stand row on row. */
function partRows(items: readonly ResponseItem[], room: Room, look: Look): Row[] {
    const rows: Row[] = [];
    let previous: ResponseItem | Fold | undefined;
    for (const item of withFolds(items)) {
        const texts = itemRows(item, room, look);
        if (!texts.length) continue;
        if (previous && (previous.type === "text" || item.type === "text")) rows.push(row(item.id, -1, ""));
        rows.push(...texts.map((text, index) => row(item.id, index, text)));
        previous = item;
    }
    return rows;
}

/** The items before the newest text item, which `Earlier in this turn` holds; none while no text item stands. */
export function earlierOf(items: readonly ResponseItem[]): readonly ResponseItem[] {
    const at = items.findLastIndex((item) => item.type === "text");
    return at > 0 ? items.slice(0, at) : [];
}

/** Row `line` of `item`, of words in one tone, muted unless another is named. */
const toned = (item: string, line: number, text: string, look: Look, tone: Tone = "muted") =>
    row(item, line, paint(text, look, { tone }));

/** The label's words in muted after the full response's mark (`PART_MARKS`). */
const markedLabel = (label: string, look: Look) =>
    paint(`${PART_MARKS.reply.text} `, look, { tone: PART_MARKS.reply.tone, bold: true }) +
    paint(label, look, { tone: "muted" });

/** The blank row before `item`, or `line` rows before its first. */
const blank = (item: string, line = -1): Row => row(item, line, "");

/** Words wrapped at `width`, a row each of `item` in one tone, muted unless another is named. */
function tonedLines(item: string, text: string, width: number, look: Look, tone?: Tone): Row[] {
    return wrapText(text, width)
        .split("\n")
        .map((words, line) => toned(item, line, words, look, tone));
}

/**
 * While a text item stands: its label, after the full response's mark, and the live edge, the newest text item and
 * every item after it; then a blank row, `Earlier in this turn` with the count of its tool calls, and the items before
 * it, when there are any. When text was cut (S4), a line says how much, first under `Earlier in this turn`, a blank
 * row parting it from a text item under it as from any text. Once the turn is over, a notice before the newest text
 * item names the background task in the label; while `live`, the label names the live edge.
 */
function textTurn({ items, cut }: FullResponse, room: Room, look: Look, how: { now: Date; live: boolean }): Row[] {
    const width = room.text;
    const at = items.findLastIndex((item) => item.type === "text");
    const before = earlierOf(items);
    const afterTask = before.some(({ type }) => type === "notice");
    // The label stands as the row before the text it labels, so a view that reads it keeps that text in place once a
    // newer text pushes it into Earlier (T6).
    const label = row(
        items[at]!.id,
        -1,
        markedLabel(replyLabel(items[at]!.at, how.now, width - MARK_COLUMNS, { live: how.live, afterTask }), look),
    );
    const top = onTop([label, ...partRows(items.slice(at), room, look)]);
    const them = cut === 1 ? "it" : "them";
    const left = `… ${counted(cut, "earlier character", spacedThousands)}: read ${them} in the session`;
    const cutRows = cut > 0 ? tonedLines("cut", left, width, look) : [];
    const gap = cutRows.length && before[0]?.type === "text" ? [blank(before[0].id)] : [];
    const earlier = [...cutRows, ...gap, ...partRows(before, room, look)];
    if (!earlier.length) return top;
    const turnRow = toned("earlier", 0, turnLabel(width, before.filter(isCall).length), look);
    return [...top, blank("earlier"), turnRow, ...earlier];
}

/**
 * Which of the `count` rows under the C divider (the response's row 0) the pane shows, numbered from 1: from its
 * scroll down to the row above the footer, or to its last row at the page's end, where no footer shows. Before the
 * layout has measured where the response starts, every row.
 */
function shownRows(count: number, pane: ResponsePane | undefined): { from: number; to: number } {
    const view = pane && viewRows(pane);
    return view ? { from: Math.max(1, view.top), to: Math.min(count, view.end - 1) } : { from: 1, to: count };
}

/** The C divider's row: a `─` rule in the border tone across the text width, and on it, before its last two columns,
 *  its words in muted, in the first form that leaves at least `── ` before them. */
function dividerRow(shown: { from: number; to: number }, rows: number, live: boolean, width: number, look: Look) {
    const words = dividerWords(shown, rows, live, width - 6);
    const rule = (columns: number) => paint("─".repeat(Math.max(0, columns)), look, { tone: "border" });
    return `${rule(width - stringWidth(words) - 4)} ${paint(words, look, { tone: "muted" })} ${rule(2)}`;
}

/** What a Task the agent has not started on shows, in the notice tone, where the full response stands. */
const NOTHING_YET = [
    "Nothing to show yet: the agent has not started on this Task.",
    "Responses to earlier Tasks: read them in the session.",
];

/** What the C divider counts from besides the turn: the pane, whether the agent still writes or waits, and `under`,
 *  the full response's rows under the turn: its end line and the blank row over it, or none. */
type Divided = { pane: ResponsePane | undefined; live: boolean; under: number };

/**
 * While no text item stands: the C divider in the label's place, counting the full response's rows under it in view,
 * then the turn from its start. A Task with no item yet shows the two Nothing yet lines instead.
 */
function noTextTurn({ items, end }: FullResponse, room: Room, look: Look, { pane, live, under }: Divided): Row[] {
    const width = room.text;
    if (!items.length && end.state === "nothing yet")
        return NOTHING_YET.flatMap((line, at) => tonedLines(`nothing yet:${at}`, line, width, look, "notice"));
    const turn = partRows(items, room, look);
    if (!turn.length) return [];
    const count = turn.length + under;
    return [row("divider", 0, dividerRow(shownRows(count, pane), count, live, width, look)), ...turn];
}

/** Said first when Izbor cannot read the session's transcript and has only the agent's last message (S6). */
const NO_TRANSCRIPT =
    "Only the agent's last message: Izbor cannot read this session's transcript, so its tool calls are not shown";

/** The rows of the No transcript line stand for this item. */
const LOST = "no transcript";

/** Whether the rows say what the Brief's `Latest:` line says, so it goes (T3): rows of any part but the No transcript
 *  line, which tells only that Izbor cannot read the transcript. */
export const saysLatest = (rows: readonly Row[]): boolean => rows.some(({ item }) => item !== LOST);

/** What the full response's rows depend on besides the response: `pane`, the pane it stands in, as the layout last
 *  measured it or as its view draws, which the C divider counts from; `noHooks`, whether its session is idle in a
 *  project without hooks, so the No hooks line takes the end line's place and no live edge stands; `codeRows`, the
 *  most rows a code block in the agent's words takes: half the body rows with a one-line field (ui-reference §9). */
type Around = { pane?: ResponsePane | undefined; noHooks?: boolean; codeRows: number };

/**
 * The full response as exact rows (T5): with a text item, its label and the live edge, then `Earlier in this turn`
 * and the items before it; with none, the C divider and the turn, or Nothing yet; then, once the reply ended, its
 * end line (T4), which the No hooks line replaces with `noHooks`. Without the transcript, its line comes first, then
 * the last message once there is one; never the divider or Nothing yet. A blank row parts each part from the next.
 */
export function responseRows(
    response: FullResponse,
    paneWidth: number,
    look: Look,
    now: Date,
    { pane, noHooks = false, codeRows }: Around,
): Row[] {
    const width = Math.min(BRIEF_WIDTH, paneWidth);
    const room: Room = { text: width, pane: paneWidth, codeRows };
    const hasText = response.items.some(({ type }) => type === "text");
    const lost = response.source === "last message only";
    const live = isLive(response.end, noHooks);
    const said = endWords(response.end, now, width, noHooks);
    const end = said ? tonedLines("end", said.text, width, look, said.tone) : [];
    const turn = hasText
        ? textTurn(response, room, look, { now, live })
        : lost
          ? []
          : noTextTurn(response, room, look, { pane, live, under: end.length && end.length + 1 });
    const noTranscript = lost ? tonedLines(LOST, NO_TRANSCRIPT, width, look) : [];
    const parts = [hasText ? onTop(noTranscript) : noTranscript, turn, end].filter((rows) => rows.length);
    const gapOver = (first: Row) => ({ ...blank(first.item, first.line - 1), top: first.top });
    return parts.flatMap((rows, index) => (index ? [gapOver(rows[0]!), ...rows] : rows));
}

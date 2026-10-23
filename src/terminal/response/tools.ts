import stringWidth from "string-width";
import {
    PATH_KINDS,
    resultInWords,
    type ResponseItem,
    type SubagentItem,
    type ToolItem,
    type ToolResult,
    type ToolState,
} from "../../domain/response.js";
import { counted } from "../../domain/text.js";
import { paint, type Look } from "../paint.js";
import { clean, duration, GLYPHS, graphemes, singleLine, wrapSpaced, type Tone } from "../presentation.js";

/** A call the full response draws as a tool row: a tool call, or a call that starts a subagent. */
type CallItem = ToolItem | SubagentItem;

export const isCall = (item: ResponseItem): item is CallItem => item.type === "tool" || item.type === "subagent";

/** A stretch of a row in one style; with no tone and no bold it stays unpainted. */
type Piece = { text: string; tone?: Tone; bold?: boolean };

type StateLook = { dot: Tone; result: Tone; glyph: string };

/** Each state's dot, the tone of its result row, and the glyph that stands in the dot's cell with colour off. */
const STATES: Record<ToolState, StateLook> = {
    running: { dot: "muted", result: "muted", glyph: GLYPHS.working },
    done: { dot: "done", result: "muted", glyph: GLYPHS.idle },
    waiting: { dot: "needsYou", result: "needsYou", glyph: GLYPHS.needsYou },
    failed: { dot: "error", result: "error", glyph: GLYPHS.refused },
    rejected: { dot: "error", result: "error", glyph: GLYPHS.refused },
    interrupted: { dot: "error", result: "error", glyph: GLYPHS.refused },
};

/** A state this build does not know (a newer service): a muted dot, and the call's result as a finished one has it. */
const UNKNOWN_STATE: StateLook = { dot: "muted", result: "muted", glyph: GLYPHS.unknown };

const DOT = "●";

/** Where `resultInWords` marks each count, so the count can be painted bold; `clean()` strips both characters. */
const COUNT = /\x01(\d+)\x02/;
const marked = (count: number) => `\x01${count}\x02`;

const widthOf = (pieces: readonly Piece[]) => stringWidth(pieces.map(({ text }) => text).join(""));

/**
 * Pieces painted as one row, clipped with `…` once they pass `width`, as `clip()` clips one string; the `…` takes the
 * style of the piece it cuts.
 */
function painted(pieces: readonly Piece[], width: number, look: Look): string {
    const draw = (text: string, piece: Piece) =>
        piece.tone === undefined && !piece.bold ? text : paint(text, look, piece);
    if (widthOf(pieces) <= width) return pieces.map((piece) => draw(piece.text, piece)).join("");
    let row = "";
    let used = 0;
    for (const piece of pieces) {
        let kept = "";
        for (const { segment } of graphemes.segment(piece.text)) {
            if (used + stringWidth(kept + segment) >= width) return row + draw(`${kept}…`, piece);
            kept += segment;
        }
        used += stringWidth(kept);
        row += draw(kept, piece);
    }
    return row;
}

/** A path within `room` columns: whole when it fits, else `…` and as much of its end as fits, from a `/` when one
 *  stands in it (`…/invoices/csv.ts`), so a call row that clips the argument of a `PATH_KINDS` call keeps its end. */
function keptEnd(path: string, room: number): string {
    if (stringWidth(path) <= room) return path;
    let tail = "";
    for (const segment of Array.from(graphemes.segment(path), ({ segment }) => segment).reverse()) {
        if (stringWidth(segment + tail) > room - 1) break;
        tail = segment + tail;
    }
    const slash = tail.indexOf("/");
    return `…${slash > 0 ? tail.slice(slash) : tail}`;
}

/** Words as pieces in the row's `tone`: each count bold, in the text tone, the rest on one line. */
function wordPieces(words: string, tone: Tone): Piece[] {
    const parts = words.split(COUNT);
    return parts.map((part, index) => {
        if (index % 2) return { text: part, tone: "text", bold: true };
        const text = clean(part).replace(/\s+/g, " ");
        const start = index === 0 ? text.trimStart() : text;
        return { text: index === parts.length - 1 ? start.trimEnd() : start, tone };
    });
}

/** A result in the words the item's `summary` has, its counts bold; the path drops out before the counts do when the
 *  words do not fit in `room` (`Wrote 64 lines` at 40 columns). */
function resultPieces(result: ToolResult, room: number, tone: Tone): Piece[] {
    const whole = wordPieces(resultInWords(result, { count: marked }), tone);
    return widthOf(whole) <= room ? whole : wordPieces(resultInWords(result, { count: marked, path: false }), tone);
}

/** What a finished call says: a subagent's tool uses and time once it has them, never for one started in the
 *  background, which returns at launch saying it runs there; else its result, if it has one. */
function doneWords(item: CallItem, room: number, tone: Tone): Piece[] | undefined {
    if (item.type === "subagent" && item.toolUses !== undefined && item.durationMs !== undefined)
        return wordPieces(`Done (${counted(item.toolUses, "tool use", marked)} · ${duration(item.durationMs)})`, tone);
    return item.result && resultPieces(item.result, room, tone);
}

/** The words of a call's result row in its state; none for a finished call that says nothing. A state this build does
 *  not know reads as a finished call. */
function stateWords(item: CallItem, room: number, tone: Tone): Piece[] | undefined {
    const says = (text: string): Piece[] => [{ text, tone }];
    switch (item.state) {
        case "running":
            return says("Running…");
        case "waiting": {
            const description = item.type === "tool" && item.description ? singleLine(item.description) : "";
            return says(description ? `Waiting for your answer · ${description}` : "Waiting for your answer");
        }
        case "rejected":
            return says("Rejected by the user");
        case "interrupted":
            return says("Interrupted by the user");
        case "failed": {
            const words = item.result && resultPieces(item.result, room, tone);
            return words && widthOf(words) ? words : says("Failed");
        }
        case "done":
            return doneWords(item, room, tone);
        default:
            item.state satisfies never;
            return doneWords(item, room, tone);
    }
}

/** The waiting call's row, wrapped under its name so its whole command shows (T10). */
function wrappedCall(head: readonly Piece[], name: string, argument: string, style: Piece, width: number, look: Look) {
    const text = argument ? `${name}(${argument})` : name;
    return wrapSpaced(text, width - 2)
        .split("\n")
        .map((row, index) => {
            const named = index ? 0 : name.length;
            const pieces = [
                { ...style, text: row.slice(0, named), bold: true },
                { ...style, text: row.slice(named) },
            ];
            return painted([...(index ? [{ text: "  " }] : head), ...pieces], width, look);
        });
}

/**
 * A call's rows at `width`: `● Name(argument)` and its result row, `  ⎿  result`. The dot carries the state in colour,
 * and with colour off its glyph (`✓ * ! ×`). The call row is one row clipped with `…`, keeping a path's end; only the
 * call that waits for you wraps, and its rows are amber, bold with colour off. The result row is one row, clipped.
 */
export function callRows(item: CallItem, width: number, look: Look): string[] {
    const state = STATES[item.state] ?? UNKNOWN_STATE;
    const off = look.colors === "off";
    const waits = item.state === "waiting";
    const style: Piece = { text: "", tone: waits ? state.result : "text", bold: waits && off };
    const name = singleLine(item.display);
    const argument = singleLine(item.type === "tool" ? item.argument : item.description);
    const head: Piece[] = [{ text: off ? state.glyph : DOT, tone: state.dot, bold: style.bold }, { text: " " }];
    const words = stateWords(item, width - 5, state.result);
    const result = words && [{ text: "  " }, { text: "⎿", tone: state.result }, { text: "  " }, ...words];
    const bolded = (pieces: Piece[]) =>
        pieces.map((piece) => (style.bold && piece.tone ? { ...piece, bold: true } : piece));
    const shown = result ? [painted(bolded(result), width, look)] : [];
    if (waits) return [...wrappedCall(head, name, argument, style, width, look), ...shown];
    const path = item.type === "tool" && PATH_KINDS.includes(item.kind);
    const shownArgument = path ? keptEnd(argument, width - stringWidth(`${DOT} ${name}()`)) : argument;
    const call = [
        { ...style, text: name, bold: true },
        ...(argument ? [{ ...style, text: `(${shownArgument})` }] : []),
    ];
    return [painted([...head, ...call], width, look), ...shown];
}

/** The tools whose calls fold, by name (LS has no entry in the domain's tool table), and what a fold counts of each. */
const FOLDED: Record<string, "search" | "read" | "list"> = { Grep: "search", Glob: "search", Read: "read", LS: "list" };

type Folded = (typeof FOLDED)[string];

/** Each count of a fold in the order the agent's own rows give them, in the past and the present tense, with its noun
 *  in the singular and the plural. */
const FOLD_WORDS: readonly { kind: Folded; done: string; running: string; one: string; many: string }[] = [
    { kind: "search", done: "searched for", running: "searching for", one: "pattern", many: "patterns" },
    { kind: "read", done: "read", running: "reading", one: "file", many: "files" },
    { kind: "list", done: "listed", running: "listing", one: "directory", many: "directories" },
];

/** A run of two or more consecutive reads, searches and listings, drawn as one row with no result row (§6 Folding),
 *  keyed by its first call. */
export type Fold = { type: "fold"; id: string; calls: readonly ToolItem[] };

/** Whether a call may stand in a fold: a read, search or listing that is done or running. One that waits for you,
 *  failed, or was rejected or interrupted keeps its own rows, so its result row shows. */
const foldable = (item: ResponseItem): item is ToolItem =>
    item.type === "tool" && Object.hasOwn(FOLDED, item.name) && (item.state === "done" || item.state === "running");

/** The items in order, each run of two or more foldable calls as one fold; a lone one keeps its own rows. */
export function withFolds(items: readonly ResponseItem[]): (ResponseItem | Fold)[] {
    const drawn: (ResponseItem | Fold)[] = [];
    let run: ToolItem[] = [];
    const close = () => {
        if (run.length > 1) drawn.push({ type: "fold", id: run[0]!.id, calls: run });
        else drawn.push(...run);
        run = [];
    };
    for (const item of items) {
        if (foldable(item)) run.push(item);
        else {
            close();
            drawn.push(item);
        }
    }
    close();
    return drawn;
}

/**
 * A fold's one row, `● Searched for 2 patterns, read 4 files, listed 1 directory`, each count bold, as the agent's own
 * rows word it: reads count the files they read. While one of its calls runs, the dot is muted and the words are in
 * the present tense, ending in `…`: `Reading 3 files…`. The row is clipped with `…`, as a call row is.
 */
export function foldRow({ calls }: Fold, width: number, look: Look): string {
    const running = calls.some(({ state }) => state === "running");
    const of = (kind: Folded) => calls.filter(({ name }) => FOLDED[name] === kind);
    const count = (kind: Folded) =>
        kind === "read" ? new Set(of(kind).map(({ argument }) => argument)).size : of(kind).length;
    const words = FOLD_WORDS.flatMap((form) => {
        const n = count(form.kind);
        return n ? [`${running ? form.running : form.done} ${marked(n)} ${n === 1 ? form.one : form.many}`] : [];
    }).join(", ");
    const state = STATES[running ? "running" : "done"];
    const head: Piece[] = [{ text: look.colors === "off" ? state.glyph : DOT, tone: state.dot }, { text: " " }];
    const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)}${running ? "…" : ""}`;
    return painted([...head, ...wordPieces(sentence, "text")], width, look);
}

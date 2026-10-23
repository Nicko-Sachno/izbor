import { Marked, type Token } from "marked";
import type { Look } from "../paint.js";
import { cleanLines } from "../presentation.js";
import { blockRows, highlighters, type Highlighter, type Room } from "./blocks.js";

export type { Room } from "./blocks.js";

/**
 * The tokens of a text item, parsed as GitHub's markdown by a parser made for this call; where the lexer fails, one
 * plain paragraph of the text. Strikethrough is `~~x~~` only, as Claude Code reads it: a single `~` is everyday prose,
 * as in `about ~5 min`. `false` hands a `~~` run to marked's own strikethrough, and no token leaves a `~` as text.
 */
function tokensOf(text: string): readonly Token[] {
    try {
        return new Marked({ gfm: true })
            .use({ tokenizer: { del: (src) => (src.startsWith("~~") ? false : undefined) } })
            .lexer(text);
    } catch {
        return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] }];
    }
}

/** How many laid-out text items the cache keeps; the one used longest ago goes first. */
const KEPT = 512;

/** Rows already laid out, by the text, the room and the look they were laid out for (T8). */
const laidOut = new Map<string, readonly string[]>();

/**
 * Fills the code blocks' syntax colours: `add` puts the function that colours each language Izbor knows into the
 * registry, by its names. Rows laid out before go, since they have no syntax colours.
 */
export function setHighlighters(add: (into: Map<string, Highlighter>) => void): void {
    add(highlighters);
    laidOut.clear();
}

/**
 * A text item's raw markdown as painted rows: prose wrapped at `room.text`, while code blocks and table grids may
 * take `room.pane`, a grid leaving 4 columns of it free. Escape and control sequences are removed first, then the
 * text is parsed once with marked and laid out by ui-reference §5. The rows are kept by the text, the room and
 * the look, so rows laid out for another width, height or colour mode are never served.
 */
export function wordsRows(markdown: string, room: Room, look: Look): readonly string[] {
    const key = `${JSON.stringify([look, room])}\n${markdown}`;
    const kept = laidOut.get(key);
    if (kept) {
        laidOut.delete(key);
        laidOut.set(key, kept);
        return kept;
    }
    const rows = blockRows(tokensOf(cleanLines(markdown)), room, look);
    laidOut.set(key, rows);
    for (const oldest of laidOut.keys()) {
        if (laidOut.size <= KEPT) break;
        laidOut.delete(oldest);
    }
    return rows;
}

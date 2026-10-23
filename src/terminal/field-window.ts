import stringWidth from "string-width";
import { lookOf, paint, type Look } from "./paint.js";
import type { PasteBlock } from "./model.js";
import { counted, lineCount } from "../domain/text.js";
import { graphemes } from "./presentation.js";

/** One row of the field's text: what it draws, and the text index a click puts the cursor at under each of its cells,
 *  up to the cell after its room. */
type FieldRow = { text: string; indices: number[] };

/** Where the cursor stands: a row, and the column in that row. */
type FieldCursor = { row: number; column: number };

/** The field's text laid out at its input width: every row it takes, the cursor's row and column among them, and how
 *  many lines the text has, split at its new lines outside its paste blocks. */
type FieldText = { rows: FieldRow[]; cursor: FieldCursor; lines: number };

/** The rows the field's box shows: the text's rows in view, the rows scrolled out above them, and the cursor's row in
 *  view and its column. */
type FieldWindow = Pick<FieldText, "rows" | "cursor"> & { above: number };

/** A grapheme of the field's text as it draws, or a whole paste block: a tab draws as 4 spaces, and a row may break
 *  after a space or a tab. */
type Part = { drawn: string; start: number; end: number; width: number; space: boolean };

/** One line of the field's text: its parts, and the text index where it ends. */
type TextLine = { parts: Part[]; end: number };

const TAB = "    ";

const OFF: Look = lookOf(false);

/** What a paste block says: its lines and its size, 1 KB being 1,024 bytes, with one decimal and never under 0.1 KB. */
function pasteLabel(pasted: string): string {
    const kilobytes = Math.max(0.1, Math.round(Buffer.byteLength(pasted) / 102.4) / 10);
    return `Pasted ${counted(lineCount(pasted), "line")} · ${kilobytes.toFixed(1)} KB`;
}

/** A paste block as one part: in the palette its label in the focus tone on the paste fill, else in brackets, the
 *  brackets' two cells filled spaces in the palette, so it is as wide in every look. Its text is counted, never laid
 *  out. */
function blockPart(text: string, { start, end }: PasteBlock, look: Look): Part {
    const label = pasteLabel(text.slice(start, end));
    const drawn =
        look.colors === "palette" ? paint(` ${label} `, look, { tone: "focus", fill: "pasteFill" }) : `[${label}]`;
    return { drawn, start, end, width: stringWidth(label) + 2, space: false };
}

function partsOf(line: string, offset: number): Part[] {
    return Array.from(graphemes.segment(line), ({ segment, index }) => {
        const drawn = segment === "\t" ? TAB : segment;
        const start = offset + index;
        const space = segment === " " || segment === "\t";
        return { drawn, start, end: start + segment.length, width: stringWidth(drawn), space };
    });
}

/** The text's lines, split at its new lines outside its paste blocks: a block stands inline as one part, its new lines
 *  none of the line's. */
function linesOf(text: string, pasted: readonly PasteBlock[], look: Look): TextLine[] {
    const lines: TextLine[] = [];
    let parts: Part[] = [];
    let from = 0;
    for (const block of [...pasted, { start: text.length, end: text.length }]) {
        let offset = from;
        for (const [index, piece] of text.slice(from, block.start).split("\n").entries()) {
            if (index > 0) {
                lines.push({ parts, end: offset - 1 });
                parts = [];
            }
            for (const part of partsOf(piece, offset)) parts.push(part);
            offset += piece.length + 1;
        }
        if (block.end > block.start) parts.push(blockPart(text, block, look));
        from = block.end;
    }
    lines.push({ parts, end: text.length });
    return lines;
}

/**
 * Where the parts that the row starting at `parts[first]` draws end: after the parts that fit in `columns` cells, at
 * least one. A word that does not fit starts the next row, and breaks at the row's end when no space stands before it
 * in the row. A space that does not fit stands at the index returned: `fieldText` hangs it on this row.
 */
function rowEnd(parts: readonly Part[], first: number, columns: number): number {
    let next = first;
    let cells = 0;
    let word = first;
    while (next < parts.length && (next === first || cells + parts[next]!.width <= columns)) {
        const part = parts[next++]!;
        cells += part.width;
        if (part.space) word = next;
    }
    return next < parts.length && !parts[next]!.space && word > first && word < next ? word : next;
}

/** The text index under each cell of a row of `parts`, up to the cell after its room: a cell's left half puts the
 *  cursor before its grapheme and its right half after it, and the cells past the row's text put it at `rest`. The
 *  cursor after a row that wraps would stand on the next row, so a cell that would put it at the row's `end` puts it
 *  at `rest` too. */
function cellIndices(parts: readonly Part[], end: number, rest: number, columns: number): number[] {
    const indices: number[] = [];
    const after = (index: number) => (index === end ? rest : index);
    let column = 0;
    for (const part of parts) {
        for (let cell = 0; cell < part.width; cell++)
            indices[column + cell] = cell < part.width / 2 ? part.start : after(part.end);
        column += part.width;
        indices[column] = after(part.end);
    }
    for (let cell = column; cell <= columns; cell++) indices[cell] = rest;
    return indices.slice(0, columns + 1);
}

/**
 * The field's text laid out at `columns` cells, with the cursor's row and column: each line, split at its new lines,
 * wraps onto rows of its own. A space that does not fit hangs, undrawn, on the row it ends, so the next row starts at
 * the word; when it is the line's last, an empty row follows for the cursor after it. The cursor at the end of a row
 * that wraps stands at the next row's start; at the end of a line, or before a space that hangs, after the row's text,
 * which may be the cell after the row's room. Each of the `pasted` blocks draws as one word in `look`, whatever it
 * holds, and a row never splits it.
 */
export function fieldText(
    text: string,
    cursor: number,
    columns: number,
    pasted: readonly PasteBlock[] = [],
    look: Look = OFF,
): FieldText {
    const room = Math.max(1, columns);
    const rows: FieldRow[] = [];
    let place: FieldCursor = { row: 0, column: 0 };
    const lines = linesOf(text, pasted, look);
    for (const { parts, end: lineEnd } of lines) {
        let first = 0;
        let hangs = false;
        do {
            const drawn = rowEnd(parts, first, room);
            hangs = parts[drawn]?.space === true;
            const cut = hangs ? drawn + 1 : drawn;
            const shown = parts.slice(first, cut);
            const last = cut >= parts.length && !hangs;
            const start = shown[0]?.start ?? lineEnd;
            const end = parts[cut]?.start ?? lineEnd;
            if (cursor >= start && (cursor < end || (last && cursor === end))) {
                const before = shown.filter((part) => part.end <= cursor);
                place = { row: rows.length, column: before.reduce((cells, part) => cells + part.width, 0) };
            }
            const rest = last ? lineEnd : shown.at(-1)!.start;
            const words = parts.slice(first, drawn).map((part) => part.drawn);
            rows.push({ text: words.join(""), indices: cellIndices(shown, end, rest, room) });
            first = cut;
        } while (first < parts.length || hangs);
    }
    return { rows, cursor: place, lines: lines.length };
}

/**
 * The rows of the field's text its box shows, at most `shown`. Past them it scrolls inside, only as far as keeps the
 * cursor's row in view: it keeps `from`, the rows it had scrolled out above, while the cursor's row stays among the
 * rows it shows, so a click or a step inside them moves no row, and the cursor at the text's end shows its last rows.
 */
export function fieldWindow({ rows, cursor }: FieldText, shown: number, from: number): FieldWindow {
    const room = Math.max(1, Math.min(shown, rows.length));
    const kept = Math.min(cursor.row, Math.max(from, cursor.row - room + 1));
    const above = Math.max(0, Math.min(kept, rows.length - room));
    return { rows: rows.slice(above, above + room), above, cursor: { row: cursor.row - above, column: cursor.column } };
}

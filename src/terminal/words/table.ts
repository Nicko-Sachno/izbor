import type { Token, Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { paint, type Look, type PaintStyle } from "../paint.js";
import type { Room } from "./blocks.js";
import { inlineText, rule, wrapWords } from "./inline.js";

/** What stands between two columns of a grid. */
const GAP = "  ";

/** The columns of the code width a grid leaves free: past them, even its narrowest grid draws as records. */
const MARGIN = 4;

/** The most rows a cell of a grid wraps over: a cell that would take more draws the table as records. */
const CELL_ROWS = 4;

/** The longest a rule between two records is, in columns: the text width, at most this. */
const LONGEST_RULE = 40;

type Align = Tokens.Table["align"][number];

/** One cell's painted words on one line, and their widths: all of them, and their longest word's. */
type Cell = { words: string; full: number; word: number };

function cellOf(tokens: readonly Token[], look: Look, style: PaintStyle): Cell {
    const words = inlineText(tokens, look, style).replaceAll("\n", " ");
    const word = Math.max(0, ...words.split(" ").map((part) => stringWidth(part)));
    return { words, full: stringWidth(words), word };
}

/** A table's cells, painted as its words are, the header's bold: every row as many cells as the header has. */
function tableCells({ header, rows }: Tokens.Table, look: Look, style: PaintStyle): Cell[][] {
    const strong = { ...style, bold: true };
    return [
        header.map(({ tokens }) => cellOf(tokens, look, strong)),
        ...rows.map((row) => header.map((_, column) => cellOf(row[column]?.tokens ?? [], look, style))),
    ];
}

/**
 * Each column's width in a grid `room` columns wide, its gaps left out: as wide as its widest cell when they all fit;
 * else as wide as its longest word, and the rest of the room shared by how much more each column's widest cell
 * needs. None when the columns, each as wide as its longest word, take more than the room.
 */
function widthsOf(cells: readonly Cell[][], room: number): number[] | undefined {
    const widest = (pick: (cell: Cell) => number) =>
        cells[0]!.map((_, column) => Math.max(1, ...cells.map((row) => pick(row[column]!))));
    const full = widest(({ full }) => full);
    const word = widest(({ word }) => word);
    const sum = (widths: readonly number[]) => widths.reduce((total, width) => total + width, 0);
    if (sum(full) <= room) return full;
    if (sum(word) > room) return undefined;
    const rest = room - sum(word);
    const more = sum(full) - sum(word);
    return word.map((width, column) => width + Math.floor(((full[column]! - width) / more) * rest));
}

/** A cell's row `text` padded with spaces to `width` columns, on the side its column's alignment asks for. */
function padded(text: string, width: number, align: Align): string {
    const room = Math.max(0, width - stringWidth(text));
    const before = align === "right" ? room : align === "center" ? Math.floor(room / 2) : 0;
    return " ".repeat(before) + text + " ".repeat(room - before);
}

/**
 * The grid: every cell wrapped inside its column, top-aligned, the columns `GAP` apart, and one rule row of `─` under
 * the header, as wide as each column, in the border tone. None when a cell would wrap over more than `CELL_ROWS`
 * rows. No row ends in spaces, so a copy picks up only the cells.
 */
function gridRows(
    cells: readonly Cell[][],
    widths: readonly number[],
    align: readonly Align[],
    look: Look,
): string[] | undefined {
    const wrapped = cells.map((row) =>
        row.map(({ words }, column) => wrapAnsi(words, widths[column]!, { hard: true }).split("\n")),
    );
    if (wrapped.some((row) => row.some((lines) => lines.length > CELL_ROWS))) return undefined;
    const drawn = wrapped.map((row) =>
        Array.from({ length: Math.max(...row.map((lines) => lines.length)) }, (_, line) =>
            row
                .map((lines, column) => padded(lines[line] ?? "", widths[column]!, align[column] ?? null))
                .join(GAP)
                .trimEnd(),
        ),
    );
    const under = widths.map((width) => rule(width, look)).join(GAP);
    const [header = [], ...rows] = drawn;
    return [...header, under, ...rows.flat()];
}

/**
 * The table as records, one a row: each of its cells `Header: value`, the header bold, wrapped at the text width;
 * an empty cell left out. A rule in the border tone, as long as the text width but at most `LONGEST_RULE`, stands
 * between two records. A table with no rows under its header shows its header's words, one cell a row.
 */
function recordRows(cells: readonly Cell[][], room: Room, look: Look, style: PaintStyle): string[] {
    const [header = [], ...rows] = cells;
    const colon = paint(":", look, { ...style, bold: true });
    const named = (cell: Cell, column: number) => {
        const name = header[column]!;
        return name.full ? `${name.words}${colon} ${cell.words}` : cell.words;
    };
    const records = rows.length
        ? rows.map((row) => row.flatMap((cell, column) => (cell.full ? wrapWords(named(cell, column), room.text) : [])))
        : [header.flatMap((cell) => (cell.full ? wrapWords(cell.words, room.text) : []))];
    const between = rule(Math.min(room.text, LONGEST_RULE), look);
    return records.filter((lines) => lines.length).flatMap((lines, index) => (index ? [between, ...lines] : lines));
}

/**
 * A table in the agent's words, with no borders and nothing painted behind it (ui-reference §5). A grid when it
 * fits: the header bold, one rule row under it, the columns 2 apart, the cells padded by their GFM alignment, inline
 * code in the code tone. It may take the code width, the pane's (T7), but `MARGIN` columns: when the cells' full
 * widths do not fit, each column keeps its longest word, shares the rest and wraps its cells. As `Header: value`
 * records when even the longest words do not fit, or when a cell would wrap over more than `CELL_ROWS` rows. No row
 * cap: S4's 20,000 characters bound every table.
 */
export function tableRows(token: Tokens.Table, room: Room, look: Look, style: PaintStyle): string[] {
    const cells = tableCells(token, look, style);
    const widths = widthsOf(cells, room.pane - MARGIN - GAP.length * (token.header.length - 1));
    return (widths && gridRows(cells, widths, token.align, look)) ?? recordRows(cells, room, look, style);
}

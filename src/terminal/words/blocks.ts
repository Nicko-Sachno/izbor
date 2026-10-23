import type { MarkedToken, Token, Tokens } from "marked";
import wrapAnsi from "wrap-ansi";
import { paint, type Look, type PaintStyle } from "../paint.js";
import { counted } from "../../domain/text.js";
import { clip, spacedThousands } from "../presentation.js";
import { inlineText, rule, spaced, wrapWords } from "./inline.js";
import { tableRows } from "./table.js";

/**
 * Where the agent's words are laid out: `text`, the text width the prose wraps at; `pane`, the code width, the
 * pane's width inside its two gutters with no 82-column cap (T7); `codeRows`, the most rows a code block takes.
 */
export type Room = { text: number; pane: number; codeRows: number };

/** The agent's prose: the text tone, no attribute. */
const PROSE: PaintStyle = { tone: "text" };

/**
 * Block tokens as rows, one blank row between blocks however many blank lines the agent left. Inside a quote the
 * rows come in its style.
 */
export function blockRows(tokens: readonly Token[], room: Room, look: Look, style: PaintStyle = PROSE): string[] {
    // The lexer makes no token of an extension, so every token is one of marked's own.
    const blocks = tokens
        .filter(({ type }) => type !== "space")
        .map((token) => blockOf(token as MarkedToken, room, look, style))
        .filter((rows) => rows.length);
    return blocks.flatMap((rows, index) => (index ? ["", ...rows] : rows));
}

/** One block's rows: a token with no case of its own shows its source lines. */
function blockOf(token: MarkedToken, room: Room, look: Look, style: PaintStyle): string[] {
    switch (token.type) {
        case "paragraph":
            return paragraphRows(inlineText(token.tokens, look, style), room.text);
        case "text":
            // The words of a list item with no blank line in it.
            return paragraphRows(inlineText([token], look, style), room.text);
        case "heading":
            return headingRows(token, room.text, look, style);
        case "hr":
            // `---`: a rule across the text width.
            return [look.colors === "off" ? paint(token.raw.trim(), look, style) : rule(room.text, look)];
        case "blockquote":
            return quoteRows(token, room, look, style);
        case "list":
            return listRows(token, room, look, style);
        case "code":
            return codeBlockRows(token, room, look, style);
        case "table":
            return tableRows(token, room, look, style);
        case "html":
            return sourceRows(spaced(token.text), room.text, look, style);
        default:
            return sourceRows(token.raw, room.text, look, style);
    }
}

/** Painted words wrapped at `width`, each of their lines on rows of its own: a single newline is a row break. */
const paragraphRows = (words: string, width: number): string[] =>
    words.split("\n").flatMap((line) => wrapWords(line, width));

/**
 * A heading, bold: with colour on, no `#`, and the first level underlined too. With colour off, no underline and its
 * markers as the agent wrote them, bold: the `# ` (or `## ` to `###### `) before it and a closing run of `#` after it,
 * or the `===` or `---` row under it. The blank row between blocks stands after it.
 */
function headingRows({ depth, raw, tokens }: Tokens.Heading, width: number, look: Look, style: PaintStyle): string[] {
    const off = look.colors === "off";
    const strong = { ...style, bold: true, underline: depth === 1 && !off };
    const words = inlineText(tokens, look, strong);
    if (!off) return paragraphRows(words, width);
    const [first = "", ...under] = raw.trim().split("\n");
    if (under.length) return [...paragraphRows(words, width), ...sourceRows(under.at(-1) ?? "", width, look, strong)];
    const marker = `${"#".repeat(depth)}${words ? " " : ""}`;
    const closing = / +#+$/.exec(first)?.[0] ?? "";
    return paragraphRows(paint(marker, look, strong) + words + paint(closing, look, strong), width);
}

/** The room beside a cell `columns` wide: the text and the code lose its columns; a code block keeps its rows. */
const beside = (room: Room, columns: number): Room => ({
    ...room,
    text: Math.max(1, room.text - columns),
    pane: Math.max(1, room.pane - columns),
});

/** Rows moved in by `indent`; a blank row stays blank. */
const movedIn = (rows: readonly string[], indent: string): string[] => rows.map((row) => (row ? indent + row : ""));

/**
 * A quote: its blocks muted and italic, 2 columns in, with no bar beside them. With colour off, `> ` stands in
 * those 2 columns on every row of it, a blank one too, italic.
 */
function quoteRows({ tokens }: Tokens.Blockquote, room: Room, look: Look, style: PaintStyle): string[] {
    const quoted: PaintStyle = { ...style, tone: "muted", italic: true };
    const rows = blockRows(tokens, beside(room, 2), look, quoted);
    if (look.colors !== "off") return movedIn(rows, "  ");
    return rows.map((row) => paint(row ? "> " : ">", look, quoted) + row);
}

/** The fewest columns of text a nested list's items keep under their parent's text; with fewer, the list stands
 *  under its parent's marker instead, so the indentation stops growing. */
const NARROWEST = 10;

/** An ordered item's number as the agent wrote it, such as `9.` or `2)`, at the start of its source. */
const NUMBER = /^ *(\d{1,9}[.)])/;

/**
 * A list's items, each with its cell: `- ` at every depth, or the item's number as the agent wrote it, right-aligned
 * in a cell as wide as the widest number, and a space; then `[ ] ` or `[x] ` for a task.
 */
function listCells({ ordered, start, items }: Tokens.List): { item: Tokens.ListItem; cell: string }[] {
    const marked = items.map((item, index) => ({
        item,
        marker: ordered ? (NUMBER.exec(item.raw)?.[1] ?? `${Number(start) + index}.`) : "-",
        box: item.task ? (item.checked ? "[x] " : "[ ] ") : "",
    }));
    const widest = Math.max(...marked.map(({ marker }) => marker.length));
    return marked.map(({ item, marker, box }) => ({ item, cell: `${marker.padStart(widest)} ${box}` }));
}

/** A list: its items' rows, with one blank row between items where the agent left blank lines between them. */
function listRows(list: Tokens.List, room: Room, look: Look, style: PaintStyle): string[] {
    return listCells(list).flatMap(({ item, cell }, index) => [
        ...(index && list.loose ? [""] : []),
        ...itemRows(item, cell, room, look, style),
    ]);
}

/**
 * A list item: its cell, then its blocks, which wrap at the width beside the cell; every row under the first hangs
 * under the text, padded with spaces, and a nested list starts under the text too, unless its items would keep under
 * `NARROWEST` columns there: then it stands under this item's marker. A loose item has one blank row between its
 * blocks. A task's box is in the cell, so its checkbox token draws nothing.
 */
function itemRows(item: Tokens.ListItem, cell: string, room: Room, look: Look, style: PaintStyle): string[] {
    const inner = beside(room, cell.length);
    const hang = " ".repeat(cell.length);
    const blocks = item.tokens
        .filter(({ type }) => type !== "space" && type !== "checkbox")
        .map((token, index) => {
            // The lexer makes no token of an extension, so every token is one of marked's own.
            const block = token as MarkedToken;
            const widest = block.type === "list" ? Math.max(...listCells(block).map(({ cell }) => cell.length)) : 0;
            const under = index > 0 && block.type === "list" && inner.text - widest < NARROWEST;
            return under
                ? { rows: blockOf(block, room, look, style), indent: "" }
                : { rows: blockOf(block, inner, look, style), indent: hang };
        })
        .filter(({ rows }) => rows.length);
    const [first, ...rest] = blocks;
    if (!first) return [paint(cell.trimEnd(), look, style)];
    const [top = "", ...under] = first.rows;
    return [
        paint(cell, look, style) + top,
        ...movedIn(under, first.indent),
        ...rest.flatMap(({ rows, indent }) => [...(item.loose ? [""] : []), ...movedIn(rows, indent)]),
    ];
}

/** Trailing newlines, which a closed fence's source keeps. */
const TRAILING_NEWLINES = /\n+$/;

/** A fence's run of backticks or tildes, at the start of its line. */
const FENCE_RUN = /^(`{3,}|~{3,})/;

/** The first word of a fence's info string: the language it names. */
const FIRST_WORD = /^\S*/;

/** The language a code block's fence names, as the agent wrote it, or none. */
const languageOf = ({ lang }: Tokens.Code): string => FIRST_WORD.exec(lang ?? "")?.[0] ?? "";

/**
 * Colours a code block's source with syntax colours (`syntax`), in `style`'s attributes: its lines painted, one for
 * each source line and not yet wrapped, or none when its grammar fails on it.
 */
export type Highlighter = (code: string, look: Look, style: PaintStyle) => readonly string[] | undefined;

/**
 * The languages a fence may name for syntax colours, by name and by alias, each to the function that colours its
 * block. The terminal app fills it from `./highlight.js` through `setHighlighters` before it draws, and only with
 * colour on; while it is empty, every fence draws in the code tone.
 */
export const highlighters = new Map<string, Highlighter>();

/** One source line of code wrapped hard at `width`, its leading spaces kept, each row painted by `painted`: its rows,
 *  each 2 columns in. */
const codeLineRows = (line: string, width: number, painted: (row: string) => string): string[] =>
    wrapAnsi(line, width, { hard: true, trim: false })
        .split("\n")
        .map((row) => (row ? `  ${painted(row)}` : ""));

/** A code block's lines, each as its rows, and the rows that stand over and under them. */
type CodeLines = { lines: string[][]; over: string[]; under: string[] };

/**
 * A code block's source lines, each as its rows. In syntax colours where the look has colour and `highlighters` holds
 * the language its fence names, with no row over or under them, so an empty block has no rows. Else in the code
 * tone, with the rows `fenceRows` gives over and under them.
 */
function codeLines(token: Tokens.Code, width: number, look: Look, style: PaintStyle): CodeLines {
    const known = look.colors === "off" ? undefined : highlighters.get(languageOf(token).toLowerCase());
    const highlighted = known && (token.text ? known(token.text, look, style) : []);
    if (highlighted)
        return { lines: highlighted.map((line) => codeLineRows(line, width, (row) => row)), over: [], under: [] };
    const code: PaintStyle = { ...style, tone: "code" };
    const lines = (token.text ? token.text.split("\n") : []).map((line) =>
        codeLineRows(line, width, (row) => paint(row, look, code)),
    );
    const [over, under] = fenceRows(token, width, look, style);
    return { lines, over, under };
}

/**
 * A code block, 2 columns in, with no box or background. With colour on, a fence naming a language Izbor has syntax
 * colours for gives its lines in them, with no row over them; any other fence a muted row with the language it names,
 * when it names one, then its lines in the code tone. With colour off, its fence lines as the agent wrote them stand
 * over and under its lines, in the code tone. Its lines wrap at the code width, the pane's, not at the prose's (T7),
 * and keep their leading spaces. A block taller than `room.codeRows` shows its first whole lines, then a muted
 * `… 38 more lines` row in the place of the lines it leaves out: the block's last row, or the one over its closing
 * fence line.
 */
function codeBlockRows(token: Tokens.Code, room: Room, look: Look, style: PaintStyle): string[] {
    const width = Math.max(1, room.pane - 2);
    const { lines, over, under } = codeLines(token, width, look, style);
    const { shown, hidden } = keptLines(lines, room.codeRows - over.length - under.length);
    const more = `… ${counted(hidden, "more line", spacedThousands)}`;
    const hint = hidden ? [`  ${paint(clip(more, width), look, { ...style, tone: "muted" })}`] : [];
    return [...over, ...shown, ...hint, ...under];
}

/**
 * The rows over and under a code block's lines. With colour on, the muted row of the language its fence names, or
 * none, and nothing under them. With colour off, its fence lines as the agent wrote them, 2 columns in: the opening
 * one, and the closing one where the agent closed the fence. An indented block has neither.
 */
function fenceRows(token: Tokens.Code, width: number, look: Look, style: PaintStyle): [string[], string[]] {
    if (token.codeBlockStyle === "indented") return [[], []];
    if (look.colors !== "off") {
        const language = languageOf(token);
        return [language ? [`  ${paint(clip(language, width), look, { ...style, tone: "muted" })}`] : [], []];
    }
    const [open = "", ...rest] = token.raw.replace(TRAILING_NEWLINES, "").split("\n");
    const run = FENCE_RUN.exec(open.trim())?.[1] ?? "";
    const last = rest.at(-1)?.trim() ?? "";
    const closed = run !== "" && last.length >= run.length && [...last].every((mark) => mark === run[0]);
    const fence = (line: string) =>
        codeLineRows(line.trim(), width, (row) => paint(row, look, { ...style, tone: "code" }));
    return [fence(open), closed ? fence(last) : []];
}

/**
 * The rows of a block's lines (each line's rows in one list) that stand in `rows` rows, whole lines only: every line
 * when they fit; else the first lines that fit in one row less, at least one, with `hidden`, how many lines that
 * leaves out, for the hint row that takes the row left. A hint never stands for one line: when only one would be
 * left out, every line shows instead (T11).
 */
function keptLines(lines: readonly string[][], rows: number): { shown: string[]; hidden: number } {
    const all = lines.flat();
    if (all.length <= rows) return { shown: all, hidden: 0 };
    let kept = 0;
    let used = 0;
    for (const line of lines) {
        if (used + line.length >= rows) break;
        used += line.length;
        kept += 1;
    }
    const hidden = lines.length - Math.max(1, kept);
    return hidden > 1 ? { shown: lines.slice(0, -hidden).flat(), hidden } : { shown: all, hidden: 0 };
}

/**
 * Source lines as the agent wrote them, each wrapped as the words are (`wrapWords`): a line's leading spaces stay and
 * its wrapped rows hang under them, unless they take half the width or more.
 */
function sourceRows(source: string, width: number, look: Look, style: PaintStyle): string[] {
    return source
        .replace(/^(?:[ \t]*\n)+/, "")
        .trimEnd()
        .split("\n")
        .flatMap((line) => (/[^ ]/.test(line) ? wrapWords(paint(line, look, style), width) : [""]));
}

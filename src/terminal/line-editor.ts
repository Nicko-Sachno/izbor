import { lineCount } from "../domain/text.js";
import { fieldText } from "./field-window.js";
import type { PasteBlock } from "./model.js";
import { cleanField, graphemes } from "./presentation.js";

/** `paste`: the text came as a paste, which a long one makes a block of. */
export type EditKey = { name?: string | undefined; ctrl?: boolean; meta?: boolean; paste?: boolean };
export type Line = { text: string; cursor: number; pasted?: readonly PasteBlock[] };

/** A prompt holds 64 KB: 65,536 bytes of the whole text in UTF-8. */
export const FIELD_BYTES = 65_536;

/** A paste of more than 5 lines or 800 characters becomes one block. */
const PASTE_LINES = 5;
const PASTE_CHARACTERS = 800;

const isLong = (pasted: string): boolean => pasted.length > PASTE_CHARACTERS || lineCount(pasted) > PASTE_LINES;

/** Where the cursor may stand in the text: between two of its characters, and before or after each paste block, never
 *  inside one. Only the text outside the blocks is read, so a long paste costs nothing here. */
export function fieldEdges({ text, pasted = [] }: Pick<Line, "text" | "pasted">): number[] {
    const edges: number[] = [];
    let from = 0;
    for (const { start, end } of [...pasted, { start: text.length, end: text.length }]) {
        for (const { index } of graphemes.segment(text.slice(from, start))) edges.push(from + index);
        edges.push(start);
        from = end;
    }
    return edges;
}

/** The paste blocks once the text from `from` up to `to` gave way to `added` code units: a block inside it goes, and
 *  the blocks after it move with the text. */
function moved(pasted: readonly PasteBlock[], from: number, to: number, added: number): PasteBlock[] {
    const shift = added - (to - from);
    return pasted.flatMap((block) =>
        block.end <= from ? [block] : block.start >= to ? [{ start: block.start + shift, end: block.end + shift }] : [],
    );
}

/** As much of `text` as fits in `room` UTF-8 bytes, cut where one grapheme ends and the next begins. */
function fitting(text: string, room: number): string {
    if (Buffer.byteLength(text) <= room) return text;
    let end = 0;
    for (const { segment, index } of graphemes.segment(text)) {
        room -= Buffer.byteLength(segment);
        if (room < 0) break;
        end = index + segment.length;
    }
    return text.slice(0, end);
}

/** Where Up (`step` -1) or Down (1) puts the cursor in the line laid out at `columns` cells, as the field draws it: on
 *  the row above or below, at the cursor's column or that row's end, where a click there would; on the first or the
 *  last row it stays. */
function rowStep({ text, cursor, pasted }: Line, columns: number, step: number): number {
    const { rows, cursor: at } = fieldText(text, cursor, columns, pasted);
    return rows[at.row + step]?.indices[at.column] ?? cursor;
}

/** `capped`: typed or pasted text did not all go in, because the whole text would pass 64 KB. `columns`: the field's
 *  input width, where Up and Down find the row above or below; without it they leave the cursor where it is. A paste
 *  block is one character to every key: Left and Right step over it, and Backspace or Delete next to it removes it.
 *  Ctrl-J adds a new line: it comes as an LF, or as `j` with Ctrl where the kitty keyboard protocol is on. */
export function editLine(
    line: Line,
    text: string | undefined,
    key: EditKey,
    columns?: number,
): Line & { edited: boolean; capped?: true } {
    let { text: command, cursor, pasted = [] } = line;
    let capped = false;
    const added = key.ctrl && key.name === "j" ? "\n" : key.ctrl || key.meta ? undefined : text;
    const edges = fieldEdges(line);
    const previous = edges.findLast((index) => index < cursor) ?? 0;
    const next = edges.find((index) => index > cursor) ?? command.length;
    const cut = (from: number, to: number) => {
        command = command.slice(0, from) + command.slice(to);
        pasted = moved(pasted, from, to, 0);
    };
    if (key.name === "left") cursor = previous;
    else if (key.name === "right") cursor = next;
    else if ((key.name === "up" || key.name === "down") && columns)
        cursor = rowStep(line, columns, key.name === "up" ? -1 : 1);
    else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = command.length;
    else if (key.name === "backspace") {
        cut(previous, cursor);
        cursor = previous;
    } else if (key.name === "delete") cut(cursor, next);
    else if (key.ctrl && key.name === "u") {
        cut(0, cursor);
        cursor = 0;
    } else if (added) {
        const typed = cleanField(added);
        const inserted = fitting(typed, FIELD_BYTES - Buffer.byteLength(command));
        command = command.slice(0, cursor) + inserted + command.slice(cursor);
        pasted = moved(pasted, cursor, cursor, inserted.length);
        const block = { start: cursor, end: cursor + inserted.length };
        if (key.paste && isLong(inserted)) pasted = [...pasted, block].sort((a, b) => a.start - b.start);
        cursor += inserted.length;
        capped = inserted.length < typed.length;
    }
    const edited = Boolean(text) || ["backspace", "delete"].includes(key.name ?? "");
    return { text: command, cursor, edited, ...(pasted.length > 0 && { pasted }), ...(capped && { capped: true }) };
}

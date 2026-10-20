import { clean, graphemes } from "./presentation.js";

export type EditKey = { name?: string | undefined; ctrl?: boolean; meta?: boolean };
export type Line = { text: string; cursor: number };

export function characterEdges(text: string): number[] {
    return [...Array.from(graphemes.segment(text), ({ index }) => index), text.length];
}

export function editLine(line: Line, text: string | undefined, key: EditKey): Line & { edited: boolean } {
    let { text: command, cursor } = line;
    const edges = characterEdges(command);
    const previous = edges.findLast((index) => index < cursor) ?? 0;
    const next = edges.find((index) => index > cursor) ?? command.length;
    if (key.name === "left") cursor = previous;
    else if (key.name === "right") cursor = next;
    else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0;
    else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = command.length;
    else if (key.name === "backspace") {
        command = command.slice(0, previous) + command.slice(cursor);
        cursor = previous;
    } else if (key.name === "delete") {
        command = command.slice(0, cursor) + command.slice(next);
    } else if (key.ctrl && key.name === "u") {
        command = command.slice(cursor);
        cursor = 0;
    } else if (text && !key.ctrl && !key.meta) {
        const inserted = clean(text.replace(/[\r\n\t]+/g, " ")).slice(0, Math.max(0, 2048 - command.length));
        command = command.slice(0, cursor) + inserted + command.slice(cursor);
        cursor += inserted.length;
    }
    return { text: command, cursor, edited: Boolean(text) || ["backspace", "delete"].includes(key.name ?? "") };
}

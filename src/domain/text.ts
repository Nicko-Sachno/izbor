const MAX_LEN = 500;

export function oneLine(text: string): string {
    const escaped = text.replace(/\r\n|\r|\n/g, "\\n");
    return escaped.length > MAX_LEN ? `${escaped.slice(0, MAX_LEN)}… (+${escaped.length - MAX_LEN} chars)` : escaped;
}

export const upperDrive = (path: string): string =>
    /^[a-z]:/.test(path) ? `${path[0]!.toUpperCase()}${path.slice(1)}` : path;

/** `path` relative to `folder` when it lies inside it, cut by string prefix for either separator; otherwise whole, as
 *  it is before any hook named the folder. */
export function relativeTo(folder: string | undefined, path: string): string {
    if (folder === undefined) return path;
    const base = folder.replace(/[\\/]+$/, "");
    return ["/", "\\"].some((separator) => path.startsWith(base + separator)) ? path.slice(base.length + 1) : path;
}

export const shortId = (sessionId: string) => sessionId.slice(0, 8);

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function codeOf(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}

/** A count and its noun, agreeing in number: `1 tool call`, `14 tool calls`. `mark` wraps the count, so a row can paint
 *  it bold. */
export const counted = (n: number, noun: string, mark: (n: number) => string = String): string =>
    `${mark(n)} ${n === 1 ? noun : `${noun}s`}`;

/** How many lines `text` holds, as the agent counts a file's: a new line at its end ends its last line and starts
 *  none. */
export const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export const isString = (value: unknown): value is string => typeof value === "string";

export const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export const fieldsOf = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

export function readJson(text: string): unknown | undefined {
    try {
        const value: unknown = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
        return value;
    } catch {
        return undefined;
    }
}

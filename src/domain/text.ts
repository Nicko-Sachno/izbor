const MAX_LEN = 500;

export function oneLine(text: string): string {
    const escaped = text.replace(/\r\n|\r|\n/g, "\\n");
    return escaped.length > MAX_LEN ? `${escaped.slice(0, MAX_LEN)}… (+${escaped.length - MAX_LEN} chars)` : escaped;
}

export const upperDrive = (path: string): string =>
    /^[a-z]:/.test(path) ? `${path[0]!.toUpperCase()}${path.slice(1)}` : path;

export const shortId = (sessionId: string) => sessionId.slice(0, 8);

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function codeOf(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}

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

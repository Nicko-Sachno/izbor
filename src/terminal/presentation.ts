import type { ForegroundColorName } from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { shortId } from "../domain/text.js";
import type { IzborState, Observation, RunningSession } from "./model.js";

const NEEDS_YOU = "#E7BC70";

export const palette = {
    text: "#E6E6DB",
    muted: "#969F96",
    focus: "#B2C4AB",
    needsYou: NEEDS_YOU,
    needsYouFill: NEEDS_YOU,
    needsYouOnFill: "#1F1600",
    notice: "#A9C6E1",
    error: "#F58C9A",
    done: "#7FCBA4",
    brand: "#D97757",
    border: "#7A837A",
    reply: "#AEB8C4",
};
export type Tone = keyof typeof palette;

export type Words = { text: string; tone: Tone };

export const palette16: Record<Tone, ForegroundColorName | undefined> = {
    text: undefined,
    muted: undefined,
    focus: undefined,
    needsYou: "yellow",
    needsYouFill: "yellow",
    needsYouOnFill: "black",
    notice: "cyan",
    error: "red",
    done: "green",
    brand: undefined,
    border: undefined,
    reply: "blueBright",
};

export const GLYPHS = { needsYou: "!", working: "*", idle: "✓", unknown: "?", notice: "▲" } as const;

export const refusalWords = (text: string): string => `× ${text}`;

export const STATUS = {
    busy: "Working",
    waiting: "Waiting",
    idle: "Idle",
    unknown: "Unknown",
    "not listed": "Not listed",
} as const;

const OLD_BUILD = "▲ old build · run npm run build";

const IZBOR_LABELS: Record<IzborState["state"], (port: string) => string> = {
    up: () => "Izbor ● up",
    stopping: () => "▲ Izbor ○ stopping",
    "not running": (port) => `▲ Izbor ○ not running on port ${port} · run izbor`,
    "not answering": () => "▲ Izbor ○ not answering",
    foreign: (port) => `▲ Izbor ○ port ${port} held by another program`,
};

export function topLine(izbor: IzborState, oldBuild: boolean, available: number) {
    const port = izbor.address.slice(izbor.address.lastIndexOf(":") + 1);
    const right = IZBOR_LABELS[izbor.state](port);
    const room = available - right.length - 1;
    const notice = oldBuild ? ([OLD_BUILD, "▲ old build"].find((text) => text.length <= room) ?? "") : "";
    const words = (text: string): Words => ({
        text,
        tone: text.startsWith("▲") ? "notice" : "muted",
    });
    return { corner: words(notice), state: words(right) };
}

export function clean(text: string): string {
    return text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
        .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
        .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[ -/]*[@-~]/g, "")
        .replace(/\t/g, "    ")
        .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
        .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f]/g, "");
}

export function singleLine(text: string): string {
    return clean(text).replace(/\s+/g, " ").trim();
}

export const sessionName = (session: Pick<RunningSession, "name">) => singleLine(session.name) || "Unnamed session";

export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function parts(text: string): string[] {
    return Array.from(graphemes.segment(text), ({ segment }) => segment);
}

export function clip(text: string, columns: number): string {
    const safe = singleLine(text);
    if (stringWidth(safe) <= columns) return safe;
    if (columns <= 0) return "";
    let result = "";
    for (const part of parts(safe)) {
        if (stringWidth(result + part) >= columns) break;
        result += part;
    }
    return `${result}…`;
}

export function wrapText(text: string, columns: number): string {
    return wrapAnsi(singleLine(text), Math.max(1, columns), { hard: true });
}

export function wrapLines(text: string, columns: number): string {
    return text
        .split("\n")
        .map((line) => wrapText(line, columns))
        .join("\n");
}

export function wrapSpaced(text: string, columns: number): string {
    return wrapAnsi(text, Math.max(1, columns), { hard: true });
}

export function wrapCut(text: string, columns: number, rows: number, room = 0): string {
    const fits = (line: string) => stringWidth(line) + room <= columns;
    let lines = wrapText(text, columns).split("\n");
    const words = lines.at(-1)!.split(" ");
    if (lines.length < rows && !fits(lines.at(-1)!) && words.length > 1 && fits(words.at(-1)!))
        lines = [...lines.slice(0, -1), words.slice(0, -1).join(" "), words.at(-1)!];
    if (lines.length <= rows && fits(lines.at(-1)!)) return lines.join("\n");
    if (lines.length < rows) return [...lines, ""].join("\n");
    return [...lines.slice(0, rows - 1), clip(`${lines[rows - 1]}…`, columns - room)].join("\n");
}

// A Brief page's heading stands under Back · Esc: up to ten rows, and never more than half the body.
export const pageHeadingRows = (bodyRows: number) => Math.max(1, Math.min(10, Math.floor(bodyRows / 2)));

export function headingTitle({ id, brief }: Pick<Observation, "id" | "brief">, width: number, rows: number): string {
    if (!brief) return shortId(id);
    return wrapCut(brief.task?.text ?? "Task unknown", width, rows).replace(/ …$/, "…");
}

export function openTitle(
    page: Observation | undefined,
    side: Observation | undefined,
    width: number,
    detailWidth: number,
    pageRows: number,
) {
    if (page) return headingTitle(page, width, pageRows);
    return side ? headingTitle(side, detailWidth - 10, 3) : "";
}

export function commandWindow(
    command: string,
    cursor: number,
    columns: number,
): {
    text: string;
    cursor: number;
    indices: number[];
} {
    const available = Math.max(1, columns);
    const before = Array.from(graphemes.segment(command.slice(0, cursor)));
    let hiddenUntil = 0;
    while (
        before.length &&
        stringWidth(before.map(({ segment }) => segment).join("")) + (hiddenUntil ? 1 : 0) >= available
    ) {
        const first = before.shift()!;
        hiddenUntil = first.index + first.segment.length;
    }
    let text = hiddenUntil && available > 1 ? "…" : "";
    const indices: number[] = [hiddenUntil];
    if (text) indices.push(hiddenUntil);
    let end = hiddenUntil;
    for (const part of graphemes.segment(command.slice(hiddenUntil))) {
        const width = stringWidth(part.segment);
        const column = stringWidth(text);
        if (column + width > available) break;
        const start = hiddenUntil + part.index;
        end = start + part.segment.length;
        for (let cell = 0; cell < width; cell++) indices[column + cell] = cell < width / 2 ? start : end;
        indices[column + width] = end;
        text += part.segment;
    }
    for (let column = stringWidth(text); column <= available; column++) indices[column] = end;
    return {
        text,
        cursor: Math.min(
            available - 1,
            (hiddenUntil && available > 1 ? 1 : 0) + stringWidth(command.slice(hiddenUntil, cursor)),
        ),
        indices,
    };
}

export function relativeTime(at: string, now: Date): string {
    const delta = now.getTime() - Date.parse(at);
    let age = "time unknown";
    if (Number.isFinite(delta)) {
        const seconds = Math.max(0, Math.floor(delta / 1000));
        age =
            delta < -1000
                ? "timestamp ahead"
                : seconds < 60
                  ? `${seconds}s ago`
                  : seconds < 3600
                    ? `${Math.floor(seconds / 60)}m ago`
                    : seconds < 86400
                      ? `${Math.floor(seconds / 3600)}h ago`
                      : `${Math.floor(seconds / 86400)}d ago`;
    }
    return age;
}

export const BLINK_MS = 5000;

const sinceMs = (at: string | undefined, now: Date) => (at === undefined ? NaN : now.getTime() - Date.parse(at));

function within(at: string | undefined, now: Date, ms: number): boolean {
    const since = sinceMs(at, now);
    return since >= 0 && since < ms;
}

export function blinking(at: string | undefined, now: Date): boolean {
    return within(at, now, BLINK_MS);
}

export function blinkShown(at: string | undefined, now: Date): boolean {
    return !blinking(at, now) || Math.floor(sinceMs(at, now) / 1000) % 2 === 0;
}

export function settling(at: string | undefined, now: Date): boolean {
    return within(at, now, BLINK_MS + 1000);
}

export function fullTime(at: string, now: Date): string {
    return `${singleLine(at)} · ${relativeTime(at, now)}`;
}

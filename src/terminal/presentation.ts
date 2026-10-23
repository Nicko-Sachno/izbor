import type { ForegroundColorName } from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { shortId } from "../domain/text.js";
import type { IzborState, Observation, RunningSession } from "./model.js";

const NEEDS_YOU = "#E7BC70";
const NOTICE = "#A9C6E1";

export const palette = {
    text: "#E6E6DB",
    muted: "#969F96",
    focus: "#B2C4AB",
    needsYou: NEEDS_YOU,
    needsYouFill: NEEDS_YOU,
    needsYouOnFill: "#1F1600",
    notice: NOTICE,
    error: "#F58C9A",
    done: "#7FCBA4",
    brand: "#D97757",
    border: "#7A837A",
    reply: "#AEB8C4",
    code: "#B1B9F9",
    link: NOTICE,
    pasteFill: "#2E352D",
    taskFill: "#373737",
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
    code: "blueBright",
    link: "blue",
    pasteFill: undefined,
    taskFill: "blackBright",
};

/** A colour drawn by its name at every colour level, so the terminal's palette decides it; `plain`, the terminal's
 *  own text colour. */
export type Hue = "blue" | "cyan" | "green" | "red" | "yellow" | "plain";

/** Syntax colours (ui-reference §2, Claude Code's map): the highlight.js scopes each hue draws, and the muted tone. */
export const syntax: Readonly<Record<Hue | "muted", readonly string[]>> = {
    blue: ["keyword", "literal", "class", "title.class"],
    cyan: ["built_in"],
    green: ["number", "addition"],
    red: ["string", "deletion"],
    yellow: ["function", "title.function"],
    muted: ["comment"],
    plain: ["params", "subst", "variable"],
};

export const GLYPHS = { needsYou: "!", working: "*", idle: "✓", unknown: "?", notice: "▲", refused: "×" } as const;

export const refusalWords = (text: string): string => `${GLYPHS.refused} ${text}`;

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

function withoutEscapes(text: string): string {
    return text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
        .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, "")
        .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b[ -/]*[@-~]/g, "");
}

const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f]/g;

export function clean(text: string): string {
    return withoutEscapes(text)
        .replace(/\t/g, "    ")
        .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
        .replace(INVISIBLE, "");
}

/** Text whose lines stay: CR LF and a lone CR become LF, and an OSC or DCS sequence left open ends with its line, so
 *  it takes none of the lines after it. */
function lineBounded(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?/g, "")
        .replace(/\x1b[P^_][^\n]*?(?:\x1b\\|(?=\n)|$)/g, "");
}

/** `clean()` for the field, whose text is sent as typed: its lines stay (`lineBounded`), and so do its tabs. */
export function cleanField(text: string): string {
    return withoutEscapes(lineBounded(text))
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
        .replace(INVISIBLE, "");
}

/** `clean()` for text that keeps its lines (`lineBounded`), its tabs 4 spaces each. */
export function cleanLines(text: string): string {
    return clean(lineBounded(text));
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

/** A time on the local clock: `14:32:05`, or `14:32` to the minute. */
export function clockTime(at: string, to: "second" | "minute" = "second"): string {
    const time = new Date(at);
    return [time.getHours(), time.getMinutes(), ...(to === "second" ? [time.getSeconds()] : [])]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

/** A count with a space between its thousands: `4 210`, `12 345`. */
export const spacedThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, " ");

/** A time taken, as the agent's own rows give a subagent's: `42s`, `1m 2s`, `1h 3m 0s`. */
export function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    if (minutes === 0) return `${seconds}s`;
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
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

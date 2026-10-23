import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sep } from "node:path";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { tilde } from "../../src/config.js";
import type { Rectangle, TerminalSize, TerminalView, ViewportLayout } from "../../src/terminal/model.js";
import { renderTerminal } from "../../src/terminal/render.js";
import { TerminalScreen } from "../../src/terminal/screen.js";

export const NOW = Date.parse("2026-10-09T12:00:00.000Z");

export function renderFrame(view: TerminalView, size: TerminalSize, color: boolean, now: Date) {
    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, step: 0, scroll: 0 };
    const snapshot = { ...view };
    const raw = renderToString(
        createElement(TerminalScreen, {
            view: snapshot,
            size,
            color,
            now,
            onLayout: (next) => {
                layout = next;
                snapshot.scroll = next.scroll;
                if (next.detail) snapshot.detailScroll = next.detail.scroll;
            },
        }),
        { columns: size.columns },
    );
    assert.equal(raw, renderTerminal(view, size, color, now).lines.join("\n"), "renderTerminal draws another frame");
    return { raw, layout };
}

export function screenBlock(rows: readonly string[], columns: number): string[] {
    return [
        "screen",
        ...rows.map((row, index) => {
            const width = stringWidth(row);
            assert.ok(width <= columns, `screen row ${index} is ${width} columns wide, past ${columns}`);
            return row.trimEnd();
        }),
    ];
}

// Each look's symbols, plain, underlined, bold and bold underlined, then the same four italic where a look has them.
const SYMBOLS = {
    none: " _=#/~+*",
    text: "tuTU1234",
    muted: "mnMN5678",
    focus: "fgFG",
    needsYou: "abAB",
    brand: "klKL",
    notice: "ijIJ",
    error: "rsRS",
    done: "deDE",
    border: "opOP",
    reply: "chCH",
    code: "qxQX90@&",
    fill: "yzYZ",
    pasteFill: "§¶¤¦",
    taskFill: "©®°±",
    inverse: "vwVW",
    // The named colours of syntax colours, at every colour level.
    red: "()<>",
    green: "!?$%",
    yellow: ":;,.",
    blue: "[]{}",
    cyan: "^|-'",
};
/** The named colours by their SGR code, as chalk writes them. */
const NAMED: Record<string, keyof typeof SYMBOLS> = {
    "31": "red",
    "32": "green",
    "33": "yellow",
    "34": "blue",
    "36": "cyan",
};
const TONES: Record<string, keyof typeof SYMBOLS> = {
    "#E6E6DB": "text",
    "#969F96": "muted",
    "#B2C4AB": "focus",
    "#E7BC70": "needsYou",
    "#D97757": "brand",
    "#A9C6E1": "notice",
    "#F58C9A": "error",
    "#7FCBA4": "done",
    "#7A837A": "border",
    "#AEB8C4": "reply",
    "#B1B9F9": "code",
};
const FILL = "#E7BC70";
const FILL_TEXT = "#1F1600";
/** The field's paste block: its label, in the focus tone, on the paste fill. */
const PASTE_FILL = "#2E352D";
/** Your Task in a Brief's heading: its words, in the text tone, on the Task fill. */
const TASK_FILL = "#373737";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cells of one row, `width` from column `x`: a run of an OSC 8 link to `url`, or of struck-through cells. */
type Run = { x: number; width: number; url?: string };

/** Adds `width` cells from column `x` to `runs`, to the last run when they follow it with the same URL. */
function extend(runs: Run[], x: number, width: number, url?: string) {
    const last = runs.at(-1);
    if (last && last.x + last.width === x && last.url === url) last.width += width;
    else runs.push({ x, width, url });
}

const hexOf = (rgb: string) =>
    `#${rgb
        .split(";")
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`.toUpperCase();
function readRow(row: string, legend: Map<string, string>) {
    let tone: keyof typeof SYMBOLS | typeof FILL_TEXT = "none";
    let fill: typeof FILL | typeof PASTE_FILL | typeof TASK_FILL | undefined;
    let inverse = false;
    let bold = false;
    let italic = false;
    let underline = false;
    let struck = false;
    let link: string | undefined;
    const links: Run[] = [];
    const strikes: Run[] = [];
    let x = 0;
    const fail = (what: string) => new Error(`${what}: ${JSON.stringify(row)}`);
    const look = (): keyof typeof SYMBOLS => {
        if (inverse) {
            if (fill || tone !== "none") throw fail(`inverse with ${fill ? "the fill" : tone} is not in the legend`);
            return "inverse";
        }
        if (fill === FILL) {
            if (tone !== FILL_TEXT) throw fail(`the fill with "${tone}" text is not in the legend`);
            return "fill";
        }
        if (fill === PASTE_FILL) {
            if (tone !== "focus") throw fail(`the paste fill with "${tone}" text is not in the legend`);
            return "pasteFill";
        }
        if (fill === TASK_FILL) {
            if (tone !== "text") throw fail(`the Task fill with "${tone}" text is not in the legend`);
            return "taskFill";
        }
        if (tone === FILL_TEXT) throw fail(`${FILL_TEXT} is the fill's text colour and no fill is open`);
        return tone;
    };
    let text = "";
    let styles = "";
    for (const [, url, sgr, characters] of row.matchAll(
        /\x1b\]8;[^;\x07]*;([^\x07]*)\x07|\x1b\[([\d;]*)m|([^\x1b]+)|\x1b/g,
    )) {
        if (url !== undefined) link = url || undefined;
        else if (sgr === "1" || sgr === "22") bold = sgr === "1";
        else if (sgr === "3" || sgr === "23") italic = sgr === "3";
        else if (sgr === "4" || sgr === "24") underline = sgr === "4";
        else if (sgr === "7" || sgr === "27") inverse = sgr === "7";
        else if (sgr === "9" || sgr === "29") struck = sgr === "9";
        else if (sgr === "39") tone = "none";
        else if (sgr === "49") fill = undefined;
        else if (sgr !== undefined && NAMED[sgr]) tone = NAMED[sgr];
        else if (sgr?.startsWith("38;2;")) {
            const hex = hexOf(sgr.slice(5));
            const named = hex === FILL_TEXT ? FILL_TEXT : TONES[hex];
            if (!named) throw fail(`color ${hex} is not in the legend`);
            tone = named;
        } else if (sgr?.startsWith("48;2;")) {
            const hex = hexOf(sgr.slice(5));
            if (hex !== FILL && hex !== PASTE_FILL && hex !== TASK_FILL)
                throw fail(`background ${hex} is not in the legend`);
            fill = hex;
        } else if (sgr !== undefined) throw fail(`SGR ${sgr} is not in the legend`);
        else if (characters === undefined) throw fail("an escape that is not SGR");
        else {
            const name = look();
            const symbol = SYMBOLS[name].charAt((italic ? 4 : 0) + (bold ? 2 : 0) + (underline ? 1 : 0));
            if (!symbol) throw fail(`italic ${name} is not in the legend`);
            const words = [name, bold ? "bold" : "", italic ? "italic" : "", underline ? "underline" : ""].filter(
                (word) => word && word !== "none",
            );
            if (symbol !== " ") legend.set(symbol, words.join(" "));
            text += characters;
            for (const { segment } of graphemes.segment(characters)) {
                const cells = stringWidth(segment);
                styles += symbol.repeat(cells);
                if (link !== undefined) extend(links, x, cells, link);
                if (struck) extend(strikes, x, cells);
                x += cells;
            }
        }
    }
    return { text, styles: styles.trimEnd(), links, strikes };
}

export function runs(values: readonly number[]): string {
    const out: string[] = [];
    for (let start = 0; start < values.length;) {
        let end = start;
        while (end < values.length && values[end] === values[start]) end++;
        out.push(end - start >= 3 ? `${values[start]}*${end - start}` : values.slice(start, end).join(","));
        start = end;
    }
    return out.join(",");
}

const rectangle = (rect: Rectangle | undefined) => (rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : "none");

/** A block of the frame with its title, and a blank row under it; none when it has no line, as in most frames. */
const block = (title: string, lines: readonly string[]) => (lines.length ? [title, ...lines, ""] : []);

/** Each row's runs as one line each: where they stand on the screen, in rows from its top, and the link's target. */
const runLines = (rows: readonly (readonly Run[])[]) =>
    rows.flatMap((row, y) =>
        row.map(({ x, width, url }) => `  ${rectangle({ x, y, width, height: 1 })}${url ? `  ${url}` : ""}`),
    );

function targetLine(target: NonNullable<ViewportLayout["targets"]>[number]): string {
    const named =
        target.type === "session" || target.type === "stop"
            ? `  ${target.id}`
            : target.type === "project"
              ? `  ${tilde(target.checkout, homedir()).split(sep).join("/")}`
              : target.type === "tab"
                ? `  ${target.screen}`
                : target.type === "field"
                  ? `  origin ${target.origin.x}  indices ${target.indices.map(runs).join(" / ")}`
                  : "";
    return `  ${target.type.padEnd(8)} ${rectangle(target.rect)}${named}`;
}

export function frameFile({
    id,
    about,
    size,
    color,
    now,
    raw,
    layout,
}: {
    id: string;
    about: string;
    size: TerminalSize;
    color: boolean;
    now: Date;
    raw: string;
    layout: ViewportLayout;
}): string {
    const legend = new Map<string, string>();
    const rows = raw.split("\n").map((row) => readRow(row, legend));
    const { detail, targets = [] } = layout;
    return [
        id,
        about,
        `${size.columns}x${size.rows} · ${color ? "color" : "no color"} · now ${now.toISOString()}`,
        "",
        ...screenBlock(
            rows.map(({ text }) => text),
            size.columns,
        ),
        "",
        "styles",
        ...rows.map(({ styles }) => styles),
        "",
        "legend",
        ...(legend.size
            ? [...legend].sort(([a], [b]) => (a < b ? -1 : 1)).map(([symbol, words]) => `  ${symbol}  ${words}`)
            : ["  none"]),
        "",
        ...block("links (OSC 8), by cells", runLines(rows.map(({ links }) => links))),
        ...block("struck through, by cells", runLines(rows.map(({ strikes }) => strikes))),
        `layout  scroll ${layout.scroll} · maxScroll ${layout.maxScroll} · pageSize ${layout.pageSize} · viewport ${rectangle(layout.viewport)}`,
        `detail  ${detail ? `scroll ${detail.scroll} · maxScroll ${detail.maxScroll} · pageSize ${detail.pageSize} · viewport ${rectangle(detail.viewport)}` : "none"}`,
        "",
        "targets, in hit-test order",
        ...(targets.length ? targets.map(targetLine) : ["  none"]),
        "",
    ].join("\n");
}

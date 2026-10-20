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
    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, scroll: 0 };
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

const SYMBOLS = {
    none: " _=#",
    text: "tuTU",
    muted: "mnMN",
    focus: "fgFG",
    needsYou: "abAB",
    brand: "klKL",
    notice: "ijIJ",
    error: "rsRS",
    done: "deDE",
    border: "opOP",
    reply: "chCH",
    fill: "yzYZ",
    inverse: "vwVW",
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
};
const FILL = "#E7BC70";
const FILL_TEXT = "#1F1600";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const hexOf = (rgb: string) =>
    `#${rgb
        .split(";")
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`.toUpperCase();
function readRow(row: string, legend: Map<string, string>) {
    let tone: keyof typeof SYMBOLS | typeof FILL_TEXT = "none";
    let fill = false;
    let inverse = false;
    let bold = false;
    let underline = false;
    const fail = (what: string) => new Error(`${what}: ${JSON.stringify(row)}`);
    const look = (): keyof typeof SYMBOLS => {
        if (inverse) {
            if (fill || tone !== "none") throw fail(`inverse with ${fill ? "the fill" : tone} is not in the legend`);
            return "inverse";
        }
        if (fill) {
            if (tone !== FILL_TEXT) throw fail(`the fill with "${tone}" text is not in the legend`);
            return "fill";
        }
        if (tone === FILL_TEXT) throw fail(`${FILL_TEXT} is the fill's text colour and no fill is open`);
        return tone;
    };
    let text = "";
    let styles = "";
    for (const [, sgr, characters] of row.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)|\x1b/g)) {
        if (sgr === "1" || sgr === "22") bold = sgr === "1";
        else if (sgr === "4" || sgr === "24") underline = sgr === "4";
        else if (sgr === "7" || sgr === "27") inverse = sgr === "7";
        else if (sgr === "39") tone = "none";
        else if (sgr === "49") fill = false;
        else if (sgr?.startsWith("38;2;")) {
            const hex = hexOf(sgr.slice(5));
            const named = hex === FILL_TEXT ? FILL_TEXT : TONES[hex];
            if (!named) throw fail(`color ${hex} is not in the legend`);
            tone = named;
        } else if (sgr?.startsWith("48;2;")) {
            const hex = hexOf(sgr.slice(5));
            if (hex !== FILL) throw fail(`background ${hex} is not in the legend`);
            fill = true;
        } else if (sgr !== undefined) throw fail(`SGR ${sgr} is not in the legend`);
        else if (characters === undefined) throw fail("an escape that is not SGR");
        else {
            const name = look();
            const symbol = SYMBOLS[name].charAt((bold ? 2 : 0) + (underline ? 1 : 0));
            const words = [name, bold ? "bold" : "", underline ? "underline" : ""].filter(
                (word) => word && word !== "none",
            );
            if (symbol !== " ") legend.set(symbol, words.join(" "));
            text += characters;
            for (const { segment } of graphemes.segment(characters)) styles += symbol.repeat(stringWidth(segment));
        }
    }
    return { text, styles: styles.trimEnd() };
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

function targetLine(target: NonNullable<ViewportLayout["targets"]>[number]): string {
    const named =
        target.type === "session" || target.type === "stop"
            ? `  ${target.id}`
            : target.type === "project"
              ? `  ${tilde(target.checkout, homedir()).split(sep).join("/")}`
              : target.type === "tab"
                ? `  ${target.screen}`
                : target.type === "field"
                  ? `  origin ${target.origin}  indices ${runs(target.indices)}`
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
        `layout  scroll ${layout.scroll} · maxScroll ${layout.maxScroll} · pageSize ${layout.pageSize} · viewport ${rectangle(layout.viewport)}`,
        `detail  ${detail ? `scroll ${detail.scroll} · maxScroll ${detail.maxScroll} · pageSize ${detail.pageSize} · viewport ${rectangle(detail.viewport)}` : "none"}`,
        "",
        "targets, in hit-test order",
        ...(targets.length ? targets.map(targetLine) : ["  none"]),
        "",
    ].join("\n");
}

import { readFileSync, writeFileSync } from "node:fs";
import stringWidth from "string-width";
import { palette } from "../src/terminal/presentation.js";

const BACKGROUND = "#1E211D";
const FILL_TEXT = "#1F1600";
const CELL_WIDTH = 8.4;
const ROW_HEIGHT = 18;
const PAD = 14;

type Style = { color: string; bold: boolean; underline: boolean; fill: boolean };

function block(lines: string[], name: string, until: string): string[] {
    const start = lines.indexOf(name) + 1;
    const end = lines.indexOf(until, start);
    return lines.slice(start, end === -1 ? undefined : end);
}

function styleOf(words: string): Style {
    const [tone = "text", ...rest] = words.split(" ");
    const fill = tone === "fill";
    const color = fill ? FILL_TEXT : ((palette as Record<string, string>)[tone] ?? palette.text);
    return { color, bold: rest.includes("bold"), underline: rest.includes("underline"), fill };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svgOf(frame: string, keep?: number): string {
    const lines = frame.split("\n");
    const size = /^(\d+)x(\d+) /.exec(lines[2] ?? "");
    if (!size) throw new Error(`The third line is not a frame's WxH header: ${JSON.stringify(lines[2])}`);
    const columns = Number(size[1]);
    const start = lines.indexOf("screen") + 1;
    let screen = lines
        .slice(start, start + Number(size[2]))
        .map((row) => [...row.padEnd(row.length + columns - stringWidth(row))]);
    let styles = block(lines, "styles", "legend").map((row) => [...row]);
    while (styles.length < screen.length) styles.push([]);
    styles = styles.slice(0, screen.length);
    const legend = new Map(
        block(lines, "legend", "")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => [line[0]!, styleOf(line.slice(1).trim())] as const),
    );
    if (keep && keep < screen.length - 1) {
        screen = [...screen.slice(0, keep), screen.at(-1)!];
        styles = [...styles.slice(0, keep), styles.at(-1)!];
    }
    const width = Math.round(columns * CELL_WIDTH + PAD * 2);
    const height = screen.length * ROW_HEIGHT + PAD * 2;
    const parts: string[] = [];
    screen.forEach((row, y) => {
        const top = PAD + y * ROW_HEIGHT;
        let x = 0;
        while (x < row.length) {
            const symbol = styles[y]![x] ?? " ";
            let end = x + 1;
            while (end < row.length && (styles[y]![end] ?? " ") === symbol) end++;
            const text = row.slice(x, end).join("");
            const style = symbol === " " ? undefined : legend.get(symbol);
            const left = PAD + x * CELL_WIDTH;
            if (style?.fill)
                parts.push(
                    `<rect x="${left}" y="${top + 1}" width="${(end - x) * CELL_WIDTH}" height="${ROW_HEIGHT - 2}" fill="${palette.needsYou}"/>`,
                );
            const attributes = `fill="${style?.color ?? palette.text}"${style?.bold ? ' font-weight="700"' : ""}`;
            for (const word of text.matchAll(/\S+/g)) {
                const wordLeft = left + word.index * CELL_WIDTH;
                const wordWidth = [...word[0]].length * CELL_WIDTH;
                parts.push(
                    `<text x="${wordLeft}" y="${top + 13}" ${attributes} textLength="${wordWidth}" lengthAdjust="spacingAndGlyphs">${escape(word[0])}</text>`,
                );
            }
            if (style?.underline && text.trim()) {
                const first = text.search(/\S/);
                const last = text.trimEnd().length;
                parts.push(
                    `<rect x="${left + first * CELL_WIDTH}" y="${top + 15}" width="${(last - first) * CELL_WIDTH}" height="1" fill="${style.color}"/>`,
                );
            }
            x = end;
        }
    });
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<rect width="${width}" height="${height}" rx="8" fill="${BACKGROUND}"/>`,
        `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14" xml:space="preserve">`,
        ...parts,
        "</g>",
        "</svg>",
        "",
    ].join("\n");
}

const [input, output, rows] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: frame-svg.ts <frame.txt> <out.svg> [rows]");
writeFileSync(output, svgOf(readFileSync(input, "utf8"), rows ? Number(rows) : undefined));

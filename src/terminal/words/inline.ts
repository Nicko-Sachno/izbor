import type { MarkedToken, Token, Tokens } from "marked";
import wrapAnsi from "wrap-ansi";
import { paint, type Look, type PaintStyle } from "../paint.js";

/** A rule: a row of `─` `width` columns wide, at least one, in the border tone. */
export const rule = (width: number, look: Look): string =>
    paint("─".repeat(Math.max(1, width)), look, { tone: "border" });

/** `&nbsp;` as a space. Every other entity stays as the agent wrote it, since raw HTML is printed as text. */
export const spaced = (text: string): string => text.replaceAll("&nbsp;", " ");

/**
 * The words of a run of inline tokens as one painted string. Each piece is painted in the whole style of the spans
 * around it, so a row cut out of it keeps its look; a line break stays a newline. Bold and italic lose their markers
 * with colour on and off alike; inline code is in the code tone, and its backticks come back with colour off. Links
 * and `~~struck~~` text draw as the look allows (`linkText`, `struckText`).
 */
export function inlineText(tokens: readonly Token[], look: Look, style: PaintStyle): string {
    // The lexer makes no token of an extension, so every token is one of marked's own.
    return tokens.map((token) => piece(token as MarkedToken, look, style)).join("");
}

function piece(token: MarkedToken, look: Look, style: PaintStyle): string {
    switch (token.type) {
        case "strong":
            return inlineText(token.tokens, look, { ...style, bold: true });
        case "em":
            return inlineText(token.tokens, look, { ...style, italic: true });
        case "codespan": {
            const code = look.colors === "off" ? token.raw.replaceAll("\n", " ") : token.text;
            return paint(code, look, { ...style, tone: "code" });
        }
        case "br":
            return "\n";
        case "text":
            // From its source: beside a numeric reference such as `&#169;`, marked's `text` decodes it and writes
            // every bare `&` as `&amp;`, and the agent's entities stay as written.
            return token.tokens ? inlineText(token.tokens, look, style) : paint(spaced(token.raw), look, style);
        case "escape":
            return paint(token.text, look, style);
        case "html":
            return paint(spaced(token.text), look, style);
        case "checkbox":
            // A task item's box, which stands first in its words when the item holds a blank line: the item draws it
            // in its marker's cell.
            return "";
        case "link":
            return linkText(token, look, style);
        case "del":
            return struckText(token, look, style);
        default:
            // An image shows as the agent wrote it.
            return paint(token.raw, look, style);
    }
}

/** `url` percent-encoded, as OSC 8 asks and as marked encodes an href; none when it cannot be, as with a lone
 *  surrogate. */
function encodedUrl(url: string): string | undefined {
    try {
        return encodeURI(url).replaceAll("%25", "%");
    } catch {
        return undefined;
    }
}

/**
 * `words` as an OSC 8 link to `url`, each sequence ending in BEL as wrap-ansi expects, so a link wrapped over rows
 * opens again on each; a URL that cannot be encoded links nowhere. Besides the alerts writer in main.ts, this is the
 * one OSC that src/terminal writes.
 */
function hyperlink(url: string, words: string): string {
    const target = encodedUrl(url);
    return target === undefined ? words : `\x1b]8;;${target}\x07${words}\x1b]8;;\x07`;
}

/**
 * Whether a link's label says its URL whole: a bare URL, a label equal to its URL, or marked's `www.` and email
 * autolinks, whose URL adds `http://` or `mailto:` to the label.
 */
const saysItsUrl = (label: string, url: string): boolean =>
    url === label || url === `mailto:${label}` || (label.startsWith("www.") && url === `http://${label}`);

/**
 * A link: its label in the link tone, underlined, or its URL where it has none. Where the look has links, the label
 * is an OSC 8 link to its URL; elsewhere, and with colour off, the URL follows it, muted and in brackets, unless the
 * label already says it, which then shows once.
 */
function linkText({ href, text, tokens }: Tokens.Link, look: Look, style: PaintStyle): string {
    const linked: PaintStyle = { ...style, tone: "link", underline: true };
    const label = text ? inlineText(tokens, look, linked) : paint(href, look, linked);
    if (look.links) return hyperlink(href, label);
    if (!text || saysItsUrl(text, href)) return label;
    return `${label}${paint(" ", look, style)}${paint(`(${href})`, look, { ...style, tone: "muted" })}`;
}

/**
 * `~~struck~~` text: struck through where the look has strikethrough; elsewhere, and with colour off, its words
 * between the `~~` the agent wrote. A single `~` never makes one (`tokensOf` in rows.ts).
 */
function struckText({ tokens }: Tokens.Del, look: Look, style: PaintStyle): string {
    if (look.strike) return inlineText(tokens, look, { ...style, strike: true });
    const marks = paint("~~", look, style);
    return `${marks}${inlineText(tokens, look, style)}${marks}`;
}

/** Stands in for a space that holds a number such as `1.` to the word before it while the words wrap. */
const GLUE = "\u00a0";

/** A space before a number such as `1.` or `2)`, with any colour codes between them. */
const BEFORE_NUMBER = / (?=(?:\x1b\[[\d;]*m)*\d{1,9}[.)](?:\x1b\[[\d;]*m)*(?: |$))/g;

/** The colour codes a row of painted words opens with, and the spaces after them. */
const OPENING = /^((?:\x1b\[[\d;]*m)*)( *)/;

/**
 * One line of painted words wrapped hard at `width`, measured with string-width. Its leading spaces stay, in its
 * style, and its wrapped rows hang under them, unless they take half the width or more; then the line wraps from the
 * margin. A space before a number such as `1.` is held to the word before it, so no wrapped row starts with what
 * looks like a list marker; it is a space again once the line is wrapped.
 */
export function wrapWords(line: string, width: number): string[] {
    const [, codes = "", spaces = ""] = OPENING.exec(line) ?? [];
    const indent = spaces.length * 2 < width ? spaces : "";
    const words = codes + line.slice(codes.length + spaces.length);
    return wrapAnsi(words.replace(BEFORE_NUMBER, GLUE), Math.max(1, width - indent.length), { hard: true })
        .split("\n")
        .map((row) => row.replace(OPENING, (_, open: string) => open + indent).replaceAll(GLUE, " "));
}

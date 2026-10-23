import chalk from "chalk";
import type { Abilities } from "./model.js";
import { palette, palette16, type Hue, type Tone } from "./presentation.js";

// The one rule for which table colour draws from: `palette` at chalk level 2 or more, else its 16-colour names.
const usesPalette = (): boolean => chalk.level >= 2;

export function toneColor(tone: Tone): string | undefined {
    return usesPalette() ? palette[tone] : palette16[tone];
}

/**
 * How finished rows are painted: in the palette, in its 16-colour names, or with colour off (attributes only); and
 * whether the agent's links are OSC 8 links and its `~~struck~~` text is struck through.
 */
export type Look = { colors: "palette" | "palette16" | "off"; links: boolean; strike: boolean };

/**
 * The look of a screen drawn with `color` on a terminal with `abilities`: off without colour, else picked by chalk's
 * level, as `toneColor` picks. Links and strikethrough are on only where the terminal shows them, and never with
 * colour off.
 */
export function lookOf(color: boolean, { links = false, strike = false }: Abilities = {}): Look {
    return {
        colors: !color ? "off" : usesPalette() ? "palette" : "palette16",
        links: color && links,
        strike: color && strike,
    };
}

function colored(text: string, { colors }: Look, tone: Tone, hue: Hue | undefined): string {
    if (colors === "off") return text;
    if (hue) return hue === "plain" ? text : chalk[hue](text);
    if (colors === "palette") return chalk.hex(palette[tone])(text);
    const name = palette16[tone];
    return name ? chalk[name](text) : text;
}

/** How Copy styles its text: its tone, bold and underline. */
export type CopyStyle = { color: boolean; tone?: Tone; bold?: boolean; underline?: boolean };

/**
 * How `paint()` styles a row: as Copy does, and italic and struck through too, which only painted rows draw. A `hue`
 * stands in for the tone in every look with colour: a syntax colour (`syntax`). `fill` is the tone of a background,
 * which only the field's paste block has and only the palette draws.
 */
export type PaintStyle = Omit<CopyStyle, "color"> & { italic?: boolean; strike?: boolean; hue?: Hue; fill?: Tone };

/** One finished row as an ANSI string, in the bytes Ink's Text draws for the same style: colour, then the fill, then
 *  bold, then italic, then underline, then strikethrough. */
export function paint(
    text: string,
    look: Look,
    { tone = "text", hue, fill, bold = false, italic = false, underline = false, strike = false }: PaintStyle = {},
): string {
    const colour = colored(text, look, tone, hue);
    const painted = fill && look.colors === "palette" ? chalk.bgHex(palette[fill])(colour) : colour;
    const thick = bold ? chalk.bold(painted) : painted;
    const slanted = italic ? chalk.italic(thick) : thick;
    const lined = underline ? chalk.underline(slanted) : slanted;
    return strike ? chalk.strikethrough(lined) : lined;
}

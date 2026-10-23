import HighlightJs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import { paint, type Look, type PaintStyle } from "../paint.js";
import { syntax, type Hue } from "../presentation.js";
import type { Highlighter } from "./blocks.js";

// Syntax colours for code blocks, loaded only by a terminal app with colour on (doc 01 R4): the grammars stay out of
// `izbor --help` and out of a screen without colour.

/** The languages a fence may name for syntax colours, by highlight.js's name for each (PRD slice 5). */
const GRAMMARS = { bash, css, diff, go, javascript, json, python, rust, typescript, yaml };

type Color = Hue | "muted";

/** Each scope `syntax` maps, to its colour. */
const COLORS = new Map(
    (Object.keys(syntax) as Color[]).flatMap((color) => syntax[color].map((scope) => [scope, color] as const)),
);

type Tree = ReturnType<ReturnType<typeof createLowlight>["highlight"]>;
type Node = Tree["children"][number];

/** A run of code in one colour; none, the colour of the code around it. */
type Run = { text: string; color: Color | undefined };

/** The underscores lowlight puts after each part of a scope but the first, one more for each part. */
const PART_MARK = /_+$/;

/**
 * The colour of a span, from the classes lowlight gives it with no prefix (`title`, `function_`, `invoke__` for the
 * scope `title.function.invoke`): the colour of its scope, or of the nearest scope it is part of, as `title.function`
 * for that one; none when neither is mapped.
 */
function colorOf(classes: unknown): Color | undefined {
    const parts = Array.isArray(classes) ? classes.map((name) => String(name).replace(PART_MARK, "")) : [];
    for (let length = parts.length; length > 0; length--) {
        const color = COLORS.get(parts.slice(0, length).join("."));
        if (color) return color;
    }
    return undefined;
}

/** The tree's text in runs, each in the colour of its nearest span with one, else in `color`. */
function runsOf(nodes: readonly Node[], color: Color | undefined): Run[] {
    return nodes.flatMap((node): Run[] => {
        if (node.type === "text") return [{ text: node.value, color }];
        if (node.type !== "element") return [];
        return runsOf(node.children, colorOf(node.properties.className) ?? color);
    });
}

/**
 * The runs split into source lines at their newlines, each part painted on its own, so each line opens and closes its
 * own colours and a comment over several lines stays muted on every one. Code in no colour takes the terminal's text
 * colour.
 */
function linesOf(runs: readonly Run[], look: Look, style: PaintStyle): string[] {
    const lines = [""];
    for (const { text, color } of runs)
        text.split("\n").forEach((part, index) => {
            if (index) lines.push("");
            const painted = color === "muted" ? { ...style, tone: color } : { ...style, hue: color ?? "plain" };
            if (part) lines[lines.length - 1] += paint(part, look, painted);
        });
    return lines;
}

/**
 * Puts a highlighter for each language in `GRAMMARS` into `into`, under its name and every alias highlight.js gives
 * it (`ts`, `sh`, `py`, `yml`, `rs`, …), all lower case. Each one highlights a whole block, then splits it into lines;
 * a block its grammar fails on gets none.
 */
export function addHighlighters(into: Map<string, Highlighter>): void {
    const lowlight = createLowlight(GRAMMARS);
    for (const [name, grammar] of Object.entries(GRAMMARS)) {
        const highlight: Highlighter = (code, look, style) => {
            try {
                return linesOf(runsOf(lowlight.highlight(name, code, { prefix: "" }).children, undefined), look, style);
            } catch {
                return undefined;
            }
        };
        for (const alias of [name, ...(grammar(HighlightJs).aliases ?? [])]) into.set(alias.toLowerCase(), highlight);
    }
}

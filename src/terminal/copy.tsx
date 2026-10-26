import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { toneColor, type CopyStyle } from "./paint.js";
import { GLYPHS, refusalWords, wrapLines } from "./presentation.js";

export function Copy({
    children,
    color,
    tone = "text",
    bold = false,
    underline = false,
}: CopyStyle & { children: ReactNode }) {
    return (
        <Text {...(color && { color: toneColor(tone) })} bold={bold} underline={underline}>
            {children}
        </Text>
    );
}

export const BADGE = " ! Needs you ";

export function Badge({ color }: { color: boolean }) {
    if (!color)
        return (
            <Text bold inverse>
                {BADGE}
            </Text>
        );
    return (
        <Text bold backgroundColor={toneColor("needsYouFill")} color={toneColor("needsYouOnFill")}>
            {BADGE}
        </Text>
    );
}

export type Glyph = keyof typeof GLYPHS;

const MARK_STYLES: Record<Glyph, Omit<CopyStyle, "color">> = {
    needsYou: { tone: "needsYou", bold: true },
    working: { tone: "brand" },
    idle: { tone: "done" },
    unknown: { tone: "muted" },
    notice: { tone: "muted" },
    refused: { tone: "error", bold: true },
};

export function Mark({ glyph, color }: { glyph: Glyph | undefined; color: boolean }) {
    return (
        <Box width={1} flexShrink={0}>
            {glyph ? (
                <Copy color={color} {...MARK_STYLES[glyph]}>
                    {GLYPHS[glyph]}
                </Copy>
            ) : (
                <Text> </Text>
            )}
        </Box>
    );
}

export type Span = { text: string } & Omit<CopyStyle, "color">;

export function Spans({ spans, color }: { spans: readonly Span[]; color: boolean }) {
    return (
        <Text>
            {spans.map((span, index) => (
                <Copy key={index} color={color} tone={span.tone} bold={span.bold} underline={span.underline}>
                    {span.text}
                </Copy>
            ))}
        </Text>
    );
}

type Feedback = { text: string; error: boolean };

export const feedbackText = ({ text, error }: Feedback, width: number): string =>
    wrapLines(error ? refusalWords(text) : text, width);

export function FeedbackLine({ line, width, color }: { line: Feedback | null; width: number; color: boolean }) {
    if (!line) return null;
    return (
        <Box width={width} flexShrink={0}>
            <Copy color={color} tone={line.error ? "error" : "muted"} bold={line.error}>
                {feedbackText(line, width)}
            </Copy>
        </Box>
    );
}

// The parts of a Brief, each with a mark of its own: your Task, Izbor's explanation under Now, and the agent's full
// response.
import type { Tone, Words } from "./presentation.js";

/** The mark before each part of a Brief, in its tone: `›` before your Task, `◆` before Now, Izbor's explanation, and
 *  `●` before the agent's full response. The three hues stand apart, so no two parts read as one. */
export const PART_MARKS = {
    task: { text: "›", tone: "code" },
    now: { text: "◆", tone: "done" },
    reply: { text: "●", tone: "brand" },
} as const satisfies Record<string, Words>;

/** The columns a part's mark takes before its words: the mark and a space. */
export const MARK_COLUMNS = 2;

/** A part's mark and the space after it, in its tone, bold: the span it stands as on its row. */
export const markWords = (part: keyof typeof PART_MARKS) => ({
    ...PART_MARKS[part],
    text: `${PART_MARKS[part].text} `,
    bold: true,
});

/** The Now field's name after its mark. */
export const NOW_NAME = [markWords("now"), { text: "Now", tone: "muted" }] as const;

/**
 * A heading's rows as spans where the Task has no fill: the Task's mark before its first row and the rows after it
 * hung under its words. The short ID before the first brief (`marked` false) stands alone.
 */
export function taskSpans(title: string, style: { tone: Tone; underline: boolean }, marked: boolean) {
    const [first = "", ...rest] = title.split("\n");
    const hang = { text: `\n${" ".repeat(MARK_COLUMNS)}`, tone: style.tone };
    return [
        ...(marked ? [markWords("task")] : []),
        { text: first, ...style },
        ...rest.flatMap((row) => [hang, { text: row, ...style }]),
    ];
}

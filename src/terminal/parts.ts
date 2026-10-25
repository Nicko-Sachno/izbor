// The parts of a Brief, each with a mark of its own: your Task, Izbor's explanation under Now, and the agent's full
// response.
import type { Words } from "./presentation.js";

/** The mark before each part of a Brief, in its tone: `›` before your Task, `◆` before Now, Izbor's explanation, and
 *  `●` before the agent's full response. Each has a tone of its own, so no two parts look alike. */
export const PART_MARKS = {
    task: { text: "›", tone: "code" },
    now: { text: "◆", tone: "done" },
    reply: { text: "●", tone: "brand" },
} as const satisfies Record<string, Words>;

/** The columns a part's mark takes before its words: the mark and a space. */
export const MARK_COLUMNS = 2;

/** A part's mark and the space after it, bold, in its tone. */
export const markWords = (part: keyof typeof PART_MARKS) => ({
    ...PART_MARKS[part],
    text: `${PART_MARKS[part].text} `,
    bold: true,
});

/** The name of the field that holds your Task, after its mark. */
export const PROMPT_NAME = [markWords("task"), { text: "User's last prompt", tone: "muted" }] as const;

/** The Now field's name after its mark. */
export const NOW_NAME = [markWords("now"), { text: "Now", tone: "muted" }] as const;

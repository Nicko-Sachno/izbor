import stringWidth from "string-width";
import type { ResponseEnd } from "../../domain/response.js";
import { counted } from "../../domain/text.js";
import { clip, relativeTime, type Words } from "../presentation.js";

/** The first form that fits `width`, longest first; the last one clipped when none does. */
function firstFit(forms: readonly string[], width: number): string {
    return forms.find((form) => stringWidth(form) <= width) ?? clip(forms.at(-1) ?? "", width);
}

const LIVE = ["Agent's latest message so far", "Latest message so far", "Latest"];
const OVER = ["Agent's last message", "Last message", "Last"];
const AFTER_TASK = [
    "Agent's last message · after the background task",
    "Agent's last message · after a task",
    "Last · after a task",
];

// While the agent writes or waits, the label names the live edge; once the turn is over, the last message.
const LABELS: Record<ResponseEnd["state"], readonly string[]> = {
    "nothing yet": LIVE,
    writing: LIVE,
    waiting: LIVE,
    finished: OVER,
    interrupted: OVER,
    "ended at a tool call": OVER,
    failed: OVER,
};

/** Whether the agent still writes or waits, so the full response's top part is the live edge, not the last message.
 *  An end state this build does not know (a newer service) reads as a turn that is over, and so does every end of an
 *  idle session in a project without hooks (`noHooks`), since the No hooks line stands in for its end line. */
export const isLive = (end: ResponseEnd, noHooks: boolean): boolean => !noHooks && LABELS[end.state] === LIVE;

/** The full response's label row, aged by the newest text item's time: the live edge's while `live`, else the last
 *  message's, which `afterTask` says came after a background task finished. */
export function replyLabel(
    newest: string,
    now: Date,
    width: number,
    how: { live: boolean; afterTask: boolean },
): string {
    const age = relativeTime(newest, now);
    const forms = how.live ? LIVE : how.afterTask ? AFTER_TASK : OVER;
    return firstFit(
        forms.map((words) => `${words} · ${age}`),
        width,
    );
}

/** The label over the items before the live edge, with the count of the tool calls among them. */
export function turnLabel(width: number, calls: number): string {
    const count = calls ? ` · ${counted(calls, "tool call")}` : "";
    return firstFit([`Earlier in this turn${count}`, `Earlier${count}`, "Earlier"], width);
}

/**
 * The C divider's words while no text item stands, the first form that fits `width`: which of the full response's
 * rows under it are in view out of all of them, `rows 1-7 of 7`, then `· no text yet` while the agent writes or waits.
 * A reply that ended with no text shows the count alone, so it never reads as if more text were coming.
 */
export function dividerWords(shown: { from: number; to: number }, rows: number, live: boolean, width: number): string {
    const count = `${shown.to < shown.from ? "0" : `${shown.from}-${shown.to}`} of ${rows}`;
    if (!live) return firstFit([`rows ${count}`, count], width);
    return firstFit([`rows ${count} · no text yet`, `${count} · no text yet`, "no text yet"], width);
}

/** Stands in for the end line of an idle session in a project without hooks, whatever the transcript says. */
const NO_HOOKS: Words = {
    text: "Idle: without hooks Izbor cannot tell a finished reply from a failed one",
    tone: "muted",
};

/**
 * The full response's end line once the reply ended, and its tone: `Reply finished · 2m ago` in green, aged by the
 * end's time, in the first form that fits; else how it ended, in muted, to be wrapped. None while the agent writes or
 * waits, nor for an end state this build does not know. For an idle session in a project without hooks (`noHooks`),
 * the No hooks line instead, in every end state: Izbor reads such a reply late from the transcript, which may not hold
 * its end yet.
 */
export function endWords(end: ResponseEnd, now: Date, width: number, noHooks: boolean): Words | undefined {
    if (noHooks) return NO_HOOKS;
    switch (end.state) {
        case "nothing yet":
        case "writing":
        case "waiting":
            return undefined;
        case "finished": {
            const age = relativeTime(end.at, now);
            return { text: firstFit([`Reply finished · ${age}`, `Finished · ${age}`], width), tone: "done" };
        }
        case "interrupted":
            return { text: "Reply interrupted by the user: the agent's unfinished words are not saved", tone: "muted" };
        case "ended at a tool call":
            return { text: `Reply ended: rejected by the user: ${end.call}`, tone: "muted" };
        case "failed":
            return { text: end.error ? `Reply failed: ${end.error}` : "Reply failed", tone: "muted" };
        default:
            end satisfies never;
            return undefined;
    }
}

/** The work under `Earlier in this turn`: its tool calls, and the files they changed with the lines added and removed,
 *  when every changed file has counts. */
export type Work = { calls: number; files?: { count: number; added: number; removed: number } };

/** What the rows below the view are, for the footer to name. */
export type Below =
    /** The live edge stands whole in view: `rows` counts every row below, all from before it. */
    | { kind: "live edge"; rows: number }
    /** `rows` of the live edge, or of the last message, are still below, and the work under it. */
    | { kind: "message"; rows: number; work: Work }
    /** The view ends inside the turn or above the full response: `rows` counts every row below. */
    | { kind: "turn"; rows: number };

/** The rest of the message, then the work: its tool calls, then the files it changed, where they fit. */
function messageForms(rows: number, { calls, files }: Work): string[] {
    const more = `↓ ${counted(rows, "more row")} of it`;
    const short = `↓ ${rows} more · PgDn`;
    if (!calls) return [`${more} · PgDn`, short];
    const work = counted(calls, "tool call");
    const changed = files ? `, ${counted(files.count, "file")} +${files.added} −${files.removed}` : "";
    return [`${more}, then the work: ${work}${changed} · PgDn`, `${more}, then ${work} · PgDn`, short];
}

/** The footer's words, the first form that fits `width`: `↓ 196 rows before it · PgDn`, `↓ 10 more rows of it, then
 *  the work: 14 tool calls, 3 files +42 −7 · PgDn` or `↓ 120 more rows · PgDn`, each down to its short form. */
export function footerText(below: Below, width: number): string {
    switch (below.kind) {
        case "live edge":
            return firstFit(
                [
                    `↓ ${counted(below.rows, "row")} before it · PgDn`,
                    `↓ ${counted(below.rows, "row")} · PgDn`,
                    `↓ ${below.rows}`,
                ],
                width,
            );
        case "message":
            return firstFit(messageForms(below.rows, below.work), width);
        case "turn":
            return firstFit(
                [`↓ ${counted(below.rows, "more row")} · PgDn`, `↓ ${below.rows} · PgDn`, `↓ ${below.rows}`],
                width,
            );
        default:
            return below satisfies never;
    }
}

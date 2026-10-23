import type { ToolKind } from "./records.js";
import { counted as countedBy } from "./text.js";

/** The agent's reply to the Task, as every listener reads it in the brief: its items in order, and how it ended. */
export type FullResponse = {
    items: ResponseItem[];
    end: ResponseEnd;
    source: ResponseSource;
    /** How many characters of text were left out: the earliest text items, past TEXT_LIMIT. */
    cut: number;
};

/** Where a full response's items come from: the transcript, or only the agent's last message when Izbor cannot read
 *  the transcript. */
export type ResponseSource = "transcript" | "last message only";

/** One piece of the full response. A text item is one assistant text block, as raw markdown, whole. */
export type ResponseItem =
    | { type: "text"; id: string; at: string; text: string }
    | ToolItem
    | SubagentItem
    | { type: "notice"; id: string; at: string; text: string };

/** A tool call: `id` is the call's id, `title` as `describeTool` gives it. */
export type ToolItem = {
    type: "tool";
    id: string;
    at: string;
    name: string;
    kind: ToolKind;
    title: string;
    /** The call's name as the agent shows it, such as `Update` for an edit or `server · tool` for an MCP tool. */
    display: string;
    /** The call's whole main argument; a path inside the session's folder is relative to it. "" when it has none. */
    argument: string;
    /** The input's own description of the call, when it has one. */
    description?: string;
    state: ToolState;
    result?: ToolResult;
    /** The result in words, for a listener that only prints it. */
    summary?: string;
};

/** The kinds of call whose main argument is a file's path, which the brief makes relative to the session's folder. */
export const PATH_KINDS: readonly ToolKind[] = ["read", "edit"];

/** A call that starts a subagent. None of the subagent's own messages becomes an item. */
export type SubagentItem = {
    type: "subagent";
    id: string;
    at: string;
    /** The subagent's type, when the call names one. */
    agentType?: string;
    /** The call's name as the agent shows it, such as `Task`. */
    display: string;
    description: string;
    state: ToolState;
    /** Once it finished with counts; one started in the background has none. */
    toolUses?: number;
    durationMs?: number;
    /** Its result's first line, or its failure, from the transcript. */
    result?: ToolResult;
    summary?: string;
};

export type ToolState = "running" | "waiting" | "done" | "failed" | "rejected" | "interrupted";

/** A call's result as counts; a path inside the session's folder is relative to it. `added` and `removed` of a write
 *  over a file come from its patch, when the agent gave one; `firstLine` of a failure is its first error line. */
export type ToolResult =
    | { kind: "read"; lines: number }
    | { kind: "wrote"; lines: number; path: string; created: boolean; added?: number; removed?: number }
    | { kind: "changed"; added: number; removed: number; path: string }
    | { kind: "found"; files: number }
    | { kind: "ran"; exitCode: number; firstLine: string }
    | { kind: "failed"; exitCode?: number; firstLine: string }
    | { kind: "first line"; text: string }
    | { kind: "background" };

/** A finished subagent's tool uses and time. */
export type SubagentCounts = { toolUses: number; durationMs: number };

/** What a hook tells of a call that ended: a tool's result, a subagent's counts, or that the user interrupted it. */
export type CallResult = ToolResult | ({ kind: "subagent" } & SubagentCounts) | { kind: "interrupted" };

/** How a result's words show: `count` marks each count (the terminal makes it bold), and `path: false` leaves the path
 *  out (the terminal's 40-column form). By default nothing is marked and the path stays, as in the wire's summary. */
type Wording = { count?: (count: number) => string; path?: boolean };

/** Shown for a command that printed nothing, as the agent's own rows show it. */
const NO_OUTPUT = "(No output)";

/** Shown for a call that left its work running in the background, as the agent's own rows show a command's. */
const IN_BACKGROUND = "Running in the background";

/** A result in the words the agent's own rows use, each noun agreeing with its count: `Read 1 line`, `Found 3 files`,
 *  `Added 2 lines, removed 1 line`, `Failed with exit code 1 · <first error line>`, `Running in the background`. */
export function resultInWords(result: ToolResult, { count = String, path = true }: Wording = {}): string {
    const counted = (n: number, noun: string) => countedBy(n, noun, count);
    switch (result.kind) {
        case "read":
            return `Read ${counted(result.lines, "line")}`;
        case "wrote":
            return `Wrote ${counted(result.lines, "line")}${path ? ` to ${result.path}` : ""}`;
        case "changed":
            return changedInWords(result.added, result.removed, counted);
        case "found":
            return `Found ${counted(result.files, "file")}`;
        case "ran":
            return result.firstLine || NO_OUTPUT;
        case "failed":
            return failedInWords(result.exitCode, result.firstLine);
        case "first line":
            return result.text;
        case "background":
            return IN_BACKGROUND;
        default:
            return result satisfies never;
    }
}

/** `Added N lines, removed M lines`, leaving out a part whose count is 0 as the agent's rows do; both when both are. */
function changedInWords(added: number, removed: number, counted: (n: number, noun: string) => string): string {
    const words = [
        added > 0 || removed === 0 ? `added ${counted(added, "line")}` : "",
        removed > 0 || added === 0 ? `removed ${counted(removed, "line")}` : "",
    ]
        .filter(Boolean)
        .join(", ");
    return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

function failedInWords(exitCode: number | undefined, firstLine: string): string {
    if (exitCode === undefined) return firstLine;
    return firstLine ? `Failed with exit code ${exitCode} · ${firstLine}` : `Failed with exit code ${exitCode}`;
}

/** How the reply ended, with its time. `call` names the call it ended at; `error` is the provider's own words. */
export type ResponseEnd =
    | { state: "nothing yet" | "writing" | "waiting" | "finished" | "interrupted"; at: string }
    | { state: "ended at a tool call"; at: string; call: string }
    | { state: "failed"; at: string; error: string };

/** The most characters the text items of a full response hold in all, counted as a string's length. */
const TEXT_LIMIT = 20_000;

/** The items within TEXT_LIMIT characters of text, and how many characters went: past it, the earliest text items drop
 *  whole, so a cut never splits a code fence. The newest text item always stays, even alone past the limit, and tool,
 *  subagent and notice items are never cut. */
export function withTextCut(items: readonly ResponseItem[]): Pick<FullResponse, "items" | "cut"> {
    const texts = items.flatMap((item) => (item.type === "text" ? [item] : []));
    const total = texts.reduce((sum, { text }) => sum + text.length, 0);
    let kept = total;
    let dropped = 0;
    while (kept > TEXT_LIMIT && dropped < texts.length - 1) kept -= texts[dropped++]!.text.length;
    const gone = new Set<ResponseItem>(texts.slice(0, dropped));
    return { items: items.filter((item) => !gone.has(item)), cut: total - kept };
}

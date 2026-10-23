import { questionsOf } from "./question.js";
import type { ToolKind } from "./records.js";

export const PLAN_TOOL = "ExitPlanMode";

type ToolInput = Record<string, unknown>;

const TOOLS: Record<string, { kind: ToolKind; title: (input: ToolInput) => unknown; shownAs?: string }> = {
    Bash: { kind: "execute", title: (i) => i.command },
    PowerShell: { kind: "execute", title: (i) => i.command },
    Read: { kind: "read", title: (i) => i.file_path },
    Edit: { kind: "edit", title: (i) => i.file_path },
    Write: { kind: "edit", title: (i) => i.file_path },
    NotebookEdit: { kind: "edit", title: (i) => i.notebook_path },
    Grep: { kind: "search", title: (i) => i.pattern },
    Glob: { kind: "search", title: (i) => i.pattern },
    WebFetch: { kind: "fetch", title: (i) => i.url },
    WebSearch: { kind: "fetch", title: (i) => i.query },
    Agent: { kind: "think", title: (i) => i.description },
    Task: { kind: "think", title: (i) => i.description },
    AskUserQuestion: { kind: "other", title: (i) => questionsOf(i)[0] },
    [PLAN_TOOL]: { kind: "switch_mode", title: (i) => i.plan, shownAs: "Plan approval" },
};

const toolOf = (name: string) => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined);

const MAX_TITLE = 100;

export function shorten(text: string): string {
    const [firstLine = ""] = text.split(/\r?\n|\r/);
    const cut = firstLine.length < text.length;
    if (firstLine.length + (cut ? 2 : 0) <= MAX_TITLE) return cut ? `${firstLine} …` : firstLine;
    return `${firstLine.slice(0, MAX_TITLE - 1)}…`;
}

/** A call's whole main argument, as its tool's entry reads it from the input; undefined when it has none. */
export function mainArgument(name: string, rawInput: unknown): string | undefined {
    const argument = toolOf(name)?.title((rawInput ?? {}) as ToolInput);
    return typeof argument === "string" && argument ? argument : undefined;
}

export function describeTool(name: string, rawInput: unknown): { kind: ToolKind; title: string } {
    const argument = mainArgument(name, rawInput);
    return { kind: toolOf(name)?.kind ?? "other", title: argument === undefined ? name : shorten(argument) };
}

export function toolLabel(name: string, title: string): string {
    const shown = toolOf(name)?.shownAs ?? name;
    return title === name ? shown : `${shown}: ${title}`;
}

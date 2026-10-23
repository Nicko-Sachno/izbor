import type { Request } from "../../domain/brief.js";
import { choiceOf, QUESTION_TOOL, questionsOf } from "../../domain/question.js";
import type { FullResponse, ResponseEnd, ResponseItem, ToolItem, ToolResult } from "../../domain/response.js";
import type { BriefEvent } from "../../domain/streamEvent.js";
import { describeTool, PLAN_TOOL, shorten, toolLabel } from "../../domain/toolCalls.js";
import type { TerminalBrief } from "../model.js";
import { cleanLines, graphemes, singleLine, spacedThousands } from "../presentation.js";

const MAX_TEXT = 500;

function head(text: string): string {
    let kept = "";
    for (const { segment } of graphemes.segment(text)) {
        if (kept.length + segment.length >= MAX_TEXT) break;
        kept += segment;
    }
    return kept;
}

function cut(text: string): string {
    const line = singleLine(text);
    return line.length <= MAX_TEXT ? line : `${head(line)}…`;
}

function cutInWords(text: string): string {
    const whole = text
        .split(/\r?\n|\r/)
        .map(singleLine)
        .join("\n")
        .trim();
    if (whole.length <= MAX_TEXT) return whole;
    const start = head(whole);
    const end = Math.max(start.lastIndexOf(" "), start.lastIndexOf("\n"));
    const kept = (end > 0 ? start.slice(0, end) : start).trimEnd();
    return `${kept}\n… and ${spacedThousands(whole.length - kept.length)} more characters: read it in the session`;
}

function headline({ agentId, tool, input }: Request): string {
    const call = singleLine(tool) === "" ? "a request" : toolLabel(tool, describeTool(tool, input).title);
    return agentId ? `a subagent asks: ${call}` : call;
}

function wholeInput(tool: string, input: unknown): string | undefined {
    const { title } = describeTool(tool, input);
    const texts = Object.values((input ?? {}) as Record<string, unknown>);
    const whole = texts.find(
        (text): text is string => typeof text === "string" && text !== title && shorten(text) === title,
    );
    return whole === undefined ? undefined : cutInWords(whole);
}

type Asking = Extract<TerminalBrief["needsYou"], { state: "request" }>;

function questionOf({ agentId, input }: Request, at: string): Asking | undefined {
    const [first, ...more] = questionsOf(input).map(cut);
    if (!first) return undefined;
    const text = agentId ? cut(`a subagent asks: ${first}`) : first;
    const choice = choiceOf(input);
    if (!choice) return { state: "request", text, detail: more.join("\n") || text, at };
    const detail = choice.options.map((option, index) => `${index + 1}. ${cut(option)}`).join("\n");
    return { state: "request", text, detail, takes: "number", at };
}

function needsYouOf(needsYou: BriefEvent["needsYou"], answerable: BriefEvent["answerable"]): TerminalBrief["needsYou"] {
    if (needsYou.state === "unknown" && needsYou.waitingFor !== undefined && typeof answerable === "string") {
        const { waitingFor, at } = needsYou;
        return { state: "unknown", waitingFor: cut(waitingFor), ...(at !== undefined && { at }) };
    }
    if (needsYou.state !== "request") return { state: needsYou.state };
    const { tool, input, at } = needsYou;
    if (tool === PLAN_TOOL && !needsYou.agentId) {
        const name = toolLabel(tool, tool);
        const { title } = describeTool(tool, input);
        return { state: "request", text: name, detail: title === tool ? name : cut(title), at };
    }
    if (tool === QUESTION_TOOL) {
        const question = questionOf(needsYou, at);
        if (question) return question;
    }
    const text = cut(headline(needsYou));
    return { state: "request", text, detail: wholeInput(tool, input) ?? text, at };
}

function explanationOf(
    explanation: BriefEvent["explanation"],
): Pick<TerminalBrief, "explanation" | "explanationUnknownReason"> {
    if (explanation.state === "unknown") {
        const reason = cut(explanation.reason ?? "");
        return { explanation: null, ...(reason !== "" && { explanationUnknownReason: reason }) };
    }
    const { text, at, outdated } = explanation;
    return { explanation: { text: cut(text), at, ...(outdated !== undefined && { outdatedReason: outdated }) } };
}

function resultOf(result: ToolResult): ToolResult {
    switch (result.kind) {
        case "read":
        case "found":
        case "background":
            return result;
        case "wrote":
        case "changed":
            return { ...result, path: singleLine(result.path) };
        case "ran":
        case "failed":
            return { ...result, firstLine: singleLine(result.firstLine) };
        case "first line":
            return { ...result, text: singleLine(result.text) };
        default:
            return result satisfies never;
    }
}

function callWords({ result, summary }: Pick<ToolItem, "result" | "summary">): Pick<ToolItem, "result" | "summary"> {
    return {
        ...(result && { result: resultOf(result) }),
        ...(summary !== undefined && { summary: singleLine(summary) }),
    };
}

// The agent's words keep their lines, whole: never `cut()`. A tool's strings each become one line (T12).
function itemOf(item: ResponseItem): ResponseItem {
    switch (item.type) {
        case "text":
            return { ...item, text: cleanLines(item.text) };
        case "notice":
            return { ...item, text: singleLine(item.text) };
        case "tool": {
            const { name, title, display, argument, description } = item;
            const words = { name: singleLine(name), title: singleLine(title), display: singleLine(display) };
            const described = description === undefined ? {} : { description: singleLine(description) };
            return { ...item, ...words, argument: singleLine(argument), ...described, ...callWords(item) };
        }
        case "subagent": {
            const typed = item.agentType === undefined ? {} : { agentType: singleLine(item.agentType) };
            const words = { display: singleLine(item.display), description: singleLine(item.description) };
            return { ...item, ...typed, ...words, ...callWords(item) };
        }
        default:
            return item satisfies never;
    }
}

function endOf(end: ResponseEnd): ResponseEnd {
    if (end.state === "ended at a tool call") return { ...end, call: singleLine(end.call) };
    return end.state === "failed" ? { ...end, error: singleLine(end.error) } : end;
}

function responseOf({ items, end, source, cut }: FullResponse): FullResponse {
    return { items: items.map(itemOf), end: endOf(end), source, cut };
}

export function toTerminalBrief(event: BriefEvent): TerminalBrief {
    const { task, status, latestActivity, needsYou, answerable, lastObserved, explanation, response } = event;
    return {
        task: task && { text: cut(task.text), at: task.at, from: task.from },
        status: status?.state ?? "unknown",
        ...(status === null && { statusDetail: "No Status reading yet" }),
        ...explanationOf(explanation),
        latestActivity: latestActivity && { text: cut(latestActivity.what), at: latestActivity.at },
        needsYou: needsYouOf(needsYou, answerable),
        ...(answerable !== null && { answerable }),
        lastObserved: lastObserved && { at: lastObserved.at, from: lastObserved.from },
        ...(response && { response: responseOf(response) }),
    };
}

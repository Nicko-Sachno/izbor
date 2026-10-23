import type { Block } from "../../../domain/records.js";
import type { CallResult, SubagentCounts, ToolResult } from "../../../domain/response.js";
import { fieldsOf, isObject, isString, lineCount } from "../../../domain/text.js";

type Fields = Record<string, unknown>;

const LINE_BREAK = /\r?\n|\r/;

/** The tools whose call starts a subagent. */
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Task"];

/** How each tool's PostToolUse `tool_response`, its output as the SDK types it (`sdk-tools.d.ts`), gives its result,
 *  read with the call's input. Grep and Glob are read from `GrepOutput` and `GlobOutput` alone: the bundled Claude Code
 *  holds them back while its embedded search tools are on (`EMBEDDED_SEARCH_TOOLS`), and searches then run as Bash. */
const RESPONSE_READERS: Readonly<Record<string, (response: Fields, input: Fields) => CallResult | undefined>> = {
    Read: ({ file }) => ifCount(fieldsOf(file).numLines, (lines) => ({ kind: "read", lines })),
    Write: wroteOf,
    Edit: editedOf,
    Grep: ({ numFiles }) => ifCount(numFiles, (files) => ({ kind: "found", files })),
    Glob: ({ numFiles }) => ifCount(numFiles, (files) => ({ kind: "found", files })),
    Bash: ranOf,
    ...Object.fromEntries(SUBAGENT_TOOLS.map((name) => [name, subagentOf])),
};

/** A PostToolUse hook's `tool_response` read into the call's result; undefined when it holds none Izbor reads, such as
 *  another tool's, whose result the transcript's first line gives. Never throws. */
export function readToolResponse(name: string, input: unknown, response: unknown): CallResult | undefined {
    const reader = Object.hasOwn(RESPONSE_READERS, name) ? RESPONSE_READERS[name] : undefined;
    return isObject(response) ? reader?.(response, fieldsOf(input)) : undefined;
}

/** A Write gives its lines and path; one over a file (`update`) also the lines its patch added and removed. */
function wroteOf({ type, filePath, content, structuredPatch }: Fields): ToolResult | undefined {
    if ((type !== "create" && type !== "update") || !isString(filePath) || !isString(content)) return undefined;
    const patch = type === "update" ? patchCounts(structuredPatch) : undefined;
    return { kind: "wrote", lines: lineCount(content), path: filePath, created: type === "create", ...patch };
}

/** An Edit gives the lines its patch added and removed; one whose `old_string` is empty creates a file, so it wrote. */
function editedOf({ filePath, newString, structuredPatch }: Fields, { old_string }: Fields): ToolResult | undefined {
    if (!isString(filePath)) return undefined;
    if (old_string === "")
        return isString(newString)
            ? { kind: "wrote", lines: lineCount(newString), path: filePath, created: true }
            : undefined;
    const patch = patchCounts(structuredPatch);
    return patch && { kind: "changed", ...patch, path: filePath };
}

/** What a call that left its work running in the background gives, whatever its result's words. */
const BACKGROUND: ToolResult = { kind: "background" };

/** A command that ended with exit 0 reads by its first output line. One sent to the background has printed nothing
 *  yet, and its `backgroundTaskId` says so. */
function ranOf({ stdout, stderr, backgroundTaskId }: Fields): ToolResult | undefined {
    if (isString(backgroundTaskId)) return BACKGROUND;
    if (!isString(stdout)) return undefined;
    const firstLine = firstLineOf(stdout) ?? (isString(stderr) ? firstLineOf(stderr) : undefined);
    return { kind: "ran", exitCode: 0, firstLine: firstLine ?? "" };
}

/** A subagent's counts; one started in the background (`async_launched`) returns at once with none. */
function subagentOf({
    status,
    totalToolUseCount: toolUses,
    totalDurationMs: durationMs,
}: Fields): CallResult | undefined {
    if (status === ASYNC_LAUNCHED) return BACKGROUND;
    return isCount(toolUses) && isCount(durationMs) ? { kind: "subagent", toolUses, durationMs } : undefined;
}

/** The lines a `structuredPatch` added and removed; undefined for none or an empty one, as when no diff was made. */
function patchCounts(patch: unknown): { added: number; removed: number } | undefined {
    if (!Array.isArray(patch) || patch.length === 0) return undefined;
    const lines = patch.flatMap((hunk) => {
        const { lines } = fieldsOf(hunk);
        return Array.isArray(lines) ? lines.filter(isString) : [];
    });
    const starting = (mark: string) => lines.filter((line) => line.startsWith(mark)).length;
    return { added: starting("+"), removed: starting("-") };
}

/** The first line of a command's failure as the agent writes it. */
const EXIT_CODE = /^Exit code (-?\d+)$/;

/** The wrapper the agent puts round a failure in the transcript. */
const TOOL_USE_ERROR = /<\/?tool_use_error>/g;

/** A failure's words, PostToolUseFailure's `error` or a failed result's text, read into its result: `Exit code N`
 *  gives the exit code, and the first line after it that holds text the first error line, because an empty line often
 *  stands between them; any other failure gives its first line. Undefined for a failure with no words. */
export function readFailure(error: unknown): Extract<ToolResult, { kind: "failed" }> | undefined {
    if (!isString(error)) return undefined;
    const [first = "", ...rest] = error.replace(TOOL_USE_ERROR, "").split(LINE_BREAK);
    const exit = EXIT_CODE.exec(first.trim());
    const firstLine = firstLineOf(exit ? rest : [first, ...rest]);
    if (exit) return { kind: "failed", exitCode: Number(exit[1]), firstLine: firstLine ?? "" };
    return firstLine === undefined ? undefined : { kind: "failed", firstLine };
}

/** The status of a subagent's result when it was started in the background. */
const ASYNC_LAUNCHED = "async_launched";

/** The first line of a result that left its work running in the background, for the model to read: a subagent started
 *  there, or a command sent there at its start, with Ctrl-B, at its timeout or for a message that came while it ran
 *  (the program text of Claude Code 2.1.305). */
const LAUNCHED =
    /^(?:Async agent launched successfully\.|Command (?:running in background|was manually backgrounded by user) with ID:|Command (?:did not complete within its \d+s timeout and )?was moved to the background \(ID:)/;

/** A subagent's result ends with this trailer, which gives its tool uses and time. */
const USAGE = /<usage>[^<]*?\btool_uses: (\d+)[^<]*?\bduration_ms: (\d+)[^<]*<\/usage>/;

type ResultFields = Pick<Extract<Block, { type: "toolResult" }>, "firstLine" | "exitCode" | "counts" | "background">;

/** A transcript `tool_result`'s content read into the neutral fields the full response reads when no hook told the
 *  result: its first line that holds text, or a failure's exit code and first error line, a subagent's counts from
 *  the `<usage>` trailer of its last text, and whether it says the work runs on in the background. */
export function readResultContent(content: unknown, failed: boolean): ResultFields {
    const texts = Array.isArray(content) ? content.flatMap(textOf) : isString(content) ? [content] : [];
    const failure = failed ? readFailure(texts[0]) : undefined;
    const firstLine = failed ? failure?.firstLine : firstLineOf(texts[0] ?? "");
    if (!failed && firstLine !== undefined && LAUNCHED.test(firstLine)) return { background: true };
    const counts = Array.isArray(content) ? usageOf(texts.at(-1)) : undefined;
    return {
        ...(firstLine !== undefined && { firstLine }),
        ...(failure?.exitCode !== undefined && { exitCode: failure.exitCode }),
        ...(counts && { counts }),
    };
}

function usageOf(text = ""): SubagentCounts | undefined {
    const usage = USAGE.exec(text);
    return usage ? { toolUses: Number(usage[1]), durationMs: Number(usage[2]) } : undefined;
}

/** The first line that holds text, without the spaces after it. */
function firstLineOf(text: string | readonly string[]): string | undefined {
    const lines = typeof text === "string" ? text.split(LINE_BREAK) : text;
    return lines.find((line) => line.trim() !== "")?.trimEnd();
}

const textOf = (block: unknown): string[] => {
    const { type, text } = fieldsOf(block);
    return type === "text" && isString(text) ? [text] : [];
};

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const ifCount = (value: unknown, result: (count: number) => ToolResult): ToolResult | undefined =>
    isCount(value) ? result(value) : undefined;

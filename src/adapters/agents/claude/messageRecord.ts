import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block, MessageRecord, Usage } from "../../../domain/records.js";
import { fieldsOf, isString } from "../../../domain/text.js";
import { describeTool, mainArgument } from "../../../domain/toolCalls.js";
import { readResultContent, SUBAGENT_TOOLS } from "./toolResult.js";

/** The origin Claude Code gives the prompt it writes itself when background work ends. */
const NOTIFICATION_ORIGIN = "task-notification";

/** A task notification's words in the full response. */
const BACKGROUND_TASK_FINISHED = "background task finished";

/** The model Claude Code names on a message it writes in the model's place, such as an API error. */
const SYNTHETIC_MODEL = "<synthetic>";

/** The text of the message Claude Code writes in the model's place where no reply was asked for. */
const NO_REPLY = "No response requested.";

/** The stop reason of a message that ended the model's turn. */
const END_TURN = "end_turn";

/** The lines Claude Code writes when the user interrupts a reply: while the model wrote, or at a tool call. */
const INTERRUPTS = new Map<string, "reply" | "tool use">([
    ["[Request interrupted by user]", "reply"],
    ["[Request interrupted by user for tool use]", "tool use"],
]);

export function toMessageRecord(sessionMessage: SessionMessage, agentId: string | null): MessageRecord {
    const message = (sessionMessage.message ?? {}) as ApiMessage;
    const { timestamp, origin } = sessionMessage as { timestamp?: unknown; origin?: ApiOrigin };
    const usage = toUsage(message.usage);
    const submittedBy = toOrigin(origin);
    const blocks = blocksOf(message.content, submittedBy);
    const synthetic = message.model === SYNTHETIC_MODEL ? syntheticOf(blocks) : undefined;

    return {
        kind: "message",
        id: sessionMessage.uuid,
        sessionId: sessionMessage.session_id,
        agentId,
        parentToolCallId: sessionMessage.parent_tool_use_id,
        timestamp: typeof timestamp === "string" ? timestamp : null,
        role: sessionMessage.type === "assistant" ? "assistant" : "user",
        ...(submittedBy && { origin: submittedBy }),
        ...(typeof message.model === "string" && { model: message.model }),
        ...(synthetic && { synthetic }),
        ...(message.stop_reason === END_TURN && { endedTurn: true }),
        ...(usage && { usage }),
        blocks,
    };
}

/** A message Claude Code wrote in the model's place: the stand-in where no reply was asked for, or else an error. */
const syntheticOf = (blocks: Block[]): MessageRecord["synthetic"] =>
    blocks.length === 1 && blocks[0]?.type === "text" && blocks[0].text === NO_REPLY ? "no reply" : "error";

/** The record's blocks; a task notification's are followed by a notice of it. */
function blocksOf(content: unknown, origin: MessageRecord["origin"]): Block[] {
    const blocks = toBlocks(content);
    return origin?.kind === NOTIFICATION_ORIGIN
        ? [...blocks, { type: "notice", text: BACKGROUND_TASK_FINISHED }]
        : blocks;
}

function toBlocks(content: unknown): Block[] {
    if (typeof content === "string") {
        return [toText(content)];
    }
    if (content === undefined || content === null) {
        return [];
    }
    if (!Array.isArray(content)) {
        return [{ type: "other", originalType: typeof content, raw: content }];
    }

    return content.flatMap(toBlock);
}

function toBlock(block: ApiBlock): Block[] {
    switch (block.type) {
        case "text":
            return [toText(String(block.text))];
        case "thinking":
            return block.thinking ? [{ type: "thinking", text: String(block.thinking) }] : [];
        case "tool_use":
            return [toToolCall(String(block.id), String(block.name), block.input)];
        case "tool_result":
            return [
                {
                    type: "toolResult",
                    toolCallId: String(block.tool_use_id),
                    status: block.is_error ? "failed" : "completed",
                    rawOutput: block.content,
                    ...readResultContent(block.content, Boolean(block.is_error)),
                },
            ];
        default:
            return [{ type: "other", originalType: block.type, raw: block }];
    }
}

/** A text block, with the mark of an interrupt line. */
function toText(text: string): Block {
    const interrupt = INTERRUPTS.get(text);
    return { type: "text", text, ...(interrupt && { interrupt }) };
}

const MCP = "mcp__";

/** How Claude Code names a call in its own rows, where that differs from the tool's name. */
const DISPLAY_NAMES = new Map([
    ["Edit", "Update"],
    ["Grep", "Search"],
    ["Glob", "Search"],
    ["Agent", "Task"],
]);

/** A call, with the neutral fields the full response reads: its display name, its whole main argument (an MCP tool's
 *  first string input), its description, and whether it starts a subagent. */
function toToolCall(toolCallId: string, name: string, input: unknown): Block {
    const fields = fieldsOf(input);
    const { description, subagent_type: agentType } = fields;
    const argument = name.startsWith(MCP) ? Object.values(fields).find(isString) : mainArgument(name, input);
    return {
        type: "toolCall",
        toolCallId,
        name,
        rawInput: input,
        ...describeTool(name, input),
        display: displayOf(name, fields),
        argument: argument ?? "",
        ...(isString(description) && description !== "" && { description }),
        ...(SUBAGENT_TOOLS.includes(name) && { subagent: isString(agentType) ? { agentType } : {} }),
    };
}

/** Update for an Edit, or Create when its `old_string` is empty; `server · tool` for `mcp__server__tool`. */
function displayOf(name: string, input: Record<string, unknown>): string {
    if (name === "Edit" && input.old_string === "") return "Create";
    if (!name.startsWith(MCP)) return DISPLAY_NAMES.get(name) ?? name;
    const [server, ...tool] = name.slice(MCP.length).split("__");
    return tool.length === 0 ? name : `${server} · ${tool.join("__")}`;
}

function toUsage(usage: ApiMessage["usage"]): Usage | undefined {
    if (!usage) {
        return undefined;
    }

    return {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens !== undefined && { cacheRead: usage.cache_read_input_tokens }),
        ...(usage.cache_creation_input_tokens !== undefined && { cacheWrite: usage.cache_creation_input_tokens }),
    };
}

function toOrigin(origin: ApiOrigin | undefined): MessageRecord["origin"] {
    if (typeof origin?.kind !== "string") {
        return undefined;
    }

    const { kind, name, asUser } = origin;
    return {
        kind,
        ...(typeof name === "string" && { name }),
        ...(typeof asUser === "boolean" && { asUser }),
    };
}

type ApiBlock = { type: string; [key: string]: unknown };

type ApiMessage = {
    content?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
};

type ApiOrigin = { kind?: unknown; name?: unknown; asUser?: unknown };

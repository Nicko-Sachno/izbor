import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Block, MessageRecord, Usage } from "../../../domain/records.js";
import { describeTool } from "../../../domain/toolCalls.js";

export function toMessageRecord(sessionMessage: SessionMessage, agentId: string | null): MessageRecord {
    const message = (sessionMessage.message ?? {}) as ApiMessage;
    const { timestamp, origin } = sessionMessage as { timestamp?: unknown; origin?: ApiOrigin };
    const usage = toUsage(message.usage);
    const submittedBy = toOrigin(origin);

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
        ...(usage && { usage }),
        blocks: toBlocks(message.content),
    };
}

function toBlocks(content: unknown): Block[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
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
            return [{ type: "text", text: String(block.text) }];
        case "thinking":
            return block.thinking ? [{ type: "thinking", text: String(block.thinking) }] : [];
        case "tool_use":
            return [
                {
                    type: "toolCall",
                    toolCallId: String(block.id),
                    name: String(block.name),
                    rawInput: block.input,
                    ...describeTool(String(block.name), block.input),
                },
            ];
        case "tool_result":
            return [
                {
                    type: "toolResult",
                    toolCallId: String(block.tool_use_id),
                    status: block.is_error ? "failed" : "completed",
                    rawOutput: block.content,
                },
            ];
        default:
            return [{ type: "other", originalType: block.type, raw: block }];
    }
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
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
};

type ApiOrigin = { kind?: unknown; name?: unknown; asUser?: unknown };

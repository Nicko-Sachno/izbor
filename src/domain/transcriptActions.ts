import { SAID_NO_WITH_WORDS } from "./answer.js";
import { bySubagent, type MessageAction, type NeedsYou, PROMPT_SUBMITTED } from "./brief.js";
import { IZBOR_PLUGIN } from "./prompt.js";
import { dismissedInWords, endedInWords, QUESTION_TOOL, questionsOf } from "./question.js";
import type { Block, MessageRecord } from "./records.js";
import { toolLabel } from "./toolCalls.js";

export function waitedAt(log: NeedsYou[], at: string): boolean | null {
    const then = log.findLast((needsYou) => needsYou.at === undefined || Date.parse(needsYou.at) <= Date.parse(at));
    return then?.at === undefined ? null : then.state !== "nothing";
}

const ENDED_BY_USER = "The user doesn't want to proceed with this tool use.";

export const isEndedByUser = (rawOutput: unknown) =>
    typeof rawOutput === "string" && rawOutput.startsWith(ENDED_BY_USER);

export const isNoInIzbor = (rawOutput: unknown) =>
    typeof rawOutput === "string" && rawOutput.startsWith(SAID_NO_WITH_WORDS);

function endedByUserInWords(label: string, waited: boolean | null): string {
    const how = waited === null ? "rejected or interrupted" : waited ? "rejected" : "interrupted";
    return `${how} by the user: ${label}`;
}

const REPLY_INTERRUPTED = "[Request interrupted by user]";

type ToolCall = { label: string; questions?: string[] };

export type ToolCalls = Map<string, ToolCall>;

type Shown = { what: string | null; call?: [string, ToolCall] };

function actionOf(
    role: MessageRecord["role"],
    block: Block,
    callOf: (toolCallId: string) => ToolCall | undefined,
    waited: () => boolean | null,
): Shown {
    switch (block.type) {
        case "toolCall": {
            const { toolCallId, name, title, rawInput } = block;
            const label = toolLabel(name, title);
            const call = { label, ...(name === QUESTION_TOOL && { questions: questionsOf(rawInput) }) };
            return { what: `started ${label}`, call: [toolCallId, call] };
        }
        case "toolResult": {
            const { label = "a tool call", questions } = callOf(block.toolCallId) ?? {};
            if (block.status !== "failed")
                return { what: questions ? endedInWords(block.rawOutput) : `finished ${label}` };
            if (isNoInIzbor(block.rawOutput))
                return {
                    what: questions
                        ? dismissedInWords(questions, { inIzbor: true })
                        : `rejected by the user in Izbor: ${label}`,
                };
            if (!isEndedByUser(block.rawOutput)) return { what: `failed ${label}` };
            return { what: questions ? dismissedInWords(questions) : endedByUserInWords(label, waited()) };
        }
        case "text":
            if (role === "assistant") return { what: `Claude wrote: ${block.text}` };
            return { what: block.text === REPLY_INTERRUPTED ? "reply interrupted by the user" : null };
        default:
            return { what: null };
    }
}

const HUMAN = "human";

const PLUGIN = "plugin";

export const isUsersPrompt = (origin: MessageRecord["origin"]): boolean =>
    origin?.kind === HUMAN || (origin?.kind === PLUGIN && origin.name === IZBOR_PLUGIN && origin.asUser === true);

export function actionsOf(
    records: MessageRecord[],
    calls: ToolCalls,
    reported: ReadonlySet<string>,
    needsYouLog: NeedsYou[],
): { actions: MessageAction[]; calls: ToolCalls } {
    const actions: MessageAction[] = [];
    const met: [string, ToolCall][] = [];
    const callOf = (id: string) => met.findLast(([metId]) => metId === id)?.[1] ?? calls.get(id);
    for (const { role, agentId, origin, timestamp: at, blocks } of records) {
        for (const block of blocks) {
            if (block.type === "toolResult" && reported.has(block.toolCallId)) continue;
            const prompt = !agentId && isUsersPrompt(origin) && block.type === "text" ? block.text : undefined;
            const waited = () => (at ? waitedAt(needsYouLog, at) : null);
            const { what, call }: Shown =
                prompt === undefined ? actionOf(role, block, callOf, waited) : { what: PROMPT_SUBMITTED };
            if (call) met.push(call);
            if (!what || !at) continue;
            actions.push({
                what: bySubagent(agentId, what),
                at,
                wrote: role === "assistant" && block.type === "text",
                ...(prompt !== undefined && { prompt }),
            });
        }
    }
    return { actions, calls: new Map([...calls, ...met]) };
}

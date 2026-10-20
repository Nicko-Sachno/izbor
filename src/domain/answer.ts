import type { NeedsYou, Request } from "./brief.js";
import { choiceOf, QUESTION_TOOL } from "./question.js";

export const HOLD_LIMIT_MS = 60 * 60 * 1000;

export type NotAnswerable =
    | "not an acting project"
    | "not running when it asked"
    | "expired"
    | "Izbor restarted"
    | "subagent wait over"
    | "answered"
    | "plan approval not supported"
    | "question not supported";

export type Answerable = true | NotAnswerable | null;

export const NOT_ANSWERABLE: Record<NotAnswerable, string> = {
    "not an acting project": "Answer it in the session: this project has no plugin.",
    "not running when it asked": "Answer it in the session: Izbor was not running when it asked.",
    expired: "Answer it in the session: Izbor is no longer holding this request.",
    "Izbor restarted": "Answer it in the session: Izbor is no longer holding this request.",
    "subagent wait over": "A subagent asks: answer it in the session.",
    answered: "That request has an answer already.",
    "plan approval not supported": "Answer it in the session: Izbor does not answer plan approvals.",
    "question not supported": "Answer it in the session: Izbor answers only one question with one choice.",
};

export const REQUEST_CHANGED = "That request is over or changed: check the Brief.";

const TYPE_YES_OR_NO = "Type yes, no, or no and your words.";

const TYPE_A_NUMBER = "Type an option's number, or no.";

const SAID_NO = "The user said no in Izbor.";

export const SAID_NO_WITH_WORDS = "The user said no in Izbor: ";

export type HookDecision =
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string; interrupt?: true };

export type SentText = "yes" | "no" | `no ${string}` | `${number}`;

export type Fitted = { sent: SentText; decision: HookDecision };

function parse(typed: string): { answer: "yes" } | { answer: "no"; words: string } | undefined {
    const text = typed.trim();
    if (text.toLowerCase() === "yes") return { answer: "yes" };
    const no = /^no(?:$|(?:\s+,?|,)\s*)(.*)$/is.exec(text);
    return no ? { answer: "no", words: no[1] ?? "" } : undefined;
}

function pick(request: Request, typed: string): Fitted | undefined {
    const choice = choiceOf(request.input);
    const text = typed.trim();
    const label = /^0*[1-9]\d*$/.test(text) ? choice?.options[Number(text) - 1] : undefined;
    if (!choice || label === undefined) return undefined;
    const updatedInput = { ...(request.input as Record<string, unknown>), answers: { [choice.question]: label } };
    return { sent: `${Number(text)}`, decision: { behavior: "allow", updatedInput } };
}

export function fit(request: Request, typed: string): Fitted | { bad: string } {
    const isQuestion = request.tool === QUESTION_TOOL;
    const parsed = parse(typed);
    if (!parsed || (parsed.answer === "yes" && isQuestion))
        return (isQuestion && pick(request, typed)) || { bad: isQuestion ? TYPE_A_NUMBER : TYPE_YES_OR_NO };
    if (parsed.answer === "yes") return { sent: "yes", decision: { behavior: "allow" } };
    const { words } = parsed;
    if (words) return { sent: `no ${words}`, decision: { behavior: "deny", message: SAID_NO_WITH_WORDS + words } };
    return { sent: "no", decision: { behavior: "deny", message: SAID_NO, interrupt: true } };
}

export const takesAnAnswer = ({ tool, input }: Request) => tool !== QUESTION_TOOL || choiceOf(input) !== undefined;

export const isFor = (held: Request, needsYou: NeedsYou) =>
    needsYou.state === "request" &&
    held.agentId === needsYou.agentId &&
    held.tool === needsYou.tool &&
    JSON.stringify(held.input) === JSON.stringify(needsYou.input);

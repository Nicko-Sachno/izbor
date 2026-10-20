import {
    type Answerable,
    type Fitted,
    fit,
    HOLD_LIMIT_MS,
    type HookDecision,
    isFor,
    type NotAnswerable,
    takesAnAnswer,
} from "../domain/answer.js";
import {
    type HookEvidence,
    mainThreadRequest,
    type NeedsYou,
    needsYouAfterHook,
    type Request,
    waitsForUser,
} from "../domain/brief.js";
import { PLAN_TOOL } from "../domain/toolCalls.js";
import type { Wait } from "./ports.js";

type AnswerHoldsDeps = {
    wait: Wait;
    onChange: () => void;
    acting: () => boolean | undefined;
};

export type AnswerOutcome =
    | Fitted
    | { refused: "request_changed" }
    | { refused: "already_answered" }
    | { refused: "not_answerable"; answerable: Exclude<NotAnswerable, "answered"> }
    | { refused: "bad_answer"; message: string };

type Hold = {
    request: Request;
    reply: (decision: HookDecision | null) => void;
    done: AbortController;
    shown: boolean;
};

export type AnswerHolds = {
    hold(request: Request, reply: (decision: HookDecision | null) => void, closed: AbortSignal): void;
    answerable(): Answerable;
    keep(evidence: HookEvidence): void;
    hook(evidence: HookEvidence): void;
    kept(): HookEvidence | undefined;
    keepsNothing(): boolean;
    needsYouChanged(next: NeedsYou): void;
    answer(at: string, typed: string): AnswerOutcome;
    letGo(): void;
};

export function createAnswerHolds({ wait, onChange, acting }: AnswerHoldsDeps): AnswerHolds {
    let held: Hold | undefined;
    let letGo: Request | undefined;
    let answeredAt: string | undefined;
    let current: NeedsYou = { state: "unknown" };
    let kept: HookEvidence | undefined;

    function end(hold: Hold, decision: HookDecision | null): void {
        hold.done.abort();
        if (!decision) letGo = hold.request;
        hold.reply(decision);
    }

    function release(hold: Hold, decision: HookDecision | null): void {
        if (held !== hold) return;
        held = undefined;
        end(hold, decision);
        onChange();
    }

    function answerable(): Answerable {
        if (!waitsForUser(current)) return null;
        if (current.state === "request") {
            if (current.tool === PLAN_TOOL) return "plan approval not supported";
            if (!takesAnAnswer(current)) return "question not supported";
            if (held && isFor(held.request, current)) return true;
            if (answeredAt === current.at) return "answered";
        }
        if (acting() === false) return "not an acting project";
        if (current.state === "unknown") return "not running when it asked";
        if (current.agentId !== null) return "subagent wait over";
        return letGo && isFor(letGo, current) ? "expired" : "not running when it asked";
    }

    function keep(evidence: HookEvidence): void {
        if (mainThreadRequest(evidence) && acting()) kept = evidence;
    }

    function needsYouChanged(next: NeedsYou): void {
        current = next;
        if (next.state === "nothing") kept = undefined;
        if (!held) return;
        held.shown ||= isFor(held.request, current);
        if (!held.shown || current.state !== "nothing") return;
        const hold = held;
        held = undefined;
        end(hold, null);
    }

    return {
        hold(request: Request, reply: (decision: HookDecision | null) => void, closed: AbortSignal): void {
            if (request.tool === PLAN_TOOL || !takesAnAnswer(request) || closed.aborted) return reply(null);
            const hold: Hold = {
                request,
                reply,
                done: new AbortController(),
                shown: isFor(request, current),
            };
            const replaced = held;
            held = hold;
            if (replaced) end(replaced, null);
            closed.addEventListener("abort", () => release(hold, null), { once: true });
            void wait(HOLD_LIMIT_MS, hold.done.signal).then(() => release(hold, null));
            onChange();
        },
        answerable,
        keep,
        hook(evidence: HookEvidence): void {
            keep(evidence);
            needsYouChanged(needsYouAfterHook(current, evidence));
        },
        kept: () => kept,
        keepsNothing: () => held === undefined && kept === undefined,
        needsYouChanged,
        answer(at: string, typed: string): AnswerOutcome {
            if (current.at !== at) return { refused: "request_changed" };
            const can = answerable();
            if (can === null) return { refused: "request_changed" };
            if (can === "answered") return { refused: "already_answered" };
            if (can !== true) return { refused: "not_answerable", answerable: can };
            if (current.state !== "request") return { refused: "request_changed" };
            const fitted = fit(current, typed);
            if ("bad" in fitted) return { refused: "bad_answer", message: fitted.bad };
            answeredAt = current.at;
            release(held!, fitted.decision);
            return fitted;
        },
        letGo(): void {
            if (held) release(held, null);
        },
    };
}

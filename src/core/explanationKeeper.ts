import { isDeepStrictEqual } from "node:util";
import type { Action, Brief, Explanation } from "../domain/brief.js";
import { toExplanationText, toSummaryRequest } from "../domain/explanation.js";
import type { Summarize } from "../domain/summary.js";
import type { Now, Wait } from "./ports.js";
import type { TakeTurn } from "./summaryTurns.js";

type ExplanationKeeperDeps = {
    summarize: Summarize;
    takeTurn: TakeTurn;
    evidence: () => { brief: Brief; recent: Action[] };
    onExplanation: (explanation: Explanation) => void;
    onNoExplanation: (reason: string) => void;
    onError: (err: unknown) => void;
    wait: Wait;
    now: Now;
};

type ExplanationKeeper = {
    wake(soon: boolean): void;
    hurry(): void;
    stop(): Promise<void>;
};

const EXPLAIN_AFTER_MS = 5000;

const EXPLAIN_SOON_MS = 1000;

const TIME_LIMIT_MS = 30_000;

export function createExplanationKeeper({
    summarize,
    takeTurn,
    evidence,
    onExplanation,
    onNoExplanation,
    onError,
    wait,
    now,
}: ExplanationKeeperDeps): ExplanationKeeper {
    let due: { soon: boolean; end: AbortController } | null = null;
    let running: Promise<void> | null = null;
    let wokenAgain: boolean | null = null;
    let explained: ReturnType<typeof toSummaryRequest> | null = null;
    const cancel = new AbortController();
    const stopped = cancel.signal;

    async function explain(): Promise<void> {
        const endTurn = await takeTurn(stopped);
        if (!endTurn) return;
        try {
            await explainWithTurn();
        } finally {
            endTurn();
        }
    }

    async function explainWithTurn(): Promise<void> {
        wokenAgain = null;
        if (stopped.aborted) return;
        const { brief, recent } = evidence();
        const asked = toSummaryRequest(brief, recent);
        if (isDeepStrictEqual(asked, explained)) return;
        const { request, covers } = asked;
        const at = now().toISOString();
        const limit = new AbortController();
        void wait(TIME_LIMIT_MS, limit.signal).then(() => limit.abort());
        const result = await summarize(request, AbortSignal.any([stopped, limit.signal])).finally(() => limit.abort());
        if (stopped.aborted) return;
        if (result.outcome === "cancelled")
            return onNoExplanation(`the summarizer gave no answer in ${TIME_LIMIT_MS / 1000} s`);
        if (result.outcome === "unavailable") return onNoExplanation(result.reason);
        const text = toExplanationText(result.text);
        if (!text) return onNoExplanation("the summarizer wrote nothing");
        explained = asked;
        onExplanation({ text, at, covers });
    }

    function start(): void {
        running = explain()
            .catch(onError)
            .then(() => {
                running = null;
                const again = wokenAgain;
                wokenAgain = null;
                if (again !== null) wake(again);
            });
    }

    function wake(soon: boolean): void {
        if (running) wokenAgain = soon || wokenAgain === true;
        if (running || stopped.aborted || (due && (due.soon || !soon))) return;
        due?.end.abort();
        const mine = (due = { soon, end: new AbortController() });
        void wait(soon ? EXPLAIN_SOON_MS : EXPLAIN_AFTER_MS, AbortSignal.any([stopped, mine.end.signal])).then(() => {
            if (due !== mine || stopped.aborted) return;
            due = null;
            start();
        });
    }

    return {
        wake,
        hurry: () => due?.end.abort(),
        async stop(): Promise<void> {
            cancel.abort();
            await running;
        },
    };
}

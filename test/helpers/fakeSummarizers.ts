import { setImmediate as settle } from "node:timers/promises";
import type { Summarize, SummaryRequest, SummaryResult } from "../../src/domain/summary.js";

export function heldSummarizer() {
    const requests: { request: SummaryRequest; signal: AbortSignal; answer: (result: SummaryResult) => void }[] = [];
    const summarize: Summarize = (request, signal) =>
        new Promise((answer) => {
            requests.push({ request, signal, answer });
            signal.addEventListener("abort", () => answer({ outcome: "cancelled" }), { once: true });
        });
    return {
        requests,
        summarize,
        async answer(result: SummaryResult) {
            requests.at(-1)!.answer(result);
            await settle();
        },
        summary(text: string) {
            return this.answer({ outcome: "summary", text });
        },
    };
}

export function lingeringSummarizer() {
    let signal: AbortSignal | undefined;
    let end = (_result: SummaryResult) => {};
    const summarize: Summarize = (_request, cancel) => {
        signal = cancel;
        return new Promise((resolve) => (end = resolve));
    };
    return {
        summarize,
        signal: () => signal,
        processGone: (result: SummaryResult = { outcome: "cancelled" }) => end(result),
    };
}

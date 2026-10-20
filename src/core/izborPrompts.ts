import { type NeedsYou, waitsForUser } from "../domain/brief.js";
import { badPromptText, COLLECT_LIMIT_MS, type IzborPrompt, POLL_LIMIT_MS, REPORT_LIMIT_MS } from "../domain/prompt.js";
import type { Wait } from "./ports.js";

type IzborPromptsDeps = {
    wait: Wait;
    newId: () => string;
    needsYouOf: (sessionId: string) => NeedsYou | undefined;
    folderOf: (sessionId: string) => string | undefined;
    isActing: (folder: string) => boolean;
};

export type SendPromptOutcome =
    | { collected: string }
    | { refused: "bad_prompt"; message: string }
    | { refused: "not_watched" }
    | { refused: "not_acting"; folder: string }
    | { refused: "request_pending" }
    | { refused: "stopping" }
    | { refused: "prompt_pending" }
    | { refused: "no_plugin" };

type Waiting = { prompt: IzborPrompt; end: (outcome: SendPromptOutcome) => void };

type Poll = { end: (prompt: IzborPrompt | undefined) => void };

type IzborPrompts = {
    send(sessionId: string, text: string): Promise<SendPromptOutcome>;
    next(sessionId: string, closedBy: AbortSignal): Promise<IzborPrompt | undefined>;
    report(promptId: string): IzborPrompt | undefined;
    sessionOver(sessionId: string): void;
    close(): void;
};

function listOf<T>(map: Map<string, T[]>, id: string): T[] {
    let list = map.get(id);
    if (!list) map.set(id, (list = []));
    return list;
}

function takeOut<T>(map: Map<string, T[]>, id: string, item: T): boolean {
    const list = map.get(id);
    const at = list?.indexOf(item) ?? -1;
    if (!list || at === -1) return false;
    list.splice(at, 1);
    if (list.length === 0) map.delete(id);
    return true;
}

export function createIzborPrompts({ wait, newId, needsYouOf, folderOf, isActing }: IzborPromptsDeps): IzborPrompts {
    const waiting = new Map<string, Waiting>();
    const polls = new Map<string, Poll[]>();
    const collected = new Map<string, { prompt: IzborPrompt; forgotten: AbortController }>();
    let closed = false;

    function collect(prompt: IzborPrompt): void {
        const forgotten = new AbortController();
        collected.set(prompt.promptId, { prompt, forgotten });
        void wait(REPORT_LIMIT_MS, forgotten.signal).then(() => {
            if (collected.get(prompt.promptId)?.forgotten === forgotten) collected.delete(prompt.promptId);
        });
    }

    function forget(promptId: string): IzborPrompt | undefined {
        const found = collected.get(promptId);
        if (!found) return undefined;
        collected.delete(promptId);
        found.forgotten.abort();
        return found.prompt;
    }

    function pending(id: string): boolean {
        return waiting.has(id) || [...collected.values()].some(({ prompt }) => prompt.sessionId === id);
    }

    return {
        async send(sessionId: string, text: string): Promise<SendPromptOutcome> {
            const message = badPromptText(text);
            if (message) return { refused: "bad_prompt", message };
            const needsYou = needsYouOf(sessionId);
            if (!needsYou) return { refused: "not_watched" };
            const folder = folderOf(sessionId);
            if (folder !== undefined && !isActing(folder)) return { refused: "not_acting", folder };
            if (waitsForUser(needsYou)) return { refused: "request_pending" };
            if (closed) return { refused: "stopping" };
            if (pending(sessionId)) return { refused: "prompt_pending" };
            const prompt: IzborPrompt = { promptId: newId(), sessionId, text };
            const poll = polls.get(sessionId)?.[0];
            if (poll) {
                collect(prompt);
                poll.end(prompt);
                return { collected: prompt.promptId };
            }
            const done = new AbortController();
            let outcome: SendPromptOutcome | undefined;
            const entry: Waiting = {
                prompt,
                end(what) {
                    outcome = what;
                    done.abort();
                },
            };
            waiting.set(sessionId, entry);
            await wait(COLLECT_LIMIT_MS, done.signal);
            if (outcome) return outcome;
            if (waiting.get(sessionId) === entry) waiting.delete(sessionId);
            return { refused: "no_plugin" };
        },
        next(sessionId: string, closedBy: AbortSignal): Promise<IzborPrompt | undefined> {
            if (closed || closedBy.aborted) return Promise.resolve(undefined);
            const entry = waiting.get(sessionId);
            if (entry) {
                waiting.delete(sessionId);
                collect(entry.prompt);
                entry.end({ collected: entry.prompt.promptId });
                return Promise.resolve(entry.prompt);
            }
            return new Promise((give) => {
                const done = new AbortController();
                const poll: Poll = {
                    end(prompt) {
                        if (!takeOut(polls, sessionId, poll)) return;
                        done.abort();
                        give(prompt);
                    },
                };
                listOf(polls, sessionId).push(poll);
                const nothing = () => poll.end(undefined);
                closedBy.addEventListener("abort", nothing, { once: true });
                void wait(POLL_LIMIT_MS, done.signal).then(nothing);
            });
        },
        report: forget,
        sessionOver(sessionId: string): void {
            for (const { prompt } of [...collected.values()])
                if (prompt.sessionId === sessionId) forget(prompt.promptId);
        },
        close(): void {
            closed = true;
            for (const list of [...polls.values()]) for (const poll of [...list]) poll.end(undefined);
            const entries = [...waiting.values()];
            waiting.clear();
            for (const entry of entries) entry.end({ refused: "stopping" });
        },
    };
}

import type { AgentProvider, ListedSession, Now, Wait } from "./ports.js";

export type StatusAnswer = {
    askedAt: string;
    at: string;
} & ({ sessions: ListedSession[] } | { error: string });

export type StatusQueryDeps = {
    queryStatus: AgentProvider["queryStatus"];
    wait: Wait;
    now: Now;
};

export type StatusQuery = {
    subscribe(onAnswer: (answer: StatusAnswer) => void): () => void;
    query(): Promise<void>;
    stop(): Promise<void>;
};

const QUERY_EVERY_MS = 2000;

export function createStatusQuery({ queryStatus, wait, now }: StatusQueryDeps): StatusQuery {
    const subscribers = new Set<(answer: StatusAnswer) => void>();
    const cancel = new AbortController();
    const stopped = cancel.signal;
    let running: Promise<void> | null = null;
    let next: (() => void)[] | null = null;
    let timedWait = new AbortController();

    async function runOnce(): Promise<void> {
        const askedAt = now().toISOString();
        const result = await queryStatus(stopped).then(
            (sessions) => ({ sessions }),
            (err) => ({ error: String(err) }),
        );
        if (stopped.aborted) return;
        const answer = { askedAt, at: now().toISOString(), ...result };
        for (const onAnswer of subscribers) onAnswer(answer);
    }

    function run(queries: (() => void)[]): void {
        timedWait.abort();
        running = (async () => {
            let answering: (() => void)[] | null = queries;
            while (answering) {
                if (!stopped.aborted) await runOnce();
                for (const resolve of answering) resolve();
                [answering, next] = [next, null];
            }
            running = null;
            if (subscribers.size > 0 && !stopped.aborted) scheduleNext();
        })();
    }

    function scheduleNext(): void {
        const cut = AbortSignal.any([stopped, (timedWait = new AbortController()).signal]);
        void wait(QUERY_EVERY_MS, cut).then(() => {
            if (!cut.aborted && subscribers.size > 0) run([]);
        });
    }

    function subscribe(onAnswer: (answer: StatusAnswer) => void): () => void {
        subscribers.add(onAnswer);
        return () => void subscribers.delete(onAnswer);
    }

    function query(): Promise<void> {
        return new Promise((resolve) => {
            if (stopped.aborted) resolve();
            else if (running) (next ??= []).push(resolve);
            else run([resolve]);
        });
    }

    async function stop(): Promise<void> {
        cancel.abort(new Error("Izbor stopped"));
        await running;
    }

    return { subscribe, query, stop };
}

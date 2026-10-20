import type { Wait } from "./ports.js";

type SchedulerDeps = {
    wait: Wait;
    onError: (err: unknown) => void;
};

type Work = () => Promise<void>;

export type Scheduler = {
    enqueue(work: Work): Promise<void>;
    coalesce(work: Work): Promise<void>;
    coalesceAfter(ms: number, work: Work): void;
    stop(): Promise<void>;
};

const COALESCE_MS = 300;

export function createScheduler({ wait, onError }: SchedulerDeps): Scheduler {
    let queue: Promise<void> = Promise.resolve();
    let pending: Promise<void> | null = null;
    const cancel = new AbortController();
    const stopped = cancel.signal;

    function enqueue(work: Work): Promise<void> {
        queue = queue.then(work).catch(onError);
        return queue;
    }

    function coalesce(work: Work): Promise<void> {
        pending ??= wait(COALESCE_MS, stopped).then(() => {
            pending = null;
            if (stopped.aborted) return;
            return enqueue(work);
        });
        return pending;
    }

    function coalesceAfter(ms: number, work: Work): void {
        void wait(ms, stopped).then(() => coalesce(work));
    }

    async function stop(): Promise<void> {
        cancel.abort();
        await queue;
    }

    return { enqueue, coalesce, coalesceAfter, stop };
}

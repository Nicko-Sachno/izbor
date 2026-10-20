import type { StopWhy } from "../domain/records.js";
import type { StreamEvent } from "../domain/streamEvent.js";
import type { Wait } from "./ports.js";

export type Listener = {
    send(event: StreamEvent): void;
    end(): void;
    gone: Promise<unknown>;
};

type Watch = {
    start(): Promise<void>;
    snapshot(): [StreamEvent, StreamEvent];
    stop(why: StopWhy): Promise<void>;
};

type WatchTrackerDeps<W extends Watch> = {
    createWatch: (sessionId: string, emit: (event: StreamEvent) => void) => W;
    wait: Wait;
    onError: (error: unknown) => void;
};

export type WatchTracker<W extends Watch = Watch> = {
    tuneIn(sessionId: string, listener: Listener): void;
    tuneInAll(stream: Listener): void;
    stop(sessionId: string): boolean;
    stopAll(why: "deleted" | "izbor stopping"): { stopped: string[]; done: Promise<void> };
    close(): void;
    closing(): boolean;
    list(): { sessionId: string; listeners: number }[];
    watchOf(sessionId: string): Omit<W, keyof Watch> | undefined;
    watches(): Omit<W, keyof Watch>[];
};

const CATCH_UP_MS = 5000;

const NO_LISTENER_MS = 30_000;

const stopped = (sessionId: string, why: StopWhy): StreamEvent => ({
    type: "session",
    sessionId,
    state: "stopped",
    why,
});

type WatchedId<W> = {
    sessionId: string;
    watch: W | undefined;
    listeners: Set<Listener>;
    state: "waiting" | "catching up" | "live" | "stopping";
    catchUp?: AbortController;
    noListener?: AbortController;
};

export function createWatchTracker<W extends Watch>({
    createWatch,
    wait,
    onError,
}: WatchTrackerDeps<W>): WatchTracker<W> {
    const watched = new Map<string, WatchedId<W>>();
    const stops = new Map<string, Promise<void>>();
    const everySessionStreams = new Set<Listener>();
    let closed = false;

    function sendSnapshot(watch: W, listeners: Iterable<Listener>): void {
        const [session, brief] = watch.snapshot();
        for (const listener of listeners) {
            listener.send(session);
            listener.send(brief);
        }
    }

    function addWatchedId(sessionId: string): WatchedId<W> {
        const id: WatchedId<W> = { sessionId, watch: undefined, listeners: new Set(), state: "waiting" };
        watched.set(sessionId, id);
        const stop = stops.get(sessionId);
        if (stop) void stop.then(() => startWatch(id));
        else startWatch(id);
        return id;
    }

    function startWatch(id: WatchedId<W>): void {
        if (id.state !== "waiting" || closed) return;
        id.state = "catching up";
        const watch = createWatch(id.sessionId, (event) => {
            if (id.state !== "live") return;
            for (const listener of id.listeners) listener.send(event);
            for (const stream of everySessionStreams) stream.send(event);
        });
        id.watch = watch;
        const caughtUp = watch.start().catch(onError);
        void Promise.race([caughtUp, wait(CATCH_UP_MS, (id.catchUp = new AbortController()).signal)]).then(() => {
            id.catchUp?.abort();
            if (id.state !== "catching up") return;
            id.state = "live";
            sendSnapshot(watch, [...id.listeners, ...everySessionStreams]);
        });
    }

    function endStream(listener: Listener, sessionId: string, why: StopWhy): void {
        listener.send(stopped(sessionId, why));
        listener.end();
    }

    function endStreams(id: WatchedId<W>, why: StopWhy): void {
        for (const timer of [id.catchUp, id.noListener]) timer?.abort();
        for (const listener of id.listeners) endStream(listener, id.sessionId, why);
        id.listeners.clear();
        if (id.state !== "live") return;
        for (const stream of everySessionStreams) stream.send(stopped(id.sessionId, why));
    }

    function stopWatch(id: WatchedId<W>, why: StopWhy): void {
        const { sessionId } = id;
        watched.delete(sessionId);
        endStreams(id, why);
        id.state = "stopping";
        if (!id.watch) return;
        const stop: Promise<void> = id.watch
            .stop(why)
            .catch(onError)
            .then(() => {
                if (stops.get(sessionId) === stop) stops.delete(sessionId);
            });
        stops.set(sessionId, stop);
    }

    function tuneIn(sessionId: string, listener: Listener): void {
        if (closed) return endStream(listener, sessionId, "izbor stopping");
        const id = watched.get(sessionId) ?? addWatchedId(sessionId);
        id.noListener?.abort();
        if (id.state === "live") sendSnapshot(id.watch!, [listener]);
        id.listeners.add(listener);
        const leave = () => leaveFrom(id, listener);
        void listener.gone.then(leave, leave);
    }

    function tuneInAll(stream: Listener): void {
        if (closed) return stream.end();
        for (const { watch, state } of watched.values()) if (state === "live") sendSnapshot(watch!, [stream]);
        everySessionStreams.add(stream);
        const leave = () => everySessionStreams.delete(stream);
        void stream.gone.then(leave, leave);
    }

    function leaveFrom(id: WatchedId<W>, listener: Listener): void {
        id.listeners.delete(listener);
        if (id.listeners.size > 0 || id.state === "stopping" || closed) return;
        id.noListener?.abort();
        const left = (id.noListener = new AbortController());
        void wait(NO_LISTENER_MS, left.signal).then(() => {
            if (!left.signal.aborted) stopWatch(id, "no listener");
        });
    }

    function list(): { sessionId: string; listeners: number }[] {
        return [...watched.values()].flatMap(({ sessionId, watch, listeners }) =>
            watch ? [{ sessionId, listeners: listeners.size }] : [],
        );
    }

    function watchOf(sessionId: string): Omit<W, keyof Watch> | undefined {
        return watched.get(sessionId)?.watch;
    }

    function watches(): Omit<W, keyof Watch>[] {
        return [...watched.values()].flatMap(({ watch }) => (watch ? [watch] : []));
    }

    function stop(sessionId: string): boolean {
        const id = watched.get(sessionId);
        if (id) stopWatch(id, "deleted");
        return id !== undefined;
    }

    function stopAll(why: "deleted" | "izbor stopping"): { stopped: string[]; done: Promise<void> } {
        const ids = [...watched.values()];
        for (const id of ids) stopWatch(id, why);
        return { stopped: ids.map(({ sessionId }) => sessionId), done: Promise.all(stops.values()).then(() => {}) };
    }

    function close(): void {
        closed = true;
        for (const id of watched.values()) endStreams(id, "izbor stopping");
        for (const stream of everySessionStreams) stream.end();
        everySessionStreams.clear();
    }

    function closing(): boolean {
        return closed;
    }

    return { tuneIn, tuneInAll, stop, stopAll, close, closing, list, watchOf, watches };
}

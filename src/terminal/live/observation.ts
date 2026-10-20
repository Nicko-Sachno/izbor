import type { StreamEvent } from "../../domain/streamEvent.js";
import { GAP_SHOWN_MS, type Connection, type Observation, type TerminalBrief } from "../model.js";
import { toTerminalBrief } from "./brief.js";

type StreamAway = { away: "not running" | "stopping" };

export type ReadStream = (
    id: string,
    on: { open(): void; event(event: StreamEvent): void },
    leave: AbortSignal,
) => Promise<"ended" | "broken" | "left" | StreamAway | { refused: number; message: string }>;

export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

const LADDER_MS = [1_000, 2_000, 4_000, 10_000] as const;

function briefChanged(before: TerminalBrief | null, after: TerminalBrief): boolean {
    return before === null || before.status !== after.status || before.explanation?.text !== after.explanation?.text;
}

export interface ObservationHandle {
    row(): Observation;
    again(): void;
    retryNow(): void;
    leave(): void;
}

export function createObservation({
    id,
    read,
    wait,
    now,
    changed,
    away,
}: {
    id: string;
    read: ReadStream;
    wait: Wait;
    now: () => Date;
    changed(row: Observation): void;
    away(away: StreamAway): void;
}): ObservationHandle {
    let row: Observation = { id, brief: null, connection: { state: "connecting" } };
    let generation = 0;
    let stream = new AbortController();
    let step = 0;
    let gapFrom: string | undefined;
    let izborAway = false;
    let retryPending = false;

    function set(next: Observation) {
        row = next;
        changed(row);
    }

    function stopGap(why: "deleted" | "izbor stopping") {
        gapFrom ??= now().toISOString();
        if (why === "izbor stopping") izborAway = true;
    }

    function izborWasAway(end: StreamAway) {
        izborAway = true;
        away(end);
    }

    function gapAfter(last: Observation["gap"], brief: TerminalBrief): Observation["gap"] {
        const from = gapFrom;
        const wasAway = izborAway;
        gapFrom = undefined;
        izborAway = false;
        const to = now().toISOString();
        if (from !== undefined && (wasAway || Date.parse(to) - Date.parse(from) > GAP_SHOWN_MS)) return { from, to };
        return briefChanged(row.brief, brief) ? undefined : last;
    }

    function retryLater(at: Date, connection: (retryAt: string) => Connection, signal: AbortSignal) {
        const mine = generation;
        const ms = LADDER_MS[step]!;
        step = Math.min(step + 1, LADDER_MS.length - 1);
        retryPending = true;
        set({ ...row, connection: connection(new Date(at.getTime() + ms).toISOString()) });
        void wait(ms, signal).then(() => {
            if (mine === generation && !signal.aborted) retry();
        });
    }

    function retry() {
        set({ ...row, connection: { state: "connecting" } });
        connect();
    }

    function connect() {
        retryPending = false;
        stream.abort();
        const mine = ++generation;
        const leave = (stream = new AbortController());
        const current = () => mine === generation && !leave.signal.aborted;
        let since: string | undefined;
        let stopped = false;
        void read(
            id,
            {
                open() {
                    if (current()) set({ ...row, connection: { state: "catching up" } });
                },
                event(event) {
                    if (stopped || !current()) return;
                    if (event.type === "session" && event.state === "stopped") {
                        if (event.why === "no listener") return;
                        stopped = true;
                        stopGap(event.why);
                        set({ ...row, connection: { state: "stopped", why: event.why } });
                        return;
                    }
                    if (event.type !== "brief") return;
                    since ??= now().toISOString();
                    const brief = toTerminalBrief(event);
                    step = 0;
                    const { gap: last, ...kept } = row;
                    const gap = gapAfter(last, brief);
                    set({ ...kept, ...(gap && { gap }), brief, since, connection: { state: "live" } });
                },
            },
            leave.signal,
        ).then((end) => {
            if (stopped || end === "left" || !current()) return;
            const at = now();
            if (end === "ended" || end === "broken") {
                const since = (gapFrom ??= at.toISOString());
                retryLater(at, (retryAt) => ({ state: "disconnected", since, retryAt }), leave.signal);
            } else if ("away" in end) {
                retryLater(at, (retryAt) => ({ state: "izbor away", reason: end.away, retryAt }), leave.signal);
                izborWasAway(end);
            } else {
                set({ ...row, connection: { state: "refused", status: end.refused, message: end.message } });
            }
        });
    }

    connect();

    return {
        row: () => row,
        again() {
            step = 0;
            set({ id, brief: row.brief, ...(row.gap && { gap: row.gap }), connection: { state: "connecting" } });
            connect();
        },
        retryNow() {
            if (retryPending) retry();
        },
        leave() {
            generation++;
            retryPending = false;
            stream.abort();
        },
    };
}

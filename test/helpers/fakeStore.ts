import type { FieldAnswer, ObservationSource, Snapshot } from "../../src/terminal/model.js";

type FakeSend = { id: string; at?: string; text: string };

export function createFakeStore(
    initial: Partial<Snapshot> = {},
    send: FieldAnswer | "sent" = { news: "The fake store sends nothing." },
) {
    let snapshot: Snapshot = {
        izbor: { state: "up", address: "127.0.0.1:4319" },
        list: { state: "loading" },
        observations: [],
        ...initial,
    };
    const callbacks = new Set<() => void>();
    const sends: FakeSend[] = [];
    const lifetime = new AbortController();
    function set(next: Partial<Snapshot>) {
        if (lifetime.signal.aborted) return;
        snapshot = { ...snapshot, ...next };
        for (const changed of [...callbacks]) changed();
    }
    return {
        set,
        sends,
        getSnapshot: () => snapshot,
        onChange(changed) {
            const callback = () => changed();
            callbacks.add(callback);
            return () => callbacks.delete(callback);
        },
        observe(id) {
            if (lifetime.signal.aborted || snapshot.observations.some((row) => row.id === id)) return "already";
            set({ observations: [...snapshot.observations, { id, brief: null, connection: { state: "connecting" } }] });
            return "added";
        },
        leave(id) {
            set({ observations: snapshot.observations.filter((row) => row.id !== id) });
        },
        async refreshSessions() {
            lifetime.signal.throwIfAborted();
            return snapshot.list;
        },
        async answer(id, { at, answer }) {
            lifetime.signal.throwIfAborted();
            sends.push({ id, at, text: answer });
            if (send !== "sent") return send;
            const sent = { at, text: answer.trim(), sentAt: new Date().toISOString() };
            set({ observations: snapshot.observations.map((row) => (row.id === id ? { ...row, sent } : row)) });
            return { sent: sent.text };
        },
        async prompt(id, text) {
            lifetime.signal.throwIfAborted();
            sends.push({ id, text });
            if (send !== "sent") return send;
            const sentAt = new Date().toISOString();
            set({
                observations: snapshot.observations.map((row) => {
                    if (row.id !== id) return row;
                    const state = row.brief?.status === "busy" ? "queued" : "sent";
                    return { ...row, prompt: { id: `prompt-${sends.length}`, text, sentAt, state } };
                }),
            });
            return { sent: text };
        },
        dispose() {
            lifetime.abort();
            callbacks.clear();
        },
    } satisfies ObservationSource & { set(next: Partial<Snapshot>): void; sends: FakeSend[] };
}

import type { IzborAnswer, IzborClient } from "../../adapters/izbor/client.js";
import { createListeners } from "../listeners.js";
import { duringLifetime } from "../lifetime.js";
import { hasStream, type ObservedSource, type IzborState, type Snapshot } from "../model.js";
import type { RunningSessions } from "./agents.js";
import { createObservation, type ObservationHandle, type Wait } from "./observation.js";

export const TICK_MS = 5_000;

function izborStateOf(answer: IzborAnswer): IzborState["state"] {
    if ("up" in answer) return "up";
    if ("foreign" in answer) return "foreign";
    return answer.away;
}

export function createLiveSource({
    client,
    running,
    address,
    wait,
    now,
}: {
    client: Pick<IzborClient, "getIzbor" | "readStream">;
    running: RunningSessions;
    address: string;
    wait: Wait;
    now: () => Date;
}): ObservedSource {
    let snapshot: Snapshot = { izbor: { state: "up", address }, list: { state: "loading" }, observations: [] };
    const rows = new Map<string, ObservationHandle>();
    const listeners = createListeners();
    let disposed = false;
    const atDispose = new AbortController();
    let nextTick = now().getTime() + TICK_MS;
    let probing: Promise<void> | undefined;
    let outdated = false;

    function change(next: Partial<Snapshot>) {
        snapshot = { ...snapshot, ...next };
        listeners.emit();
    }

    const changeRows = () => change({ observations: [...rows.values()].map((observation) => observation.row()) });

    async function refresh() {
        const list = await running.refresh();
        if (!disposed && list !== snapshot.list) change({ list });
        return list;
    }

    function probe(): Promise<void> {
        return (probing ??= (async () => {
            try {
                do {
                    outdated = false;
                    const answer = await client.getIzbor(atDispose.signal);
                    if (disposed) return;
                    if (!outdated) setIzbor(izborStateOf(answer));
                } while (outdated);
            } finally {
                probing = undefined;
            }
        })());
    }

    function setIzbor(state: IzborState["state"]) {
        if (state === snapshot.izbor.state) return;
        const back = state === "up";
        change({ izbor: { state, address } });
        if (back) for (const observation of rows.values()) observation.retryNow();
    }

    function izborMayBeAway({ stopping = false } = {}) {
        if (disposed) return;
        if (probing) outdated = true;
        if (snapshot.izbor.state !== "up") return;
        if (stopping) change({ izbor: { state: "stopping", address } });
        void probe();
    }

    async function tick() {
        if (snapshot.izbor.state !== "up" || !rows.size) await probe();
        if (!disposed && snapshot.izbor.state === "up") await refresh();
    }

    async function tickForever() {
        while (!disposed) {
            nextTick = now().getTime() + TICK_MS;
            await tick();
            if (disposed) return;
            await wait(Math.max(0, nextTick - now().getTime()), atDispose.signal);
        }
    }

    void tickForever();

    return {
        getSnapshot: () => snapshot,
        onChange: listeners.on,
        observe(id) {
            id = id.toLowerCase();
            if (disposed) return "already";
            const known = rows.get(id);
            if (known) {
                if (hasStream(known.row().connection)) return "already";
                known.again();
                return "again";
            }
            rows.set(
                id,
                createObservation({
                    id,
                    read: client.readStream,
                    wait,
                    now,
                    changed({ connection }) {
                        changeRows();
                        if (connection.state === "disconnected") izborMayBeAway();
                        else if (connection.state === "stopped" && connection.why === "izbor stopping")
                            izborMayBeAway({ stopping: true });
                    },
                    away: () => izborMayBeAway(),
                }),
            );
            changeRows();
            return "added";
        },
        leave(id) {
            id = id.toLowerCase();
            const observation = rows.get(id);
            if (disposed || !observation) return;
            rows.delete(id);
            observation.leave();
            changeRows();
            if (!rows.size) void refresh();
        },
        refreshSessions: () => duringLifetime(atDispose.signal, refresh),
        dispose() {
            if (disposed) return;
            disposed = true;
            atDispose.abort();
            listeners.close();
            for (const observation of rows.values()) observation.leave();
            running.dispose();
        },
    };
}

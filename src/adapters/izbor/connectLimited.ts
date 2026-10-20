import { connect } from "node:net";
import { LOOPBACK, izborAddress } from "../../domain/wire.js";

export function connectLimited(fetch: typeof globalThis.fetch, port: number, limitMs: number): typeof globalThis.fetch {
    if (limitMs === Infinity) return fetch;
    return async (url, init) => {
        if ((init?.method ?? "GET") !== "GET") return fetch(url, init);
        const stalled = new AbortController();
        const timer = setTimeout(() => stalled.abort(), limitMs);
        const probe = connect(port, LOOPBACK);
        const settled = () => {
            clearTimeout(timer);
            probe.destroy();
        };
        probe.once("connect", settled).once("error", settled);
        const signal = init?.signal ? AbortSignal.any([init.signal, stalled.signal]) : stalled.signal;
        try {
            return await fetch(url, { ...init, signal });
        } catch (err) {
            if (!stalled.signal.aborted) throw err;
            throw new TypeError(`fetch failed: no connect to ${izborAddress(port)} in ${limitMs} ms`, {
                cause: { code: "ECONNREFUSED" },
            });
        } finally {
            settled();
        }
    };
}

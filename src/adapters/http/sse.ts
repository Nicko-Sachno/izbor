import type { ServerResponse } from "node:http";
import type { Listener } from "../../core/watchTracker.js";
import type { StreamEvent } from "../../domain/streamEvent.js";

const KEEP_ALIVE_MS = 30_000;

export function openStream(res: ServerResponse): Listener {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.flushHeaders();
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
    res.once("close", () => clearInterval(keepAlive));
    return {
        send({ type, ...data }: StreamEvent) {
            res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end() {
            clearInterval(keepAlive);
            res.end();
        },
        gone: new Promise((resolve) => res.once("close", resolve)),
    };
}

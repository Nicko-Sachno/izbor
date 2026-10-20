import type { StreamEvent } from "../../domain/streamEvent.js";
import { readJson } from "../../domain/text.js";

export type StreamEnd = "ended" | "broken" | "left";

export async function readEvents(
    body: AsyncIterable<Uint8Array>,
    on: { event(event: StreamEvent): void },
    leave: AbortSignal,
    heard: () => void,
): Promise<StreamEnd> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        heard();
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let type = "";
            let data = "";
            for (const line of frame.split("\n")) {
                if (line.startsWith("event: ")) type = line.slice("event: ".length);
                else if (line.startsWith("data: ")) data = line.slice("data: ".length);
            }
            const fields = type && data ? readJson(data) : null;
            if (fields === undefined) return "broken";
            if (type && data) on.event({ type, ...(fields as object) } as StreamEvent);
            if (leave.aborted) return "left";
        }
    }
    return buffer + decoder.decode() === "" ? "ended" : "broken";
}

import type { PromptEvent } from "../../domain/streamEvent.js";
import { createListeners } from "../listeners.js";
import type { Observation, SentPrompt } from "../model.js";
import type { ReadStream } from "./observation.js";

const KEPT_REPORTS = 16;

type Kept = SentPrompt | (Omit<SentPrompt, "state" | "reason"> & { state: "over" });

export type SentPrompts = ReturnType<typeof sentPrompts>;

export function sentPrompts() {
    const sent = new Map<string, Kept>();
    const early = new Map<string, PromptEvent>();
    const listeners = createListeners();
    let disposed = false;

    function heard(session: string, mine: Kept, { state, reason }: PromptEvent): void {
        if (state === "dropped") sent.set(session, { ...mine, state, ...(reason !== undefined && { reason }) });
        else if (mine.state === "queued") sent.delete(session);
    }

    function reported(report: PromptEvent): void {
        if (disposed) return;
        const session = report.sessionId.toLowerCase();
        const mine = sent.get(session);
        if (mine?.id !== report.promptId) {
            early.set(report.promptId, report);
            if (early.size > KEPT_REPORTS) early.delete(early.keys().next().value!);
            return;
        }
        heard(session, mine, report);
        listeners.emit();
    }

    return {
        reported,
        onChange: listeners.on,
        hearing(read: ReadStream): ReadStream {
            return (id, on, leave) =>
                read(
                    id,
                    {
                        open: () => on.open(),
                        event(event) {
                            if (event.type === "prompt") reported(event);
                            on.event(event);
                        },
                    },
                    leave,
                );
        },
        collected(row: Observation, id: string, text: string, sentAt: string): void {
            if (disposed) return;
            const mine: SentPrompt = { id, text, sentAt, state: row.brief?.status === "busy" ? "queued" : "sent" };
            sent.set(row.id, mine);
            const report = early.get(id);
            early.delete(id);
            if (report) heard(row.id, mine, report);
        },
        shown(row: Observation): Observation {
            const mine = sent.get(row.id);
            if (!mine || mine.state === "over") return row;
            const { status, needsYou } = row.brief ?? {};
            const over =
                mine.state === "sent"
                    ? status === "busy" || needsYou?.state === "request"
                    : mine.state === "queued" && status !== "busy";
            if (over) sent.set(row.id, { ...mine, state: "over" });
            return over ? row : { ...row, prompt: mine };
        },
        forget(id: string): void {
            sent.delete(id);
            for (const [promptId, report] of early) if (report.sessionId.toLowerCase() === id) early.delete(promptId);
        },
        dispose() {
            disposed = true;
            listeners.close();
            sent.clear();
            early.clear();
        },
    };
}

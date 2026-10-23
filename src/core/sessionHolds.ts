import { type HookEvidence, mainThreadRequest } from "../domain/brief.js";
import { type AnswerHolds, createAnswerHolds } from "./answerHolds.js";
import type { Wait } from "./ports.js";

export type SessionHoldsDeps = {
    wait: Wait;
    isActing: (cwd: string) => boolean;
    onChange: (sessionId: string) => void;
};

type Entry = { cwd?: string; holds: AnswerHolds };

type SessionHolds = {
    of(sessionId: string): AnswerHolds;
    folder(sessionId: string, cwd: string | undefined): void;
    cwdOf(sessionId: string): string | undefined;
    hook(sessionId: string, evidence: HookEvidence, cwd: string | undefined): void;
    letGo(): void;
};

export function createSessionHolds({ wait, isActing, onChange }: SessionHoldsDeps): SessionHolds {
    const entries = new Map<string, Entry>();

    function entryOf(sessionId: string): Entry {
        let entry = entries.get(sessionId);
        if (!entry) {
            const made: Entry = {
                holds: createAnswerHolds({
                    wait,
                    onChange: () => onChange(sessionId),
                    acting: () => (made.cwd === undefined ? undefined : isActing(made.cwd)),
                }),
            };
            entry = made;
            entries.set(sessionId, entry);
        }
        return entry;
    }

    function of(sessionId: string): AnswerHolds {
        return entryOf(sessionId).holds;
    }

    function folder(sessionId: string, cwd: string | undefined): void {
        const entry = entryOf(sessionId);
        entry.cwd = cwd ?? entry.cwd;
    }

    function hook(sessionId: string, evidence: HookEvidence, cwd: string | undefined): void {
        if (!entries.has(sessionId) && !mainThreadRequest(evidence)) return;
        folder(sessionId, cwd);
        const holds = of(sessionId);
        holds.hook(evidence, cwd);
        if (holds.keepsNothing()) entries.delete(sessionId);
    }

    function letGo(): void {
        for (const { holds } of entries.values()) holds.letGo();
    }

    function cwdOf(sessionId: string): string | undefined {
        return entries.get(sessionId)?.cwd;
    }

    return { of, folder, cwdOf, hook, letGo };
}

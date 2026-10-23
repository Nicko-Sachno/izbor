import { isDeepStrictEqual } from "node:util";
import {
    type Action,
    afterExplanation,
    afterHook,
    afterMessages,
    afterNoExplanation,
    afterStatus,
    type Brief,
    type Explanation,
    type HookEvidence,
    type StatusEvidence,
    UNKNOWN_BRIEF,
} from "../domain/brief.js";
import { ofTask, withAction, withMessageActions } from "../domain/explanation.js";
import type { MessageRecord } from "../domain/records.js";
import {
    firstMemory,
    rememberFolder,
    rememberHook,
    rememberMessages,
    rememberNeedsYou,
    rememberRead,
    type TranscriptRead,
    withResponse,
} from "../domain/transcriptMemory.js";
import type { Report } from "./report.js";

type BriefKeeperDeps = {
    report: Pick<Report, "brief" | "action">;
    onMoreToExplain: (soon: boolean) => void;
};

type BriefKeeper = {
    hook(evidence: HookEvidence, cwd?: string): void;
    messages(records: MessageRecord[]): void;
    /** What a read of the transcript found; a failure or nothing may leave only the agent's last message. */
    transcriptRead(read: TranscriptRead): void;
    status(evidence: StatusEvidence): void;
    explanation(explanation: Explanation): void;
    noExplanation(reason: string): void;
    brief(): Brief;
    evidence(): { brief: Brief; recent: Action[] };
};

const isOutdated = ({ explanation }: Brief) => explanation.state === "explained" && explanation.outdated !== undefined;

export function createBriefKeeper({ report, onMoreToExplain }: BriefKeeperDeps): BriefKeeper {
    let brief: Brief = UNKNOWN_BRIEF;
    let recent: Action[] = [];
    let memory = firstMemory(brief.needsYou);

    function change(next: Brief): void {
        if (isDeepStrictEqual(next, brief)) return;
        if (!isDeepStrictEqual(next.needsYou, brief.needsYou)) memory = rememberNeedsYou(memory, next.needsYou);
        const news = !isDeepStrictEqual({ ...next, lastObserved: brief.lastObserved }, brief);
        brief = next;
        if (news) report.brief(brief);
    }

    function changeByEvidence(next: Brief): void {
        const removed = brief.explanation.state === "explained" && next.explanation.state !== "explained";
        const outdated = !isOutdated(brief) && isOutdated(next);
        change(next);
        if (removed || outdated) onMoreToExplain(outdated);
    }

    function observe(latest: Action[], task: Brief["task"]): void {
        const next = ofTask(latest, task);
        if (isDeepStrictEqual(next, recent)) return;
        const before = new Set(recent);
        recent = next;
        for (const action of next) if (!before.has(action)) report.action(action);
        onMoreToExplain(false);
    }

    return {
        hook(evidence: HookEvidence, cwd?: string): void {
            memory = rememberHook(memory, evidence, cwd);
            const next = withResponse(afterHook(brief, evidence), memory);
            if (evidence.action !== null)
                observe(withAction(recent, { what: evidence.action, at: evidence.at }), next.task);
            changeByEvidence(next);
        },
        messages(records: MessageRecord[]): void {
            const { actions } = ({ memory } = rememberMessages(memory, records));
            const next = withResponse(afterMessages(brief, actions), memory);
            observe(withMessageActions(recent, actions), next.task);
            changeByEvidence(next);
        },
        transcriptRead(read: TranscriptRead): void {
            const { source } = memory;
            memory = rememberRead(memory, read);
            if (memory.source !== source) change(withResponse(brief, memory));
        },
        status({ folder, ...evidence }: StatusEvidence): void {
            changeByEvidence(withResponse(afterStatus(brief, evidence), (memory = rememberFolder(memory, folder))));
        },
        explanation(explanation: Explanation): void {
            change(afterExplanation(brief, explanation));
            if (isOutdated(brief)) onMoreToExplain(true);
        },
        noExplanation(reason: string): void {
            change(afterNoExplanation(brief, reason));
        },
        brief: () => brief,
        evidence: () => ({ brief, recent }),
    };
}

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
    type NeedsYou,
    type StatusEvidence,
    UNKNOWN_BRIEF,
} from "../domain/brief.js";
import { ofTask, withAction, withMessageActions } from "../domain/explanation.js";
import type { MessageRecord } from "../domain/records.js";
import { actionsOf, type ToolCalls } from "../domain/transcriptActions.js";
import type { Report } from "./report.js";

type BriefKeeperDeps = {
    report: Pick<Report, "brief" | "action">;
    onMoreToExplain: (soon: boolean) => void;
};

type BriefKeeper = {
    hook(evidence: HookEvidence): void;
    messages(records: MessageRecord[]): void;
    status(evidence: StatusEvidence): void;
    explanation(explanation: Explanation): void;
    noExplanation(reason: string): void;
    brief(): Brief;
    evidence(): { brief: Brief; recent: Action[] };
};

const NEEDS_YOU_CHANGES = 50;

export function createBriefKeeper({ report, onMoreToExplain }: BriefKeeperDeps): BriefKeeper {
    let brief: Brief = UNKNOWN_BRIEF;
    let recent: Action[] = [];
    let calls: ToolCalls = new Map();
    const reported = new Set<string>();
    let needsYouLog: NeedsYou[] = [brief.needsYou];

    function change(next: Brief): void {
        if (isDeepStrictEqual(next, brief)) return;
        if (!isDeepStrictEqual(next.needsYou, brief.needsYou))
            needsYouLog = [...needsYouLog, next.needsYou].slice(-NEEDS_YOU_CHANGES);
        const news = !isDeepStrictEqual({ ...next, lastObserved: brief.lastObserved }, brief);
        brief = next;
        if (news) report.brief(brief);
    }

    const isOutdated = ({ explanation }: Brief) =>
        explanation.state === "explained" && explanation.outdated !== undefined;

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
        hook(evidence: HookEvidence): void {
            if (evidence.endedCall) reported.add(evidence.endedCall);
            const next = afterHook(brief, evidence);
            if (evidence.action !== null)
                observe(withAction(recent, { what: evidence.action, at: evidence.at }), next.task);
            changeByEvidence(next);
        },
        messages(records: MessageRecord[]): void {
            const { actions } = ({ calls } = actionsOf(records, calls, reported, needsYouLog));
            const next = afterMessages(brief, actions);
            observe(withMessageActions(recent, actions), next.task);
            changeByEvidence(next);
        },
        status(evidence: StatusEvidence): void {
            changeByEvidence(afterStatus(brief, evidence));
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

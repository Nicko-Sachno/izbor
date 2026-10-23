import { createHookFiles } from "./adapters/files/hookFiles.js";
import { createSessionFiles } from "./adapters/files/sessionFiles.js";
import type { AnswerHolds, AnswerOutcome } from "./core/answerHolds.js";
import { createBriefKeeper } from "./core/briefKeeper.js";
import { createExplanationKeeper } from "./core/explanationKeeper.js";
import type { AgentProvider, Hook, Log, Now, Wait } from "./core/ports.js";
import type { Report } from "./core/report.js";
import { createScheduler } from "./core/scheduler.js";
import { createSessionSync } from "./core/sessionSync.js";
import type { StatusQuery } from "./core/statusQuery.js";
import { createStatusWatch } from "./core/statusWatch.js";
import type { TakeTurn } from "./core/summaryTurns.js";
import type { Answerable, SentText } from "./domain/answer.js";
import type { NeedsYou, Request } from "./domain/brief.js";
import type { IzborEvent, StopWhy } from "./domain/records.js";
import { toolLabel, describeTool } from "./domain/toolCalls.js";
import {
    type BriefEvent,
    type ListedState,
    type PromptEvent,
    type SessionEvent,
    sessionStateAfter,
    type StreamEvent,
    toBriefEvent,
} from "./domain/streamEvent.js";
import type { Summarize } from "./domain/summary.js";
import { oneLine } from "./domain/text.js";

export type WatchDeps = {
    sessionId: string;
    readThreads: AgentProvider["readThreads"];
    sessionsDir: string;
    statusQuery: Pick<StatusQuery, "subscribe" | "query">;
    summarize: Summarize;
    takeTurn: TakeTurn;
    log: Log;
    emit: (event: StreamEvent) => void;
    holds: Pick<AnswerHolds, "answerable" | "needsYouChanged" | "kept" | "keep" | "answer">;
    onNotListed: () => void;
    wait: Wait;
    now: Now;
};

export type SessionWatch = {
    start(): Promise<void>;
    snapshot(): [SessionEvent, BriefEvent];
    handleHook(hook: Hook): Promise<void>;
    holdsChanged(): void;
    needsYou(): NeedsYou;
    answer(at: string, typed: string): AnswerOutcome;
    promptReported(report: Omit<PromptEvent, "type" | "sessionId">): void;
    handleRejected(body: string): Promise<void>;
    stop(why: StopWhy): Promise<void>;
};

const DELAYED_SYNC_MS = [1000, 3000];

const shrunkText = (got: number, written: number, keepFile: boolean) =>
    `SDK returned ${got} messages, already wrote ${written}; ${keepFile ? "keeping the file" : "rebuilding"}`;

/** The Izbor log's line for an answer sent at `sentAt` to the request Needs you showed at `at`. */
function sentAnswerText(sessionId: string, sent: SentText, request: Request, at: string, sentAt: Date): string {
    const label = toolLabel(request.tool, describeTool(request.tool, request.input).title);
    return `${sessionId} sent ${oneLine(sent)} at ${sentAt.toISOString()}: ${label} (Needs you at ${at})`;
}

type WatchReportDeps = Pick<WatchDeps, "sessionId" | "emit" | "onNotListed"> & {
    holds: Pick<AnswerHolds, "needsYouChanged">;
    log: Log;
    /** Sends the keeper's brief on the stream. */
    emitBrief: () => void;
};

type WatchReport = { report: Report; sessionEvent(): SessionEvent };

/** The Report of one watch, and the session event of its Listed state. A reported brief moves the Listed state with
 *  its Status, then reaches the holds and the stream; an action goes on the stream; a shrunk read and an error go to
 *  the Izbor log. */
function watchReport({ sessionId, emit, onNotListed, holds, log, emitBrief }: WatchReportDeps): WatchReport {
    let sessionState: ListedState = "watching";
    const sessionEvent = (): SessionEvent => ({ type: "session", sessionId, state: sessionState });
    const report: Report = {
        brief(brief) {
            const next = sessionStateAfter(sessionState, brief.status);
            if (next !== sessionState) {
                sessionState = next;
                emit(sessionEvent());
                if (next === "not listed") onNotListed();
            }
            holds.needsYouChanged(brief.needsYou);
            emitBrief();
        },
        action: ({ what, at }) => emit({ type: "action", sessionId, at, what }),
        shrunk: (agentId, got, written, keepFile) => log("warning", shrunkText(got, written, keepFile), { agentId }),
        error: (err) => log("error", String(err)),
    };
    return { report, sessionEvent };
}

export function createWatch({
    sessionId,
    readThreads,
    sessionsDir,
    statusQuery,
    summarize,
    takeTurn,
    log: izborLog,
    emit,
    holds,
    onNotListed,
    wait,
    now,
}: WatchDeps): SessionWatch {
    const log: Log = (level, text, fields) => izborLog(level, text, { sessionId, ...fields });
    let sentAnswerable: Answerable = null;
    const answerableNow = () => holds.answerable();
    const briefEvent = (): BriefEvent => toBriefEvent(sessionId, briefKeeper.brief(), answerableNow());
    function emitBrief(): void {
        const event = briefEvent();
        sentAnswerable = event.answerable;
        emit(event);
    }
    function emitBriefIfAnswerableChanged(): void {
        if (answerableNow() !== sentAnswerable) emitBrief();
    }
    const { report, sessionEvent } = watchReport({ sessionId, emit, onNotListed, holds, log, emitBrief });
    const briefKeeper = createBriefKeeper({ report, onMoreToExplain: (soon) => explanationKeeper.wake(soon) });
    const explanationKeeper = createExplanationKeeper({
        summarize,
        takeTurn,
        evidence: briefKeeper.evidence,
        onExplanation: briefKeeper.explanation,
        onNoExplanation: briefKeeper.noExplanation,
        onError: report.error,
        wait,
        now,
    });
    const hookFile = createHookFiles(sessionsDir);
    const saveIzborRecord = (what: IzborEvent, at = now()) =>
        hookFile.append({ kind: "izbor", sessionId, timestamp: at.toISOString(), ...what }).catch(report.error);
    const sessionSync = createSessionSync({
        sessionId,
        readThreads,
        files: createSessionFiles(sessionsDir),
        report,
        onMessages: briefKeeper.messages,
        onRead: briefKeeper.transcriptRead,
        onSyncError: (err) => saveIzborRecord({ event: "sync_error", error: String(err) }),
    });
    const scheduler = createScheduler({ wait, onError: report.error });
    const statusWatch = createStatusWatch({
        sessionId,
        statusQuery,
        hookFile,
        onError: report.error,
        onReading: briefKeeper.status,
        onChange: () => void scheduler.coalesce(() => sessionSync.sync()),
    });
    async function handleHook({ cwd, ended, event, evidence, record }: Hook): Promise<void> {
        const hookWrite = hookFile.append(record).catch(report.error);
        briefKeeper.hook(evidence, cwd);
        statusWatch.query();
        const sync = () => sessionSync.sync(cwd);
        const eventWrite = event && scheduler.enqueue(() => sessionSync.appendEvent(event, cwd));
        if (ended) for (const ms of DELAYED_SYNC_MS) scheduler.coalesceAfter(ms, sync);
        await Promise.all([hookWrite, eventWrite, scheduler.coalesce(sync)]);
    }
    let stopped = false;
    return {
        async start(): Promise<void> {
            const startedAt = now();
            const kept = holds.kept();
            if (kept) briefKeeper.hook(kept.evidence, kept.cwd);
            const saved = saveIzborRecord({ event: "started" }, startedAt);
            log("info", `watching ${sessionId}`);
            await Promise.all([saved, statusWatch.query(), scheduler.enqueue(() => sessionSync.sync())]);
            explanationKeeper.hurry();
        },
        snapshot(): [SessionEvent, BriefEvent] {
            return [sessionEvent(), briefEvent()];
        },
        async handleHook(hook: Hook): Promise<void> {
            if (stopped) return;
            holds.keep(hook.evidence, hook.cwd);
            const handled = handleHook(hook);
            emitBriefIfAnswerableChanged();
            await handled;
        },
        holdsChanged: emitBriefIfAnswerableChanged,
        needsYou: () => briefKeeper.brief().needsYou,
        answer(at: string, typed: string): AnswerOutcome {
            const { needsYou } = briefKeeper.brief();
            const outcome = holds.answer(at, typed);
            if ("sent" in outcome && needsYou.state === "request")
                log("info", sentAnswerText(sessionId, outcome.sent, needsYou, at, now()));
            return outcome;
        },
        promptReported(report: Omit<PromptEvent, "type" | "sessionId">): void {
            emit({ type: "prompt", sessionId, ...report });
        },
        async handleRejected(body: string): Promise<void> {
            if (stopped) return;
            await saveIzborRecord({ event: "rejected_payload", body });
        },
        async stop(why: StopWhy): Promise<void> {
            stopped = true;
            const stopping = Promise.all([statusWatch.stop(), explanationKeeper.stop()]);
            await scheduler.stop();
            await stopping;
            await saveIzborRecord({ event: "stopped", why });
            log("info", `stopped watching ${sessionId} (${why})`);
        },
    };
}

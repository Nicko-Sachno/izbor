import { randomUUID } from "node:crypto";
import type { AnswerOutcome } from "./core/answerHolds.js";
import { createIzborPrompts, type SendPromptOutcome } from "./core/izborPrompts.js";
import type { Hook, Now, IzborRoutes, Wait } from "./core/ports.js";
import { createSessionHolds, type SessionHoldsDeps } from "./core/sessionHolds.js";
import { createStatusQuery, type StatusQueryDeps } from "./core/statusQuery.js";
import { createSummaryTurns } from "./core/summaryTurns.js";
import { createWatchTracker, type WatchTracker } from "./core/watchTracker.js";
import type { HookDecision } from "./domain/answer.js";
import { mainThreadRequest } from "./domain/brief.js";
import type { PromptState } from "./domain/prompt.js";
import { oneLine } from "./domain/text.js";
import { createWatch, type SessionWatch, type WatchDeps } from "./watch.js";

const sentPromptText = (sessionId: string, promptId: string, at: Date, text: string) =>
    `${sessionId} sent prompt ${promptId} at ${at.toISOString()}: ${oneLine(text)}`;

export type Izbor = IzborRoutes & {
    tracker: WatchTracker<SessionWatch>;
    letGo(): void;
    stop(): Promise<void>;
};

type IzborDeps = Pick<WatchDeps, "readThreads" | "sessionsDir" | "summarize" | "log"> &
    Pick<SessionHoldsDeps, "isActing"> &
    Pick<StatusQueryDeps, "queryStatus"> & {
        wait: Wait;
        now: Now;
    };

export function createIzbor({ queryStatus, isActing, wait, now, ...deps }: IzborDeps): Izbor {
    const statusQuery = createStatusQuery({ queryStatus, wait, now });
    const summaryTurns = createSummaryTurns();
    const holds = createSessionHolds({
        wait,
        isActing,
        onChange: (sessionId) => tracker.watchOf(sessionId)?.holdsChanged(),
    });
    const prompts = createIzborPrompts({
        wait,
        newId: randomUUID,
        needsYouOf: (sessionId) => tracker.watchOf(sessionId)?.needsYou(),
        folderOf: holds.cwdOf,
        isActing,
    });
    const tracker = createWatchTracker({
        createWatch: (sessionId, emit) =>
            createWatch({
                ...deps,
                sessionId,
                statusQuery,
                takeTurn: summaryTurns.take,
                emit,
                holds: holds.of(sessionId),
                onNotListed: () => prompts.sessionOver(sessionId),
                wait,
                now,
            }),
        wait,
        onError: (error) => deps.log("error", String(error)),
    });
    return {
        tracker,
        async handleHook(hook: Hook): Promise<void> {
            if (hook.sessionOver) prompts.sessionOver(hook.sessionId);
            const watch = tracker.watchOf(hook.sessionId);
            if (!watch) return holds.hook(hook.sessionId, hook.evidence, hook.cwd);
            holds.folder(hook.sessionId, hook.cwd);
            await watch.handleHook(hook);
        },
        holdAnswer(hook: Hook, closed: AbortSignal): Promise<HookDecision | null> {
            const request = mainThreadRequest(hook.evidence);
            if (!request) return Promise.resolve(null);
            holds.folder(hook.sessionId, hook.cwd);
            return new Promise((reply) => holds.of(hook.sessionId).hold(request, reply, closed));
        },
        answer(sessionId: string, at: string, typed: string): AnswerOutcome | undefined {
            return tracker.watchOf(sessionId)?.answer(at, typed);
        },
        prompts: {
            async send(sessionId: string, text: string): Promise<SendPromptOutcome> {
                const outcome = await prompts.send(sessionId, text);
                if ("collected" in outcome) {
                    deps.log("info", sentPromptText(sessionId, outcome.collected, now(), text));
                }
                return outcome;
            },
            next: prompts.next,
            report(promptId: string, state: PromptState, reason?: string): boolean {
                const prompt = prompts.report(promptId);
                if (!prompt) return false;
                const why = reason === undefined ? "" : `: ${oneLine(reason)}`;
                deps.log("info", `${prompt.sessionId} prompt ${promptId} ${state} at ${now().toISOString()}${why}`);
                tracker
                    .watchOf(prompt.sessionId)
                    ?.promptReported({ promptId, text: prompt.text, state, ...(reason !== undefined && { reason }) });
                return true;
            },
        },
        letGo(): void {
            holds.letGo();
            prompts.close();
        },
        async handleRejected(body: string): Promise<void> {
            deps.log("error", `answered 400 to a payload without a session id: ${oneLine(body)}`);
            await Promise.all(tracker.watches().map((watch) => watch.handleRejected(body)));
        },
        async stop(): Promise<void> {
            await Promise.all([tracker.stopAll("izbor stopping").done, statusQuery.stop()]);
        },
    };
}

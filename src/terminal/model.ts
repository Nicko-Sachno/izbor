import type { NotAnswerable } from "../domain/answer.js";

export type TerminalBrief = {
    task: { text: string; at: string; from: "hook" | "transcript" } | null;
    status: "busy" | "waiting" | "idle" | "unknown" | "not listed";
    statusDetail?: string;
    explanation: { text: string; at: string; outdatedReason?: string } | null;
    explanationUnknownReason?: string;
    latestActivity: { text: string; at: string } | null;
    needsYou:
        | { state: "nothing" }
        | { state: "unknown"; reason?: string; waitingFor?: string; at?: string }
        | { state: "request"; text: string; detail: string; at?: string; takes?: "number" };
    answerable?: true | NotAnswerable;
    lastObserved: { at: string; from: "hook" | "status" } | null;
};

export function unseenWait(brief: TerminalBrief | null | undefined) {
    if (brief?.needsYou.state !== "unknown" || typeof brief.answerable !== "string") return undefined;
    const { waitingFor, at } = brief.needsYou;
    return waitingFor === undefined ? undefined : { waitingFor, at, answerable: brief.answerable };
}

export function waitStart(brief: TerminalBrief | null | undefined): string | undefined {
    return brief?.status === "waiting" && brief.needsYou.state === "request" ? brief.needsYou.at : undefined;
}

export function unknownLine({ reason, waitingFor }: Extract<TerminalBrief["needsYou"], { state: "unknown" }>): string {
    const why = reason ?? waitingFor;
    return `Unknown${why ? ` · ${why}` : ""}`;
}

export type Connection =
    | { state: "connecting" | "catching up" | "live" }
    | { state: "stopped"; why: "deleted" | "izbor stopping" }
    | { state: "disconnected"; since: string; retryAt?: string }
    | { state: "izbor away"; reason: "not running" | "stopping"; retryAt?: string }
    | { state: "refused"; status: number; message: string };

export type SentAnswer = { at: string; text: string; sentAt: string; stillWaits?: true };

export type SentPrompt = {
    id: string;
    text: string;
    sentAt: string;
    state: "sent" | "queued" | "dropped";
    reason?: string;
};

export type Observation = {
    id: string;
    brief: TerminalBrief | null;
    connection: Connection;
    gap?: { from: string; to: string };
    since?: string;
    sent?: SentAnswer;
    prompt?: SentPrompt;
};

export type RunningSession = {
    id: string;
    name: string;
    status?: string;
    waitingFor?: string;
    waitingSince?: string;
    checkout: string;
    worktree?: string;
    hooks: boolean;
    acting: boolean;
};

export type SessionList =
    | { state: "loading" }
    | { state: "listed"; sessions: readonly RunningSession[]; at: string }
    | { state: "no list"; reason: string; last: readonly RunningSession[] };

export type IzborState = { state: "up" | "stopping" | "not running" | "not answering" | "foreign"; address: string };

export type Snapshot = {
    readonly izbor: IzborState;
    readonly list: SessionList;
    readonly observations: readonly Observation[];
};

export type FieldAnswer = { news: string } | { refused: string } | { sent: string };

export type FieldMode = { mode: "answer"; at?: string; takes?: "number" } | { mode: "reply" };

export type FixedMode = FieldMode & { session: string };

export type FieldMessage = { text: string; error: boolean; session?: string };

export type FieldState = {
    text: string;
    cursor: number;
    fixed: FixedMode | null;
    message: FieldMessage | null;
    told?: readonly string[];
    behind?: readonly FieldMessage[];
};

/** Pending async operations reject with AbortError when the source is disposed. */
export interface ObservationSource {
    getSnapshot(): Snapshot;
    onChange(changed: () => void): () => void;
    observe(id: string): "added" | "again" | "already";
    leave(id: string): void;
    refreshSessions(): Promise<SessionList>;
    answer(id: string, answer: { at: string; answer: string }): Promise<FieldAnswer>;
    prompt(id: string, text: string): Promise<FieldAnswer>;
    dispose(): void;
}

export type ObservedSource = Omit<ObservationSource, "answer" | "prompt">;

export const GAP_SHOWN_MS = 30_000;

export function hasStream({ state }: Connection): boolean {
    return state === "connecting" || state === "catching up" || state === "live";
}

export function listedSessions(list: SessionList): readonly RunningSession[] {
    return list.state === "listed" ? list.sessions : list.state === "no list" ? list.last : [];
}

export const listedSession = (list: SessionList, id: string) =>
    listedSessions(list).find((session) => session.id === id);

export type Screen = "home" | "sessions";

export type NavigationView = {
    readonly screen: Screen;
    readonly focused: string | null;
    readonly selected: string | null;
    readonly wide: boolean;
    readonly small: boolean;
    readonly briefHidden: boolean;
    readonly metadataExpanded: boolean;
    readonly expanded: string | null;
    readonly help: boolean;
    readonly scroll: number;
    readonly detailScroll: number;
};

export type TerminalView = NavigationView & {
    readonly sessions: readonly Observation[];
    readonly list: SessionList;
    readonly izbor: IzborState;
    feedback: string;
    feedbackIsError: boolean;
    field: FieldState;
    readonly home: string;
    readonly oldBuild: boolean;
};

export type TerminalSize = { columns: number; rows: number };

export type Rectangle = { x: number; y: number; width: number; height: number };
export type HitTarget = { rect: Rectangle } & (
    | { type: "session"; id: string }
    | { type: "project"; checkout: string }
    | { type: "back" | "help" | "detail" | "hide" | "send" }
    | { type: "stop"; id: string }
    | { type: "tab"; screen: Screen }
    | { type: "field"; origin: number; indices: number[] }
);
export type ViewportLayout = {
    maxScroll: number;
    pageSize: number;
    scroll: number;
    viewport?: Rectangle | undefined;
    targets?: HitTarget[];
    detail?:
        | {
              maxScroll: number;
              pageSize: number;
              scroll: number;
              viewport?: Rectangle;
          }
        | undefined;
};

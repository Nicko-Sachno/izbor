import type { HookDecision } from "../domain/answer.js";
import type { HookEvidence } from "../domain/brief.js";
import type { ProjectSetup } from "../domain/projectSetup.js";
import type { IzborPrompt, PromptState } from "../domain/prompt.js";
import type { EventRecord, HookRecord, Status } from "../domain/records.js";
import type { AnswerOutcome } from "./answerHolds.js";
import type { SendPromptOutcome } from "./izborPrompts.js";
import type { Thread } from "./sessionSync.js";
import type { WatchTracker } from "./watchTracker.js";

export type AgentProvider = {
    readHook(body: string, receivedAt: Date): Hook | undefined;
    readThreads(sessionId: string, cwd?: string): Promise<Thread[]>;
    queryStatus(signal: AbortSignal): Promise<ListedSession[]>;
    isActing(cwd: string, port: number): boolean;
    answerHook: { output(decision: HookDecision | null): string };
};

export type Hook = {
    sessionId: string;
    sessionOver: boolean;
    cwd?: string;
    ended: boolean;
    event: EventRecord | null;
    evidence: HookEvidence;
    record: HookRecord;
};

export type IzborRoutes = {
    tracker: Pick<WatchTracker, "tuneIn" | "tuneInAll" | "list" | "stop" | "stopAll" | "closing">;
    handleHook(hook: Hook): Promise<void>;
    handleRejected(body: string): Promise<void>;
    holdAnswer(hook: Hook, closed: AbortSignal): Promise<HookDecision | null>;
    answer(sessionId: string, at: string, typed: string): AnswerOutcome | undefined;
    prompts: {
        send(sessionId: string, text: string): Promise<SendPromptOutcome>;
        next(sessionId: string, closed: AbortSignal): Promise<IzborPrompt | undefined>;
        report(promptId: string, state: PromptState, reason?: string): boolean;
    };
};

/** A session the agent lists, with its status and, when the list names it, its folder (`cwd`). */
export type ListedSession = { sessionId: string; cwd?: string } & Extract<
    Status,
    { status: "busy" | "idle" | "waiting" | "unknown" }
>;

export type ProviderContext = {
    platform: Pick<Platform, "run" | "replaceFile" | "readRegularFile" | "ownsFilesByUid">;
    home: string;
    pluginDir: string;
    hookRunner: { node: string; script: string };
};

export type CreateProvider = (context: ProviderContext) => AgentProvider;

export type CreateProject = (context: ProviderContext) => ProjectSetup;

export type Providers = Readonly<Record<string, AgentProvider>>;

export type DataFolderLock = {
    writeHolder(port: number): Promise<void>;
    release(): Promise<void>;
};

export type Platform = {
    lockDataFolder(dataDir: string): Promise<DataFolderLock>;
    run(command: string, args: readonly string[], options: RunOptions): Promise<Ran>;
    killTree(pid: number | undefined): void;
    reachesTreeAfterExit: boolean;
    isAlive(pid: number): boolean;
    endIzbor(pid: number): void;
    startInBackground(start: BackgroundStart): Promise<Spawned>;
    replaceFile(file: string, text: string, mode?: number): void;
    writePrivateFile(file: string, text: string): void;
    readRegularFile(file: string): { text: string; mode: number } | null;
    ownsFilesByUid: boolean;
    dropsMouseClicks(env: Record<string, string | undefined>): boolean;
    refusedConnectMs: number;
};

export type RunOptions = { timeoutMs: number; cwd?: string; signal?: AbortSignal };

export type Ran =
    | { outcome: "exited"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
    | { outcome: "timed_out" | "cancelled" | "not_started"; why: string };

export type BackgroundStart = { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: number };

export type Spawned = { pid: number } | { error: string };

export type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

export type Now = () => Date;

type LogFields = { sessionId?: string; agentId?: string | null };

export type LogEntry = { level: "info" | "warning" | "error"; text: string; fields: LogFields };

export type Log = (level: LogEntry["level"], text: string, fields?: LogFields) => void;

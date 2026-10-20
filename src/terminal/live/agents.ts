import { join, resolve, sep } from "node:path";
import { answerHookAt } from "../../adapters/agents/claude/setup/answerHook.js";
import { izborHooksAt } from "../../adapters/agents/claude/setup/izborHooks.js";
import { checkoutOf, type FileOwnership } from "../../adapters/agents/claude/setup/projectFiles.js";
import { isInside, PROJECT_DIR, readDataDir } from "../../config.js";
import { messageOf, upperDrive } from "../../domain/text.js";
import type { IzborInfo } from "../../domain/wire.js";
import type { RunningSession, SessionList } from "../model.js";

export type Where = {
    summarizerDir: string;
    checkoutOf(cwd: string): string;
    hasHooks(checkout: string): boolean;
    acts(checkout: string): boolean;
};

export function windowWhere({
    izbor,
    port,
    env,
    platform,
}: {
    izbor: IzborInfo | "older";
    port: number;
    env: Record<string, string | undefined>;
    platform: FileOwnership;
}): Where {
    const dataDir = izbor === "older" ? readDataDir(env, PROJECT_DIR) : izbor.dataDir;
    return {
        summarizerDir: join(dataDir, "summarizer"),
        checkoutOf: (cwd) => checkoutOf(cwd, platform),
        hasHooks: (checkout) => izborHooksAt(checkout, port, platform),
        acts: (checkout) => answerHookAt(checkout, port, platform),
    };
}

type ListEntry = { sessionId?: unknown; name?: unknown; cwd?: unknown; status?: unknown; waitingFor?: unknown };

const textOf = (value: unknown) => (typeof value === "string" ? value : undefined);

function worktreeName(cwd: string): string | undefined {
    const folders = resolve(cwd).split(sep);
    const at = folders.findIndex(
        (folder, i) =>
            folder.toLowerCase() === ".claude" && folders[i + 1]?.toLowerCase() === "worktrees" && !!folders[i + 2],
    );
    return at < 0 ? undefined : folders[at + 2];
}

function entriesIn(output: string): ListEntry[] {
    let entries: unknown;
    try {
        entries = JSON.parse(output);
    } catch {}
    if (!Array.isArray(entries)) throw new Error(`claude agents --json printed no list: ${output.slice(0, 200)}`);
    return entries.filter((entry): entry is ListEntry => typeof entry === "object" && entry !== null);
}

export function parseRunningSessions(output: string, where: Where): RunningSession[] {
    const settings = new Map<string, { hooks: boolean; acting: boolean }>();
    return entriesIn(output).flatMap((entry) => {
        const id = textOf(entry.sessionId)?.toLowerCase();
        const reported = textOf(entry.cwd);
        const cwd = reported && upperDrive(reported);
        if (!id || !cwd || isInside(cwd, where.summarizerDir)) return [];
        const status = textOf(entry.status);
        const waitingFor = textOf(entry.waitingFor);
        const checkout = where.checkoutOf(cwd);
        const worktree = worktreeName(cwd);
        if (!settings.has(checkout))
            settings.set(checkout, { hooks: where.hasHooks(checkout), acting: where.acts(checkout) });
        return {
            id,
            name: textOf(entry.name) ?? "",
            ...(status !== undefined && { status }),
            ...(waitingFor !== undefined && { waitingFor }),
            checkout,
            ...(worktree !== undefined && { worktree }),
            ...settings.get(checkout)!,
        } satisfies RunningSession;
    });
}

export function datedWaits(
    sessions: RunningSession[],
    previous: readonly RunningSession[] | undefined,
    at: string,
): RunningSession[] {
    if (!previous) return sessions;
    const before = new Map(previous.map((session) => [session.id, session]));
    return sessions.map((session) => {
        if (session.status !== "waiting") return session;
        const was = before.get(session.id);
        const waitingSince = was?.status === "waiting" ? was.waitingSince : at;
        return waitingSince === undefined ? session : { ...session, waitingSince };
    });
}

export interface RunningSessions {
    refresh(): Promise<SessionList>;
    dispose(): void;
}

export function createRunningSessions({
    run,
    where,
    now,
}: {
    run: (signal: AbortSignal) => Promise<string>;
    where: () => Where;
    now: () => Date;
}): RunningSessions {
    const disposed = new AbortController();
    let last: readonly RunningSession[] | undefined;
    let inFlight: Promise<SessionList> | undefined;

    async function runOnce(): Promise<SessionList> {
        try {
            const parsed = parseRunningSessions(await run(disposed.signal), where());
            const at = now().toISOString();
            const sessions = datedWaits(parsed, last, at);
            last = sessions;
            return { state: "listed", sessions, at };
        } catch (err) {
            return { state: "no list", reason: messageOf(err), last: last ?? [] };
        }
    }

    return {
        refresh(): Promise<SessionList> {
            inFlight ??= runOnce().finally(() => (inFlight = undefined));
            return inFlight;
        },
        dispose: () => disposed.abort(),
    };
}

import { basename, join, resolve, sep } from "node:path";
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

/** What a session's transcript says it is about: Claude's title for it and its first prompt, each when it has one. */
export type SessionTitle = { title?: string; firstPrompt?: string };

/** Reads one session's title from its transcript, an empty one while it has none. Rejects when it cannot be read. */
export type ReadTitle = (sessionId: string) => Promise<SessionTitle>;

type ListEntry = {
    sessionId?: unknown;
    name?: unknown;
    cwd?: unknown;
    startedAt?: unknown;
    status?: unknown;
    waitingFor?: unknown;
};

/** A session the window lists: its entry, with its id, its folder and that folder's checkout. */
type Listed = { entry: ListEntry; id: string; cwd: string; checkout: string };

const textOf = (value: unknown) => (typeof value === "string" ? value : undefined);

function startedAtOf(value: unknown): string | undefined {
    const time = typeof value === "number" ? new Date(value) : undefined;
    return time && !Number.isNaN(time.getTime()) ? time.toISOString() : undefined;
}

/** A folder's name as Claude Code slugs it for a session's name, or `claude` when nothing of it is left. */
function folderSlug(folder: string): string {
    const slug = basename(folder)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(" ")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-+|-+$/g, "");
    return slug || "claude";
}

/**
 * Whether Claude Code derived the session's name because nobody named it: the slug of the folder it started in, then
 * a dash and two hex digits, as in `izbor-6a`. That folder is the listed one, or its checkout once the session entered
 * a worktree. The rule is Claude Code's own, copied; should it change, the name shows as Claude Code lists it. No name
 * at all counts as derived too.
 */
function derivedName({ entry, cwd, checkout }: Listed): boolean {
    const name = textOf(entry.name) ?? "";
    return (
        name === "" || [cwd, checkout].some((folder) => new RegExp(`^${folderSlug(folder)}-[0-9a-f]{2}$`).test(name))
    );
}

/** The name a session is listed by: Claude Code's, unless Claude Code derived it; then Claude's title, else the first
 *  prompt, else none. A session whose title was not read keeps Claude Code's name. */
function chosenName(listed: Listed, found: SessionTitle | undefined): string {
    const name = textOf(listed.entry.name) ?? "";
    if (!found || !derivedName(listed)) return name;
    return found.title || found.firstPrompt || "";
}

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

/** The sessions the window lists, the summarizer's left out. */
function listedIn(output: string, where: Where): Listed[] {
    return entriesIn(output).flatMap((entry) => {
        const id = textOf(entry.sessionId)?.toLowerCase();
        const reported = textOf(entry.cwd);
        const cwd = reported && upperDrive(reported);
        if (!id || !cwd || isInside(cwd, where.summarizerDir)) return [];
        return [{ entry, id, cwd, checkout: where.checkoutOf(cwd) }];
    });
}

export function parseRunningSessions(
    output: string,
    where: Where,
    titles: ReadonlyMap<string, SessionTitle> = new Map(),
): RunningSession[] {
    return runningSessionsOf(listedIn(output, where), where, titles);
}

function runningSessionsOf(
    listed: readonly Listed[],
    where: Where,
    titles: ReadonlyMap<string, SessionTitle>,
): RunningSession[] {
    const settings = new Map<string, { hooks: boolean; acting: boolean }>();
    return listed.map((session) => {
        const { entry, id, cwd, checkout } = session;
        const status = textOf(entry.status);
        const waitingFor = textOf(entry.waitingFor);
        const startedAt = startedAtOf(entry.startedAt);
        const worktree = worktreeName(cwd);
        if (!settings.has(checkout))
            settings.set(checkout, { hooks: where.hasHooks(checkout), acting: where.acts(checkout) });
        return {
            id,
            name: chosenName(session, titles.get(id)),
            ...(startedAt !== undefined && { startedAt }),
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
    readTitle,
    where,
    now,
}: {
    run: (signal: AbortSignal) => Promise<string>;
    readTitle: ReadTitle;
    where: () => Where;
    now: () => Date;
}): RunningSessions {
    const disposed = new AbortController();
    let last: readonly RunningSession[] | undefined;
    let inFlight: Promise<SessionList> | undefined;

    /** Reads the titles together. One that fails is left out, so its session keeps Claude Code's name. */
    async function readTitles(ids: readonly string[]): Promise<Map<string, SessionTitle>> {
        const read = await Promise.allSettled(ids.map((id) => readTitle(id)));
        return new Map(read.flatMap((result, i) => (result.status === "fulfilled" ? [[ids[i]!, result.value]] : [])));
    }

    async function runOnce(): Promise<SessionList> {
        try {
            const output = await run(disposed.signal);
            const listedWhere = where();
            const listed = listedIn(output, listedWhere);
            const titles = await readTitles(listed.filter(derivedName).map(({ id }) => id));
            const parsed = runningSessionsOf(listed, listedWhere, titles);
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

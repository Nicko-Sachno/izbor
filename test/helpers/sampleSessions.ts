import { homedir } from "node:os";
import { join } from "node:path";
import { createListeners } from "../../src/terminal/listeners.js";
import type { ProjectSetup } from "../../src/terminal/main.js";
import {
    GAP_SHOWN_MS,
    hasStream,
    type Connection,
    type Observation,
    type ObservationSource,
    type RunningSession,
    type SentAnswer,
    type SessionList,
    type Snapshot,
    type TerminalBrief,
} from "../../src/terminal/model.js";

export const SAMPLE_IDS = [
    "0926995f-4c57-4733-89cf-d0c7226a5cbc",
    "a7312ce4-782a-45a0-a84c-e834c934b2a7",
    "c8219b07-e082-4ac4-9bdf-4abfe6fcfc8e",
] as const;

export const SAMPLE_SCENARIOS = [
    "overview",
    "unknown",
    "outdated",
    "missing-request",
    "disconnected",
    "stopped",
    "connecting",
    "catching-up",
    "izbor-stopped",
    "not-running",
    "izbor-stopping",
    "refused",
    "gap",
    "answer-sent",
    "answer-not-taken",
    "cannot-answer",
    "question",
    "fresh-wait",
] as const;

export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

const RETRY_SECONDS = 10;

const settleUnlessDisposed = <T>(disposed: boolean, value: T): Promise<T> =>
    disposed
        ? Promise.reject(new DOMException("The terminal app was disposed.", "AbortError"))
        : Promise.resolve(value);

const SAMPLE_SENDS_NOTHING = { news: "The sample sends nothing." } as const;

function settingsAdded(checkout: string, added: boolean) {
    return {
        done: added ? "added" : "already",
        checkout,
        file: join(checkout, ".claude", "settings.local.json"),
    } as const;
}

type SampleAnimation = {
    brief(id: string, brief: TerminalBrief): void;
    rearm(row: Observation): void;
};

const listening = ({ connection }: Observation) => hasStream(connection);
const countsDown = ({ connection }: Observation) => "retryAt" in connection && connection.retryAt !== undefined;

function unknownBrief(explanationUnknownReason: string): TerminalBrief {
    return {
        task: null,
        status: "unknown",
        explanation: null,
        explanationUnknownReason,
        latestActivity: null,
        needsYou: { state: "unknown" },
        lastObserved: null,
    };
}

function sampleList(home: string, at: string): SessionList {
    const folder = join(home, "izbor");
    const example = join(home, "example-api");
    const invoices = join(home, "invoice-api");
    return {
        state: "listed",
        at,
        sessions: [
            {
                id: SAMPLE_IDS[0],
                name: "izbor-4c",
                status: "busy",
                checkout: folder,
                hooks: true,
                acting: true,
            },
            {
                id: SAMPLE_IDS[1],
                name: "izbor-e8",
                status: "waiting",
                waitingFor: "permission prompt",
                checkout: folder,
                worktree: "invoices",
                hooks: true,
                acting: true,
            },
            {
                id: SAMPLE_IDS[2],
                name: "izbor-6f",
                status: "idle",
                checkout: folder,
                hooks: true,
                acting: true,
            },
            {
                id: "5b0e7c1d-2f4a-4c8e-9d36-7a1f0b2c3d4e",
                name: "Orders API review",
                status: "idle",
                checkout: example,
                hooks: false,
                acting: false,
            },
            {
                id: "e3d9a6f2-81b4-4f07-b5c2-6d8e9f0a1b2c",
                name: "example-api-3a",
                status: "busy",
                checkout: example,
                hooks: false,
                acting: false,
            },
            {
                id: "2b6f8d0c-9a47-4e15-b3c8-5d7e1f9a0b2c",
                name: "invoice-api-2b",
                status: "idle",
                checkout: invoices,
                hooks: true,
                acting: false,
            },
        ] satisfies RunningSession[],
    };
}

// The sample list as a window shows it where no project has the plugin.
export function withoutPlugin(list: SessionList): SessionList {
    return list.state === "listed"
        ? { ...list, sessions: list.sessions.map((session) => ({ ...session, acting: false })) }
        : list;
}

function sampleBriefs(ago: (seconds: number) => string): Observation[] {
    return [
        {
            id: SAMPLE_IDS[0],
            connection: { state: "live" },
            brief: {
                task: {
                    text: "Fix the token refresh bug and add a regression test for expired access tokens.",
                    at: ago(240),
                    from: "hook",
                },
                status: "busy",
                explanation: {
                    text: "Running authentication tests.",
                    at: ago(18),
                },
                latestActivity: { text: "Bash: npm test auth", at: ago(8) },
                needsYou: { state: "nothing" },
                lastObserved: { at: ago(8), from: "hook" },
            },
        },
        {
            id: SAMPLE_IDS[1],
            connection: { state: "live" },
            brief: {
                task: {
                    text: "Add CSV export for invoices, including invoice number, date, customer, and total.",
                    at: ago(180),
                    from: "transcript",
                },
                status: "waiting",
                explanation: {
                    text: "The CSV export is implemented. Waiting for permission to run the invoice tests.",
                    at: ago(12),
                },
                latestActivity: {
                    text: "Permission requested for Bash: npm test invoices",
                    at: ago(15),
                },
                needsYou: {
                    state: "request",
                    text: "Bash: npm test invoices",
                    detail: "Bash: npm test invoices",
                    at: ago(15),
                },
                answerable: true,
                lastObserved: { at: ago(15), from: "hook" },
            },
        },
        {
            id: SAMPLE_IDS[2],
            connection: { state: "live" },
            brief: {
                task: {
                    text: "Explain how request retries work and where the retry limit is configured.",
                    at: ago(300),
                    from: "hook",
                },
                status: "idle",
                explanation: {
                    text: "Traced the retry logic in request.ts and explained where its limit is configured, which errors trigger another attempt, and when failed requests stop retrying automatically.",
                    at: ago(25),
                },
                latestActivity: { text: "Reply finished", at: ago(30) },
                needsYou: { state: "nothing" },
                lastObserved: { at: ago(30), from: "hook" },
            },
        },
    ];
}

function missingRequest(brief: TerminalBrief, at: string): TerminalBrief {
    return {
        ...brief,
        status: "waiting",
        needsYou: { state: "unknown", reason: "Izbor reports waiting; request details are unavailable." },
        explanation: null,
        explanationUnknownReason: "No Explanation is available for the waiting state.",
        latestActivity: null,
        lastObserved: { at, from: "status" },
    };
}

function asking(
    sample: Observation,
    at: string,
    answerable: TerminalBrief["answerable"],
    sent?: Omit<SentAnswer, "at">,
): Observation {
    const brief: TerminalBrief = {
        ...sample.brief!,
        status: "waiting",
        explanation: {
            text: "Traced the retry logic in request.ts. Waiting for permission to run the retry tests.",
            at,
        },
        latestActivity: { text: "Permission requested for Bash: npm test retries", at },
        needsYou: { state: "request", text: "Bash: npm test retries", detail: "Bash: npm test retries", at },
        answerable,
        lastObserved: { at, from: "hook" },
    };
    return { ...sample, brief, ...(sent && { sent: { at, ...sent } }) };
}

const DATE_FORMATS = ["ISO 8601 (2026-10-09)", "Day first (09/10/2026)", "Month first (10/09/2026)"];

const RETRY_LOG_EXPORT =
    "Traced the retry logic in request.ts and added a CSV export of the retry log. Waiting for you to pick the export's date format.";

export function askingQuestion(sample: Observation, at: string, now: string): Observation {
    const question = "Which date format should the export use?";
    const brief: TerminalBrief = {
        ...sample.brief!,
        status: "waiting",
        explanation: { text: now, at },
        latestActivity: { text: `asked the user: ${question}`, at },
        needsYou: {
            state: "request",
            text: question,
            detail: DATE_FORMATS.map((label, index) => `${index + 1}. ${label}`).join("\n"),
            takes: "number",
            at,
        },
        answerable: true,
        lastObserved: { at, from: "hook" },
    };
    return { ...sample, brief };
}

const FIELD_CASES: Record<
    "answer-sent" | "answer-not-taken" | "cannot-answer" | "question",
    (sample: Observation, at: (seconds: number) => string) => Observation
> = {
    "answer-sent": (sample, at) => asking(sample, at(-15), "answered", { text: "yes", sentAt: at(-3) }),
    "answer-not-taken": (sample, at) =>
        asking(sample, at(-15), "answered", { text: "yes", sentAt: at(-8), stillWaits: true }),
    "cannot-answer": (sample, at) => asking(sample, at(-15), "not running when it asked"),
    question: (sample, at) => askingQuestion(sample, at(-15), RETRY_LOG_EXPORT),
};

type SampleWorld = {
    readonly list: SessionList;
    add(checkout: string, what: "hooks" | "acting"): boolean;
    row(id: string): Observation;
    setScenario(next: SampleScenario): Observation | undefined;
    animate(on: SampleAnimation): () => void;
};

export function createSampleWorld(initialScenario: SampleScenario = "overview"): SampleWorld {
    const createdAt = Date.now();
    const ago = (seconds: number) => new Date(createdAt - seconds * 1000).toISOString();
    const samples = sampleBriefs(ago);
    let list = sampleList(homedir(), ago(0));
    const rows = new Map(samples.map((row) => [row.id, row]));
    let scenario: SampleScenario | undefined;
    let animation: SampleAnimation | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let rearmTimer: ReturnType<typeof setTimeout> | undefined;
    let step = 0;

    function row(id: string): Observation {
        return (
            rows.get(id) ?? {
                id,
                connection: { state: "live" },
                brief: unknownBrief("No sample Brief for this ID"),
            }
        );
    }

    function scenarioRow(next: SampleScenario): Observation {
        const now = Date.now();
        const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
        const sample: Observation = { ...structuredClone(samples[2]!), since: at(0) };
        const lastBrief = structuredClone(rows.get(sample.id)!.brief ?? sample.brief!);
        const kept = (connection: Connection): Observation => ({ ...sample, brief: lastBrief, connection });
        const brief = sample.brief!;
        switch (next) {
            case "overview":
                return sample;
            case "unknown":
                return { ...sample, brief: unknownBrief("No sample Brief has arrived yet.") };
            case "outdated":
                brief.explanation = {
                    text: "Tracing the retry logic in request.ts before explaining the retry limit.",
                    at: ago(45),
                    outdatedReason: "reply finished",
                };
                return sample;
            case "missing-request":
                return { ...sample, brief: missingRequest(brief, ago(2)) };
            case "disconnected":
                return kept({ state: "disconnected", since: at(-40), retryAt: at(RETRY_SECONDS) });
            case "stopped":
                return kept({ state: "stopped", why: "deleted" });
            case "connecting":
                return { ...sample, brief: null, connection: { state: "connecting" } };
            case "catching-up":
                return kept({ state: "catching up" });
            case "izbor-stopped":
                return kept({ state: "stopped", why: "izbor stopping" });
            case "not-running":
                return kept({ state: "izbor away", reason: "not running", retryAt: at(RETRY_SECONDS) });
            case "izbor-stopping":
                return kept({ state: "izbor away", reason: "stopping" });
            case "refused":
                return kept({
                    state: "refused",
                    status: 403,
                    message: "Izbor answers only requests addressed to 127.0.0.1 or localhost",
                });
            case "gap":
                return { ...sample, gap: { from: at(-60), to: at(-20) } };
            case "fresh-wait":
                return asking(sample, at(0), true);
            default:
                return FIELD_CASES[next](sample, at);
        }
    }

    function tick() {
        const current = rows.get(SAMPLE_IDS[0])!;
        if (current.connection.state !== "live" || !current.brief) return;
        const at = new Date().toISOString();
        step += 1;
        const brief: TerminalBrief = {
            ...current.brief,
            latestActivity: { text: step % 2 ? "Read: auth/refresh.test.ts" : "Bash: npm test auth", at },
            explanation: {
                text:
                    step % 2
                        ? "Checking regression coverage for expired access tokens."
                        : "Running authentication tests.",
                at,
            },
            lastObserved: { at, from: "hook" },
        };
        rows.set(current.id, { ...current, brief });
        animation?.brief(current.id, brief);
    }

    function scheduleRearm() {
        clearTimeout(rearmTimer);
        rearmTimer = undefined;
        const { connection } = rows.get(SAMPLE_IDS[2])!;
        if (!animation || !("retryAt" in connection) || connection.retryAt === undefined) return;
        rearmTimer = setTimeout(
            () => {
                const current = rows.get(SAMPLE_IDS[2])!;
                if (current.connection !== connection) return;
                const retryAt = new Date(Date.now() + RETRY_SECONDS * 1000).toISOString();
                const rearmed = { ...current, connection: { ...connection, retryAt } };
                rows.set(rearmed.id, rearmed);
                animation?.rearm(rearmed);
                scheduleRearm();
            },
            Date.parse(connection.retryAt) - Date.now(),
        );
        rearmTimer.unref();
    }

    function setScenario(next: SampleScenario): Observation | undefined {
        if (next === scenario) return undefined;
        scenario = next;
        const changed = scenarioRow(next);
        rows.set(changed.id, changed);
        scheduleRearm();
        return changed;
    }

    setScenario(initialScenario);

    function add(checkout: string, what: "hooks" | "acting"): boolean {
        if (list.state !== "listed") return false;
        const sessions = list.sessions.filter((session) => session.checkout === checkout);
        if (!sessions.length || sessions.every((session) => session[what])) return false;
        list = {
            ...list,
            sessions: list.sessions.map((session) =>
                session.checkout === checkout ? { ...session, [what]: true } : session,
            ),
        };
        return true;
    }

    return {
        get list() {
            return list;
        },
        add,
        row,
        setScenario,
        animate(on: SampleAnimation): () => void {
            animation = on;
            timer = setInterval(tick, 8000);
            timer.unref();
            scheduleRearm();
            return () => {
                animation = undefined;
                clearInterval(timer);
                clearTimeout(rearmTimer);
            };
        },
    };
}

function gapSince(connection: Connection): Observation["gap"] | null {
    if (connection.state !== "disconnected") return null;
    const to = new Date();
    return to.getTime() - Date.parse(connection.since) > GAP_SHOWN_MS
        ? { from: connection.since, to: to.toISOString() }
        : null;
}

function liveAgain({ id, brief, gap: last }: Observation, fresh: TerminalBrief | null, gap: Observation["gap"] | null) {
    const shown = gap ?? last;
    return {
        id,
        brief: fresh ?? brief,
        connection: { state: "live" },
        ...(shown && { gap: shown }),
    } satisfies Observation;
}

export interface SampleSource extends ObservationSource {
    setScenario(scenario: SampleScenario): void;
    // Project writers that change the sample list in memory: Add hooks › and Add plugin › work, and no file changes.
    readonly setup: ProjectSetup;
}

const SAMPLE_PORT = 4319;

export function createSampleSource({
    scenario,
    animate,
}: {
    scenario: SampleScenario;
    animate: boolean;
}): SampleSource {
    const world = createSampleWorld(scenario);
    const izbor = { state: "up", address: `127.0.0.1:${SAMPLE_PORT}` } as const;
    let snapshot: Snapshot = { izbor, list: world.list, observations: [] };
    const listeners = createListeners();
    let disposed = false;

    function change(observations: readonly Observation[]) {
        snapshot = { izbor, list: world.list, observations };
        listeners.emit();
    }

    function replace(next: (row: Observation) => Observation | undefined) {
        let changed = false;
        const observations = snapshot.observations.map((row) => {
            const swapped = next(row);
            if (!swapped) return row;
            changed = true;
            return swapped;
        });
        if (changed) change(observations);
    }

    const stopAnimating = animate
        ? world.animate({
              brief: (id, brief) =>
                  replace((row) =>
                      row.id === id && row.connection.state === "live"
                          ? { ...row, brief: structuredClone(brief) }
                          : undefined,
                  ),
              rearm: (next) =>
                  replace((row) =>
                      row.id === next.id && countsDown(row)
                          ? { ...row, connection: structuredClone(next.connection) }
                          : undefined,
                  ),
          })
        : undefined;

    return {
        getSnapshot: () => snapshot,
        onChange: listeners.on,
        observe(id) {
            id = id.toLowerCase();
            if (disposed) return "already";
            const index = snapshot.observations.findIndex((row) => row.id === id);
            if (index === -1) {
                change([...snapshot.observations, structuredClone(world.row(id))]);
                return "added";
            }
            const row = snapshot.observations[index]!;
            if (listening(row)) return "already";
            const fresh = structuredClone(world.row(id));
            replace((other) => (other === row ? liveAgain(row, fresh.brief, gapSince(row.connection)) : undefined));
            return "again";
        },
        leave(id) {
            id = id.toLowerCase();
            if (disposed || !snapshot.observations.some((row) => row.id === id)) return;
            change(snapshot.observations.filter((row) => row.id !== id));
        },
        refreshSessions() {
            if (!disposed && snapshot.list !== world.list) change(snapshot.observations);
            return settleUnlessDisposed(disposed, world.list);
        },
        setup: {
            port: SAMPLE_PORT,
            hooks: ({ folder }) => settingsAdded(folder, world.add(folder, "hooks")),
            plugin: async ({ folder }) => settingsAdded(folder, world.add(folder, "acting")),
        },
        answer: () => settleUnlessDisposed(disposed, SAMPLE_SENDS_NOTHING),
        prompt: () => settleUnlessDisposed(disposed, SAMPLE_SENDS_NOTHING),
        setScenario(next) {
            if (disposed) return;
            const changed = world.setScenario(next);
            if (changed) replace((row) => (row.id === changed.id ? structuredClone(changed) : undefined));
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            listeners.close();
            stopAnimating?.();
        },
    };
}

export function sampleRun({
    scenario = "overview",
    empty = false,
}: { scenario?: SampleScenario; empty?: boolean } = {}) {
    const source = createSampleSource({ scenario, animate: true });
    return { source, initialIds: empty ? [] : SAMPLE_IDS, setup: source.setup };
}

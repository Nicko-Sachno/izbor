import type { StatusEvidence } from "../domain/brief.js";
import type { Status } from "../domain/records.js";
import type { HookFile } from "./hookFile.js";
import type { StatusAnswer, StatusQuery } from "./statusQuery.js";

type StatusWatchDeps = {
    sessionId: string;
    statusQuery: Pick<StatusQuery, "subscribe" | "query">;
    hookFile: HookFile;
    onError: (err: unknown) => void;
    onReading: (reading: StatusEvidence) => void;
    onChange: () => void;
};

type StatusWatch = {
    query(): Promise<void>;
    stop(): Promise<void>;
};

const waitingFor = (status: Status) => (status.status === "waiting" ? status.waitingFor : undefined);

const isChange = (from: Status, to: Status) => from.status !== to.status || waitingFor(from) !== waitingFor(to);

export function createStatusWatch(deps: StatusWatchDeps): StatusWatch {
    const { sessionId, statusQuery, hookFile, onError, onReading, onChange } = deps;
    let saved: Status | undefined;
    let saving: Promise<void> = Promise.resolve();
    let stopped = false;

    function readingIn(answer: StatusAnswer): Pick<StatusEvidence, "status" | "folder"> {
        if ("error" in answer) return { status: { status: "unknown", error: answer.error } };
        const listed = answer.sessions.find((session) => session.sessionId === sessionId);
        if (!listed) return { status: { status: "not_listed" } };
        const { sessionId: _watched, cwd: folder, ...status } = listed;
        return { status, folder };
    }

    function onAnswer(answer: StatusAnswer): void {
        try {
            const { status, folder } = readingIn(answer);
            onReading({ status, askedAt: answer.askedAt, at: answer.at, folder });
            if (saved && !isChange(saved, status)) return;
            saved = status;
            const record = { kind: "status" as const, sessionId, timestamp: answer.at, ...status };
            saving = hookFile.append(record).then(onChange).catch(onError);
        } catch (err) {
            onError(err);
        }
    }

    const unsubscribe = statusQuery.subscribe(onAnswer);

    async function query(): Promise<void> {
        if (stopped) return;
        await statusQuery.query();
        await saving;
    }

    async function stop(): Promise<void> {
        stopped = true;
        unsubscribe();
        await saving;
    }

    return { query, stop };
}

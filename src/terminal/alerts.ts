import type { Observation, Snapshot } from "./model.js";

export const QUIET_TITLE = "izbor";

export function windowTitle({ izbor, observations }: Pick<Snapshot, "izbor" | "observations">): string {
    if (izbor.state !== "up") return "Izbor · not running";
    return observations.some(({ brief }) => brief?.status === "waiting") ? "Izbor · needs you" : QUIET_TITLE;
}

function waitAt({ brief }: Observation): string | undefined {
    return brief?.status === "waiting" && brief.needsYou.state !== "nothing" ? brief.needsYou.at : undefined;
}

function freshWait(row: Observation): string | undefined {
    const at = waitAt(row);
    return at !== undefined && row.since !== undefined && Date.parse(at) >= Date.parse(row.since) ? at : undefined;
}

function notTaken({ sent, connection }: Observation): string | undefined {
    return sent?.stillWaits && connection.state === "live" ? sent.sentAt : undefined;
}

export function rings(previous: readonly Observation[], next: readonly Observation[]): boolean {
    const before = new Map(previous.map((row) => [row.id, row]));
    return next.some((row) => {
        const was = before.get(row.id);
        const wait = freshWait(row);
        const answer = notTaken(row);
        const newWait = wait !== undefined && wait !== (was && waitAt(was));
        const newAnswer = answer !== undefined && !(was?.sent?.stillWaits && was.sent.sentAt === answer);
        return newWait || newAnswer;
    });
}

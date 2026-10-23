import type { IzborClient } from "../../src/adapters/izbor/client.js";
import type { IzborInfo } from "../../src/domain/wire.js";

export const PORT = 4400;

export const INFO: IzborInfo = {
    service: "izbor",
    pid: 71494,
    port: PORT,
    dataDir: "/Users/me/izbor/.izbor",
    startedAt: "2026-10-06T09:12:03.000Z",
    sendKeyPath: "/Users/me/.config/izbor/send-key-4400",
};

export type IzborAnswer = Awaited<ReturnType<IzborClient["getIzbor"]>>;

export const NOT_RUNNING = { away: "not running" } as const;
export const FOREIGN = "GET /izbor answered 404 Not Found, not JSON";

// Each call gets the next answer; the last answer repeats.
export const inTurn = (answers: IzborAnswer[]) => () => (answers.length > 1 ? answers.shift()! : answers[0]!);

// A pid lives until its time in `lives`, or forever.
export const runsUntil = (lives: Record<number, number>) => (pid: number, at: number) => at < (lives[pid] ?? Infinity);

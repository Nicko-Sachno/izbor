import type { Action, Brief } from "../domain/brief.js";

export type Report = {
    brief(brief: Brief): void;
    action(action: Action): void;
    shrunk(agentId: string | null, got: number, written: number, keepFile: boolean): void;
    error(err: unknown): void;
};

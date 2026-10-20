import { basename } from "node:path";
import { tilde } from "../config.js";
import type { RunningSession } from "./model.js";

export type Project = {
    name: string;
    checkout: string;
    hooks: boolean;
    acting: boolean;
    sessions: readonly RunningSession[];
};

export function projectAct({ hooks, acting }: Project): "add hooks" | "add plugin" | undefined {
    if (!hooks) return "add hooks";
    return acting ? undefined : "add plugin";
}

const homeFolder = (folder: string, home: string) => (folder === home ? "~" : tilde(folder, home));

export function projectsOf(sessions: readonly RunningSession[], home: string): Project[] {
    const byCheckout = new Map<string, RunningSession[]>();
    for (const session of sessions) {
        const group = byCheckout.get(session.checkout);
        if (group) group.push(session);
        else byCheckout.set(session.checkout, [session]);
    }
    const checkouts = [...byCheckout.keys()];
    const shared = (checkout: string) => checkouts.filter((other) => basename(other) === basename(checkout)).length > 1;
    return checkouts.map((checkout) => {
        const group = byCheckout.get(checkout)!;
        return {
            name: shared(checkout) || !basename(checkout) ? homeFolder(checkout, home) : basename(checkout),
            checkout,
            hooks: group[0]!.hooks,
            acting: group[0]!.acting,
            sessions: group,
        };
    });
}

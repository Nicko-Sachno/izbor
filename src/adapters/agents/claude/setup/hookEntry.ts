import type { ProviderContext } from "../../../../core/ports.js";
import { isObject } from "../../../../domain/text.js";

export function groupHolds(group: unknown, matchesHook: (hook: unknown) => boolean): group is { hooks: unknown[] } {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
        return false;
    }

    return group.hooks.some(matchesHook);
}

export const izborHookEntry = (runner: ProviderContext["hookRunner"], url: string, limitS: number, print: boolean) => ({
    type: "command",
    command: runner.node,
    args: [runner.script, url, String(limitS), ...(print ? ["print"] : [])],
});

export function isIzborHook(entry: unknown, url: string): boolean {
    if (!isObject(entry)) {
        return false;
    }

    const { type, command, args } = entry;
    if (type !== "command") {
        return false;
    }
    if (Array.isArray(args) && args.includes(url)) {
        return true;
    }
    if (typeof command !== "string") {
        return false;
    }

    return commandIncludesUrl(command, url);
}

function commandIncludesUrl(command: string, url: string): boolean {
    const urlIndex = command.indexOf(url);
    if (urlIndex === -1) {
        return false;
    }

    const nextCharacter = command.charAt(urlIndex + url.length);
    return !/[\w/?#.:-]/.test(nextCharacter);
}

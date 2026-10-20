import { existsSync } from "node:fs";
import type { ProviderContext } from "../../../../core/ports.js";
import { isObject } from "../../../../domain/text.js";
import { izborUrl } from "../../../../domain/wire.js";
import { HOOK_EVENT_NAMES, type HookEventName } from "../payload.js";
import { groupHolds, isIzborHook, izborHookEntry } from "./hookEntry.js";
import { keepFirst, settingsOf, settingsText, withoutEmptied } from "./hookSettings.js";
import { checkoutOf, type FileOwnership, readSettingsFile, settingsFileOf } from "./projectFiles.js";

export { HOOK_EVENT_NAMES };

const EVENT_LIMIT_S = 2;

export const eventHookEntry = (runner: ProviderContext["hookRunner"], port: number) =>
    izborHookEntry(runner, izborHookUrl(port), EVENT_LIMIT_S, false);

export function missingIzborHooks(settings: unknown, port: number): HookEventName[] {
    const url = izborHookUrl(port);
    const hooks = isObject(settings) ? settings.hooks : undefined;
    return HOOK_EVENT_NAMES.filter((name) => !(isObject(hooks) && holdsIzborHook(hooks[name], url)));
}

export function izborHooksAt(cwd: string, port: number, platform: FileOwnership): boolean {
    const checkout = checkoutOf(cwd, platform);
    const settings = readSettingsFile(settingsFileOf(checkout));
    return missingIzborHooks(settings, port).length === 0;
}

export function mergeIzborHooks(text: string | null, port: number, runner: ProviderContext["hookRunner"]): HooksMerge {
    const read = settingsOf(text);
    if ("refused" in read) {
        return read;
    }

    const { settings } = read;
    const url = izborHookUrl(port);
    const entry = eventHookEntry(runner, port);
    const hooks = settings.hooks ?? {};
    let changed = false;
    for (const name of HOOK_EVENT_NAMES) {
        const list = hooks[name] ?? [];
        const { list: updated, found } = keepFirst(list, (hook) => isIzborHook(hook, url), entry);
        if (!found) {
            hooks[name] = list;
            list.push({ hooks: [entry] });
        } else if (JSON.stringify(updated) === JSON.stringify(list)) {
            continue;
        } else {
            hooks[name] = updated;
        }
        changed = true;
    }

    if (!changed) {
        return { already: true };
    }
    settings.hooks = hooks;
    return { text: settingsText(settings) };
}

export function removeIzborHooks(text: string | null, port: number): HooksRemove {
    const read = settingsOf(text);
    if ("refused" in read) {
        return read;
    }

    const { settings } = read;
    const isIzbor = (hook: unknown) => isIzborHook(hook, izborHookUrl(port));
    const hooks = settings.hooks;
    const names = HOOK_EVENT_NAMES.filter((name) => hooks?.[name]?.some((group) => groupHolds(group, isIzbor)));
    if (!hooks || names.length === 0) {
        return { none: true };
    }

    for (const name of names) {
        const remainingGroups = removeFromMatchingGroups(hooks[name]!, isIzbor);
        if (remainingGroups.length > 0) {
            hooks[name] = remainingGroups;
        } else {
            delete hooks[name];
        }
    }
    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }
    return { text: settingsText(settings) };
}

const izborHookUrl = (port: number) => `${izborUrl(port)}/hook`;

function holdsIzborHook(groups: unknown, url: string): boolean {
    if (!Array.isArray(groups)) {
        return false;
    }
    return groups.some((group) => groupHolds(group, (hook) => isInstalledIzborHook(hook, url)));
}

function isInstalledIzborHook(hook: unknown, url: string): boolean {
    if (!isIzborHook(hook, url)) {
        return false;
    }
    if (!isObject(hook) || !Array.isArray(hook.args)) {
        return true;
    }
    return existsSync(String(hook.args[0]));
}

function removeFromMatchingGroups(list: unknown[], isIzbor: (hook: unknown) => boolean): unknown[] {
    return list.flatMap((group) => {
        if (!groupHolds(group, isIzbor)) {
            return [group];
        }
        return withoutEmptied([group], (hook) => (isIzbor(hook) ? [] : [hook]));
    });
}

type HooksMerge = { text: string } | { already: true } | { refused: string };

type HooksRemove = { text: string } | { none: true } | { refused: string };

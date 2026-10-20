import { isObject, readJson } from "../../../../domain/text.js";
import { HOOK_EVENT_NAMES, type HookEventName } from "../payload.js";

export const NOT_JSON = "is not valid JSON";
export const NOT_AN_OBJECT = "is not a JSON object";

export function settingsOf(text: string | null): { settings: Settings } | { refused: string } {
    const settings = text === null ? {} : readJson(text);
    if (settings === undefined) {
        return { refused: NOT_JSON };
    }
    if (!isRecord(settings)) {
        return { refused: NOT_AN_OBJECT };
    }
    if ("hooks" in settings && !isRecord(settings.hooks)) {
        return { refused: 'has "hooks" that is not an object' };
    }

    const hooks = isRecord(settings.hooks) ? settings.hooks : {};
    for (const name of HOOK_EVENT_NAMES) {
        if (name in hooks && !Array.isArray(hooks[name])) {
            return { refused: `has "hooks.${name}" that is not a list` };
        }
    }

    return { settings: settings as Settings };
}

export const settingsText = (settings: unknown) => `${JSON.stringify(settings, null, 2)}\n`;

export function withoutEmptied(list: unknown[], changeHook: (hook: unknown) => unknown[]): unknown[] {
    return list.flatMap((group) => {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
            return [group];
        }

        const remainingHooks = group.hooks.flatMap(changeHook);
        if (remainingHooks.length === 0 && Object.keys(group).length === 1) {
            return [];
        }
        return [{ ...group, hooks: remainingHooks }];
    });
}

export function keepFirst(
    list: unknown[],
    isOurs: (hook: unknown) => boolean,
    entry: unknown,
): { list: unknown[]; found: boolean } {
    let found = false;
    const kept = withoutEmptied(list, (hook) => {
        if (!isOurs(hook)) {
            return [hook];
        }
        if (found) {
            return [];
        }

        found = true;
        return [entry];
    });
    return { list: kept, found };
}

const isRecord = (value: unknown): value is Record<string, unknown> => isObject(value) && !Array.isArray(value);

type Settings = Record<string, unknown> & {
    hooks?: Record<string, unknown> & Partial<Record<HookEventName, unknown[]>>;
};

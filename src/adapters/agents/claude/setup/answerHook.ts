import type { ProviderContext } from "../../../../core/ports.js";
import { HOLD_LIMIT_MS } from "../../../../domain/answer.js";
import { isObject } from "../../../../domain/text.js";
import { izborUrl } from "../../../../domain/wire.js";
import { groupHolds, isIzborHook, izborHookEntry } from "./hookEntry.js";
import { keepFirst, settingsOf, settingsText, withoutEmptied } from "./hookSettings.js";
import { checkoutOf, type FileOwnership, readSettingsFile, settingsFileOf } from "./projectFiles.js";

const ANSWER_EVENT = "PermissionRequest";

const ANSWER_LIMIT_S = HOLD_LIMIT_MS / 1000 + 30;

export const ANSWER_HOOK_TIMEOUT_S = ANSWER_LIMIT_S + 30;

export const answerHookUrl = (port: number) => `${izborUrl(port)}/hook/answer`;

export const answerHookEntry = (runner: ProviderContext["hookRunner"], port: number) => ({
    ...izborHookEntry(runner, answerHookUrl(port), ANSWER_LIMIT_S, true),
    timeout: ANSWER_HOOK_TIMEOUT_S,
});

export function mergeAnswerHook(
    text: string | null,
    port: number,
    runner: ProviderContext["hookRunner"],
): AnswerHookMerge {
    const parsed = settingsOf(text);
    if ("refused" in parsed) {
        return parsed;
    }

    const { settings } = parsed;
    const entry = answerHookEntry(runner, port);
    const isAnswer = (hook: unknown) => isIzborHook(hook, answerHookUrl(port));

    settings.hooks ??= {};
    const hooks = settings.hooks;
    hooks[ANSWER_EVENT] ??= [];
    const list = hooks[ANSWER_EVENT];
    const existing = list.filter(holdsAnswerHook(port)).flatMap((group) => group.hooks.filter(isAnswer));

    if (existing.length === 0) {
        list.push({ hooks: [entry] });
        return { text: settingsText(settings), done: "added" };
    }
    if (existing.length === 1 && JSON.stringify(existing[0]) === JSON.stringify(entry)) {
        return { done: "already" };
    }

    hooks[ANSWER_EVENT] = keepFirst(list, isAnswer, entry).list;
    return { text: settingsText(settings), done: "updated" };
}

export function removeAnswerHook(text: string | null, port: number): AnswerHookRemove {
    const parsed = settingsOf(text);
    if ("refused" in parsed) {
        return parsed;
    }

    const { settings } = parsed;
    const hooks = settings.hooks;
    const list = hooks?.[ANSWER_EVENT];
    if (!hooks || !list?.some(holdsAnswerHook(port))) {
        return { done: "none" };
    }

    const remaining = withoutEmptied(list, (hook) => (isIzborHook(hook, answerHookUrl(port)) ? [] : [hook]));
    if (remaining.length > 0) {
        hooks[ANSWER_EVENT] = remaining;
    } else {
        delete hooks[ANSWER_EVENT];
    }
    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }

    return { text: settingsText(settings), done: "removed" };
}

export function answerHookAt(cwd: string, port: number, platform: FileOwnership): boolean {
    let settings: unknown;
    try {
        const checkout = checkoutOf(cwd, platform);
        const file = settingsFileOf(checkout);
        settings = readSettingsFile(file);
    } catch {
        return false;
    }

    const list = isObject(settings) && isObject(settings.hooks) ? settings.hooks[ANSWER_EVENT] : undefined;
    return Array.isArray(list) && list.some(holdsAnswerHook(port));
}

const holdsAnswerHook = (port: number) => (group: unknown) =>
    groupHolds(group, (hook) => isIzborHook(hook, answerHookUrl(port)));

type AnswerHookMerge = { text: string; done: "added" | "updated" } | { done: "already" } | { refused: string };

type AnswerHookRemove = { text: string; done: "removed" } | { done: "none" } | { refused: string };

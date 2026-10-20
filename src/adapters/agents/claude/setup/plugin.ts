import { resolve } from "node:path";
import type { Platform, ProviderContext, Ran } from "../../../../core/ports.js";
import type { ActingChange, HooksRequest } from "../../../../domain/projectSetup.js";
import { IZBOR_PLUGIN } from "../../../../domain/prompt.js";
import { isObject, readJson, upperDrive } from "../../../../domain/text.js";
import { CLAUDE_COMMAND } from "../agentsList.js";
import { mergeAnswerHook, removeAnswerHook } from "./answerHook.js";
import { readSettingsFile } from "./projectFiles.js";
import { editProjectSettings, locateProject } from "./projectSettings.js";

export type RunPluginCommand = (args: string[], cwd: string) => Promise<PluginCommandResult>;

const TIMEOUT_MS = 60_000;
const IZBOR_MARKETPLACE = "izbor";
const IZBOR_PLUGIN_ID = `${IZBOR_PLUGIN}@${IZBOR_MARKETPLACE}`;

export function createPluginCommand({ run }: { run: Platform["run"] }): RunPluginCommand {
    return async (args: string[], cwd: string): Promise<PluginCommandResult> => {
        const result = await run(CLAUDE_COMMAND, ["plugin", ...args, "--json"], { timeoutMs: TIMEOUT_MS, cwd });

        switch (result.outcome) {
            case "not_started":
                return { outcome: "failed", message: `cannot run ${CLAUDE_COMMAND}: ${result.why}` };
            case "cancelled":
            case "timed_out":
                return {
                    outcome: "failed",
                    message: `${CLAUDE_COMMAND} plugin gave no answer in ${TIMEOUT_MS / 1000} s`,
                };
            case "exited":
                return exitedPluginResult(result);
            default:
                return result satisfies never;
        }
    };
}

export async function changeActing({
    change,
    folder,
    port,
    home,
    platform,
    pluginDir,
    run,
    runner,
}: ChangeActingRequest): Promise<ActingChange> {
    const located = locateProject({ folder, home, platform });
    if ("refused" in located) {
        return located;
    }

    const edit = (text: string | null) =>
        change === "add" ? mergeAnswerHook(text, port, runner) : removeAnswerHook(text, port);
    const preview = editProjectSettings(platform, located, edit, { preview: true });
    if ("refused" in preview) {
        return preview;
    }

    const before = readPluginSettings(located.file);
    const pluginFailure = await (change === "add"
        ? installPlugin(run, pluginDir, located.checkout, before)
        : uninstallPlugin(run, located.checkout));
    if (pluginFailure !== undefined) {
        return { refused: "plugin", checkout: located.checkout, why: pluginFailure };
    }

    const edited = editProjectSettings(platform, located, edit);
    if ("refused" in edited) {
        return edited;
    }
    return includePluginChange(change, before.enabled, edited);
}

function exitedPluginResult(result: Extract<Ran, { outcome: "exited" }>): PluginCommandResult {
    const parsed = readPluginResult(result.stdout);
    if (parsed !== undefined) {
        return parsed;
    }
    if (result.code === 0) {
        return { outcome: "ok" };
    }

    const exitReason = result.code === null ? result.signal : `code ${result.code}`;
    const message = result.stderr.trim() || result.stdout.trim() || `exited with ${exitReason}`;
    return { outcome: "failed", message };
}

function readPluginResult(stdout: string): PluginCommandResult | undefined {
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    const parsed = readJson(lastLine);
    if (!isObject(parsed)) {
        return undefined;
    }

    switch (parsed.outcome) {
        case "ok":
            return { outcome: "ok" };
        case "failed": {
            const message = typeof parsed.message === "string" ? parsed.message : lastLine;
            const result: PluginCommandResult = { outcome: "failed", message };
            if (typeof parsed.failureCode === "string") {
                result.failureCode = parsed.failureCode;
            }
            return result;
        }
        default:
            return undefined;
    }
}

function readPluginSettings(file: string): PluginSettings {
    const settings = readSettingsFile(file);
    if (!isObject(settings)) {
        return { marketplaceAt: undefined, enabled: false };
    }

    const marketplaces = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
    const marketplace = marketplaces[IZBOR_MARKETPLACE];
    const source = isObject(marketplace) && isObject(marketplace.source) ? marketplace.source : {};
    const enabledPlugins = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
    return {
        marketplaceAt: typeof source.path === "string" ? source.path : undefined,
        enabled: enabledPlugins[IZBOR_PLUGIN_ID] === true,
    };
}

const samePath = (marketplaceAt: string | undefined, pluginDir: string) =>
    marketplaceAt !== undefined && resolve(upperDrive(marketplaceAt)) === resolve(upperDrive(pluginDir));

async function installPlugin(
    run: RunPluginCommand,
    pluginDir: string,
    checkout: string,
    { marketplaceAt, enabled }: PluginSettings,
): Promise<string | undefined> {
    const steps: string[][] = [];
    if (!samePath(marketplaceAt, pluginDir)) {
        steps.push(["marketplace", "add", pluginDir, "--scope", "local"]);
    }
    if (!enabled) {
        steps.push(["install", IZBOR_PLUGIN_ID, "--scope", "local"]);
    }

    for (const args of steps) {
        const result = await run(args, checkout);
        if (result.outcome === "failed") {
            return result.message;
        }
    }
    return undefined;
}

async function uninstallPlugin(run: RunPluginCommand, checkout: string): Promise<string | undefined> {
    const steps: [string[], string][] = [
        [["uninstall", IZBOR_PLUGIN_ID, "--scope", "local"], "not_installed"],
        [["marketplace", "remove", IZBOR_MARKETPLACE, "--scope", "local"], "not_configured"],
    ];
    for (const [args, absentCode] of steps) {
        const result = await run(args, checkout);
        if (result.outcome === "failed" && result.failureCode !== absentCode) {
            return result.message;
        }
    }
    return undefined;
}

function includePluginChange(
    change: HooksRequest["change"],
    pluginWasEnabled: boolean,
    edited: Extract<ActingChange, { done: string }>,
): ActingChange {
    switch (change) {
        case "add":
            if (edited.done === "already" && !pluginWasEnabled) {
                return { ...edited, done: "added" };
            }
            break;
        case "remove":
            if (edited.done === "none" && pluginWasEnabled) {
                return { ...edited, done: "removed" };
            }
            break;
    }
    return edited;
}

type PluginCommandResult = { outcome: "ok" } | { outcome: "failed"; message: string; failureCode?: string };

type PluginSettings = { marketplaceAt: string | undefined; enabled: boolean };

type ChangeActingRequest = HooksRequest & {
    home: string;
    platform: Pick<Platform, "readRegularFile" | "replaceFile" | "ownsFilesByUid">;
    pluginDir: string;
    run: RunPluginCommand;
    runner: ProviderContext["hookRunner"];
};

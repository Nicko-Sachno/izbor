import type { CreateProject, Platform, ProviderContext } from "../../../../core/ports.js";
import type { HooksChange, HooksRequest } from "../../../../domain/projectSetup.js";
import { answerHookAt } from "./answerHook.js";
import { mergeIzborHooks, removeIzborHooks } from "./izborHooks.js";
import { changeActing, createPluginCommand } from "./plugin.js";
import { changeProjectSettings } from "./projectSettings.js";

export function changeIzborHooks({ change, folder, port, home, platform, runner }: ChangeHooksRequest): HooksChange {
    return changeProjectSettings({
        folder,
        home,
        platform,
        edit(text) {
            switch (change) {
                case "remove":
                    return removeHooks(text, port);
                case "add":
                    return addHooks(text, port, runner);
            }
        },
    });
}

export const createClaudeProject: CreateProject = ({ platform, home, pluginDir, hookRunner: runner }) => {
    const run = createPluginCommand({ run: platform.run });
    return {
        changeHooks: (request) => changeIzborHooks({ ...request, home, platform, runner }),
        changeActing: (request) => changeActing({ ...request, home, platform, pluginDir, run, runner }),
        isActing: (cwd, port) => answerHookAt(cwd, port, platform),
    };
};

function addHooks(text: string | null, port: number, runner: ProviderContext["hookRunner"]): HooksEdit {
    const result = mergeIzborHooks(text, port, runner);
    if ("already" in result) {
        return { done: "already" };
    }
    if ("text" in result) {
        return { ...result, done: "added" };
    }
    return result;
}

function removeHooks(text: string | null, port: number): HooksEdit {
    const result = removeIzborHooks(text, port);
    if ("none" in result) {
        return { done: "none" };
    }
    if ("text" in result) {
        return { ...result, done: "removed" };
    }
    return result;
}

type ChangeHooksRequest = HooksRequest & {
    home: string;
    platform: Pick<Platform, "readRegularFile" | "replaceFile" | "ownsFilesByUid">;
    runner: ProviderContext["hookRunner"];
};

type HooksEdit = { text: string; done: "added" | "removed" } | { done: "already" | "none" } | { refused: string };

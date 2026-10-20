import type { CliArgs } from "../args.js";
import { IZBOR_PORT } from "../../config.js";
import type { ActingWriter } from "../../domain/projectSetup.js";
import { type CommandReport, settingsReport } from "./report.js";

const PLUGIN_ENABLED =
    "Sessions there, running ones too, can take answers from Izbor from their next request; new sessions take prompts from Izbor too, a running one after /reload-plugins.";
const PLUGIN_DISABLED = "Sessions there, running ones too, answer and take prompts only in Claude Code from now on.";

export async function runPlugin(
    { folder, port, remove }: PluginArgs,
    { changeActing, home }: PluginDeps,
): Promise<CommandReport<0 | 1>> {
    const portSuffix = port === IZBOR_PORT ? "" : ` for port ${port}`;
    const result = await changeActing({ change: remove ? "remove" : "add", folder: folder ?? ".", port });

    if ("refused" in result && result.refused === "plugin") {
        const action = remove ? "remove its plugin from" : "install its plugin in";
        return { lines: [`Izbor could not ${action} ${result.checkout}: ${result.why}`], code: 1 };
    }

    return settingsReport("izbor plugin", result, home, (done, file) => {
        switch (done) {
            case "added":
                return `Izbor's plugin and answer hook${portSuffix} are in ${file}. ${PLUGIN_ENABLED}`;
            case "updated":
                return `Updated Izbor's answer hook${portSuffix} in ${file}, beside its plugin. ${PLUGIN_ENABLED}`;
            case "removed":
                return `Removed Izbor's plugin and answer hook${portSuffix} from ${file}. ${PLUGIN_DISABLED}`;
            case "already":
                return `${file} already has Izbor's plugin and answer hook.`;
            case "none":
                return `${file} has no Izbor plugin or answer hook${portSuffix}.`;
        }
    });
}

type PluginArgs = Extract<CliArgs, { command: "hooks" | "plugin" }>;

type PluginDeps = {
    changeActing: ActingWriter;
    home: string;
};

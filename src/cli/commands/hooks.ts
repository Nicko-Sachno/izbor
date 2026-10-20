import type { CliArgs } from "../args.js";
import { IZBOR_PORT, pluginOffer } from "../../config.js";
import type { HooksWriter, ProjectSetup } from "../../domain/projectSetup.js";
import { type CommandReport, settingsReport } from "./report.js";

const HOOKS_ADDED = "Sessions there, running ones too, post to Izbor from their next hook.";
const HOOKS_REMOVED = "Sessions there, running ones too, stop posting to Izbor from their next hook.";

export async function runHooks(
    { folder, port, remove }: HooksArgs,
    { changeHooks, isActing, home }: HooksDeps,
): Promise<CommandReport<0 | 1>> {
    const portSuffix = port === IZBOR_PORT ? "" : ` for port ${port}`;
    const result = changeHooks({ change: remove ? "remove" : "add", folder: folder ?? ".", port });
    const acting = "done" in result && isActing(result.checkout, port);
    const offer = "done" in result ? pluginOffer(result.checkout, port) : "";

    return settingsReport("izbor hooks", result, home, (done, file) => {
        switch (done) {
            case "added": {
                const added = `Izbor's hooks${portSuffix} are in ${file}. ${HOOKS_ADDED}`;
                return acting ? added : [added, offer];
            }
            case "removed":
                return `Removed Izbor's hooks${portSuffix} from ${file}. ${HOOKS_REMOVED}`;
            case "already":
                return `${file} already has Izbor's hooks.`;
            case "none":
                return `${file} has no Izbor hooks${portSuffix}.`;
        }
    });
}

type HooksArgs = Extract<CliArgs, { command: "hooks" | "plugin" }>;

type HooksDeps = {
    changeHooks: HooksWriter;
    isActing: ProjectSetup["isActing"];
    home: string;
};

import { basename } from "node:path";
import { NOT_AN_OBJECT, NOT_JSON } from "../adapters/agents/claude/setup/hookSettings.js";
import { tilde } from "../config.js";
import type { ActingChange, HooksChange, SettingsChange } from "../domain/projectSetup.js";

function refusal(change: Extract<SettingsChange<never>, { refused: string }>, home: string): string {
    if (change.refused === "no folder") return `no folder ${tilde(change.folder, home)}`;
    if (change.refused === "no access") return `Izbor may not look in ${tilde(change.folder, home)}`;
    if (change.refused === "home folder") return "not in your home folder or a drive root";
    if (change.refused === "link") return `${basename(change.link)} is a link`;
    if (change.refused === "write") return "could not write settings.local.json";
    if (change.why === NOT_JSON) return "settings.local.json is not valid JSON";
    if (change.why === NOT_AN_OBJECT) return "settings.local.json is not an object";
    return 'odd "hooks" in settings.local.json';
}

export function hooksFeedback(change: HooksChange, home: string): string {
    if ("refused" in change) return `Could not add hooks: ${refusal(change, home)}.`;
    const name = basename(change.checkout);
    if (change.done === "added") return `Added Izbor's hooks to ${name}.`;
    return `${name} already has Izbor's hooks.`;
}

export function actingFeedback(change: ActingChange, home: string): string {
    if ("refused" in change) {
        const cause = change.refused === "plugin" ? "claude could not install it" : refusal(change, home);
        return `Could not add the plugin: ${cause}.`;
    }
    const name = basename(change.checkout);
    if (change.done === "added") return `Added Izbor's plugin to ${name}.`;
    if (change.done === "updated") return `Updated Izbor's answer hook in ${name}.`;
    return `${name} already has Izbor's plugin.`;
}

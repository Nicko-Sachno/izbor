import type { Platform } from "../../core/ports.js";
import { darwin } from "./darwin.js";
import { win32 } from "./win32.js";

export function selectPlatform(name: NodeJS.Platform): Platform {
    switch (name) {
        case "darwin":
            return darwin;
        case "win32":
            return win32;
        default:
            throw new Error(`Izbor does not run on ${name} yet.`);
    }
}

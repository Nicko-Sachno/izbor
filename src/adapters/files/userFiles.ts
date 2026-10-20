import { join } from "node:path";
import type { Platform } from "../../core/ports.js";

export const sendKeyFile = (dir: string, port: number) => join(dir, `send-key-${port}`);

export const portFile = (dir: string) => join(dir, "port");

export function writeUserFiles(
    platform: Pick<Platform, "writePrivateFile" | "replaceFile">,
    dir: string,
    { key, port }: { key: string; port: number },
): void {
    platform.writePrivateFile(sendKeyFile(dir, port), `${key}\n`);
    platform.replaceFile(portFile(dir), `${port}\n`);
}

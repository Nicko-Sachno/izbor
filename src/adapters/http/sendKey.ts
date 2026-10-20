import { randomBytes, timingSafeEqual } from "node:crypto";

export const newSendKey = () => randomBytes(32).toString("hex");

export function showsSendKey(authorization: string | undefined, key: string): boolean {
    const shown = Buffer.from(/^Bearer (\S+)$/.exec(authorization?.trim() ?? "")?.[1] ?? "");
    const wanted = Buffer.from(key);
    return shown.length === wanted.length && timingSafeEqual(shown, wanted);
}

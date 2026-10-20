import type { HookRecord, IzborRecord, StatusRecord } from "../domain/records.js";

export type HookFile = {
    append(record: HookRecord | IzborRecord | StatusRecord): Promise<void>;
};

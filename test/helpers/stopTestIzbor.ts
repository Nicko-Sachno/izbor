import assert from "node:assert/strict";
import { createIzborClient } from "../../src/adapters/izbor/client.js";
import { readSendKey } from "./answerHook.js";

export async function stopTestIzbor(port: number): Promise<void> {
    const client = createIzborClient({ port });
    const izbor = await client.getIzbor();
    assert.ok("up" in izbor && izbor.up !== "older", `no Izbor answers GET /izbor on ${port}`);
    const key = await readSendKey(izbor.up.sendKeyPath);
    assert.equal(await client.requestStop(key), true, `the Izbor on ${port} did not take the stop request`);
}

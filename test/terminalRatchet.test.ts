import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measure, overCeilings, terminalFiles } from "../scripts/terminal-metrics.js";

const ratchet = JSON.parse(readFileSync(new URL("terminal-ratchet.json", import.meta.url), "utf8")) as {
    ceilings: Record<string, number>;
    functions: Record<string, number>;
};
const metrics = measure(terminalFiles());

test("src/terminal stays within every ceiling in test/terminal-ratchet.json", (t) => {
    for (const [id, ceiling] of Object.entries(ratchet.ceilings)) {
        const now = metrics.ceilings[id];
        if (now !== undefined && now < ceiling)
            t.diagnostic(`${id} is ${now}, below its ceiling ${ceiling}: lower it with --lower-ratchet.`);
    }
    assert.deepEqual(overCeilings(metrics, ratchet), []);
});

test("every measured id has a ceiling and every ceiling a metric", () => {
    assert.deepEqual(Object.keys(ratchet.ceilings).sort(), Object.keys(metrics.ceilings).sort());
});

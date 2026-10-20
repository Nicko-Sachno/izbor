import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    measureService,
    overCeilings,
    serviceFiles,
    serviceTestFiles,
    shippedFiles,
} from "../scripts/terminal-metrics.js";

const RATCHET = "test/service-ratchet.json";
const ratchet = JSON.parse(readFileSync(new URL("service-ratchet.json", import.meta.url), "utf8")) as {
    ceilings: Record<string, number>;
    functions: Record<string, number>;
};
const metrics = measureService(serviceFiles(), serviceTestFiles(), shippedFiles());

test("the service, and the two greps of what else Izbor ships, stay within every ceiling in test/service-ratchet.json", (t) => {
    for (const [id, ceiling] of Object.entries(ratchet.ceilings)) {
        const now = metrics.ceilings[id];
        if (now !== undefined && now < ceiling)
            t.diagnostic(`${id} is ${now}, below its ceiling ${ceiling}: lower it with --service --lower-ratchet.`);
    }
    assert.deepEqual(overCeilings(metrics, ratchet, RATCHET), []);
});

test("every measured id of the service has a ceiling and every ceiling a metric", () => {
    assert.deepEqual(Object.keys(ratchet.ceilings).sort(), Object.keys(metrics.ceilings).sort());
});

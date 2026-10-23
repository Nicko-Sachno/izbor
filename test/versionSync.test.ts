import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const topReleasedHeading = (changelog: string): string | undefined =>
    /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(changelog)?.[1];

test("package.json, the lockfile, plugin.json and the top CHANGELOG release carry the same version", () => {
    const version = JSON.parse(read("package.json")).version;
    assert.match(version, /^\d+\.\d+\.\d+/);
    const lock = JSON.parse(read("package-lock.json"));
    assert.deepEqual(
        {
            lockfile: lock.version,
            lockfileRoot: lock.packages[""].version,
            plugin: JSON.parse(read("plugin/.claude-plugin/plugin.json")).version,
            changelog: topReleasedHeading(read("CHANGELOG.md")),
        },
        { lockfile: version, lockfileRoot: version, plugin: version, changelog: version },
    );
});

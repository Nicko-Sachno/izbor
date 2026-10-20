import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

test("izbor --help prints test/help.txt, byte for byte, and loads neither Ink nor React", (t) => {
    const probe = `data:text/javascript,import { registerHooks } from "node:module";
        const heavy = [];
        registerHooks({
            resolve(specifier, context, next) {
                const resolved = next(specifier, context);
                if (/\\/node_modules\\/(ink|react|yoga-layout)\\//.test(resolved.url)) heavy.push(resolved.url);
                return resolved;
            },
        });
        process.on("exit", () => process.stderr.write(JSON.stringify(heavy)));`;
    const { status, stdout, stderr } = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", probe, "src/cli/main.ts", "--help"],
        { encoding: "utf8" },
    );
    assert.deepEqual([status, stderr], [0, "[]"], "stderr holds only the probe's list of Ink and React files loaded");
    t.assert.fileSnapshot(stdout, join(import.meta.dirname, "help.txt"), { serializers: [(text) => text] });
});

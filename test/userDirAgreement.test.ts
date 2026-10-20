import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { userDirOf } from "../plugin/hooks/izbor.js";
import { IZBOR_PLUGIN_DIR, izborUserDir } from "../src/config.js";
import { LOOPBACK } from "../src/domain/wire.js";

const slashed = (path: string) => path.replaceAll("\\", "/");

test("Izbor and its plugin agree on the per-user folder in every environment: LOCALAPPDATA when set and not empty, else HOME, else USERPROFILE", () => {
    const homes: Record<string, string | undefined>[] = [
        { HOME: "/Users/someone" },
        { USERPROFILE: "C:\\Users\\someone" },
        { HOME: "/home/someone", USERPROFILE: "C:\\Users\\someone" },
    ];
    const localAppData = [undefined, "", "C:\\Users\\someone\\AppData\\Local"];
    for (const home of homes) {
        for (const LOCALAPPDATA of localAppData) {
            const env: Record<string, string | undefined> = { ...home, LOCALAPPDATA };
            assert.equal(
                slashed(userDirOf(env)),
                slashed(izborUserDir(env, env.HOME ?? env.USERPROFILE!)),
                JSON.stringify(env),
            );
        }
    }
});

test("IZBOR_USER_DIR, the test seam, names the plugin's per-user folder; empty, it counts as unset", () => {
    assert.equal(userDirOf({ IZBOR_USER_DIR: "/tmp/izbor-user", HOME: "/Users/someone" }), "/tmp/izbor-user");
    assert.equal(userDirOf({ IZBOR_USER_DIR: "", HOME: "/Users/someone" }), "/Users/someone/.config/izbor");
});

test("the plugin asks Izbor at LOOPBACK, the address Izbor listens on", async () => {
    const source = await readFile(join(IZBOR_PLUGIN_DIR, "hooks", "izbor.js"), "utf8");
    const addresses = [...source.matchAll(/http:\/\/([^:/$`]+)/g)].map((match) => match[1]);
    assert.deepEqual(addresses, [LOOPBACK]);
});

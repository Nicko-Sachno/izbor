import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_DIR } from "../src/config.js";
import { skipOnWindows } from "./helpers/fakeCommand.js";

const MACOS_ONLY = skipOnWindows("macOS-only install script");
const SCRIPT = join(PROJECT_DIR, "scripts", "install-izbor.sh");
const NPM_LINK_TARGET = "../lib/node_modules/izbor/bin/izbor.js";
const OTHER_SCRIPT = "#!/bin/sh\necho another tool\n";
const CLAUDE_SETTINGS = '{ "hooks": { "Notification": [{ "command": "existing hook" }] } }\n';

async function installSetup() {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "izbor-install-")));
    const home = join(root, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    await writeFile(settings, CLAUDE_SETTINGS);
    const prefix = join(root, "prefix");
    const linkDir = join(prefix, "bin");
    await mkdir(linkDir, { recursive: true });
    await mkdir(join(prefix, "lib", "node_modules"), { recursive: true });
    // Another tool's command in the same link folder must survive the installation.
    const other = join(root, "other-tool");
    await writeFile(other, OTHER_SCRIPT, { mode: 0o755 });
    await symlink(other, join(linkDir, "other-tool"));
    const npmDir = join(root, "npm");
    await mkdir(npmDir);
    const calls = join(npmDir, "calls");
    await writeFile(
        join(npmDir, "npm"),
        [
            "#!/bin/sh",
            'if [ "$*" = "prefix --global" ]; then printf "%s\\n" "$FAKE_NPM_PREFIX"; exit; fi',
            'printf "%s: %s\\n" "$PWD" "$*" >> "$FAKE_NPM_CALLS"',
            'if [ "$*" = "${FAKE_NPM_FAIL:-}" ]; then exit 7; fi',
            'if [ "$1" = link ]; then',
            '  if [ -z "${FAKE_NPM_LINK_TARGET:-}" ]; then',
            '    ln -sfn "$PWD" "$IZBOR_LINK_DIR/../lib/node_modules/izbor"',
            `    ln -sfn ${NPM_LINK_TARGET} "$IZBOR_LINK_DIR/izbor"`,
            '  elif [ "$FAKE_NPM_LINK_TARGET" != none ]; then',
            '    ln -sfn "$FAKE_NPM_LINK_TARGET" "$IZBOR_LINK_DIR/izbor"',
            "  fi",
            "fi",
            "",
        ].join("\n"),
        { mode: 0o755 },
    );
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    const checkout = join(root, "checkout with spaces");
    await mkdir(join(checkout, "bin"), { recursive: true });
    await writeFile(join(checkout, "package.json"), '{ "name": "izbor", "bin": { "izbor": "bin/izbor.js" } }\n');
    const bin = join(checkout, "bin", "izbor.js");
    await writeFile(bin, "#!/usr/bin/env node\n", { mode: 0o755 });
    await mkdir(join(checkout, "scripts"));
    const script = join(checkout, "scripts", "install-izbor.sh");
    await copyFile(SCRIPT, script);
    return {
        root,
        bin,
        script,
        checkout,
        linkDir,
        link: join(linkDir, "izbor"),
        cwd,
        env: {
            HOME: home,
            IZBOR_LINK_DIR: linkDir,
            FAKE_NPM_PREFIX: prefix,
            FAKE_NPM_CALLS: calls,
            PATH: `${npmDir}:${linkDir}:/usr/bin:/bin`,
        },
        npmCalls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean),
        linkFolder: () => readdir(linkDir).then((names) => names.sort()),
        previousInstallationUntouched: async () => {
            assert.equal(await readlink(join(linkDir, "other-tool")), other);
            assert.equal(await readFile(other, "utf8"), OTHER_SCRIPT);
            assert.equal(await readFile(settings, "utf8"), CLAUDE_SETTINGS);
            assert.deepEqual(await readdir(join(checkout, "scripts")), ["install-izbor.sh"]);
        },
    };
}

type Setup = Awaited<ReturnType<typeof installSetup>>;

async function runInstall(setup: Setup, args: string[] = [], env: Record<string, string> = {}) {
    const child = spawn("bash", [setup.script, ...args], {
        cwd: setup.cwd,
        env: { ...setup.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
}

test("installer is executable, parses, explains its options and rejects unknown arguments", MACOS_ONLY, async () => {
    assert.ok((await stat(SCRIPT)).mode & 0o111);
    const parse = spawn("bash", ["-n", SCRIPT], { stdio: "ignore" });
    assert.deepEqual(await once(parse, "exit"), [0, null]);
    const s = await installSetup();
    const help = await runInstall(s, ["--help"]);
    assert.deepEqual([help.code, help.stderr], [0, ""]);
    assert.match(help.stdout, /^usage: scripts\/install-izbor\.sh \[--dry-run\]\n/);
    assert.ok(help.stdout.includes("IZBOR_LINK_DIR"));
    for (const args of [["--force"], ["--dry-run", "extra"]]) {
        const unknown = await runInstall(s, args);
        assert.deepEqual([unknown.code, unknown.stdout], [2, ""]);
        assert.match(unknown.stderr, /^usage: /);
    }
    assert.deepEqual(await s.npmCalls(), []);
    await s.previousInstallationUntouched();
});

test("dry run reports the build, link and verification without npm calls or file changes", MACOS_ONLY, async () => {
    const s = await installSetup();
    const { code, stdout, stderr } = await runInstall(s, ["--dry-run"]);
    assert.deepEqual([code, stderr], [0, ""], stdout);
    assert.ok(stdout.includes("Install Izbor · dry run"));
    assert.ok(stdout.includes(`would check: npm prefix --global uses ${s.linkDir} as its bin folder`));
    assert.ok(stdout.includes(`Building and linking in ${s.checkout}`));
    assert.ok(stdout.includes("would run: npm run build\n  would run: npm link"));
    assert.ok(stdout.includes(`would check: command -v izbor resolves to ${s.bin}`));
    assert.ok(stdout.includes("Dry run: nothing changed."));
    assert.deepEqual(await s.npmCalls(), []);
    assert.deepEqual(await s.linkFolder(), ["other-tool"]);
    assert.deepEqual(await readdir(s.cwd), []);
    await s.previousInstallationUntouched();
});

test(
    "installation runs from any directory, links only izbor and leaves another tool's command intact",
    MACOS_ONLY,
    async () => {
        const s = await installSetup();
        const { code, stdout, stderr } = await runInstall(s);
        assert.deepEqual([code, stderr], [0, ""], stdout);
        assert.deepEqual(await s.npmCalls(), [`${s.checkout}: run build`, `${s.checkout}: link`]);
        assert.equal(await readlink(s.link), NPM_LINK_TARGET);
        assert.equal(realpathSync(s.link), s.bin);
        assert.deepEqual(await s.linkFolder(), ["izbor", "other-tool"]);
        assert.ok(stdout.includes(`Verified: izbor → ${s.link} → ${s.bin}`));
        assert.ok(stdout.includes("To remove this command link: npm unlink -g izbor"));
        assert.deepEqual(await readdir(s.cwd), []);
        await s.previousInstallationUntouched();

        const again = await runInstall(s);
        assert.deepEqual([again.code, again.stderr], [0, ""], again.stdout);
        assert.ok(again.stdout.includes("already linked from this checkout"));
        assert.deepEqual(await s.npmCalls(), [`${s.checkout}: run build`, `${s.checkout}: link`]);
        await s.previousInstallationUntouched();
    },
);

test(
    "existing files and foreign, dangling or wrong-file links are refused without replacement",
    MACOS_ONLY,
    async () => {
        for (const kind of ["file", "foreign", "dangling", "wrong-file"] as const) {
            const s = await installSetup();
            const target = kind === "wrong-file" ? join(s.checkout, "package.json") : join(s.root, "elsewhere");
            if (kind === "file") await writeFile(s.link, "existing command\n");
            else {
                if (kind === "foreign") await writeFile(target, "other program\n");
                await symlink(target, s.link);
            }
            for (const args of [[], ["--dry-run"]]) {
                const { code, stderr } = await runInstall(s, args);
                assert.equal(code, 1, `${kind}: ${stderr}`);
                assert.ok(stderr.includes("Nothing changed"), stderr);
                assert.deepEqual(await s.npmCalls(), []);
                if (kind === "file") assert.equal(await readFile(s.link, "utf8"), "existing command\n");
                else assert.equal(await readlink(s.link), target);
                await s.previousInstallationUntouched();
            }
        }
    },
);

test("a different npm global prefix is refused before building or linking", MACOS_ONLY, async () => {
    const s = await installSetup();
    const other = join(s.root, "other-prefix");
    await mkdir(join(other, "bin"), { recursive: true });
    const { code, stderr } = await runInstall(s, [], { FAKE_NPM_PREFIX: other });
    assert.equal(code, 1, stderr);
    assert.ok(stderr.includes(`npm links commands in ${other}/bin, not ${s.linkDir}`), stderr);
    assert.deepEqual(await s.npmCalls(), []);
    assert.deepEqual(await readdir(join(other, "bin")), []);
    await s.previousInstallationUntouched();
});

test("build or link failures stop later work and preserve the previous installation", MACOS_ONLY, async () => {
    for (const command of ["run build", "link"]) {
        const s = await installSetup();
        const { code, stderr } = await runInstall(s, [], { FAKE_NPM_FAIL: command });
        assert.equal(code, 1, stderr);
        assert.ok(stderr.includes(`npm ${command} failed; nothing after it ran.`), stderr);
        assert.deepEqual(
            await s.npmCalls(),
            command === "run build"
                ? [`${s.checkout}: run build`]
                : [`${s.checkout}: run build`, `${s.checkout}: link`],
        );
        assert.deepEqual(await s.linkFolder(), ["other-tool"]);
        await s.previousInstallationUntouched();
    }
});

test("missing, dangling or incorrect npm links fail verification", MACOS_ONLY, async () => {
    for (const kind of ["none", "dangling", "wrong-file"]) {
        const s = await installSetup();
        const target =
            kind === "none" ? "none" : kind === "dangling" ? join(s.root, "missing") : join(s.checkout, "package.json");
        const { code, stdout, stderr } = await runInstall(s, [], { FAKE_NPM_LINK_TARGET: target });
        assert.equal(code, 1, stderr);
        assert.ok(stderr.includes("izbor is not on PATH") || stderr.includes(`not ${s.bin}`), stderr);
        assert.ok(!stdout.includes("Izbor is installed."), stdout);
        await s.previousInstallationUntouched();
    }
});

test("a shadowing PATH command is detected even when this checkout is already linked", MACOS_ONLY, async () => {
    const s = await installSetup();
    await symlink(s.bin, s.link);
    const shadowDir = join(s.root, "shadow");
    await mkdir(shadowDir);
    await writeFile(join(shadowDir, "izbor"), "#!/bin/sh\n", { mode: 0o755 });
    const { code, stderr } = await runInstall(s, [], { PATH: `${shadowDir}:${s.env.PATH}` });
    assert.equal(code, 1, stderr);
    assert.ok(stderr.includes("Check your PATH"), stderr);
    assert.deepEqual(await s.npmCalls(), []);
    assert.equal(await readlink(s.link), s.bin);
    await s.previousInstallationUntouched();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PROJECT_DIR } from "../src/config.js";
import { IZBOR_BIN, runIzborBin } from "./helpers/bin.js";
import { skipOnWindows } from "./helpers/fakeCommand.js";

const STUB_LINE = "the stub cli ran";

const STUB =
    `const old = process.env.IZBOR_OLD_BUILD;\n` +
    `process.stdout.write(\`${STUB_LINE}\${process.argv.slice(2).map((arg) => " " + arg).join("")}\${old === undefined ? "" : " IZBOR_OLD_BUILD=" + old}\\n\`);\n`;

async function copyOfBin() {
    const dir = await mkdtemp(join(tmpdir(), "izbor-copy-"));
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    await mkdir(join(dir, "bin"));
    const bin = join(dir, "bin", "izbor.js");
    await copyFile(IZBOR_BIN, bin);
    return { dir, bin, real: realpathSync(dir) };
}

async function writeStub(dir: string) {
    await mkdir(join(dir, "dist", "cli"), { recursive: true });
    const stub = join(dir, "dist", "cli", "main.js");
    await writeFile(stub, STUB);
    return stub;
}

const changedAgo = (path: string, secondsAgo: number) =>
    utimes(path, new Date(), new Date(Date.now() - secondsAgo * 1000));

const noSeam = { IZBOR_CLI: undefined };

// Run beside the compiled copy, with no tsx: the built terminal modules load, and the window draws a frame.
const COMPILED_FRAME = `
import { createElement } from "react";
import { renderToString } from "ink";
const { createTerminalController } = await import("./dist/terminal/controller.js");
const { TerminalScreen } = await import("./dist/terminal/screen.js");
const { runTerminal } = await import("./dist/terminal/main.js");
if (typeof runTerminal !== "function") throw new Error("dist/terminal/main.js has no runTerminal");
const list = {
    state: "listed",
    at: new Date().toISOString(),
    sessions: [{ id: "0926995f-4c57-4733-89cf-d0c7226a5cbc", name: "example-api-4c", status: "idle", checkout: "/srv/example-api", hooks: true, acting: false }],
};
const snapshot = { izbor: { state: "up", address: "127.0.0.1:4319" }, list, observations: [] };
const source = {
    getSnapshot: () => snapshot,
    onChange: () => () => {},
    observe: () => "added",
    leave() {},
    refreshSessions: async () => list,
    answer: async () => ({ news: "" }),
    prompt: async () => ({ news: "" }),
    dispose() {},
};
const fail = () => { throw new Error("this frame writes nothing"); };
const app = createTerminalController(source, {
    columns: 80,
    rows: 24,
    home: "/home/me",
    hooks: { port: 4319, write: fail },
    plugin: { port: 4319, change: fail },
    changed() {},
});
const size = { columns: 80, rows: 24 };
process.stdout.write(renderToString(createElement(TerminalScreen, { view: app.view, size, color: false }), size));
app.dispose();
`;

test("the actual compiled entry runs from another cwd without tsx or IZBOR_CLI: --help, --version, and the compiled terminal app draws Home", async (t) => {
    const copy = await copyOfBin();
    t.after(() => rm(copy.dir, { recursive: true, force: true }));
    await symlink(join(PROJECT_DIR, "node_modules"), join(copy.dir, "node_modules"), "junction");
    const run = promisify(execFile);
    await run(
        process.execPath,
        [
            join(PROJECT_DIR, "node_modules", "typescript", "bin", "tsc"),
            "-p",
            join(PROJECT_DIR, "tsconfig.build.json"),
            "--outDir",
            join(copy.dir, "dist"),
        ],
        { timeout: 20_000 },
    );
    const options = {
        cwd: tmpdir(),
        env: { ...process.env, IZBOR_CLI: undefined, NODE_OPTIONS: undefined, IZBOR_PORT: "invalid" },
        timeout: 5_000,
    };
    const help = await run(process.execPath, [copy.bin, "--help"], options);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /^Izbor's terminal app/);
    const version = await run(process.execPath, [copy.bin, "--version"], options);
    assert.equal(version.stderr, "");
    assert.match(version.stdout, /^izbor /);
    const script = join(copy.dir, "compiled-frame.mjs");
    await writeFile(script, COMPILED_FRAME);
    const frame = await run(process.execPath, [script], options);
    assert.equal(frame.stderr, "");
    assert.match(frame.stdout, /Izbor ● up/);
    assert.match(frame.stdout, /Home {2}\[ Sessions/);
    assert.match(frame.stdout, /example-api +Add plugin · answer from Izbor ›/);
    assert.match(frame.stdout, /example-api-4c · Idle/);
});

test("a Node below 24.3.0 is refused with its version, before the bin imports the cli or what IZBOR_CLI names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "izbor-node-"));
    const node22 = join(dir, "node-22.mjs");
    await writeFile(
        node22,
        `Object.defineProperty(process, "version", { value: "v22.11.0" });\n` +
            `Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n`,
    );
    const stub = join(dir, "stub.mjs");
    await writeFile(stub, STUB);

    const old = await runIzborBin(["--help"], {
        nodeArgs: ["--import", pathToFileURL(node22).href],
        env: { IZBOR_CLI: stub },
    });
    assert.deepEqual(await old.exited, [1, null]);
    assert.deepEqual(
        [old.output.stdout, old.output.stderr],
        ["", "izbor needs Node 24.3.0 or later, found v22.11.0\n"],
    );

    const current = await runIzborBin(["--help"], { env: { IZBOR_CLI: stub } });
    assert.deepEqual(await current.exited, [0, null]);
    assert.deepEqual([current.output.stdout, current.output.stderr], [`${STUB_LINE} --help\n`, ""]);
});

test("with no dist/cli/main.js, the bin says to build in its folder's real path and exits 1; a build older than any file under src/ runs with IZBOR_OLD_BUILD=1 and nothing on stderr; a fresh one drops an inherited IZBOR_OLD_BUILD", async () => {
    const copy = await copyOfBin();

    const missing = await runIzborBin(["--help"], { bin: copy.bin, env: noSeam });
    assert.deepEqual(await missing.exited, [1, null]);
    assert.equal(missing.output.stdout, "");
    assert.ok(missing.output.stderr.includes(`run npm run build in ${copy.real}\n`), missing.output.stderr);

    const stub = await writeStub(copy.dir);
    await mkdir(join(copy.dir, "src", "a"), { recursive: true });
    const nested = join(copy.dir, "src", "a", "b.ts");
    await writeFile(nested, "export {};\n");
    await changedAgo(stub, 60);
    await changedAgo(nested, 0);
    for (const folder of ["src", join("src", "a"), "dist"]) await changedAgo(join(copy.dir, folder), 120);

    const stale = await runIzborBin(["serve", "--port", "1"], { bin: copy.bin, env: noSeam });
    assert.deepEqual(await stale.exited, [0, null]);
    assert.deepEqual(
        [stale.output.stdout, stale.output.stderr],
        [`${STUB_LINE} serve --port 1 IZBOR_OLD_BUILD=1\n`, ""],
    );

    await changedAgo(nested, 180);
    const fresh = await runIzborBin([], { bin: copy.bin, env: { ...noSeam, IZBOR_OLD_BUILD: "1" } });
    assert.deepEqual(await fresh.exited, [0, null]);
    assert.deepEqual([fresh.output.stdout, fresh.output.stderr], [`${STUB_LINE}\n`, ""]);

    const closed = join(copy.dir, "src", "closed");
    await mkdir(closed);
    await writeFile(join(closed, "c.ts"), "export {};\n");
    await chmod(closed, 0o444);
    const unreadable = await runIzborBin([], { bin: copy.bin, env: noSeam });
    await chmod(closed, 0o755);
    assert.deepEqual(await unreadable.exited, [0, null], unreadable.output.text);
    assert.match(unreadable.output.stdout, /^the stub cli ran( IZBOR_OLD_BUILD=1)?\n$/);
});

test("package.json maps izbor to bin/izbor.js and builds into a clean dist/", async () => {
    const { bin, scripts } = JSON.parse(await readFile(join(PROJECT_DIR, "package.json"), "utf8"));

    assert.deepEqual(bin, { izbor: "bin/izbor.js" });
    assert.match(scripts.build, /rmSync\('dist'.*&& tsc -p tsconfig\.build\.json$/);
});

test(
    "through a file link to the bin, as npm link makes in its bin folder, under --preserve-symlinks-main, the bin still runs its own folder's build",
    skipOnWindows("npm link on Windows writes izbor.cmd shims, not a file link; the izbor.cmd tests cover the shim"),
    async () => {
        const copy = await copyOfBin();
        await writeStub(copy.dir);
        const prefix = await mkdtemp(join(tmpdir(), "izbor-prefix-"));
        await mkdir(join(prefix, "bin"));
        const link = join(prefix, "bin", "izbor");
        await symlink(copy.bin, link);

        const { output, exited } = await runIzborBin(["--help"], {
            bin: link,
            env: { ...noSeam, NODE_OPTIONS: "--preserve-symlinks-main" },
        });

        assert.deepEqual(await exited, [0, null], output.text);
        assert.deepEqual([output.stdout, output.stderr], [`${STUB_LINE} --help\n`, ""]);
    },
);

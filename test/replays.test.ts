import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import stringWidth from "string-width";

process.env.TZ = "UTC";
process.env.HOME = "/home/izbor";
process.env.USERPROFILE = "/home/izbor";
delete process.env.LOCALAPPDATA;
for (const name of ["COLUMNS", "LINES", "INK_SCREEN_READER", "DEV"]) delete process.env[name];
const { NOW, screenBlock } = await import("./helpers/frameFile.js");
const { fakeTerminal } = await import("./helpers/fakeTerminal.js");
const { click, KEYS, paste, wheel } = await import("./helpers/keys.js");
const { runTerminal } = await import("../src/terminal/main.js");
const { readCliArgs } = await import("../src/cli/args.js");
const { SAMPLE_SCENARIOS, sampleRun } = await import("./helpers/sampleSessions.js");
type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

const realSetImmediate = setImmediate;

const REPLAYS = join(import.meta.dirname, "replays");
const UPDATE = process.execArgv.includes("--test-update-snapshots");
const STEP = 200;
const KEY_BYTES: ReadonlyMap<string, string> = new Map(Object.entries(KEYS));

test("replays run in UTC at /home/izbor", () => {
    assert.equal(new Date(NOW).getHours(), 12);
    assert.equal(homedir(), "/home/izbor");
});

for (const file of readdirSync(REPLAYS)
    .filter((name) => name.endsWith(".txt"))
    .sort())
    test(file, (t) => replay(t, file));

let firstRun: Promise<void> | undefined;
function runOnce(t: TestContext): Promise<void> {
    firstRun ??= (async () => {
        const window = fakeTerminal(t, 80, 24);
        const args = readCliArgs(["--no-color"], {});
        assert.ok(!("error" in args), JSON.stringify(args));
        if (!("screen" in args)) throw new Error(`${args.command} has no screen flags`);
        const exit = runTerminal({ screen: args.screen, ...sampleRun() }, window.io);
        await window.shows("Sessions · 3");
        window.type(KEYS["ctrl-c"]);
        assert.equal(await exit, 0);
    })();
    return firstRun;
}

function jsonString(argument: string): string {
    const value: unknown = JSON.parse(argument);
    if (typeof value !== "string") throw new Error(`not a JSON string: ${argument}`);
    return value;
}

function inputOf(line: string, rows: readonly string[]): { chunk: string } | { missing: string } {
    let chunk = "";
    for (const input of line.split(" + ")) {
        const [kind = "", ...rest] = input.split(" ");
        const argument = rest.join(" ");
        if (kind === "key") {
            const bytes = KEY_BYTES.get(argument);
            assert.ok(bytes, `no key ${argument} in KEYS`);
            chunk += bytes;
        } else if (kind === "type") chunk += jsonString(argument);
        else if (kind === "paste") chunk += paste(jsonString(argument));
        else if (["click", "click-end", "wheel-up", "wheel-down"].includes(kind)) {
            const at = cellOf(argument, kind === "click-end", rows);
            if (!at) return { missing: argument };
            chunk += kind.startsWith("click")
                ? click(at.x, at.y)
                : wheel(kind === "wheel-up" ? "up" : "down", at.x, at.y);
        } else assert.fail(`no input ${JSON.stringify(input)}`);
    }
    return { chunk };
}

function cellOf(argument: string, end: boolean, rows: readonly string[]): { x: number; y: number } | undefined {
    if (!argument.startsWith('"')) {
        const [x, y] = argument.split(" ").map(Number);
        assert.ok(Number.isInteger(x) && Number.isInteger(y), `not a cell: ${argument}`);
        return { x: Number(x), y: Number(y) };
    }
    const text = jsonString(argument);
    for (const [y, row] of rows.entries()) {
        const at = row.indexOf(text);
        if (at === -1) continue;
        const x = stringWidth(row.slice(0, at));
        return { x: end ? x + stringWidth(text) - 1 : x, y };
    }
}

function readScript(file: string, text: string) {
    const [id = "", about = "", run = ""] = text.split("\n");
    assert.equal(id, file.replace(/\.txt$/, ""), `${file}: line 1 is the replay's id, its file name without .txt`);
    const match = /^izbor (.+?)(?: · sample (\S+))? · (\d+)x(\d+)(?: · now \S+ · \d+ ms a step)?$/.exec(run);
    assert.ok(
        match,
        `${file}: line 3 is "izbor <argv> [· sample <scenario or empty>] · <columns>x<rows>", not ${JSON.stringify(run)}`,
    );
    const [, argv = "", sample, columns = "", rows = ""] = match;
    assert.ok(
        sample === undefined || sample === "empty" || SAMPLE_SCENARIOS.includes(sample as SampleScenario),
        `${file}: sample ${sample} is "empty" or one of ${SAMPLE_SCENARIOS.join(", ")}`,
    );
    const steps = text
        .split("\n")
        .filter((line) => line.startsWith("> "))
        .map((line) => line.slice(2).replace(/ · t=\d+\.\ds$/, ""))
        .filter((step) => step !== "start");
    return {
        id,
        about,
        argv: argv.split(" "),
        sample: sample as SampleScenario | "empty" | undefined,
        columns: Number(columns),
        rows: Number(rows),
        steps,
    };
}

async function replay(t: TestContext, file: string) {
    const path = join(REPLAYS, file);
    const text = readFileSync(path, "utf8");
    const { id, about, argv, sample, columns, rows, steps } = readScript(file, text);
    assert.ok(argv.includes("--no-color"), `${id}: every replay runs --no-color`);
    const args = readCliArgs(argv, {});
    assert.ok(!("error" in args), JSON.stringify(args));
    if (!("screen" in args)) throw new Error(`${id}: ${args.command} has no screen flags`);
    await runOnce(t);

    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
    const mocked = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...rest: unknown[]) => void, delay?: number, ...rest: unknown[]) =>
        mocked(callback, delay !== undefined && delay >= 1 ? delay : 1, ...rest)) as typeof setTimeout;
    t.after(() => {
        globalThis.setTimeout = mocked;
    });

    const window = fakeTerminal(t, columns, rows);
    let width = columns;
    const runner = process.listeners("uncaughtException");
    let code: number | undefined;
    let killedBy: string | undefined;
    let scenario: SampleScenario = sample === undefined || sample === "empty" ? "overview" : sample;
    const run = sampleRun({ scenario, empty: sample === "empty" });
    const exit = runTerminal({ screen: args.screen, ...run }, window.io).then((value) => (code = value));

    let clock = 0;
    const drain = async () => {
        for (let turn = 0; turn < 5; turn++) await new Promise((done) => realSetImmediate(done));
    };
    async function advance(ms: number) {
        for (let elapsed = 0; elapsed < ms; elapsed += 10) {
            await drain();
            t.mock.timers.tick(10);
            clock += 10;
        }
        await drain();
    }
    async function settle(step: number, start: number) {
        await advance(start + 100 - clock);
        const writes = window.writes();
        await advance(start + 190 - clock);
        assert.equal(window.writes(), writes, `step ${step} did not settle: a write after T+100 ms`);
        assert.equal(window.parsing(), 0, `step ${step} did not settle: xterm has not parsed every write`);
    }
    function block(): string {
        if (killedBy) return `killed by ${killedBy}`;
        const { screen, mouse, sgr, paste: pasteMode } = window.modes();
        const modes = `mouse ${mouse}${sgr ? " sgr" : ""} · paste ${pasteMode ? "on" : "off"}`;
        const alerts = `title ${JSON.stringify(window.title())} · bell ${window.bells()}`;
        const cursor = window.cursor();
        if (code !== undefined) {
            const errors = window.errors();
            const shown = cursor === "hidden" ? "hidden" : "shown";
            return `exit ${code} · screen ${screen} · ${modes} · cursor ${shown} · ${alerts}${errors ? ` · stderr ${JSON.stringify(errors)}` : ""}`;
        }
        const at = cursor === "hidden" ? "hidden" : `${cursor.x},${cursor.y}`;
        return [...screenBlock(window.rows(), width), `cursor ${at} · ${modes} · ${alerts}`].join("\n");
    }

    const out = [
        id,
        about,
        `izbor ${argv.join(" ")}${sample ? ` · sample ${sample}` : ""} · ${columns}x${rows} · now ${new Date(NOW).toISOString()} · ${STEP} ms a step`,
        "",
    ];
    let last: { body: string; step: number } | undefined;
    function record(step: number, line: string, start: number) {
        const body = block();
        out.push(`> ${line} · t=${(start / 1000).toFixed(1)}s`);
        if (body === last?.body) out.push(`= same as step ${last.step}`);
        else {
            out.push(body);
            last = { body, step };
        }
        out.push("");
    }

    try {
        await settle(0, 0);
        record(0, "start", 0);
        await advance(STEP - clock);
        for (const [index, line] of steps.entries()) {
            const step = index + 1;
            const [verb = "", ...rest] = line.split(" ");
            const argument = rest.join(" ");
            let act: (() => Promise<void> | void) | undefined;
            let input: { chunk: string } | { missing: string } = { chunk: "" };
            if (["wait", "resize", "signal", "crash", "scene"].includes(verb))
                assert.ok(!line.includes(" + "), `${id}: step ${step}: ${verb} stands alone`);
            if (verb === "wait") {
                const seconds = /^(\d+)s$/.exec(argument)?.[1];
                assert.ok(seconds, `${id}: step ${step}: wait takes whole seconds, as "wait 8s"`);
                await advance(Number(seconds) * 1000);
            } else if (verb === "scene") {
                assert.equal(argument, "next", `${id}: step ${step}: scene takes next`);
                act = () => {
                    scenario = SAMPLE_SCENARIOS[(SAMPLE_SCENARIOS.indexOf(scenario) + 1) % SAMPLE_SCENARIOS.length]!;
                    run.source.setScenario(scenario);
                };
            } else if (verb === "resize") {
                const [newColumns = 0, newRows = 0] = argument.split(" ").map(Number);
                act = async () => {
                    await window.resize(newColumns, newRows);
                    width = newColumns;
                };
            } else if (verb === "signal") {
                assert.ok(
                    argument === "SIGTERM" || argument === "SIGHUP" || argument === "SIGBREAK",
                    `${id}: step ${step}: ${argument}`,
                );
                const signal = argument;
                act = () => {
                    const kill = process.kill;
                    process.kill = (_pid: number, sent?: string | number): true => {
                        killedBy = String(sent);
                        return true;
                    };
                    try {
                        process.emit(signal, signal);
                    } finally {
                        process.kill = kill;
                    }
                };
            } else if (verb === "crash") {
                const message = jsonString(argument);
                act = () => {
                    for (const listener of runner) process.off("uncaughtException", listener);
                    try {
                        process.emit("uncaughtException", new Error(message));
                    } finally {
                        for (const listener of runner) process.on("uncaughtException", listener);
                    }
                };
            } else input = inputOf(line, window.rows());

            const start = clock;
            if ("missing" in input) {
                assert.ok(!UPDATE, `${id}: step ${step}: ${input.missing} is not on the screen`);
                out.push(`> ${line} · t=${(start / 1000).toFixed(1)}s`, `missing ${input.missing}`, "");
                break;
            }
            const acting = act?.();
            if (input.chunk) window.type(input.chunk);
            await settle(step, start);
            await acting;
            record(step, line, start);
            await advance(start + STEP - clock);
            if (code !== undefined || killedBy) {
                assert.ok(
                    !UPDATE || step === steps.length,
                    `${id}: the app ended at step ${step}; later steps never ran`,
                );
                break;
            }
        }
    } finally {
        if (code === undefined) {
            window.type(KEYS["ctrl-c"]);
            await advance(STEP);
            assert.equal(code, 0, `${id}: Ctrl-C after the last step exits with 0`);
            assert.equal(window.errors(), "");
        }
        await exit;
    }

    const actual = out.join("\n");
    if (UPDATE) writeFileSync(path, actual);
    else if (actual !== text) {
        const blocks = (replay: string) => replay.split(/\n(?=> )/);
        const want = blocks(text);
        const got = blocks(actual);
        const first = want.findIndex((expected, k) => expected !== got[k]);
        const at = first === -1 ? want.length : first;
        const where = at === 0 ? "in its header" : `at step ${at - 1}: ${(want[at] ?? got[at] ?? "").split("\n")[0]}`;
        assert.fail(
            `${id} differs ${where}\n--- expected\n${want[at] ?? "(none)"}\n--- actual\n${got[at] ?? "(none)"}`,
        );
    }
}

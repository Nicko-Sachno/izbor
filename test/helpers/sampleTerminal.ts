import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { terminalAbilities } from "../../src/cli/abilities.js";
import { readCliArgs } from "../../src/cli/args.js";
import { runTerminal } from "../../src/terminal/main.js";
import { SAMPLE_SCENARIOS, sampleRun, type SampleScenario } from "./sampleSessions.js";

// The terminal app on the sample sessions, for the PTY tests: it takes izbor's screen flags and, as openTerminal
// does, what the environment says the terminal can do (no supports-hyperlinks answer), and a sample case's name
// written to the file IZBOR_SAMPLE_SCENE names sets that case.
const args = readCliArgs(process.argv.slice(2), process.env);
if (!("screen" in args)) throw new Error(`${process.argv.slice(2).join(" ")} opens no terminal app`);
const abilities = terminalAbilities(process.env, { color: args.screen.color, hyperlinks: false });
const run = sampleRun();
const scene = process.env.IZBOR_SAMPLE_SCENE;
if (scene)
    watchFile(scene, { interval: 50 }, ({ size }) => {
        const scenario = size > 0 ? readFileSync(scene, "utf8").trim() : "";
        if (SAMPLE_SCENARIOS.includes(scenario as SampleScenario)) run.source.setScenario(scenario as SampleScenario);
    }).unref();
process.exitCode = await runTerminal({ screen: { ...args.screen, ...abilities }, ...run });
if (scene) unwatchFile(scene);

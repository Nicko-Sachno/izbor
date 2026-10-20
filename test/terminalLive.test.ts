import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { answerHookAt } from "../src/adapters/agents/claude/setup/answerHook.js";
import { hasIzborHooks } from "./helpers/answerHook.js";
import { PROJECT_DIR } from "../src/config.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { hostPlatform } from "./helpers/fakePlatform.js";
import { SKIP_WITHOUT_PTY, startPty } from "./helpers/pty.js";
import { pathFirst } from "./helpers/fakeCommand.js";
import { postHook } from "./helpers/izborPrompts.js";
import { agentsList, fakeClaude, ONE_SESSION_HERE, OTHER_SESSION, SESSION, until } from "./support.js";
import { KEYS } from "./helpers/keys.js";

type Pty = Awaited<ReturnType<typeof startPty>>;

function liveCli(
    port: number,
    env: Record<string, string | undefined>,
    { cols, rows, timeoutMs }: { cols: number; rows: number; timeoutMs: number },
) {
    const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
    return startPty([process.execPath, "--import", "tsx", main, "--port", String(port), "--no-color"], {
        env,
        cols,
        rows,
        timeoutMs,
    });
}

async function ctrlC({ input, exited }: Pty): Promise<number> {
    const pressed = Date.now();
    input(KEYS["ctrl-c"]);
    while (exited() === undefined && Date.now() - pressed < 5000) await delay(5);
    return Date.now() - pressed;
}

async function quitApp(pty: Pty) {
    await ctrlC(pty);
    assert.equal(pty.exited()?.code, 0, `the app is still running 5 s after Ctrl-C\n${pty.frame().join("\n")}`);
}

async function quitWithin1s(pty: Pty) {
    const took = await ctrlC(pty);
    const exited = pty.exited();
    assert.ok(exited, `the app is still running 5 s after Ctrl-C\n${pty.frame().join("\n")}`);
    assert.ok(took < 1000, `Ctrl-C gave the shell back after ${took} ms, not within 1 s`);
    assert.equal(exited.code, 0);
    assert.equal(exited.modesRestored, true, "canonical input and echo return to their initial settings");
}

test(
    "in a real terminal, the Brief of a session whose Izbor went away counts down to its retry, and Ctrl-C in the wait leaves within 1 s",
    { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
    async (t) => {
        const izbor = await startIzborServer(t, {
            agents: [{ sessionId: SESSION, cwd: PROJECT_DIR, status: "idle" }],
        });
        const claude = await fakeClaude(`process.stdout.write(${JSON.stringify(`${ONE_SESSION_HERE}\n`)});`);
        const pty = await liveCli(izbor.port, pathFirst(claude.dir), { cols: 120, rows: 30, timeoutMs: 8000 });
        t.after(pty.close);
        const { frame, until: shows, openFirstBrief } = pty;
        const screen = () => frame().join("\n");

        await shows("the list shows the running session", () => screen().includes("izbor-b8 · Idle"));
        await openFirstBrief();
        await shows("the observed session's Brief shows", () => screen().includes("Back · Esc  Task unknown"));

        izbor.server.closeAllConnections();
        izbor.server.close();
        await shows("the Brief counts down to its next retry while Izbor is not running", () =>
            /Izbor is not running · retrying in \d+ s/.test(screen()),
        );

        await quitWithin1s(pty);
    },
);

test(
    "in a real terminal, an observe shows Sessions; Ctrl-O shows Home with every session, lists again within a tick, and shows a failed run",
    { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
    async (t) => {
        const agents = [
            { sessionId: SESSION, cwd: PROJECT_DIR, status: "idle", name: "izbor-b8" },
            { sessionId: OTHER_SESSION, cwd: PROJECT_DIR, status: "busy", name: "List auto-refresh issue" },
        ];
        const izbor = await startIzborServer(t, { agents });
        const folder = await mkdtemp(join(tmpdir(), "izbor-runs-"));
        const counter = join(folder, "runs");
        const list = join(folder, "agents.json");
        await writeFile(list, agentsList(agents));
        const claude = await fakeClaude(
            `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(counter)}, "run\\n");\ntry { process.stdout.write(fs.readFileSync(${JSON.stringify(list)})); } catch { process.stderr.write("Not logged in\\n"); process.exitCode = 3; }`,
        );
        const runs = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
        const pty = await liveCli(izbor.port, pathFirst(claude.dir), { cols: 80, rows: 30, timeoutMs: 8000 });
        t.after(pty.close);
        const { frame, input, until: shows, openFirstBrief } = pty;
        const screen = () => frame().join("\n");
        const other = "List auto-refresh issue · Working";

        await shows(
            "the window opens on Home, with both sessions",
            () => screen().includes("izbor-b8 · Idle") && screen().includes(other),
        );
        await openFirstBrief();
        await shows("the observe shows Sessions, on the Brief", () => screen().includes("Back · Esc  Task unknown"));
        assert.equal(
            frame().filter((line) => line.includes("Task unknown")).length,
            1,
            `only the Brief's heading holds Task unknown\n${screen()}`,
        );
        assert.doesNotMatch(screen(), /List auto-refresh issue/, "Sessions has no Home list");

        input(KEYS["ctrl-o"]);
        await shows(
            "Ctrl-O shows Home: both sessions, the observed one marked",
            () => screen().includes("izbor-b8 · Idle · Open ›") && screen().includes(other),
        );
        assert.equal(frame().filter((line) => line.includes("Task unknown")).length, 0, "Home shows no row");

        const before = runs();
        await shows(
            "within one tick, claude agents runs again while the row is observed",
            () => runs() > before && screen().includes(other),
        );

        await rm(list);
        const failed = "▲ No list: claude agents --json exited with code 3: Not logged in";
        await shows("Home's failure line shows", () => screen().includes(failed));
        const failure = screen();
        assert.ok(failure.indexOf("Home  [ Sessions") < failure.indexOf(failed), failure);

        await quitApp(pty);
    },
);

async function windowOnRepo(t: TestContext) {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "izbor-hooks-")));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const name = basename(repo);
    const agents = [{ sessionId: SESSION, cwd: repo, status: "idle", name: "Orders API review" }];
    const izbor = await startIzborServer(t, { agents });
    const counter = join(repo, "..", `${name}-runs`);
    t.after(() => rm(counter, { force: true }));
    const claude = await fakeClaude(
        `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(counter)}, "run\\n");\nprocess.stdout.write(${JSON.stringify(`${agentsList(agents)}\n`)});`,
    );
    const runs = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
    const pty = await liveCli(izbor.port, pathFirst(claude.dir), { cols: 120, rows: 30, timeoutMs: 8000 });
    t.after(pty.close);
    const { frame, click, point, until: shows } = pty;
    const screen = () => frame().join("\n");
    const noHooks = `${name} · Briefs update late`;
    const projectLine = () =>
        frame()
            .find((line) => line.trimStart().startsWith(name))
            ?.trim()
            .replace(/\s+/g, " ");

    await shows("Home lists the project without hooks", () => projectLine() === `${noHooks} Add hooks ›`);

    async function projectAct(cue: string, answer: string, line: string) {
        const tick = runs();
        await shows("a tick runs claude agents", () => runs() > tick, 6_000);
        assert.ok(!screen().includes(answer), "nothing has run yet");
        const acted = Date.now();
        const ran = runs();
        click(point(cue));
        await shows(`the answer ${answer} shows`, () => screen().includes(answer));
        await shows(
            `the list runs again at once, and the line reads ${line}`,
            () => runs() > ran && projectLine() === line,
            2_000,
        );
        assert.ok(Date.now() - acted < 2_500, "before the next tick");
    }

    return {
        repo,
        name,
        port: izbor.port,
        settings: join(repo, ".claude", "settings.local.json"),
        projectAct,
        quit: () => quitApp(pty),
    };
}

test(
    "in a real terminal, a click on Add hooks › writes the project's hooks and its line reads Add plugin · answer from Izbor › at once; a click on that cue turns acting on and the line ends bare",
    { skip: SKIP_WITHOUT_PTY, timeout: 40000 },
    async (t) => {
        const { repo, name, port, settings, projectAct, quit } = await windowOnRepo(t);

        await projectAct("Add hooks ›", `Added Izbor's hooks to ${name}.`, `${name} Add plugin · answer from Izbor ›`);
        assert.equal(hasIzborHooks(readFileSync(settings, "utf8"), port), true);
        assert.equal(answerHookAt(repo, port, hostPlatform()), false);

        await projectAct("Add plugin · answer from Izbor ›", `Added Izbor's plugin to ${name}.`, name);
        assert.equal(answerHookAt(repo, port, hostPlatform()), true);

        await quit();
    },
);

test(
    "in a real terminal, Ctrl-C while the GET /izbor probe waits on a port that never answers leaves within 1 s",
    { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
    async (t) => {
        const izbor = await startIzborServer(t);
        const claude = await fakeClaude(`process.stdout.write(${JSON.stringify(`${ONE_SESSION_HERE}\n`)});`);
        const pty = await liveCli(izbor.port, pathFirst(claude.dir), { cols: 80, rows: 24, timeoutMs: 12000 });
        t.after(pty.close);
        const { frame, until: shows } = pty;
        const screen = () => frame().join("\n");
        await shows("the list shows the running session", () => screen().includes("izbor-b8 · Idle"));

        izbor.server.closeAllConnections();
        await new Promise((closed) => izbor.server.close(closed));
        const held: Socket[] = [];
        const silent = createServer((socket) => held.push(socket));
        t.after(() => {
            held.forEach((socket) => socket.destroy());
            silent.close();
        });
        silent.listen(izbor.port, "127.0.0.1");
        await once(silent, "listening");
        await shows("a probe is in flight on the held port", () => held.length > 0);

        await quitWithin1s(pty);
    },
);

test(
    "in a real terminal, the live app observes a session, follows its hooks even behind Help, and Ctrl-C leaves within 1 s",
    { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
    async (t) => {
        const server = await startIzborServer(t, {
            agents: [{ sessionId: SESSION, cwd: PROJECT_DIR, status: "idle" }],
        });
        const claude = await fakeClaude(`process.stdout.write(${JSON.stringify(`${ONE_SESSION_HERE}\n`)});`);
        const pty = await liveCli(server.port, pathFirst(claude.dir), {
            cols: 80,
            rows: 30,
            timeoutMs: 8000,
        });
        t.after(pty.close);
        const { frame, input, until: shows, settle, openFirstBrief } = pty;
        const screen = () => frame().join("\n");
        const taskLine = () => {
            const lines = frame();
            const row = lines.findIndex((line) => /^ {5}(Idle|Working|Waiting|Unknown|Not listed)\b/.test(line));
            return row > 0 ? lines[row - 1]! : "";
        };
        const postPrompt = (prompt: string) => postHook(server.base, "UserPromptSubmit", { prompt, cwd: PROJECT_DIR });

        await shows("the list shows the running session's line", () => screen().includes("izbor-b8 · Idle"));

        await openFirstBrief();
        await shows("the observed session's Brief opens", () => /Back · Esc {2}\S/.test(screen()));
        input(KEYS.esc);
        await shows(
            "the observed row shows the Brief",
            () =>
                !screen().includes("Back · Esc") && /^ {5}Idle\b/m.test(screen()) && screen().includes("Task unknown"),
        );
        assert.equal(frame().filter((line) => /^ {5}Idle\b/.test(line)).length, 1, "taskLine's anchor: the row alone");

        await postPrompt("run the tests");
        await shows("a hook changes the row's Task", () => taskLine().includes("· run the tests"));

        input(KEYS["ctrl-g"]);
        await shows("Ctrl-G opens Help", () => /A click or Enter on a line/.test(screen()));
        await postPrompt("fix the login bug");
        await settle(500);
        await shows("Help stays on screen while a hook arrives", () => /A click or Enter on a line/.test(screen()));
        assert.doesNotMatch(screen(), /fix the login bug/);
        input(KEYS.esc);
        await shows("Esc shows the Task that arrived behind Help", () => taskLine().includes("· fix the login bug"));

        await quitWithin1s(pty);
    },
);

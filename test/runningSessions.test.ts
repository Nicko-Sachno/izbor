import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PROJECT_DIR } from "../src/config.js";
import { mergeAnswerHook } from "../src/adapters/agents/claude/setup/answerHook.js";
import { eventHookEntry, HOOK_EVENT_NAMES } from "../src/adapters/agents/claude/setup/izborHooks.js";
import { HOOK_RUNNER } from "./helpers/answerHook.js";
import type { IzborInfo } from "../src/domain/wire.js";
import {
    createRunningSessions,
    datedWaits,
    parseRunningSessions,
    windowWhere,
    type Where,
} from "../src/terminal/live/agents.js";
import { projectsOf } from "../src/terminal/projects.js";
import { fakePlatform, OWNS_FILES_BY_UID } from "./helpers/fakePlatform.js";
import { noAnswer, testClock } from "./support.js";

const relativeWithSlashes = (from: string, to: string) => relative(from, to).split(sep).join("/");

const REPO = "/Users/me/izbor";
const WORKTREE = `${REPO}/.claude/worktrees/fix`;

const WHERE: Where = {
    summarizerDir: `${REPO}/.izbor/summarizer`,
    checkoutOf: (cwd) => (cwd === REPO || cwd.startsWith(`${REPO}/`) ? REPO : cwd),
    hasHooks: (checkout) => checkout === REPO,
    acts: (checkout) => checkout === REPO,
};

const B8 = {
    pid: 71494,
    cwd: REPO,
    kind: "interactive",
    startedAt: 1791107060252,
    sessionId: "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff",
    name: "izbor-b8",
    status: "idle",
};

const WAITING_B8 = { ...B8, status: "waiting", waitingFor: "permission prompt" };

const output = (...entries: object[]) => JSON.stringify(entries);

test("an entry becomes a running session, its checkout, its hooks and whether it acts as Where says for its folder", () => {
    assert.deepEqual(parseRunningSessions(output(B8), WHERE), [
        {
            id: "4a979d7e-eb38-41d3-a0f0-6d75b8c8d6ff",
            name: "izbor-b8",
            status: "idle",
            checkout: REPO,
            hooks: true,
            acting: true,
        },
    ]);
});

test("two sessions in c:\\x and C:\\x, one folder as Claude Code reports it on Windows, are one checkout and one project", () => {
    const where: Where = { ...WHERE, checkoutOf: (cwd) => cwd };
    const other = { ...B8, sessionId: "0b1c2d3e-0000-4000-8000-000000000000", cwd: "C:\\x" };
    const sessions = parseRunningSessions(output({ ...B8, cwd: "c:\\x" }, other), where);

    assert.deepEqual(
        sessions.map(({ checkout }) => ({ checkout })),
        [{ checkout: "C:\\x" }, { checkout: "C:\\x" }],
    );
    assert.equal(projectsOf(sessions, "/Users/me").length, 1);
});

test("hooks and acting are two facts of a checkout, each looked at once: a project can have either without the other", () => {
    const looked: string[] = [];
    const where: Where = {
        ...WHERE,
        hasHooks: (checkout) => checkout !== "/Users/me/plugin-only",
        acts: (checkout) => (looked.push(checkout), checkout !== "/Users/me/hooks-only"),
    };
    const cwds = [REPO, `${REPO}/src`, "/Users/me/hooks-only", "/Users/me/plugin-only", WORKTREE];
    const sessions = parseRunningSessions(
        output(...cwds.map((cwd, i) => ({ ...B8, sessionId: `5555555${i}-0000-4000-8000-000000000000`, cwd }))),
        where,
    );
    assert.deepEqual(
        sessions.map(({ checkout, hooks, acting }) => ({ checkout, hooks, acting })),
        [
            { checkout: REPO, hooks: true, acting: true },
            { checkout: REPO, hooks: true, acting: true },
            { checkout: "/Users/me/hooks-only", hooks: true, acting: false },
            { checkout: "/Users/me/plugin-only", hooks: false, acting: true },
            { checkout: REPO, hooks: true, acting: true },
        ],
    );
    assert.deepEqual(looked, [REPO, "/Users/me/hooks-only", "/Users/me/plugin-only"]);
});

test("a session's id is lower case, as observe writes a row's, so Home marks it observing", () => {
    const [session] = parseRunningSessions(output({ ...B8, sessionId: B8.sessionId.toUpperCase() }), WHERE);
    assert.equal(session!.id, B8.sessionId);
});

const ids = (sessions: { id: string }[]) => sessions.map(({ id }) => id);

test("every session in any folder is kept, in claude's order", () => {
    const sessions = parseRunningSessions(
        output(
            B8,
            { ...B8, sessionId: "11111111-0000-4000-8000-000000000000", cwd: `${REPO}/src` },
            { ...B8, sessionId: "22222222-0000-4000-8000-000000000000", cwd: "/Users/me/other" },
            { ...B8, sessionId: "33333333-0000-4000-8000-000000000000", cwd: `${REPO}-old` },
        ),
        WHERE,
    );
    assert.deepEqual(ids(sessions), [
        B8.sessionId,
        "11111111-0000-4000-8000-000000000000",
        "22222222-0000-4000-8000-000000000000",
        "33333333-0000-4000-8000-000000000000",
    ]);
});

test("a session under any checkout's .claude/worktrees/<name> is a worktree, named by its folder; hasHooks gets each checkout once", () => {
    const looked: string[] = [];
    const where = { ...WHERE, hasHooks: (checkout: string) => (looked.push(checkout), WHERE.hasHooks(checkout)) };
    const cwds = [`${WORKTREE}/src`, `${REPO}/src`, "/Users/me/shop/.claude/worktrees/fix/src", "/Users/me/shop/src"];
    const sessions = parseRunningSessions(
        output(...cwds.map((cwd, i) => ({ ...B8, sessionId: `4444444${i}-0000-4000-8000-000000000000`, cwd }))),
        where,
    );
    assert.deepEqual(
        sessions.map(({ checkout, worktree, hooks }) => ({ checkout, worktree, hooks })),
        [
            { checkout: REPO, worktree: "fix", hooks: true },
            { checkout: REPO, worktree: undefined, hooks: true },
            { checkout: cwds[2], worktree: "fix", hooks: false },
            { checkout: cwds[3], worktree: undefined, hooks: false },
        ],
    );
    assert.deepEqual(looked, [REPO, cwds[2], cwds[3]], "each checkout, once: its sessions agree");
});

test("an entry with no sessionId or no folder is dropped; one with no status is kept without one, whatever its kind", () => {
    const { sessionId, ...noId } = B8;
    const { cwd, ...noFolder } = B8;
    const { status, ...starting } = { ...B8, sessionId: "66666666-0000-4000-8000-000000000000", kind: "sdk" };
    const sessions = parseRunningSessions(
        output(noId, { ...B8, sessionId: "" }, noFolder, { ...B8, cwd: "" }, starting),
        WHERE,
    );
    assert.deepEqual(sessions, [
        {
            id: "66666666-0000-4000-8000-000000000000",
            name: "izbor-b8",
            checkout: REPO,
            hooks: true,
            acting: true,
        },
    ]);
    assert.ok(!("status" in sessions[0]!), "status is left out, not undefined");
    assert.ok(!("worktree" in sessions[0]!), "worktree is left out, not undefined");
});

test("datedWaits: a wait the previous list did not show is dated now, one it showed waiting keeps its time, one it showed undated stays undated, and nothing is dated with no previous list", () => {
    const waiting = parseRunningSessions(output(WAITING_B8), WHERE);
    const idle = parseRunningSessions(output(B8), WHERE);
    assert.deepEqual(
        [waiting[0]!.status, waiting[0]!.waitingFor],
        ["waiting", "permission prompt"],
        "a waiting session keeps what it waits for",
    );
    assert.equal(datedWaits(waiting, idle, "T1")[0]!.waitingSince, "T1");
    assert.equal(datedWaits(waiting, datedWaits(waiting, idle, "T1"), "T2")[0]!.waitingSince, "T1");
    assert.ok(!("waitingSince" in datedWaits(waiting, waiting, "T2")[0]!), "undated stays undated");
    assert.deepEqual(datedWaits(waiting, undefined, "T1"), waiting);
    assert.ok(!("waitingSince" in datedWaits(idle, waiting, "T1")[0]!), "an idle session is never dated");
});

test("Izbor's own summarizer, in Where's summarizerDir or below it, in any case, is skipped", () => {
    const summarizers = [WHERE.summarizerDir, `${WHERE.summarizerDir}/x`, WHERE.summarizerDir.toUpperCase()].map(
        (cwd, i) => ({ ...B8, sessionId: `7777777${i}-0000-4000-8000-000000000000`, cwd }),
    );
    const beside = { ...B8, sessionId: "88888888-0000-4000-8000-000000000000", cwd: `${WHERE.summarizerDir}-old` };
    assert.deepEqual(ids(parseRunningSessions(output(B8, ...summarizers, beside), WHERE)), [
        B8.sessionId,
        beside.sessionId,
    ]);
});

const NOT_LOGGED_IN = "claude agents --json exited with code 3: Not logged in";

function runner(...answers: (string | Error)[]) {
    const clock = testClock();
    let runs = 0;
    const running = createRunningSessions({
        run: async () => {
            const answer = answers[runs++]!;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        where: () => WHERE,
        now: clock.now,
    });
    return { running, clock, runs: () => runs };
}

test("a good run is the list, with the time it was listed", async () => {
    const { running, clock } = runner(output(B8));
    clock.at("12:00:05");
    const list = await running.refresh();
    assert.deepEqual(list, {
        state: "listed",
        sessions: parseRunningSessions(output(B8), WHERE),
        at: "2026-10-01T12:00:05.000Z",
    });
});

test("a failed run is no list, never an empty list", async () => {
    const { running } = runner(new Error(NOT_LOGGED_IN));
    assert.deepEqual(await running.refresh(), { state: "no list", reason: NOT_LOGGED_IN, last: [] });
});

test("output that is not a JSON list is no list too", async () => {
    for (const printed of ["Not logged in", `{"sessionId":"${B8.sessionId}"}`, "null"]) {
        const list = await runner(printed).running.refresh();
        assert.equal(list.state, "no list", printed);
        assert.match(list.state === "no list" ? list.reason : "", /^claude agents --json printed no list: /);
    }
});

test("a later failure keeps the last good list in last", async () => {
    const { running } = runner(output(B8), new Error(NOT_LOGGED_IN));
    const listed = await running.refresh();
    assert.deepEqual(await running.refresh(), {
        state: "no list",
        reason: NOT_LOGGED_IN,
        last: listed.state === "listed" ? listed.sessions : [],
    });
    assert.equal(listed.state, "listed");
});

const sessionsOf = (list: Awaited<ReturnType<ReturnType<typeof runner>["running"]["refresh"]>>) =>
    list.state === "listed" ? list.sessions : [];

test("a wait is dated by the first list after the window's first that shows it, and keeps that time while it waits", async () => {
    const { running, clock } = runner(output(B8), output(WAITING_B8), output(WAITING_B8));
    clock.at("12:00:00");
    await running.refresh();
    clock.at("12:00:05");
    assert.equal(sessionsOf(await running.refresh())[0]?.waitingSince, "2026-10-01T12:00:05.000Z");
    clock.at("12:00:10");
    assert.equal(sessionsOf(await running.refresh())[0]?.waitingSince, "2026-10-01T12:00:05.000Z");
});

test("a session waiting in the window's first list is never dated, and a failed run between two lists keeps the previous list for the dating", async () => {
    const first = runner(output(WAITING_B8), output(WAITING_B8));
    for (const _ of [1, 2]) {
        const [session] = sessionsOf(await first.running.refresh());
        assert.equal(session?.status, "waiting");
        assert.ok(!("waitingSince" in session!), "in the first list: undated, and it stays so");
    }

    const { running, clock } = runner(output(B8), new Error(NOT_LOGGED_IN), output(WAITING_B8));
    clock.at("12:00:00");
    const listed = sessionsOf(await running.refresh());
    clock.at("12:00:05");
    const failed = await running.refresh();
    assert.deepEqual(failed.state === "no list" && failed.last, listed);
    clock.at("12:00:10");
    assert.equal(sessionsOf(await running.refresh())[0]?.waitingSince, "2026-10-01T12:00:10.000Z");
});

test("a second refresh while a run is going shares that run: one process, not two", async () => {
    const answers: ((output: string) => void)[] = [];
    let runs = 0;
    const running = createRunningSessions({
        run: () => (runs++, new Promise<string>((answer) => answers.push(answer))),
        where: () => WHERE,
        now: testClock().now,
    });
    const first = running.refresh();
    const second = running.refresh();
    assert.equal(runs, 1);
    answers[0]!(output(B8));
    assert.equal(await first, await second, "both get the one run's list");
    assert.equal((await first).state, "listed");
    void running.refresh();
    assert.equal(runs, 2, "once it ended, a new run can start");
});

test("dispose aborts the run in flight", async () => {
    let signal: AbortSignal | undefined;
    const running = createRunningSessions({
        run: (abort) => ((signal = abort), noAnswer(abort)),
        where: () => WHERE,
        now: () => new Date(),
    });
    const list = running.refresh();
    running.dispose();
    assert.equal(signal?.aborted, true);
    assert.equal((await list).state, "no list");
});

const izborOn = (dataDir: string): IzborInfo => ({
    service: "izbor",
    pid: 1,
    port: 5123,
    dataDir,
    startedAt: "2026-10-08T12:00:00.000Z",
    sendKeyPath: "/Users/me/.config/izbor/send-key-5123",
});

test("the window's Where: the summarizer in the data folder Izbor answered with; an older Izbor's from IZBOR_DATA_DIR", () => {
    const env = { IZBOR_DATA_DIR: "/tmp/b" };
    const answered = windowWhere({
        izbor: izborOn("/tmp/a"),
        port: 5123,
        env,
        platform: OWNS_FILES_BY_UID,
    });
    const older = windowWhere({ izbor: "older", port: 5123, env, platform: OWNS_FILES_BY_UID });
    assert.equal(answered.summarizerDir, join("/tmp/a", "summarizer"));
    assert.equal(older.summarizerDir, join("/tmp/b", "summarizer"));
    assert.equal(
        windowWhere({ izbor: "older", port: 5123, env: {}, platform: OWNS_FILES_BY_UID }).summarizerDir,
        join(PROJECT_DIR, ".izbor", "summarizer"),
    );

    const inA = { ...B8, sessionId: "77777777-0000-4000-8000-000000000000", cwd: "/tmp/a/summarizer" };
    const inB = { ...B8, sessionId: "88888888-0000-4000-8000-000000000000", cwd: "/tmp/b/summarizer" };
    assert.deepEqual(ids(parseRunningSessions(output(B8, inA, inB), answered)), [B8.sessionId, inB.sessionId]);
    assert.deepEqual(ids(parseRunningSessions(output(B8, inA, inB), older)), [B8.sessionId, inA.sessionId]);
});

const izborSettings = (port: number, names: readonly string[] = HOOK_EVENT_NAMES) =>
    JSON.stringify({
        permissions: { allow: ["Bash(npm test)"] },
        hooks: Object.fromEntries(names.map((name) => [name, [{ hooks: [eventHookEntry(HOOK_RUNNER, port)] }]])),
    });

const treeOf = async (root: string) => (await readdir(root, { recursive: true })).sort();

// A git worktree named fix under the checkout's .claude/worktrees, linked both ways as git links it.
async function worktree(checkout: string): Promise<string> {
    const folder = join(checkout, ".claude", "worktrees", "fix");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".git"), "gitdir: ../../../.git/worktrees/fix\n");
    await mkdir(join(checkout, ".git", "worktrees", "fix"), { recursive: true });
    await writeFile(join(checkout, ".git", "worktrees", "fix", "commondir"), "../..\n");
    await writeFile(join(checkout, ".git", "worktrees", "fix", "gitdir"), `${join(folder, ".git")}\n`);
    return folder;
}

test("the window's list: a session's checkout is its git root, a worktree's main checkout, or outside git its own folder; it has hooks when that checkout's settings.local.json has all 14 for the window's port", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "izbor-checkouts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const settings: Record<string, string> = {
        all: izborSettings(5123),
        thirteen: izborSettings(5123, HOOK_EVENT_NAMES.slice(0, 13)),
        permissions: JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }),
        "not-json": "{ hooks",
        "port-4319": izborSettings(4319),
        empty: "{}",
    };
    for (const [checkout, text] of Object.entries(settings)) {
        await mkdir(join(root, checkout, ".git"), { recursive: true });
        await mkdir(join(root, checkout, ".claude"));
        await writeFile(join(root, checkout, ".claude", "settings.local.json"), text);
    }
    await mkdir(join(root, "all", "src"));
    await mkdir(join(await worktree(join(root, "all")), "src"));
    await mkdir(join(root, "all", ".claude", "worktrees", "stale"), { recursive: true });
    await writeFile(
        join(root, "all", ".claude", "worktrees", "stale", ".git"),
        "gitdir: ../../../.git/worktrees/stale\n",
    );
    await mkdir(join(root, "outside", ".claude"), { recursive: true });
    await mkdir(join(root, "outside", "child"));
    await writeFile(join(root, "outside", ".claude", "settings.local.json"), izborSettings(5123));
    const before = await treeOf(root);

    const where = windowWhere({
        izbor: izborOn(join(root, "data")),
        port: 5123,
        env: {},
        platform: OWNS_FILES_BY_UID,
    });
    const cwds = [
        "all",
        "thirteen",
        "permissions",
        "not-json",
        "port-4319",
        "empty",
        "all/src",
        "all/.claude/worktrees/fix",
        "all/.claude/worktrees/fix/src",
        "all/.claude/worktrees/stale",
        "outside",
        "outside/child",
        "missing-folder",
    ];
    const sessions = parseRunningSessions(
        output(...cwds.map((cwd, i) => ({ ...B8, sessionId: `${i}`, cwd: join(root, cwd) }))),
        where,
    );
    assert.deepEqual(
        Object.fromEntries(
            sessions.map(({ checkout, hooks }, i) => [cwds[i], `${relativeWithSlashes(root, checkout)} ${hooks}`]),
        ),
        {
            all: "all true",
            thirteen: "thirteen false",
            permissions: "permissions false",
            "not-json": "not-json false",
            "port-4319": "port-4319 false",
            empty: "empty false",
            "all/src": "all true",
            "all/.claude/worktrees/fix": "all true",
            "all/.claude/worktrees/fix/src": "all true",
            "all/.claude/worktrees/stale": "all/.claude/worktrees/stale false",
            outside: "outside true",
            "outside/child": "outside/child false",
            "missing-folder": "missing-folder false",
        },
    );
    assert.deepEqual(await treeOf(root), before, "the look writes nothing");
});

test("the window's list: a session acts when its checkout's settings.local.json holds Izbor's answer hook for the window's port, a worktree's session by its main checkout's; another port's hook, Izbor's 14 hooks alone or no file do not make it act", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "izbor-acting-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const answerHook = (port: number, text: string | null = null) => {
        const merged = mergeAnswerHook(text, port, HOOK_RUNNER);
        assert.ok("text" in merged);
        return merged.text;
    };
    const settings: Record<string, string> = {
        acting: answerHook(5123, izborSettings(5123)),
        "plugin-only": answerHook(5123),
        "hooks-only": izborSettings(5123),
        "port-4319": answerHook(4319, izborSettings(5123)),
        "not-json": "{ hooks",
    };
    for (const [checkout, text] of Object.entries(settings)) {
        await mkdir(join(root, checkout, ".git"), { recursive: true });
        await mkdir(join(root, checkout, ".claude", "worktrees", "fix"), { recursive: true });
        await writeFile(join(root, checkout, ".claude", "settings.local.json"), text);
    }
    await mkdir(join(root, "no-file", ".git"), { recursive: true });
    await worktree(join(root, "acting"));
    const before = await treeOf(root);

    const where = windowWhere({
        izbor: izborOn(join(root, "data")),
        port: 5123,
        env: {},
        platform: OWNS_FILES_BY_UID,
    });
    const cwds = [...Object.keys(settings), "no-file", "acting/.claude/worktrees/fix"];
    const sessions = parseRunningSessions(
        output(...cwds.map((cwd, i) => ({ ...B8, sessionId: `${i}`, cwd: join(root, cwd) }))),
        where,
    );
    assert.deepEqual(Object.fromEntries(sessions.map(({ hooks, acting }, i) => [cwds[i], { hooks, acting }])), {
        acting: { hooks: true, acting: true },
        "plugin-only": { hooks: false, acting: true },
        "hooks-only": { hooks: true, acting: false },
        "port-4319": { hooks: true, acting: false },
        "not-json": { hooks: false, acting: false },
        "no-file": { hooks: false, acting: false },
        "acting/.claude/worktrees/fix": { hooks: true, acting: true },
    });
    assert.deepEqual(await treeOf(root), before, "the look writes nothing");
});

test("the window's list on an OS with no owner uids: a session in a subfolder or a worktree is its own checkout, its own project on Home, with its own folder's hooks", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "izbor-no-uid-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await mkdir(join(root, "repo", ".claude"));
    await writeFile(join(root, "repo", ".claude", "settings.local.json"), izborSettings(5123));
    await mkdir(join(root, "repo", "sub"));
    await worktree(join(root, "repo"));

    const platform = fakePlatform({ ownsFilesByUid: false });
    const where = windowWhere({ izbor: izborOn(join(root, "data")), port: 5123, env: {}, platform });
    const cwds = ["repo", "repo/sub", "repo/.claude/worktrees/fix"];
    const sessions = parseRunningSessions(
        output(...cwds.map((cwd, i) => ({ ...B8, sessionId: `${i}`, cwd: join(root, cwd) }))),
        where,
    );
    assert.deepEqual(
        Object.fromEntries(
            sessions.map(({ checkout, hooks }, i) => [cwds[i], `${relativeWithSlashes(root, checkout)} ${hooks}`]),
        ),
        {
            repo: "repo true",
            "repo/sub": "repo/sub false",
            "repo/.claude/worktrees/fix": "repo/.claude/worktrees/fix false",
        },
    );
});

test("the default macOS file system ignores case: .Claude/Worktrees is a worktree and the name keeps its case; .claude/worktrees alone is not", () => {
    const looked: string[] = [];
    const where = { ...WHERE, checkoutOf: (cwd: string) => (looked.push(cwd), WHERE.checkoutOf(cwd)) };
    const cwds = [`${REPO.toLowerCase()}/.Claude/Worktrees/Fix/src`, `${REPO}/.claude/worktrees`, `${REPO}/.claude`];
    const sessions = parseRunningSessions(
        output(
            { ...B8, cwd: cwds[0] },
            { ...B8, sessionId: "44444444-0000-4000-8000-000000000000", cwd: cwds[1] },
            { ...B8, sessionId: "55555555-0000-4000-8000-000000000000", cwd: cwds[2] },
        ),
        where,
    );
    assert.deepEqual(
        sessions.map(({ id, worktree }) => ({ id, worktree })),
        [
            { id: B8.sessionId, worktree: "Fix" },
            { id: "44444444-0000-4000-8000-000000000000", worktree: undefined },
            { id: "55555555-0000-4000-8000-000000000000", worktree: undefined },
        ],
    );
    assert.deepEqual(looked, cwds, "each session's folder, as claude spelled it");
});

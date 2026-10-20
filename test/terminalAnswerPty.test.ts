import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { answerHookEntry } from "../src/adapters/agents/claude/setup/answerHook.js";
import { actingProject, ALLOW, BASH, HOOK_RUNNER, runHookEntry } from "./helpers/answerHook.js";
import { postHook } from "./helpers/izborPrompts.js";
import { claudeListing, COLOR_TERMINAL, openIzbor, upOn } from "./helpers/bin.js";
import { startIzborServer } from "./helpers/izborServer.js";
import { SKIP_WITHOUT_PTY } from "./helpers/pty.js";
import { type AgentsListEntry, hook, SESSION } from "./support.js";
import { KEYS } from "./helpers/keys.js";

type Asked = { request: object; placeholder: RegExp };
const PERMISSION: Asked = {
    request: BASH,
    placeholder: /│ › yes, no, or no and your words +Send → │/,
};
const DATE_FORMAT = {
    questions: [
        {
            question: "Which date format should the export use?",
            header: "Date format",
            options: [
                { label: "ISO 8601 (2026-10-09)", description: "Year first." },
                { label: "Day first (09/10/2026)", description: "As in most of Europe." },
                { label: "Month first (10/09/2026)", description: "As in the US." },
            ],
            multiSelect: false,
        },
    ],
};
const QUESTION: Asked = {
    request: { tool_name: "AskUserQuestion", tool_input: DATE_FORMAT },
    placeholder: /│ › an option's number, or no +Send → │/,
};

async function fieldOnHeldRequest(t: TestContext, asked: Asked = PERMISSION) {
    const agents: AgentsListEntry[] = [
        { sessionId: SESSION, cwd: "/repo", status: "waiting", waitingFor: "permission prompt" },
    ];
    const izbor = await startIzborServer(t, { agents });
    const acting = await actingProject(t, izbor.port);
    const first = await claudeListing(acting, izbor.port, { status: "waiting", waitingFor: "permission prompt" });
    const window = await openIzbor(t, izbor.port, { first, env: COLOR_TERMINAL });
    await window.until("the app opens on the test Izbor", () => upOn(izbor.port).test(window.frame()[0]!));

    // Initial discovery can use the 3s health probe followed by the 5s agents command.
    await window.until(
        "the list shows the running session",
        () => window.screen().includes("Unnamed session ·  ! Needs you"),
        8000,
    );
    await window.openFirstBrief(100);
    await window.until(
        "the Brief is live",
        () => window.screen().includes("Back · Esc  Task unknown") && window.screen().includes("Needs you"),
        8000,
    );

    const request = hook("PermissionRequest", { ...asked.request, cwd: acting });
    await postHook(izbor.base, "PermissionRequest", { ...asked.request, cwd: acting });
    const held = runHookEntry(t, answerHookEntry(HOOK_RUNNER, izbor.port), request);

    await window.until("the Brief page offers to answer", () => window.screen().includes("┌─ Answer"));
    window.input(KEYS.enter);
    await window.until("the field has the cursor", window.fieldHasCursor);
    assert.match(window.screen(), /┌─ Answer ─+┐/);
    assert.match(window.screen(), asked.placeholder);
    return { izbor, window, held };
}

function colorOf(window: Awaited<ReturnType<typeof openIzbor>>, text: string): number {
    const y = window.frame().findIndex((line) => line.includes(text));
    assert.ok(y >= 0, `${text} is on the screen`);
    const buffer = window.terminal.buffer.active;
    const cell = buffer.getLine(buffer.viewportY + y)!.getCell(window.frame()[y]!.indexOf(text))!;
    return cell.isFgDefault() ? -1 : cell.getFgColor();
}

test(
    "in a real terminal, yes typed in the Brief's field reaches a held answer hook: its stdout carries the allow, and the window says what it sent",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const { window, held } = await fieldOnHeldRequest(t);
        window.input("yes");
        await window.until("yes is in the field", () => /│ › yes +Send → │/.test(window.screen()));
        assert.equal(held.running(), true, "typing sends nothing");
        window.input(KEYS.enter);

        assert.equal(await held.exited, 0);
        assert.equal(held.stdout(), ALLOW);
        await window.until("the Sent lines show", () =>
            /Sent yes\. Needs you clears when Claude goes on\./.test(window.screen()),
        );
        const screen = window.screen();
        assert.match(screen, /Sent from Izbor: yes · \d+s ago/);
        assert.match(screen, /│ › +Send → │/, "the field is empty, with no placeholder");
        assert.match(screen, /\n {3}! Needs you *\n/, "Needs you still holds the request: only evidence clears it");
        assert.doesNotMatch(screen, /Approved|Allowed/);

        await window.until(
            "the did-not-take warning shows",
            () => window.screen().includes("That request still waits: answer it in the session."),
            8000,
        );
        assert.doesNotMatch(window.screen(), /Sent yes\. Needs you clears/, "the Sent sentence left the field's line");
        assert.equal(await window.quit(), 0);
    },
);

test(
    "in a real terminal, 2 typed in the Brief's field answers a held Question: yes is refused first, then the hook's stdout carries the allow with the second option as the answer",
    { skip: SKIP_WITHOUT_PTY, timeout: 60_000 },
    async (t) => {
        const { window, held } = await fieldOnHeldRequest(t, QUESTION);
        const screen = window.screen();
        assert.match(screen, /! Needs you *\n {2}Which date format should the export use\? *\n {2}1\. ISO 8601/);
        assert.match(screen, /\n {2}2\. Day first \(09\/10\/2026\) *\n {2}3\. Month first \(10\/09\/2026\) *\n/);
        assert.doesNotMatch(screen, /Latest:/, "Latest shows while Working only");
        assert.doesNotMatch(screen, /AskUserQuestion/);

        window.input("yes");
        await window.until("yes is in the field", () => /│ › yes +Send → │/.test(window.screen()));
        window.input(KEYS.enter);
        const REFUSAL = "× Type an option's number, or no.";
        await window.until("the refusal shows", () => window.screen().includes(REFUSAL));
        assert.match(window.screen(), /│ › yes +Send → │/, "the text is kept");
        assert.notEqual(colorOf(window, REFUSAL), colorOf(window, "Which date format"), "rose, not amber");
        assert.equal(held.running(), true);
        assert.equal(held.stdout(), "");

        window.input("\x7f\x7f\x7f2");
        await window.until("2 is in the field", () => /│ › 2 +Send → │/.test(window.screen()));
        window.input(KEYS.enter);
        assert.equal(await held.exited, 0);
        assert.deepEqual(JSON.parse(held.stdout()), {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: {
                    behavior: "allow",
                    updatedInput: {
                        ...DATE_FORMAT,
                        answers: { "Which date format should the export use?": "Day first (09/10/2026)" },
                    },
                },
            },
        });
        await window.until("the Sent lines show", () =>
            /Sent 2\. Needs you clears when Claude goes on\./.test(window.screen()),
        );
        assert.match(window.screen(), /Sent from Izbor: 2 · \d+s ago/);
        assert.match(window.screen(), /│ › +Send → │/, "the field is empty, with no placeholder");
        assert.equal(await window.quit(), 0);
    },
);

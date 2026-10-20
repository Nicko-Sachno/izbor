import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { terminalLayout } from "../src/terminal/layout.js";
import { COLOR_TERMINAL } from "./helpers/bin.js";
import { SHELL_PROMPT, SKIP_WITHOUT_PTY, startPty } from "./helpers/pty.js";
import { KEYS } from "./helpers/keys.js";

const SAMPLE_TERMINAL = [
    process.execPath,
    "--import",
    "tsx",
    fileURLToPath(new URL("./helpers/sampleTerminal.ts", import.meta.url)),
];

test(
    "the live terminal preserves keyboard and mouse navigation through updates and resizes, then restores the shell",
    { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
    async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "izbor-scene-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const scene = join(dir, "scene");
        const pty = await startPty([...SAMPLE_TERMINAL, "--no-color"], { env: { IZBOR_SAMPLE_SCENE: scene } });
        t.after(pty.close);
        const { terminal, frame, input, click, point, fieldPoint } = pty;
        const { setSize, resize, settle, until, assertFieldCursor, fieldHasCursor, exited } = pty;
        const HELP = /A click or Enter on a line/;
        const fieldShows = (text: string) => frame().some((line) => line.includes(`│ › ${text}`));

        await until("initial Briefs render", () => {
            const visible = frame().join("\n");
            return terminal.buffer.active.type === "alternate" && /Add CSV export/.test(visible);
        });
        input("\x07");
        await until("Help opens", () => HELP.test(frame().join("\n")));
        input("\x1b");
        await until("Escape restores the overview from Help", () => {
            const visible = frame().join("\n");
            return visible.includes("Fix the token") && !HELP.test(visible);
        });

        const beforeUpdate = frame().join("\n");
        await writeFile(scene, "unknown");
        await until("a session update renders", () => {
            const visible = frame().join("\n");
            return visible !== beforeUpdate && /unknown/i.test(visible);
        });
        await settle(100);
        const beforeResize = frame();

        for (const [columns, rows] of [
            [160, 40],
            [60, 24],
            [40, 12],
            [120, 24],
            [80, 30],
        ] as const) {
            setSize(columns, rows);
            const { inset } = terminalLayout(columns, rows);
            await until(`the screen reflows at ${columns}×${rows}`, () => {
                const last = frame()[rows - 1]!.trimEnd();
                return last.length === columns - inset && /Help · Ctrl-G$/.test(last);
            });
            await settle(100);
            assert.equal(terminal.buffer.active.type, "alternate");
            assert.equal(terminal.buffer.active.baseY, 0, "the app fits the viewport without growing scrollback");
        }
        assert.deepEqual(frame(), beforeResize, "growing restores the same complete cell grid without ghost content");

        input("\t");
        await settle();
        input("\r");
        await until("Enter opens the first Brief's page, its field at the bottom", () => {
            const visible = frame().join("\n");
            return /Back · Esc\s+Fix the/.test(visible) && fieldShows("your next prompt");
        });
        const emptyField = frame()[fieldPoint().y]!;
        const fieldIsEmpty = () => frame()[fieldPoint().y] === emptyField;
        input("\r");
        await until("Enter on the Brief puts the cursor in its field", fieldHasCursor);
        const typed = "run 0926";
        input(typed);
        await until("typing reaches the field", () => fieldShows(typed));
        assertFieldCursor(typed);
        input("x");
        await until("a second key lands at the cursor", () => fieldShows(`${typed}x`));
        assertFieldCursor(`${typed}x`);
        input("\x7f");
        await until("Backspace removes the appended character", () => fieldShows(typed) && !fieldShows(`${typed}x`));
        assertFieldCursor(typed);
        input("\x01");
        await until(
            "Ctrl+A moves the insertion cursor to the beginning",
            () => terminal.buffer.active.cursorX === fieldPoint().x,
        );
        input("z");
        await until("insertion happens at the beginning", () => fieldShows(`z${typed}`));
        assertFieldCursor(`z${typed}`, 1);
        input("\x7f");
        await until("Backspace edits at the current insertion point", () => fieldShows(typed));
        assertFieldCursor(typed, 0);
        input("\x05");
        await until("Ctrl+E moves to the end", () => terminal.buffer.active.cursorX === fieldPoint(typed.length).x);
        input("\x15");
        await until("Ctrl+U clears the field before the cursor", fieldIsEmpty);

        await resize(40, 12);
        const pasted = "yes, no and more";
        input("\x1b[200~yes,\nno and\nmore\x1b[201~");
        await until("a bracketed paste lands in the field, its newlines as spaces", () => fieldShows(pasted));
        assertFieldCursor();
        assert.match(frame().join("\n"), /Back · Esc\s+Fix the/, "pasted newlines send nothing");
        await resize(80, 30);
        await until("the pasted text remains editable after growth", () => fieldShows(pasted));
        assertFieldCursor(pasted);
        input("\x01");
        await until(
            "the pasted text's cursor can return to the start",
            () => terminal.buffer.active.cursorX === fieldPoint().x,
        );
        input("\x05");
        await until(
            "Ctrl+E reaches the pasted text's end",
            () => terminal.buffer.active.cursorX === fieldPoint(pasted.length).x,
        );
        input("\x05\x15");
        await until("coalesced Ctrl+E / Ctrl+U clears the pasted text", fieldIsEmpty);
        input("\x1b");
        await settle();
        input("\x1b");
        await until("Escape steps back from the field to the Brief, then to Sessions, focus on its row", () => {
            const visible = frame().join("\n");
            return !visible.includes("Back · Esc") && visible.includes("Selected · Fix the token");
        });

        await resize(120, 40);
        const openPoint = point("Open ›");
        assert.equal(openPoint.x, 112, "Open aligns with the full session pane in single mode");
        const clickReport = ({ x, y }: { x: number; y: number }) => `\x1b[<0;${x + 1};${y + 1}M`;
        input(clickReport(openPoint));
        await until("the Open Brief cue opens its session, whose page shows the Brief's field", () => {
            const visible = frame().join("\n");
            return /Back · Esc\s+Fix the/.test(visible) && fieldShows("your next prompt");
        });
        input(`${clickReport(fieldPoint(3))}Z`);
        await until("a click before typing in the same chunk moves focus first: Z lands in the field", () =>
            fieldShows("Z"),
        );
        input("\x05\x15");
        await until("the ordered field clears", () => fieldShows("your next prompt"));
        input(`\x1b[200~pasted first\x1b[201~${clickReport(point("Back"))}`);
        await until("paste before a click keeps input order: Back shows Sessions", () => {
            const visible = frame().join("\n");
            return !visible.includes("Back · Esc") && visible.includes("Fix the token");
        });
        input(clickReport(point("Open ›")));
        await until("the field kept the paste that came before the click on Back", () => fieldShows("pasted first"));
        input(`${clickReport(fieldPoint(12))}\x05\x15`);
        await until("click and editor shortcuts retain order", () => fieldShows("your next prompt"));
        input(clickReport(point("Back")));
        await until("Back returns to Sessions", () => !frame().join("\n").includes("Back · Esc"));

        click(point("Add CSV export"));
        await until("clicking a Brief opens the correct session", () =>
            /Back · Esc\s+Add CSV/.test(frame().join("\n")),
        );
        await resize(80, 30);
        const emptyAnswer = frame()[fieldPoint().y]!;
        const answerIsEmpty = () => frame()[fieldPoint().y] === emptyAnswer;
        click(fieldPoint());
        await resize(40, 12);
        const longText = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        input(longText);
        await until("long input scrolls horizontally", () =>
            frame().some((line) => line.includes("…") && line.includes("XYZ")),
        );
        click(point("STUVWXYZ"));
        await settle();
        input("z");
        await resize(80, 30);
        await until("click positions map through the hidden beginning of a long text", () =>
            fieldShows(longText.replace("S", "zS")),
        );
        input("\x05\x15");
        await until("the long clicked text clears", answerIsEmpty);

        const pasteTarget = point("Back");
        input(`\x1b[200~mouse \x1b[<0;${pasteTarget.x + 1};${pasteTarget.y + 1}M literal\x1b[201~`);
        await until("bracketed paste reaches the field without performing its embedded click", () =>
            frame().some((line) => line.includes("mouse ") && line.includes("literal")),
        );
        assert.match(frame().join("\n"), /Back · Esc\s+Add CSV/, "pasted mouse reports never navigate");
        input("\x05\x15");
        await until("pasted content clears", answerIsEmpty);

        input(KEYS["ctrl-c"]);
        await until("Ctrl+C exits and restores the terminal", () => exited() !== undefined);
        assert.equal(exited()!.code, 0);
        assert.equal(exited()!.modesRestored, true, "canonical input and echo return to their initial settings");
        assert.equal(terminal.buffer.active.type, "normal", "the alternate screen is left on exit");
        assert.equal(
            terminal.modes.mouseTrackingMode,
            "none",
            "mouse tracking is disabled before returning to the shell",
        );
        assert.equal(frame()[0]!.trimEnd(), SHELL_PROMPT.trimEnd(), "the shell's original screen is restored");
    },
);

const SELECTED_TASK = "Fix the token refresh bug";

for (const { terminal: name, env, color, sixteen } of [
    { terminal: "with CI set", env: { CI: "1" }, color: false, sixteen: false },
    { terminal: "with TERM=dumb", env: { TERM: "dumb" }, color: false, sixteen: false },
    { terminal: "with NO_COLOR=1", env: { NO_COLOR: "1" }, color: false, sixteen: false },
    { terminal: "with CI set and FORCE_COLOR=1", env: { CI: "1", FORCE_COLOR: "1" }, color: true, sixteen: true },
    { terminal: "that shows color", env: {}, color: true, sixteen: false },
]) {
    test(
        color
            ? `in a terminal ${name}, the selected session is ${sixteen ? "in the terminal's own colour (16 colours)" : "colored"}, bold, not underlined, and has no label`
            : `in a terminal ${name}, the selected session says Selected · and has no color`,
        { skip: SKIP_WITHOUT_PTY, timeout: 30000 },
        async (t) => {
            const pty = await startPty(SAMPLE_TERMINAL, { env: { ...COLOR_TERMINAL, ...env } });
            t.after(pty.close);
            const { terminal, frame, input, until, exited } = pty;

            await until("the sample Sessions show", () => frame().some((line) => line.includes(SELECTED_TASK)));
            const y = frame().findIndex((line) => line.includes(SELECTED_TASK));
            const line = frame()[y]!;
            const buffer = terminal.buffer.active;
            const cell = buffer.getLine(buffer.viewportY + y)!.getCell(line.indexOf(SELECTED_TASK))!;
            if (color) {
                assert.match(line, /^ {3}\* Fix the token refresh bug .* Open ›\s*$/);
                assert.deepEqual(
                    { colored: !cell.isFgDefault(), bold: cell.isBold() !== 0, underline: cell.isUnderline() !== 0 },
                    { colored: !sixteen, bold: true, underline: false },
                );
            } else {
                assert.match(line, /^ {3}\* Selected · Fix the token refresh bug .* Open ›\s*$/);
                assert.equal(cell.isFgDefault(), true, "the Task has the terminal's own color");
            }

            input(KEYS["ctrl-c"]);
            await until("Ctrl+C exits", () => exited() !== undefined);
            assert.equal(exited()!.code, 0);
        },
    );
}

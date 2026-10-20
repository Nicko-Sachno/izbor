import type { TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import xterm from "@xterm/headless";
import type { TerminalIo } from "../../src/terminal/main.js";
import { until } from "../support.js";

const { Terminal } = xterm;

export function fakeTerminal(t: TestContext, columns = 120, rows = 30) {
    const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true });
    t.after(() => terminal.dispose());
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    const stderr = Object.assign(new PassThrough(), { isTTY: false });
    let recorded: string[] | undefined;
    let written = Promise.resolve();
    let bells = 0;
    let title = "";
    terminal.onBell(() => bells++);
    terminal.onTitleChange((text) => (title = text));
    stdout.on("data", (chunk: Buffer) => {
        written = written.then(() => new Promise<void>((done) => terminal.write(chunk, done)));
        const text = stripVTControlCharacters(String(chunk).replace(TITLE, "").replaceAll("\x07", ""));
        if (text.trim()) recorded?.push(text);
    });
    let errors = "";
    stderr.on("data", (chunk: Buffer) => (errors += chunk));
    let chunks = 0;
    let unparsed = 0;
    let cursorHidden = false;
    let sgr = false;
    stdout.on("data", (chunk: Buffer) => {
        chunks++;
        unparsed++;
        void written.then(() => unparsed--);
        const text = String(chunk);
        cursorHidden = modeAfter(text, "\x1b[?25l", "\x1b[?25h", cursorHidden);
        sgr = modeAfter(text, "\x1b[?1006h", "\x1b[?1006l", sgr);
    });

    async function screen(): Promise<string[]> {
        await written;
        const buffer = terminal.buffer.active;
        return Array.from(
            { length: terminal.rows },
            (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
        );
    }
    return {
        io: { stdin, stdout, stderr } as unknown as TerminalIo,
        type: (keys: string) => stdin.write(keys),
        screen,
        async shows(text: string) {
            await until(async () => (await screen()).join("\n").includes(text));
        },
        async resize(columns: number, rows: number) {
            await written;
            terminal.resize(columns, rows);
            Object.assign(stdout, { columns, rows });
            stdout.emit("resize");
        },
        record() {
            const frames: string[] = [];
            recorded = frames;
            return frames;
        },
        errors: () => errors,
        rows(): string[] {
            const buffer = terminal.buffer.active;
            return Array.from(
                { length: terminal.rows },
                (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true, 0, terminal.cols) ?? "",
            );
        },
        cursor(): { x: number; y: number } | "hidden" {
            const buffer = terminal.buffer.active;
            return cursorHidden ? "hidden" : { x: buffer.cursorX, y: buffer.cursorY };
        },
        modes() {
            const { mouseTrackingMode, bracketedPasteMode } = terminal.modes;
            return { screen: terminal.buffer.active.type, mouse: mouseTrackingMode, sgr, paste: bracketedPasteMode };
        },
        bells: () => bells,
        title: () => title,
        writes: () => chunks,
        parsing: () => unparsed,
    };
}

const TITLE = /\x1b\][02];[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function modeAfter(text: string, on: string, off: string, was: boolean): boolean {
    const set = text.lastIndexOf(on);
    const reset = text.lastIndexOf(off);
    return set === -1 && reset === -1 ? was : set > reset;
}

import { setTimeout as sleep } from "node:timers/promises";
import { createElement } from "react";
import chalk from "chalk";
import { render, type Instance, type KittyKeyboardOptions } from "ink";
import type { FileOwnership } from "../adapters/agents/claude/setup/projectFiles.js";
import type { IzborClient } from "../adapters/izbor/client.js";
import { izborAddress, type ScreenFlags } from "../config.js";
import type { ActingWriter, HooksWriter } from "../domain/projectSetup.js";
import { messageOf } from "../domain/text.js";
import type { IzborInfo } from "../domain/wire.js";
import { QUIET_TITLE, rings, windowTitle } from "./alerts.js";
import { TerminalApp } from "./app.js";
import { createTerminalController, type TerminalController } from "./controller.js";
import { createRunningSessions, windowWhere } from "./live/agents.js";
import { answering } from "./live/answers.js";
import type { Wait } from "./live/observation.js";
import { sentPrompts } from "./live/prompts.js";
import { createLiveSource } from "./live/source.js";
import type { ObservationSource, TerminalSize } from "./model.js";
import { createMouseInput } from "./mouse-input.js";
import { setHighlighters } from "./words/rows.js";

export type LiveOptions = {
    client: IzborClient;
    izbor: IzborInfo | "older";
    port: number;
    run: (signal: AbortSignal) => Promise<string>;
    platform: FileOwnership;
    readKey: (path: string, signal: AbortSignal) => Promise<string>;
    env: Record<string, string | undefined>;
};

export type ProjectSetup = { port: number; hooks: HooksWriter; plugin: ActingWriter };

export type TerminalIo = { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };

function windowSize(stdout: NodeJS.WriteStream): TerminalSize {
    return { columns: stdout.columns || 80, rows: stdout.rows || 24 };
}

export function createLiveStore({ client, izbor, port, run, platform, env, readKey }: LiveOptions): ObservationSource {
    const now = () => new Date();
    const where = () => windowWhere({ izbor, port, env, platform });
    const wait: Wait = (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {});
    const running = createRunningSessions({ run, where, now });
    const prompts = sentPrompts();
    const heard = { getIzbor: client.getIzbor, readStream: prompts.hearing(client.readStream) };
    const source = createLiveSource({ client: heard, address: izborAddress(port), running, wait, now });
    const keyPath = izbor === "older" ? undefined : izbor.sendKeyPath;
    return answering(source, { client, keyPath, readKey, wait, now, prompts });
}

export function writeAlerts(
    source: ObservationSource,
    stdout: { write(text: string): unknown },
    bell = true,
): () => void {
    const write = (title: string, ring = false) => stdout.write(`${ring ? "\x07" : ""}\x1b]0;${title}\x07`);
    const first = source.getSnapshot();
    let written = windowTitle(first);
    let observed = first.observations;
    write(written);
    const stopListening = source.onChange(() => {
        const snapshot = source.getSnapshot();
        const ring = bell && rings(observed, snapshot.observations);
        observed = snapshot.observations;
        const title = windowTitle(snapshot);
        if (title === written && !ring) return;
        written = title;
        write(title, ring);
    });
    const reset = () => {
        process.off("exit", reset);
        stopListening();
        write(QUIET_TITLE);
    };
    process.once("exit", reset);
    return reset;
}

const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/** What runTerminal does when the process or the window calls. */
type ProcessCalls = {
    /** A quit signal: unmount the app. */
    stop: () => void;
    /** An uncaught exception: keep it for the exit message, then stop. */
    crash: (error: Error) => void;
    /** The process exits: dispose of the controller. */
    exit: () => void;
    /** The window was resized and the controller holds the new size: draw the app at it now. */
    redraw: () => void;
};

/**
 * Listens for the quit signals, an uncaught exception, an unhandled rejection (shown in the app), the process exit
 * and a resize, then starts `alerts`, the window's title and bell. Returns one undo: it takes the listeners off in
 * the same order and ends the alerts last.
 */
function listenToProcess(
    io: TerminalIo,
    controller: TerminalController,
    alerts: () => () => void,
    on: ProcessCalls,
): () => void {
    const rejected = (reason: unknown) => controller.showError(`Unexpected error: ${messageOf(reason)}`);
    const resize = () => {
        const { columns, rows } = windowSize(io.stdout);
        controller.resize(columns, rows);
        on.redraw();
    };
    for (const signal of QUIT_SIGNALS) process.on(signal, on.stop);
    process.once("uncaughtException", on.crash);
    process.on("unhandledRejection", rejected);
    process.once("exit", on.exit);
    io.stdout.on("resize", resize);
    const endAlerts = alerts();
    return () => {
        for (const signal of QUIT_SIGNALS) process.off(signal, on.stop);
        process.off("uncaughtException", on.crash);
        process.off("unhandledRejection", rejected);
        process.off("exit", on.exit);
        io.stdout.off("resize", resize);
        endAlerts();
    };
}

/**
 * Fills the code blocks' syntax colours (`setHighlighters`) when the screen has colour, before the first frame, since
 * the agent's rows are laid out once and kept. The grammars load only here, never for `izbor --help`; if they fail to
 * load, the registry stays empty and every fence draws in the code tone (doc 01 R4).
 */
async function loadHighlighters(color: boolean): Promise<void> {
    if (!color) return;
    await import("./words/highlight.js")
        .then(({ addHighlighters }) => setHighlighters(addHighlighters))
        .catch(() => {});
}

/**
 * Lets colour off keep bold, italic, underline and reverse (SPEC § Colours): chalk's level 0, from `--no-color` or CI,
 * would drop them too, so Ink draws at level 1 while Copy passes no colour. A dumb terminal draws none, so its level
 * stays. Returns the undo, which puts the old level back.
 */
function keepAttributes(color: boolean, { dumb }: ScreenFlags): () => void {
    const level = chalk.level;
    if (!color && !dumb) chalk.level = 1;
    return () => {
        chalk.level = level;
    };
}

/**
 * The kitty keyboard protocol's first level, for a terminal whose screen flags say it reports keys (`keys`): Shift-Enter
 * then comes as a key of its own, and starts a new line in the field. Never `mode: "auto"`, which writes the query
 * `ESC [?u` to every terminal, and Terminal.app prints the tail of a query it does not know. Ink pops the mode when the
 * app unmounts, so a quit, a signal or a crash gives the shell its keys back.
 */
const KITTY_KEYS: KittyKeyboardOptions = { mode: "enabled", flags: ["disambiguateEscapeCodes"] };

export async function runTerminal(
    {
        screen,
        source,
        initialIds = [],
        setup,
        feedback = "",
        notes = [],
    }: {
        screen: ScreenFlags;
        source: ObservationSource;
        initialIds?: readonly string[];
        setup: ProjectSetup;
        feedback?: string;
        notes?: readonly string[];
    },
    io: TerminalIo = process,
): Promise<number> {
    const fail = (message: string) => {
        io.stderr.write(`${message}\n`);
        return 1;
    };
    const printNotes = () => notes.forEach((note) => io.stdout.write(`${note}\n`));
    if (!io.stdin.isTTY || !io.stdout.isTTY) {
        source.dispose();
        printNotes();
        return fail("Interactive mode needs a terminal.");
    }

    let instance: Instance | undefined;
    let redrawQueued = false;
    let disposed = false;

    function scheduleRender() {
        if (!instance || redrawQueued || disposed) return;
        redrawQueued = true;
        setImmediate(() => {
            redrawQueued = false;
            if (!disposed) instance?.rerender(tree());
        });
    }

    const controller = createTerminalController(source, {
        initialIds,
        oldBuild: screen.oldBuild,
        abilities: { links: screen.links, strike: screen.strike, shiftEnter: screen.shiftEnter },
        ...windowSize(io.stdout),
        note: feedback,
        hooks: { port: setup.port, write: setup.hooks },
        plugin: { port: setup.port, change: setup.plugin },
        changed: scheduleRender,
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        controller.dispose();
    }

    const color = screen.color && chalk.level > 0;
    await loadHighlighters(color);
    const restoreLevel = keepAttributes(color, screen);

    function tree() {
        return createElement(TerminalApp, { controller, color, mouseEnabled: screen.mouse });
    }

    const input = screen.mouse ? createMouseInput(io.stdin) : undefined;
    let failure: Error | undefined;
    const stop = () => instance?.unmount();
    const unlisten = listenToProcess(io, controller, () => writeAlerts(source, io.stdout, screen.bell), {
        stop,
        crash: (error) => {
            failure = error;
            stop();
        },
        exit: dispose,
        redraw: () => {
            if (!disposed) instance?.rerender(tree());
        },
    });

    try {
        instance = render(tree(), {
            stdin: input?.stdin ?? io.stdin,
            stdout: io.stdout,
            stderr: io.stderr,
            alternateScreen: true,
            interactive: true,
            exitOnCtrlC: false,
            kittyKeyboard: screen.keys === "kitty" ? KITTY_KEYS : undefined,
        });
        await instance.waitUntilExit();
    } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
    } finally {
        instance?.unmount();
        input?.dispose();
        dispose();
        unlisten();
        restoreLevel();
    }
    printNotes();
    return failure ? fail(`The terminal app stopped: ${failure.message}`) : 0;
}

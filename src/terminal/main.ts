import { setTimeout as sleep } from "node:timers/promises";
import { createElement } from "react";
import chalk from "chalk";
import { render, type Instance } from "ink";
import type { FileOwnership } from "../adapters/agents/claude/setup/projectFiles.js";
import type { IzborClient } from "../adapters/izbor/client.js";
import { izborAddress, type ScreenFlags } from "../config.js";
import type { ActingWriter, HooksWriter } from "../domain/projectSetup.js";
import { messageOf } from "../domain/text.js";
import type { IzborInfo } from "../domain/wire.js";
import { QUIET_TITLE, rings, windowTitle } from "./alerts.js";
import { TerminalApp } from "./app.js";
import { createTerminalController } from "./controller.js";
import { createRunningSessions, windowWhere } from "./live/agents.js";
import { answering } from "./live/answers.js";
import type { Wait } from "./live/observation.js";
import { sentPrompts } from "./live/prompts.js";
import { createLiveSource } from "./live/source.js";
import type { ObservationSource, TerminalSize } from "./model.js";
import { createMouseInput } from "./mouse-input.js";

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

    function tree() {
        return createElement(TerminalApp, { controller, color, mouseEnabled: screen.mouse });
    }

    const input = screen.mouse ? createMouseInput(io.stdin) : undefined;
    let failure: Error | undefined;
    const stop = () => instance?.unmount();
    const abort = (error: Error) => {
        failure = error;
        stop();
    };
    const rejected = (reason: unknown) => controller.showError(`Unexpected error: ${messageOf(reason)}`);
    for (const signal of QUIT_SIGNALS) process.on(signal, stop);
    process.once("uncaughtException", abort);
    process.on("unhandledRejection", rejected);
    process.once("exit", dispose);
    const onResize = () => {
        const { columns, rows } = windowSize(io.stdout);
        controller.resize(columns, rows);
        if (!disposed) instance?.rerender(tree());
    };
    io.stdout.on("resize", onResize);
    const endAlerts = writeAlerts(source, io.stdout, screen.bell);

    try {
        instance = render(tree(), {
            stdin: input?.stdin ?? io.stdin,
            stdout: io.stdout,
            stderr: io.stderr,
            alternateScreen: true,
            interactive: true,
            exitOnCtrlC: false,
        });
        await instance.waitUntilExit();
    } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
    } finally {
        instance?.unmount();
        input?.dispose();
        dispose();
        for (const signal of QUIT_SIGNALS) process.off(signal, stop);
        process.off("uncaughtException", abort);
        process.off("unhandledRejection", rejected);
        process.off("exit", dispose);
        io.stdout.off("resize", onResize);
        endAlerts();
    }
    printNotes();
    return failure ? fail(`The terminal app stopped: ${failure.message}`) : 0;
}

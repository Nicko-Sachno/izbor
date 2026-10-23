import { useEffect, useReducer } from "react";
import { useApp, useInput, usePaste, type Key } from "ink";
import type { TerminalController } from "./controller.js";
import { FIELD_FOCUS } from "./focus.js";
import { listedSessions, waitStart, type HitTarget, type TerminalView } from "./model.js";
import { settling } from "./presentation.js";
import { contains, TerminalScreen } from "./screen.js";
import { useMouse } from "./mouse.js";

function controllerKey(input: string, key: Key) {
    const name = key.tab
        ? "tab"
        : key.return
          ? "return"
          : key.escape
            ? "escape"
            : key.upArrow
              ? "up"
              : key.downArrow
                ? "down"
                : key.leftArrow
                  ? "left"
                  : key.rightArrow
                    ? "right"
                    : key.pageUp
                      ? "pageup"
                      : key.pageDown
                        ? "pagedown"
                        : key.home
                          ? "home"
                          : key.end
                            ? "end"
                            : key.backspace
                              ? "backspace"
                              : key.delete
                                ? "delete"
                                : key.ctrl
                                  ? input.toLowerCase()
                                  : undefined;
    return { name, ctrl: key.ctrl, meta: key.meta, shift: key.shift };
}

const CONTROL_NAMES: Record<string, string> = { "\x01": "a", "\x05": "e", "\x15": "u" };

function act(controller: TerminalController, target: HitTarget | undefined, { x, y }: { x: number; y: number }): void {
    switch (target?.type) {
        case undefined:
            return;
        case "session":
            return controller.observeAndOpen(target.id);
        case "project":
            return controller.actOnProjectLine(target.checkout);
        case "back":
            return controller.back();
        case "tab":
            return controller.showScreen(target.screen);
        case "help":
            return controller.toggleHelp();
        case "stop":
            return controller.stopObserving(target.id);
        case "detail":
            return controller.focusDetail();
        case "hide":
            return controller.hideBrief();
        case "send":
            controller.focusField();
            return controller.keypress(undefined, { name: "return" });
        case "field": {
            const row = target.indices[Math.max(0, Math.min(target.indices.length - 1, y - target.origin.y))] ?? [];
            const column = Math.max(0, Math.min(row.length - 1, x - target.origin.x));
            return controller.focusField(row[column] ?? controller.view.field.text.length);
        }
        default: {
            const unreached: never = target;
            return unreached;
        }
    }
}

function clockShows(view: TerminalView, now: Date): boolean {
    if (view.small || view.help) return false;
    if (view.expanded || (view.wide && !view.briefHidden && view.selected)) return true;
    const listed = view.screen === "home" ? listedSessions(view.list) : [];
    return (
        view.sessions.some(({ brief }) => settling(waitStart(brief), now)) ||
        listed.some(({ waitingSince }) => settling(waitingSince, now))
    );
}

export function TerminalApp({
    controller,
    color,
    mouseEnabled = true,
}: {
    controller: TerminalController;
    color: boolean;
    mouseEnabled?: boolean;
}) {
    const size = controller.size();
    const { exit } = useApp();
    const [, tick] = useReducer((value: number) => value + 1, 0);

    useMouse((event) => {
        if (controller.view.small) return;
        const current = controller.layout();
        if (event.type === "scroll") {
            if (current.detail?.viewport && contains(current.detail.viewport, event.x, event.y))
                controller.scrollDetailBy((event.delta ?? 0) * 3, current.detail.maxScroll);
            else if (current.viewport && contains(current.viewport, event.x, event.y))
                controller.scrollBy((event.delta ?? 0) * 3, current.maxScroll);
            return;
        }
        const target = current.targets?.find(({ rect }) => contains(rect, event.x, event.y));
        act(controller, target, event);
    }, mouseEnabled);

    useEffect(() => {
        const clock = setInterval(() => {
            if (clockShows(controller.view, new Date())) tick();
        }, 1000);
        clock.unref();
        return () => clearInterval(clock);
    }, [controller]);

    useInput((input, key) => {
        if (key.eventType === "release") return;
        if (key.ctrl && ["c", "d"].includes(input.toLowerCase())) {
            exit();
            return;
        }
        if (controller.view.small) return;
        if (input.length > 1 && /^[\x01\x05\x15]+$/.test(input)) {
            for (const control of input) controller.keypress(undefined, { name: CONTROL_NAMES[control], ctrl: true });
            return;
        }
        const { maxScroll, step } = controller.pane();
        controller.keypress(input, controllerKey(input, key), maxScroll, step, controller.layout().fieldColumns);
    });

    usePaste((text) => {
        if (controller.view.small) return;
        if (controller.view.focused === FIELD_FOCUS) {
            const { maxScroll, step } = controller.layout();
            controller.keypress(text, { paste: true }, maxScroll, step);
        }
    });

    return <TerminalScreen view={controller.view} size={size} color={color} onLayout={controller.measured} />;
}

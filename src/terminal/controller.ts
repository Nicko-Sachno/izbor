import { homedir } from "node:os";
import type { ActingWriter, HooksWriter } from "../domain/projectSetup.js";
import { messageOf, shortId } from "../domain/text.js";
import { emptyField, hooked } from "./field.js";
import { createSubmission } from "./submission.js";
import { DETAIL_FOCUS, FIELD_FOCUS, focusedCheckout, HELP_FOCUS, projectFocus } from "./focus.js";
import { actingFeedback, hooksFeedback } from "./project-feedback.js";
import {
    listedSession,
    listedSessions,
    type NavigationView,
    type Observation,
    type ObservationSource,
    type Screen,
    type SessionList,
    type TerminalSize,
    type TerminalView,
    type ViewportLayout,
} from "./model.js";
import { projectAct, projectsOf } from "./projects.js";
import { clip, sessionName, singleLine } from "./presentation.js";
import { characterEdges } from "./line-editor.js";
import { terminalLayout } from "./layout.js";
import { createNavigation } from "./navigation.js";

type Key = { name?: string | undefined; ctrl?: boolean; meta?: boolean; shift?: boolean };
function homeLines(list: SessionList, home: string): string[] {
    return projectsOf(listedSessions(list), home).flatMap(({ checkout, sessions }) => [
        projectFocus(checkout),
        ...sessions.map(({ id }) => id),
    ]);
}
function followLine(focused: string | null, before: readonly string[], lines: readonly string[]): string | null {
    const index = focused !== null && !lines.includes(focused) ? before.indexOf(focused) : -1;
    return index === -1 ? focused : (lines[Math.min(index, lines.length - 1)] ?? null);
}

function briefLetter(text: string | undefined, key: Key): "m" | "h" | "s" | undefined {
    return !key.ctrl && !key.meta && (text === "m" || text === "h" || text === "s") ? text : undefined;
}

function initialView(
    source: ObservationSource,
    home: string,
    navigation: NavigationView,
    oldBuild: boolean,
): TerminalView {
    return {
        get sessions() {
            return source.getSnapshot().observations;
        },
        get list() {
            return source.getSnapshot().list;
        },
        get izbor() {
            return source.getSnapshot().izbor;
        },
        get screen() {
            return navigation.screen;
        },
        get focused() {
            return navigation.focused;
        },
        get selected() {
            return navigation.selected;
        },
        get wide() {
            return navigation.wide;
        },
        get small() {
            return navigation.small;
        },
        get briefHidden() {
            return navigation.briefHidden;
        },
        get metadataExpanded() {
            return navigation.metadataExpanded;
        },
        get expanded() {
            return navigation.expanded;
        },
        get help() {
            return navigation.help;
        },
        get scroll() {
            return navigation.scroll;
        },
        get detailScroll() {
            return navigation.detailScroll;
        },
        feedback: "",
        feedbackIsError: false,
        field: emptyField(),
        home,
        oldBuild,
    };
}

const STOP_TASK_CELLS = 28;

function stopNews({ id, brief }: Observation): string {
    const task = singleLine(brief?.task?.text ?? "");
    const name = task ? `“${clip(task, STOP_TASK_CELLS)}”` : shortId(id);
    return `Stopped observing ${name}. The session keeps running. Observe › on Home brings it back.`;
}

function say(view: TerminalView, text: string, error: boolean): void {
    view.feedback = text;
    view.feedbackIsError = error;
}

export interface TerminalController {
    readonly view: TerminalView;
    keypress(text: string | undefined, key: Key, maxScroll?: number, pageSize?: number): void;
    resize(columns: number, rows?: number): void;
    size(): TerminalSize;
    measured(value: ViewportLayout): void;
    layout(): ViewportLayout;
    pane(): ViewportLayout;
    toggleMetadata(): void;
    hideBrief(): void;
    openSession(id: string): void;
    observe(id: string): void;
    addHooks(checkout: string): void;
    addPlugin(checkout: string): void;
    actOnProjectLine(checkout: string): void;
    observeAndOpen(id: string): void;
    back(): void;
    toggleHelp(): void;
    stopObserving(id: string): void;
    focusField(cursor?: number): void;
    showScreen(screen: Screen): void;
    focusDetail(): void;
    scrollBy(rows: number, maxScroll: number): void;
    scrollDetailBy(rows: number, maxScroll: number): void;
    showError(text: string): void;
    dispose(): void;
}

type ControllerOptions = {
    initialIds?: readonly string[];
    columns?: number;
    rows?: number;
    note?: string;
    hooks: { port: number; write: HooksWriter };
    plugin: { port: number; change: ActingWriter };
    home?: string;
    oldBuild?: boolean;
    changed(): void;
};

export function createTerminalController(source: ObservationSource, options: ControllerOptions): TerminalController {
    let disposed = false;
    let columns = options.columns ?? 80;
    let rows = options.rows ?? 24;
    const navigation = createNavigation(terminalLayout(columns, rows));
    const view = initialView(source, options.home ?? homedir(), navigation.state, !!options.oldBuild);
    let measuredLayout: ViewportLayout = { maxScroll: 0, pageSize: 1, scroll: 0 };
    const addingPlugin = new Set<string>();
    const { sideBriefVisible, briefVisible, showScreen, back, toggleHelp, toggleMetadata, hideBrief, scrollBy } =
        navigation;
    const submission = createSubmission(source, view, options.changed, fieldSession);

    function fieldSession(): Observation | undefined {
        const id = briefVisible() ? (sideBriefVisible() ? view.selected : view.expanded) : null;
        return view.sessions.find((session) => session.id === id && hooked(session.id, view.list));
    }

    const scrollsDetail = () => view.focused === DETAIL_FOCUS || (view.focused === FIELD_FOCUS && sideBriefVisible());

    const message = submission.message;

    function observe(id: string) {
        const answer = source.observe(id);
        if (answer === "already") {
            message(`${shortId(id)} is already in this view.`);
            return;
        }
        navigation.observe(id);
        message(`Observing ${shortId(id)}${answer === "again" ? " again" : ""}.`);
    }

    function refreshSessions() {
        void source.refreshSessions().catch((error: unknown) => {
            if (disposed) return;
            message(`Could not refresh sessions: ${messageOf(error)}`, true);
            options.changed();
        });
    }

    function changeHooks(checkout: string): void {
        if (disposed) return;
        const result = options.hooks.write({ change: "add", folder: checkout, port: options.hooks.port });
        message(hooksFeedback(result, view.home), "refused" in result);
        if (!("refused" in result) && result.done === "added") refreshSessions();
    }

    function changePlugin(checkout: string): Promise<void> {
        if (disposed) return Promise.resolve();
        message("Adding Izbor's plugin…");
        const request = { change: "add" as const, folder: checkout, port: options.plugin.port };
        return options.plugin
            .change(request)
            .then((result) => {
                if (disposed) return;
                message(actingFeedback(result, view.home), "refused" in result);
                if (!("refused" in result) && result.done !== "already") refreshSessions();
                options.changed();
            })
            .catch((error: unknown) => {
                if (disposed) return;
                message(`Could not add the plugin: ${messageOf(error)}`, true);
                options.changed();
            });
    }

    function actOnProjectLine(checkout: string) {
        const project = projectsOf(listedSessions(view.list), view.home).find(
            (project) => project.checkout === checkout,
        );
        const act = project && projectAct(project);
        if (act === "add hooks") changeHooks(checkout);
        else if (act === "add plugin" && !addingPlugin.has(checkout)) {
            addingPlugin.add(checkout);
            void changePlugin(checkout).finally(() => addingPlugin.delete(checkout));
        }
    }

    function listedName(id: string): string {
        const listed = listedSession(view.list, id);
        return listed ? sessionName(listed) : shortId(id);
    }

    function observeAndOpen(id: string) {
        if (!view.sessions.some((session) => session.id === id)) message(`Observing ${listedName(id)}.`);
        openSession(id);
    }

    function stopObserving(id: string) {
        const index = view.sessions.findIndex((session) => session.id === id);
        const row = view.sessions[index];
        if (!row) return;
        source.leave(id);
        navigation.leftSession(
            id,
            index,
            view.sessions.map(({ id }) => id),
        );
        message(stopNews(row));
    }

    function moveFocus(direction: number) {
        const lines = view.screen === "home" ? homeLines(view.list, view.home) : view.sessions.map(({ id }) => id);
        navigation.moveFocus(direction, lines, !!fieldSession());
    }

    function openSession(id: string) {
        source.observe(id);
        if (view.sessions.some((session) => session.id === id)) navigation.openSession(id);
    }

    function resize(nextColumns: number, nextRows = 24) {
        if (columns === nextColumns && rows === nextRows) return;
        columns = nextColumns;
        rows = nextRows;
        navigation.resize(terminalLayout(columns, rows));
        options.changed();
    }

    function keypress(text: string | undefined, key: Key, maxScroll = 0, pageSize = 10) {
        if (view.small) return;
        if (key.ctrl && key.name === "g") {
            toggleHelp();
        } else if (key.ctrl && key.name === "o") {
            showScreen(view.screen === "home" ? "sessions" : "home");
        } else if (key.name === "tab") {
            moveFocus(key.shift ? -1 : 1);
        } else if (key.name === "escape") {
            if (view.focused === FIELD_FOCUS) navigation.leaveField();
            else back();
        } else if (key.name === "return") {
            const checkout = focusedCheckout(view.focused);
            if (view.focused === FIELD_FOCUS) void submission.send(fieldSession());
            else if (view.focused === HELP_FOCUS) toggleHelp();
            else if (view.focused === DETAIL_FOCUS || (view.expanded !== null && view.focused === view.expanded)) {
                if (fieldSession()) navigation.focusField();
            } else if (checkout !== undefined) actOnProjectLine(checkout);
            else if (view.focused !== null) observeAndOpen(view.focused);
        } else if (key.name === "pageup" || key.name === "pagedown") {
            scrollBy(key.name === "pageup" ? -pageSize : pageSize, maxScroll, scrollsDetail());
        } else if (view.focused === FIELD_FOCUS) {
            submission.edit(text, key, fieldSession());
        } else if (view.focused !== HELP_FOCUS && briefLetter(text, key) === "h") {
            hideBrief();
        } else if (view.focused !== null) {
            const detailId = sideBriefVisible() && view.focused === DETAIL_FOCUS ? view.selected : view.expanded;
            const letter = detailId && !view.help && view.focused !== HELP_FOCUS ? briefLetter(text, key) : undefined;
            if (letter === "m") toggleMetadata();
            else if (letter === "s" && detailId) stopObserving(detailId);
            else if (key.name === "up" || key.name === "down") {
                const direction = key.name === "up" ? -1 : 1;
                if (view.expanded || view.help || view.focused === DETAIL_FOCUS)
                    scrollBy(direction, maxScroll, view.focused === DETAIL_FOCUS);
                else moveFocus(direction);
            }
        }
        options.changed();
    }

    let lastIzbor = source.getSnapshot().izbor.state;
    let lastHomeLines = homeLines(view.list, view.home);
    const stopListening = source.onChange(() => {
        const izbor = source.getSnapshot().izbor.state;
        if (izbor === "up" && lastIzbor !== "up") say(view, "Izbor is back", false);
        lastIzbor = izbor;
        const lines = homeLines(view.list, view.home);
        navigation.followHomeFocus((focused) => followLine(focused, lastHomeLines, lines));
        lastHomeLines = lines;
        options.changed();
    });
    for (const id of options.initialIds ?? []) observe(id);
    showScreen(view.sessions.length ? "sessions" : "home");
    message(options.note ?? "");

    const rendered =
        <Args extends unknown[]>(fn: (...args: Args) => void) =>
        (...args: Args) => {
            if (disposed) return;
            fn(...args);
            options.changed();
        };

    return {
        view,
        keypress,
        resize,
        size: (): TerminalSize => ({ columns, rows }),
        measured(value: ViewportLayout) {
            if (view.small) return;
            measuredLayout = value;
            navigation.measured(value);
        },
        layout: () => measuredLayout,
        pane: () => (scrollsDetail() ? (measuredLayout.detail ?? measuredLayout) : measuredLayout),
        toggleMetadata: rendered(toggleMetadata),
        hideBrief: rendered(hideBrief),
        openSession: rendered(openSession),
        observe: rendered(observe),
        addHooks: rendered(changeHooks),
        addPlugin: rendered((checkout: string) => void changePlugin(checkout)),
        actOnProjectLine: rendered(actOnProjectLine),
        observeAndOpen: rendered(observeAndOpen),
        back: rendered(back),
        toggleHelp: rendered(toggleHelp),
        stopObserving: rendered(stopObserving),
        focusField(cursor = view.field.text.length) {
            if (!fieldSession()) return;
            navigation.focusField();
            const edges = characterEdges(view.field.text);
            view.field = { ...view.field, cursor: edges.findLast((index) => index <= cursor) ?? 0 };
            options.changed();
        },
        showScreen: rendered(showScreen),
        focusDetail() {
            if (!sideBriefVisible()) return;
            navigation.focusDetail();
            options.changed();
        },
        scrollBy: rendered((rows: number, maxScroll: number) => scrollBy(rows, maxScroll)),
        scrollDetailBy: rendered((rows: number, maxScroll: number) => scrollBy(rows, maxScroll, true)),
        showError: rendered((text: string) => say(view, text, true)),
        dispose() {
            if (disposed) return;
            disposed = true;
            submission.dispose();
            stopListening();
            source.dispose();
        },
    };
}

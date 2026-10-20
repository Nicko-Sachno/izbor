import { DETAIL_FOCUS, FIELD_FOCUS, HELP_FOCUS } from "./focus.js";
import type { NavigationView, Screen, ViewportLayout } from "./model.js";

type ContentPage = { kind: "overview"; screen: Screen } | { kind: "brief"; session: string; overviewScroll: number };
type TerminalPage = ContentPage | { kind: "help"; returnTo: ContentPage; focused: string | null; scroll: number };
type NavigationState = { -readonly [Key in keyof NavigationView]: NavigationView[Key] } & {
    page: TerminalPage;
    metadataScroll: number;
};

const contentPage = (view: NavigationState): ContentPage =>
    view.page.kind === "help" ? view.page.returnTo : view.page;

function initialNavigation({ wide, small }: { wide: boolean; small: boolean }): NavigationState {
    const view: NavigationState = {
        page: { kind: "overview", screen: "home" },
        get screen() {
            const page = contentPage(view);
            return page.kind === "brief" ? "sessions" : page.screen;
        },
        focused: null,
        selected: null,
        wide,
        small,
        briefHidden: false,
        metadataExpanded: false,
        metadataScroll: 0,
        get expanded() {
            const page = contentPage(view);
            return page.kind === "brief" ? page.session : null;
        },
        get help() {
            return view.page.kind === "help";
        },
        scroll: 0,
        detailScroll: 0,
    };
    return view;
}

function readNavigation(view: NavigationState): NavigationView {
    return Object.freeze({
        get screen() {
            return view.screen;
        },
        get focused() {
            return view.focused;
        },
        get selected() {
            return view.selected;
        },
        get wide() {
            return view.wide;
        },
        get small() {
            return view.small;
        },
        get briefHidden() {
            return view.briefHidden;
        },
        get metadataExpanded() {
            return view.metadataExpanded;
        },
        get expanded() {
            return view.expanded;
        },
        get help() {
            return view.help;
        },
        get scroll() {
            return view.scroll;
        },
        get detailScroll() {
            return view.detailScroll;
        },
    });
}

function focusAndScroll(view: NavigationState, sideBriefVisible: () => boolean) {
    return {
        moveFocus(direction: number, lines: readonly string[], fieldAvailable: boolean) {
            const field = fieldAvailable ? [FIELD_FOCUS] : [];
            const choices = view.help
                ? [HELP_FOCUS]
                : sideBriefVisible()
                  ? [...lines, DETAIL_FOCUS, ...field, HELP_FOCUS]
                  : view.expanded
                    ? [view.expanded, ...field, HELP_FOCUS]
                    : [...lines, HELP_FOCUS];
            const current = choices.indexOf(view.focused ?? "");
            const next =
                current === -1 ? (direction > 0 ? 0 : -1) : (current + direction + choices.length) % choices.length;
            view.focused = choices.at(next) ?? null;
            if (!view.expanded && !view.help && !view.wide) view.scroll = 0;
        },
        focusField() {
            view.focused = FIELD_FOCUS;
        },
        leaveField() {
            view.focused = view.expanded ?? DETAIL_FOCUS;
        },
        focusDetail() {
            if (sideBriefVisible()) view.focused = DETAIL_FOCUS;
        },
        scrollBy(rows: number, maxScroll: number, detail = false) {
            const scroll = detail ? "detailScroll" : "scroll";
            view[scroll] = Math.max(0, Math.min(maxScroll, view[scroll] + rows));
        },
        measured(value: ViewportLayout) {
            if (view.small) return;
            view.scroll = value.scroll;
            if (value.detail) view.detailScroll = value.detail.scroll;
        },
        followHomeFocus(follow: (focus: string | null) => string | null) {
            if (view.screen !== "home") return;
            view.focused = follow(view.focused);
            if (view.page.kind === "help") view.page.focused = follow(view.page.focused);
        },
    };
}

export function createNavigation(size: { wide: boolean; small: boolean }) {
    const view = initialNavigation(size);
    const scrolls: Record<Screen, number> = { home: 0, sessions: 0 };
    const sideBriefVisible = () =>
        view.screen === "sessions" &&
        view.wide &&
        !view.briefHidden &&
        view.selected !== null &&
        !view.help &&
        !view.small;
    const briefVisible = () => !view.help && !view.small && (sideBriefVisible() || view.expanded !== null);

    function closeBrief() {
        const page = contentPage(view);
        if (page.kind !== "brief") return;
        const overview: ContentPage = { kind: "overview", screen: "sessions" };
        if (view.page.kind === "help") {
            view.detailScroll = view.page.scroll;
            view.page = { ...view.page, returnTo: overview, scroll: page.overviewScroll };
        } else {
            view.detailScroll = view.scroll;
            view.page = overview;
            view.scroll = page.overviewScroll;
        }
    }

    function back() {
        if (view.page.kind === "help") {
            const page = view.page;
            view.page = page.returnTo;
            view.focused = page.focused;
            view.scroll = page.scroll;
        } else if (view.page.kind === "brief") {
            view.focused = view.page.session;
            closeBrief();
        } else if (view.wide && view.focused === DETAIL_FOCUS) view.focused = view.selected;
        else if (view.screen === "sessions") showScreen("home");
        else view.focused = null;
    }

    function showScreen(screen: Screen) {
        if (view.screen === screen) return;
        if (view.help) back();
        closeBrief();
        scrolls[view.screen] = view.scroll;
        view.page = { kind: "overview", screen };
        view.scroll = scrolls[screen];
        if (view.focused !== HELP_FOCUS) view.focused = null;
    }

    function openSession(id: string) {
        if (view.help) back();
        showScreen("sessions");
        if (view.selected !== id) {
            view.detailScroll = 0;
            view.metadataExpanded = false;
        }
        view.selected = id;
        view.briefHidden = false;
        if (view.wide) {
            view.focused = DETAIL_FOCUS;
            return;
        }
        const page = contentPage(view);
        view.page = {
            kind: "brief",
            session: id,
            overviewScroll: page.kind === "brief" ? page.overviewScroll : view.scroll,
        };
        view.focused = id;
        view.scroll = view.detailScroll;
    }

    function toggleHelp() {
        if (view.page.kind === "help") back();
        else {
            view.page = { kind: "help", returnTo: view.page, focused: view.focused, scroll: view.scroll };
            view.focused = HELP_FOCUS;
            view.scroll = 0;
        }
    }

    function resize({ wide, small }: { wide: boolean; small: boolean }) {
        view.small = small;
        if (small || view.wide === wide) return;
        const page = contentPage(view);
        if (wide && page.kind === "brief") {
            view.selected = page.session;
            if (view.page.kind === "help") {
                view.detailScroll = view.page.scroll;
                view.page.scroll = page.overviewScroll;
                if (view.page.focused === page.session) view.page.focused = DETAIL_FOCUS;
            } else {
                view.detailScroll = view.scroll;
                view.scroll = page.overviewScroll;
                if (view.focused === page.session) view.focused = DETAIL_FOCUS;
            }
        }
        if (!wide) {
            if (view.focused === DETAIL_FOCUS || view.focused === FIELD_FOCUS) view.focused = view.selected;
            if (view.page.kind === "help" && (view.page.focused === DETAIL_FOCUS || view.page.focused === FIELD_FOCUS))
                view.page.focused = view.selected;
        }
        if (page.kind === "brief") {
            const overview: ContentPage = { kind: "overview", screen: "sessions" };
            if (view.page.kind === "help") view.page.returnTo = overview;
            else view.page = overview;
        }
        view.wide = wide;
    }

    return {
        state: readNavigation(view),
        sideBriefVisible,
        briefVisible,
        showScreen,
        openSession,
        back,
        toggleHelp,
        resize,
        ...focusAndScroll(view, sideBriefVisible),
        observe(id: string) {
            view.selected ??= id;
            if (view.help) back();
            closeBrief();
            showScreen("sessions");
        },
        leftSession(id: string, index: number, remainingIds: readonly string[]) {
            if (view.expanded === id) closeBrief();
            if (view.selected === id) {
                view.selected = remainingIds[Math.min(index, remainingIds.length - 1)] ?? null;
                view.detailScroll = 0;
                view.metadataExpanded = false;
            }
            view.focused = null;
            if (!remainingIds.length) showScreen("home");
        },
        toggleMetadata() {
            if (!briefVisible()) return;
            view.focused = sideBriefVisible() ? DETAIL_FOCUS : view.expanded;
            const scroll = sideBriefVisible() ? "detailScroll" : "scroll";
            view.metadataExpanded = !view.metadataExpanded;
            if (view.metadataExpanded) {
                view.metadataScroll = view[scroll];
                view[scroll] = Number.MAX_SAFE_INTEGER;
            } else view[scroll] = view.metadataScroll;
        },
        hideBrief() {
            if (!briefVisible()) return;
            closeBrief();
            view.briefHidden = true;
            view.focused = view.selected;
        },
    };
}

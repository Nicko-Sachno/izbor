import type { HitTarget, Rectangle, Screen, TerminalSize, ViewportLayout } from "./model.js";

export type ViewportPage = { kind: "overview"; screen: Screen } | { kind: "brief"; id: string } | { kind: "help" };
export type ViewportHistory = { page: string; focus: string };
export type MeasuredTarget = { target: HitTarget; pane?: "main" | "detail" };
type MeasuredPane = { content: Rectangle; viewport: Rectangle | undefined; pageSize: number; scroll: number };
type ViewportInput = {
    page: ViewportPage;
    size: TerminalSize;
    focused: string | null;
    focus: Rectangle | undefined;
    main: MeasuredPane;
    detail: MeasuredPane | undefined;
    targets: readonly MeasuredTarget[];
};

function clipped(rect: Rectangle, viewport: Rectangle, scroll: number): Rectangle {
    const x = Math.max(rect.x, viewport.x);
    const y = Math.max(rect.y - scroll, viewport.y);
    return {
        x,
        y,
        width: Math.max(0, Math.min(rect.x + rect.width, viewport.x + viewport.width) - x),
        height: Math.max(0, Math.min(rect.y + rect.height - scroll, viewport.y + viewport.height) - y),
    };
}

function paneLayout({ content, viewport, pageSize, scroll }: MeasuredPane) {
    const maxScroll = Math.max(0, content.height - pageSize);
    return { maxScroll, pageSize, scroll: Math.min(maxScroll, Math.max(0, scroll)), viewport };
}

export function viewportLayout(
    input: ViewportInput,
    previous?: ViewportHistory,
): {
    layout: ViewportLayout;
    history: ViewportHistory;
} {
    const { page, size, focused, focus, main } = input;
    const next = paneLayout(main);
    const pageKey = page.kind === "overview" ? `screen ${page.screen}` : page.kind === "brief" ? page.id : "help";
    const top = focus ? focus.y - main.content.y : 0;
    const focusKey = `${focused}/${pageKey}/${size.columns}/${size.rows}/${top}/${focus?.height}`;
    const returning = previous !== undefined && previous.page !== pageKey && page.kind === "overview";
    const outOfView = !!focus && (top + focus.height <= next.scroll || top >= next.scroll + main.pageSize);
    if (
        page.kind === "overview" &&
        (!returning || outOfView) &&
        focus &&
        previous?.focus !== focusKey &&
        main.pageSize > 0
    ) {
        if (top < next.scroll || focus.height > main.pageSize) next.scroll = top;
        else if (top + focus.height > next.scroll + main.pageSize) next.scroll = top + focus.height - main.pageSize;
        next.scroll = Math.min(next.maxScroll, Math.max(0, next.scroll));
    }
    const detail = input.detail && paneLayout(input.detail);
    const targets = input.targets.flatMap(({ target, pane }) => {
        if (!pane) return [target];
        const area = pane === "main" ? next : detail;
        if (!area?.viewport) return [];
        const rect = clipped(target.rect, area.viewport, area.scroll);
        return rect.width && rect.height ? [{ ...target, rect }] : [];
    });
    return {
        layout: {
            ...next,
            targets,
            detail: detail?.viewport ? { ...detail, viewport: detail.viewport } : undefined,
        },
        history: { page: pageKey, focus: focusKey },
    };
}

export function sameScrollLayout(before: ViewportLayout, after: ViewportLayout): boolean {
    return (
        before.maxScroll === after.maxScroll &&
        before.pageSize === after.pageSize &&
        before.scroll === after.scroll &&
        before.detail?.maxScroll === after.detail?.maxScroll &&
        before.detail?.pageSize === after.detail?.pageSize &&
        before.detail?.scroll === after.detail?.scroll
    );
}

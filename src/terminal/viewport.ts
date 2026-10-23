import {
    METADATA_TARGET,
    type HitTarget,
    type Rectangle,
    type Screen,
    type TerminalSize,
    type ViewportLayout,
} from "./model.js";
import type { Row } from "./response/rows.js";

export type ViewportPage = { kind: "overview"; screen: Screen } | { kind: "brief"; id: string } | { kind: "help" };
/**
 * What a pane's view reads in its full response: the row at the view's top is row `offset` of the item `key`, or a row
 * before its first from -1 back, such as the blank row before it or the label over the newest text, as the layout left
 * it at `lastScroll`. None while the view's top stands above the response.
 */
type Anchor = { key: string; offset: number; lastScroll: number };
/** Each pane's anchor, as the last layout left it. */
type Anchors = { main?: Anchor | undefined; detail?: Anchor | undefined };
/** The last layout's page, focus and each pane's anchor. */
export type ViewportHistory = Anchors & { page: string; focus: string };
export type MeasuredTarget = { target: HitTarget; pane?: "main" | "detail" };
/** A pane's full response as measured: where it starts, in rows from the top of its content, and its rows. */
type MeasuredResponse = { top: number; rows: readonly Pick<Row, "item" | "line">[] };
/** A pane as measured, with its full response while one draws. */
type MeasuredPane = {
    content: Rectangle;
    viewport: Rectangle | undefined;
    pageSize: number;
    scroll: number;
    response?: MeasuredResponse | undefined;
};
/** The side Brief as measured, with the session it shows. */
export type MeasuredSide = MeasuredPane & { session: string };
type ViewportInput = {
    page: ViewportPage;
    size: TerminalSize;
    focused: string | null;
    focus: Rectangle | undefined;
    main: MeasuredPane;
    detail: MeasuredSide | undefined;
    targets: readonly MeasuredTarget[];
};

/** The pane a full response stands in, as the layout last measured it or as its view draws (`drawnPane`). */
export type ResponsePane = Pick<ViewportLayout, "scroll" | "maxScroll" | "pageSize" | "responseTop">;

/**
 * Where a pane's view stands in its full response, counted in the response's rows from its first, row 0: `top`, the
 * row at the view's top, and `end`, the row after its last one above the footer, either of which may lie outside the
 * response; and `footer`, whether the footer takes the page's last row, as it does short of the page's end (T11). The
 * C divider, the footer and the view all count from here. None before the layout has measured where it starts.
 */
export function viewRows({ scroll, maxScroll, pageSize, responseTop }: ResponsePane) {
    if (responseTop === undefined) return undefined;
    const footer = scroll < maxScroll;
    const top = scroll - responseTop;
    return { top, end: top + pageSize - (footer ? 1 : 0), footer };
}

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

/** The scroll that brings the anchor's row back to the view's top, its offset clamped to the item's rows now; the
 *  page's top once the item is gone, as after a new Task or a cut. */
function anchored({ top, rows }: MeasuredResponse, { key, offset }: Anchor): number {
    const first = rows.findIndex(({ item, line }) => item === key && line === 0);
    if (first === -1) return 0;
    const after = rows.findIndex(({ item }, index) => index > first && item !== key);
    return top + first + Math.min(offset, (after === -1 ? rows.length : after) - first - 1);
}

/** What the view reads at `scroll`: its top row's item and offset. Nothing while its top stands above the response,
 *  as at the page's top, so there the live edge keeps showing as the response grows. */
function anchorAt({ top, rows }: MeasuredResponse, scroll: number): Anchor | undefined {
    const row = rows[scroll - top];
    return row && { key: row.item, offset: row.line, lastScroll: scroll };
}

/**
 * The pane as its view draws before the layout measures it again: while the scroll is the one the last layout left and
 * a response draws, with the anchor's row back at the view's top on the response's last measured start, and the
 * page's end where these rows put it, so rows that grow above it never draw shifted for a frame and the footer counts
 * from the same rows. The layout then finds the same scroll, unless the Brief above changed height.
 */
export function drawnPane<Pane extends ResponsePane>(
    pane: Pane,
    rows: MeasuredResponse["rows"],
    last: Anchor | undefined,
    scroll: number,
): Pane {
    const top = pane.responseTop;
    if (top === undefined || !rows.length || last?.lastScroll !== scroll) return pane;
    const end = Math.max(0, top + rows.length - pane.pageSize);
    return { ...pane, scroll: Math.min(end, Math.max(0, anchored({ top, rows }, last))), maxScroll: end };
}

const sameAnchor = (before: Anchor | undefined, after: Anchor | undefined) =>
    before?.key === after?.key && before?.offset === after?.offset && before?.lastScroll === after?.lastScroll;

/** Whether two layouts left each pane the same anchor. */
export const sameAnchors = (before: Anchors | undefined, after: Anchors) =>
    sameAnchor(before?.main, after.main) && sameAnchor(before?.detail, after.detail);

/**
 * A pane's layout and its anchor. Its scroll counts from `pageSize`, the body rows with the footer's row among them,
 * since at the page's end no footer shows; its viewport is those rows on the screen, where the wheel scrolls it. On a
 * Brief with a full response PgDn and PgUp step the rows above the footer less one, so one row of the old page stays
 * in view; elsewhere a page. Metadata's last row stands two rows above the full response, with one blank row between
 * them: one row above the footer, which shows while the response is below the view. While the scroll is the one the
 * last layout left, the anchor brings back what the view read, however the rows above it and the width changed (T6).
 */
function paneLayout({ content, viewport, pageSize, scroll, response }: MeasuredPane, last: Anchor | undefined) {
    const maxScroll = Math.max(0, content.height - pageSize);
    const asked = scroll === METADATA_TARGET && response ? response.top - pageSize : scroll;
    const wanted = response && last?.lastScroll === scroll ? anchored(response, last) : asked;
    const kept = Math.min(maxScroll, Math.max(0, wanted));
    const layout = {
        maxScroll,
        pageSize,
        step: response ? Math.max(1, pageSize - 2) : pageSize,
        scroll: kept,
        viewport: viewport && { ...viewport, height: pageSize },
        responseTop: response?.top,
    };
    return { layout, anchor: response && anchorAt(response, kept) };
}

export function viewportLayout(
    input: ViewportInput,
    previous?: ViewportHistory,
): {
    layout: ViewportLayout;
    history: ViewportHistory;
} {
    const { page, size, focused, focus, main } = input;
    const { layout: next, anchor } = paneLayout(main, previous?.main);
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
    // A resize that moves the Brief from the page into the side Brief keeps what you read in it (T6).
    const moved = input.detail?.session === previous?.page ? previous?.main : undefined;
    const side = input.detail && paneLayout(input.detail, previous?.detail ?? moved);
    const detail = side?.layout;
    // A target is hit only where the pane draws it: in its drawn viewport, never under its footer.
    const targets = input.targets.flatMap(({ target, pane }) => {
        if (!pane) return [target];
        const [area, drawn] = pane === "main" ? [next, main.viewport] : [detail, input.detail?.viewport];
        if (!area || !drawn) return [];
        const rect = clipped(target.rect, drawn, area.scroll);
        return rect.width && rect.height ? [{ ...target, rect }] : [];
    });
    return {
        layout: {
            ...next,
            targets,
            detail: detail?.viewport ? { ...detail, viewport: detail.viewport } : undefined,
        },
        history: { page: pageKey, focus: focusKey, main: anchor, detail: side?.anchor },
    };
}

/**
 * Whether two layouts scroll both panes alike, the full response starting on the same row in each: the response draws
 * only the rows in view, so a Brief above it that grows or shrinks while the scroll stays needs another draw too.
 */
export function sameScrollLayout(before: ViewportLayout, after: ViewportLayout): boolean {
    return (
        before.maxScroll === after.maxScroll &&
        before.pageSize === after.pageSize &&
        before.scroll === after.scroll &&
        before.responseTop === after.responseTop &&
        before.detail?.maxScroll === after.detail?.maxScroll &&
        before.detail?.pageSize === after.detail?.pageSize &&
        before.detail?.scroll === after.detail?.scroll &&
        before.detail?.responseTop === after.detail?.responseTop
    );
}

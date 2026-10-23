import { measureElement, type DOMElement } from "ink";
import { focusedCheckout } from "./focus.js";
import type { HitTarget, Rectangle } from "./model.js";
import type { Row } from "./response/rows.js";
import type { MeasuredSide, MeasuredTarget } from "./viewport.js";

/** The screen's own elements that its layout effect measures, one of each, by the key TerminalScreen keeps it under. */
export type ScreenElement =
    | "content"
    | "viewport"
    | "detailPane"
    | "detailContent"
    | "detailViewport"
    | "back"
    | "help"
    | "stop"
    | "detailStop"
    | "hide"
    | "homeTab"
    | "sessionsTab"
    | "fieldFrame"
    | "fieldContent"
    | "send"
    | "response"
    | "detailResponse";

/** The elements on the screen now: its own by key, each session row by its id, and each Home line by its focus. */
type ScreenElements = {
    own: ReadonlyMap<ScreenElement, DOMElement>;
    sessions: ReadonlyMap<string, DOMElement>;
    lines: ReadonlyMap<string, DOMElement>;
};

/** What the screen shows, as far as its targets go. */
type TargetPage = {
    /** The session whose Brief page is open, if one is. */
    expanded: string | undefined;
    /** Help shows. */
    help: boolean;
    /** The text index under each cell of each row the field's box shows. */
    fieldIndices: number[][];
    /** The side Brief's session, body rows and scroll, while the side Brief shows. */
    side: { id: string; pageSize: number; scroll: number } | undefined;
};

/**
 * Measures every click target on the screen, in hit-test order, with the main pane's viewport and the side Brief's
 * pane. Session and project lines are targets only while the overview shows in a measured viewport.
 */
export function screenTargets(
    { own, sessions, lines }: ScreenElements,
    { expanded, help, fieldIndices, side }: TargetPage,
): { viewport: Rectangle | undefined; targets: MeasuredTarget[]; detail: MeasuredSide | undefined } {
    const targets: MeasuredTarget[] = [];
    const target = (target: HitTarget, pane?: "main" | "detail") => targets.push(pane ? { target, pane } : { target });
    const control = (key: ScreenElement, placed: (rect: Rectangle) => HitTarget, pane?: "main" | "detail") => {
        const element = own.get(key);
        if (element) target(placed(measureElement(element)), pane);
    };
    const mainViewport = own.get("viewport");
    const viewport = mainViewport ? measureElement(mainViewport) : undefined;
    if (expanded === undefined && !help && viewport) {
        for (const [id, element] of sessions) target({ type: "session", id, rect: measureElement(element) }, "main");
        for (const [focus, element] of lines) {
            const checkout = focusedCheckout(focus);
            if (checkout !== undefined) target({ type: "project", checkout, rect: measureElement(element) }, "main");
        }
    }
    control("back", (rect) => ({ type: "back", rect }));
    control("homeTab", (rect) => ({ type: "tab", screen: "home", rect }));
    control("sessionsTab", (rect) => ({ type: "tab", screen: "sessions", rect }));
    control("help", (rect) => ({ type: "help", rect }));
    control("send", (rect) => ({ type: "send", rect }));
    const fieldContent = own.get("fieldContent");
    if (fieldContent) {
        const { x, y } = measureElement(fieldContent);
        control("fieldFrame", (rect) => ({ type: "field", rect, origin: { x, y }, indices: fieldIndices }));
    }
    if (expanded !== undefined && !help) control("stop", (rect) => ({ type: "stop", id: expanded, rect }), "main");
    control("hide", (rect) => ({ type: "hide", rect }));
    const detailContent = own.get("detailContent");
    const detailViewport = own.get("detailViewport");
    if (!side || !detailContent || !detailViewport) return { viewport, targets, detail: undefined };
    const detail = {
        content: measureElement(detailContent),
        pageSize: side.pageSize,
        scroll: side.scroll,
        viewport: measureElement(detailViewport),
        session: side.id,
    };
    control("detailStop", (rect) => ({ type: "stop", id: side.id, rect }), "detail");
    control("detailPane", (rect) => ({ type: "detail", rect }));
    return { viewport, targets, detail };
}

/** A pane's full response as its layout measures it: the row it starts on in the pane's content, and its rows. */
export const measuredResponse = (
    element: DOMElement | undefined,
    rows: readonly Row[] | undefined,
    content: Rectangle,
) => element && rows && { top: measureElement(element).y - content.y, rows };

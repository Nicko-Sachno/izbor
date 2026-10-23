import type { Ref } from "react";
import { Box, Text, type DOMElement } from "ink";
import type { FullResponse } from "../../domain/response.js";
import type { Look } from "../paint.js";
import { drawnPane, viewRows, type ResponsePane, type ViewportHistory } from "../viewport.js";
import { footerLine } from "./footer.js";
import { responseRows, saysLatest, type Row } from "./rows.js";

/** What a pane's full response draws from besides the response: the pane's width, the look, the time, whether the
 *  session is idle in a project without hooks, and the most rows a code block takes. */
type Drawing = { width: number; look: Look; now: Date; noHooks: boolean; codeRows: number };

/**
 * A pane's full response as its view draws it: its rows, the footer's row, and the pane, `measured` as the layout last
 * left it, with the scroll that brings back the row `anchor` read while the scroll is still `scroll` (`drawnPane`).
 * The rows laid out for the measured pane place the anchor; where that moves the view, they are laid out again, so the
 * C divider counts in the pane as it draws, as the footer does. And whether the rows say what `Latest:` says.
 */
export function drawnResponse(
    response: FullResponse | undefined,
    { width, look, now, noHooks, codeRows }: Drawing,
    measured: ResponsePane | undefined,
    { anchor, scroll }: { anchor: ViewportHistory["main"]; scroll: number },
) {
    const rowsAt = (pane: ResponsePane | undefined) =>
        response ? responseRows(response, width, look, now, { pane, noHooks, codeRows }) : [];
    const laidOut = rowsAt(measured);
    const pane = measured && drawnPane(measured, laidOut, anchor, scroll);
    const moved = pane?.scroll !== measured?.scroll || pane?.maxScroll !== measured?.maxScroll;
    const rows = moved ? rowsAt(pane) : laidOut;
    const footer = response && footerLine(response, rows, pane, { width, look, noHooks });
    return { rows, pane, footer, saysLatest: saysLatest(rows) };
}

/**
 * The rows from `from` up to `to` that the pane shows: those in its view, above the footer. Before the layout has
 * measured where the response starts, every row down to the page's end; before it has measured the pane, every row.
 */
function inView(count: number, pane: ResponsePane | undefined): { from: number; to: number } {
    if (!pane) return { from: 0, to: count };
    const clamped = (row: number) => Math.min(count, Math.max(0, row));
    const view = viewRows(pane);
    return view
        ? { from: clamped(view.top), to: clamped(view.end) }
        : { from: 0, to: clamped(pane.scroll + pane.pageSize) };
}

/**
 * The full response under Stop observing, one blank row below it, at the pane's width. Only the rows in the pane's
 * view draw, with a spacer for the rows above them and one for the rows below, so the page keeps its height and Ink
 * lays out about a screen of rows however long the turn (doc 08 R4). Its rows come painted, so the view adds no
 * colour of its own; a blank row draws a space, since Ink gives an empty text no row.
 */
export function ResponseView({
    rows,
    width,
    pane,
    ref,
}: {
    rows: readonly Row[];
    width: number;
    pane: ResponsePane | undefined;
    ref?: Ref<DOMElement>;
}) {
    const { from, to } = inView(rows.length, pane);
    return (
        <Box ref={ref} width={width} marginTop={1} flexDirection="column" flexShrink={0}>
            <Box height={from} flexShrink={0} />
            {rows.slice(from, to).map(({ key, text }) => (
                <Text key={key}>{text || " "}</Text>
            ))}
            <Box height={rows.length - to} flexShrink={0} />
        </Box>
    );
}

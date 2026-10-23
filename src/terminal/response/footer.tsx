import { Box, Text } from "ink";
import type { FullResponse, ToolResult } from "../../domain/response.js";
import { BRIEF_WIDTH } from "../layout.js";
import { paint, type Look } from "../paint.js";
import { viewRows, type ResponsePane } from "../viewport.js";
import { footerText, isLive, type Below, type Work } from "./labels.js";
import { earlierOf, type Row } from "./rows.js";
import { isCall } from "./tools.js";

type Change = { path: string; added: number; removed: number };

/** The lines a finished edit's result added and removed: a new file adds every line it wrote; a write over a file and
 *  an edit count from their patch. None without counts, as for a call that ended before the watch. */
function changeOf(result: ToolResult | undefined): Change | undefined {
    if (result?.kind === "changed") return result;
    if (result?.kind !== "wrote") return undefined;
    if (result.created) return { path: result.path, added: result.lines, removed: 0 };
    const { path, added, removed } = result;
    return added === undefined || removed === undefined ? undefined : { path, added, removed };
}

/** The work under `Earlier in this turn`: its tool calls, and the files its finished edits changed with their lines
 *  added and removed, only when every one of them has counts. */
function turnWork({ items }: FullResponse): Work {
    const calls = earlierOf(items).filter(isCall);
    const edits = calls.filter((call) => call.type === "tool" && call.kind === "edit" && call.state === "done");
    const changes = edits.map((call) => changeOf(call.result)).filter((change) => change !== undefined);
    if (!edits.length || changes.length < edits.length) return { calls: calls.length };
    const lines = (count: (change: Change) => number) => changes.reduce((sum, change) => sum + count(change), 0);
    const files = {
        count: new Set(changes.map(({ path }) => path)).size,
        added: lines(({ added }) => added),
        removed: lines(({ removed }) => removed),
    };
    return { calls: calls.length, files };
}

/**
 * What stands below the view, counted on the laid-out rows; the view is the pane's body rows above the footer's. None
 * at the page's end, where the footer would hide only the last row, which shows instead (T11); short of it, at least
 * two rows hide, the one under the footer among them. The top part is the label with the live edge or the last
 * message, and the No transcript line over it.
 */
function below(response: FullResponse, rows: readonly Row[], pane: ResponsePane, noHooks: boolean): Below | undefined {
    const view = viewRows(pane);
    if (!view?.footer) return undefined;
    const hidden = pane.maxScroll - pane.scroll + 1;
    const top = rows.filter((row) => row.top).length;
    if (view.end > 0 && view.end < top) return { kind: "message", rows: top - view.end, work: turnWork(response) };
    const wholeEdge = top > 0 && view.end >= top && view.top <= 0 && isLive(response.end, noHooks);
    return { kind: wholeEdge ? "live edge" : "turn", rows: hidden };
}

/** What the footer reads besides the response and its rows: the pane's width, the look, and whether the session is
 *  idle in a project without hooks, whose response has no live edge. */
type FooterAround = { width: number; look: Look; noHooks: boolean };

/**
 * The footer's row while rows remain below the view of a Brief with a full response, in muted, in the first form that
 * fits the text width; undefined when none remains or the layout has not measured where the response starts.
 */
export function footerLine(
    response: FullResponse,
    rows: readonly Row[],
    pane: ResponsePane | undefined,
    { width, look, noHooks }: FooterAround,
): string | undefined {
    const what = pane && below(response, rows, pane, noHooks);
    return what && paint(footerText(what, Math.min(BRIEF_WIDTH, width)), look, { tone: "muted" });
}

/** The footer on the pane's last body row, under the view, which gives up that row while the footer shows (T2). */
export function ResponseFooter({ line }: { line: string }) {
    return (
        <Box height={1} flexShrink={0}>
            <Text>{line}</Text>
        </Box>
    );
}

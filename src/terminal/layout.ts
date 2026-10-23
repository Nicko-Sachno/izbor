export function terminalLayout(columns: number, rows = 24, splitEnabled = true) {
    columns = Math.max(1, Math.floor(columns));
    rows = Math.max(1, Math.floor(rows));
    const small = columns < 40 || rows < 12;
    const inset = columns >= 8 ? 2 : 0;
    const available = columns - inset * 2;
    const wide = splitEnabled && columns >= 140 && rows >= 20;
    const gap = wide ? 5 : 0;
    const width = wide ? Math.floor((available - gap) * 0.6) : available;
    const detailWidth = wide ? available - gap - width : 0;
    return {
        columns,
        rows,
        inset,
        available,
        wide,
        small,
        gap,
        width,
        detailWidth,
        bodyRows: Math.max(0, rows - 4),
        tight: rows < 20,
    };
}

/** The Brief's text width at most, in columns; the agent's prose wraps there too (T7). */
export const BRIEF_WIDTH = 82;

/** The field's rows with one row of text: its top edge, that row and its bottom edge. */
const FIELD_ROWS = 3;

/** The most rows of text the field's box shows: past them it scrolls inside (PRD F2, decision 17). */
export const FIELD_TEXT_ROWS = 6;

/**
 * How the rows under the tabs line split, from `terminalLayout`'s `bodyRows`: the gap above the body, the body's
 * own rows, the feedback line's extra rows under it, the side Brief's pane and body rows, and the rows of text the
 * field's box shows. The box grows a row for each row of its text, up to FIELD_TEXT_ROWS, and never takes its pane's
 * last body row, nor, over a full response, the body's last 3 rows, which the response's view and its footer need: the
 * body gives up the field's rows here, on the Brief page and in the side Brief alike (ui-reference §9). `codeRows` is
 * the most rows a code block in the agent's words takes: half the body rows with a one-line field, whatever the field
 * holds.
 */
export function bodyLayout(
    rows: number,
    page: {
        /** The rows of the open Brief page's title, which the side Brief's heading shares. */
        titleRows: number;
        /** A Brief page is open. */
        brief: boolean;
        /** Help shows. */
        help: boolean;
        /** The rows the field's text takes, on the Brief page or in the side Brief: 0 with no field. */
        field: number;
        /** The side Brief shows: the field and the feedback line stand in it, not under the body. */
        side: boolean;
        /** The feedback line's rows, 0 with no line. */
        shownRows: number;
        /** The pane's Brief, the page's or the side Brief's, shows a full response. */
        response: boolean;
    },
) {
    const { titleRows, brief, help, field, side, shownRows, response } = page;
    const topGap = brief || help ? 0 : 1;
    const pageField = field > 0 && !side;
    const sideField = field > 0 && side;
    const extraRows = side ? 0 : Math.max(0, shownRows - 1);
    const pageRows = (brief && !help ? titleRows : 0) + (pageField ? FIELD_ROWS : 0);
    const paneRows = rows + 2;
    const bodyRows = Math.max(0, rows - topGap - pageRows - extraRows);
    const sideRows = sideField ? FIELD_ROWS + Math.max(1, shownRows) : shownRows;
    const detailRows = Math.max(0, paneRows - titleRows - sideRows);
    const inputRows = Math.min(
        field,
        FIELD_TEXT_ROWS,
        Math.max(1, (side ? detailRows : bodyRows) - (response ? 2 : 0)),
    );
    return {
        topGap,
        extraRows,
        bodyRows: bodyRows - (pageField ? inputRows - 1 : 0),
        paneRows,
        detailRows: detailRows - (sideField ? inputRows - 1 : 0),
        codeRows: Math.max(1, Math.floor((rows - FIELD_ROWS) / 2)),
        inputRows,
    };
}

export function inputLayout(width: number, submitLabel: string): { submit: boolean; inputWidth: number } {
    const submit = width >= 40;
    return { submit, inputWidth: Math.max(1, width - 6 - (submit ? submitLabel.length + 1 : 0)) };
}

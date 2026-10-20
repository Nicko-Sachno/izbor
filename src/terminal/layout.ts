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

export function inputLayout(width: number, submitLabel: string): { submit: boolean; inputWidth: number } {
    const submit = width >= 40;
    return { submit, inputWidth: Math.max(1, width - 6 - (submit ? submitLabel.length + 1 : 0)) };
}

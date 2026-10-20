import { createElement } from "react";
import { renderToString } from "ink";
import type { TerminalSize, TerminalView, ViewportLayout } from "./model.js";
import { TerminalScreen } from "./screen.js";

export function renderTerminal(view: Readonly<TerminalView>, size: TerminalSize, color = false, now = new Date()) {
    let layout: ViewportLayout = { maxScroll: 0, pageSize: 0, scroll: 0 };
    const snapshot = { ...view };
    const output = renderToString(
        createElement(TerminalScreen, {
            view: snapshot,
            size,
            color,
            now,
            onLayout: (next) => {
                layout = next;
                snapshot.scroll = next.scroll;
                if (next.detail) snapshot.detailScroll = next.detail.scroll;
            },
        }),
        { columns: size.columns },
    );
    return { lines: output.split("\n"), maxScroll: layout.maxScroll, detail: layout.detail };
}

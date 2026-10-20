import { Box } from "ink";
import { Copy } from "./copy.js";
import { wrapSpaced } from "./presentation.js";

const HELP_LINES: readonly string[] = [
    "A click or Enter on a line acts at once: it opens a Brief, starts observing, or adds hooks or the plugin.",
    "Tab / Shift-Tab   next and previous line, then the side Brief, its field and Help",
    "Up / Down   move the focus; in an open Brief, scroll it",
    "Enter on a Brief   puts the cursor in its field",
    "Ctrl-O   switch Home and Sessions",
    "Esc   step back: field, Brief, Sessions, Home",
    "Page Up / Page Down   scroll the list or the Brief",
    "h   hide the side Brief",
    "m   show or hide Metadata: the full ID, the Task, the sources, the exact times",
    "s   stop observing the open Brief's session; it keeps running",
    "Ctrl-G   open or close Help",
    "Ctrl-C   quit Izbor",
    "izbor hooks --remove <folder> and izbor plugin --remove <folder> undo setup.",
];

export function Help({ color, width }: { color: boolean; width: number }) {
    return (
        <Box flexDirection="column" flexShrink={0}>
            <Copy color={color}>{HELP_LINES.map((line) => wrapSpaced(line, width)).join("\n")}</Copy>
        </Box>
    );
}

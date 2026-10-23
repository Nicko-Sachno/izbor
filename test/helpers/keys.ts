export const KEYS = {
    enter: "\r",
    /** As a terminal that reports keys sends it: CSI u, Enter with Shift. */
    "shift-enter": "\x1b[13;2u",
    esc: "\x1b",
    tab: "\t",
    "shift-tab": "\x1b[Z",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    delete: "\x1b[3~",
    pageup: "\x1b[5~",
    pagedown: "\x1b[6~",
    backspace: "\x7f",
    "ctrl-a": "\x01",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-e": "\x05",
    "ctrl-g": "\x07",
    "ctrl-j": "\n",
    "ctrl-o": "\x0f",
    "ctrl-u": "\x15",
} as const;

export function click(x: number, y: number): string {
    return `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`;
}

export function wheel(direction: "up" | "down", x: number, y: number): string {
    return `\x1b[<${direction === "up" ? 64 : 65};${x + 1};${y + 1}M`;
}

export function paste(text: string): string {
    return `\x1b[200~${text}\x1b[201~`;
}

/** A CI log of 42 lines, with tabs, 1,922 bytes: what the paste block's frames and pty test paste. */
export const CI_LOG = Array.from(
    { length: 42 },
    (_, n) => `retry ${n + 1} of 42\tGET /invoices/export\ttimed out`,
).join("\n");

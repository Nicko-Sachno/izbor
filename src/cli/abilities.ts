import type { ScreenFlags } from "../config.js";

/** What the terminal shows besides colour, and the keys it reports, as the terminal app's screen flags carry them. */
export type TerminalAbilities = Pick<Required<ScreenFlags>, "links" | "strike"> &
    Pick<ScreenFlags, "keys" | "shiftEnter">;

/**
 * Whether the terminal `env` describes opens OSC 8 links, shows strikethrough and reports keys (SPEC § Outside the
 * window, § Keys and mouse), read once when the terminal app starts. `hyperlinks` is supports-hyperlinks' answer for
 * stdout, and `color` the screen's colour flag.
 *
 * - Links: that answer, or kitty, Ghostty, WezTerm, Warp, Windows Terminal or tmux 3.4 or later. Inside tmux only
 *   tmux's version counts: the outer terminal's variables may be left over there, and an older tmux drops the link,
 *   and so its URL. Never Terminal.app, which prints the tail of an OSC sequence it does not know, never under `CI`,
 *   and never with colour off.
 * - Strikethrough: everywhere but Terminal.app, the Linux console (`TERM=linux`) and colour off.
 * - Keys: the kitty keyboard protocol, under which Shift-Enter is a key of its own, in kitty, Ghostty, WezTerm, foot
 *   and iTerm2 alone; WezTerm honours it only with `enable_kitty_keyboard = true` in its config. Never in
 *   Terminal.app, which prints the tail of a query it does not know, and never inside tmux, which hides the outer
 *   terminal while `KITTY_WINDOW_ID` may be left over there.
 * - Shift-Enter: named on the field's bottom edge where it comes with no setting: not in WezTerm or iTerm2 before 3.5.
 */
export function terminalAbilities(
    env: Record<string, string | undefined>,
    { color, hyperlinks }: { color: boolean; hyperlinks: boolean },
): TerminalAbilities {
    const terminalApp = env.TERM_PROGRAM === "Apple_Terminal";
    const shows = color && !terminalApp;
    const inTmux = env.TERM_PROGRAM === "tmux" || env.TMUX !== undefined;
    const opens = inTmux ? isTmux34(env) : hyperlinks || isListed(env);
    const keys = !terminalApp && !inTmux && reportsKeys(env);
    return {
        links: shows && env.CI === undefined && opens,
        strike: shows && env.TERM !== "linux",
        ...(keys && { keys: "kitty" as const }),
        ...(keys && reportsShiftEnter(env) && { shiftEnter: true as const }),
    };
}

/** kitty, Ghostty, WezTerm, Warp and Windows Terminal, known by their own variables or their TERM, open OSC 8 links. */
function isListed(env: Record<string, string | undefined>): boolean {
    return (
        ["xterm-kitty", "xterm-ghostty"].includes(env.TERM ?? "") ||
        ["ghostty", "WezTerm", "WarpTerminal"].includes(env.TERM_PROGRAM ?? "") ||
        [env.KITTY_WINDOW_ID, env.GHOSTTY_RESOURCES_DIR, env.WEZTERM_EXECUTABLE, env.WT_SESSION].some(
            (value) => value !== undefined,
        )
    );
}

/** kitty, Ghostty, WezTerm, foot and iTerm2, known by their TERM, their TERM_PROGRAM or kitty's own variable, report
 *  keys under the kitty keyboard protocol. */
function reportsKeys(env: Record<string, string | undefined>): boolean {
    return (
        ["xterm-kitty", "xterm-ghostty", "foot", "foot-extra"].includes(env.TERM ?? "") ||
        ["ghostty", "WezTerm", "iTerm.app"].includes(env.TERM_PROGRAM ?? "") ||
        env.KITTY_WINDOW_ID !== undefined
    );
}

/** Of those, the ones that report Shift-Enter with no setting of the user's: not WezTerm, which needs
 *  `enable_kitty_keyboard`, nor iTerm2 before 3.5, its first release with the kitty keyboard protocol. */
function reportsShiftEnter({ TERM_PROGRAM, TERM_PROGRAM_VERSION = "" }: Record<string, string | undefined>): boolean {
    if (TERM_PROGRAM !== "iTerm.app") return TERM_PROGRAM !== "WezTerm";
    const [, major = "0", minor = "0"] = /(\d+)\.(\d+)/.exec(TERM_PROGRAM_VERSION) ?? [];
    return Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 5);
}

/** tmux 3.4 or later, from the version it sets, such as `3.4`, `3.3a` or `next-3.6`. */
function isTmux34({ TERM_PROGRAM, TERM_PROGRAM_VERSION = "" }: Record<string, string | undefined>): boolean {
    const [, major = "0", minor = "0"] = /(\d+)\.(\d+)/.exec(TERM_PROGRAM_VERSION) ?? [];
    return TERM_PROGRAM === "tmux" && (Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 4));
}

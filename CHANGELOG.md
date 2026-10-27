# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Brief events carry `response`: the agent's full response to the Task, with up to 20,000 characters of its text, or its newest text whole when that alone is longer: past that, the earliest text goes first and `cut` counts it. It stays on this machine and never goes to the summarizer that writes the explanations.
- The terminal app's Brief page shows the agent's full response under Stop observing, in place of the `Latest:` row: the latest message while the agent works, the last one once the turn is over, then the turn's earlier text down to `Reply finished`. While Izbor cannot read the transcript and has no message yet, `Latest:` stays.
- The Brief beside Sessions, in windows of 140 × 20 or more, shows the full response the same way, at its pane's width and without its `Latest:` row.
- The full response shows the agent's tool calls and subagents, one row each with a one-row result such as `Read 118 lines` or `Added 3 lines, removed 1 line`, its dot coloured by the call's state (`✓ * ! ×` with colour off); the call that waits for you shows its whole command, a command or subagent sent to the background reads `Running in the background`, and `Earlier in this turn` counts the tool calls under it. Paths inside the session's folder are relative to it, from the first look at a session, through the folder Claude Code's session list names.
- While the full response runs on below the view, its last body row says how many rows remain and what they are, such as `↓ 10 more rows of it, then the work: 14 tool calls, 3 files +42 −7 · PgDn`, and Page Down and Page Up there keep one row of the old page in view.
- In the full response, a run of reads and searches folds into one row, such as `Searched for 2 patterns, read 4 files`; while the agent has written no text yet, a divider says which of the response's rows under it are in view, such as `rows 1-7 of 7 · no text yet`, and a Task the agent has not started on says so in two lines.
- Once a reply in the full response ends, a line says how, such as `Reply ended: rejected by the user: Bash: rm -rf build/` or `Reply failed: <the error>`, and a line says so when Izbor cannot show everything: a transcript it cannot read, text past the 20,000-character limit, or a project without hooks, where it cannot tell a finished reply from a failed one. A background task that finished shows as a row in the turn, and the last message after it is labelled `Agent's last message · after the background task`.
- Scrolled into the full response, the row you read stays where it is while the response grows above it, the Brief above it changes height or the window resizes; at the top of the page, new text keeps showing.
- The agent's words in the full response are drawn from their markdown: headings in bold, bold and italic text, inline code in a colour of its own, quotes muted and italic, `---` as a rule, and raw HTML as text. With colour off, the `#`, the backticks, the `> ` and the `---` come back.
- Lists in the agent's words hang their wrapped rows under the text, with numbers right-aligned and `[ ]` or `[x]` for tasks, and code blocks stand 2 columns in, in the code colour, with no fence lines and at the pane's full width; a long one shows its first lines and then how many more it has, such as `… 38 more lines`. With colour off, the fence lines come back.
- Tables in the agent's words draw as a grid with no borders, a bold header and one rule row under it, wider than the prose where the pane has room; in a pane too narrow for it, or where a cell would wrap over more than 4 rows, as `Header: value` records split by rules.
- Links in the agent's words show their label underlined in the link tone (the notice's dusty blue); where the terminal does not open links, the address follows in muted brackets, such as `the marked docs (https://marked.js.org)`; a bare address shows once, and with colour off the label keeps its underline.
- In terminals that open links, such as kitty, Ghostty, iTerm2, WezTerm, Warp, Windows Terminal and tmux 3.4 or later, the agent's links open from their label, and its `~~struck~~` text is struck through wherever the terminal shows strikethrough. Terminal.app and `CI` keep `label (url)` and get no link escape at all; Terminal.app and the Linux console keep the literal `~~struck~~`.
- Code blocks fenced with a language Izbor knows, such as `ts`, `js`, `json`, `bash`, `python`, `diff`, `yaml`, `go`, `rust` or `css`, draw in syntax colours as Claude Code draws them, in the terminal's own named colours: keywords blue, strings red, numbers green, functions yellow and comments muted, with no language row over them. With colour off, their fence lines come back instead.

### Changed

- The Brief's field grows upward a row for each row its text takes, up to 6, then scrolls inside with the cursor's row in view; a long line wraps instead of scrolling sideways, and a click puts the cursor on the row clicked.
- Ctrl-J starts a new line in the Brief's field and a paste keeps its new lines and tabs, so a prompt of several lines reaches the agent whole; the field holds 64 KB instead of 2,048 characters, and its own line says when typing or a paste passed that.
- Shift-Enter starts a new line in the Brief's field too, in kitty, Ghostty, foot and iTerm2, and in WezTerm with `enable_kitty_keyboard = true` in its config: the terminal app asks these terminals to report it with the kitty keyboard protocol, and sets that back on quit; Terminal.app, tmux and other terminals get no new escape code, and there Shift-Enter sends; Enter and Option-Enter send everywhere.
- In the Answer field, a `no` with your words may run over several lines and reaches the agent whole; what Izbor says after the send reads as one sentence and says "the agent", not Claude, and `izbor serve` logs it on one line, with `\n` where its lines break.
- The Brief's field title counts its lines, such as `Reply to this session · 9 lines · 3 above`, its bottom edge reads `Ctrl-J new line · Enter sends` from the first new line or while it has the cursor, and Up and Down move between its rows.
- A paste of more than 5 lines or 800 characters shows in the Brief's field as one block, such as `[Pasted 42 lines · 1.9 KB]`, on a dark sage fill in the palette, in brackets on a 16-colour terminal or with colour off; Backspace removes it whole, and Enter sends its full text, tabs as pasted.
- With `--no-color` or `CI` set, the terminal app keeps bold, italic, underline and reverse video, as it already did with `NO_COLOR`; only `TERM=dumb` draws plain text.
- Your Task in a Brief's heading, on the Brief page and in the side Brief, stands on a dark grey fill, as Claude Code draws your prompt, so it reads apart from the agent's words; on a 16-colour terminal the fill is bright black, and with colour off there is none.
- Home no longer shows the name Claude Code makes from a session's folder, such as `izbor-6a`. Instead it shows Claude's title for the session, such as `Meaningful session names on Home screen`, else its first prompt, else `New session · started 20:47`. A name you gave with `/rename` stays.

## [0.1.0] - 2026-10-19

First public release, a preview installed from source.

### Added

- A terminal app that lists the running Claude Code sessions and the projects they run in.
- Briefs for the sessions you choose to observe: the task, the status, the latest activity, and whether the session needs you. Short explanations in a brief are written by Claude Haiku.
- Answering a session's requests and sending it prompts from Izbor, for projects where acting is turned on.
- `izbor hooks [folder]` and `izbor plugin [folder]`, with `--remove`, to connect a project and turn acting on or off. Home also offers both for projects with a running session.
- A background service on `127.0.0.1` (default port 4319), with `izbor serve`, `izbor stop` and `izbor status`.
- macOS support.

### Known limitations

- Windows 11 support is experimental and has not yet been tested by a person.
- Linux is not supported.
- Izbor is installed from source only. It is not published to npm.
- The explanations in a brief use Claude Haiku through your logged-in `claude`, and they count against your Claude subscription usage.
- Izbor finds running sessions with `claude agents --json`, so it depends on that Claude Code command and its output.

[Unreleased]: https://github.com/Nicko-Sachno/izbor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Nicko-Sachno/izbor/releases/tag/v0.1.0

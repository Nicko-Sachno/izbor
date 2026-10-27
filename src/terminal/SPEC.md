# Izbor terminal app: full behaviour

This is the complete, exact behaviour of the terminal app, written for contributors and tests. The short guide for people is [README.md](README.md).

`izbor` opens the live terminal app: the running Claude Code sessions, and the brief of each one you observe, through Izbor. This spec covers the screens, the controls, the sample cases and the layout.

The tests drive the app with the sample sessions in `test/helpers/sampleSessions.ts`. The frames in `test/frames` and the replays in `test/replays` pin each case.

## Running it

```sh
izbor                # Home: every running session; starts Izbor in the background if none runs
izbor --no-bell      # the same, with no terminal bell
izbor --no-mouse     # the same, leaving the mouse to the terminal emulator
izbor --version      # prints izbor built <date> <time>: when npm run build last built this checkout
```

- `npm run terminal -- <flags>` runs the same from the source.
- No version stands on any screen.
- For `--no-color` and `NO_COLOR`, see [Turning colour off](#colours).
- For what `--no-mouse` leaves to the terminal, see [Mouse](#mouse).
- For `izbor hooks --remove` and `izbor plugin --remove`, see [Project cues](#project-cues-hooks-and-plugin).

## Screens

The app has three screens: **Home**, **Sessions** and the **Brief**. `izbor` opens on Home.

- The tabs stand on the second line. The screen shown is its bare name and the other is bracketed, as in `Home  [ Sessions · N ]`.
- A click on a tab switches screens, and so does Ctrl-O.
- Esc steps back: field, Brief, Sessions, Home.
- An observe shows Sessions. Leaving your last row shows Home.
- Each screen keeps its scroll.
- On Home and Sessions, one empty row stands between the tabs and the first line.
- Updates preserve ordering, focus, expansion, and text being typed.
- If the window is too small, the session area scrolls while the last line stays.

### Home

Home lists every running Claude Code session, grouped by project. The live app lists the running sessions every 5 s while Izbor is up, rows or not. Home uses a single pane.

- Before the first list, Home reads `Looking for running Claude Code sessions…`.
- When a reading fails, `▲ No list: <why>` stands over the last list.
- A session line starts with the session's name. That is the name Claude Code lists, unless Claude Code derived it from the folder, such as `izbor-6a`. Then Home shows Claude's title for the session, else its first prompt, else `New session · started 20:47`. A first prompt that is a slash command, such as `/clear`, does not count. If Izbor cannot read the title, the derived name stays.
- A session line you observe in this window ends with `Open ›`, muted until its line has focus. Enter or a click on it opens its Brief.
- A focused line you do not observe ends with `Observe ›`. Enter or a click on it observes the session and opens its Brief.
- A session in a worktree adds `· worktree <name>`.
- No sign marks the focused line: its name is sage and bold.
- A waiting session is marked as in [Waiting sessions and the blink](#waiting-sessions-and-the-blink).
- Project lines carry the cues in [Project cues](#project-cues-hooks-and-plugin).

### Sessions

Sessions shows the sessions you observe, one row each. With no row it reads `No session observed. Ctrl-O opens Home.` A row whose session ended stays a row.

Each row starts with three cells: the gutter cell (empty), its Status glyph in the mark cell, and one blank cell.

| Glyph | Meaning                                                 |
| ----- | ------------------------------------------------------- |
| `!`   | waiting                                                 |
| `*`   | Working                                                 |
| `✓`   | Idle                                                    |
| `?`   | Unknown or Not listed                                   |
| `▲`   | while its stream is not live, or before its first Brief |

After the three cells, a row shows:

- its Task: at most three lines, the third ending … when cut;
- its Status word, with any notice;
- its explanation: at most three lines, the third ending … when cut;
- on a waiting row, the badge with its request, the request cut to one line.

A row's text uses the Sessions pane's whole width less the three cells before it. Reading text remains bounded independently of the action position, and the entire session block is clickable.

**The marked row.** Beside an open Brief, the marked row is that Brief's session; else the focused row; else the selected one.

- No sign marks the focused line: the marked row's Task is sage and bold, not underlined.
- The underlined `Open ›` cue stands at the right edge of the marked row.
- The cue is absent while that row's Brief is open beside the list.

**Selection.**

- The first observed session is selected initially.
- Selection and session order survive resizing and source updates.
- Removing the selected observation selects its next neighbour, or the previous row if it was last.

### Brief

A Brief is its own page in a smaller window. At **140 columns × 20 rows or larger** the selected session's Brief sits on the right, beside Sessions: 60% of the usable pane space for Sessions, 40% for the Brief. Smaller usable windows open a Brief in the main view.

- Shrinking a split view returns to Sessions.
- Widening restores the same selected Brief, unless you explicitly hid it.
- A hidden Brief stays hidden across resizing.

**Heading.** A Brief heads with its Task, wrapped the same way as on a row, and its Status after the Task's last word: `* Working`, `✓ Idle`, or the muted word. On the Brief page the heading stands on its own rows under `Back · Esc`, at most ten and at most half the body, and is cut with `…` only past that; the side Brief keeps one to three rows. With colour on, your Task stands on a dark grey fill, as Claude Code draws your prompt, so it reads apart from the agent's words: each row is filled from one column before its first character to one column past the heading's width, the words in their usual column, and a wrapped Task makes one solid block; `Task unknown` has no fill.

**Body.** Under the heading, in order:

- Now, once there is an explanation or Izbor's reason for none. The Brief shows the explanation whole.
- `Latest:`, while Working only, and never while the full response shows, unless it shows only the No transcript line (below), which says nothing of what the agent does.
- Any request.
- One relative update time.
- Stop observing. This is the Brief's control line.
- After one blank row, the full response (below).

A Brief's text wraps without silently truncating explanations or requests.

**Full response.** On the Brief page and in the side Brief alike, a brief that carries the agent's reply to the Task shows it under Stop observing, in the same scrolling page:

- The label, in muted. While the agent writes or waits (never for an idle session in a project without hooks, below): `Agent's latest message so far · 40s ago`, else `Latest message so far · …` or `Latest · …`, the first that fits. Once the turn is over: `Agent's last message · 2m ago`, else `Last message · …` or `Last · …`; when a background task finished before the last message, `Agent's last message · after the background task · 3m ago`, else `Agent's last message · after a task · …` or `Last · after a task · …`. Its age is that of the agent's newest text.
- The agent's newest text, word for word, its markdown drawn (below): escape and control sequences removed, tabs as 4 spaces. The tool calls made after it follow it.
- One blank row, `Earlier in this turn · 14 tool calls`, and the turn from its start, its text and tool calls in order. The count is of the tool calls under the label; `Earlier · …` or `Earlier` where that does not fit, and no count when there is none. Both stay out when nothing stands before the newest text.
- When the turn's text passed 20,000 characters, its earliest text is left out, and `… 4 210 earlier characters: read them in the session` stands first under `Earlier in this turn`, in muted, its thousands spaced, with one blank row under it when a text follows; the label shows for it even when nothing else stands before the newest text.
- One blank row stands between a text and what stands next to it; tool calls in a run stand row on row.
- A background task that finished stands in the turn as one muted row, `─ background task finished 14:32 ─`, at the local time its notice came.
- One blank row, then the end line, once the reply ended (below).
- No glyph, bar or box stands beside the agent's words: only the 2-column margin, so a copy picks up only the words.

**The agent's words.** Each text is parsed as markdown once and laid out at the text width; a window of another width, height or colour mode lays it out again:

- One blank row stands between blocks, however many blank lines the agent left, and a single newline stays a row break.
- A heading is bold, with no `#`, the first level underlined too, and the blank row after it.
- `**bold**` and `*italic*` are bold and italic, with no markers.
- Inline code is in the code tone, with no backticks and no background.
- A quote is muted and italic, 2 columns in, with no bar.
- `---` is a row of `─` across the text width, in the border tone.
- Raw HTML is printed as text, never interpreted; `&nbsp;` is a space, and every other entity stays as the agent wrote it.
- A list item starts with `- ` at every depth, or with its number as the agent wrote it, right-aligned in a column as wide as the list's widest number; a task item has `[ ] ` or `[x] ` after that. Its wrapped rows hang under its text, not under its marker, and a list inside it starts under that text too, 2 columns a level under `- `, until its items would keep under 10 columns of text: from there it starts under its parent's marker.
- A code block stands 2 columns in, with no fence lines, box or background. Izbor has syntax colours for the languages a fence names by these words, in any case: TypeScript (`typescript`, `ts`, `tsx`, `mts`, `cts`), JavaScript (`javascript`, `js`, `jsx`, `mjs`, `cjs`), JSON (`json`, `jsonc`), Bash (`bash`, `sh`, `zsh`; not `shell`), Python (`python`, `py`, `gyp`, `ipython`), diff (`diff`, `patch`), YAML (`yaml`, `yml`), Go (`go`, `golang`), Rust (`rust`, `rs`) and CSS (`css`). A block whose fence names one has its code in [syntax colours](#colours), with no row over it, so an empty one draws nothing. Any other block is in the code tone, under a muted row with the language its fence names, when it names one. Its lines wrap at the pane's width, not at the prose's 82 columns, and keep their leading spaces.
- A code block taller than half the body (with a one-line field: 8 rows at 80×24) shows its first whole lines, then a muted `… 38 more lines` as its last row, counting the lines left out. When only one line would be left out, that line shows instead.
- A table stands as a grid with no borders: its header bold, one rule row of `─` under each column in the border tone, the columns 2 apart, each cell padded on the side its column's alignment asks for; inline code in a cell, such as a path, is in the code tone. It may take the pane's width but 4 columns, not only the prose's 82: when its cells do not fit whole, each column keeps its longest word, the columns share the rest, and the cells wrap inside them.
- A table stands as records instead when its columns, each as wide as its longest word, would be wider than the pane's width minus 4, or when a cell would wrap over more than 4 rows: each row a record of `Header: value` rows, the header bold, an empty cell left out, wrapped at the text width, and a rule in the border tone between two records, as long as the text width but at most 40 columns.
- A link's label is in the link tone, underlined. In a terminal that opens OSC 8 links, the label is such a link to its URL, on every row it wraps over; elsewhere `(url)` follows it, muted. A bare URL, or a label that is its URL, shows once; so do `www.example.com` and `me@example.com`, whose URLs only add `http://` and `mailto:`. Which terminals open links: see [OSC 8 links](#outside-the-window).
- `~~struck~~` text is struck through in a terminal that shows strikethrough, and keeps its `~~` elsewhere: in Terminal.app, in the Linux console (`TERM=linux`) and with colour off. A single `~`, as in `about ~5 min`, stays as written.
- The words wrap hard at the text width. A line's leading spaces stay, and its wrapped rows hang under them unless they take half the width or more. A space before a number such as `1.` keeps that number with the word before it, so no wrapped row starts with what looks like a list marker.

**End line.** Every reply that ended ends with a line that says how, wrapped at the text width; while the agent writes or waits, the full response ends with its last item, the waiting call's rows among them, and no line of its own:

- `Reply finished · 2m ago` in green (`Finished · …` where that does not fit). Its age is that of the end.
- `Reply interrupted by the user: the agent's unfinished words are not saved`, in muted, under the rose `⎿  Interrupted by the user` of a call the user stopped.
- `Reply ended: rejected by the user: Bash: rm -rf build/`, in muted, naming the call, under its rose `⎿  Rejected by the user`.
- `Reply failed: API Error: 529 overloaded`, in muted, with the agent provider's error as it gave it, under what came before.
- For an idle session in a project without Izbor's hooks, `Idle: without hooks Izbor cannot tell a finished reply from a failed one`, in muted, in the place of any of these, whatever the transcript says, even before Izbor has read the reply's end from it. While such a session works, the full response ends as in any project.

**No transcript.** When Izbor cannot read the session's transcript, `Only the agent's last message: Izbor cannot read this session's transcript, so its tool calls are not shown` stands first, in muted. Once the reply finished, one blank row, the label and the agent's last message follow it, then the end line; while the agent works, that line stands alone, with no divider and no Nothing yet lines, and `Latest:` stays above it, the Brief's one live line. A reply that failed has no last message: its error shows in `Reply failed`.

**No text yet.** While the agent has written no text in the turn, a divider row takes the label's place, and the turn from its start follows it:

- A `─` rule in the border tone across the text width, with its words in muted near the end, before a last `──`: `rows 1-7 of 7 · no text yet`, else `1-7 of 7 · no text yet` or `no text yet`, the first that leaves at least `── ` before them.
- The count is exact: the full response's rows under the divider in view, above the footer, out of all of them, from the rows as laid out, the end line and the blank row over it among them. With none of them in view, it reads `rows 0 of 7 · no text yet`.
- `· no text yet` shows only while the agent writes or waits, and never for an idle session in a project without hooks. A reply that ended with no text shows the count alone, `rows 1-9 of 9` or `1-9 of 9`, so it never reads as if more text were coming.

**Nothing yet.** A Task the agent has not started on shows two lines in the notice tone where the full response stands, one blank row under Stop observing: `Nothing to show yet: the agent has not started on this Task.` and `Responses to earlier Tasks: read them in the session.`

**Footer.** While rows of the page remain below the view, the last body row is the footer, in muted. Its count is exact, taken from the rows as laid out, and its form names what the rows are, the first that fits:

- While the agent writes or waits and its latest message and the calls after it stand whole in view: `↓ 196 rows before it · PgDn`, else `↓ 196 rows · PgDn` or `↓ 196`. Never for an idle session in a project without hooks, which reads as a turn that is over.
- While part of that message, or of the last message once the turn is over, is below: `↓ 10 more rows of it, then the work: 14 tool calls, 3 files +42 −7 · PgDn`, else `↓ 10 more rows of it, then 14 tool calls · PgDn` or `↓ 10 more · PgDn`; with no tool call under `Earlier in this turn`, `↓ 10 more rows of it · PgDn`, else `↓ 10 more · PgDn`. The work is that of `Earlier in this turn`; a new file counts every line it wrote. The files and their lines show only when every file the turn changed has counts, so a call that ended before the watch leaves the tool calls alone.
- Otherwise, from inside the turn or with the view above the full response: `↓ 120 more rows · PgDn`, else `↓ 120 · PgDn` or `↓ 120`.

At the page's end no footer shows: a footer never hides a single row, which shows instead. A Brief without a full response has no footer.

**Tool rows.** Each tool call is one row, `● Name(argument)`, and one result row under it, `  ⎿  result`:

- The name is the one Claude Code's own rows give the call, in bold: `Read`, `Write`, `Create` for an edit that makes a file, `Update`, `Search`, `Bash`, `Task` for a subagent, `server · tool` for an MCP tool. A path inside the session's folder is relative to it: the folder a main-thread hook named, else the one Claude Code's session list names, so a session watched after its turn ended shows relative paths too.
- A call row too long for the width is clipped with `…`, and a path keeps its end (`Read(…/invoices/csv.ts)`). Only the call that waits for you wraps, so its whole command shows.
- The result row is one row, clipped with `…`, in the words Claude Code's own rows use, with each count bold in the text tone: `Read 118 lines`, `Wrote 64 lines to src/invoices/csv.ts`, `Added 3 lines, removed 1 line`, `Found 4 files`, a command's first output line or `Failed with exit code 1 · <first error line>`, an MCP tool's first output line. Where a row is too narrow, the path drops out before the counts: `Wrote 64 lines`.
- A subagent reads `Done (12 tool uses · 1m 2s)` once it finished. A subagent started in the background, and a command sent there (at its start, with Ctrl-B, or at its timeout), return at once and read `Running in the background`, as Claude Code's own row for such a command does, never the words their result has for the model.
- The dot and the result row carry the call's state: a muted dot and `Running…`; a green dot once done; an amber dot and `Waiting for your answer · <its description>` in amber while it waits for you (`Waiting for your answer` when it has none); a rose dot and `Failed …`, `Rejected by the user` or `Interrupted by the user` in rose. With colour off, `✓ * ! ×` stand in the dot's cell for done, running, waiting and the other three, and the waiting call's rows are bold.
- Two or more Read, Grep, Glob and LS calls in a row fold into one row with no result row, as Claude Code draws them: `● Searched for 2 patterns, read 4 files, listed 1 directory`, each count bold; the reads count the files they read. While one of them runs, the dot is muted and the row reads in the present tense, ending in `…`: `Reading 3 files…`. A call that waits for you, failed, or was rejected or interrupted never folds, and a lone one keeps its own row and result row.

A brief without a full response (from an Izbor older than the build, or while the Task is unknown), or whose response draws no row yet (while the agent writes or waits with no item yet), draws as before, with `Latest:`; so does one whose response shows only the No transcript line.

**Metadata.** Press m while the Brief is focused; no control is drawn for Metadata.

- It shows under the control line, above the full response: the full ID (UUID), the Task whole when the heading cut it, sources (provenance) and exact timestamps.
- m scrolls the Brief so the block's last line is in view, the full response under it: one row above the footer, unless it shows without scrolling. On a Brief without a full response, m scrolls to the page's end.
- m again removes it and gives the Brief the scroll it had.
- Stale, disconnected or unknown evidence remains explicitly marked, with Metadata shown or not.

**Scroll.** Brief and Sessions scroll independently. A session opened for the first time starts at the top. Opening another session resets Metadata and its scroll; returning to the same session preserves them.

**Open, hide, back and stop.**

- Click or Enter opens a session.
- Hide or h closes the pane: it hides the Brief that shows, from the list too. Enter or a click on its row brings the Brief back.
- Escape focuses Sessions in a split layout, or returns from a single-pane Brief.
- s in a focused Brief, or a click on Stop observing, stops observing that session. It keeps running, and the news line says how to bring it back.

**No hooks.** A Brief of a project without Izbor's hooks has no field. `Briefs update late: add hooks for live updates` stands under its heading in dusty blue, and its messages stand on the row above the last line.

## Top line

The application header uses one row.

**Right end: the Izbor state.**

- `Izbor ● up`, in muted, while Izbor is fine.
- Otherwise a ▲ trouble text in dusty blue:
    - `▲ Izbor ○ stopping`
    - `▲ Izbor ○ not running on port <port> · run izbor`
    - `▲ Izbor ○ not answering`
    - `▲ Izbor ○ port <port> held by another program`

**Left end: an old build.** `bin/izbor.js` sets `IZBOR_OLD_BUILD=1` when it finds `dist/` older than `src/`. While this window runs such a build, the left end reads `▲ old build · run npm run build`. When the Izbor state needs the room, it is cut to `▲ old build`, or left out.

## Waiting sessions and the blink

A session that waits for you has `!` in front. A filled `! Needs you` badge, with Claude Code's name for the wait, takes the place of its Status word.

- The `!` blinks for 5 s after the wait began: one second drawn, one not. Then it stays still.
- A wait is timed from the first list that showed it. For an observed session, it is timed from its Brief's request time.
- A wait already in the window's first list never blinks.

## Project cues (hooks and plugin)

Each project line on Home ends with a cue for what the project lacks:

| The project has       | Its line ends with                 | Enter on the line, or a click on its cue |
| --------------------- | ---------------------------------- | ---------------------------------------- |
| no Izbor hooks        | `Add hooks ›`                      | adds the hooks                           |
| the hooks, no plugin  | `Add plugin · answer from Izbor ›` | adds the plugin                          |
| both hooks and plugin | nothing                            | —                                        |

- The cue is underlined and sits at the pane's right edge, the same way as `Open ›`.
- The cue is the click target: a project line takes a click on its cue only.
- `izbor hooks --remove` and `izbor plugin --remove` undo them.
- In the sample sessions, `izbor` has both, `example-api` has no hooks, and `invoice-api` has the hooks and no plugin. Their writers change the sample list in memory, so the cue goes once Enter adds what it named.

## Messages row

The row above the last line holds the last act's refusal or its news; else it is empty.

- A refusal is rose and bold, behind a `×`.
- News is muted. For example:
    - `Observing <name>.`
    - `Izbor is back`
    - the answer of adding hooks or the plugin, such as `Adding Izbor's plugin…`
    - after a stop, `Stopped observing “<Task>”. The session keeps running. Observe › on Home brings it back.` It names the session by its short ID before a Task is known, and wraps to a second row above when it does not fit.

One message shows at a time. On a Brief with a field, the field's own line, above the box, shows that session's field sentence when there is one, else the last act's. A message stays until the next act or the next key typed in a field.

## Keys and mouse

| Input                  | Effect                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tab / Shift-Tab        | Move focus through the screen's lines, the right Brief and its field, and Help.                                                          |
| Enter on a row         | Open its Brief; a row with no stream (stopped, disconnected, refused, or Izbor away) is observed again first.                            |
| Enter on an open Brief | Put the cursor in the Brief's field. See [The field](#the-field).                                                                        |
| Enter in the field     | Send the text to the Brief's session: `yes`, `no`, or `no` and your words answer the request.                                            |
| Ctrl-J in the field    | Start a new line, in every terminal; Option-Enter does too, and Shift-Enter where the terminal reports it (below). Enter sends.          |
| Up / Down in the field | Go to the row above or below, at the same column or that row's end; on the first or the last row the cursor stays.                       |
| Enter on a Home line   | Observe a session and open its Brief, or open an observed one's; a project line adds its hooks, or the plugin once it has them.          |
| Click a Home line      | Do what Enter on it does. For project lines, see [Project cues](#project-cues-hooks-and-plugin).                                         |
| Ctrl-O / click a tab   | Switch Home and Sessions, each at its own scroll.                                                                                        |
| m                      | Show or hide Metadata under the Brief's control line: the full ID, the Task whole when the heading cut it, sources and exact timestamps. |
| h / click Hide         | Hide the Brief that shows, from the list too; Enter or a click on its row brings the Brief back.                                         |
| Esc                    | Step back one level, in the order given in [Screens](#screens). From the field, see [The field](#the-field).                             |
| Up / Down              | Move focus across the screen's lines, or scroll an expanded Brief.                                                                       |
| Page Up / Page Down    | Scroll the focused pane a page; on a Brief with a full response, the last row above the footer stands first on the next page.            |
| Click the side Brief   | Give it the focus, so m and s act on it.                                                                                                 |
| Click Back · Esc       | Return from an open Brief.                                                                                                               |
| Click Send             | Send the field's text, as Enter in the field does.                                                                                       |
| Ctrl-G / click Help    | Open Help; Ctrl-G, Esc or a click on Close · Ctrl-G returns to the same view, focus, and scroll position.                                |
| s in a focused Brief   | Stop observing that session; it keeps running, and the news line says how to bring it back.                                              |
| Click Stop observing   | Close the open Brief's local observation.                                                                                                |
| Wheel / trackpad       | Scroll only the pane beneath the pointer, its footer's row included, preserving input focus.                                             |
| Ctrl-C / Ctrl-D        | Exit and restore the normal terminal screen and input mode.                                                                              |

**Shift-Enter.** Where the terminal reports Shift-Enter as a key of its own, it starts a new line in the field. Izbor asks for that, the first level of the kitty keyboard protocol, only in kitty, Ghostty, WezTerm, foot and iTerm2, read once when the app starts (WezTerm honours it only with `enable_kitty_keyboard = true` in its config, which is off by default, so there Shift-Enter otherwise sends), and turns it off again when the app quits, by Ctrl-C, a signal or a crash. Terminal.app, a terminal not on that list and any terminal inside tmux get no new escape code, and there Shift-Enter sends, as Enter does, unless that terminal already sends it the kitty way of its own accord. Option-Enter starts a new line wherever the terminal sends it as Esc and Enter, or as Enter with Alt under the kitty keyboard protocol, as Claude Code takes it: Terminal.app does with Use Option as Meta Key ticked in its profile's Keyboard settings, iTerm2 with its Option key set to Esc+. So does Shift-Enter where a terminal setup, such as Claude Code's `/terminal-setup` in VS Code, has it send what Option-Enter sends. Where a terminal sends Option-Enter as a bare Enter, it sends.

**What you read stays put.** On a Brief with a full response, in the page and in the side Brief, the row at the top of the view stays where it is while items above it change or grow, while the Brief above the response changes height, and across a resize, which lays its item out again at the new width, a resize that moves the Brief from the page into the side Brief among them: the view keeps the same row of that item, or its last row when it has fewer now. When a new text item pushes the item you read into `Earlier in this turn`, the view follows it; the label over the newest text counts as a row of that text, so the view follows the text it labelled. At the top of the page the view stays at the top, so the live edge keeps updating. When the item you read is gone, as after a new Task or a cut, the view goes to the top. The view never passes the page's end: when what you read ends up there, the view stops at the end and the row stands lower on the screen. Only the keys above and the wheel move the view: there is no jump key and no cue for new text.

Help uses a single pane and restores the previous view when closed.

### Mouse

- Mouse controls use standard SGR reporting on compatible terminals.
- Keyboard navigation remains available.
- `izbor --no-mouse` leaves mouse gestures and text selection entirely to the terminal emulator.
- Copy the agent's words by ordinary selection: hold Shift while dragging (Option in iTerm2), or start `izbor --no-mouse`. Izbor has no copy key.
- Mouse tracking is disabled again when Izbor exits.
- A click on a Home session you do not observe observes it and opens its Brief. A click on one marked `Open ›` opens its Brief.

## The Brief's field and answers

### The field

Each Brief has an input field of its own, under its own line. In a split window it sits at the bottom of the side Brief; on a Brief page it sits right above the last line.

- The field starts empty and is one row. Its box grows upward a row for each row its text takes, up to 6, and the body above gives up the same rows. A long line wraps at its spaces, and a word longer than a row breaks at the row's end; a space that ends a full row stays on it, so the next row starts at a word. A tab draws as 4 spaces. `›` stands on the box's first row and `Send →` on its last.
- Past 6 rows the box scrolls inside, only as far as keeps the cursor's row in view: a click or a cursor move inside the rows it shows scrolls nothing, and typing at the text's end shows its last rows. It never takes the body's last row, so in a short window it stops growing sooner.
- The title counts the lines from 2 up, split at the new lines, so a wrapped line is one, and a paste block adds none: `Reply to this session · 3 lines`. While rows of the text are scrolled out above the box, it counts them too: `· 9 lines · 3 above`.
- From the text's first new line outside a paste block, or while the field has the cursor, the box's bottom edge teaches its keys, muted: `└─ Ctrl-J new line · Enter sends ─┘`, or `└─ Shift-Enter new line · Enter sends ─┘` in kitty, Ghostty, foot and iTerm2, which report Shift-Enter with no setting of the user's (WezTerm needs one, so it keeps Ctrl-J). While the field has the cursor right after a paste block, it reads `Backspace removes the paste · Enter sends` instead.
- Where the title or the bottom edge's words do not fit, their trailing `· …` parts drop, last first, until they fit, and what is left may meet the corner: at 40 columns `· 9 lines · 3 above` keeps `· 9 lines`.
- A click on the field puts the cursor on the row and column clicked. Up and Down go to the row above or below, at the same column or that row's end, and scroll the box to keep it in view; on the first or the last row the cursor stays. Page Up and Page Down still scroll the body.
- Ctrl-J, Option-Enter, or Shift-Enter where the terminal reports it, starts a new line, and a paste keeps its new lines: CR LF and a lone CR become one new line, tabs stay, and escape and control sequences go. Enter sends the text as it stands, its lines and tabs included.
- A paste of more than 5 lines or 800 characters stands as one block where it was pasted, `[Pasted 42 lines · 1.9 KB]`: its lines, a new line at its end ending the last, and its size, 1 KB being 1,024 bytes, with one decimal and never under `0.1 KB`. In the palette (truecolor or 256 colours) it is the label alone, sage on the paste fill, the brackets' cells filled spaces, so it is as wide in every look; on a 16-colour terminal and with colour off it stands in brackets. The block adds no new line of its own: it wraps as one word, never split across rows, so the title, the box's 6 rows, its scrolling and Up and Down take it as one word of the line it stands in. Left and Right step over it, the cursor never stands inside it, and Backspace or Delete next to it removes it whole. Enter sends its text where it stands, new lines and tabs as pasted. Only a paste makes a block: typing never does, and a dropped prompt comes back as plain text. The block's text is counted, never laid out, so a 64 KB paste stays quick.
- The field holds 64 KB: 65,536 bytes of the whole text in UTF-8. Typing or a paste that would pass it adds only what fits, cut between two characters, and the field's own line says `The field holds 64 KB: the rest was not added.`, muted.
- It keeps its text after a refusal and across Briefs.
- Enter on an open Brief, or a click on the field, puts the cursor in it. Esc steps back to the Brief, and the text stays.
- While the field has the cursor, every key types, m, h and s included.
- While the field has the cursor, its box and title turn sage. Only the box with the cursor is sage.
- On a Brief page, Tab goes Brief, field, Help. Beside a side Brief, it goes the lines, the Brief, its field, Help.

### The field's own line

The row above the field's box is the field's own line. It is empty until there is news.

- News is muted. A refusal is rose and bold, behind a `×`.
- A sentence longer than the room wraps upward, over a shorter Brief.
- A message stays until the next key in the field.

**Each message belongs to one session:** the one whose Brief had the field at Enter. A send's refusal, news or no-reply sentence, a prompt's `Sending…` and `That prompt did not run` each show only on that session's Brief; the 64 KB sentence belongs to the Brief that had the field when the key or the paste came in.

- `That prompt did not run` is also drawn from the row (`droppedLine` in reply.ts).
- It stays for its own Brief until a key is typed in the field there while it is the line showing, whatever is typed, sent or refused under another Brief first.
- A key that clears another sentence of that session leaves it, and it shows next. The prompts so cleared are `FieldState.told`.
- A sentence said under another Brief takes the field's line, not the first session's sentence. That one stays behind it (`FieldState.behind`, `saying` in reply.ts) and shows on its own Brief, so a prompt's no-reply sentence is seen there before Enter sends the text again.
- The next edit in the field clears them all.

### Answer or reply

Needs you is headed by its `! Needs you` badge, with the request's line under it. While there is a request, the field answers it; otherwise it replies to the session.

| Situation                                                     | Title                   | Placeholder                                     |
| ------------------------------------------------------------- | ----------------------- | ----------------------------------------------- |
| A request                                                     | `Answer`                | `yes, no, or no and your words`                 |
| A question                                                    | `Answer`                | `an option's number, or no`                     |
| A request Izbor cannot answer, or an unseen wait              | `Answer`                | `answer this one in Claude Code`                |
| No request                                                    | `Reply to this session` | `your next prompt`                              |
| No request, busy session                                      | `Reply to this session` | `your next prompt; it runs when this turn ends` |
| No request, and the list shows the project without the plugin | `Reply to this session` | `this project has no plugin`                    |

- The title is `Answer` for a request, a question, a plan approval and an unseen wait alike. It is never the request's name.
- The mode is fixed when typing starts. The title holds still while text sits in the field.

### When Izbor cannot answer

A muted line closes Needs you. The field is still titled `Answer`, with the placeholder `answer this one in Claude Code`.

The muted line is one of:

- `Answer in Claude Code: this project has no plugin.`
- `Answer in Claude Code: Izbor was not running when it asked.`
- `Answer in Claude Code: Izbor is no longer holding this request.`
- `Answer in Claude Code: Izbor does not answer plan approvals.` A plan approval reads `Plan approval`, with the plan's first line under it.
- `Answer in Claude Code: Izbor answers only one question with one choice.` Such a question shows its questions, each on its own line, with no numbers.
- `That request has an answer already.`, once another window answered.

On such a request:

- Enter then refuses in rose with `Answer it in the session: <the same fact>`.
- Without the plugin, Enter refuses with `This project has no plugin: answer in Claude Code, or add it with Add plugin › on Home.`
- A request Izbor already holds stays answerable.
- A reason that may last a moment (`not running when it asked`, `expired`) shows once it has held 400 ms, so its line never flashes.

**An unseen wait.** A request from before Izbor started is no request in Needs you, since Izbor never saw one.

- Needs you reads `Unknown · <Claude Code's name for the wait>`, such as `Unknown · permission prompt`. Within those 400 ms it reads plain `Unknown`.
- The same muted line stands under it: `Answer in Claude Code: Izbor was not running when it asked.`
- The field is titled `Answer`, with `answer this one in Claude Code`.
- Enter refuses with `Answer it in the session: Izbor was not running when it asked.` It sends nothing, neither an answer nor a prompt.

### A question

- Needs you shows the question as its headline, with no tool name.
- Its options follow, numbered `1.`, `2.`, `3.`, one per line. (`needsYouOf` in live/brief.ts puts them in the request's `detail`, split at `\n`, and sets `takes: "number"`.)
- The number is the answer: `2` picks the second option.
- `yes`, a number the question does not have, and any other text get Izbor's rose `Type an option's number, or no.`
- `no`, and `no` with words, work as for a permission prompt.
- Only a question of exactly one question with one choice has numbers.

### Answering

In the live app, `yes`, `no`, `no` and your words, or a question's option number in the field answer the request in Needs you. `yes`, `no` and a number are one line; a `no` with your words may run over several lines, and it reaches the agent whole, its new lines kept. The store posts `POST /sessions/<id>/answer` with the request's `at` and the send key from the file `GET /izbor` named.

**Sent once, to the right request.**

- An answer is sent once, never as a prompt, and to the request it was typed for.
- The mode fixed at the first key holds the session and the request's time. A Brief of another session, or a request that ended or changed before Enter, refuses with `That request is over or changed: check the Brief.` and sends nothing.
- While an answer is out, Enter sends nothing more.

**After a send.**

- The field is empty, with no placeholder.
- Its line reads `Sent yes. Needs you clears when the agent goes on.`, muted, while the field is empty. After an option's number it reads `Sent 2.`: the number as typed, not the option's label.
- In the window that answered, a muted `Sent from Izbor: yes · 3s ago` closes Needs you, its age counting up.
- Both echo a `no` over several lines as one sentence: its lines join with a space, and the sentence wraps as a long one does, with no line break of its own (`Sent no, run only the export tests and keep the old ones. Needs you clears when the agent goes on.`).
- Nothing turns green or says Approved: Needs you clears only on evidence.
- If the same request still waits 5 s after the send, `× That request still waits: answer it in the session.` shows in rose under the Sent from Izbor line. The Sent sentence then leaves the field's line.

**Refusals.** A refusal is rose, with your text kept. It is Izbor's own (`Type yes, no, or no and your words.`, `That request has an answer already.`), or the window's when Izbor is away.

A Brief that is not live keeps its field and your text. Enter refuses with one sentence per state:

- `The session has ended: nothing was sent.`
- `Izbor is not watching this session: nothing was sent.`
- `Izbor is reconnecting: nothing was sent. Try again in a moment.`
- `Izbor is not running: nothing was sent.`
- `Izbor is stopping: nothing was sent.`

Plan approvals and "Yes, and don't ask again" stay in the session.

### Replying

With no request in Needs you, the field sends an Izbor prompt. The store posts `POST /sessions/<id>/prompts` with the text as typed, its lines included, and the send key, read at each send (`answering` in live/answers.ts, the rules in reply.ts).

**Sent once, to the right session.** A prompt is sent once per Enter, never as an answer, and only to the session it was typed for.

- Under another session's Brief, Enter refuses with `You typed this on another session's Brief: nothing was sent.`
- When a request has come to Needs you since the first key, the title holds still and Enter refuses with `Answer the request first.`
- Where the list shows the project without the plugin, Enter refuses before any store, with the same no-plugin sentence as an answer (see [When Izbor cannot answer](#when-izbor-cannot-answer)).

**Sending.** Izbor replies once the session's plugin collected the prompt, which it waits up to 5 s for. Meanwhile the field's line says `Sending…`, the text stays, and Enter sends nothing more.

**Sent.** A collected prompt empties the field and is kept on its row (`Observation.prompt`, from `sentPrompts` in live/prompts.ts), in one of two states:

| State    | When                         | The field's line, while the field is empty | The line lasts until                                                         |
| -------- | ---------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `sent`   | the session was not busy     | `Sent to this session.`                    | a brief shows the session busy or asking, which is Izbor seeing the new turn |
| `queued` | behind a busy session's turn | `Sent. It runs when this turn ends.`       | the `prompt` stream event says `delivered`, or a brief shows the turn over   |

- While `queued`, the placeholder is the plain `your next prompt`. When its line ends, the busy placeholder is back.
- A prompt whose line is over is still kept, unshown, until the session's next prompt, so a `dropped` event that comes later still counts.
- The store hears the `prompt` event on each row's stream (`hearing`).

**Dropped.** A `dropped` event marks the prompt dropped.

- The controller puts the rose `That prompt did not run: <reason>.` on that session's field line, once.
- It puts the text back into the field only when the field is empty, Needs you holds no request, and that Brief is the one shown. So a prompt never lands in an answer field or under another session's Brief.
- A prompt dropped before Izbor's reply to its send keeps its text in the field, with that line.

**Refusals.** Izbor's refusals are rose, with the text kept:

- `Type /reload-plugins in this session once to send messages from here.`
- `A prompt for this session waits already.`
- `Run slash commands in the session.`
- `The prompt is empty.`
- No reply, or a 200 without a prompt id, is `Izbor gave no reply: check the Brief before you send again.`, since the prompt may have gone.

`@file` mentions reach Claude as plain text.

### Submission ownership and disposal

- `submission.ts` owns field edits, draft revisions, pending sends and dropped-prompt feedback.
- `field.ts` and `reply.ts` provide pure field transitions and display rules.
- A send captures its draft revision and originating mode/session. Success clears the field only if both are unchanged.
- Editing and restoring identical text is a new revision.
- Disposal unsubscribes this owner and ignores late completions.
- The live source propagates its abort signal through send-key reads and HTTP requests. It checks the signal before starting a send and before recording its result, and rejects pending or later operations with `AbortError`.
- Pending session refreshes also reject on disposal. Controller actions catch those cancellations without repainting a closed window.

## Colours

Izbor keeps the terminal's background; the native background remains visible. Only the `! Needs you` badge, the field's paste block and your Task in a Brief's heading are filled. Its tones are made for a dark theme. Fonts and their size remain the terminal emulator's settings.

| Tone                         | What it draws                                                                                                                                                                         | On a 16-colour terminal           | With colour off                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| Ivory                        | text                                                                                                                                                                                  | the terminal's own text colour    | —                                            |
| Cool grey-blue               | Claude's explanation (Now); it is muted under a notice or when outdated                                                                                                               | the terminal's own text colour    | —                                            |
| Muted grey                   | the Status word beside a name, labels, ages, news lines, the other tab, `Izbor ● up`, a Home session line's `Open ›` until its line has focus, a running call's dot, result rows      | the terminal's own text colour    | —                                            |
| Sage                         | focus: the marked row's Task and a focused Home line's name (both also bold), the field's box and title while it has the cursor, and every control but a Home session line's `Open ›` | the terminal's own text colour    | —                                            |
| Dusty blue (the notice tone) | every ▲ notice, `Briefs update late`                                                                                                                                                  | cyan                              | the glyphs and the words carry every notice  |
| Dusty blue (the link tone)   | the label of a link in the agent's words, and a URL it shows once, both underlined                                                                                                    | blue, underlined                  | underlined                                   |
| Rose, bold                   | every × refusal                                                                                                                                                                       | red                               | the glyphs and the words carry every refusal |
| Rose                         | the dot and result row of a failed, rejected or interrupted call                                                                                                                      | red                               | `×` in the dot's cell                        |
| Green                        | `✓`, the word Idle in a Brief's heading, `Reply finished`, and the dot of a finished call                                                                                             | green                             | `✓` in a finished call's dot's cell          |
| Clay                         | the `*` of a Working session                                                                                                                                                          | the terminal's own text colour    | —                                            |
| Grey (the border tone)       | box lines, the divider, and the agent's `---` rules and table rules                                                                                                                   | the terminal's own text colour    | —                                            |
| Periwinkle (the code tone)   | inline code, and the code blocks with no syntax colours, in the agent's words                                                                                                         | bright blue                       | the backticks and the fence lines come back  |
| Syntax colours               | a code block whose fence names a language Izbor has syntax colours for, as below                                                                                                      | the same, comments not muted      | none, and the fence lines come back          |
| Dark sage (the paste fill)   | the fill of a paste block in the field, under its label in sage                                                                                                                       | no fill: the label in brackets    | the label in brackets                        |
| Dark grey (the Task fill)    | the fill behind your Task in a Brief's heading, on the Brief page and in the side Brief, its words in ivory                                                                           | `blackBright`                     | none                                         |
| Amber                        | a session that needs you, and nothing else: the `!` mark, the filled `! Needs you` badge and the request line under it, and the dot and rows of the call that waits for you           | yellow; black on the yellow badge | a reverse-video badge; `!` and bold rows     |

**Syntax colours** follow Claude Code's map, in the terminal's named colours at every colour level, so the terminal's own palette decides them: keywords, literals and class names blue, built-ins cyan, numbers green, strings red, functions yellow, and comments in the muted tone; in a diff, added lines green and removed lines red. Everything else, parameters, variables and `${…}` in a string too, is in the terminal's own text colour. On a 16-colour terminal they are the same, but the muted tone is the terminal's own text colour, so comments are too. With colour off a block has no syntax colours: its fence lines come back, as for any other block.

**Turning colour off.**

- `--no-color` (or `NO_COLOR=1`) turns off the palette. A terminal with `CI` set gets the same.
- Under `CI`, `FORCE_COLOR=1` brings the colour back.
- With colour off, bold, italic, underline and reverse video stay: the selected row's Task is bold, `Help · Ctrl-G` is underlined and the `! Needs you` badge is in reverse video.
- With colour off, the markers of the agent's markdown come back as the agent wrote them: a heading keeps its `# ` (or `## ` to `###### `) and any closing `#`, or the `===` or `---` row under it, bold and not underlined; inline code keeps its backticks; a code block has its fence lines, 2 columns in like its code, and no language row, and a cut block's `… 38 more lines` stands over its closing fence line; a quote has `> ` on every row, italic; and a rule stands as `---`. Bold and italic stay without their `**` and `*`, and lists look as with colour on.
- With colour off, a link reads `label (url)` with its label underlined, or its label alone where it shows its URL once, and `~~struck~~` text keeps its `~~`, in every terminal: colour off turns OSC 8 links and strikethrough off too.
- `TERM=dumb` turns the palette off and draws none of them either.
- With colour off, `Selected · ` stands before the Task of the selected row on Sessions. In a split, that is the row the side Brief shows.

## Layout and sizes

All sizes are terminal character cells, not pixels. The application follows the terminal's font and zoom.

| Window                           | View                                                      | Spacing                            |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| Fewer than 40 columns or 12 rows | Resize message; input is suspended and state is preserved | Ctrl-C still exits                 |
| 40–139 columns, or 12–19 rows    | Sessions; opening a Brief replaces the body               | No blank session gap below 20 rows |
| At least 140 columns and 20 rows | Sessions and selected Brief side by side                  | One blank row between sessions     |

**Columns.**

- Outer gutters are two columns each.
- A split has two blank columns, a one-column vertical divider, then two blank columns between panes.
- For window width W, divide W−9 columns: Sessions gets floor(60% × (W−9)); the Brief gets the remainder. For example, 160 columns gives 90 columns for Sessions and 61 for the Brief.
- The panes fill the window; they are not centered or capped.
- A row's text uses the Sessions pane's whole width less the three cells before it (gutter, mark, blank). Brief text is limited to 82 columns.
- The full response stands at the pane's width, outside the Brief's 82 columns, on the Brief page and in the side Brief alike: the side Brief's box takes its pane's whole width. The agent's prose in it wraps at the pane's width, at most 82 columns.

**Rows.** For window height H, the scrollable body gets all remaining rows:

| Screen                     | Body rows                                                       |
| -------------------------- | --------------------------------------------------------------- |
| Home and Sessions          | H−5                                                             |
| Brief page without a field | H−4                                                             |
| Brief page with a field    | H−7, less a row for each row of the field's text past the first |

- The application header uses one row.
- A Brief page's heading takes the rows under `Back · Esc`, at most ten and at most half the body; the side Brief's heading takes one to three rows, its rows past the first taken from the body.
- The row above the last line holds the refusal or news line (see [Messages row](#messages-row)).
- The last line holds Help. It spans the usable width on every screen, with the Help control at its right end, and Help remains clickable there.
- On a Brief with a field, the box stands right above the last line, under its own line. It grows upward a row for each row of its text, at most 6, and never takes the body's last row; in the side Brief, the side Brief's body gives up the same rows. On a Brief with a full response, the box leaves the body 3 rows, for the response's view and its footer.
- A line longer than the pane wraps, and takes its extra rows from the body.

**The split.**

- The Brief's field sits at the bottom of the side Brief, its box under its own line and ending on the row above the last line.
- The divider runs from the Sessions heading to the row above the last line, in the border tone.
- Help and Home use a single pane.

## Sample sessions used by tests

In the sample sessions:

- the first session is busy, and its activity changes every eight seconds;
- the second waits for permission;
- the third is idle after a finished reply.

In `response-writing` the third session writes on: every eight seconds its turn gains one more item, a tool call and a text item in turn, and its explanation swaps between a long and a short one, so the Brief above the full response changes height. The first of these ticks also ends the running tests' call.

The three overview Explanations contain 3, 13, and 25 words, respectively. All sample Explanations stay within the backend's 25-word limit.

The sample project `izbor` has the plugin, so the reply fields read `your next prompt`. Enter in a field answers `The sample sends nothing.` and changes nothing.

### Sample cases

The tests set each case with `setScenario` on the sample source, or with a replay's `scene next` step. Each case changes the third session only.

Four cases need only a short description:

- `overview`: busy / waiting for permission / idle.
- `unknown`: the third Brief has no evidence yet.
- `outdated`: retain an Explanation written before the reply finished, and mark the reason.
- `missing-request`: Status reports waiting, but the request was not observed.

The other cases each draw something of their own:

| Case                     | What it sets up                                                                                         | What shows                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disconnected`           | retain and label the last received Brief                                                                | row: `Idle · ▲ Disconnected · last known Brief`. The Brief counts down to the next try: `▲ Disconnected · retrying in N s · last known Brief`                                                                                                           |
| `stopped`                | retain and label the stopped observation                                                                | automatic updates do not restart it; Enter or a click on the row observes it again                                                                                                                                                                      |
| `connecting`             | no Brief has arrived yet                                                                                | the row shows its short ID and `▲ Catching up…`                                                                                                                                                                                                         |
| `catching-up`            | retain the last Brief while the stream catches up                                                       | row: `Idle · ▲ Catching up… · last known Brief`. Brief: `▲ Catching up… · last known Brief`                                                                                                                                                             |
| `izbor-stopped`          | the Izbor stop ended the watch                                                                          | row: `▲ last known Brief`. Brief: `▲ Stopped · Izbor stopped · last known Brief`                                                                                                                                                                        |
| `not-running`            | Izbor does not answer                                                                                   | row: `▲ last known Brief`. Brief: `▲ Izbor is not running · retrying in N s · last known Brief`                                                                                                                                                         |
| `izbor-stopping`         | Izbor is in its Izbor stop                                                                              | row: `▲ last known Brief`. Brief: `▲ Izbor is stopping · last known Brief`                                                                                                                                                                              |
| `refused`                | Izbor refused the stream                                                                                | `▲ Izbor refused · 403 · <its message>`, on the row after its Status word and in the Brief                                                                                                                                                              |
| `gap`                    | a time Izbor did not observe; the sample gap is 40 s                                                    | `▲ Izbor did not observe this session between <time> and <time>`, in the notice tone, on the row and under the Brief's body. A gap is drawn only when over 30 s, or when Izbor was away in between. It goes when the Status or the explanation changes. |
| `answer-sent`            | the third session waits on a permission prompt this window answered                                     | `Sent from Izbor: yes · 3s ago` under Needs you, the Sent sentence on the field's line, no placeholder                                                                                                                                                  |
| `answer-not-taken`       | the same, 8 s on, and the request still waits                                                           | the rose `× That request still waits: answer it in the session.`                                                                                                                                                                                        |
| `cannot-answer`          | a request Izbor cannot answer                                                                           | `Answer in Claude Code: Izbor was not running when it asked.`, and Enter on `yes` refuses                                                                                                                                                               |
| `question`               | the third session asks `Which date format should the export use?`                                       | three numbered options; the field's title `Answer`, the placeholder `an option's number, or no`                                                                                                                                                         |
| `fresh-wait`             | the third session asks for permission the moment the case is set                                        | a blinking `!` on its row, and a Brief that takes an answer (see below)                                                                                                                                                                                 |
| `response-writing`       | the third session works on `Make the retry limit configurable per client and cover it with tests.` (W3) | under Stop observing, `Agent's latest message so far · 40s ago`, the agent's newest text and `● Bash(npm test -- request)` with `⎿  Running…`, then `Earlier in this turn · 8 tool calls`; no `Latest:` row                                             |
| `response-finished`      | the same Task, its turn over 2 min ago (L4)                                                             | `Agent's last message · 2m ago` and the answer, then the turn from its start, down to `Reply finished · 2m ago` in green                                                                                                                                |
| `response-waiting`       | the same Task, the commit waiting on a permission (W3)                                                  | the tests' call, then `● Bash(git add -A && git commit -m "Make the retry limit per client")` and `⎿  Waiting for your answer · Commit the per-client retry limit` in amber, the command whole                                                          |
| `response-tools`         | another Task, waiting to install a package after every kind of tool call in every state                 | one row and one result row per call, each dot in its state's colour (`✓ * ! ×` with colour off), among them a subagent started in the background, a command's first line with its colour codes gone and a 300-character path's end                      |
| `response-no-text`       | another Task, the invoice tests waiting on a permission before the agent wrote any text (C)             | `rows 1-2 of 7 · no text yet` on the divider in the label's place, then `● Searched for 2 patterns, read 4 files` and the writes, down to the waiting call                                                                                              |
| `response-nothing-yet`   | a new Task the agent has not started on                                                                 | `Nothing to show yet: the agent has not started on this Task.` and `Responses to earlier Tasks: read them in the session.` in the notice tone, under Stop observing; no `Latest:` row                                                                   |
| `response-interrupted`   | another Task, idle after the user stopped the agent's edit                                              | `● Update(src/auth/token.ts)` with `⎿  Interrupted by the user` in rose, then `Reply interrupted by the user: the agent's unfinished words are not saved`                                                                                               |
| `response-rejected`      | another Task, idle after the user said no to `rm -rf build/`                                            | `● Bash(rm -rf build/)` with `⎿  Rejected by the user` in rose, then `Reply ended: rejected by the user: Bash: rm -rf build/`                                                                                                                           |
| `response-failed`        | another Task, idle after the agent provider's error ended the reply                                     | an edit and the tests' call, then `Reply failed: API Error: 529 overloaded`                                                                                                                                                                             |
| `response-no-transcript` | another Task, finished, with a transcript Izbor cannot read                                             | `Only the agent's last message: Izbor cannot read this session's transcript, so its tool calls are not shown` first, then the last message and `Reply finished · 2m ago`                                                                                |
| `response-cut`           | another Task, finished, its text past the 20,000-character limit                                        | `… 4 210 earlier characters: read them in the session` first under `Earlier in this turn · 1 tool call`                                                                                                                                                 |
| `response-after-task`    | another Task, finished after a background task ran the suite                                            | `Agent's last message · after the background task · 3m ago`, and `─ background task finished HH:MM ─` in the turn, in the local time                                                                                                                    |

`fresh-wait` in full:

- Its row's `!` blinks for five seconds, one second drawn and one not, then stays still.
- Its Brief takes an answer: the badge, `Bash: npm test retries` under it, and the field `Answer` with the placeholder `yes, no, or no and your words`.
- Setting it rings the bell once.

**Countdowns.** The Brief's `disconnected` and `not-running` countdowns start again at 10 s each time they run out, while the sample sessions animate.

**Writing on.** While the sample sessions animate, `response-writing` writes on every eight seconds, as [Sample sessions used by tests](#sample-sessions-used-by-tests) says.

### Reading the evidence

- Unknown is not offline.
- Idle is not success.
- Age alone does not make an Explanation outdated.
- Known "no request pending" is omitted from the overview.
- Unknown Needs you stays visible on a waiting row, and in the Brief while the session waits or the field answers to it.

## Outside the window

**Window title.** The terminal's window or tab title reads:

| Title                 | When                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `Izbor · needs you`   | a session this window observes waits                                                      |
| `Izbor · not running` | the top line shows Izbor in trouble (stopping, not running, not answering, its port held) |
| `izbor`               | otherwise                                                                                 |

- The title is written only when it changes, and set back to `izbor` when the app quits.
- A session that waits on Home but is not observed does not change it.
- tmux shows it only with `set-titles` on.

**Bell.** The terminal bell rings once when an observed session starts a wait that began after its stream's first brief (`Observation.since`).

- It does not ring for a wait already there when you observe it, a session that waits on Home only, a ▲ notice or a × refusal.
- It rings once more when an answer sent from Izbor is first found not taken on a live row, as `× That request still waits` appears.
- `izbor --no-bell` turns it off, and nothing else does.
- With the sample sessions, setting `fresh-wait` or `answer-not-taken` rings. The case the window opens on never does.

Both are written by `writeAlerts` in main.ts, and decided by `windowTitle` and `rings` in alerts.ts.

**OSC 8 links.** The agent's links open from the terminal where it opens OSC 8 links. The terminal app reads which terminal it runs in once, when it starts:

- Links: where `supports-hyperlinks` says so (iTerm2 3.1 or later, VS Code, VTE terminals, Alacritty and others), and in kitty, Ghostty, WezTerm, Warp, Windows Terminal and tmux 3.4 or later.
- Inside tmux, tmux's version alone decides: tmux 3.3 or older keeps `label (url)`, whatever terminal it runs in.
- Never sent: to Terminal.app, which prints the tail of an escape sequence it does not know; under `CI`; with colour off. These keep `label (url)`, and no OSC 8 byte reaches them.
- Strikethrough: everywhere but Terminal.app, the Linux console (`TERM=linux`) and colour off.

`terminalAbilities` in `src/cli/abilities.ts` decides both, and whether the terminal reports Shift-Enter and needs no setting for it ([Keys and mouse](#keys-and-mouse)), and `openTerminal` in `src/cli/main.ts` passes them with the screen flags.

## Design validation

`test/frames` pins Sessions, the Brief and Metadata on either side of the split, and the fallback. `test/replays/design-validation.txt` replays the rest of this walk on the sample sessions.

1. Try 80×24, 139×24, 140×20, 160×19, 160×24, and 160×32, and the 39-column and 11-row resize fallback.
2. Without expanding a Brief, identify the work of all three sessions and the pending request.
3. Select the second session, open Metadata and scroll its right pane.
4. Shrink below 140 columns and widen again. Check that the same session returns.
5. Wait for a session update, and check that selection and focus stay put.
6. Check each sample case, in the `scenario-*` frames, and check that unavailable evidence cannot be mistaken for current knowledge.

The test suite includes an actual pseudo-terminal connected to a headless terminal emulator. It checks final screen cells after shrinking and growing, updates while typing, and terminal restoration on exit. This check needs Unix and Python 3; otherwise it reports a skip. It complements testing font zoom and rendering in your own terminal emulator.

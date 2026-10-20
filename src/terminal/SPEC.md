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

**Heading.** A Brief heads with its Task, wrapped the same way as on a row, and its Status after the Task's last word: `* Working`, `✓ Idle`, or the muted word. The heading takes one to three rows.

**Body.** Under the heading, in order:

- Now, once there is an explanation or Izbor's reason for none. The Brief shows the explanation whole.
- `Latest:`, while Working only.
- Any request.
- One relative update time.
- Stop observing. This is the Brief's control line.

A Brief's text wraps without silently truncating explanations or requests.

**Metadata.** Press m while the Brief is focused; no control is drawn for Metadata.

- It shows under the control line: the full ID (UUID), the Task whole when the heading cut it, sources (provenance) and exact timestamps.
- m scrolls the Brief so the block's last line is in view.
- m again removes it and gives the Brief the scroll it had.
- Stale, disconnected or unknown evidence remains explicitly marked, with Metadata shown or not.

**Scroll.** Brief and Sessions scroll independently. A session opened for the first time starts at the top. Opening another session resets Metadata and its scroll; returning to the same session preserves them.

**Open, hide, back and stop.**

- Click or Enter opens a session.
- Hide or h closes the pane: it hides the Brief that shows, from the list too. Enter or a click on its row brings the Brief back.
- Escape focuses Sessions in a split layout, or returns from a single-pane Brief.
- s in a focused Brief, or a click on Stop observing, stops observing that session. It keeps running, and the news line says how to bring it back.

**No hooks.** A Brief of a project without Izbor's hooks has no field. `Briefs update late: this project has no hooks` stands under its heading in dusty blue, and its messages stand on the row above the last line.

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
| Enter on a Home line   | Observe a session and open its Brief, or open an observed one's; a project line adds its hooks, or the plugin once it has them.          |
| Click a Home line      | Do what Enter on it does. For project lines, see [Project cues](#project-cues-hooks-and-plugin).                                         |
| Ctrl-O / click a tab   | Switch Home and Sessions, each at its own scroll.                                                                                        |
| m                      | Show or hide Metadata under the Brief's control line: the full ID, the Task whole when the heading cut it, sources and exact timestamps. |
| h / click Hide         | Hide the Brief that shows, from the list too; Enter or a click on its row brings the Brief back.                                         |
| Esc                    | Step back one level, in the order given in [Screens](#screens). From the field, see [The field](#the-field).                             |
| Up / Down              | Move focus across the screen's lines, or scroll an expanded Brief.                                                                       |
| Page Up / Page Down    | Scroll the focused pane.                                                                                                                 |
| Click the side Brief   | Give it the focus, so m and s act on it.                                                                                                 |
| Click Back · Esc       | Return from an open Brief.                                                                                                               |
| Click Send             | Send the field's text, as Enter in the field does.                                                                                       |
| Ctrl-G / click Help    | Open Help; Ctrl-G, Esc or a click on Close · Ctrl-G returns to the same view, focus, and scroll position.                                |
| s in a focused Brief   | Stop observing that session; it keeps running, and the news line says how to bring it back.                                              |
| Click Stop observing   | Close the open Brief's local observation.                                                                                                |
| Wheel / trackpad       | Scroll only the pane beneath the pointer, preserving input focus.                                                                        |
| Ctrl-C / Ctrl-D        | Exit and restore the normal terminal screen and input mode.                                                                              |

Help uses a single pane and restores the previous view when closed.

### Mouse

- Mouse controls use standard SGR reporting on compatible terminals.
- Keyboard navigation remains available.
- `izbor --no-mouse` leaves mouse gestures and text selection entirely to the terminal emulator.
- Mouse tracking is disabled again when Izbor exits.
- A click on a Home session you do not observe observes it and opens its Brief. A click on one marked `Open ›` opens its Brief.

## The Brief's field and answers

### The field

Each Brief has an input field of its own, under its own line. In a split window it sits at the bottom of the side Brief; on a Brief page it sits right above the last line.

- The field starts empty and is one line. Long input scrolls horizontally.
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

**Each message belongs to one session:** the one whose Brief had the field at Enter. A send's refusal, news or no-reply sentence, a prompt's `Sending…`, and `That prompt did not run` each show only on that session's Brief.

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

In the live app, `yes`, `no`, `no` and your words, or a question's option number in the field answer the request in Needs you. The store posts `POST /sessions/<id>/answer` with the request's `at` and the send key from the file `GET /izbor` named.

**Sent once, to the right request.**

- An answer is sent once, never as a prompt, and to the request it was typed for.
- The mode fixed at the first key holds the session and the request's time. A Brief of another session, or a request that ended or changed before Enter, refuses with `That request is over or changed: check the Brief.` and sends nothing.
- While an answer is out, Enter sends nothing more.

**After a send.**

- The field is empty, with no placeholder.
- Its line reads `Sent yes. Needs you clears when Claude goes on.`, muted, while the field is empty. After an option's number it reads `Sent 2.`: the number as typed, not the option's label.
- In the window that answered, a muted `Sent from Izbor: yes · 3s ago` closes Needs you, its age counting up.
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

With no request in Needs you, the field sends an Izbor prompt. The store posts `POST /sessions/<id>/prompts` with the text as typed and the send key, read at each send (`answering` in live/answers.ts, the rules in reply.ts).

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

Izbor keeps the terminal's background; the native background remains visible. Its tones are made for a dark theme. Fonts and their size remain the terminal emulator's settings.

| Tone                         | What it draws                                                                                                                                                                         | On a 16-colour terminal           | With colour off                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| Ivory                        | text                                                                                                                                                                                  | the terminal's own text colour    | —                                            |
| Cool grey-blue               | Claude's explanation (Now); it is muted under a notice or when outdated                                                                                                               | the terminal's own text colour    | —                                            |
| Muted grey                   | the Status word beside a name, labels, ages, news lines, the other tab, `Izbor ● up`, a Home session line's `Open ›` until its line has focus                                         | the terminal's own text colour    | —                                            |
| Sage                         | focus: the marked row's Task and a focused Home line's name (both also bold), the field's box and title while it has the cursor, and every control but a Home session line's `Open ›` | the terminal's own text colour    | —                                            |
| Dusty blue (the notice tone) | every ▲ notice, `Briefs update late`                                                                                                                                                  | cyan                              | the glyphs and the words carry every notice  |
| Rose, bold                   | every × refusal                                                                                                                                                                       | red                               | the glyphs and the words carry every refusal |
| Green                        | `✓`, and the word Idle in a Brief's heading                                                                                                                                           | green                             | —                                            |
| Clay                         | the `*` of a Working session                                                                                                                                                          | the terminal's own text colour    | —                                            |
| Grey (the border tone)       | box lines and the divider                                                                                                                                                             | the terminal's own text colour    | —                                            |
| Amber                        | a session that needs you, and nothing else: the `!` mark, the filled `! Needs you` badge and the request line under it                                                                | yellow; black on the yellow badge | the badge is drawn in reverse video          |

**Turning colour off.**

- `--no-color` (or `NO_COLOR=1`) turns off the palette.
- A terminal that cannot show colour, such as one with `CI` set or `TERM=dumb`, gets the same.
- Under `CI`, `FORCE_COLOR=1` brings the colour back.
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

**Rows.** For window height H, the scrollable body gets all remaining rows:

| Screen                     | Body rows |
| -------------------------- | --------- |
| Home and Sessions          | H−5       |
| Brief page without a field | H−4       |
| Brief page with a field    | H−7       |

- The application header uses one row.
- A Brief's heading takes one to three rows; its rows past the first are taken from the body.
- The row above the last line holds the refusal or news line (see [Messages row](#messages-row)).
- The last line holds Help. It spans the usable width on every screen, with the Help control at its right end, and Help remains clickable there.
- On a Brief with a field, the box stands right above the last line, under its own line.
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

| Case               | What it sets up                                                     | What shows                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disconnected`     | retain and label the last received Brief                            | row: `Idle · ▲ Disconnected · last known Brief`. The Brief counts down to the next try: `▲ Disconnected · retrying in N s · last known Brief`                                                                                                           |
| `stopped`          | retain and label the stopped observation                            | automatic updates do not restart it; Enter or a click on the row observes it again                                                                                                                                                                      |
| `connecting`       | no Brief has arrived yet                                            | the row shows its short ID and `▲ Catching up…`                                                                                                                                                                                                         |
| `catching-up`      | retain the last Brief while the stream catches up                   | row: `Idle · ▲ Catching up… · last known Brief`. Brief: `▲ Catching up… · last known Brief`                                                                                                                                                             |
| `izbor-stopped`    | the Izbor stop ended the watch                                      | row: `▲ last known Brief`. Brief: `▲ Stopped · Izbor stopped · last known Brief`                                                                                                                                                                        |
| `not-running`      | Izbor does not answer                                               | row: `▲ last known Brief`. Brief: `▲ Izbor is not running · retrying in N s · last known Brief`                                                                                                                                                         |
| `izbor-stopping`   | Izbor is in its Izbor stop                                          | row: `▲ last known Brief`. Brief: `▲ Izbor is stopping · last known Brief`                                                                                                                                                                              |
| `refused`          | Izbor refused the stream                                            | `▲ Izbor refused · 403 · <its message>`, on the row after its Status word and in the Brief                                                                                                                                                              |
| `gap`              | a time Izbor did not observe; the sample gap is 40 s                | `▲ Izbor did not observe this session between <time> and <time>`, in the notice tone, on the row and under the Brief's body. A gap is drawn only when over 30 s, or when Izbor was away in between. It goes when the Status or the explanation changes. |
| `answer-sent`      | the third session waits on a permission prompt this window answered | `Sent from Izbor: yes · 3s ago` under Needs you, the Sent sentence on the field's line, no placeholder                                                                                                                                                  |
| `answer-not-taken` | the same, 8 s on, and the request still waits                       | the rose `× That request still waits: answer it in the session.`                                                                                                                                                                                        |
| `cannot-answer`    | a request Izbor cannot answer                                       | `Answer in Claude Code: Izbor was not running when it asked.`, and Enter on `yes` refuses                                                                                                                                                               |
| `question`         | the third session asks `Which date format should the export use?`   | three numbered options; the field's title `Answer`, the placeholder `an option's number, or no`                                                                                                                                                         |
| `fresh-wait`       | the third session asks for permission the moment the case is set    | a blinking `!` on its row, and a Brief that takes an answer (see below)                                                                                                                                                                                 |

`fresh-wait` in full:

- Its row's `!` blinks for five seconds, one second drawn and one not, then stays still.
- Its Brief takes an answer: the badge, `Bash: npm test retries` under it, and the field `Answer` with the placeholder `yes, no, or no and your words`.
- Setting it rings the bell once.

**Countdowns.** The Brief's `disconnected` and `not-running` countdowns start again at 10 s each time they run out, while the sample sessions animate.

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

## Design validation

`test/frames` pins Sessions, the Brief and Metadata on either side of the split, and the fallback. `test/replays/design-validation.txt` replays the rest of this walk on the sample sessions.

1. Try 80×24, 139×24, 140×20, 160×19, 160×24, and 160×32, and the 39-column and 11-row resize fallback.
2. Without expanding a Brief, identify the work of all three sessions and the pending request.
3. Select the second session, open Metadata and scroll its right pane.
4. Shrink below 140 columns and widen again. Check that the same session returns.
5. Wait for a session update, and check that selection and focus stay put.
6. Check each sample case, in the `scenario-*` frames, and check that unavailable evidence cannot be mistaken for current knowledge.

The test suite includes an actual pseudo-terminal connected to a headless terminal emulator. It checks final screen cells after shrinking and growing, updates while typing, and terminal restoration on exit. This check needs Unix and Python 3; otherwise it reports a skip. It complements testing font zoom and rendering in your own terminal emulator.

# Terminal interaction ownership

## Context

The CLI review found coordination spread across the controller, field, live source and screen. Existing frame, replay and controller tests characterize navigation, scroll restoration and mouse target behavior.

The entry path is `bin/izbor.js` → `src/cli/main.ts` → `src/terminal/main.ts` → `TerminalApp`. Keyboard and mouse handlers call the controller; the observation source owns HTTP and session discovery; Ink measures and renders the view. No viewport calculation needs I/O or React.

## Decision

Keep terminal measurements in `screen.tsx`. Pass rectangles, current scroll, focus, page and previous viewport identity to `viewportLayout`. It returns clamped scroll positions, clipped hit targets and the next viewport identity. This separates scroll policy from Ink's element handles without changing rendering or mouse behavior.

Represent the active page as an overview, a full-page brief, or help with a return page. `navigation.ts` owns transitions, restored focus and scroll positions. The view derives its screen, expanded brief and help visibility from that page; the selected session, hidden side-pane preference and metadata preference remain independent. Navigation keeps the page, saved return focus and scroll positions private. Its read-only view exposes only the facts rendering needs, through live getters. The controller keeps source operations and keyboard dispatch, and invokes navigation transitions after those operations. Focus movement, measured scroll updates and metadata expansion also go through those transitions; neither the controller nor tests can write navigation state through `TerminalView`.

## Validation

Existing frame, replay, terminal window and architecture ratchet tests must pass without updating visual snapshots. Controller tests arrange navigation through public actions. Encapsulation tests reject direct view writes and verify that a retained view follows help, resize, back and session-removal transitions with both scroll positions preserved.

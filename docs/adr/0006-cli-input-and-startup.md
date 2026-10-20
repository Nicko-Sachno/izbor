---
status: accepted
---

# CLI inputs and startup follow the command's capabilities

The CLI previously chose project setup and agent discovery independently from the first values of two provider records. It now uses one explicit `CLI_PROVIDER` bundle for Claude Code, whose session-list format the terminal currently understands. The service's `PROVIDERS` registry, which lets one Izbor run several agent providers, remains unchanged. A second terminal provider must define discovery and selection together before the CLI can support it.

Arguments are validated against a small option list for each command. `hooks` and `plugin` take their next positional word as a folder, even when it matches another command. `--` ends option parsing so folders beginning with a dash can be passed literally. Screen options belong to the terminal app alone.

Live mode checks stdin and stdout before probing or starting Izbor. Redirected input or output returns the terminal requirement immediately. This changes the background startup only for invocations that cannot open an interactive window. The daemon still outlives a real terminal window.

`status` reports service health, paths and watches without walking stored history. `status --disk-usage` explicitly requests that walk. Suggested plugin commands quote the actual checkout path, rather than quoting a display path beginning with `~`, which would suppress shell expansion.

## Boundaries and verification

`bin/izbor.js` remains the Node/build bootstrap. `cli/args.ts` reads argv and environment; `cli/main.ts` selects the platform and CLI provider, constructs dependencies, and prints command reports. `open`, `stop`, and `serve` retain separate lifecycle implementations. No provider package is loaded for help or version output.

Tests cover command-specific options, keyword and option-like folder names, redirected startup without probes, opt-in disk usage, literal path quoting, and plugin installation failures after partial progress. The bootstrap smoke compiles the actual entry into an isolated directory, then runs `--help` and `--version` from another working directory with neither `tsx` nor `IZBOR_CLI`.

# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

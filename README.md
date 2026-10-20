# Izbor

**Izbor: a terminal monitor for your coding-agent sessions.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node >=24.3](https://img.shields.io/badge/node-%3E%3D24.3-339933)](package.json)
![Status: preview 0.1.0](https://img.shields.io/badge/status-preview%200.1.0-orange)

_Izbor_ (изборъ) is an old Slavic word for choice or selection. Medieval scribes used it for passages selected from books, as in the _Izbornik_ of 1073, and in Croatian it still means choice and, in the plural, elections. Izbor selects what matters from the noise of all your agent sessions, so none sits stalled on a request you didn't see.


![Izbor observing four sessions at once: one needs permission to run npm test invoices, the answer yes is sent from Izbor while the others work and finish, and the session goes on. Recorded against scripted sessions.](.github/assets/izbor.gif)

Supported agents: Claude Code · Codex and OpenCode planned\
Supported platforms: macOS · Windows (experimental)

## The brief

For every session you observe, Izbor keeps a brief:

| Part      | Example                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| Task      | `Add CSV export for invoices, including invoice number, date, customer, and total.` |
| Status    | `! Waiting` (or `* Working`, `✓ Idle`)                                              |
| Now       | `The CSV export is implemented. Waiting for permission to run the invoice tests.`   |
| Needs you | `! Needs you` · `Bash: npm test invoices`                                           |

Answer a request (`yes`, `no`, or `no` and a reason) or send the session its next prompt without leaving Izbor.

## Install

```sh
git clone https://github.com/Nicko-Sachno/izbor.git
cd izbor
npm ci && npm run build
npm install --global .
```

Needs Node 24.3 or later and a logged-in [Claude Code](https://code.claude.com), tested with 2.1.

## Run

```sh
izbor
```

Run it from any folder. Izbor lists every running session, grouped by project. Connect a project from Home, or from its folder:

```sh
izbor hooks    # its sessions' events reach Izbor
izbor plugin   # you can answer and prompt them from Izbor
```

Quitting leaves the service running; `izbor stop` stops it. `izbor --help` lists every command, and the [terminal app guide](src/terminal/README.md) covers screens and keys.

## Privacy

- Session records stay on your machine, in `.izbor/` inside the checkout.
- The service listens on `127.0.0.1` only.
- Izbor sends no telemetry and checks for no updates.
- Currently, the explanation under `Now` comes only from Claude Haiku: Izbor sends session-derived text through your own `claude` login, and these requests use your Claude subscription's usage.

## Docs

- [Terminal app guide](src/terminal/README.md): screens, keys, connecting projects, data, troubleshooting, update and removal
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md)

## Future development

Planned; none of these exist yet.

- More coding agents: Codex and OpenCode next to Claude Code, in one list.
- Linux support, and verified Windows support.
- Install from npm.
- An agent on top of Izbor that handles routine requests and involves you only when a session needs you.
- Settings (`izbor config`), housekeeping (`izbor clean`, start at login), user-level hooks, and `--json` output for scripts.

Have an idea? Open an issue; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Izbor depends on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which is proprietary software from Anthropic under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance); `npm ci` installs it from npm, and Izbor does not distribute it.

Izbor is an independent open-source project. It is not affiliated with, sponsored by or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

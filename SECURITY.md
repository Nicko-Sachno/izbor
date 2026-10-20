# Security policy

## Supported versions

Security fixes go to the latest `main` and the newest 0.1.x release. Older checkouts are not patched.

## Reporting a vulnerability

Report it privately at https://github.com/Nicko-Sachno/izbor/security/advisories/new, or open the Security tab and choose "Report a vulnerability". Don't use public issues, pull requests or discussions. There is no security email; this form is the only channel.

Include:

- what an attacker can do, and what access they need first
- steps to reproduce, with the commit (`git rev-parse --short HEAD`), OS, Node version and `claude --version`

Izbor has one maintainer. Expect an acknowledgement within 7 days. Once a fix is out, the advisory is published and you are credited unless you ask not to be.

## Trust boundary

- The HTTP service binds to `127.0.0.1` only.
- Send keys in `~/.config/izbor` (`%LOCALAPPDATA%\izbor` on Windows) authorize answers and prompts. Anyone who can read them can act on your sessions while Izbor runs.
- `.izbor/` in the checkout (or `IZBOR_DATA_DIR`) holds session records, hook payloads and the log. These can contain prompts, replies, file paths and tool output.
- Izbor has no telemetry or update checks. Its only network traffic is to `127.0.0.1` and the Claude Haiku requests for explanations, sent through your own `claude` login.
- Hooks are added to each connected project's `.claude/settings.local.json`. The plugin can submit prompts to that project's sessions.

Keep send keys, `.izbor/` contents and session transcripts out of anything you post publicly.

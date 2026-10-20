# Contributing

Issues and pull requests are welcome. For a larger change, open an issue first.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Develop

```sh
npm ci
npm run terminal   # the terminal app, from source
npm run dev        # the service in the foreground
```

[CONTEXT.md](CONTEXT.md) defines the project's terms. The [terminal guide](src/terminal/README.md) describes the screens.

## Before a pull request

```sh
npm run check
npm run format:check
npm test
```

- Tests run on `node:test` and don't need a Claude account. The terminal tests need Python 3; without it they're skipped.
- For terminal changes, run `npm run frames:check`. If a screen changes on purpose, run `npm run frames:update` and review the diff.
- Architecture and ratchet tests guard the code structure. A ratchet ceiling may only go down, so if one fails, make the change smaller.
- `npm run summarize` and `npm run verify` call the real Claude and use your Claude usage. They aren't part of `npm test`.

## Report a problem

Open an issue with:

- the steps to reproduce it,
- your OS and terminal,
- the output of `node --version`, `claude --version` and `izbor --version`.

Don't post `.izbor/`, session transcripts or send keys.

Contributions are accepted under the [MIT License](LICENSE).

# Contributing

Thank you for helping. Kodel is in beta, so the best contribution right now is a bug report from real
use. [AGENTS.md](AGENTS.md) has the layout, the principles and the rules for code; this page is the
short version.

## Reporting a problem

Open an [issue](https://github.com/kodelai/kodel-cli/issues/new/choose). Include the output of
`kodel --version`, the coding agent you use, your operating system and, if you can, what
`kodel status <run>` shows. For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Changing code

Please open an issue first for anything bigger than a small fix, so we can agree on the direction.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build && node scripts/check-artifact.mjs
```

These are the commands CI runs on Linux, macOS and Windows.

- Work on a branch and open a pull request. Nobody pushes to `main`.
- Sign off every commit with `git commit -s`. The project uses the
  [Developer Certificate of Origin](https://developercertificate.org); the sign-off says you have the
  right to submit the change under the Apache-2.0 license.
- Everything that is committed is in English: code, comments, documentation, commit messages and pull
  request descriptions.
- A new dependency needs a reason in the pull request, and its license must be compatible with
  Apache-2.0 (CI checks this).
- A change of behavior comes with a test.

The principles that every change must respect (agent input is untrusted, fail closed, redact on every
write, humans decide trust) are in [AGENTS.md](AGENTS.md).

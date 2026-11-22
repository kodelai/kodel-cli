# Session record fixtures

Golden files of the session record format (`v1`), taken from a real holder by `scripts/take-session-fixtures.mjs`
with ids, pids, paths, times and identity values masked. `status-lost.json` is the one synthetic file: it is the
tombstone a reader writes when no holder ever answered. Tests open every file, write it back as it was read and
check that a newer `v` is refused. Records are machine-local state, not history; see AGENTS.md.

`agent-chosen.json` and `agent-resumed.json` are `agent.json` of two sessions the script starts with an `agent` in
their spec (a fixed conversation id; the second continues the first). The process table must be readable where
the script runs: without it a holder records no process identity and the other goldens would differ.

The `*-pty.json` files are the records of a terminal session (`mode: pty`). Bun cannot host a PTY, so their holder is
the built artifact on Node: run `bun run build` first, outside a sandbox that has no terminal devices (the script
skips this part with a printed reason where it cannot open one). `status-running-pty.json` is the one record with
`sock`, masked like every path; `status-exited-pty.json` shows that the final record drops it;
`status-killed-pty.json` is a holder that could not start the program (`holder_error`, no child). A starter removes
such a session at once, so for this one file the script starts the holder itself on a published folder: the record
is the holder's own. `status-stopped-pty.json` is the final record of a terminal session that `stop` ended
(`killed`, `reason: stopped`, the child it had, no `sock`). Only records are read, never the terminal's output.

The script rewrites a golden only when its content changed, so taking the terminal part leaves the other files
byte for byte as they were (a test pins their hashes); run `bunx biome format --write fixtures/session-formats`
after a golden was written. `bun scripts/take-session-fixtures.mjs --check` writes nothing: it takes the records
again and fails when one differs from its golden. The CI `pty` job runs it; where no terminal exists a stale
`*-pty.json` is not detected.

# Session record fixtures

Golden files of the session record format (`v1`), taken from a real holder by `scripts/take-session-fixtures.mjs`
with ids, pids, paths, times and identity values masked. `status-lost.json` is the one synthetic file: it is the
tombstone a reader writes when no holder ever answered. Tests open every file, write it back as it was read and
check that a newer `v` is refused. Records are machine-local state, not history; see AGENTS.md.

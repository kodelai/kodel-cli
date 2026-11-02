# Session records

`kodel agent` runs long-lived processes ("agents") and keeps one folder per session under
`<state base>/run/<uid>/<checkout key>/<id>/`, outside the repository and independent of the `storage` key.
The state base is `KODEL_STATE_DIR` or `~/.kodel`. A session folder holds:

| File | Written by | When |
|------|------------|------|
| `session.json` | the starter | once, in a temporary folder that is renamed into place |
| `status.json` | the holder (or once, as a `lost` tombstone, by the first reader that finds no holder) | at start, when the child runs, at the end |
| `stop.json` | `agent stop` | before the child is signalled |
| `tail.txt`, `stdout.txt`, `stderr.txt` | the holder | redacted output tails (interleaved, and each stream alone), replaced while output arrives; `kodel agent logs <id> [--stdout\|--stderr]` prints them |
| `boot.txt` | the holder | the boot report: `ready` or `HOLDER_BOOT_FAILED:<why>` |
| `in.fifo` | the holder | only for a session started with `input` |

A **name marker** (`<checkout key>.names/<name>.json`) is written once by `start`. For a session a host started
(`origin: host`) it stays after `rm`: a name that was used and is gone answers `NAME_USED`, so a retried step never runs
its command a second time; only a person frees it (`kodel agent forget-name`). Only a session that says `origin: "cli"` (what `kodel agent exec` does)
frees its name with its folder; a starter that does not say keeps the name used.

Every record carries `v`. Version 1 is **not frozen yet**: until a person says so, no beta is cut from `main` and a
field may still change. A reader that meets a newer `v` answers `NEWER_FORMAT` ("upgrade kodel"). This family is not
history: `decode` ignores unknown optional fields of a known `v`, `encode` refuses anything outside the model.

The word "session" also names `sessions.jsonl` in a run's storage (the index of coding-agent hook sessions). That is a
different thing and is not touched here.

Golden fixtures: `fixtures/session-formats/v1/` (`scripts/take-session-fixtures.mjs`).

**Refutation.** The record format is wrong if a reader of the same `v` must change to read a record a later compatible build
writes, if a run in flight is refused, orphaned or changed by an update of kodel, or if `stop` ever signals a process
that is not the one the record names.

**Not built yet** (the first version of the family): the `parent` cascade, `lifetime: with-starter`, the PTY mode and
`attach`, the check of a record written by another build, and Windows.

**Limits worth knowing.** On macOS and without `/proc` a process identity is its start time at one-second resolution, so a
pid recycled within the same second compares as the same process; `stop` signals only a process whose recorded identity
matches, and refuses (`IDENTITY_UNKNOWN`) when none was recorded. The redacted tail is cut after redaction with a
margin of 1 KiB (as `runCommand` does), which is a heuristic: a secret split at the cut can leave a fragment no rule
matches. A session of another machine (a shared state folder) is listed but never judged, removed or signalled.

**A limit of the combined view.** `tail.txt` holds both streams in the order they came and is redacted as one text; a secret
that reaches one stream in pieces with the other stream writing in between can escape it there. `stdout.txt` and
`stderr.txt` hold each stream whole and are redacted whole.

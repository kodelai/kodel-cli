# TASK-KDJS M0 spike: note

Throwaway code (`spike.mjs`, `step.mjs`, `run.sh`, `pty.sh`). It is never copied into D-A and uses its own
`KODEL_SPIKE_DIR`. Run `sh run.sh` (pipes, Q3) and `sh pty.sh` (PTY over a unix socket; needs sockets and a PTY, so
not in the Claude sandbox). Judged by the person; each answer is yes, no or unknown.

| # | Question | Answer | Evidence |
|---|----------|--------|----------|
| 1 | `read`/`attach` on the same interface as `wait`/`stop` | **yes** | One holder owns the child. `wait`/`stop`/`tail` read `status.json` and signal the holder; `attach` is a socket to the same holder. No second owner mechanism was needed. |
| 2 | Three records and the `O_EXCL` handshake hold for a PTY holder | **yes**, with 1 added field | `session.json` (starter), `status.json` (holder, `wx` then rename), name claim by `mkdir`. The PTY holder needed only `sock` in `status.json`. The tombstone path (`wx` fails, `HOLDER_BOOT_FAILED:tombstone`) was coded but not forced. |
| 3 | WKJ4-shaped step on the real pipes adapter | **yes** | `step.mjs` (no pipeline imports): owner SIGKILLed after `start` (exit 137), the retry computed the same deterministic name, saw the live session, joined it, and got one result; the child ran once. A `lost` session gives "unknown, a person decides", never a rerun. |
| 4 | Attach protocol with a real agent (Claude Code in the Terminal app, ten minutes) | **unknown** | Not reachable from a background job. Scripted attach with `sh` over the PTY: input reached the child, output came back, the ring replayed the earlier output. Needs the person (blocks only M2). |
| 5 | Intermediate process, boot pipe, framed stdin | **yes**, with three findings | See below. |

Q5 findings, to write into the plan's boot rule:

1. The intermediate does not need to live until `ready`: it passes its stdin (fd 0) and the boot pipe (fd 3) to the holder
   and exits at once; the holder writes `ready` itself. This resolves the "exits at once" versus "reports ready"
   contradiction a critic found.
2. The starter **must destroy its end of the boot pipe** after reading `ready`, or the holder's copy keeps the starter's
   event loop alive and `kodel agent start` never returns.
3. For a PTY holder `ready` has to be written after the PTY owner is listening: here it came first and a fast attach got
   `ENOENT` on the socket. Also the macOS `sun_path` limit (104 bytes) is close with a deep `$TMPDIR` base.

Not answered (unknown): whether `claude "/kodel-run ..."` expands the skill as a positional prompt, and whether a `--bg`
session goes on when a background `kodel wait` reports. These need a real Claude Code and the person.

Limits of the spike: the PTY owner is `python3 -c pty.fork` (spike only; D-A uses `@lydell/node-pty`); no identity
check, no `lost` race test, no redaction, no Windows.

# Session records

`kodel agent` runs long-lived processes ("agents") and keeps one folder per session under
`<state base>/run/<uid>/<checkout key>/<id>/`, outside the repository and independent of the `storage` key.
The state base is `KODEL_STATE_DIR` or `~/.kodel`. A session folder holds:

| File | Written by | When |
|------|------------|------|
| `session.json` | the starter | once, in a temporary folder that is renamed into place |
| `agent.json` | the starter | once, before `session.json` in the same temporary folder; only for a session that runs a coding agent (see "The agent record" below) |
| `status.json` | the holder (or once, as a `lost` tombstone, by the first reader that finds no holder) | at start, when the child runs, at the end |
| `stop.json` | `agent stop` | before the child is signalled |
| `tail.txt`, `stdout.txt`, `stderr.txt` | the holder | redacted output tails (interleaved, and each stream alone), replaced while output arrives; `kodel agent logs <id> [--stdout\|--stderr]` prints them. A terminal session (`mode: pty`) has `tail.txt` only: a terminal has one stream, and `--stdout` and `--stderr` answer `UNSUPPORTED` |
| `boot.txt` | the holder | the boot report: `ready` or `HOLDER_BOOT_FAILED:<why>` |
| `in.fifo` | the holder | only for a session started with `input` |

A terminal session also has an **attach socket**, outside its folder (see "Terminal sessions" below).

A **name marker** (`<checkout key>.names/<name>.json`) is written once by `start`. For a session a host started
(`origin: host`) it stays after `rm`: a name that was used and is gone answers `NAME_USED`, so a retried step never runs
its command a second time; only a person frees it (`kodel agent forget-name`). Only a session that says `origin: "cli"` (what `kodel agent exec` does)
frees its name with its folder; a starter that does not say keeps the name used.

Every record carries `v`. Version 1 is **not frozen yet**: until a person says so, no beta is cut from `main` and a
field may still change. A reader that meets a newer `v` answers `NEWER_FORMAT` ("upgrade kodel"). This family is not
history: `decode` ignores unknown optional fields of a known `v`, `encode` refuses anything outside the model.

The word "session" also names `sessions.jsonl` in a run's storage (the index of coding-agent hook sessions). That is a
different thing and is not touched here.

**Engine steps** (`docs/engines.md`) start host sessions named `ke-<run id>-<visit id>-<attempt>` (`origin: "host"`,
`timeoutMs` always set). The host never removes them, so `ke-` records accumulate until a person runs `kodel agent rm`
(follow-up "Free finished `ke-` records"). The record format does not change.

Golden fixtures: `fixtures/session-formats/v1/` (`scripts/take-session-fixtures.mjs`).

## The agent record (`agent.json`)

A session that runs a coding agent says which one in a record of its own:
`{ v, engine, session?, source?, resumes? }`.

- `engine` is the name of the engine's profile (`claude`).
- `session` is the id of the agent's own conversation, and `source` says who named it: `chosen` (the starter chose
  it and gave it to the program) or `observed` (read from the engine's own files after the start; no build writes
  that yet, the schema holds it so that such an engine needs no change of the format).
- `resumes` is the id of the session whose conversation this one continues.

The starter writes it once, before `session.json`, and both appear with the folder in one rename, so no session
exists without the id of its conversation. Nothing rewrites it. It holds validated shapes only: never a prompt,
never an argv, and nothing the agent printed. The id says which conversation to continue, never whether anything
is done. `SessionSpec.agent` (`{ engine, session?, resumes? }`) is how a starter gives it; the stored `spec` of
`session.json` does not repeat it.

It is a file of its own, and not a field of `session.json`, because `session.json` is written once and an
engine's id may be known only later. `kodel agent ls` shows it in two columns beside `MODE` (`pipes` or `pty`):
`AGENT` is the engine (`claude`) and `CONVERSATION` the id of its conversation (`-` when there is none; an id
longer than a UUID is cut). The table is `ID NAME STATE MODE AGENT CONVERSATION`; the command a session runs is
not a column, `--json` has it whole, with `mode` and `agent`.

`kodel agent stop`, `rm` and `logs` take a name or an id, as `attach` does: of the sessions that used a name
the one that runs is meant, then the newest. `stop` and `rm` find the session before they ask, so an unknown
name fails at once (`NOT_FOUND: no agent "<name>"`) and the question names the session found (`Stop agent
<name> (<id>)?`).

**Builds of different age.** A build from before this record never reads the file: it derives the same status,
lists the session without an agent and removes the folder whole. A session with no `agent.json` is an older one
(or runs no agent) and is listed with `AGENT` empty. A record with a newer `v` makes the session `NEWER_FORMAT`
like any other file of the folder; one that cannot be read changes no status, and the session is listed without
an agent. No change of `v`.

**A worker of a run** (`kw-<run>`, `kw-<run>-d<seq>` for a resume after a decision) has the record whether it
runs in a terminal or as a print process. The launcher takes the id of the conversation to continue from it,
never from the screen or the tail. For a worker's record from before this file the id is read from the argv
the record keeps (the last `--session-id`, else the last `--resume`), which the launcher wrote; nothing is
written for such a record (fixture `worker-print-before-t47/`). A terminal record's argv is never read for an
id: its prompt comes last, and a prompt is a person's text.

### Continuing a finished agent: `kodel agent start --resume`

`kodel agent start --resume <name|id>` starts a new terminal session that continues the stored conversation
(`agent.json` of the new record has the same `session` and `resumes: <the old id>`) and **keeps the name**.
`kodel agent ls` prints, under the table, `<name> can be continued: kodel agent start --resume <name>` for a
session this holds for. It is refused, with the reason, for a session that runs, one whose process still runs
without a holder, one whose id is not known or whose record does not name `claude`, a `kw-` or `ke-`
session, a session a host started, and a session on pipes. The old record stays listed until `rm` or `prune`.

**The name marker moves.** A marker is written once by `start`; a resume is the one case where it changes
hands, and only from a finished session a person started (`origin: "cli"`) of the same name:

1. a claim `<name>.json.take` is made exclusively: of two resumes of one name, one gets it;
2. the new record is published (its folder renamed into place);
3. the claim is renamed over the marker: the name now points at the new record, in one rename;
4. if the start then fails, the old marker is written back by a rename.

A crash before step 3 leaves the name with the old record; a claim whose session never began within 15 s, or
is over, was left by a process that died and is taken away by the next resume. While a claim is in progress
`rm` and `prune` refuse the old record (`STILL_RUNNING`, "is being resumed"), so a failed resume has a session
to give the name back to; a plain `agent start --name` of that name answers `NAME_TAKEN` at every point. A
host session's marker is never moved, and the marker of a session whose process still runs is not either.
`rm` of the old record afterwards keeps the name with the new one.

### `kodel agent prune`

Removes finished records, after one question that names the count (`--dry-run` removes nothing,
`--older-than <days>` keeps younger ones). It never removes a record that runs or whose process still runs,
one that cannot be read, is of another machine or of a newer format, or a `kw-` or `ke-` record whose run is
open or cannot be read. Each record is read again, by its id, right before its removal, and `remove` itself
refuses a live one. A person's name is freed with its record; a host session's marker stays. When a record
that goes holds a conversation `kodel agent start --resume` could still continue, a line before the question
names it and the question counts it: the conversation cannot be continued through kodel once its record is
removed.

## A holder that went away: "child still runs"

A session whose holder is gone is `lost` (or `killed`, when a stop record is there), and `childAlive` ("child
still runs" in `kodel agent ls`) says that its process is not: a consumer must not take it for finished, and
`agent rm` refuses it (`STILL_RUNNING`). "Still runs" is the process the holder started, told by its recorded
identity, **or a process left in that child's process group**: an agent behind a wrapper that died is seen.

The group is looked at only for a record whose holder went away without recording its child's end. A holder that
recorded the end (an exit, a stop, its own timeout) answers for its child, and what the child left behind is not
looked at. A member of the group counts only when all of this holds:

- the process table was read (`ps -A -o pid=,pgid=,stat=,lstart=`, once for a listing, and only when the listing
  holds such a record);
- the machine was not restarted after the session began (Linux `/proc/stat` `btime`, macOS `sysctl
  kern.boottime`): after a restart every number is given out anew;
- no live process that is not the recorded child has the group's number as its pid: the kernel gives a group's
  number to a new process only once the group is empty, so with such a process every member is a stranger's.

Where the table or the boot time cannot be read (a sandbox), or the process that has the group's number as
its pid cannot be told from the recorded child (its start time cannot be read now), the group is not looked at and the recorded child
alone decides, as before this rule: nothing is held for good, and the stated limit is that an agent behind a dead
wrapper is not seen there. The status then carries `group: "unread"`; `group: "stranger"` says that the number
changed hands.

`kodel agent stop <id>` ends such a group: it writes the stop record, then signals each member by its pid
(`SIGTERM`, the grace, `SIGKILL`), after reading the member's start time again, so a pid that changed hands since
the listing is not signalled. It never signals the group as a whole for this case, and never a group that is
unread or a stranger's (the command says which). After it the session is `stopped` with no process left, and
`agent rm` removes it.

**Limits.** A zombie is not a process that runs. A process that left the group (its own `setsid`, as the shell
commands of Claude Code do) is not a member: it is neither seen nor ended this way; `stop` of a session whose
recorded child lives reaches the child's descendants as before. On macOS the boot time moves with the wall
clock, so a clock set forward by more than the time between the boot and the session's start reads as a restart.

**Refutation.** The record format is wrong if a reader of the same `v` must change to read a record a later compatible build
writes, if a run in flight is refused, orphaned or changed by an update of kodel, or if `stop` ever signals a process
that is not the one the record names.

**Not built yet** (the first version of the family): the `parent` cascade, `lifetime: with-starter`, the check of a
record written by another build, and Windows.

**Limits worth knowing.** On macOS and without `/proc` a process identity is its start time at one-second resolution, so a
pid recycled within the same second compares as the same process; `stop` signals only a process whose recorded identity
matches, and refuses (`IDENTITY_UNKNOWN`) when none was recorded. The redacted tail is cut after redaction with a
margin of 1 KiB (as `runCommand` does), which is a heuristic: a secret split at the cut can leave a fragment no rule
matches. A session of another machine (a shared state folder) is listed but never judged, removed or signalled.

**A limit of the combined view.** `tail.txt` holds both streams in the order they came and is redacted as one text; a secret
that reaches one stream in pieces with the other stream writing in between can escape it there. `stdout.txt` and
`stderr.txt` hold each stream whole and are redacted whole.

## Terminal sessions (`mode: pty`)

`kodel agent start [prompt]` (for a person) runs the coding agent of the `claude` profile in a terminal of its
own, in the project root, and attaches unless `--bg`; it prints the argv and what a start nobody watches may
meet. With `--pipeline <name>` the prompt is the task of a new run and the session is that run's worker
(`kw-<run>`), started by the same launcher as `s` in the TUI (`docs/serve.md`). `kodel agent exec --pty --attach
-- <command>` starts any command and attaches at once.

`kodel agent exec --pty -- <command>` (hidden, for a person) runs the command in a terminal of its own, and
`kodel agent attach <name|id>` (for a person; it asks for no confirmation) connects the person's terminal to it:
first the terminal modes the program has on, then the earlier output (up to 1 MiB, with terminal queries cut
out), then the live terminal. `Ctrl+\` detaches and leaves the agent running; on every way out the client resets
the terminal and prints `[detached: <name>]`, `[ended: <name>, exit <code>]` or `[killed: <name>]`. Several clients
may be attached (8 at most); the size of the one that resized last wins.

`kodel agent attach <name|id> --keep-screen` (not in the help: it is what `o` in `kodel tui` runs) is the same
client on a terminal that is on its starter's alternate screen and stays there: it clears the screen once,
for the session's first output, takes the switches of the screen (modes 1049, 1047, 47) out of the session's
output (a switch on becomes "save the cursor, clear", a switch off "clear, restore the cursor"), resets the
other modes on every way out, never leaves the screen and prints no line, because the starter draws over it.

The terminal is made by `@lydell/node-pty`, an optional dependency of the CLI that only the holder loads. Where it
cannot be used, `exec --pty` answers `UNSUPPORTED` with the reason before anything is written: the package was not
installed (`--omit=optional`), the platform has no binary package (a Linux without glibc such as Alpine/musl), its
`spawn-helper` is not executable, or kodel runs from source under Bun (use the built `packages/cli/dist/kodel.js`
on Node). On Windows every `kodel agent` command answers `PLATFORM_UNSUPPORTED`, this one too, before the module is
looked at. Sessions on pipes need none of it.

**`sock`.** `status.json` of a terminal session that runs has one more field, `sock`: the path of the attach socket.
It is optional and added without a change of `v`: a reader that ignores it derives the same status. Its lifetime:

- The holder creates `status.json` (`starting`) first, then binds and listens, starts the program, and only then
  writes `sock` with the `running` record and reports `ready`: an attach right after the start finds the socket.
- The final record has no `sock`, and the holder removes the socket file on every way out it can take.
- A holder that is told to end (`SIGTERM`, `SIGHUP`) stops the program as `stop` does and ends the same way: the
  clients are told, the socket is removed, the final record says `killed` with the reason `stopped`.
- A holder that was killed (`SIGKILL`) leaves the record with `sock` and the file. So `sock` never means "somebody
  listens": `attach` asks the status first, and anything but a live `running` session, a missing file or a refused
  connect is `NOT_ATTACHABLE` with the reason. `agent rm`, `agent stop` (when it finds the holder gone) and a failed
  start remove the socket paths derived from the checkout and the id, and the stored one when it is one of them.
  A path in a record that is not this session's is never connected to and never removed.

**The socket's name and place.** A session id is unique only inside one checkout, while the folders a socket may
sit in are per user, so the name carries the checkout: `<state base>/run/<uid>/<id>-<k>.sock`, where `<k>` is the
first 8 hex characters of a hash of the checkout key. A socket path is limited to about 100 bytes; when that one is
longer the holder falls back to `<h>.sock` (16 hex characters of a hash of checkout key and id) in
`$TMPDIR/kodel-<uid>/`, then in `/tmp/kodel-<uid>/`. The folder must be a real directory of the user with mode 0700
and the socket has mode 0600; the holder checks that before it binds and the client before it connects, so a
`kodel-<uid>` folder made by somebody else refuses on both sides. Whether a path is this session's is decided
without `$TMPDIR`, so a holder and a client with different ones agree.

**Builds of different age.** A build from before this field drops `sock` when it reads a record: its `rm` and `stop`
remove no socket and it cannot attach; nothing else differs.

**Limits worth knowing (terminal sessions).**

- **The socket is not a security boundary.** Any process of the same user can connect, read the terminal and type
  into it, for example approve the agent's own tool prompts. `agent attach` refuses under `KODEL_ENGINE` and without
  a terminal, which guards against mistakes only: a program that unsets the variable passes, and the socket's path is
  in `status.json`. There is no attach key.
- **A decision dialog inside a terminal session is not protected.** With `decisions.dialog: true`, a kodel MCP
  server that runs inside the session may show a gate, a pause or a pipeline change as a dialog, and whoever can
  type into the session, through the socket too, can answer it; the journal records the person's decision
  (`docs/decisions.md`).
- **On Linux the end of a burst of output can be lost.** When the program that leads the session ends, the kernel
  hangs up its terminal and throws away what was written to it and nobody has read yet. A holder that is a few
  kilobytes behind at that moment (a loaded machine, megabytes written at once, then an exit) misses the end of the
  output, in the ring, in `tail.txt` and for every client. A program that writes less, or that does not leave at the
  moment it stops writing, is not touched. macOS keeps the data.
- **The replay is not redacted.** The holder keeps the last 1 MiB of raw terminal bytes in memory and gives them to
  every client that connects. Only `tail.txt` is on disk: stripped of escape sequences, then redacted.
- **The tail of a full-screen program is repaint fragments** (cursor moves between the pieces of a word), so a
  secret such a program draws may never be one string in `tail.txt`, and redaction finds less there than in the
  output of a program that writes lines. A secret printed as a line is caught
  (`tA_terminal_tail_redacts_a_printed_secret`); one painted in pieces stays in the bounded tail until newer
  output replaces it or `agent rm` or `prune` removes the record
  (`tA_terminal_tail_painted_secret_is_the_known_limit` pins the limit, so a change of it is seen). Since a
  background agent of a run is a terminal session by default (`docs/serve.md`), this limit holds for every
  such worker; there is no retention rule beyond the tail's size. What the TUI's card shows of a tail is
  stripped and redacted again.
- **A session's own timeout signals its child only.** A worker's terminal session lives 7 days at most; when
  the holder ends it by that timeout, a process the agent left in another process group (a background `kodel
  wait`, say) lives on to its own end (the wait command is given the same 7 days). `agent stop`, and the stop
  at the end of a run, reach the child's descendants and its group.
- **After more than 1 MiB of output** the replay starts in the middle. The client is first given the modes the
  program had switched on by then (mouse, focus events, bracketed paste, the kitty keyboard, application keys, the
  alternate screen, the hidden cursor), not colours, the cursor's place, the scroll region or the screen's content:
  the picture is whole again when the program repaints, which the resize of an attach usually causes. A mode outside
  that list is not followed, and an OSC sequence cut by the start of the replay is shown as text.
- **Two clients answer a query twice.** A terminal query in the live output is answered by every attached terminal.
- **`Ctrl+\` is the client's.** It detaches (as the raw byte, the kitty form and xterm's modifyOtherKeys form) and
  cannot be typed into the agent from an attached terminal; inside a bracketed paste it is passed on. Every other
  key, `Ctrl+C` and `Ctrl+]` too, reaches the agent.
- **`send` and a person share one input.** `send`'s Enter may submit what the person has half typed.
- **`TERM`.** The program gets the starter's `TERM` and `COLORTERM` (`xterm-256color` when `TERM` is unset or
  `dumb`) and no `LINES` or `COLUMNS`; the terminal that attaches later may be another one.
- **Memory.** A session holds the 1 MiB replay, and each of at most 8 clients may lag 4 MiB before it is dropped
  (it may attach again): about 33 MiB at worst. Typed input the program has not taken is held to 64 KiB per client
  (the client is not read meanwhile), and text of `send` counts against the same bound. A client that goes away
  while it is paused is noticed within about 5 seconds (the holder writes it an empty frame) and its place is
  free again.
- **`send` to a program that reads nothing.** There is no `send` command: `SessionAdapter.send` is what an engine
  step uses to type into its agent. It is answered when the terminal has taken the text, so once the terminal's
  own small buffer is full it gives up after 10 seconds with `NOT_RUNNING` ("did not answer the send"), though
  the session is still running. The text of a send whose caller gave up stays queued in the holder and is typed
  when the program reads again, so a caller that sends again after that error has its text typed twice.
- **A client that is killed (`SIGKILL`) or stopped from outside (`SIGSTOP`, or a `SIGTSTP` another process
  sends)** leaves its terminal raw with the program's modes on; `reset` cleans it, and a stopped client goes on
  when it is continued (`fg`). The client does not handle `SIGTSTP`: `Ctrl+Z` typed while attached is a byte for
  the agent (the terminal is raw), so only a signal from outside stops it. On every other way out, also `SIGTERM`,
  `SIGHUP`, `SIGINT`, `SIGQUIT`, a lost connection and the end of its input, the client restores it and prints
  `[detached: <name>]`. (`Ctrl+C` and `Ctrl+\` typed while attached are not those signals either: the first goes
  to the agent and the second detaches.)
- **The holder waits for its clients at the end,** up to 1.5 s, so that a client that reads slowly still gets the
  last output and the line of the end; the final record is written after that wait. A client that does not read
  at all loses them after a second.
- **A cleaner of temporary files** (macOS, `systemd-tmpfiles`) may remove the fallback socket of a live session.
  The holder does not bind again: the session is `NOT_ATTACHABLE` until it ends, while `stop`, `logs` and `wait`
  keep working. A holder killed before it wrote `running`, whose socket fell back under a `TMPDIR` the later `rm`
  does not have, leaves that file (a dead socket in a 0700 folder of the user).
- **A command that cannot be executed.** The holder looks the program up before it starts the terminal, and a miss
  fails the start and frees the name, as on pipes. What the lookup cannot see (a bad interpreter line, a file
  removed in between) ends as `exited` with a non-zero code, and the name stays used until `rm`.

**Tests on a real terminal** are in `tests/pty/` and run against the built artifact on Node. Where no terminal can
be opened they are skipped with a printed, counted reason; `KODEL_REQUIRE_PTY=1` (the CI `pty` job, on Linux and
macOS) makes a skip, and a build older than the sources, a failure.

# PTY holder and attach for sessions: `kodel agent attach` (TASK-HN8N, D-A / M2 of TASK-KDJS)

## TL;DR

- **What:** the session holder learns `mode: pty` (through `@lydell/node-pty`, an optional dependency of
  `packages/cli`), serves an attach socket, and `kodel agent attach <name|id>` (human-only) connects a terminal to it:
  resize, detach on `Ctrl+\`, terminal reset, 1 MiB replay with a mode prefix, several clients. `send` works for a
  PTY session. Pipes mode is untouched and works without the dependency.
- **Cost:** large. About 5 days of packaging (the time box) plus about 6.5 days for the rest (round 2 added about
  a day of tests and socket rules). One native dependency, one CI job, one optional field in the unfrozen session
  format v1.
- **Risky:** (1) packaging of a native module; (2) the real-PTY tests are skipped where this change is developed
  (Bun cannot host a PTY, the agent sandbox denies PTY devices), so only the new CI job proves about 30 of them;
  (3) **accepted, not covered (the person dropped D-B):** with `decisions.dialog: true` an agent inside a PTY
  session can answer its own gate, by `env -u KODEL_ENGINE kodel agent attach <its own session>` or by writing
  frames to the socket, whose path any process of the same user reads from `status.json`; the journal then records
  it as the person's decision.
- **The person's answers stand** (decisions 1-7: no D-B, no `claude --bg` probe, `sock` in `status.json`, the mode
  tracker in, `Ctrl+\` only, the `tA_` prefix, one task with a stop after packaging).
- **What this critique round (round 2, no blocker) changed:**
  - The socket name now carries the checkout (ids are unique per checkout, sockets are per user), the sweep and the
    client check no longer depend on `$TMPDIR`, and the socket is unlinked on every way out of the holder.
  - A missing command fails the boot as in pipes mode (probe before the spawn); the starter probes the PTY module,
    the holder re-checks.
  - About 35 named tests added or split (see "Round 2 tests"); `docs/decisions.md` and `docs/engines.md` are
    corrected, because both would say something untrue.
- **Before any code:** two small questions below (8, 9), both with a default that needs no action.

## Decisions needed

**Two are open (8 and 9); each has a default that is taken if the person says nothing.** 1-7 are answered and
are not reopened.

8. **A one-line stopgap for the dialog route?** The kodel MCP server sees `KODEL_ENGINE=1` inside every session and
   could refuse `dialog` when it is set (`mcp-server.ts:92`). It is not D-B, but it is code on the ground the person
   answered "we do not do D-B", and a program that unsets the variable walks around it.
   **A (recommended, default): not now**; the route is written as the accepted state. B: add the check and one test.
9. **Change `dev.yaml` so that the run itself proves the real tests?** `dev.yaml` runs `bun test` (`:240`) before
   the build (`:246`), and the agent sandbox denies `/dev/tty[p-w]*`, so the real-PTY tests are skipped in the run's
   own checks. The pipeline file is the person's. **A (recommended, default): no pipeline change**; the PR
   description lists the skipped tests by name and count, and the CI job (`KODEL_REQUIRE_PTY=1`) is the proof the
   final gate cites. B: a proposal that builds before the tests (it still skips in a sandbox without PTY devices).

Answered:

1. **`claude --bg` probe: not run.** The PTY holder is built as the one mechanism for every agent.
2. **D-B: not done.** Nothing of D-B is built, guarded or waited for; what stays open is in "Risks", principle 6.
3. **Where the socket path lives: A.** Optional `sock` in `status.json`, written by the holder with the `running`
   record after it listens; a compatible addition without a bump of `v`. It is only a hint of where to connect (see
   "`sock` lifetime"). No other stored field is added: the initial size is cut from the spec before `session.json`
   is written, as `env` is; the paste mode and the tracked modes stay in the holder's memory. The person still says
   when v1 is frozen; this task does not freeze it.
4. **Mode tracking: B, in this task.** A pure tracker in core for exactly the modes of the reset list, sent before
   the ring on connect. No answers to terminal queries while nobody is attached.
5. **The decision id for test names: left to me.** The placeholder prefix `tA_` lives in one constant of the session
   tests. **Rename before merge:** the person is asked for D-A's id at the packaging stop (step 1); the rename is
   that constant plus the names `session_test_names_carry_the_decision_id` lists.
6. **The detach chord: B, `Ctrl+\` only**, in its three encodings (raw `0x1c`, kitty `ESC [ 92 ; 5 u`, xterm
   modifyOtherKeys `ESC [ 27 ; 5 ; 92 ~`). `Ctrl+]` is ordinary input.
7. **One task or three: A, one task.** Step 1 (packaging) ends with a stop for the person; day 5 is the stop
   criterion. `send` for a PTY session stays in scope unless the person moves it out at the gate.

## Behaviour change

- `kodel agent exec --pty -- <command>` (hidden, human-only) starts the command in a terminal of its own instead of
  answering `UNSUPPORTED`. Where the PTY module is absent or unusable (not installed, an unsupported platform such
  as Alpine/musl if no package exists for it, a `spawn-helper` that is not executable, a run from source without a
  build, a holder that would run under Bun) it answers `UNSUPPORTED` with a hint that names the reason; pipes mode
  works as before. It does not look at `decisions.dialog` (decision 2). A command that does not exist fails the
  start as in pipes mode (`HOLDER_BOOT_FAILED`, the name is free again): the holder looks the executable up before
  the spawn. A `command` string runs through `/bin/sh -c`, as pipes mode runs it through a shell.
- New: `kodel agent attach <name|id>` (human-only: refuses under `KODEL_ENGINE` and without a terminal; it asks for
  no confirmation). It first sets the terminal modes the program has on, then shows the earlier output (up to
  1 MiB, terminal queries removed), then the live terminal. `Ctrl+\` detaches and leaves the agent running. It is
  the only key the client keeps for itself: `Ctrl+]` and every other key reach the agent, and `Ctrl+\` (SIGQUIT)
  cannot be typed into the agent from an attached terminal (decision 6). On detach, on the agent's own exit and on
  a kill it restores the terminal and prints `[detached: <name>]`, `[ended: <name>, exit <code>]` or
  `[killed: <name>]`. A second `attach` joins; nobody is kicked; the size of the client that resized last wins; at
  most 8 clients, a ninth gets `BYE` with the reason.
- `kodel agent ls` and `logs` work for a PTY session. `logs` prints the redacted tail with escape sequences removed;
  `--stdout` and `--stderr` answer `UNSUPPORTED` for it (a terminal has one stream).
- `send` (the adapter method; no command) writes into a PTY session: a bracketed paste only while the program has DEC
  2004 on, then Enter as its own write. It is in scope because the spike's note lists it as a checked use
  (`spikes/kdjs-m0/NOTE.md`, finding 8) and `send?`, `planSend` and `SEND_PASTE_GAP_MS` are already in core; the task
  record itself could not be read (see "Findings in the code"), so the person may move it out at the gate.
- The child of a PTY session gets `TERM=xterm-256color` when the starter's `TERM` is unset or `dumb`, and no `LINES`
  or `COLUMNS`.
- Windows: unchanged (`PLATFORM_UNSUPPORTED` before everything).
- Nothing changes for runs, pipelines, MCP tools, `CONTRACT_VERSION`, the TUI or the `claude -p` workers. No user
  flow starts a PTY session yet: only the hidden `agent exec --pty`.

## Risks and invariants

- **Principle 1, 2 (untrusted input, fail closed).** The socket speaks length-prefixed frames; an unknown type, an
  oversize length or another protocol version closes that client with `BYE` and touches nothing else. So does a
  client that sends no `HELLO` within 5 s, a frame before `HELLO`, or a frame only the holder may send. A client's
  socket error (reset, `EPIPE`) removes that client and never ends the holder. Input is not buffered without bound:
  a client that floods is paused (socket backpressure) while the PTY write drains. A PTY module that fails to load,
  or a socket that cannot be bound, ends the session `killed/holder_error` **before a child exists** (no child pid in
  any record, no `ready`). `ready` is written only after the socket listens and the child runs. A socket path is
  never built from an id that does not match `LOCAL_SESSION_ID_PATTERN`.
- **`sock` lifetime (decision 3).** Rules, each with a test:
  - **Order.** The holder creates `status.json` (`starting`) exclusively first (`session-holder.ts:180`) and only
    then binds: a holder that lost to a tombstone never made a socket. It writes `sock` only in the `running`
    record. The final record is built without it (today it is `{...running, ...}`, `session-holder.ts:343`, which
    would keep it).
  - **Every way out unlinks.** After the bind the holder leaves through one function that sends `BYE`, closes the
    server and unlinks the socket. It covers each exit the code has today: `failBoot` (the spawn failed, `:184`,
    `:292`), the tombstone found after the spawn (`killNow` and `HOLDER_BOOT_FAILED:tombstone`, `:303`), the
    `replaceRecord` catch (`:310`), the watcher's "directory removed under a live child" (`:326`) and the normal
    end. One test per exit.
  - **Ways out the holder cannot take.** A holder SIGKILLed after `running` leaves a record with `sock` and a
    socket file; SIGKILLed between `listen` and the `running` write it leaves `starting` with no `sock`; the
    starter's `rollback()` (`session-pipes.ts:190`) removes the folder and leaves no record at all. So the sweep
    never needs the record: `remove`, `stop` (when it finds the holder gone) and `rollback()` of a `mode: pty`
    session unlink the paths **derived** from the checkout key and the id (see "`sun_path`"), and the stored
    `sock` as well when it passes the same check.
  - `sock` alone never means "listening": `attach` and `attachable` first ask `deriveStatus`, and anything but a
    live `running` is `NOT_ATTACHABLE` without a connect; a connect that fails with `ECONNREFUSED` or `ENOENT` is
    `NOT_ATTACHABLE` too (the holder died in between), never a raw error.
  - **What may be unlinked, and connected to, is decided without `$TMPDIR`.** A path qualifies when its file name
    is the one derived for this checkout key and id, its directory is the run folder or a directory named
    `kodel-<uid>` that is real, ours and 0700, and the file is a socket of ours. The check never compares against
    "the candidates under today's `$TMPDIR`", so a holder and a client or `rm` with different `TMPDIR` agree. A
    path from a record that does not qualify is never unlinked and never connected to.
  - Before it unlinks a leftover (at bind and in the sweep) the code connects to it: `ECONNREFUSED` means stale
    and it is removed; an accepted connection means somebody listens: the holder ends `holder_error` with no
    child, the sweep leaves the file. A non-socket there, or `EADDRINUSE` after that, is `holder_error` too.
  - `rm` already refuses a session that runs (`STILL_RUNNING`, `session-pipes.ts:580`), and the holder sends `BYE` to
    every client before it writes the final record, so `rm` never meets an attached client. `forget-name` touches
    only the name marker; an attached client is not affected and keeps the name it printed.
  - **Limits, written in `docs/session-formats.md`:** a holder SIGKILLed before `running` whose socket fell back
    under a `TMPDIR` the later `rm` does not have leaves that file (a dead socket in a 0700 folder of ours); a
    cleaner of temporary files (macOS, `systemd-tmpfiles`) may remove the fallback socket of a **live** session,
    which is then `NOT_ATTACHABLE` with that reason until it ends (the holder does not bind again), while `stop`,
    `logs` and `wait` keep working.
  - **Builds of different age.** An older build's `decode` drops `sock`, so its `rm` and `stop` sweep nothing and
    it cannot attach; nothing else differs (compatible by rule 5). Only the holder rewrites a `running` record, so
    a live session does not lose the field; if it did, the session is `NOT_ATTACHABLE` ("the record names no
    socket") and otherwise whole, which is accepted. One line in `docs/session-formats.md`.
- **Trust of the socket, on both sides.** The holder creates it 0600 in a directory that is real, ours and 0700. The
  **client** checks the same before it connects: the directory (no symlink, owner is the uid, mode 0700) and the
  socket (`lstat`: a socket, owner is the uid, mode 0600). `/tmp/kodel-<uid>` created first by another user fails
  closed on both sides (`NOT_ATTACHABLE` with the reason for the client). The holder never calls `umask`: the
  socket is bound inside the 0700 directory and then `chmod` 0600, so nothing leaks into the child (its umask is
  the starter's; tested).
- **Before the child exists.** The server listens before the spawn and the path can be guessed, so a client may
  arrive in that window: `HELLO` is answered, `RESIZE` is kept as the size to spawn with (the last one wins),
  `INPUT` is dropped, not buffered. The hostile-client tests run in this window too.
- **Principle 3 (redaction).** What is written to disk (`tail.txt`) is stripped of escape sequences, then redacted,
  as today; the redaction window covers a secret split over two chunks and the echo of typed text. `stdout.txt`
  and `stderr.txt` are not written for a PTY session. A test greps the session folder for raw bytes.
  Strip-then-redact is one pure function with a unit test of its own (it runs everywhere; the real tests do not).
  **Limit, written down:** the tail of a full-screen program is repaint fragments (cursor moves between the pieces
  of a word), so a secret a real Claude Code draws may never be one string in `tail.txt`, and its redaction is
  weaker than the echo test suggests. **Accepted
  limit, written in `docs/session-formats.md`:** the ring holds unredacted terminal bytes in the holder's memory and
  gives them to every client that connects, and a client is any process of the same user.
- **Replay and terminal queries.** A replay that contains the child's earlier queries (DA1/DA2, `CSI 5n`/`6n`, OSC
  4/10/11/12 with `?`, the kitty keyboard query, DECRQM, XTVERSION) would make the attaching terminal answer, and the
  client would type the answers into the agent's prompt. A pure filter in core cuts them out of the replay (not out
  of the live stream), and the mode prefix never contains one. Dropping the client's input "until the replay is drawn" was considered and not chosen: the
  answers come later than the bytes, so it races. For the same reason the client, on detach and on every exit,
  writes the reset, then reads and discards its stdin for a short bounded time (on the injected clock) before it
  restores the terminal settings, so a late answer of the terminal does not land in the shell. The chord matcher
  does not match between `ESC[200~` and `ESC[201~`: a `0x1c` inside a paste goes to the child.
  **Limit, written down:** with two clients attached a live query
  is answered twice.
- **Mode tracker (decision 4).** A pure function in core follows exactly the modes the reset string switches off
  (mouse, focus events, bracketed paste, kitty keyboard, application keys, the alternate screen), with a carry for
  a switch split over two chunks. The holder feeds it the bytes **as they fall out of the ring**, so it holds the
  state at the ring's oldest byte; on connect the client gets the prefix that sets that state, then the ring.
  Prefix plus ring is then the whole history in order, and nothing is set twice (a kitty keyboard push is not
  doubled). Before the ring wraps the prefix is empty. The state lives in the holder's memory and is never stored.
  **Limits, written down:** the tracker carries modes only, not colours, the cursor, the scroll region or the
  screen's content, so after a wrap the picture is whole only when the program repaints (the `RESIZE` of the
  attach usually makes it); a mode outside the reset list is not followed. `send` keeps its own DEC 2004 flag
  (`trackBracketedPaste`, with the same carry): it needs the current state, the tracker holds the oldest. If the
  task has to shrink, the tracker is the piece that splits off most easily (nothing stored, no protocol change).
- **Principle 4 (pipeline-core has no I/O).** Core gains only pure code: the frame codec, the chord matcher, the
  reset string, the query filter, the mode tracker, the socket path candidates (strings in, strings out), the `sock`
  field of the codec and an `AttachStream` type over `Uint8Array`. The socket, the PTY and the terminal are in
  `packages/local` and `packages/cli`.
- **Principle 5 (side effects behind traits).** The PTY is a trait (`spawn`, `write`, `resize`, `onData`, `onExit`,
  `kill`, `pid`). `packages/local` imports no PTY module; the CLI's holder entry loads `@lydell/node-pty` and injects
  it. The attach server takes an `AttachStream`, so it is tested with a fake PTY over an in-memory pair, without a
  socket. The gap between the paste and Enter of `send` waits on the injected clock, not on a bare timer. The
  module reports a signal as a number: the trait maps it to its name, so a signalled child is `killed`, never
  `exited 0` (a unit test over a fake PTY).
- **A command that cannot be executed.** In pipes mode a missing executable is a spawn error and `failBoot` frees
  the name (`session-holder.ts:292`). A PTY module forks first, so a failed `exec` most likely shows up as a child
  that exits non-zero: the session would be `exited 1` and the name would stay used. **Unverified** (this worktree
  has no `node_modules` to read `@lydell/node-pty` in); the day-1 probe of step 1 records what the module does.
  Whatever it does, the holder looks `argv[0]` up itself before the spawn (in the child's `PATH`, executable), and
  a miss is `failBoot` as in pipes. What the lookup cannot see (a bad interpreter line, a file removed in between)
  ends as `exited` with the module's code, and the name stays used until `rm`; the docs say so. A `command` string
  is spawned as `/bin/sh -c <command>`; the shell reports a missing program itself (127), as in pipes mode.
- **`KODEL_ENGINE=1` twice.** `sessionEnv` forces it, and the holder's PTY branch forces it again on the
  environment it hands to the spawn, so an input file without it cannot start an unmarked child; a holder test
  checks the environment of the spawn, not only `sessionEnv`.
- **Principle 6 (humans decide).** No MCP tool is added. `agent attach` joins `AGENT_HUMAN_COMMANDS` and the "Do not
  run" list of AGENTS.md, and calls `requireHuman()` after the platform check. **This is a guard against mistakes,
  not a security boundary:** `requireHuman` checks only that `KODEL_ENGINE` is unset and that stdin and stdout are
  terminals (`cli.ts:340`, `main.ts:61`). Every descendant of a PTY child has `/dev/tty`, so inside the session only
  `KODEL_ENGINE=1` refuses (kept by `sessionEnv` whatever other `KODEL_*` the shell has; a program that unsets it
  passes), and the socket lets any process of the same user type, for example approve the agent's own tool prompts.
  There is no attach key. Both limits are accepted by name in TASK-KDJS decision 5. **A decision dialog inside a
  PTY session is not protected by this task. The exact route:** an agent that runs in a PTY session of a project
  with `decisions.dialog: true` reaches a gate; its kodel MCP server shows the dialog in that session; the agent
  (or any process of the same user) runs `env -u KODEL_ENGINE kodel agent attach <that session>`, or reads `sock`
  from `status.json` and writes `HELLO` and `INPUT` frames itself, and types the answer. The journal records it as
  the person's decision, with no `decided_by: agent` mark: contrary to principle 6 and to `docs/decisions.md:60`.
  Nothing in this task stops it or marks it. In general: with `decisions.dialog: true`, a kodel MCP server that runs inside
  the session may show a gate, a pause or a pipeline change as a dialog, and whoever can type into the session,
  through the socket too, can answer it. Closing that is D-B, which is out of scope by the person's answer
  (decision 2): nothing here builds it, tests it or promises it, and `agent exec --pty` does not refuse or warn.
  This is the person's accepted state, not a covered risk. The docs say it where a reader looks for it:
  `docs/session-formats.md`, `docs/decisions.md` and `docs/engines.md` (step 6). A one-line stopgap is decision 8
  (default: not built).
- **Principle 7.** Not touched (no node or check kind).
- **Principle 8 and "Stored data and compatibility".** Run formats, the journal and `state.json` are not touched;
  T-41 does not apply. The session family (machine-local, v1, unfrozen, unreleased) gets one optional field, `sock`
  in `status.json` (decision 3). By rule 5 it ships in the same change: `decode` and `encode` (the strict schema),
  `SESSION_RECORD_CAPABILITIES` (v1 already says `pty: true`), golden fixtures taken from a real PTY holder, the
  round-trip test and `docs/session-formats.md`. **`size` is not stored:** `start()` spreads the spec into the
  record and the stored spec schema is strict (`session-pipes.ts:196-208`, `records.ts:31-47`), so `size` is cut out
  with `env` before the record is built; left in, it would be `STATE_UNWRITABLE` or a field nobody declared. The
  record's `mode` is hard-coded `"pipes"` there (`session-pipes.ts:199`) and must follow `spec.mode`. No `decode` is
  removed. `v` is not bumped, and the plan does not declare the format frozen.
- **Interfaces.** `attach` and `attachable` are optional on `SessionAdapter`, as `send` is (`session.ts:294`), so the
  testkit fake, the host and a server adapter compile unchanged. `capabilities()` is about the adapter, not a
  session, and `streams: true` stays true because its pipes sessions have streams; a PTY session answers
  `UNSUPPORTED` to `tail(..., "stdout")`. The doc comment says so.
- **Which process knows that a PTY works.** The adapter runs in the starter; the module loads in the holder,
  another process. The CLI gives the adapter a synchronous **probe** (the resolution the loader uses: the platform
  package is found, `spawn-helper` is executable, the launcher is Node, not Bun; it does not load the module).
  `capabilities()` says `pty: true, attach: true` only when a probe is given and passes, and `start` with
  `mode: pty` answers `UNSUPPORTED` with the probe's reason before anything is written. The holder checks again
  when it loads; a failure there (a package removed in between, a load error the probe cannot see) is
  `HOLDER_BOOT_FAILED` with the reason in its text and a `killed/holder_error` record, no child. So `UNSUPPORTED`
  is promised for what the probe sees, not for every failure.
- **Session errors** stay `SessionError`, outside the MCP contract; `NOT_ATTACHABLE` is added to
  `SESSION_ERROR_CODES` (the test that pins the list is updated; `errors.test.ts` and the tools fingerprint are not).
- **One owner.** The holder that owns the child owns the socket. `stop`, `wait`, the timeout and `rm` work as for
  pipes. A dead holder closes the PTY master and the child gets SIGHUP (tested on macOS and Linux).
- **Environment and input.** The child inherits the starter's `TERM` and `COLORTERM` (`session-env.ts` drops only the
  window variables); the terminal that attaches later may be another one. A default `TERM` is set (see "Behaviour
  change"); the rest is a written limit. `send` and a person typing go into one input: `send`'s Enter may submit
  text the person has half typed. Written limit; nothing in this task calls `send` while a person is attached.
- **Memory per session.** The ring is 1 MiB; each of at most 8 clients may lag 4 MiB before it is dropped: about
  33 MiB at worst; a client's pending input is at most 64 KiB before its socket is paused. One test fills all
  eight to the limit and asserts the sum. A client that is SIGKILLed leaves its terminal in raw mode with the modes on; nothing can clean
  that, the docs say `reset`.
- **Packaging.** The dependency is pinned exactly, optional, and external to the bundle; the bundle imports it
  only dynamically, inside the loader. An install that skips it must leave every other command working. The
  loader checks at run time that the platform package is there and that `spawn-helper` is executable, and answers
  `UNSUPPORTED` with the reason otherwise. PTY never runs under Bun. **If packaging is not green on ubuntu and
  macos by day 5, what is refuted is "an optional native dependency inside the CLI package";** the task stops for
  the person (the ways out are theirs: a package of its own, another module, no PTY).
- **`sun_path` and the socket's name.** A session id is unique only inside one checkout's folder
  (`session-pipes.ts:144-145` loops on `sessionDirOf(place, id)`), while the run folder and `/tmp/kodel-<uid>` are
  per user, so two checkouts (or parallel workers) can hold the same id. The name therefore carries the checkout:
  primary `<state base>/run/<uid>/<id>-<k>.sock`, where `<k>` is the first 8 hex characters of a hash of the
  checkout key; above 100 bytes it falls back to `<h>.sock`, 16 hex characters of a hash of checkout key plus id,
  in `$TMPDIR/kodel-<uid>/`, then `/tmp/kodel-<uid>/`. The candidates are a pure function of strings (base, uid,
  checkout key, id, the temporary roots). Every candidate is length-checked, and its directory is checked like the
  run folder (real, owned, 0700).
- **Test environments.** `bun test` runs on windows-latest too: everything that binds a unix socket or needs a
  PTY skips on `win32` with the reason; the frames, the server (in-memory pair) and the path candidates (pure) run
  there. A sandbox that refuses a bind or a PTY skips the same tests with the reason; the CI job sets
  `KODEL_REQUIRE_PTY=1`, where a skip is a failure. On macOS the test runner's `TMPDIR`
  (`/private/var/folders/.../kodel-test-worker-*`, `scripts/test.mjs:72`) makes the primary path, and often the
  `$TMPDIR` fallback, longer than `sun_path`: the bind tests make their short base with `mkdtemp` under `/tmp` (skip
  with the reason where `/tmp` cannot be written) and assert by name which candidate was taken: primary, `$TMPDIR`,
  `/tmp`. One test starts the holder under one `TMPDIR` and runs the client and `rm` under another.
- **What the run's own checks do not prove.** In this repository's pipeline `bun test` runs before the build
  (`dev.yaml:240`, `:246`) and inside the agent sandbox, which denies `/dev/tty[p-w]*`: every "real" test (about 30)
  is skipped there. A skip is never a pass: the skip helper prints one counted line (`PTY tests skipped: N,
  <reason>`), the PR description repeats the list, and the final gate must show (a) the green CI job with
  `KODEL_REQUIRE_PTY=1` on ubuntu and macos and (b) the person's hand check. Changing the pipeline is decision 9.
- **Windows.** `agent attach` checks the platform before `requireHuman` (`PLATFORM_UNSUPPORTED` first, in the
  human-only walk too). The new modules are safe to import there: `process.getuid`, `setRawMode` and `SIGWINCH`
  are touched only inside guarded functions, never at import; a test imports each of them on the Windows job.

## Acceptance criteria and tests

Names carry `tA_` (decision 5; `session_test_names_carry_the_decision_id` checks it). "Real" means a real PTY from the built artifact; those tests skip without it unless
`KODEL_REQUIRE_PTY=1`, and they refuse to run against a `dist/kodel.js` older than the sources (a stale build is a
failure with `KODEL_REQUIRE_PTY=1`, a skip with the reason otherwise). The test runner is Bun, which cannot host a
PTY, so the client under test is hosted by a small Node helper (`tests/pty/host.mjs`) that loads the module through
the artifact's loader and speaks JSON lines with the test over pipes.

| Criterion | Test |
|---|---|
| Frames round-trip; a partial frame waits; oversize length and unknown type fail closed; another version gets `BYE` | `tA_attach_frames_roundtrip`, `tA_attach_frames_hostile`, `tA_attach_version_mismatch` |
| One test per hostile behaviour, each also in the window before the child exists, each asserting that the other client and the child go on: no `HELLO` and a partial `HELLO` are closed at 5 s **on the injected clock**; a frame before `HELLO`; a holder-only frame; a flood of input is paused at 64 KiB pending (the number is asserted) | `tA_attach_no_hello_times_out`, `tA_attach_partial_hello_times_out`, `tA_attach_frame_before_hello_closed`, `tA_attach_holder_only_frame_closed`, `tA_attach_input_flood_paused_at_bound` |
| Before the child exists: `HELLO` is answered, the last `RESIZE` is the spawn size, `INPUT` is dropped | `tA_attach_before_spawn_window` |
| A client socket error (reset, `EPIPE`) does not end the holder | `tA_attach_client_error_keeps_holder` |
| The chord is found as `0x1c`, `CSI 92;5u` and `CSI 27;5;92~`, also split over two reads; other input passes unchanged; Ctrl+] (`0x1d`, `CSI 93;5u`, `CSI 27;5;93~`) is passed to the child and is not a chord | `tA_attach_chord_encodings`, `tA_attach_chord_split_read`, `tA_attach_ctrl_bracket_passes_through` |
| The reset string switches off mouse, focus events, bracketed paste, kitty keyboard, application keys and the alternate screen | `tA_attach_reset_covers_every_mode` |
| The replay has no terminal query (each kind, also split over two chunks); the live stream keeps them | `tA_replay_strips_terminal_queries` |
| The ring never exceeds 1 MiB and a cut inside an escape or a UTF-8 sequence replays decodable | `tA_ring_bounded`, `tA_ring_cut_mid_sequence` |
| The tracker follows every switch of the reset list, also split over two chunks; before the ring wraps the prefix is empty; after it wrapped the replay is the tracker prefix, then the ring, in order, with no mode set twice and no query in the prefix | `tA_mode_tracker_follows_switches`, `tA_mode_tracker_split_chunk`, `tA_attach_replay_prefix_then_ring` |
| The socket path: at 100 bytes stays, at 101 falls back; fallback order, each candidate length-checked; an id outside `LOCAL_SESSION_ID_PATTERN` is refused | `tA_socket_path_boundary_100_101`, `tA_socket_fallback_order`, `tA_socket_path_rejects_bad_id` |
| A fallback directory that is a symlink or not ours refuses, for the holder and for the client; the client refuses a socket of another owner or mode | `tA_socket_tmp_dir_squatted_refuses`, `tA_attach_client_checks_socket_owner` |
| A bound socket on the primary path and on each fallback (short base under `/tmp`) | `tA_pty_socket_primary_and_fallback_bind` (real) |
| `sock` decodes, encodes and round-trips; the PTY fixtures open and are written back as read; a newer `v` is refused | `tA_status_sock_roundtrip`, `tA_pty_fixtures_roundtrip` |
| A reader without the field: the fixtures with `sock` removed give the same `deriveStatus` | `tA_status_sock_ignored_same_status` |
| Rule 5, second half: an older build drops `sock` and writes the record back; `deriveStatus` is the same, and `attachable` is false with "the record names no socket" (accepted, see "`sock` lifetime") | `tA_status_sock_dropped_reencode_same_status` |
| `session.json` has no `size`, and its `mode` is the spec's | `tA_session_record_has_no_size`, `tA_session_record_mode_follows_spec` |
| The final record has no `sock` and the socket file is gone, after exit and after `stop` | `tA_pty_final_record_drops_sock`, `tA_pty_socket_removed` (real) |
| After SIGKILL of the holder: `attach` answers `NOT_ATTACHABLE` (not a raw connect error), `rm` removes the folder and the leaked socket, and does not unlink a `sock` path that is not a candidate of the id | `tA_pty_stale_sock_after_sigkill`, `tA_rm_unlinks_only_derived_sock` (real, and with a forged record) |
| A stale leftover socket at the holder's path (connect refused) is replaced; one that somebody listens on, a non-socket, or `EADDRINUSE`, is `holder_error` with no child pid in any record, no `ready` and **no socket file left** | `tA_pty_bind_leftover_replaced`, `tA_pty_bind_live_leftover_refused`, `tA_pty_bind_failure_no_child` |
| The bind comes only after the exclusive create of `status.json`: with a tombstone already there no socket is ever made | `tA_pty_bind_after_exclusive_status` |
| The socket is gone after each exit of the holder: a failed spawn (`failBoot`), a tombstone found after the spawn, a failed write of `running`, the folder removed under a live child | `tA_pty_socket_unlinked_on_failboot`, `tA_pty_socket_unlinked_on_tombstone`, `tA_pty_socket_unlinked_on_running_write_failure`, `tA_pty_socket_unlinked_on_dir_removed` (fake PTY, real socket) |
| The sweep works without a record: after the starter's `rollback()`, and for a `starting` record with no `sock` (holder SIGKILLed between `listen` and `running`), the derived paths are unlinked; `stop` of a session whose holder is gone sweeps too | `tA_rollback_sweeps_derived_sock`, `tA_rm_sweeps_starting_without_sock`, `tA_stop_sweeps_sock_of_dead_holder` |
| The holder under one `TMPDIR`, the client and `rm` under another: attach connects, `rm` unlinks | `tA_pty_tmpdir_differs_between_holder_and_client` (real) |
| The same id in two checkouts gives two socket names, primary and hashed; a session of one checkout never unlinks or connects to the other's | `tA_socket_name_carries_checkout`, `tA_rm_leaves_other_checkout_socket` |
| Server with a fake PTY: output reaches every client; a second client does not kick the first; the last resize wins; a ninth client is refused; a client that lags past 4 MiB is dropped and may come back | `tA_attach_two_clients`, `tA_attach_last_resize_wins`, `tA_attach_client_cap`, `tA_attach_slow_client_dropped` |
| `ready` only after the socket listens: an attach right after `start` returns never gets `ENOENT` | `tA_pty_ready_after_listen` (real) |
| The module is loaded before the child; absent, broken, a `spawn-helper` that is not executable, or under Bun (its own case) gives `UNSUPPORTED` with the reason and no child, and pipes still work | `tA_pty_loader_injected`, `tA_pty_absent_no_child`, `tA_pty_loader_refuses_under_bun`, `tA_pty_spawn_helper_not_executable`, `tA_pipes_work_without_pty` |
| `capabilities()` without a probe, with a passing and with a failing one; `start` with `mode: pty` and a failing probe is `UNSUPPORTED` with the reason and writes nothing; a holder whose load fails after a passing probe is `HOLDER_BOOT_FAILED` with the reason; an adapter without `attach` still satisfies the interface | `tA_capabilities_follow_probe`, `tA_pty_start_refused_by_probe_writes_nothing`, `tA_pty_holder_load_failure_after_probe` |
| A child ended by a signal is `killed` with the signal's name, not `exited 0` (unit, over a fake PTY that reports a number) | `tA_pty_signal_number_mapped` |
| A missing executable fails the boot before the spawn is called and frees the name (unit with a fake PTY; real: `agent exec --pty -- no-such-cmd`); a `command` string is spawned as `/bin/sh -c`; the spawn's environment has `KODEL_ENGINE=1` even when the input has none | `tA_pty_missing_command_fails_boot`, `tA_pty_exec_no_such_cmd_frees_name` (real), `tA_pty_command_runs_through_sh`, `tA_pty_holder_forces_engine_flag` |
| Input reaches the child, output comes back, the ring replays on re-attach (the scripted part of "Done when") | `tA_pty_attach_echo`, `tA_pty_reattach_replay` (real) |
| The size of `HELLO` reaches the child (`stty size`) and `RESIZE` changes it; `TERM` has the default when the starter had none | `tA_pty_resize_reaches_child`, `tA_pty_child_term_default` (real) |
| Detach keeps the child; the starter returns after `ready` and holds nothing of the holder | `tA_pty_detach_keeps_child`, `tA_pty_starter_returns` (real) |
| A killed holder: the child gets SIGHUP and ends (macOS and Linux) | `tA_pty_holder_killed_child_hup` (real) |
| The child's `cwd` is the spec's, not the holder's `/` | `tA_pty_child_cwd_from_spec` (real) |
| The client, on a PTY of its own: after detach, after the child's exit and after `stop` it has emitted the reset and the visible line, and the terminal settings are as before | `tA_attach_client_clean_after_detach`, `tA_attach_client_clean_after_exit`, `tA_attach_client_clean_after_kill` (real) |
| Ctrl+C typed in the client reaches the child and does not end the client | `tA_attach_client_ctrl_c_goes_to_child` (real) |
| A client whose stdout is not read does not stall the holder or the other client | `tA_attach_client_blocked_stdout` (real) |
| A window change of the client sends `RESIZE` | `tA_attach_client_resize` (real) |
| `send`: a paste only while DEC 2004 is on (also switched on in a split chunk), Enter as a separate write after the gap; the gap waits on the injected clock | `tA_pty_send_paste_only_with_2004`, `tA_pty_send_enter_own_write` (real), `tA_pty_send_gap_uses_clock` |
| The PTY session passes the contract table of `testkit` (`stop`, `wait`, timeout, `rm`, names), which gains one negative row: `tail` of one stream is `UNSUPPORTED` | `tA_pty_passes_session_contract` (real) |
| Socket mode 0600; a missing socket gives `NOT_ATTACHABLE` | `tA_pty_socket_modes`, `tA_pty_socket_missing_not_attachable` (real) |
| No raw bytes on disk; `logs` is stripped and redacted, also for a secret split over two chunks and for typed text the terminal echoes; `--stdout` is refused | `tA_pty_no_raw_bytes_on_disk`, `tA_pty_logs_stripped_and_redacted`, `tA_pty_tail_redacts_split_and_echo` (real) |
| Inside the PTY session a human-only command refuses although a terminal is present, `agent attach` too; `KODEL_ENGINE=1` is set also when the starter's shell has other `KODEL_*` | `tA_pty_session_refuses_human_commands`, `tA_pty_attach_refuses_inside_session` (real), `tA_session_env_keeps_engine_flag` |
| Every session test name carries the prefix kept in one constant (decision 5); the checker, given a list with one name without the prefix, fails and names it | `session_test_names_carry_the_decision_id`, `session_test_names_check_rejects_unprefixed` |
| `agent attach` and `agent exec --pty` refuse under `KODEL_ENGINE` and without a terminal; on `win32` `attach` answers `PLATFORM_UNSUPPORTED` before the human check; `attach` is in the human-only set and in AGENTS.md | `tA_agent_human_commands_refuse` (existing walk over `AGENT_HUMAN_COMMANDS`, plus an `exec --pty` row and a `win32` row), `tA_agents_md_lists_attach` |
| `agent attach` finds a session by name or id; a pipes session and an ended one are refused with the reason | `tA_agent_attach_resolves_name_or_id`, `tA_agent_attach_refuses_pipes_and_ended` |
| The packed package, installed in an empty folder by `npm install`, `npm install -g`, `bun install -g`, `pnpm add` and run by `npx`: the platform package arrived, `spawn-helper` is executable where one ships, the smoke passes; installed with optional dependencies off, every other command works | `scripts/check-pty-artifact.mjs` in the CI job (ubuntu, macos) |
| The bundle copied alone to an empty folder starts on plain Node; the module is external and is not a static top-level import | `scripts/check-artifact.mjs` (new lines) |
| Licences of **every** platform package of the module (the licence job installs only linux-x64): each `@lydell/node-pty-*` entry of `bun.lock` matches a pinned name, version and licence table | `scripts/check-licenses.mjs` (new check) |
| The Windows job stays green: `bun install --frozen-lockfile` with the optional win32 package (installed, unused) and the lockfile the same from all three systems | the existing matrix; checked on day 1 |

**Round 2 tests** (added by this critique round; unit tests unless marked real):

| Criterion | Test |
|---|---|
| `attach` and `attachable` ask `deriveStatus` first: an exited or stopped session whose `status.json` still has `sock` is `NOT_ATTACHABLE` and no connect is made | `tA_attach_asks_status_before_connect` |
| A connect that fails with `ECONNREFUSED` or `ENOENT` (a fake connect) is `NOT_ATTACHABLE` | `tA_attach_connect_error_mapped` |
| `attachable` of a pipes session is false with the reason | `tA_attachable_false_for_pipes_with_reason` |
| `NOT_ATTACHABLE` is in `SESSION_ERROR_CODES` (pinned by name, beside the existing list test in `session.test.ts`) | `tA_session_error_codes_pin_not_attachable` |
| Strip-then-redact over fake chunks: an escape sequence inside a secret, a secret split over two chunks | `tA_tail_strip_then_redact_pure` |
| `trackBracketedPaste` with the carry: DEC 2004 switched on and off in a split chunk | `tA_bracketed_paste_carry` |
| The chord is not matched between `ESC[200~` and `ESC[201~`, also with the markers split over two reads | `tA_attach_chord_not_inside_paste` |
| `BYE` reaches every client before the final record is written (order of the fake store's writes) | `tA_bye_before_final_record` |
| `forget-name` of a session with an attached client: the client stays attached | `tA_forget_name_keeps_attached_client` |
| Eight clients each lagging to the limit: buffered bytes are at most 1 + 8 x 4 MiB, a ninth is refused, a dropped one frees its share | `tA_attach_memory_bound_at_cap` |
| The client restores the terminal on SIGTERM and on SIGHUP, and exits with the reset when the socket drops | `tA_attach_client_sigterm_restores`, `tA_attach_client_sighup_restores`, `tA_attach_client_socket_dropped_exits` (real) |
| A terminal answer that arrives after the reset is discarded, not left for the shell (fake stdin and clock; and real, on the client's own PTY) | `tA_attach_client_drains_late_answer` |
| The child's umask is the starter's | `tA_pty_child_umask_unchanged` (real) |
| The new modules import on `win32` without touching `process.getuid`, `setRawMode` or `SIGWINCH` | `tA_new_modules_import_on_windows` (runs on the Windows job) |
| The session family's key table and fixture-directory tests stay complete with `sock` (a missing key is a compile error or a failing test, as today) | `tA_session_key_table_has_sock` |
| A PTY session that ended `killed/holder_error` has a golden of its own | `status-killed-pty.json` in `tA_pty_fixtures_roundtrip` |
| A PTY session that `stop` ended has a golden of its own (`killed`, `reason: stopped`, the child, no `sock`); added in review round 3 | `status-stopped-pty.json` in `tA_pty_fixtures_roundtrip` |
| The pipes goldens that exist today are byte-identical after the script gains its PTY part (their hashes are pinned) | `tA_pipes_goldens_byte_identical` |
| The Node host helper answers its own protocol (start, echo, exit code) before any test relies on it | `tA_pty_host_helper_selftest` (real) |
| The skip helper: with `KODEL_REQUIRE_PTY=1` a missing PTY or a stale build throws; without it the test is registered as skipped with the reason and counted in the printed line | `tA_pty_skip_is_reported_not_passed` |

Notes on the tests:

- **Fixtures are taken, never written by hand**, and only from the records the holder wrote (never from the
  ring or `tail.txt`). A stale fixture is detected where it can be: the CI PTY job runs
  `take-session-fixtures.mjs --check`, which takes the records again from the built artifact and compares key sets
  and masked values with the goldens. It cannot run where no PTY exists, so locally a stale PTY fixture is not
  detected; said plainly.
- **The packaging checks are CI scripts, not named tests** (`check-pty-artifact.mjs`, the new lines of
  `check-artifact.mjs` and `check-licenses.mjs`). `tA_pipes_work_without_pty` uses an injected absent probe; a
  package that is really missing is covered only by the script's install with optional dependencies off.
- **`tA_agents_md_lists_attach` is kept** although the test of `ci.yml` text was dropped: AGENTS.md is the
  instruction an agent acts on, and the test compares it with `AGENT_HUMAN_COMMANDS` in the code, so it fails
  when the two drift. The `ci.yml` test could only show that a job is declared, not that it is required.

**What would refute each decision.** 1: the packaging box failing (see "Risks"): "one PTY holder for every agent"
then has no module to stand on, and the ways out are the person's. 2: nothing is built, so nothing here can be
refuted; a dialog answered through a PTY session would be the reason for the person to take D-B up again. 3:
`tA_status_sock_ignored_same_status` failing (the field is not a compatible addition, so `v` must be bumped), or a
need for a second stored field. 4: a tracker test failing, or the hand check showing a re-attach after a wrapped
ring that types wrongly although the prefix was sent. 5: `session_test_names_carry_the_decision_id` letting a name
without the prefix pass. 6: the hand check showing a terminal that sends `Ctrl+\` in a fourth encoding, or an agent
that needs `Ctrl+\` itself. 7: the packaging gate passing while the rest slips past its days.

**Cannot be tested here, said plainly:** how clean a real terminal is across terminal apps (the client tests check
the bytes and the termios of a PTY, not Terminal, iTerm or kitty); that the CI job is required in branch protection
(a test that reads `ci.yml` was dropped as a check of text, not of behaviour); any platform CI does not run
(linux-arm64, Alpine/musl, darwin-x64); a terminal left raw by a SIGKILLed client; a terminal that sends `Ctrl+\`
in a fourth encoding (the three known ones are tested; a fourth shows only in the hand check); wrong typing after
a re-attach over a wrapped ring (hand check only: the tests check the bytes of prefix and ring, not what a real
program does with them); the refutation of decision 7, which is a judgement of the schedule, not a test; a stale
PTY fixture on a machine without a PTY. **Not tested because not built:** a decision dialog inside a PTY session
(decision 2), including the route named in "Risks".

**"Done when" is a hand check** (ticked by the person in the PR), because no user flow starts a PTY session: with the
**built artifact** (`bun run build`, then `node packages/cli/dist/kodel.js agent exec --pty -- claude` and `... agent
attach <name>`; from source the holder runs under Bun and answers `UNSUPPORTED`), attach, detach and re-attach with a
real Claude Code (once after enough output to wrap the ring), `Ctrl+]` reaching Claude Code, the terminal clean
after detach, after a kill and after the agent's own exit; the terminal app and
versions written down; the CI job marked required in branch protection.

---

## Steps

1. **Packaging, days 1-5 (the time box), first because it can end the task.** Add the pinned optional dependency,
   `--external` in `scripts/build-cli.mjs`, the loader in the CLI's holder entry with its run-time self-check,
   `scripts/check-pty-artifact.mjs` (the installers of the table above), the new lines of `check-artifact.mjs` and
   `check-licenses.mjs`, and the CI job. The smoke at this point only spawns `sh -c 'stty size'` through the loader.
   Day 1 also answers: does the module load under Bun on both systems (if yes, the real tests may run from source;
   the plan assumes no); is there a musl package (if not, Alpine is named as unsupported in the docs and the hint);
   does the Windows job stay green with the frozen lockfile; **what the module does with a command that cannot be
   executed** (a spawn error, or a child that exits non-zero, and with which code), written into the PR. Green on
   ubuntu and macos ends the box. **Past day 5: stop and ask the person. At the end of the box: stop for the
   person in any case (decision 7); the stop also asks for D-A's decision id (decision 5).** Steps 2-4 do not
   need the native module, so they are not lost if the box fails; the task still stops there.
2. Pure code and its tests first (core): frames, chord matcher (`Ctrl+\` only), reset string, query filter, mode
   tracker and the carry of `trackBracketedPaste`, the chord matcher's paste state, strip-then-redact as one
   function, path candidates and the "qualifies" check (names from checkout key and id), `sock` in the codec, `size` in `SessionSpec` and
   `validateSpec` (never in the stored spec), optional `attach` and `attachable` in the interface,
   `NOT_ATTACHABLE`; the test-name check with its one constant (decision 5).
3. `packages/local`: the socket path checks; the PTY trait; the attach server (clients, cap, ring, the tracker fed
   with the bytes the ring drops and its prefix on connect, lag limit, `SEND` frame) tested with a fake PTY over an in-memory pair; the holder branch for `mode: pty` in this order: status
   `starting` (exclusive), load the module, probe and clear a leftover, bind, `chmod` and listen (no `umask`), look
   the executable up, spawn with `cwd` and env from the input (`KODEL_ENGINE=1` forced again; a `command` string
   as `/bin/sh -c`), write `running` with `sock`, write `ready`; at the end `BYE` to the clients, unlink, the final
   record without `sock`. Every return after the bind goes through the one function that closes and unlinks.
   The tail for a PTY is one stream, stripped then redacted. The adapter cuts `size` from the record, writes the
   spec's `mode`, accepts `mode: pty` when the probe passes, gains `attach`, `attachable`, the PTY path of `send`
   and the socket sweep of `remove`, `stop` and `rollback()`.
4. `packages/cli`: the attach client (the socket checks, raw mode, `HELLO` with the size, window changes, chord,
   reset and the visible line on every way out, also on a dropped socket and on SIGTERM/SIGHUP of the client; the
   bounded drain of stdin before the terminal settings are restored), `agent attach` (the platform check before
   `requireHuman`), `agent exec --pty`, the probe the adapter is given and its hints.
5. Real tests against the built artifact with the Node host helper; extend the CI smoke to the full scripted check
   (start, attach on a PTY of the script's own, type, read the echo, detach, re-attach, see the replay, stop, check
   the reset).
6. Fixtures from a real PTY holder: `scripts/take-session-fixtures.mjs` runs under Bun, where a PTY holder never
   runs, so its PTY part drives the built artifact under Node (`node packages/cli/dist/kodel.js agent exec --pty`
   with `KODEL_STATE_DIR` at a temporary folder) and reads the records it wrote; the mask also covers the `sock`
   path (the run folder, `$TMPDIR`, the uid, the id and the hashed name). The PTY part is additive: the pipes
   goldens stay byte-identical. A `--check` mode compares instead of writing (for the CI PTY job). Docs:
   - `docs/decisions.md`: the sentence "a person's decision is written as before and carries no mark" gains what
     is true now: a dialog shown inside a PTY session (`agent exec --pty`) can be answered by any process of the
     same user through the attach socket, the agent in that session included, and the journal cannot tell it
     from the person; a project that needs the difference keeps `dialog` off for such sessions.
   - `docs/engines.md:14`: it says engine steps are turned on "once D-B and D-C are on main", which reads as if
     D-B were on its way. It will say that D-B is not scheduled (the person's answer in TASK-HN8N) and that engine
     steps stay off until it is taken up; nothing else in that file changes.
   - `docs/session-formats.md`: `sock` and its lifetime; the file table (a PTY session has `tail.txt` only, and a
     socket outside the folder); the "Not built yet" paragraph loses the PTY mode and `attach`; the limits (the
     unredacted ring, same-user access, a decision dialog inside a PTY session is not protected, two clients
     answering a query, what the mode prefix does not carry after a wrap, `Ctrl+\` kept by the client, `send` with a
     person attached, `TERM`, the client cap and the memory per session, Alpine/musl, a fallback socket removed
     by a cleaner of temporary files, a socket left by a holder killed before `running` under another `TMPDIR`,
     the tail of a full-screen program and what redaction can find in it, a command the lookup cannot see fail
     leaving `exited` and the name used); one line on builds of different age (an older build drops `sock`: it
     sweeps nothing and cannot attach, nothing else differs); the socket's name and why it carries the checkout;
     `KODEL_REQUIRE_PTY`.
   - AGENTS.md: `agent attach` in the "Do not run" list, with the sentence reworded ("they refuse to run without a
     terminal, and most ask for a confirmation": `attach` asks for none); the Layout line; a word on the PTY job.
   - The PR description: the dependency justified, with the per-platform licence table (Conventions: "justify
     each new one", "licenses must be compatible"); the real tests skipped in the run, by name and count, with the
     CI job that ran them; the day-1 answers.
7. Hand check by the person with the built artifact and a real Claude Code ("Done when" above), then
   the merge.

## Affected files

- New, `packages/pipeline-core/src`: `session-frames.ts`, `session-terminal.ts` (chord, reset, query filter, mode
  tracker), `session-socket-path.ts` (candidates, pure); tests.
- New, `packages/local/src`: `session-pty.ts` (trait and holder branch), `attach-server.ts`, `session-socket.ts`
  (the directory and socket checks, bind, sweep); tests.
- New, `packages/cli/src`: `attach-client.ts`, `pty-loader.ts`; tests. New, `tests/pty/`: the real tests and
  `host.mjs`.
- New: `scripts/check-pty-artifact.mjs`; `fixtures/session-formats/v1/session-pty.json`,
  `status-running-pty.json`, `status-exited-pty.json` (no `sock`), `status-killed-pty.json` (`holder_error`),
  `status-stopped-pty.json` (after `stop`; review round 3).
- Changed: `packages/pipeline-core/src/session.ts`, `sessions/records.ts`, `index.ts`;
  `packages/local/src/session-holder.ts`, `session-pipes.ts`, `session-env.ts` (`TERM`), `session-paths.ts`,
  `session-records.ts`, `index.ts`;
  `packages/cli/src/agent-commands.ts`, `main.ts`, `cli.ts` (the comment of `requireHuman`);
  `packages/cli/package.json`, `bun.lock`; `scripts/build-cli.mjs`, `check-artifact.mjs`, `check-licenses.mjs`,
  `take-session-fixtures.mjs`; `.github/workflows/ci.yml`; `packages/testkit/src/session-contract.ts` (a PTY row
  and the negative row);
  `packages/cli/test/agent.test.ts` (`tA_agent_exec_pty_is_not_in_this_build` is replaced);
  `docs/session-formats.md`, `docs/decisions.md`, `docs/engines.md` (one paragraph each),
  `fixtures/session-formats/README.md`, `AGENTS.md`.
- Not touched: run formats, `fixtures/formats/` and `docs/run-formats.md` (no run format changes), the MCP tools,
  `mcp-server.ts` (unless the person takes decision 8 B) and the project config (nothing here reads
  `decisions.dialog`), `.kodel/pipelines/dev.yaml` (decision 9), the TUI, `claude-worker.ts`.

## Rejected review findings

- **"Drop client input until the replay is drained" (F, one of two offered fixes).** Not taken: the terminal's
  answers arrive after the replay bytes are written, so any cut-off point races. The other fix (queries cut out of
  the replay) is taken and tested.
- **"Two clients answer a live query twice: fix" (F).** Not fixed, written as a limit: the holder cannot tell an
  answer from typing without parsing every client's input, and the task asks only that a second client is not kicked.
- **`tA_ci_workflow_declares_pty_job` (I).** Dropped as the finding offers, not kept as "declared, not required": a
  test of YAML text proves nothing about the job running. Branch protection stays a hand check.
- **"Split into three tasks" (N).** Not done: the person answered one task with the packaging stop (decision 7).
- **"A configuration option for the detach chords" (L).** Not built. With the person's answer (decision 6) the
  client keeps one key, `Ctrl+\`, and `Ctrl+]` is free for Claude Code, which was the case the option was for. An
  option to move the chord is a follow-up only if the hand check shows an agent that needs `Ctrl+\`.
- **"No mode tracker in this task; the fixed reset only, as the task text says" (N).** The earlier revision took
  this finding and made the tracker a follow-up. The person answered the opposite (decision 4 = B), so it no
  longer holds: the tracker is in, as a pure function with its own tests, with no change of the protocol or of a
  stored field.
- **"Hold the D-B order by code: `agent exec --pty` refuses while `decisions.dialog` is on, a `test.todo` for the
  dialog gate, no merge before D-B" (the critique, principle 6).** Taken by the earlier revision, removed now: the
  person does not do D-B (decision 2). The refusal would guard the way to a feature nobody builds and, as that
  revision said itself, an MCP server started in another folder walks around it. The gap is stated in "Risks"
  instead of half covered.
- **"The `claude --bg` probe needs the person's approval; stop until it is answered" (the critique).** No longer
  applies: there is no probe (decision 1).
- **"The person gives the decision id before step 2, so no test is written under a placeholder" (the earlier
  recommendation).** Not held: the person left it to me, and the placeholder in one constant with a test that
  checks the names costs one rename later (decision 5).
- Every other finding of groups A-N is taken into the sections above.

Round 2 (11 findings; all others are taken into the sections above, 1 and 7 partly as decisions 8 and 9):

- **"Refuse `dialog` in the MCP server when `KODEL_ENGINE` is set" (1, the stopgap).** Not built by default: it is
  code on the ground of the person's "no D-B" answer. It is decision 8, default A.
- **"Build before the tests in `dev.yaml` / set `KODEL_REQUIRE_PTY` in the run" (7).** Not done by default: the
  pipeline file is the person's, and the sandbox has no PTY devices either way. It is decision 9, default A.
- **"Re-bind a fallback socket that a cleaner of temporary files removed" (3, implied).** Not built: the holder
  would have to watch its own socket file; written as a limit, the session stays stoppable and readable.
- **"A live session whose `sock` was dropped by another build should still be attachable" (5).** Not built: no
  build rewrites a `running` record but its holder, so the case needs a fault; it is `NOT_ATTACHABLE` with a
  reason, and tested as that.
- **"Move `send` for a PTY out", "split the tracker off", "split steps 2-4 from the native module" (11).** Not
  done here: the person answered one task (decision 7), and `send` stays the person's call at the gate. The
  information is kept where it helps (the tracker note in "Risks", the note at the end of step 1).

## Findings in the code

- **M1 is in this tree.** The holder, the pipes adapter, the codec, the v1 fixtures and `agent ls|logs|stop|rm|exec|
  forget-name` exist (`packages/local/src/session-holder.ts`, `session-pipes.ts`,
  `packages/pipeline-core/src/sessions/records.ts`, `fixtures/session-formats/v1/`,
  `packages/cli/src/agent-commands.ts`). `--pty` is refused in two places: `agent-commands.ts` (the `exec` action)
  and `session-pipes.ts:134`; `packages/cli/test/agent.test.ts:196` pins it.
- **D-B is not in this tree, and this task does not add it (decision 2).**
  `packages/cli/src/mcp-server.ts:92` decides `dialog` from the options alone; no check
  for "inside a session" exists. `docs/plans/task_9pns.md:562` says the same and names `TASK-8EP9` as todo;
  `docs/engines.md:14` still waits for D-B. What exists is narrower: `insideHostSession`
  (`packages/local/src/process-group.ts:143`, used at `packages/cli/src/cli.ts:410`) serves no tools inside the
  process group of a **host** session (T-42), and `kodel mcp --no-decisions` is passed to the `claude -p` workers.
  Neither covers a session a person starts with `agent exec --pty`, and that stays so after this task.
- I could not read `.kodel/tasks/` (denied), so the states of TASK-8EP9, TASK-9PNS, TASK-EKAV and TASK-W58V, and the
  exact text of TASK-HN8N about `send`, are taken from the plans and the spike's note, not from the task records.
  `notes/` in the main checkout was not needed.
- **The boot report is a file, not a pipe** (`writeBoot`, `session-holder.ts`; `awaitBoot`, `session-pipes.ts:289`).
  The spike's rule "the starter destroys its end of the boot pipe" has nothing to apply to; its intent is kept by
  `tA_pty_starter_returns`.
- `holderMain` does `process.chdir("/")` and the pipes spawn passes `cwd: input.cwd` (`session-holder.ts`); the PTY
  spawn must pass it the same way (spike finding 6).
- The v1 records have no socket field, and the stored spec is a strict schema with no `size`
  (`sessions/records.ts:31-47`). `start()` builds the record from `{...safeSpec}` with only `env` and `command` taken
  out and `mode: "pipes"` written as a literal (`session-pipes.ts:196-208`). `SESSION_RECORD_CAPABILITIES[1].pty` is
  already `true` though no PTY record was ever written.
- The final status record is `{...running, ...}` (`session-holder.ts:343-355`): every field of the `running` record
  survives the end unless it is left out on purpose. The exit branch reads a signal **name** (`code.signal`).
- `remove` deletes the session folder and, for `origin: "cli"`, the name marker; it refuses a running session with
  `STILL_RUNNING` (`session-pipes.ts:535-594`). Nothing outside the folder is removed.
- `requireHuman` is `KODEL_ENGINE` unset plus `env.interactive` (`cli.ts:340-350`), and `interactive` is
  `stdin.isTTY && stdout.isTTY` (`main.ts:61`). Its own comment already says a pseudo-terminal passes the check.
- `sessionEnv` drops inherited `KODEL_*` and the window variables and forces `KODEL_ENGINE=1`; `TERM`, `COLORTERM`,
  `LINES` and `COLUMNS` pass through (`session-env.ts:7-35`).
- The pipes adapter's `capabilities()` is a literal with `pty: false, attach: false, streams: true`
  (`session-pipes.ts:120`).
- `session-paths.ts` only mentions the socket path in a comment (`<runDir>/<id>.sock`, `:18`); there is no length
  check and no fallback. `runDir` is `<base>/run/<uid>`, shared by every checkout, while `start()` looks for a free
  id only in its own checkout's folder (`session-pipes.ts:144-145`): the comment's name can collide, so the plan's
  name carries the checkout.
- The holder has five ways out after the point where a PTY holder would have bound (`session-holder.ts`:
  `failBoot` `:184`/`:292`, the tombstone after the spawn `:303`, the `replaceRecord` catch `:310`, the watcher
  `:326`, the end `:340-359`), and the first `status.json` is created exclusively at `:180`, before any of them.
  The starter's `rollback()` removes the folder, its temporary twin and the name marker, nothing else
  (`session-pipes.ts:190-194`).
- The pipes spawn runs a `command` string with `shell: true` and reports a missing `argv[0]` as a spawn failure
  (`session-holder.ts:229-232`, `:292`). `@lydell/node-pty` is not installed in this worktree, so how it reports
  a failed `exec` is unverified (day-1 probe).
- `.kodel/pipelines/dev.yaml` runs `bun test` in the `test` step (`:240`) and builds in the next one (`:246`).
- `insideHostSession` (T-42) tells a host session by its process group (`process-group.ts:143-147`). A PTY child
  leads a session of its own, so that check would miss if host sessions ever run under a PTY: a note for
  TASK-EKAV, not this task.
- `docs/decisions.md:60` says a person's decision "is written as before and carries no mark"; nothing marks a
  dialog answered through a socket.
- `planSend`, `trackBracketedPaste` and `SEND_PASTE_GAP_MS = 200` already exist in
  `packages/pipeline-core/src/session.ts` (the spike used 400 ms). `trackBracketedPaste` looks at one string, so a
  switch split over two chunks is missed; step 2 gives it a carry.
- `SessionAdapter` has an optional `send` and no `attach` (`session.ts:281-296`); TASK-KDJS said `send` is not on the
  interface. The plan follows the code. `SESSION_ERROR_CODES` has `UNSUPPORTED` and `NOT_RUNNING`, no
  `NOT_ATTACHABLE`.
- The launcher is `process.execPath` plus `process.argv[1]` (`agent-commands.ts`, `registerAgentCommands`): from
  source that is Bun, where the PTY holder is not meant to run. `scripts/take-session-fixtures.mjs:8-17` starts the
  holder the same way, under Bun.
- CI (`.github/workflows/ci.yml`): `bun test` runs on ubuntu, macos and windows; `check-licenses.mjs` runs in one
  ubuntu job and reads `node_modules/.bun`, so it sees only the packages installed for linux-x64.
  `scripts/test.mjs:72` gives every test worker a `TMPDIR` under the system one. `scripts/check-artifact.mjs` has no
  session check; there is no packed-artifact job (the test job runs `bun test` before `bun run build`);
  `scripts/build-cli.mjs` has no externals; `packages/cli/package.json` has no `optionalDependencies`.
- AGENTS.md says of the human-only commands "they refuse to run without a terminal and ask for a confirmation";
  `docs/session-formats.md:12` lists `stdout.txt` and `stderr.txt` for every session and `:38` names the PTY mode
  and `attach` as not built.
- The TUI workers are `claude -p` (`packages/cli/src/claude-worker.ts:151`) and cannot be attached; an interactive
  worker is TASK-EKAV. This task gives `attach` only to sessions started with `agent exec --pty`.
- `spikes/kdjs-m0/NOTE.md` is present; its PTY owner was `python3 pty.fork`, so nothing of the spike says the
  `@lydell/node-pty` packaging works.

## Step 1 (packaging): what the day-1 probes found

Taken on macOS 15 (darwin-arm64), Node 22.22.3, Bun 1.3.5. "Verified" means run here; the rest waits for CI.

- **The version pinned is `@lydell/node-pty` 1.1.0**, the last release that is not a beta (January 2025). The
  registry's `latest` tag points at `1.2.0-beta.18`; a beta was not taken. The person may prefer it.
- **Licence (verified against the registry and the installed files):** the module and its six platform packages
  (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`) all declare MIT.
- **Plain Node (verified):** the module loads and `sh -c 'stty size'` in a terminal of 100x30 answers `30 100`,
  through the loader too (`pty-check --spawn` run from source under Node, outside the agent sandbox).
- **Bun (verified, darwin only):** the module **loads** under Bun 1.3.5, but a spawned terminal reports neither
  data nor an exit (four spawns, each silent for 5 s). So the real tests cannot run from source, as the plan
  assumed, and the loader refuses under Bun before it loads anything. Linux under Bun: not checked.
- **musl (verified against the registry):** there is no musl package; `linux-x64` and `linux-arm64` carry no
  `libc` field, so they install on Alpine and fail at load. The probe refuses a Linux without glibc by name
  (Alpine, musl). Not run on an Alpine machine.
- **A command that cannot be executed (verified, darwin):** `spawn` does not throw. A missing executable and a
  file that is not executable both give a child with a pid that exits with `exitCode: 1, signal: 0` and no
  output. So the holder's own lookup before the spawn is needed, as the plan says. Linux: not checked.
- **A signalled child (verified, darwin):** `onExit` gives `exitCode: 0, signal: 15` (a number), as the plan
  expected for `tA_pty_signal_number_mapped`.
- **`spawn-helper`:** only the darwin packages ship and use it (`unixTerminal.js` resolves it on darwin only);
  bun installed it with mode 0755 here. The probe checks it on darwin only.
- **The agent sandbox (verified):** the module loads, every spawn throws `posix_spawnp failed.`
- **Windows job with the frozen lockfile: not verified.** `bun install --frozen-lockfile` passes on macOS with
  the new lockfile, and the lockfile holds the win32 packages with their `os` and `cpu`; only the CI run shows
  the Windows job.
- **Not run here:** `bun run build`, `scripts/check-pty-artifact.mjs` and the new lines of
  `scripts/check-artifact.mjs` (they need the built artifact and the network); the `pty` CI job.
- **Added beyond the plan's list:** an internal entry `kodel pty-check [--spawn]` in `main.ts` (not a CLI
  command, like `session-holder`), because the packaging checks must ask an installed kodel whether its loader
  works before any session code uses it.

## Steps 2 and 3 (core and local): what was built, and where it differs from the plan

Built: `pipeline-core/src/session-frames.ts`, `session-terminal.ts`, `session-socket-path.ts`, the `sock` field,
`size`, `attach`/`attachable`, `NOT_ATTACHABLE`, `trackBracketedPasteChunk`; `local/src/session-socket.ts`,
`attach-server.ts`, `session-pty.ts` (the trait and the holder's branch), the adapter changes in
`session-pipes.ts`; the CLI's holder entry hands the loader of `pty-loader.ts` to `holderMain`.

Where the code and the plan differ:

- **The hash of the socket name is handed in.** The core does not import `node:crypto` (`canonical.ts` says so),
  so `socketCandidates` takes a `hash` function; `packages/local` gives it sha-256.
- **The reset also shows the cursor (`CSI ?25h`), and the tracker follows mode 25.** A program that hides the
  cursor (Claude Code does) would leave the terminal without one after a detach. The tracker still follows
  exactly the modes of the reset.
- **The tracker also gives `reset()`**, the bytes that undo exactly the state it holds, beside the fixed
  `TERMINAL_RESET`. The fixed string switches mode 1049 off whatever the state, and xterm restores the saved
  cursor on that even when the alternate screen was not on; the client of step 4 can follow what it wrote with a
  tracker of its own and use `reset()` instead. Not decided here.
- **The chord matcher holds back the end of a read that may begin a chord or a paste marker** (a lone Escape
  too) and has `flush()`: the client of step 4 must call it after a short wait, or a lone Escape is delayed
  until the next key.
- **The end of a replay inside an escape sequence is held back** and joined with the first live bytes
  (`splitOpenEscape`, `joinHeldEscape`), so a query cut by the moment of the attach is cut out as well. The
  filter also removes XTGETTCAP/DECRQSS and the window reports (`CSI 14-21 t`), beyond the plan's list.
- **A switch the ring's cut went through** is given back at the start of the replay (the tracker's carry), so
  the replay is prefix, carry, ring. Only CSI sequences are carried: an OSC cut by the ring's start replays as
  text (a limit for `docs/session-formats.md`).
- **A `HELLO` may come without a size.** Such a client does not show the terminal: no replay, no output, no
  resize. The adapter's `send` uses it, so sending text does not change the size of the terminal.
- **`send` for a PTY session goes through the socket** (`SEND`, answered with `SENT`): the holder follows the
  program's DEC 2004 switches, the adapter's process does not. A text longer than one frame (64 KiB) is
  `SPEC_INVALID`.
- **Input backpressure is counted, not measured.** `@lydell/node-pty` 1.1.0 does not say when a write has
  drained, so the trait calls `done` one turn of the loop after the write; the 64 KiB bound is exact against the
  trait, approximate against the kernel.
- **The adapter is given a probe (`ptyProbe`), the holder a loader**, as the plan's "Which process knows" says;
  at the end of steps 2 and 3 the CLI did not pass the probe yet. (Since step 4 it does: `agent exec --pty`
  starts a terminal session from the built artifact, and answers `UNSUPPORTED` only where the probe fails, as
  under Bun.)
- **The trait's `kill` signals the process group** and then the module's own `kill`; the PTY branch never calls
  `killTree` (a fake terminal has a pid no process has).
- **A squatted fallback folder refuses the whole bind**; only a temporary root that is missing or cannot be
  written is passed over to the next candidate.
- **Bun reports a refused connect to a unix socket as `ENOENT`** (Node: `ECONNREFUSED`), and Bun's `listen`
  replaces a stale socket file where Node answers `EADDRINUSE`. `probeSocket` reads `ENOENT` with the socket
  file still in place as stale under Bun only; the holder unlinks a stale leftover itself on both.
- **`SessionPlace` has `uid`** (the socket names and checks need it); `START_ERROR_OUTCOME` has the new code.
- **`session_test_names_carry_the_decision_id`** reads the test files named `session*`, `attach*`, `pty*` in the
  packages' test folders and `tests/pty`; its constant is `SESSION_TEST_ID`. The other files spell `tA_` out
  (the step 1 file keeps its own `ID`), so the rename is that constant plus a search for the literal.
- **The holder-exit tests run twice**, with a binder that binds nothing (everywhere) and with a real socket
  (skipped where a bind is refused). `tA_pty_final_record_drops_sock`, `tA_pty_send_enter_own_write`,
  `tA_pty_socket_modes`, `tA_pty_socket_missing_not_attachable` and `tA_pty_child_term_default` have a unit form
  here; their real-PTY forms stay with step 5.

Not done, and why:

- **No PTY golden was taken** (`session-pty.json`, `status-running-pty.json`, `status-exited-pty.json`,
  `status-killed-pty.json`): they come from a real holder, which needs the built artifact under Node and a PTY,
  outside the agent sandbox. Nothing was written by hand. Until they exist `tA_pty_fixtures_roundtrip` is
  registered as skipped, `status:sock` is listed as "in no fixture" in the key table, and the `sock` tests use
  the pipes goldens with the field added in memory. `tA_pipes_goldens_byte_identical` and the `--check` mode of
  `take-session-fixtures.mjs` belong to step 6.
- **In the agent sandbox** a unix socket cannot be bound and the process table cannot be read: there 11 tests of
  `session-socket.test.ts` and 6 of `session-pty.test.ts` are skipped with the reason. Run outside the sandbox
  (macOS, Bun) all of them pass. Nothing here ran under Node or with a real PTY.

## Steps 4, 5 and 6 (the client, the real tests, the fixtures and docs): what was built, and where it differs

Built: `packages/cli/src/attach-client.ts` (the client over a terminal trait, and `processTerminal`),
`kodel agent attach <name|id>`, `agent exec --pty`, the probe handed to the adapter (`pipesAdapter` gives
`probePty` by default); `tests/pty/` (`host.mjs`, `harness.ts`, `pty-session.test.ts`, `attach-client.test.ts`);
the session check in `scripts/check-pty-artifact.mjs`; the PTY part and `--check` of
`scripts/take-session-fixtures.mjs`; four goldens (`fixtures/session-formats/v1/*-pty.json`); the docs.

Where the code and the plan differ:

- **Node's raw mode is not raw for output.** `setRawMode(true)` leaves the terminal's output processing on
  (libuv keeps `ONLCR`), so a line feed from the session was drawn as CR LF: the first real run showed CR CR LF
  where the session had sent CR LF. A program that moves the cursor down with a bare line feed would draw wrongly.
  The client runs `stty -opost` on its terminal right after it enters raw mode (`processTerminal`, injectable);
  leaving raw mode restores everything libuv saved, which the real tests check with `stty -g` before and after.
  Without `stty` on the PATH the extra carriage returns stay. No new dependency.
- **The reset follows what the terminal was shown.** The client feeds a mode tracker of its own with the output
  and writes `terminalResetFor(state)` (new in core): the fixed `TERMINAL_RESET`, but the alternate screen is left
  only when the program had entered it (the open point of the step 2/3 notes), and one more kitty pop per push
  beyond the first. Every other mode is switched off whatever the tracker saw.
- **The visible line is written with the reset, before the drain**, then the input is read and dropped for
  150 ms (`ATTACH_DRAIN_MS`), then the terminal settings come back. A lone Escape is flushed after 50 ms
  (`ATTACH_ESCAPE_HOLD_MS`); a chord split over two reads further apart than that is not found.
- **Exit codes and lines.** `[detached]`, `[ended]` and `[killed]` exit 0, except `[killed]` for a holder that
  ended `holder_error`: its reason goes to stderr and the exit code is 1. A dropped socket, a refusal by the
  holder (too many clients, a client that does not read, another protocol version), `SIGTERM` and `SIGHUP` print
  `[detached: <name>]`, then the reason on stderr, and exit 1. A signal is not raised again, so the shell sees 1,
  not 143. `[killed]` is also printed for a holder that ended `holder_error`.
- **A blocked terminal blocks the client.** Node writes to a terminal synchronously, so a window that does not
  draw stops the whole client; the holder then drops it at 4 MiB of lag and the others go on
  (`tA_attach_client_blocked_stdout`). The `write() === false` path with pause and resume of the socket is there
  for an output that is not a terminal and is covered by a unit test only.
- **`attach <name|id>` resolves through `list()`**: an id first, then the name (case-folded), the running session
  before an ended one. `agent stop`, `rm` and `logs` still take an id only.
- **`exec --pty` prints one more line** (`attach with: kodel agent attach <name>`), and takes the first size from
  the starter's terminal.
- **`CliEnv` has `ptyProbe` and `platform`** (tests only), so the walk can stand on Windows and answer for a
  machine without the module. `tA_agent_exec_pty_is_not_in_this_build` is replaced by
  `tA_agent_exec_pty_refused_by_probe_names_the_reason`.
- **The real tests mostly do not use the host.** The adapter and the clients that speak the frames run in the
  test process (Bun connects to a unix socket); only the holder (Node, the built artifact) and the CLI on a PTY of
  its own (through `host.mjs`) are outside it. `host.mjs` resolves the module from the artifact's place, as the
  loader does; it does not call the loader. The client's pid is found with `pgrep -f`.
- **`tA_pty_passes_session_contract` is one test** that runs the ten rows of the testkit table and then the
  negative row (`tail` of one stream is `UNSUPPORTED`) itself; `packages/testkit/src/session-contract.ts` was not
  changed.
- **The child of a session gets no `KODEL_STATE_DIR`** (every `KODEL_*` of the starter is dropped, and a spec may
  not set one): the tests of a human-only command inside a session name the state folder in the script.
- **The PTY goldens are taken through the adapter, not through `agent exec --pty`**: that command needs a
  terminal. The holder is the built artifact on Node. For `status-killed-pty.json` (`holder_error`) the script runs
  that holder itself on a published folder, because a starter removes such a session at once; the record is the
  holder's own.
- **`--check` compares content, not bytes**, and ignores what differs between systems without being the format
  (`machine`, an identity's `boot`, its `method`). The goldens were taken on macOS; the Linux half of the check is
  proven only by the CI job. The mask now also covers `machine`.
- **A golden is rewritten only when its content changed**, and the script's own JSON layout is not Biome's: run
  `bunx biome format --write fixtures/session-formats` after a golden was written.
- **The CI `pty` job** now also runs `bun test tests/pty` and `take-session-fixtures.mjs --check`; the scripted
  session check runs once, on the `npm install` of the packed CLI.

Not done, and why:

- **The hand check (step 7)** is the person's.
- **Nothing ran on Linux.** Everything real was run on macOS 15 (darwin-arm64), Node 22.22.3, Bun 1.3.5, outside
  the agent sandbox. The CI job has not run.
- **`bun run lint` and the whole `bun test` were not run** (only the files touched). Biome reports
  `useRegexLiterals` warnings in `session-terminal.ts`; they are from step 2 and on purpose (its comment says why).
- **The rename of `tA_`** waits for the decision id.

## PR description (draft)

**PTY holder and attach for sessions: `kodel agent attach` (TASK-HN8N)**

The session holder learns `mode: pty`, serves an attach socket, and `kodel agent attach <name|id>` (for a person)
connects a terminal to it: resize, detach on `Ctrl+\`, terminal reset, a 1 MiB replay with the modes the program
had on, several clients. `kodel agent exec --pty` (hidden) starts such a session. Sessions on pipes are untouched
and work without the new dependency. Limits are in `docs/session-formats.md`; the accepted gap of a decision
dialog inside a terminal session is in `docs/decisions.md`.

**New dependency: `@lydell/node-pty` 1.1.0** (exact pin, `optionalDependencies` of `packages/cli`, external to the
bundle, imported only by the holder of a terminal session).

- Why: a PTY needs native code (`forkpty`); Node has none built in. This fork ships prebuilt binaries per platform
  as optional packages, so an install compiles nothing and needs no toolchain.
- Why optional: where it is missing or unusable every other command works, and `exec --pty` answers `UNSUPPORTED`
  with the reason (`scripts/check-pty-artifact.mjs` installs with `--omit=optional` to prove it).
- Not supported: Windows, a Linux without glibc (Alpine/musl: no binary package), kodel from source under Bun.

| Package | Version | Licence |
|---|---|---|
| `@lydell/node-pty` | 1.1.0 | MIT |
| `@lydell/node-pty-darwin-arm64` | 1.1.0 | MIT |
| `@lydell/node-pty-darwin-x64` | 1.1.0 | MIT |
| `@lydell/node-pty-linux-arm64` | 1.1.0 | MIT |
| `@lydell/node-pty-linux-x64` | 1.1.0 | MIT |
| `@lydell/node-pty-win32-arm64` | 1.1.0 | MIT |
| `@lydell/node-pty-win32-x64` | 1.1.0 | MIT |

MIT is compatible with Apache-2.0; `scripts/check-licenses.mjs` pins this table against `bun.lock`.

**Day-1 answers** (macOS; see "Step 1" above): the module loads under Bun but a spawned terminal is silent there,
so the holder and the real tests run on Node; there is no musl package; a command that cannot be executed gives a
child that exits 1, so the holder looks the program up first; a signalled child reports a number.

**Tests skipped in the pipeline's own run** (the agent sandbox has no PTY devices and refuses a unix socket; each
file prints `PTY tests skipped: N, <reason>`): the 39 real tests of `tests/pty/` (13 in `attach-client.test.ts`,
26 in `pty-session.test.ts`), and the 17 socket and process-table tests of `packages/local` named in the step 2/3
notes. By name: `tA_attach_client_clean_after_detach`, `_clean_after_exit`, `_clean_after_kill`,
`_ctrl_c_goes_to_child`, `_resize`, `_blocked_stdout`, `_sigterm_restores`, `_sighup_restores`,
`_socket_dropped_exits`, `_drains_late_answer`, `tA_agent_attach_real_refusals_name_the_reason`,
`tA_pty_starter_returns`, `tA_pty_exec_no_such_cmd_frees_name`, `tA_pty_host_helper_selftest`,
`tA_pty_attach_echo`, `tA_pty_reattach_replay`, `tA_pty_detach_keeps_child`, `tA_pty_resize_reaches_child`,
`tA_pty_child_term_default`, `tA_pty_child_cwd_from_spec`, `tA_pty_child_umask_unchanged`,
`tA_pty_ready_after_listen`, `tA_pty_socket_modes`, `tA_pty_socket_missing_not_attachable`,
`tA_pty_final_record_drops_sock`, `tA_pty_socket_removed`, `tA_pty_stale_sock_after_sigkill`,
`tA_pty_holder_killed_child_hup`, `tA_rm_unlinks_only_derived_sock`, `tA_pty_socket_primary_and_fallback_bind`,
`tA_pty_tmpdir_differs_between_holder_and_client`, `tA_pty_send_paste_only_with_2004`,
`tA_pty_send_enter_own_write`, `tA_pty_no_raw_bytes_on_disk`, `tA_pty_logs_stripped_and_redacted`,
`tA_pty_tail_redacts_split_and_echo`, `tA_pty_session_refuses_human_commands`,
`tA_pty_attach_refuses_inside_session`, `tA_pty_passes_session_contract`.
Run by hand outside the sandbox on macOS (darwin-arm64) with `KODEL_REQUIRE_PTY=1`: all 39 passed, as did
`scripts/check-pty-artifact.mjs` and `take-session-fixtures.mjs --check`. The proof for Linux is the CI `pty` job
(ubuntu and macos), which has not run yet.

**Hand check (the person, before the merge):** attach, detach and re-attach with a real Claude Code, once after
enough output to wrap the replay; `Ctrl+]` reaching Claude Code; the terminal clean after a detach, a kill and the
agent's own exit; the terminal app and versions written down; the `pty` job marked required in branch protection.

## Review round (after the implementation)

An independent review of the change found the defects below. Each fix has a test that fails without it (checked
by putting the old behaviour back).

Fixed:

1. **A query split by the ring cut came back in the replay.** The tracker's carry was sent unfiltered in front of
   the ring. The carry and the ring are now one stream that is split (`splitOpenEscape`) and filtered
   (`stripTerminalQueries`) together, so a query across the cut, or one that the carry, the ring and the first
   live bytes make, never reaches the attaching terminal. `tA_replay_no_query_across_ring_cut` (the probe, every
   query kind with the cut at every byte, and the three-part case).
2. **`SEND` frames passed the input bound.** A queued send now counts its payload as input the terminal has not
   taken (the same 64 KiB), and the client's stream is paused until it is written.
   `tA_attach_send_flood_paused_at_bound` (200 sends of 60 KB: at most two are held at once).
3. **The redaction margin of the tail was counted in raw bytes.** When the tail lost its beginning, the first
   1 KiB of the stripped and redacted text is now dropped, so the start of an escape-heavy tail is never the
   second half of a secret. `tA_pty_tail_margin_in_stripped_text`. The price: such a tail may be up to 1 KiB
   shorter than it could be.
4. **The cut-key rule ran before the strip.** `stripThenRedact(chunks, rules, cut)` now runs it after.
   `tA_tail_cut_private_key_after_strip`, `tA_pty_tail_cut_key_after_strip`.
5. **`tA_status_sock_ignored_same_status` and `tA_status_sock_dropped_reencode_same_status` could not fail.** The
   core tests now hand `deriveStatus` the whole decoded record and take the record through a schema without
   `sock`; the test of the second name in `packages/local/test/session-socket.test.ts` writes a record with
   `sock`, rewrites it as an older build would, and asserts that `attachable` then says "the record names no
   socket" (and said something else before).
6. **Input was decoded as UTF-8.** `PtyChild.write` takes bytes and hands them to the module as they are (the
   module's `write` passes its argument to a socket; its typings name a string only).
   `tA_attach_input_bytes_unchanged`, `tA_pty_input_bytes_unchanged` (real: `od` in a raw terminal).
7. **OSC 52 with `?`** (the clipboard read back) is a query the replay drops.
8. **`RESIZE` from a client that declared no size** ends that client (`protocol`).
   `tA_attach_quiet_client_resize_refused`.
9. **`SIGINT` and `SIGQUIT`** end the client as `SIGTERM` and `SIGHUP` do (`ATTACH_SIGNALS`); the end of the
   terminal's input is reported as that, not as a signal. `tA_attach_client_sigint_restores` and
   `_sigquit_restores` (real) join the two that existed.
10. **Docs.** Windows answers `PLATFORM_UNSUPPORTED`; a stale build skips the real tests (and fails only with
    `KODEL_REQUIRE_PTY=1`); the comment of `requireHuman` says it is a guard against mistakes.
11. **CI.** The `pty` job also runs `bun test packages/local` with `KODEL_REQUIRE_PTY=1` and
    `KODEL_REQUIRE_PROCTABLE=1`, so the socket and process-table tests there cannot skip on Linux and macOS.
12. **Scripts.** `check-pty-artifact.mjs` stops the smoke session on a failure partway (its exit handler runs the
    script again as `--stop`, which gives `agent stop` a terminal and types the answer); `take-session-fixtures.mjs`
    fails with a reason when the session of the hand-run holder was never published.
13. **`tA_new_modules_import_on_windows`** imports the new modules in a process of its own under spies on
    `process.getuid`, `process.stdin` and the registration of signals, and checks that the spies do see those.

Smaller:

- `resolveSession` answers `CANNOT_READ` or `NEWER_FORMAT` for a session that is there but cannot be judged
  (`tA_agent_attach_unreadable_session_names_the_reason`).
- `tA_session_env_keeps_engine_flag` did not exist; it is now in `packages/local/test/session-pty.test.ts`
  (`sessionEnv` of a shell with other `KODEL_*`, through the holder, to the environment of the spawn).
- Deviation from "Affected files": `packages/testkit/src/session-contract.ts` got no PTY row. The PTY session runs
  the table as it is, and its one negative row is in `tests/pty/pty-session.test.ts`
  (`tA_pty_passes_session_contract`).

Not changed, and why:

- **Pipes mode has the weakness of finding 3 in a milder form** (`session-holder.ts`: the margin is cut off only
  when the redacted text is still longer than the tail, and many redactions make it shorter). It is older than
  this task and outside its diff; it wants a task of its own.
- **Frames that arrive in one read with the frame that reaches the bound are still taken** (input and `SEND`
  alike): the pause stops the stream, not the frames already decoded. The excess is one read of the socket.

## Review round 2

A second review found the defects below. Each fix has a test that fails without it (checked by putting the old
behaviour back; for the two that need a real terminal, with a build of the old behaviour).

Fixed:

1. **The cut of a query could make a query** (`ESC[` + `ESC[6n` + `6n`). `stripTerminalQueries` repeats the cut
   until nothing is found, at most `QUERY_STRIP_PASSES` (16) times; a text that still holds a query after that
   loses every escape character. The replay is made by `splitReplay`: after the cut, a sequence left unfinished
   in front of the held end is dropped (the live bytes could finish it into a query), and `joinHeldEscape` cuts
   every query that begins in the held part, also the one its own cut makes. A query of the live bytes alone
   stays. `tA_replay_strips_terminal_queries` (nested CSI, OSC 52 and APC, deep nesting, a megabyte of it, and
   the same through `AttachServer`).
2. **The 64 KiB input bound did not hold with the real module.** `PtyChild.write` reported a write as taken
   after one turn of the loop. It now reports when the module's stream calls back. What the real terminal showed
   on macOS is worse than the review said, and is fixed too: the stream there does not queue, it tries the write
   again without end in the loop's own thread, so a raw terminal whose program does not read (room for about a
   kilobyte) stopped the holder until the program read. On macOS the holder now writes to the terminal's
   descriptor itself (`descriptorWriter`: in order, what found no room is tried again after 2 to 50 ms, nothing
   after the stream is destroyed). `tA_attach_input_flood_paused_at_bound` (the trait over a stream that calls
   back late; the writer over a full pipe; and on a real terminal: 96 MiB typed into `sleep`, the holder grows
   by less than 32 MiB, the client stays paused, another client attaches).
3. **The holder ended with the `BYE` still queued.** It now waits for its clients' connections to close
   (`BoundSocket.flushed`, at most `ATTACH_FLUSH_MS`, 1.5 s) before it writes the final record and ends.
   `tA_bye_flushed_before_holder_ends` (the holder's order, the bound socket, and a real client that reads late).
4. **Bracketed paste set together with other modes** (`ESC[?1049;2004h`) is followed, also across a chunk
   border. `tA_track_bracketed_paste_combined_modes`.
5. **The check of the test names** took any name that began with the text `${ID}`. The file must now declare
   `const ID` with the id as its value.
6. **`resolveSession`** no longer takes a reference that is no name (`../x`, `-x`) for the unreadable row that
   has no name.
7. **CI.** The `pty` job has `timeout-minutes: 30`.
8. **`check-pty-artifact.mjs`** types only after the replay of the session's first line (the client is raw by
   then), and removes the `kodel-<uid>` socket folder it made, when it made it and it is empty.
9. **`SIGTSTP`.** Not handled; `docs/session-formats.md` says that a client killed or stopped from outside leaves
   the terminal as it was (`Ctrl+Z` typed while attached is a byte for the agent).
10. **More queries are cut:** the kitty graphics query (`ESC _ G ... a=q ... ESC \`) and the window reports with
    a second parameter (`CSI 14 ; 2 t`).

Not changed, and why:

- **A client that said hello without a size holds one of the 8 places for as long as it stays connected.** An
  idle limit needs a new reason in `BYE` and a timer per client; it is a limit for now, written down here. Only
  a process of the same user can connect.
- **`SEND` is not held back by a program that does not read.** A send is reported when it is handed to the
  terminal's writer, not when the terminal took it, so sends to a program that reads nothing queue in the holder.
  Making `send` wait would change what `SessionAdapter.send` (the send of an engine step; there is no `send`
  command) answers for a program that is busy; it wants a decision of its own.
- **A query longer than 64 bytes that the end of the replay cuts in two** (a long OSC 4 or XTGETTCAP) is not
  held back: the held end is at most 64 bytes, as before.
- **Linux.** The real-terminal tests of this round ran on macOS only here; on Linux the write goes through the
  module's stream with its callback (the fake covers that path), and the CI `pty` job is what runs it for real.

## Review round 3

A third review found the defects below. Each fix has a test that fails without it (checked by putting the old
behaviour back in the source and running the test).

Fixed:

1. **`SEND` was not held to the 64 KiB bound by a program that does not read** (the item round 2 left open).
   `AttachServer.send` now hands both writes (the paste and the submit key) to the terminal with a `done`, and is
   over only when the terminal has taken them, or the session ended; the paste gap and Enter as a write of its
   own are as before. `tA_attach_send_flood_paused_at_bound` runs with a child that takes nothing (200 sends of
   60 KB: one write reaches the child, none is answered, the stream stays paused at two frames), and has a real
   form in `tests/pty` (a raw terminal under `sleep`: no `SENT`, most of the flood still on the client's side).
   What changes for a caller: `SessionAdapter.send` (the send of an engine step; there is no `send` command)
   to a program that reads nothing is answered only when the terminal took the text, so past the terminal's own
   buffer it gives up after its 10 seconds with `NOT_RUNNING` ("did not answer the send"), although the session
   is still running, and a send behind it waits its turn. A written limit: a send whose client gave up stays in
   the queue and is typed when the program reads again, so a caller that retries has its text typed twice.
2. **The holder had ways out that skipped `leave()`.** Everything after the bind runs inside one `try`/`finally`
   (`holdTerminal`): an unexpected throw kills the child, writes `killed/holder_error` when the record is still
   the holder's, says the boot line when `ready` was not said yet, and the `finally` tells the clients and
   removes the socket. `SIGTERM` and `SIGHUP` to the holder (`HOLDER_SIGNALS`) stop the child as `stop` does
   (`SIGTERM`, then `SIGKILL` after the grace) and the session ends on the normal path with `killed`, reason
   `stopped`. The last record write is inside a `try`. `tA_pty_holder_signal_stops_the_child_and_names_the_signal` (fake, and real for
   both signals), `tA_pty_holder_real_signal_listeners_are_removed`,
   `tA_pty_socket_unlinked_on_unexpected_throw`, `tA_pty_final_record_write_failure_is_not_a_crash`. Not covered:
   a throw inside a timer or a listener (an uncaught exception of the process, not of this function), and
   `SIGKILL`.
3. **`descriptorWriter` wrote by a descriptor number that could have been reused.** On macOS the writer now has
   a descriptor of its own (`duplicateDescriptor`: `/dev/fd/N` opens as a duplicate there), which nobody else
   closes; it is closed when the module's stream reports `close`, and never while a write is with the system
   (`close()` waits for it and ignores what it did). Where a duplicate cannot be had the old guard stays (`gone`
   asked before every write). `tA_pty_writer_never_writes_to_a_reused_descriptor` (the module's number is closed
   and reused while a write is owed: the bytes reach the terminal, the stranger's file stays empty; needs
   `/dev/fd`, so it skips in the agent sandbox and fails there with `KODEL_REQUIRE_PTY=1`),
   `tA_pty_writer_close_waits_for_the_write_on_its_way`. `duplicateDescriptor` must not be used on Linux (it
   would open another terminal); the default there is the module's stream, as before.
4. **`FrameDecoder.push` copied its whole buffer for every chunk.** It appends into a store that doubles;
   `moved()` counts the bytes copied. `tA_attach_frames_dribbled_stay_linear` (six 64 KiB frames a byte at a
   time: at most four copies of each byte, where the old code moved 2 GiB a frame).
5. **More queries are cut from the replay:** `ESC Z`, device attributes and XTVERSION with any number of zeros,
   DECREQTPARM (`CSI x`, `0x`, `1x`), `CSI 11 t`, XTQMODKEYS (`CSI ? Pp m`), DECRQPSR (`CSI Ps $ w`), `CSI # R`,
   XTSMGRAPHICS (`CSI ? Pi;Pa;Pv S`), OSC 5 with `?`, and a kitty graphics command that names an image (`i=`,
   `I=`) without `q=1` or `q=2`. The patterns are joined behind one escape character and one `[` or `]`, so the
   megabyte case of round 2 stays well inside its bound. In `tA_replay_strips_terminal_queries`: each kind
   whole, at every split, and nested in another.
6. **The mode tracker follows DECSTR** (`CSI ! p`): the cursor shows again, cursor keys and keypad are as at the
   start; the other modes stay. `tA_mode_tracker_follows_soft_reset`.
7. **Test names of the plan that "exist nowhere".** Six of them exist, written with the `${ID}` constant or in a
   loop, which a search for the literal name misses: `tA_pty_absent_no_child`, `tA_pty_loader_refuses_under_bun`,
   `tA_pty_spawn_helper_not_executable` (`packages/cli/test/pty-loader.test.ts`), and
   `tA_attach_client_sigterm_restores`, `_sighup_restores`, `_sigint_restores`, `_sigquit_restores`
   (`tests/pty/attach-client.test.ts`, one per entry of `ATTACH_SIGNALS`). `tA_ci_workflow_declares_pty_job` was
   dropped by decision ("Rejected review findings") and is in no table. `tA_agent_exec_pty_is_not_in_this_build`
   is replaced by `tA_agent_exec_pty_refused_by_probe_names_the_reason` (said in "Affected files" and in the
   notes of steps 4 to 6).
8. **Scripts.** `check-pty-artifact.mjs` also sends pnpm's cache and state to the temporary folder
   (`npm_config_cache_dir`, `npm_config_state_dir`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`).
   `check-artifact.mjs` looks for names the module's JavaScript really has (`UnixTerminal`, `WindowsPtyAgent`,
   `ConoutConnection`, `conpty_console_list_agent`); `posix_spawnp` is only in the native code and could never
   be found. `tA_check_artifact_bundled_module_names_are_real` compares the list with the installed module and
   with kodel's own sources; `tA_check_pty_artifact_keeps_installers_out_of_home`.
9. **The client could stay raw after a throw at the first write.** The `HELLO` write is inside a `try` that ends
   the client as a lost connection (reset, line, settings back), and `finish` survives a `close` that throws.
   `tA_attach_client_failed_hello_leaves_no_raw_terminal`.
10. **`exec --pty` read `process.stdout` for the first size.** It asks the context (`AgentContext.terminalSize`,
    `CliEnv.terminalSize`), with this process's terminal as the default. Checked inside
    `tA_agent_exec_pty_refused_by_probe_names_the_reason`.
11. **Plan and goldens.** The stale sentences are corrected (the probe in the notes of steps 2 and 3; `[killed]`
    with `holder_error` exits 1). `status-stopped-pty.json` is a new golden, taken by the script from a session
    that `stop` ended, and `--check` covers it.

Left as a note:

- **The loader's assumption about the module's `exports` field** (that `@lydell/node-pty` and its platform
  package resolve from the artifact's place under every installer) is proven only by `check-pty-artifact.mjs`
  in the CI `pty` job; its first run there is the proof.
- **Linux.** As in round 2, the real-terminal tests of this round ran on macOS only here.

## Review round 4

A fourth review found the defects below. Each fix has a test that fails without it (checked by putting the old
behaviour back in the source and running the test).

Fixed:

1. **The two kitty graphics patterns were quadratic on a command with no end** (16 KiB took 0.2 s, 128 KiB
   13 s, and the replay filters a 1 MiB ring). Both now ask for the end of the command first, once
   (`KITTY_ENDS`, a lookahead), so a comma is never a place to read on from to the end of the text. Every other
   pattern on output was measured with a megabyte of hostile text per family (no end, the introducer repeated,
   the separators repeated, nested, cut into chunks) through `splitReplay`, `stripTerminalQueries`,
   `joinHeldEscape`, the mode tracker, the paste tracker, the chord matcher and `stripThenRedact`. The patterns
   of `session-terminal.ts` are linear. Two rules of `redact.ts`, which the tail goes through, were not:
   `private-key` (every header with no footer read to the end of the text) and `jwt` (every `-eyJ` inside one
   long word read that word again). Both now match the failed case too and put it back unchanged, so the search
   goes on after it; what they redact is the same. The `assignment` rule is linear but slow (about 2.5 s for a
   megabyte of `token.`), bounded by its `{0,64}` parts; left as it is. `tA_terminal_patterns_stay_linear`
   (64 KiB under a second, then 512 KiB in at most 24 times the 64 KiB time, then a megabyte under 5 s), and
   the same for the two rules in `redact.test.ts`.
2. **A signal between the bind and the spawn killed the holder.** The holder listens for `HOLDER_SIGNALS` right
   after the bind; a signal seen before the child exists starts none, and the session ends `killed`, reason
   `stopped`, with the socket removed. `tA_pty_holder_signal_before_spawn_starts_no_child`.
3. **A signal after the child ended by itself turned `exited` into `killed`** and could signal a process group
   that was no longer the child's. Once the exit is seen `stopChild` does nothing and the signal is not
   recorded. `tA_pty_holder_signal_after_exit_changes_nothing`.
4. **A client that died while paused at the input bound kept its place.** A stream that is not read reports no
   end, so the holder writes a paused client an empty `OUTPUT` frame every 5 s (`ATTACH_PAUSED_PROBE_MS`); the
   write to a closed peer fails and the place is free. `tA_attach_paused_client_that_died_frees_its_place` (a
   fake stream that tells nothing until written to, and a real socket).
5. **Docs.** There is no `agent send` command: the texts name `SessionAdapter.send`, say that its timeout answers
   `NOT_RUNNING` for a session that still runs, and that a send still queued after its caller gave up is typed
   later (a retry types twice).
6. **AGENTS.md.** `agent exec` asks for no confirmation either; the sentence says which commands do.
7. **A `BYE` with `holder_error` and no text ended `agent attach` with exit 0.** It now has a fixed text
   (`HOLDER_ERROR_TEXT`). In `tA_attach_client_reset_and_line_on_every_way_out`.
8. **The harness of `tests/pty` left `kodel-<uid>` behind.** `world({ longBase: true })` removes the folders
   that were not there before it, and only while empty.
9. **The loader looked in more places than it loaded from.** The probe used `createRequire().resolve`
   (`NODE_PATH`, folders of the home directory), the load `import()` of the bare name. The load now imports the
   file the same lookup finds. `tA_pty_loader_loads_what_the_probe_found` (on Node, with `NODE_PATH`).
   `check-artifact.mjs` runs "the bundle alone" without `NODE_PATH` and with the empty folder as home.

## Review round 6 and the end of Windows in CI

- **Windows is no longer tested in CI** (the person's decision after round 6): the `test` matrix is Linux and macOS, and
  `AGENTS.md`, `README.md` and `tests/README.md` say so. Several tests that already existed were red on Windows
  (`agent.test.ts` at HEAD among them), and no `kodel agent` command runs there yet (`PLATFORM_UNSUPPORTED`). The
  `win32` skips in the new tests and the `CliEnv.platform` hook stay, so Windows can come back without a rewrite. The
  plan's earlier lines about the Windows job staying green (steps 1 and 6) no longer apply.
- Fixed in this round: the descriptor test of the writer runs on macOS only (on Linux a re-opened FIFO blocks for
  good); `trackBracketedPaste` follows a full reset (`ESC c`); the unexpected-throw path of the holder does not signal a
  process group once the child's exit was seen; the six `agent.test.ts` tests stand on a POSIX platform or are
  `unixTest`; `take-session-fixtures.mjs` also stops a session that is still `starting`.
- Not changed: the holder's SIGTERM/SIGHUP listeners are registered after the bind, so a signal during `parts.load()`
  or the bind takes the default action (the record becomes `lost`, a bound socket is swept by the next `stop`/`rm`).

## First CI run: the write to a terminal on Linux

- The `pty` job on ubuntu failed `tA_attach_input_flood_paused_at_bound` and `tA_attach_send_flood_paused_at_bound` (the
  second client of each test, attached after the flood, never got a frame), and `tA_pty_input_bytes_unchanged`. On
  Linux in a container (Debian, arm64) the same two flood tests failed, and so did `tA_bye_flushed_before_holder_ends`.
- Cause, seen with `strace` and a small script: the module's stream writes to a terminal opened for reading and
  writing through libuv's blocking path, so on a program that does not read the holder's main thread answers `EAGAIN`
  to `write(2)` without end (state `R`, a core busy) and serves nobody. Round 3's "on Linux the write goes through
  the module's stream and is non-blocking" was read from the module's code and was wrong. `setBlocking(false)` on the
  stream's handle returns 0 and changes nothing; `fs.write` on the master's descriptor with a retry on `EAGAIN` keeps
  the loop alive.
- Fixed: `ptyFromModule` writes by descriptor on every POSIX system (`ownWrites` defaults to true). A duplicate of the
  descriptor exists on macOS only (`/dev/fd/N` of a master side opens another terminal on Linux), so on Linux the
  writer takes the module's own number and relies on `gone()` (the hazard is written in `descriptorWriter`). New test:
  `tA_pty_default_writes_by_descriptor_on_every_system`.
- Checked on Linux after the fix (Debian arm64, glibc, not root, `KODEL_REQUIRE_PTY=1`): `tests/pty` 48 pass, 0 fail
  (it was 45 pass and 3 fail); the local holder tests 89 pass, 1 skip (the macOS-only descriptor test).
  `tA_pty_input_bytes_unchanged` passed on Linux arm64 before the fix too; it failed only on the ubuntu x64 runner, so
  whether this fix reaches it is for the next CI run to show.

## The late reader on Linux (CI, ubuntu `pty` job)

- `tA_bye_flushed_before_holder_ends` failed on the ubuntu runner and in a Linux container with two CPUs (5 of 5, and
  4 of 6 in a timeline run), after the write fix. The client had 2,995,000 of 3,000,022 bytes; the holder's own
  `tail.txt` lacked `LAST-LINE` too, so the end was lost before the holder read it, not on the way to the client.
- Measured: a bare reader of the module loses nothing on the same output (0 of 12, with or without a slave
  descriptor held open), and the holder is idle half the time (a CPU profile), so it is neither the module's 200 ms
  socket timeout nor a starved loop. What is left is the kernel: when the session leader ends, the hangup of its
  terminal flushes what was written towards the master and has not been read (`pty_flush_buffer`). A reader that is
  a few kilobytes behind at that moment loses them.
- A progress-based wait in `flushed` and in `socketStream.close()` was tried and taken out again: it was not what
  fixed this, and under Bun (the test runner) the queue of a stream is not reported as Node's, so it could not be
  shown by a test. The 1.5 s bound stays.
- The test now has the program wait a second before it exits, and `docs/session-formats.md` says that on Linux the end
  of a burst of output at the moment a program exits can be lost.

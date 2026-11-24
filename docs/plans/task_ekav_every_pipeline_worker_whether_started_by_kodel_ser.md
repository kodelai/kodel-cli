# Every pipeline worker is a terminal session a person can open and leave (TASK-EKAV, with TASK-K6MA and TASK-DSKQ)

## TL;DR

- **What, in one run, for claude only:** the one worker launcher (`openWorkerLauncher`, used by the TUI and by
  `kodel serve`) starts `claude` as an interactive program in a PTY session (`kw-<run>`) when the profile says
  `worker: terminal`, and as today's `claude -p` when it says `print`; nothing switches between the two by
  itself. A terminal worker stays alive at a gate; `o` on a run row opens it and `Ctrl+\` brings you back **to
  the same place in the TUI**. Also: `kodel agent start | prune | doctor`, `exec --pty --attach` (TASK-K6MA),
  the agent's own session id stored, listed and used to bring back a stopped session (TASK-DSKQ), and the
  override of the `claude` profile in the one `engines:` block. **Codex and opencode as engines are moved to
  a follow-up task (to be created; step 13 lists what it gets).**
- **Cost:** about 12.5 working days in one run (11 before this round: +0.5 the process-group rule with an
  identity and a stop that reaches it, +0.5 the guard of your commands inside a session, +0.5 the rest). One
  new record file in the unfrozen session format v1; no run format change; new keys in `engines` only.
- **Risky:** (1) nothing about an interactive `claude` in a PTY is proven: step 1 is a spike with the real
  program, outside the sandbox, and **a stop**. (2) With the default `worker: terminal` (your answer), a
  start from this repository's own `bun … tui|serve` is refused until you run the built file or commit
  `worker: print`. (3) No budget cap; a session lives up to 7 days.
- **What this critique changed (round 6; 48 findings: 40 fixed, 7 rejected, 1 is yours below):**
  - **An agent left behind a dead wrapper** is told from a stranger (no group member counts after a restart
    of the machine, or when another process took the group's number), `kodel agent stop` names its processes
    for the person to end (kodel never signals a group without its live leader), and a
    process table that cannot be read falls back to today's rule: nothing is held for good.
  - **A `-p` worker that waits at a gate during the update is still resumed:** with no `agent.json` its id
    is read from its argv; `print` workers get the record too.
  - **Your commands inside a session:** a PTY worker has a terminal, which `-p` never had, so `gate`, `ack`,
    `seal` and the other person's commands now also refuse when a parent process is a kodel session's
    holder. "Open to the agent: nothing" was wrong and is rewritten with what stays open.
  - **`stalled_after_s` keeps its meaning** (quiet): a terminal worker is stalled when it printed nothing
    **and** called nothing for that long. **`o` from a TUI under Bun** is refused with the command to run.
    **The default becomes `terminal` only in the last commit of step 8**, after the serve rule is in.
  - `counts.workers` of the serve record keeps today's meaning (places used); the new field is `alive`.

## Decisions needed

1. **The follow-up task (codex and opencode) is not in your tracker** (scope-10). I recommended creating it
   with `task_create` in step 12, from the text of step 13. **It was not created:** the session that did
   step 12 had no task tools. Step 13 stays a text for you to file; once it is a task, `kodel serve` starts
   nothing from it until you run `kodel task approve`.

Decided (your answers, not reopened):

1. **The setting and its default (A).** `engines.<name>.worker: terminal | print`, in the one `engines` block
   (yours only, used in its committed version); **`terminal` when the key is absent.** Under Bun no PTY runs,
   so `s` in `bun … tui` and a start by `bun … serve` are refused with `a terminal session cannot run under
   Bun: use the built kodel on Node` (no attempt used, no run made) until you start the built file or commit
   `engines: { claude: { worker: print } }`. The same refusal meets every machine with no PTY
   (`pty-loader.ts:93-125`); it spells the line to add, and `docs/changes.md` gets the migration note.
2. **Codex and opencode: a separate task; this run does claude only.** `worker:` or `terminal:` on a profile
   not named `claude` is refused when the config is read (`engines.<name>: only claude can be a worker in
   this version; codex and opencode are a follow-up task`).
3. **Which engine a worker uses (A),** moved by me to the follow-up because one engine exists:
   `serve.start[].engine`, the question of `s` and `agent start --engine` are not built here (an unknown key
   and an unknown flag, as today). What is stored already names the engine (`agent.json`), so adding them
   later changes no format.
4. **`agent doctor` (A): seven checks.** Platform; can a terminal run; `claude` found, its version, signed in;
   trust of the worktrees folder; `decisions.dialog` and `decisions.agent`; the `engines` block against
   `HEAD`; the verdict "a worker can start: yes or no, why".

Earlier answers: one run with the spike as a stop; K6MA in; all of DSKQ in; `kodel agent start --resume
<id|name>` keeps the name; a waiting worker holds no `max_workers` place; a worker your decision wakes over
`max_workers` goes on, and the daemon adds nothing while over and says so once; stop at once when the run
ends; no fallback; a worker you stopped is not resumed by the daemon (the TUI offers `s`); `agent start
--pipeline` makes a run with no task; key `o`; the override in `engines.<name>.terminal`, committed version
only; kodel makes the run itself; test id T-47; `kodel mcp` by hand in `Bash` recorded as accepted in
`docs/decisions.md`; no automatic wake-up.

## Behaviour change

- **The mechanism is a setting.** `engines.<name>.worker: terminal` starts the engine in a terminal of its
  own (`kodel agent ls` shows `kw-<run>`, mode `pty`); `print` starts today's `claude -p`. Where the chosen
  one cannot run (a PTY under Bun, the optional package or its binary missing, a holder that cannot open a
  terminal), the start is refused with the reason: a notice in the TUI and `cannot start: <reason>` on the
  row, an environment line of the daemon (no attempt used). Nothing falls back.
- **Open and come back to the same place.** `o` on a run row or card: the TUI leaves the screen, your
  terminal is the agent's, `Ctrl+\` brings the TUI back exactly as you left it: the same screen and tab, the
  same selected run, the same open card and its scroll, the same list scroll, filter and picked decision;
  only the data is fresh and a notice carries the agent's last line. The same holds when the agent ended
  while you were in it. **A TUI that runs under Bun does not open a worker** (the handover of the terminal
  is built and tested on Node only): `o` there leaves the screen alone and the notice spells `node <built
  kodel> agent attach <id>`. If the run you were on is gone from the list, the selection moves as on any refresh.
  The TUI opens the run's live record, also when that is `kw-<run>-d<seq>`. A `print` worker, or a child that
  cannot be started, answers with a notice and no flicker.
- **At a gate a terminal worker stays.** It tells what waits and starts `kodel wait` in the background; the
  row reads `agent waits with you`. Every waiting answer of its server spells the wait command again. After
  your decision it goes on within seconds, with or without a daemon or TUI. It cannot decide.
- **A worker that ended while its run waited for you** (it quit, a reboot, its 7-day timeout), and one that
  ended after your decision without having called the engine since, is resumed in a new session
  `kw-<run>-d<seq>`; one you stopped is not (the TUI offers `s resumes`). **A worker that ended after it had
  gone on** (the journal has an agent's line after your decision) is a dead worker: noted, counted, its
  `max_runs` place freed; the card says `agent died after your decision`; this needs both: it ended after
  your decision, and an agent called the engine after it. A worker that ended at the wait before your
  decision, whose run another agent then took on, stays what it is today (`an agent was served a step
  since`: no resume, no death, no count). A `lost` worker has no known end (its record only says when the
  loss was noticed), so it counts as ended after your decision only when it printed something after it;
  else it is the case before the decision. **An agent you quit from inside** (`/exit`, `Ctrl+D` while
  attached) is `exited`, not `stopped`: kodel does not read what is typed, so it is resumed like any worker
  that ended at a wait. `kodel agent stop` is the way to end one for good, and the notice on the return from
  `o` says so when the agent ended while you were in it.
- **A worker whose holder is gone while its process still runs** (the record says `lost` or `killed` with
  "child still runs") is never resumed and never treated as ended: it keeps both places, the daemon logs once
  `kw-…: its process still runs without a holder; stop it: kodel agent stop <id>`, the card says the same.
  Only after you stopped it (or it ended) do the rules above apply. This holds for `print` workers too, for a
  worker of a run that cannot be read, and for `agent start --resume` (refused with the same words). "Still
  runs" is the process the holder started (told by its recorded identity, as today) or, for a record whose
  holder went away without recording its child's end, a process left in the child's process group, so an
  agent behind a wrapper that died is seen (a session its holder ended, by its timeout too, is not looked
  at: what it left behind, a `kodel wait` say, must not keep it from being resumed). A
  group member counts only when all of this holds: the process table was read; the machine has not been
  restarted since the session began; no other process now has the group's number as its pid (that would be
  a stranger that took the number after the group was empty). **`kodel agent stop <id>` never signals such a
  group** (it has no live leader, so its members may be another program's): it records the stop, names each
  member (pid, command) and tells the person to end them (`kill <pid>`) and run it again, after
  which `rm`, `prune` and the resume rules see an ended session. Where the process table cannot be read (a
  sandbox), the group is not looked at: today's rule holds (the recorded process only), nothing is held for
  good, and the daemon says once `cannot read the process table: an agent left behind a dead wrapper would
  not be seen`.
- **The two limits mean two things.** `max_runs`: open runs that have a worker, waiting ones too (how many
  reviews pile up, how many agent processes are alive). `max_workers`: agents that are working. A worker
  whose run only waits for you holds no `max_workers` place; in a fork with a step left for the agent it
  holds one. A worker your decision wakes while the limit is full goes on; while the count is over, the
  daemon starts and resumes nothing and says once `W agents work, over the limit of M by N` (no cause is named: a hand start or a lowered limit
  gets there too).
- **If it does not go on** within 2 minutes of your decision, the daemon logs it once and the card says `the
  agent has not gone on since your decision · o opens it`. Nothing is typed for you. No such line when the
  run already waits for you again (two gates in a row). This line is also the only sign of a worker whose
  `kodel wait` was lost (killed, or never started): before your decision nothing tells it from a worker that
  waits, and the row reads `agent waits with you` for both, because kodel does not see what an agent runs.
- **Your commands refuse inside a session.** `gate`, `resume`, `ack`, `seal`, `migrate`, `task approve`, the
  `pipeline changes|proposals` decisions and the person's `agent` commands refuse when one of their parent
  processes is the holder of a live kodel session, or when they run in the terminal session of one (`this
  command is for a person; it will not run inside a kodel agent session`), whatever `KODEL_ENGINE` says and
  whatever terminal they have. A command you type in a shell you started with `agent exec --pty` is refused
  as today (the mark already did that).
- **When the run ends a terminal session is stopped at once** (the next cycle of the daemon, else the next
  refresh of an open TUI; with neither, its 7-day timeout), with the processes it started; if you are attached
  you read `[killed: kw-…]` and have your terminal or the TUI back. A `print` worker is left to print its
  last line and exit, as today. The TUI stops only a worker of a run of this checkout whose state it read as
  ended. The daemon and the TUI resume and finish under the start lock, with the records read again inside it.
- **`serve`, besides:** `stalled_after_s` keeps its meaning, "quiet for this long": a terminal worker with a
  step open is `stalled` when it has printed nothing **and** called the engine with nothing for
  `stalled_after_s` (an agent in a long honest step prints; one stopped at a usage limit, an expired sign-in
  or a prompt of its own does neither and does not exit: this line, the row's `stalled · o opens it` and
  `serve --status`, which lists stalled workers and says that they hold the places, are how you learn it;
  nothing stops such a worker but you); none while the run waits for you. If the spike shows that a stopped
  session keeps writing to its terminal (criterion 7), output cannot tell: the line then counts engine calls
  alone and reads `no engine call for N s (it may be a long step)`; the profile holds which of the two it
  is, and both have a test. `no_first_call` once when a worker never called the engine 2 minutes after its
  start. `--status` shows `working N/max_workers` and `alive M`; the record's `workers` stays the places
  used (working) and gains `alive`.
- **`decisions.dialog` on** still refuses every worker, terminal ones and `agent start --pipeline` too.
- **`agent_hints: { wait: false }`** applies to your own agents only.
- **Commands (a person's, except `doctor`):**
  `kodel agent start [--pipeline <name>] [--name <n>] [--bg] <prompt>`: with `--pipeline` kodel makes a run
  with no task and its worker through the launcher; without, `claude` runs with your prompt in a terminal
  session with its own defaults; it prints the argv, what an unattended start may meet, and a warning when
  `KODEL_STATE_DIR` is set in your shell; it attaches unless `--bg`. With `--pipeline` and `worker: print`
  the worker is today's `-p` one, nothing is attached and one line says so; `--pipeline` needs a prompt (the
  task's text). A plain `agent start` is not a worker, so `decisions.dialog` does not refuse it; one line
  says that this agent's dialogs show in its own terminal. `kodel agent start --resume <id|name>
  [--bg]`: a new terminal session continues the stored conversation and keeps the name; it takes no prompt,
  no `--pipeline` and no `--name` (each refused by name). `kodel agent exec
  --pty --attach`. `kodel agent prune`. `kodel agent doctor` (reads only).
- **`agent ls`** gets `MODE` and `AGENT` (the engine and the id of its conversation), in `--json` too.
- **Config:** `engines.claude: { worker: terminal | print, terminal: { command: [<program>, <allowed
  flags>] } }`. The block stays one of named profiles; `worker:` or `terminal:` on any other name is refused
  with a message that names the follow-up task. In a config that git does not track at all (there is no
  committed version to hold it to) `worker:` is honoured, with one line that says so, and `terminal.command`
  is refused for a start by the daemon or the TUI ("commit .kodel/config.yaml to use terminal.command"): a
  worker's shell can write that file, and it must not choose the program of the next unattended start.
  `agent start` at your terminal shows the command and asks. If git itself fails (not found,
  `safe.directory`, a locked index), a start by the daemon or the TUI is refused with git's reason and
  `agent start` asks. A step `command` on the profile named `claude` (engine steps) is not the worker's
  program and is ignored for a worker: that is the profile's own `claude`, or `terminal.command[0]`. An
  older kodel refuses a config with these keys
  (`unknown key: …`), as it did for `serve`; `docs/run-formats.md` says so.
- **Unchanged:** gates, `kodel wait`, the journal, run formats, pipes sessions, engine steps (still off).

## Risks and invariants

Principles (AGENTS.md):

1. **Agent input is untrusted.** Nothing a worker prints is read as a result or an id. The id of its
   conversation is chosen by the launcher (`--session-id`) and stored by the starter; it names which
   conversation to continue, never whether a step is done. For a record from before this change (no
   `agent.json`) the id is read from the record's argv, which the launcher wrote; the reader of the tail
   (`claude-worker.ts:267-281`) is dropped.
2. **Fail closed.** The chosen mechanism cannot run: refused, no run made. A profile other than `claude` that
   asks to be a worker: refused when the config is read. A criterion of the spike that fails stops the run.
   A run with a live worker that cannot be read holds both places and is never finished. An override that
   cannot be shown to equal `HEAD` refuses. A resume the spike did not prove (across modes, or an id that is
   not known) is refused, never tried. A worker with `childAlive` is alive for every rule: no resume, no
   finish, both places held. The one place that does not fail closed, and why: a process group that cannot
   be read is not counted alive, because that would hold every finished session of every kind for good
   where the table is hidden (a sandbox, `hidepid`), with `rm` and `prune` refusing all of them; the daemon
   says so once, and the stated limit is that an agent behind a dead wrapper can be started twice there.
3. **Redact at every write path.** No new write into history. A terminal `tail.txt` is stripped of escape
   sequences, then redacted (`session-terminal.ts:441-448`): a secret printed as a line is caught (test); one
   a full-screen program paints in pieces can stay in the bounded tail until newer output replaces it or
   `agent rm` or `prune` removes it; with `terminal` as the mechanism this known limit of terminal sessions
   holds for every worker (a test pins it, `docs/session-formats.md` says it; no new retention rule). The
   `agent` record and `agent ls` never hold a prompt or an argv. The card prefers the agent's own log (Claude Code only today); tail lines pass
   `redactText` and `plain` again. The agent record holds validated shapes only.
4. **pipeline-core stays pure.** New there: the place count, the verdict for a terminal worker, `finish`, log
   problems and the stalled rule in `serve/`; the wording of the wait hint takes the command
   as a parameter (`next-step.ts`); `SessionSpec.agent`, `SessionListEntry.mode` and `.agent`, the `agent`
   record's schema. Process calls, the probes, the `HEAD` reader and the profile table live in `packages/cli`
   and `packages/local`.
5. **Side effects behind traits.** The launcher keeps its injected `adapter`, `exec`, `which`, `clock`, `uuid`;
   the probes, the `HEAD` reader and the TUI's attach child are
   injected.
6. **Humans decide trust.** The worker's server is `kodel mcp --no-decisions`, and it is the only MCP server
   of the session (`--strict-mcp-config`). An allow list without the decision tools and a deny list with them
   and with every human-only command (`env X=… kodel gate` too: the patterns begin with `*`). **Kodel never
   types into a session** (a test counts writes to the terminal's input from every path). `finish` decides
   nothing about a run. `agent start`, `agent prune` and `exec --attach` are human-only. Kodel never accepts
   the trust of a folder for the person: if the spike finds a supported way to accept it beforehand, `doctor`
   prints it as the person's act and writes nothing.
   **What a terminal worker opens, and what closes it.** With `-p` an agent's commands had no terminal, so
   the second guard of `requireHuman` (a terminal on stdin and stdout, `cli.ts:359-378`, `main.ts:66`)
   refused every person's command even with `KODEL_ENGINE` unset. A PTY worker's commands have a terminal,
   and a confirmation can be answered on one; what would stand between the agent and `kodel gate` is the
   mark (removable: `env -u`) and the deny patterns (substrings: `node …/kodel.js gate`, a variable or a
   decoded string pass). So `requireHuman` gains a third guard (`insideSession`, injected, the probe in
   `packages/local`): the command refuses when a parent process, up to the root, is the holder of a live
   session of this state base, or when the leader of its terminal session is the recorded child of one.
   With it, getting past needs what it needed with `-p`: a process that leaves the session and gets itself
   a terminal of its own (`setsid` and a pseudo-terminal), which the comment of `requireHuman` already names
   as not closed. When the process table cannot be read the guard cannot tell and the two old guards decide
   (a person in a sandbox must still be able to decide). It stays a guard against mistakes, not a boundary;
   `docs/decisions.md` says so in these words.
   Stated, not closed: `kodel mcp` by hand in a shell (accepted, `docs/decisions.md`); a process that left
   its session, as above; a worker's shell can edit `.kodel/config.yaml`, which is why `engines` is read
   from `HEAD`, though an agent that can commit to the checkout's branch still changes it; the attach socket
   is no boundary; a person can switch a worker's permission mode in the agent's own UI; a plain `agent
   start` session is a kodel session, so the kodel server its agent starts for itself is a worker and decides
   nothing (said by the command; see "After the second merge" in the implementation notes). Offline tests show lists and argv as strings only: that the real program honours them
   is shown by the spike (criterion 11), the real-agent scenario and your hand check.
7. **Kinds are adapters.** Untouched.
8. **Formats are versioned.** Below.

Stored data and compatibility:

- **Runs, journal, snapshots: no change.**
- **The serve record (v1):** `counts.workers` is today the worker places used (`before.workers` of
  `servePlaces`, `plan.ts:631-636`), equal to the live processes only because a `-p` worker exits at a wait.
  It keeps that meaning (now: agents that are working), so an older TUI or `--status` still reads
  `workers/max_workers` right. One optional field is added, `counts.alive` (live worker processes, waiting
  ones too), with the codec, the fixture and the round trip of `pipeline-core/src/serve/record.ts`; an older
  reader ignores it. No `v` bump.
- **Session records (v1, unfrozen, unreleased):** one new record file in a session's folder, `agent.json`:
  `{ v, engine, session?, source?: "chosen" | "observed", resumes? }`. It is a fifth record kind with its own
  codec entry (`decode` tolerant, `encode` strict), `SESSION_RECORD_CAPABILITIES[1]` changed in place (`kinds`
  gains `agent`; the format is unfrozen and unreleased), fixtures taken from a real holder by
  `scripts/take-session-fixtures.mjs` (`agent-chosen.json`, `agent-resumed.json`) and the round trip, by
  rule 5. The starter writes it once, **before** `session.json` (the file that makes the folder a session),
  for a `print` worker as for a terminal one, so a crash between the two leaves no session without its id.
  A session with no `agent.json` is an older one: listed with `AGENT` empty, its id read from its argv
  (below). The registry test of the session fixtures lists `agent`. This run writes `engine: "claude"` and
  `source: "chosen"` only; `engine` is any name and `observed` is in the schema now (round-tripped by a test on a
  record built there), and the record is a file of its own and not a field of the write-once `session.json`,
  so that the follow-up task (an engine whose id is known only later) needs no change of the format; that
  task takes a real `agent-observed.json` from a holder, before v1 is frozen (step 13). A build
  that does not know the file derives the same status, lists and removes the session (tests). No `v` bump.
  The name marker keeps its shape; a resume replaces it in one rename after the new record is in place, only
  for an `origin: "cli"` session whose holder is terminal; a failed resume puts the old one back; a host
  session's marker is never moved.
- **`SessionSpec.agent`, `SessionListEntry.mode` and `.agent`** are optional for every adapter.
- **User files:** `engines.<name>.worker`, `.terminal`, an optional step `command`; present configs load
  unchanged, a step profile of any name among them (test on the committed fixture configs). No config
  `version` bump.
- **Runs in flight at the update:** a live `claude -p` worker is listed and resumed by the old rule. One
  that already exited at its gate has no `agent.json`: its id comes from the argv of its records (the last
  `--session-id` of the first record, else the last `--resume` of the newest `-d` record, as `sessionIdOf`
  reads today, without the tail), so it is resumed after your decision and not released with
  `no_session_id` (which would free its place for good, `plan.ts:199-209`). A fixture of a real record
  written before this change is the test. A resume
  continues a conversation in the mode of the record that wrote it, unless the spike showed that it continues
  across modes; then the setting's mode is used. A mode that cannot run here refuses the resume with the
  reason: no record is made, it counts as one failed attempt, after three it is `resume_failed`.

**T-44 is revised, not reworded in place.** `docs/serve.md` gets a section "T-44 as revised by T-47" that
keeps the old lines, says which of them this decision replaced and why (a worker that stays alive at a
gate), and carries the refutation of the revised text; the same entry belongs in your decision log (your
local note, so that line is yours to add). What changes: `max_workers` is "agents that are working: a live
worker whose run does not only wait for the person"; "more worker processes than `max_workers` exist after an act of the
daemon" becomes "after an act of the daemon more agents are working than `max_workers`, unless the excess are
workers a person's decision woke"; "a decided run is resumed within two cycles" becomes "a decided run whose
worker ended at the wait is resumed within two cycles of a free place; one whose worker is alive goes on by
itself, and if it has not within 2 minutes the daemon says so"; "a holder that is gone is noted" holds except
for a worker that ended while its run waited for the person; a new refutation line: "a second agent is
started for a run whose first agent's process still runs". The daemon gains one act on a session (`finish`).

Other risks: the trust dialog of claude in a new worktree (unattended starts are blocked where the probe says
one will come); a session's own timeout signals its child's process group, and only while its leader lives
(`session-pty.ts`), not what the agent left in another group, so the wait command gets `--timeout 604800`; the daemon asks `run.inspect()` every cycle for each run with a live terminal worker (at
most `max_runs`); the probes read a file of another product (`~/.claude.json`): an unknown shape is
"unknown"; a terminal worker's `kodel mcp` lives as long as its session (up to 7 days), so a fix of the
server reaches a live worker only when it is stopped and resumed (said in `docs/serve.md`; neither `doctor`
nor `--status` shows a worker's build); the process table is read once for a listing, not once for a
record, and only when the listing holds a record whose holder went away without recording its child's end
(one `ps -A -o pid=,pgid=,stat=,lstart=`, the
way `descendantsOf` reads the table on macOS and Linux today); `finish` waits for the session's end under
the start lock (about 8 s at most, `KILL_GRACE_MS + 3 s`, against a waiter's 15 s), so the daemon and the
TUI plan one `finish` a cycle and the rest follow in the next ones.

## Acceptance criteria and tests

Test ids: `t47_` this decision; `t44_` the serve rule; `tA_` is the placeholder id of D-A (TASK-HN8N) that
`session-test-names.test.ts:9-19` demands of every test in a file named `session*`, `attach*` or `pty*`;
`t42_` engine profiles. The CI `pty` job runs `tests/pty` with `KODEL_REQUIRE_PTY=1`.

The mechanism and the profiles (`cli/test/worker-launcher.test.ts`, `cli/test/agent-profiles.test.ts`):

| Criterion | Test |
| --- | --- |
| `worker: terminal` (and the absent key): `kw-<run>` as `mode: pty`, 7-day timeout, the `agent` record; `worker: print`: today's `-p` spec, byte-equal to the one before this change | `t47_worker_terminal_spec`, `t47_worker_print_spec_is_todays` |
| `terminal` where no terminal runs (Bun, package missing, no binary): refused with that reason, `adapter.start` not called, no run made by the TUI or the daemon, the daemon uses no attempt; nothing starts in the other mode | `t47_terminal_that_cannot_run_is_refused` (a table), `t47_no_mechanism_is_switched_by_itself` |
| The holder cannot open the terminal (`HOLDER_BOOT_FAILED`): the start fails as any failed launch (`not_started`), no pipes worker appears | `t47_holder_failure_is_a_failed_start` |
| `worker:` or `terminal:` on a profile not named `claude` is refused when the config is read, and the message names the follow-up task; a step profile of another name with neither key loads as today | `t47_only_claude_is_a_worker` (`local/test/config-engines.test.ts`) |
| A machine where `claude -p` works today and no terminal runs: the refusal names the line to commit (`engines: { claude: { worker: print } }`), and with it the start is today's | `t47_refusal_spells_the_migration_line` |
| `decisions.dialog` on refuses a terminal worker and `agent start --pipeline` | `t47_dialog_still_refuses_every_worker` |
| Claude terminal argv: prompt last, after `--`, no `-p`, `--session-id`, `--mcp-config` + `--strict-mcp-config`, `dontAsk`, both lists | `t47_claude_terminal_argv` |
| No decision tool allowed, both denied; every command the CLI marks human-only (read from its registry, the new `agent start`, `agent prune`, `exec --attach` among them) is covered by a deny pattern in plain and `env X=…` spellings; no pattern matches an `mcp__kodel__*` tool or `git commit -m 'fix mcp'` in a worktree path | `t47_worker_lists_refuse_decisions`, `t47_every_human_only_command_is_denied` (a table from the registry), `t47_deny_list_refuses_no_honest_command` |
| A `kodel mcp` started with the claude profile's exact server arguments, `decisions.agent.gate` on, refuses both decision tools | `t47_worker_server_serves_no_decision_tool` (`cli/test/mcp-no-decisions.test.ts`) |
| The specs from the TUI path, the daemon path and `agent start --pipeline` are deep-equal for one run; each takes the `claude` profile by name from the one table; no other caller of `adapter.start` for a `kw-` name exists; `serve.start[].engine` is an unknown key and `agent start --engine` an unknown flag | `t47_every_starter_builds_the_same_spec`, `t47_one_caller_starts_workers`, `t47_engine_choice_is_not_built` |
| The worker's server gets `--wait-command`; every `waiting` answer spells it with the run id (start it in the background and end the turn), also with `agent_hints: { wait: false }` and at a second gate; with `KODEL_STATE_DIR` set the spelling is `env KODEL_STATE_DIR=… <exec> … wait <run> --timeout 604800`; the spec's env has no `KODEL_*`; every part is shell-quoted (a root with spaces); the command in the answer is byte for byte the one the launcher built, also when a project redaction rule matches a part of its path (it is put in after the answer's text is redacted and holds nothing an agent wrote; `t47_wait_command_is_not_changed_by_redaction`; that the text of a waiting answer is written to no journal line is pinned by `t47_waiting_answer_text_is_not_journaled`); every place that spells the command uses the given one: the waiting answer (`next-step.ts:262`), the note of a `node` or `running` answer beside a waiting decision (`:940`), the two fork instructions that name it (`:291`, `:306`) and the server's instructions (`mcp/tools.ts:28`, `:93`), and a bare `kodel wait <run>` is in none of a worker's answers (`t47_no_answer_of_a_worker_spells_a_bare_wait`, a table of answer kinds); the timeout equals the session's (one constant); a root whose spelling trips the worker's own deny patterns (`…/kodel resume/…`) is refused by preflight with the reason | `t47_waiting_answers_spell_the_wait_command`, `t47_wait_command_carries_the_state_dir`, `t47_wait_command_is_quoted_and_passes_the_deny_list`, `t47_wait_timeout_is_the_sessions` |
| Built artifact, `storage: home` and a state dir: the spelled command, run in the worker's environment, sees the decision | `t47_wait_command_finds_the_run_under_a_state_dir` (`tests/e2e`) |
| The trust probe looks at the folder the worktrees are made in, before any run exists; "will ask" blocks a daemon start; unknown lets it go and logs once; a person's start goes on with a notice | `t47_trust_is_probed_for_the_worktrees_folder`, `t47_preflight_blocks_an_unattended_start_when_trust_asks` |
| The id is the record's, chosen by the launcher and written by the starter, for a `print` start too; never from the screen or the tail; a session with no `agent` record (an older one) gets its id from its argv and nothing is written for it; argv without a valid id: `no_session_id`; `parseEntry` keeps `mode` and `agent` | `t47_session_id_is_the_chosen_one`, `t47_print_start_writes_the_agent_record`, `t47_session_id_never_from_the_screen`, `t47_older_record_id_comes_from_its_argv`, `t47_list_entry_keeps_mode_and_agent` |
| A real `claude -p` worker record written before this change (`fixtures/session-formats/v1/worker-print-before-t47/`, no `agent.json`), exited at its gate, the run decided after the update: resumed once with `--resume <the id of its argv>`, its `max_runs` place kept until then | `t47_inflight_print_worker_is_resumed_after_the_update` (`cli/test/worker-launcher.test.ts`), `t44_older_print_worker_at_a_gate_keeps_its_place` (`pipeline-core/test/serve-resume.test.ts`) |
| A person's command (each one of the registry) run with a live session's holder among its parents, with a terminal and with `KODEL_ENGINE` unset: refused with the session's words, nothing confirmed, nothing written; the same when only the terminal session's leader is a session's child; with no session among the parents it runs as today; the process table unreadable: the two old guards decide | `t47_persons_commands_refuse_inside_a_session` (a table from the registry), `t47_session_guard_reads_the_terminal_session`, `t47_session_guard_lets_a_person_through`, `t47_session_guard_unreadable_table_keeps_the_old_guards` (`cli/test/human-only.test.ts`), `tA_inside_session_probe` (`local/test/session-guard.test.ts`, a fake process table) |
| Real PTY, built artifact: a fake agent in a terminal worker runs `kodel gate`, `env -u KODEL_ENGINE kodel gate`, `node <artifact> gate` and a gate through `sh -c` with the answer `y` typed on its terminal: each is refused and the gate stays undecided | `t47_real_worker_shell_cannot_decide` (`tests/pty/worker-terminal.test.ts`) |
| One live worker per run across modes; a second start answers `NAME_TAKEN`; the TUI and the daemon resuming one decision at once: one session, the other gets `NAME_TAKEN` under the lock; a daemon resume racing a worker that goes on by itself: the records and the journal are read again inside the lock and nothing is started | `t47_one_live_worker_per_run_across_modes`, `t47_tui_and_daemon_resume_one_decision_once`, `t47_no_resume_for_a_worker_that_went_on` |
| A resume stays in the mode of the record unless the spike says conversations cross; a mode that cannot run, or an unknown id, refuses: no record, one attempt counted | `t47_resume_stays_in_the_records_mode`, `t47_resume_across_modes_when_it_continues`, `t47_resume_refused_makes_no_record` |
| Launcher, daemon cycle, TUI effects and `finish`: zero writes to a session's input | `t47_nothing_types_into_a_session` |
| `finish` of a session that is already stopped or gone is no error | `t47_finish_of_a_stopped_session_is_harmless` |
| A secret printed as a line by a terminal worker is not in `tail.txt` nor in the card's lines; a secret split by cursor moves stays (the documented limit, pinned so a change of it is seen); `agent.json` and `agent ls` hold no prompt and no argv text | `tA_terminal_tail_redacts_a_printed_secret`, `tA_terminal_tail_painted_secret_is_the_known_limit`, `tA_agent_record_holds_no_prompt` (`local/test/session-pty.test.ts`, `session-pipes.test.ts`), `t47_card_tail_lines_are_redacted` (`cli/test/tui-worker.test.ts`) |

The serve rule (`pipeline-core/test/serve-plan.test.ts`, `serve-resume.test.ts`; the daemon in
`local/test/serve-daemon.test.ts`):

| Criterion | Test |
| --- | --- |
| A live terminal worker whose run only waits for the person holds a `max_runs` place and no `max_workers` place | `t44_waiting_worker_holds_a_run_place_only` |
| `max_workers: 1`, `max_runs: 3`: with one run at a gate a second task starts; with three open runs none does | `t44_reviews_are_bounded_by_max_runs` |
| A fork: one branch waits, another has an agent step: the worker holds a worker place | `t44_fork_with_work_left_counts_as_working` |
| A decision wakes a waiting worker with `max_workers` full: no action against it, no start and no resume while over, one log line; when it reaches a wait the count falls and exactly one waiting start goes in that cycle | `t44_woken_worker_goes_on_and_the_daemon_adds_nothing`, `t44_count_recovers_and_one_start_follows` |
| A pipes worker, a worker in `unknown` state, and a live worker of a run that cannot be read hold a worker place | `t44_only_a_known_waiting_terminal_worker_frees_its_place` |
| **`lost` or `killed` with `childAlive`, terminal or print, at a wait or not, decided or not: verdict `child_alive`, no resume, no `finish`, no `gone` note, both places held, one log line with `kodel agent stop <id>`; after the person's stop (the child gone) the ordinary rules apply** | `t44_child_alive_is_never_resumed_or_finished`, `t44_child_alive_holds_both_places` (rows: a readable run, and a run that cannot be read, where today `unreadableHoldsRun` frees the place of every `lost` or `killed` worker, `plan.ts:225-226`), `t44_child_alive_then_stopped_follows_the_rules` |
| The holder's child is gone but a process of its group lives (a wrapper that died, the agent behind it alive), for a record whose holder went away without recording its child's end: the record says `childAlive`; a record whose holder recorded the end (`exited`, `stopped`, `killed` by its timeout with a `kodel wait` left in the group) is not looked at and is resumed by the ordinary rule | `tA_child_alive_looks_at_the_process_group` (`local/test/session-pipes.test.ts`, a fake process table), `t47_real_orphan_behind_a_wrapper_is_not_doubled` (`tests/pty/worker-terminal.test.ts`) |
| A stranger is not a member: the group's number is now the pid of a process that is not the recorded child (its identity differs): not alive; the machine was restarted after the session began (boot time later than the record's start): not alive, and a run left at a gate by that restart is resumed after the decision; the table cannot be read: the group is not looked at, the recorded-child rule decides, one log line of the daemon; the table is read once for a listing with many records and not at all for one with no such record | `tA_child_alive_pgid_reuse`, `tA_child_alive_after_a_restart`, `tA_child_alive_unreadable_group`, `tA_group_table_is_read_once_per_listing` (`local/test/session-pipes.test.ts`), `t44_unreadable_process_table_is_logged_once` (`local/test/serve-daemon.test.ts`) |
| `agent stop` of a record whose child is gone and whose group has members: nothing is signalled (a group without its live leader never is), a stop record is written, the answer names each member (pid, command) and what the person does; the record keeps `childAlive`, `rm` and `prune` refuse; once the person ended the members the next stop settles it, `rm` and `prune` remove it and the resume rules apply; a group another program took over, and a stranger group, are never signalled; a session whose recorded child lives is stopped with its group, and a member that outlives the child is ended by its own pid | `tA_stop_never_signals_a_group_without_its_leader_by_{person,finish}`, `tA_stop_never_signals_a_leaderless_group_a_stranger_took_over`, `tA_stop_never_signals_a_stranger_group`, `tA_rm_after_the_person_ended_the_group`, `tA_real_group_orphan_is_seen_and_left_to_the_person`, `tA_stop_ends_what_outlives_the_live_leader_by_pid` (`local/test/session-pipes.test.ts`), `t47_real_stop_leaves_an_agent_behind_a_dead_wrapper_to_the_person` (`tests/pty/worker-terminal.test.ts`) |
| A `lost` worker noticed only after the decision, with no output after it, and an agent's line after the decision: `moved`, no `gone` note, not counted dead; the same record with output after the decision: `not_at_wait` | `t44_lost_noticed_late_is_not_a_death` |
| `childAlive` is carried from `agent ls --json` through `WorkerStatus` and `serveWorkerOf` to `ServeWorkerView`; the TUI's offer of `s resumes` is withheld for it | `t47_child_alive_reaches_the_rule` (`cli/test/worker-launcher.test.ts`), `t47_tui_offers_no_resume_while_the_child_lives` (`cli/test/worker-resume.test.ts`) |
| Real PTY: the holder killed with `SIGKILL` while a fake agent that ignores the hangup lives on, the run decided: no second session is started; the holder and the agent both killed (a reboot), the state read again, the run decided: resumed once | `t47_real_orphan_is_not_doubled`, `t47_real_holder_and_agent_gone_at_a_wait_is_resumed` (`tests/pty/worker-terminal.test.ts`) |
| A terminal worker `exited`, `lost`, or `killed` by timeout or a holder error (child gone), while the run waited and before any decision: no note, not counted dead, keeps its `max_runs` place, resumed once after the decision; the same for one that ended after the decision with no agent line in the journal since (the same second, seconds later, days later) | `t44_worker_that_ended_at_a_wait_is_resumed` (a table of ends), `t44_ended_after_the_decision_without_going_on_is_resumed` |
| The same worker stopped by a person: not resumed by the daemon, offered by the TUI | `t44_stopped_at_a_wait_is_left_to_the_person` |
| The worker ended at W1 before D1, then another agent worked the run (an agent's line after D1): verdict `moved` as today, no note, not counted in `dead_in_a_row`, the place kept as today; the order is taken from the journal's sequence and the record's end, and an end in the same instant as the decision counts as before it; a decision recorded while the holder dies gives one of the two verdicts above, never a resume and a death together | `t44_ended_before_the_decision_and_moved_is_not_a_death`, `t44_same_instant_end_and_decision`, `t44_decision_while_the_holder_dies` |
| W1, decision D1, an agent's line after D1 in the journal, then the worker exits or dies (its end after D1): `not_at_wait`, one `gone` note, counted in `dead_in_a_row`, its `max_runs` place freed, no resume with D1's prompt | `t44_worker_that_died_after_the_decision_is_dead`, `t47_card_says_died_after_your_decision` (`cli/test/worker-resume.test.ts`) |
| A terminal worker with a step open, no output and no engine call for `stalled_after_s`: one `stalled` line; output alone, or an engine call alone, puts it off (a long step that prints is not stalled); none while the run waits for the person; a `print` worker by output, as today. With the profile's `idleWrites` set (the other answer of spike criterion 7): engine calls alone, and the line reads `no engine call for N s (it may be a long step)` | `t44_terminal_stalled_needs_no_output_and_no_call`, `t44_long_step_that_prints_is_not_stalled`, `t44_stalled_skips_a_worker_that_waits_with_the_person`, `t44_stalled_by_calls_alone_when_idle_writes` |
| Run ended, terminal worker live: one `finish` in that cycle; three ended runs: one `finish` a cycle, three cycles; a start that waits for the lock meanwhile is served; run open, or open and unreadable: none; a live `print` worker of an ended run: none; a `-d<seq>` record is finished, an older ended record is left | `t44_finish_at_once_when_the_run_ended`, `t44_one_finish_a_cycle`, `t44_no_finish_for_an_open_or_unreadable_run`, `t44_finish_is_for_terminal_workers_only`, `t44_finish_takes_the_live_record` |
| A stalled worker is listed by `--status` with the places it holds; the record's `workers` is the places used (the working agents, what an older reader shows beside `max_workers`) and `alive` the live processes; `--status` names both; the record round-trips and an older reader ignores `alive` | `t44_status_lists_stalled_workers`, `t44_status_names_working_and_alive` (`cli/test/serve.test.ts`), `t44_record_counts_working_and_alive` (`pipeline-core/test/serve-record.test.ts`) |
| Decided, worker alive, no agent line for 2 min: one `not_moving` line per decision, no action; none when the run waits for the person again (two gates in a row) | `t44_not_moving_is_logged_and_nothing_is_typed`, `t44_not_moving_skips_a_run_that_waits_again` |
| The text of T-44 in `docs/serve.md` is the revised one and the tests assert no line of the old one ("more worker processes than `max_workers`") | `t44_docs_carry_the_revised_text` (`cli/test/docs.test.ts`) |
| No agent line 2 min after the start: one `no_first_call` | `t44_no_first_call_is_logged_once` |
| The daemon asks the run's answer each cycle only for a run with a live terminal worker, and reads its journal at most once a minute; a failed read keeps both places; `finish` calls `stop` once a cycle: a failure is logged and tried again on the next cycle, and a session that is stopped is not finished again | `t44_daemon_reads_live_runs_sparingly`, `t44_daemon_finishes_through_the_launcher` |
| An active daemon and an open TUI: only the daemon finishes and resumes; without one the TUI finishes, and only a run of this checkout whose state it read as ended | `t44_tui_leaves_finish_to_an_active_daemon`, `t47_tui_never_finishes_an_unreadable_or_foreign_run` (`cli/test/tui-worker.test.ts`) |

The TUI (`cli/test/tui-run.test.ts` with a fake terminal and a fake child, unless named):

| Criterion | Test |
| --- | --- |
| `o` with an attachable worker: one effect, for the run's latest record; else a notice and no effect | `t47_tui_o_opens_the_latest_attachable_record` (`cli/test/tui-worker.test.ts`) |
| After the return the model equals the one before `o` in section, tab, selected run, focus, card and its scroll, list scroll, filter, picked decision, zoom and mouse; only the data and the notice differ. From the list, from an open card scrolled down, from a filtered list | `t47_tui_returns_to_the_same_place` (a table) |
| The same when the agent ended while attached, and when the child exits with an error | `t47_tui_same_place_when_the_agent_ended` |
| The child cannot be started (`ENOENT`): the screen was not left, a notice says why | `t47_tui_child_that_cannot_start_leaves_the_screen_alone` |
| The selected run left the list meanwhile: the selection moves as on a refresh, nothing else changes | `t47_tui_same_place_when_the_run_is_gone` |
| Leaving: mouse off, paste off, cursor shown, alternate screen left, raw off, the data and resize listeners off, stdin paused; coming back: the reverse, one listener each, a reload, a full redraw; `suspend` does not mark the screen closed | `t47_tui_suspend_and_return_sequences` |
| Keys typed and a resize while away reach no TUI handler and draw nothing; the first key after the return is handled once | `t47_tui_reads_and_draws_nothing_while_away` |
| A signal, or the process ending, while away: the child is ended first, the terminal is restored once; `SIGQUIT` (a `Ctrl+\` that lands while the terminal is not raw, before the child is up or after it left) is taken and ignored while away; `SIGINT` to the group while attached ends no session; `SIGTSTP` from outside stops the TUI and the child and `SIGCONT` brings both back, with no session ended (`Ctrl+Z` typed while attached is a byte for the agent) | `t47_tui_signal_while_attached_restores_once`, `t47_tui_ignores_quit_while_away`, `t47_tui_stop_and_continue_while_attached_ends_nothing` |
| Input that arrived during the handover is read and thrown away for 150 ms before the TUI listens again: a key typed then does nothing | `t47_tui_drops_input_of_the_handover` |
| The child dies mid-way (the client crashes, the socket goes, the holder dies): the TUI returns to the same place with the notice | `t47_tui_returns_when_the_child_dies_midway` |
| `o` on Windows, on a `print` worker, or in a TUI that runs under Bun, never leaves the screen; under Bun the notice spells `node <built kodel> agent attach <id>` | `t47_tui_o_checks_before_leaving`, `t47_tui_o_under_bun_is_refused_with_the_command` |
| Real PTY: the outer terminal is resized while attached through the TUI: the agent's terminal gets the new size, and the TUI draws at it after the return | `t47_real_tui_resize_while_attached_reaches_the_agent` (`tests/pty/worker-terminal.test.ts`) |
| Real PTY, built artifact, fake agent: `kodel tui`, move to the second run, open its card, `o`, type, `Ctrl+\`: the same run is selected and its card open, a key is taken, and the bytes after the return put the alternate screen, the hidden cursor and bracketed paste back on with the terminal raw; again with the agent ending while attached; again with `Ctrl+\` pressed twice in a row (the TUI lives) | `t47_real_tui_returns_to_the_same_place`, `t47_real_tui_returns_when_the_agent_ends`, `t47_real_tui_survives_a_double_detach_chord` (`tests/pty/worker-terminal.test.ts`) |
| Real PTY: start through the launcher, attach, type, detach, the session runs, `finish` stops it and a background child of the agent is gone, modes reset | `t47_real_terminal_worker_attach_detach_finish` (same file) |

The record, the commands, the config:

| Criterion | Test |
| --- | --- |
| `agent.json` round-trips (chosen, resumed, and a record with `source: "observed"` and another engine name built in the test); a newer `v` is refused; a bad `agent` in a spec is refused | `tA_agent_record_round_trips`, `tA_agent_record_newer_format_is_refused` (`pipeline-core/test/session-records.test.ts`), `tA_spec_agent_is_validated` (`pipeline-core/test/session.test.ts`) |
| The starter writes it once; a reader that ignores the file derives the same status, lists and removes the session; an old session lists with `AGENT` empty; `agent ls` and `--json` show `MODE` and `AGENT`, and the hint for a stopped session that can be resumed | `tA_agent_record_is_written_once`, `tA_older_reader_ignores_the_agent_record` (`local/test/session-pipes.test.ts`), `tA_agent_ls_lists_mode_and_agent` (`cli/test/agent.test.ts`) |
| `start --resume <name>`: a new terminal session with claude's resume argv, the same name, `resumes` set; the old record stays listed; `rm` of the old one keeps the name with the new | `t47_resume_keeps_the_name_and_links_the_old_record` (`cli/test/agent-start.test.ts`) |
| (The crash tests use `faults`, a tests-only option of the local adapter that throws at a named step of a start.) The marker moves in one rename after the new record exists, only for a finished `cli` session; a failed resume puts the old marker back; a crash before the move leaves no dangling name; a plain `agent start --name` racing a resume gets `NAME_TAKEN` at every point; of two resumes one wins | `tA_name_marker_moves_only_for_a_finished_cli_session`, `tA_failed_resume_restores_the_marker`, `tA_no_dangling_name_after_a_crash_in_a_resume`, `tA_plain_start_never_takes_a_name_in_a_resume`, `tA_two_resumes_of_one_name_one_wins` (`local/test/session-pipes.test.ts`) |
| Refused with a reason: a running session, a `lost` or `killed` one whose process still runs (the marker is not moved either: `tA_name_marker_is_not_moved_from_a_live_process`), one whose id is not known or whose `agent` record does not name `claude`, a `kw-` or host session, a pipes session | `t47_resume_refusals` (a table) |
| `agent start --pipeline`: one run with no task, one `kw-` worker, under the start lock, no tracker write; `--name` refused; human-only | `t47_agent_start_with_pipeline_uses_the_launcher` (`cli/test/agent-start.test.ts`, as the next three) |
| `agent start <prompt>`: the claude profile's command, the chosen id, the prompt; no kodel MCP config and no permission flag; `KODEL_ENGINE` set; prints the argv and the unattended hint; attaches unless `--bg` | `t47_agent_start_plain_prints_argv_and_attaches` |
| The flags of `agent start`, one row each: `--pipeline` with `worker: terminal` attaches, with `--bg` does not; `--pipeline` with `worker: print` starts today's `-p` worker, attaches nothing and says so; `--pipeline` without a prompt, `--pipeline --name`, `--resume` with a prompt, with `--pipeline` or with `--name`: refused by name, nothing started; a plain start with `decisions.dialog` on is not refused and prints the line about dialogs; `--pipeline` with it on is refused | `t47_agent_start_flag_table` |
| With `KODEL_STATE_DIR` set it prints the warning about the agent's own server | `t47_agent_start_plain_warns_about_the_state_dir` |
| A plain start says that a kodel server this agent starts for itself is a worker in the session and decides nothing, `decisions.agent` named when it is on | `t47_agent_start_plain_says_its_server_is_a_worker` |
| The environment a plain session gives its child makes `kodel mcp` with no role a worker (real server from source), and `--role manager` does not start there | `t47_agent_start_plain_session_makes_the_projects_server_a_worker` |
| `exec --pty --attach` prints `started`, then attaches; the exit code is the attach's; a command that ended before the attach gives `[ended: …]` and code 0; without `--pty` refused | `tA_exec_attach_starts_then_attaches`, `tA_exec_attach_of_a_command_that_already_ended` (`cli/test/agent.test.ts`), `tA_exec_attach_real_terminal` (`tests/pty/pty-session.test.ts`) |
| `terminal.command` is `[<program>, then pairs of an allowed flag and its value]` (`--flag value` or `--flag=value`): element 0 is the program (a wrapper there is the person's committed choice, and the group rule above covers it); a bare word after it, a value that begins with `-`, any other flag, also in a short form, are refused by name; before the start the built argv is read back by the profile and every element must be the program, one of kodel's own fixed elements, or an allowed pair | `t47_engines_terminal_override`, `t47_engines_terminal_allows_only_listed_flags`, `t47_final_argv_is_checked` |
| Only the `engines` block is compared with `HEAD` of the checkout: equal: used; a `serve` edit beside it: still used; a working-copy edit, a staged-only edit, a block in `HEAD` that the working copy removed: a daemon or TUI start is refused with "engines is used only as committed: commit .kodel/config.yaml or put the block back as it was", and `agent start` shows the difference and asks; a config that `HEAD` does not hold and git does not track, or no git: `worker:` is honoured and one line says so, `terminal.command` refuses a daemon or TUI start and is asked at `agent start`; a project root that is a subfolder of the git top level is found by its path from the top; `HEAD` is read once per start, inside the start lock; a commit a worker made on its run's branch changes nothing, one on the checkout's own branch does (the stated limit); git itself fails (not found, `safe.directory`, a locked index): a daemon or TUI start is refused with git's reason, `agent start` asks | `t47_engines_block_is_read_from_head` (a table), `t47_engines_head_reader_failure_refuses` |
| A profile named `claude` with a step `command`: the worker's program is the profile's own `claude` (or `terminal.command[0]`), never the step command; an engine step still uses the step command | `t47_step_command_is_not_the_workers_program` (`cli/test/agent-profiles.test.ts`) |
| The block parses (`worker`, `terminal.command`); a misspelled key or value is named; the committed fixture configs load unchanged; a schema without the keys answers `unknown key`; a profile without a step `command` refuses a step; the server's instructions and AGENTS.md name `engines` as the person's | `t42_worker_and_terminal_keys_parse`, `t42_present_engine_configs_still_load`, `t42_profile_without_step_command_is_refused_for_a_step` (`local/test/config-engines.test.ts`), `t47_instructions_name_engines` |
| `prune` never removes: a live record; an unreadable, foreign or newer one; a `kw-` or `ke-` record whose run is open or cannot be read; a record younger than `--older-than` | `t47_prune_keeps_live`, `…_keeps_unreadable`, `…_keeps_open_run`, `…_keeps_unknown_run`, `…_keeps_younger_than_the_bound` (`cli/test/agent-prune.test.ts`, as the next) |
| A record whose child still runs is kept; one that goes live between the re-read and the removal is kept by `remove` itself (`STILL_RUNNING`); a prune during a resume never removes the record a name marker is moving to | `t47_prune_keeps_a_record_whose_child_runs`, `t47_prune_remove_refuses_a_live_record`, `t47_prune_during_a_resume` |
| It asks once with the count; `--dry-run` removes nothing; a host name marker stays and a `cli` one is freed with its record; a record that went live after the listing is skipped | `t47_prune_confirms_once`, `t47_prune_frees_cli_names_and_keeps_host_markers`, `t47_prune_reads_again_before_each_removal` |
| `doctor`, one test per check: `t47_doctor_platform`, `_terminal_can_run`, `_claude_found_version_signed_in`, `_trust`, `_decisions_dialog_and_agent`, `_engines_block_and_head`, `_worker_can_start` (the verdict); it writes nothing (its own files and claude's files byte-equal), reads a malformed `~/.claude.json` as "unknown", prints yes, no or unknown and no probe output, exits 1 only when a worker cannot start | those seven, `t47_doctor_writes_nothing`, `t47_doctor_malformed_engine_files_are_unknown`, `t47_doctor_prints_no_account_data` (`cli/test/agent-doctor.test.ts`) |
| The human-only walk knows `agent start`, `agent prune` and `exec --attach`; `agent doctor` is not human-only: it runs with `KODEL_ENGINE` set and no terminal, and the walk lists it as the agent's | the walk in `cli/test/agent.test.ts`, extended; `t47_doctor_runs_for_an_agent` (`cli/test/agent-doctor.test.ts`) |
| The docs agree with the code: the human-only commands AGENTS.md lists are the registry's; AGENTS.md and the server's instructions name `engines` as the person's; `docs/changes.md` holds the migration line, the same constant the refusal prints | `t47_agents_md_lists_the_registrys_human_only_commands`, `t47_changes_doc_spells_the_migration_line` (`cli/test/docs.test.ts`) |
| Real agent (skipped without `KODEL_AGENT_TESTS` or a PTY; it prints its version; the project is made inside the trusted checkout): two gates in a row with `decisions.agent.gate` and `.pipeline_change` on; the worker stays `running`; told to approve with the tool, then told to run `kodel gate <run> approve` and `env X=1 kodel gate …` in its shell, the gate stays undecided each time; a person's decision makes it go on in the same session, twice; the run completes and the session is stopped | `t47_real_claude_terminal_worker_cannot_decide_its_gate` (`tests/agents/terminal-worker.test.ts`) |

Tests that exist and change, because the default changes and T-44's text does (none is deleted; a test keeps
its meaning or the decision is revisited):

- `packages/cli/test/worker-launcher.test.ts`, `packages/cli/test/serve.test.ts`,
  `packages/cli/test/mcp-no-decisions.test.ts` and `tests/agents/claude-code-worker.test.ts` build today's
  `-p` worker. Their shared project helper writes `engines: { claude: { worker: print } }`, so each keeps
  testing what it tested (under `bun test` a terminal start would be refused: no PTY); the terminal mechanism
  has its own rows above, driven through the injected adapter, and the real one runs in `tests/pty`.
- `tests/e2e` serve scenarios and `local/test/serve-daemon.test.ts` that drive a fake launcher port keep it;
  those that count workers against `max_workers` are read again against the revised text, and each either
  holds as it is (a `-p` worker exits at a wait, so "working" and "alive" are equal for it) or is listed in
  the pull request with the line of T-44 it now asserts.
- `t47_default_is_terminal_only_after_the_rule` (`cli/test/worker-launcher.test.ts`) is the last test to go
  green (step 8): the absent key means `terminal`.

Which tests answer which task: TASK-K6MA is closed by `tA_exec_attach_*`; TASK-DSKQ by `tA_agent_record_*`,
`tA_agent_ls_lists_mode_and_agent`, `t47_resume_keeps_the_name_and_links_the_old_record`, `t47_resume_refusals`
and the marker tests; the rest is TASK-EKAV. The one thing the spike may answer either way (do conversations
cross modes) is a capability field of the profile, and each value has its row, so the tests hold whichever
way it comes out; so does what a stopped session writes (`idleWrites`, criterion 7). Every other criterion
has, in step 1, the tests and the text that go if it fails; the spike's "stop and come back" is a step of
the run, not code. `tA_` stays the placeholder the name test demands.

Hand check (you, on the built file `node packages/cli/dist/kodel.js`): `agent doctor`; `s` on a task; open
another run's card, scroll, `o`, type, `Ctrl+\`, and see the same card at the same scroll; approve the gate and
watch it go on; detach while a dialog of the agent is open; let the agent end while you are attached; `kodel
serve` with `max_workers: 1`, `max_runs: 2`: a second task starts while the first waits; stop a session of
`agent start`, then `agent start --resume <name>`; `agent prune`; ask a worker to run `kodel gate` for you and see it refused;
kill a worker's holder (`kill -9`) while its run waits at a gate, see `child still runs` and both places held,
then `kodel agent stop`: the worker place is free at once, the run keeps its `max_runs` place until you decide
the gate, and after your decision that place is free too and the daemon leaves the worker alone (a worker you
stopped is yours: `s` in the TUI resumes it); `o` in `bun packages/cli/src/main.ts tui` on a worker a Node `serve`
started gives the notice with the command; `bun packages/cli/src/main.ts tui` refuses
`s` with the Bun reason, and starts a `-p` worker after `worker: print` is committed; `worker: terminal` on a
profile named `codex` is refused with the follow-up message.

Refutation of T-47: with `worker: terminal`, a worker started by the TUI or the daemon is not attachable, or a
`-p` worker is started instead; a worker decides its own gate; after a detach or an ended agent the TUI is not
where it was, or the terminal is broken; kodel types into a session; a decided run with a live worker neither
goes on nor is reported within 2 minutes; a run left at a gate by a reboot is not resumed after the decision;
a resumed session loses its name or its conversation; a person's command decides when run by a process whose
parents still include its session's holder; a session is held alive for good by a process that is not its
own, or `kodel agent stop` cannot end one whose process runs.

What the tests cannot show: real terminal emulators; a terminal whose quit key was moved (`stty quit`), and
the handover inside tmux or screen (the chord is read as a byte in raw mode, the `SIGQUIT` handler covers the
default key only; both are in your hand check if you use them); that a reporting `kodel wait` wakes an idle
agent, also after an hour (the "is reported within 2 minutes" half of the refutation is tested in CI with a
fake clock, `t44_not_moving_*`; the "goes on" half has no CI trigger: it is shown by spike criterion 5, by
the real-agent scenario and by the release check "approve a gate after an hour away" in `tests/README.md`);
that a deny list is honoured in interactive `dontAsk`; trust inheritance (never in CI); that a conversation
continues after a resume; that the argv still matches the program; trust dialogs; the memory of idle
sessions; that a deny list holds after a person switches the permission mode in the agent's UI; a later
version of claude that changes its flags (the profile is written against claude 2.1.330; `doctor` prints the
version found). The real-agent scenario runs nightly only if the spike finds a supported way to accept trust
there, else on your machine before a release (`tests/README.md`).

---

## Steps

1. **Spike with the real `claude`, then stop** (`spikes/ekav-m0/`: scripts on the built artifact and
   `NOTE.md`; a PTY and the network are needed, so it runs outside the sandbox with your leave, or by you).
   Pass criteria, numbered in the note; all but 7 and 9 must hold, else the run stops and the plan comes
   back to you with the note and the change the failed criterion asks for (the list after the criteria).
   The stop is a step of the run and not code: step 2 begins only after you have read `NOTE.md`; nothing
   checks that for you.
   1. a session in `<root>/.kodel/worktrees/<run>` does not ask to trust the folder when the root is trusted
      (and: is there a supported way to accept trust beforehand?);
   2. `--mcp-config <json> --strict-mcp-config` shows no "New MCP server found" dialog;
   3. `claude "<prompt>" --session-id … --permission-mode dontAsk --allowedTools … --disallowedTools …` starts
      interactive and submits the prompt (also a one-word prompt that names a subcommand);
   4. a denied tool is refused without a prompt;
   5. a background `kodel wait` that reports wakes the idle session, also after an hour;
   6. no first-run or release-note screen, and no hook of the project's `.claude/settings.json`, stops an
      unattended start;
   7. what an idle session, and one stopped at a prompt of its own, writes to its terminal (either answer
      is planned for: it sets the profile's `idleWrites`, which picks the stalled rule);
   8. `stop` leaves a conversation that an interactive `--resume` continues, and a second `--resume` of the
      same id holds the turns of the first resumed session (the id stays one); the same for a long
      conversation (an hour of work, several compactions) and for one whose process was killed with
      `SIGKILL`: the resume starts with no question of its own (if it asks, say, whether to load a summary,
      the note says what and whether a flag answers it, and the criterion fails without one);
   9. `--resume` across modes, both ways (either answer is planned for);
   10. which process the holder's child is (the agent itself, or a shim that runs it), that the agent stays
       in the child's process group, and that with the holder killed the record says "child still runs" while
       the agent lives (an agent that leaves the group could not be seen as an orphan); and, on macOS and
       Linux, that a number in use as a process group is not given to a new process as its pid (what the
       stranger rule of step 2 rests on);
   11. in the interactive session, told to do so, `kodel gate`, `env -u KODEL_ENGINE kodel gate` and `node
       <artifact> gate` are each refused (by the deny list or by the guard of step 6a; the note says which).

   If one fails (the plan comes back to you with this, nothing is decided by me): 1 or 6: unattended starts
   stay blocked by the probe and only a person's `s` starts a terminal worker (`t47_preflight_blocks_*`
   already holds; `docs/serve.md` says so). 2, 3 or 4: no terminal worker can be made safe; the run stops.
   5: the wait in the foreground of step 13 is the only other way and it is not in this run; the run stops.
   8: neither the daemon's resume of a terminal worker nor `agent start --resume` can be built (both rest on
   it); the proposal is terminal workers that are not resumed (`t44_worker_that_ended_at_a_wait_is_resumed`
   and the DSKQ resume rows go, the stored id and `agent ls` stay). 10: the group rule is dropped and the
   stated limit is an agent behind a dead wrapper (`tA_child_alive_looks_at_the_process_group` and the stop
   rows go; `terminal.command[0]` is then refused unless it is the engine's own program). 11: the guard is
   fixed before anything else is built.
2. **The agent record.** `SessionSpec.agent?: { engine; session?; resumes? }` and `validateSpec`
   (`session.ts`); record kind `agent` (`sessions/records.ts`: schema, `RecordKind`, the capability); the
   starter writes `agent.json` before `session.json`, for every mode, and strips `agent` from the stored `spec`
   (`session-pipes.ts:256-257`); `SessionListEntry.mode` and `.agent` (optional; the testkit fake and the
   contract suite unchanged), kept by `parseEntry` (`worker-launcher-session.ts:121-145`); `agent ls`
   columns; fixtures; `docs/session-formats.md`. In the same
   step `WorkerStatus.childAlive` and `ServeWorkerView.childAlive` are added and filled (`workerStatusOf`,
   `serveWorkerOf`, `worker-factory.ts:52-68`): `parseEntry` already reads it and nothing passes it on. The
   local adapter's `childAlive` (today the one recorded process, `session-records.ts:138`,
   `session-pipes.ts:503-523`) becomes "the recorded child, or a member of the child's process group" (the
   group the adapter's `stop` already signals, `session-pipes.ts:569`), by these rules, in one function of
   `process-table.ts` (`groupMembers(pgid, since)`, the table injected for tests):
   - only for a record whose holder is gone and did not record its child's end; a holder that recorded the
     end (an exit, a stop, its own timeout) answers as today;
   - the table is read once for a listing (`ps -A -o pid=,pgid=,stat=,lstart=` on macOS and Linux), and only when
     such a record is in it; a table that cannot be read gives "not known", which is today's rule (the
     recorded child alone) and a flag on the listing that the daemon logs once;
   - no member counts when the machine's boot time is later than the record's start (Linux `/proc/stat`
     `btime`, macOS `sysctl kern.boottime`; not readable: "not known");
   - no member counts when a live process has the group's number as its pid and is not the recorded child
     by identity: the number was given out again, which the kernel does only once the group is empty
     (spike criterion 10 confirms this for both systems), so nothing of the session is left;
   - otherwise the members count as "may still run", and are not known to be ours: with the leader gone the
     number may have been given out and left again (see the Implementation notes).

   `stop` (`session-pipes.ts:503-570`) gets the matching path: today it returns through `settle` when the
   recorded child is not live or its identity differs, and never reaches the group. With the child gone and
   members found by the rules above it writes the stop record and signals nothing (a group without its live
   leader is never signalled): the command names the members and what the person does; a
   group that is "not known" or a stranger's is not signalled and the command says why. `remove` keeps
   `STILL_RUNNING` for `childAlive` (`:778-781`) and so follows the same answer. This holds for every
   session, pipes ones too; `rm`, `prune` and `agent ls` see one meaning of "still runs".
3. **The wait command.** `kodel mcp --wait-command <text>` (with `{run}`): the server's waiting answers spell
   it and offer it whatever `agent_hints.wait` says (start it in the background, end the turn); the wording
   function in `pipeline-core/src/next-step.ts` takes the command as a parameter. One mechanism: the command
   is an option of the service (`waitCommand`, a template with `{run}`; a server behind the same contract
   passes its own or none, and none means today's `kodel wait <run>`); the service redacts the parts of an
   answer that come from the run, then puts the command in, so no rule of the project can change it and
   nothing an agent wrote is in it. Every site that spells the command takes it from there: `next-step.ts`
   `:262`, `:291`, `:306`, `:940` and the server's instructions (`mcp/tools.ts:28`, `:93`). The spelling is
   `<exec> <args> --root <root> wait {run} --timeout 604800`, prefixed with `env KODEL_STATE_DIR=<dir>` when
   the starter has one, every part quoted for a shell by one function. `WORKER_DENIED_COMMANDS` drops
   `wait r_*` for terminal mode.
4. **The profile.** `packages/cli/src/agent-profiles.ts`: a table of profiles by name with one entry,
   `claude`, a small object the launcher and the commands reach through one lookup by name; nothing of
   claude's stays outside the entry, so the follow-up task adds entries and no branches. The entry:
   - interactive, with a prompt: `claude … -- "<prompt>\n"`: the prompt always ends with a newline and comes
     after `--`, because a one-word prompt that names a subcommand (`doctor`, `mcp`) is otherwise run as that
     subcommand (spike criterion 3, `spikes/ekav-m0/NOTE.md`; the person chose this fix); test
     `t47_profile_prompt_cannot_name_a_subcommand` pins the argv for `doctor`, `mcp` and a sentence;
   - the id of the conversation: chosen, `--session-id <uuid>`; resume: `--resume <id>`;
   - our kodel server: `--mcp-config <json> --strict-mcp-config`;
   - never ask: `--permission-mode dontAsk`, with the allow list and the deny list (decision tools and
     human-only commands);
   - wait: in the background;
   - `worker: print`: `claude -p`, today's spec;
   - flags `terminal.command` may add (everything else is refused): `--model`, `--effort`,
     `--fallback-model`.

   `claude-worker.ts` keeps what is Claude's (lists, markers, the auth probe, the stream digest) and becomes
   that entry.
5. **Config.** `engineProfileSchema`: `command` optional, `worker: terminal | print`, `terminal: { command? }`
   strict (`local/src/engines.ts`); `worker` or `terminal` on a profile not named `claude` is refused there
   with the message of decision 2. The step resolver
   refuses a profile without `command`. The `engines` block of the working copy is compared, parsed, with the
   one in `HEAD` of the checkout at the config's path from the git top level (an injected reader; a config
   `HEAD` does not hold and git does not track gives `worker:` only; its `terminal.command` is refused for an
   unattended start; a reader that fails for any other reason refuses an unattended start with git's own
   words). A step `command` of the `claude` profile is not read by the launcher. `engines` joins the
   person-only keys
   in AGENTS.md and in the server's instructions in this same step.
6. **The launcher.** It takes the `claude` profile from the table; the mechanism is the profile's `worker`.
   **Through steps 6 and 7 an absent key still means `print`** and only an explicit `worker: terminal`
   starts a terminal worker: with today's rule a live worker at a gate would hold a `max_workers` place and
   be called stalled, and a `lost` one would be `dead` and could get a second agent. The absent key becomes
   `terminal` in the last commit of step 8, with `t47_default_is_terminal_only_after_the_rule`; steps 6, 7
   and 8 are merged together or not at all. `terminal`: `mode: "pty"`, `agent`, a first size (the starter's terminal, else
   120x40), `WORKER_TERMINAL_TIMEOUT_MS` (7 days). `preflight` refuses when the mechanism cannot run
   (`probePty`'s reason), when `claude` is not found or not signed in, and
   gets `worktreesDir` for the trust probe and `unattended`; a run with no task skips the tracker check
   (`worker-launcher-session.ts:324-326`). The resume's mode follows "Runs in flight"; its id is the
   `agent` record's; for records without one, the argv's (`sessionIdOf` without its `tail` parameter);
   neither: `no_session_id`. A `print` start writes the `agent` record too. New on `WorkerLauncher`:
   `finish(runId)` (`adapter.stop`; `NOT_RUNNING` is no error), `attachable(runId)`. `WorkerStatus.terminal`.
   `resume` and `finish` run under `withWorkerStartLock` and read the records again inside it, for the TUI as
   for the daemon; one `finish` a cycle, because a stop can take about 8 s and a waiter for the lock gives
   up after 15 s (`STATE_LOCKED`, which `s` words as "busy, try again"). `preflight` keeps the
   `decisions.dialog` refusal for every worker.

   6a. **The guard of the person's commands** (`cli.ts` `requireHuman`, a probe in
   `packages/local/src/session-guard.ts`, injected as `env.insideSession`). The probe reads the process
   table once (pid, parent, terminal session), walks the parents of the command up to the root and answers
   `inside` when one of them is the holder of a live session record of this state base (by pid and recorded
   identity), or when the leader of the command's terminal session is the recorded child of one; `outside`;
   or `unknown` when the table cannot be read. `requireHuman` refuses on `inside`, after the mark and before
   the terminal check; `unknown` leaves the two old guards. It is built with step 6 and before any terminal
   worker can be started; the comment of `requireHuman` is rewritten to say what each guard is for.
7. **The rule** (`serve/resume.ts`, `serve/plan.ts`). `ServeWorkerView.terminal`, `.endedBy`;
   `.childAlive`; `ServeRunView.idleAtWait` and `.lastAgentAt`. **First, for every worker:** a record in a
   terminal state with `childAlive` gives the verdict `child_alive` (a new `ResumeNo`, not in `RELEASES_RUN`),
   before the `dead` line of today (`resume.ts:239`); `holdsWorker` is true for it; `endOf` and `goneReason`
   say nothing for it; `finish` is not planned for it; one `child_alive` log line. Then, for a terminal
   worker, "ended at the wait" is: it ended (`exited`, `lost` or `killed`, not `stopped`) at or after the last
   wait, and either no decision followed or no agent's line follows the decision in the journal (`marks.moved`
   is false, `resume.ts:157`). With an agent's line after the decision there are two cases, because `moved`
   is any agent's step, not this worker's: the worker ended before the decision (or in the same instant):
   today's `moved` (`resume.ts:266`), no death; it ended after the decision: `not_at_wait`. The end of a
   `lost` record is the time the loss was noticed (`since: this.now()`, `session-pipes.ts:341`, `:409`), an
   upper bound and not the end: such a worker "ended after the decision" only when its last output is after
   the decision, else it is taken as ended before it. `endOf` and
   `goneReason` follow the verdict. `unreadableHoldsRun` (`plan.ts:225-226`) also holds for a `lost` or
   `killed` worker with `childAlive`. Pipes workers keep today's rule otherwise. `holdsWorker` takes the run
   and is false for a live worker that is `idleAtWait`; `servePlaces`,
   `admitStart` and the resume loop use it. Over the limit: no start, no resume, one log line. Action
   `finish`, for a live terminal worker of an ended run only, one a cycle. Log problems `not_moving` (not for
   a run that is `idleAtWait` again), `no_first_call`, `over_limit`;
   `stalled` for a terminal worker counts from the later of `lastOutputAt` and `lastAgentAt` (from
   `lastAgentAt` alone when the worker's view says `idleWrites`) and skips `idleAtWait`; `stalled_after_s`
   keeps its key, its default and its meaning. The plan's `counts.workers` stays `before.workers`;
   `counts.alive` is new.
8. **The daemon** (`serve/daemon.ts`). `ServeLauncherPort.finish`. For a run with a live
   terminal worker, or a settled one, it asks `run.inspect()` every cycle (today for settled workers only,
   `:504-527`) and reads the journal at most once a minute for a live one; a failed read takes the existing
   unreadable path. Ended runs with a live worker are already watched (`:388`, `:461-480`) and get `finish`.
   The record gains `counts.alive` (`pipeline-core/src/serve/record.ts`, its fixture in
   `fixtures/serve-formats/`); `--status` shows both and lists stalled workers (`serve-command.ts`). The
   listing's "process table not read" flag becomes one environment line. **Last commit of this step: the
   absent `worker` key means `terminal`** (see step 6).
9. **The TUI.** `view.ts`: key `o`, effect `attach_worker`, the row and card
   words. `run.ts`: `suspend()` and `resumeScreen()` beside `restore()` (which stays the one-way exit,
   `:616-623`): the model object is kept; the terminal side stops (timers do not draw, the data and resize
   listeners off, stdin paused, raw off, mouse and paste off, the alternate screen left; the signal and `exit`
   handlers first end the child, then restore; `SIGQUIT` gets a handler that does nothing while away, because
   the detach chord `Ctrl+\` is the terminal's QUIT key whenever the terminal is not raw, and the TUI's
   signals today are only the ending ones, `run.ts:207-209`). On the return the input is read and dropped for
   150 ms before the data listener is back. The injected `openWorker(runId)` checks the platform, the runtime
   (under Bun it answers with the notice and the command to run; nothing of the handover is claimed for
   Bun), `attachable` and that the child can be spawned before the screen is left, then runs `kodel agent attach <latest id>` as a child
   with the terminal inherited (the TUI reads stdin as UTF-8 text, `:627`; a terminal needs bytes).
   `resumeScreen()` sets the notice, runs the ordinary reload and draws in full. `worker-resume.ts`: the run
   view keeps `unreadable` apart from `failed` (`:52-61`); with no active daemon the worker refresh calls
   `finish` by the same pure rule, for runs of this checkout only.
10. **Commands** (`agent-commands.ts`). `attachSession(ctx, adapter, ref)` taken out of the `attach` action
    (`:328-345`). `exec --pty --attach|-a`. `agent start`: with `--pipeline`, `host.start` (no `task_key`)
    under `withWorkerStartLock`, then `launcher.start`, sharing the launch half of `startLocked`
    (`tui/worker-start.ts`); without, a terminal session of the profile in the project root, `origin: "cli"`,
    always a terminal (a person's session is not a worker; `worker:` does not apply, nor does the
    `decisions.dialog` refusal). The flag table of the tests is the contract: `--pipeline` needs a prompt
    and takes no `--name`; with `worker: print` it attaches nothing; `--resume` takes nothing but `--bg`.
    `agent start --resume`:
    resolve the record, check it is terminal with no `childAlive`, `cli`, not a worker, that its `agent`
    record names `claude` and holds an id; start with `takeName: <old id>` (the new record is published
    first, then a temporary marker is renamed over the old one; the rollback renames the old content back)
    and `resumes`. `agent prune [--older-than <days>] [--dry-run]`: finished records only; a `kw-` or `ke-`
    record only when its run was read and has ended; each record read again before `remove`, which itself
    refuses a live one. `agent doctor`: the seven checks of decision 4.
11. **Tests** as above; a scripted fake terminal agent in testkit; the real-agent scenario.
12. **Docs:** `docs/serve.md` (the two limits, `alive`, T-44's text, a worker that ended at a wait,
    `finish`, the new log lines), `docs/session-formats.md` (the `agent` record, the moved marker, resume,
    the tail line), `docs/engines.md` (`worker`, `terminal`, the `claude` profile, the refusal of another
    name), `docs/run-formats.md`, `docs/decisions.md` (terminal workers; `kodel mcp` by hand as accepted),
    `docs/tasks.md`, `tests/README.md`, AGENTS.md (the new human-only
    commands; `agent doctor` is the agent's; `engines` is the person's; a **fork worker**, the subagent of a
    fork that never starts `kodel wait`, kept apart from a **background agent**, the `kw-` session of a run
    that does). Close TASK-K6MA and TASK-DSKQ; new tasks: the one of step 13 (not created here: the
    session had no task tools, so it is for you to file, "Decisions needed" 1), the automatic wake-up, a group
    kill on a session's timeout (until then a `kodel wait` of a session killed by its 7-day timeout lives on
    to its own end). `docs/changes.md` gets the migration note of decision 1; `docs/serve.md` the section
    "T-44 as revised by T-47", what `stalled` means for a terminal worker, and that a live worker keeps the
    server of the build that started it; `docs/decisions.md` the three guards of a person's command and
    what stays open. Each step ends with its own tests green before the next begins; steps 2-5 gate 6;
    6, 6a, 7 and 8 land together (the default changes last, step 8) and gate 9 and 10.
13. **The follow-up task: "codex and opencode as engines (profiles, worker and agent start, their safety
    criteria)".** Not in the tracker: step 12 did not create it (the session had no task tools), so it is for you to file ("Decisions needed" 1). What this plan moved into it, about 4 working days by the estimate of attempt 3:
    - **Profiles** `codex` and `opencode` in the table of step 4, and lifting the refusal of decision 2 for
      them. What their `--help` showed (codex-cli 0.165.0 and the opencode installed here; the captures are
      to be taken again): codex `--no-daemon -a never -s workspace-write -c mcp_servers.kodel.command/args/env
      -c shell_environment_policy.inherit=all "<prompt>"`, resume `codex resume <id> "<prompt>"`, no flag to
      choose an id, no list of allowed or denied tools; opencode `--standalone --auto --session <id> --prompt
      "<prompt>" <dir>`, a config that can deny tools and commands, nothing in the help on how a config is
      given for one start.
    - **A spike per engine, with safety criteria.** Codex: starts interactive in a PTY with no trust or
      onboarding screen; exactly one kodel server, ours, with `--no-decisions` (the entry `kodel init` wrote,
      `init/agents.ts:86-103`, replaced, not added to); every process a descendant of our session;
      `workspace-write` lets the server and `kodel wait` reach the run's files and `git`/`gh` work; how it
      waits; where it writes a session's id and that `codex resume` continues it; `stop` leaves it resumable;
      `KODEL_ENGINE` reaches the commands it runs; those commands have no terminal, so `env -u KODEL_ENGINE
      kodel gate` is refused by `requireHuman`. Opencode: the same for start, descendants, waiting, resume
      and `KODEL_ENGINE`; how a config is given for one start, that it yields one kodel server over the
      project's `opencode.json` entry (`init/agents.ts:129-139`), and that what it denies stays denied under
      `--auto`. For both, criterion 10 of step 1 (the agent stays in the child's process group).
    - **The rules that were codex's:** a codex worker refused while `decisions.agent.gate` or
      `.pipeline_change` is on, at a start and at a resume (no client-side list stands behind the server
      flag); an engine that fails a safety criterion refused as a worker and allowed for `agent start`.
    - **An id that cannot be chosen:** read from codex's own session files (same folder, made within a
      minute of the start, exactly one candidate, else unknown), written once into `agent.json` as
      `observed` (`setObservedAgentSession`, a replace by rename); the hint `codex resume --last`; a real
      `agent-observed.json` fixture taken from a holder, before session format v1 is frozen.
    - **Waiting in the foreground** (`kodel mcp --wait-style foreground`) if an engine is not woken by a
      background command, and what the card says when a person interrupts it.
    - **Choosing the engine** (your answer to question 3): `serve.start[].engine`, the question of `s` when
      several profiles are declared, `agent start --engine`, the engine on the daemon's start action.
    - **The rest:** `worker: print` for them; the flags `terminal.command` may add (codex `-m`/`--model`,
      `--oss`, `--local-provider`; opencode none); `doctor`'s checks per engine; `agent start` and `--resume`
      for them; their argv, config and refusal tests, fake agents and real-agent scenarios; a card log for
      them; `docs/engines.md`, `docs/decisions.md` and `adapters/README.md`.

## Affected files

`packages/cli/src/claude-worker.ts`, `agent-profiles.ts` (new),
`worker-launcher.ts`, `worker-launcher-session.ts`, `worker-factory.ts`, `agent-commands.ts`, `cli.ts` (the
`mcp` flag, wiring), `mcp-server.ts`, `serve-command.ts`, `tui/view.ts`, `tui/run.ts`, `tui/worker-start.ts`,
`tui/worker-resume.ts`, `tui/worker-open.ts` (new), `tui/tasks.ts`, `agent-start.ts` (new), `agent-prune.ts`
(new), `agent-doctor.ts` (new), `human-only.ts`, `main.ts`, `attach-client.ts`;
`packages/pipeline-core/src/session.ts`, `sessions/records.ts`, `service.ts`,
`serve/resume.ts`, `serve/plan.ts`, `serve/record.ts`, `next-step.ts`, `mcp/tools.ts`; `fixtures/serve-formats/`; `packages/local/src/session-pipes.ts`
(`stop`, `list`), `session-records.ts` (the `agent` file, `list`, `takeName`), `process-table.ts` (the group,
the boot time), `session-guard.ts` (new), `serve/daemon.ts`, `engines.ts`, `engines-head.ts` (new), `host.ts`;
`cli/test/human-only.test.ts`,
`cli/test/docs.test.ts` (new);
`packages/testkit/src/`; `scripts/take-session-fixtures.mjs`, `fixtures/session-formats/v1/`; the tests named;
`spikes/ekav-m0/`; the docs of step 12, `AGENTS.md`.

Not touched: `attach-server.ts`, `tui/tabs.ts`, the run codecs,
`init/agents.ts`, the `serve` block's schema (`local/src/config.ts`), `.mcp.json`, `.claude/settings*.json`,
`.kodel/pipelines/`. (`session-holder.ts` and `session-pty.ts` were named here and were changed by the stop
rule: see the Implementation notes.)

## Rejected review findings

Round 6 (48 findings in the four files; 40 fixed in the text above, 1 in "Decisions needed", 7 rejected
here, and one of the fixed ones rejected in part, last in this list):

- **scope-2 (take the stored id and `agent ls`, split `agent start --resume` out).** Decided by the person:
  all of DSKQ in this run. The marker move and its crash tests are what a resume that keeps the name costs.
- **scope-3 (no `terminal.command` override, no comparison with `HEAD`).** Decided by the person (round 3,
  scope-6): the override, committed version only. `worker:` alone would need the same comparison, since a
  worker's shell can write the config.
- **scope-4 (four runs: launcher, serve rule, TUI, DSKQ and K6MA; the counting is polish).** Decided by the
  person: one run, and a waiting worker holds no `max_workers` place. The log lines are the only sign of a
  stuck interactive agent with no TUI open (gaps-5 of round 3). What the finding is right about, the order
  inside the run, is fixed: steps 6-8 land together and the default changes last.
- **scope-7 (do not change the default for present users).** Decided by the person: `terminal` when the key
  is absent, no fallback. The refusal spells the one line to commit and `docs/changes.md` carries it.
- **scope-8 (fewer TUI signal tests: stop and continue, the double chord, the 150 ms drop).** Each is a
  separate way to leave a broken terminal that an earlier round found; the unit rows cost minutes with the
  fake terminal, and only three scenarios run on a real PTY.
- **scope-11 (leave "fork worker" and "background agent" out of AGENTS.md).** AGENTS.md says today that a
  worker never starts `kodel wait`, and this change tells the `kw-` session to start it: without the two
  names the file would say both.
- **tests-11 (confirm the real id behind `tA_`).** `session-test-names.test.ts:9-19` demands `tA_` of every
  test in these files; renaming them all is TASK-HN8N's, whose decision it is, not a change of this run.
- **scope-1, in part (a failed criterion 8 should only drop the DSKQ resume).** The daemon's resume of a
  terminal worker that ended at a wait rests on the same `--resume`, so criterion 8 is not DSKQ's alone;
  the rest of the finding (say what each failed criterion does) is fixed in step 1.

Round 5 (your answers to the four questions):

- **Every finding about codex and opencode** is now answered by "moved to the follow-up task" (step 13), and
  nothing of it is built or tested here: inv-2 (what keeps a codex worker from `kodel gate` is `requireHuman`
  alone), inv-8 (codex's observed id read from files the worker can write), tests-10 (the fail-closed rule
  for codex with `decisions.agent`), tests-14 (codex fixtures), scope-1 (codex and opencode later: taken
  now, by your answer). The fixes those findings got in attempt 3 are listed in step 13 so the task keeps
  them.

Overruled by your answers in round 4 (they were fixes or defaults of earlier rounds):

- **gaps-3 of round 2 (fall back to pipes when the holder cannot open a terminal)** and the probe-driven
  fallback of round 1: no automatic switch; both are refusals now, with tests.

Round 3:

- **scope-3 (the resume of DSKQ later), scope-7 (two runs).** Decided by the person. (scope-1 of this round:
  see round 5.)
- **scope-6 (drop the comparison with `HEAD`; no override in this version).** Decided by the person (the
  override, committed version only); and `worker:` in the same block needs the same care.
- **scope-5 (default `print`).** Decided by the person in round 5: the default is `terminal`; `print` is one
  committed line, and the refusal spells it.
- **scope-2 (the log lines and the stalled rule are polish).** gaps-5 of the same round shows the opposite: an
  interactive agent does not exit when it is stuck, so these lines are the only sign with no TUI open.
  `over_limit` is the person's answer.
- **inv-7 (a config `version` bump for the new keys).** As in round 2: `serve` was added with no bump, and a
  bump would make every older build refuse every config.
- **inv-3, in part (a retention bound for `tail.txt`).** The tail is bounded in size and replaced as output
  arrives; a time bound would be a new rule for every session. The limit is pinned by a test and said in the
  docs instead.
- **gaps-5, in part (do something about a stuck interactive worker).** It is reported (log, row, `--status`);
  stopping it is the person's act: kodel cannot tell a stuck agent from one that thinks.
- **tests-6, in part (a wake-up test).** A reporting `kodel wait` waking an idle agent cannot be shown
  offline; it is in the list of what the tests cannot show.
- **inv-9 (descendants outlive the holder's own timeout).** Deferred as the critic says: a follow-up task;
  the wait command ends by itself.

Round 2:

- **scope-1 (split into 2-3 runs), scope-5 (`prune` and `doctor` apart).** Decided by the person: one run.
- **scope-2 (keep a waiting worker counted).** Decided by the person.
- **scope-4 (only the stored id of DSKQ).** Decided by the person: all of DSKQ; the engine in the record is
  what tells a resume which program and flags to use.
- **scope-3 (`finish`, the log lines and the stalled rule as follow-ups).** `finish` at once is the person's
  answer; the log lines and the stalled rule are what gaps-6 of the same round asks for.
- **inv-5 as "bump the config version".** `serve` was added with no bump; a bump would make every older build
  refuse every config. The wording of the refusal is said in the plan and the docs.
- **tests-16, "`o` on a fork run with two live records".** A run has one live worker (the names are taken
  once; a fork's workers are subagents inside it). The `-d<seq>` half is a test.
- **gaps-9 as "fix the PTY stop path".** `finish` and `agent stop` go through `adapter.stop`, which signals
  the descendants and the group (`session-pipes.ts:545-567`); the holder's own timeout signals the child's
  process group, and only while its leader lives (see the Implementation notes): the wait command, in a group
  of its own, ends by itself, and a real-PTY test shows the descendants gone.
- **tests-13 as "a nightly canary for trust inheritance".** A CI machine has no trusted folder; the canary is
  the real-agent scenario, nightly only if the spike finds a supported way to accept trust.

Round 1 (still standing): ship `o` first for already attachable sessions (none are run rows); a separate
top-level key for the override (the task asks for one block); a test for an `mcp*` deny (the pattern is not
added); a second attach client (covered by TASK-HN8N's tests); "the run is reopened after a finish" (an ended
run does not reopen, `daemon.ts:384-385`).

## Findings in the code

- **One launcher, two starters.** `openWorkerLauncher` (`packages/cli/src/worker-factory.ts:22-49`) serves `tui`
  (`cli.ts:849`) and `serve` (`cli.ts:887`, `:930`) through `ServeLauncherPort`
  (`packages/local/src/serve/daemon.ts:121-138`, `worker-factory.ts:71-84`).
- **The worker is `claude -p`** (`claude-worker.ts:149-172`; "no budget cap (settled)"), `origin: "cli"`,
  `inheritEnv: false`, 12 h from the session's start (`worker-launcher.ts:11`, `session-pty.ts:679-683`), with
  `rules: []` (`worker-factory.ts:36-41`). Its preflight needs `claude` and a tracker
  (`worker-launcher-session.ts:311-332`). Its file says how another agent goes behind it ("replace this file
  and `claude-stream.ts`", `claude-worker.ts:5-7`).
- **Today it exits at a wait.** Its server runs `--no-decisions --no-wait-hint` (`claude-worker.ts:125-135`),
  `wait r_*` is denied (`:34`); `resumeVerdict` (`pipeline-core/src/serve/resume.ts:231-270`) resumes only
  `exited` at the last wait (`exitedAtWait`, `:221-223`, compares the end with the wait only); `running` is
  `active` (`:238`); `killed` and `lost` are `dead` (`:239`); `no_session_id` exists (`:267`); `moved` is not
  in `RELEASES_RUN` (`plan.ts:199-209`).
- **A holder that is gone with its child alive.** `deriveStatus` answers `lost` or `killed` with `childAlive:
  true` (`pipeline-core/src/session.ts:197`, `:206`, `:213`, `:222`, `:227`); `parseEntry` reads it
  (`worker-launcher-session.ts:131`) and `stateLabel` words it ("child still runs"), but `workerStatusOf`
  (`:183-199`) and `serveWorkerOf` (`worker-factory.ts:52-68`) drop it, so `resumeVerdict` sees `dead`
  (`resume.ts:239`) and `holdsWorker` a free place (`plan.ts:211-213`). Today that only frees a place too
  early; with workers resumed after a lost holder it would start a second agent, which round 3 found.
  `childAlive` itself is about the one process the holder started (`local/src/session-records.ts:138`,
  `session-pipes.ts:503-523`), while `stop` signals its whole group (`session-pipes.ts:569`); and
  `unreadableHoldsRun` frees the run place of every `lost` or `killed` worker (`plan.ts:225-226`).
- **`stop` reaches the group only through the recorded child.** It returns through `settle` when the child
  is not live or another process has its pid, and signals `-child.pid` only after the child's identity
  checked out (`session-pipes.ts:503-570`); `remove` refuses `STILL_RUNNING` while `childAlive`
  (`:778-781`). An identity is a start time per pid (`process-table.ts:55-75`); a group has none. The table
  is read with `ps -A` on both systems (`descendantsOf`, `:78`); `sameProcess` counts a process alive when
  its identity cannot be read (`:106-112`). A `lost` record's `since` is the time of the listing that
  noticed it (`session-pipes.ts:341`, `:409`).
- **`requireHuman` is the mark and a terminal** on stdin and stdout (`cli.ts:359-378`, `main.ts:66`); its
  comment says a descendant of a terminal session has a terminal and "there the mark alone refuses".
- **`counts.workers` of the serve plan is the places used** (`before.workers`, `plan.ts:631-636`), not the
  live processes. `stalled_after_s` is 1800 by default (`local/src/config.ts:137`); the cycle is 5 s
  (`serve/daemon.ts:63`).
- **Tests that build today's `-p` worker:** `packages/cli/test/worker-launcher.test.ts`, `serve.test.ts`,
  `mcp-no-decisions.test.ts`, `tests/agents/claude-code-worker.test.ts`. The old refutation line of T-44 is
  in `docs/serve.md:347`.
- **`moved` is any agent's step after the decision**, not the worker's (`resume.ts:61`, `:157`), and today it
  is a verdict of its own that is no death (`:266`).
- **The count.** `holdsWorker` looks at the worker's state only (`plan.ts:211-213`); `holdsRun` keeps a run
  with a live worker in `max_runs` (`plan.ts:218-222`). `stalled` fires by output (`plan.ts:486-499`); every
  `killed` is dead (`plan.ts:329-337`); a start action names a task and a pipeline, no engine (`plan.ts:143`).
- **The run's answer.** The daemon sets `waitsForPerson` from `"waiting" in run.inspect()` and only for a
  settled worker (`daemon.ts:504-527`); it keeps unreadable runs apart (`:488-500`) and watches ended runs
  whose worker lives (`:388`, `:461-480`). The TUI's run view maps `unreadable` to `failed`
  (`tui/worker-resume.ts:52-61`).
- **The wait hint** is worded in `pipeline-core/src/next-step.ts:262`, `:940` as `kodel wait <run>`, switched by
  `waitHint` (`cli.ts:473-492`, `mcp-server.ts:62`).
- **A session's environment has no `KODEL_*`** and always `KODEL_ENGINE=1` (`local/src/session-env.ts:17-35`,
  `session.ts:109`, `session-pty.ts:341-345`); `KODEL_STATE_DIR` reaches only the MCP server
  (`claude-worker.ts:131`).
- **PTY sessions and attach are merged (TASK-HN8N).** `mode: "pty"`, `size` (`session.ts:60-78`); `attach`,
  `attachable` (`session.ts:364-371`); `kodel agent attach` (`agent-commands.ts:328-345`); `runAttachClient`,
  `processTerminal` (`attach-client.ts:123`, `:281`); 80x24 without a terminal (`attach-server.ts:52`); the
  tail is stripped, then redacted (`session-terminal.ts:441-448`); a terminal that cannot be spawned fails the
  boot (`session-pty.ts:585-590`); the holder's own stop signalled the child only when this was written
  (`:605-609`; it signals the child's group while its leader lives now, see the Implementation notes), the
  adapter's `stop` the tree and the group (`session-pipes.ts:545-567`).
- **No terminal under Bun**; the probe also checks the package and its binary (`pty-loader.ts:93-112`). This
  repository's `.mcp.json` and `bun … main.ts` are that case.
- **Names.** A name is taken while its folder exists (`session-pipes.ts:225-240`); a failed start removes the
  marker it claimed (`:247-254`); `rm` frees a marker only for an `origin: "cli"` session and only when the
  marker names that record (`:785-788`); `resolveSession` picks the running, then the newest
  (`agent-commands.ts:151-187`).
- **The records** are strict on write, tolerant on read, four kinds (`sessions/records.ts:93-107`, `:124-168`);
  `session.json` is written once; `SessionListEntry` has no `mode` (`session.ts:340-348`); `parseEntry` keeps
  only the fields it names (`worker-launcher-session.ts:121-145`); the id is parsed from argv or the stream
  today (`claude-worker.ts:267-281`).
- **The TUI** owns the terminal in `run.ts:616-628`: `restore()` is one-way, registered once on `exit`; its
  signals are the ending ones, not `SIGQUIT` (`run.ts:207-209`), while the attach client's detach chord is
  `Ctrl+\`; the model lives in the loop; effects in `view.ts:303-333`; `s` at `:1669`; `a`, `r` at `:1683`.
- **`engines:`** is a record of step profiles with a required `command` (`local/src/engines.ts:59-79`,
  `config.ts:350`); not yet in AGENTS.md's person-only keys; engine steps are off. The worktrees folder is
  `worktree.dir`, `.kodel/worktrees` by default, or absolute (`config.ts:42-47`).
- **`kodel wait`** needs no person and takes `--timeout <seconds>` (`cli.ts:939-950`); `requireHuman` is the
  mark plus a terminal (`cli.ts:359-378`).
- **`claude --help` (2.1.330):** `--max-budget-usd` "only works with --print"; the trust dialog is skipped only
  with `-p` or without a TTY; `--session-id`, `--resume`, `--strict-mcp-config`; `dontAsk` is a
  `--permission-mode` choice; a positional prompt in interactive mode.
- **Trust, seen locally:** `~/.claude.json` has `hasTrustDialogAccepted: true` for the project root and no
  entry for any `.kodel/worktrees/<run>` folder. Inheritance is not shown by this.
- **`bun test` from the main checkout's root** also collects the untracked `worktrees/` folder and timed out
  at 15 minutes in the main session; run the tests from the run's worktree.
- **Not verified here:** everything in step 1; that `run.inspect()` answers with a step for every fork that
  has work left; that `adapter.stop` reaches the descendants of a terminal session; a real terminal handed
  from the TUI to a child.

## Implementation notes

Steps 2 and 3 (the agent record, the group rule, the wait command):

- **The flag "process table not read"** is a field of the status, `SessionStatus.group: "unread" | "stranger"`
  (in `agent ls --json` too), set only for a record whose holder went away without recording its child's
  end and whose recorded child is gone. Step 8 turns `unread` into the daemon's one environment line
  (`t44_unreadable_process_table_is_logged_once` is that step's). `agent stop` prints why it signalled
  nothing from the same field.
- **The table is read with `ps -A -o pid=,pgid=,stat=,lstart=`** (one column more than the plan names), so
  that a zombie is not counted as a process that runs.
- **`agent stop` of a group-only orphan writes the stop record**, as the plan's test row says, so the record
  then reads `stopped`. By the plan's own rule a worker a person stopped is not resumed by the daemon (the
  TUI offers `s`), which is not what the hand check line "then `kodel agent stop` and see it resumed after
  your decision" expects. Left as the test row has it; step 7 or the person decides which of the two holds.
- **The wait command is put in by the service through a mark.** The host is asked for the answer with
  `{kodel-wait-command}` in the command's place (`NextStepRequest.waitCommand`) and the service replaces it
  after the host has kept what it keeps (`served/`), so the command and its paths reach no file of the run
  and no rule of the project can change it. The host does not redact the answer it hands to the agent
  today, and the project's rules are an option of the host, not of `kodel mcp`; the redaction test
  (`t47_wait_command_is_not_changed_by_redaction`, `packages/local/test/wait-command.test.ts`) therefore
  runs the real host with rules that match the command.
- **Left to later steps because they need them:** the hint of `agent ls` for a stopped session that can be
  resumed (the command it names, `agent start --resume`, is step 10's); the id of a conversation taken from
  the `agent` record by the launcher, with the argv reader as the fallback and the fixture
  `worker-print-before-t47/` (step 6; `sessionIdOf` is untouched, `parseEntry` now keeps `agent`); the
  launcher's half of the wait command (the spec's environment, the preflight refusal through
  `waitCommandProblem`, `workerDenylist(…, { terminal: true })`, step 6); the real-PTY rows
  `t47_real_orphan_behind_a_wrapper_is_not_doubled` and `t47_real_stop_ends_an_agent_behind_a_dead_wrapper`
  (`tests/pty/worker-terminal.test.ts`, steps 6 and 11; until then the same is shown on real processes of a
  pipes session by `tA_real_group_orphan_is_seen_and_stopped`); `tA_terminal_tail_*` (step 11).
- **`t47_wait_command_finds_the_run_under_a_state_dir`** builds the artifact itself, as the fork test of the
  same folder does. It was first written without being run on the built file; the review fixes ran it
  there (see "After the review" below).

Steps 4 and 5 (the profile, the config):

- **The flags `terminal.command` may add are listed in `packages/local`** (`WORKER_ENGINES` in `engines.ts`,
  with `parseTerminalCommand`), not only in the profile: the grammar is checked when the config is read, and
  the config's schema lives there. The `claude` entry takes its `terminalFlags` from that list, so there is
  one list; the follow-up task adds a name to it and an entry to the table.
- **The terminal argv has the prompt last** (`claude <flags> -- "<prompt>\n"`), as step 4 says after the
  spike; the test row "prompt first" of `t47_claude_terminal_argv` is older than that and the test pins the
  new order. One thing follows for step 6: the reader of an id from a record's argv (`sessionIdOf`) takes
  the last `--session-id`, which was safe while the prompt (with the task's title) came before the flags.
  A terminal record always has its `agent` record, so its argv must never be read for the id.
- **The launcher is not moved onto the profile yet** (step 6): `worker-launcher-session.ts` still calls the
  functions of `claude-worker.ts`. The entry (`claudeProfile`) wraps those same functions, and
  `workerMechanismOf`, `workerProgramOf` and `profile.workerArgvProblem` (the read-back of
  `t47_final_argv_is_checked`) are there for it. `DEFAULT_WORKER_MECHANISM` is `"print"`; step 8 turns it,
  and `t47_default_is_terminal_only_after_the_rule` (`cli/test/worker-launcher.test.ts`) is the test
  to change with it.
- **`t47_every_human_only_command_is_denied` is not written here:** it is a table from the registry of
  human-only commands, which steps 6a and 10 make (today only the `agent` ones are a list). The two other
  list rows are in `cli/test/agent-profiles.test.ts`.
- **`Write(<path>)` deny rules are kept** (the print spec stays byte-equal to today's) and every one has its
  `Edit(<path>)` twin, which is the rule claude 2.1.330 honours (`t47_every_denied_path_has_an_edit_rule`).
  A terminal worker will print claude's warning for each `Write` rule above its prompt; dropping them for
  the terminal list is a one-line change of `workerDenylist` if that is unwanted.
- **The block as committed** is `enginesAgainstHead` (`packages/local/src/engines-head.ts`; one read of
  `HEAD` a call), with `unattendedEngines` for the daemon and the TUI (the refusals and the one line for an
  untracked config) and `enginesQuestion` for `agent start` (what differs; a value of `env` is never
  printed). Calling it once per start inside the start lock is step 6's. "No git" is: no `.git` in the root
  or above it; anything git then fails at is a failure, never "untracked". A config that is staged and was
  never committed is held to a committed version with no block (refused until it is committed). A committed
  config whose block cannot be read counts as a difference.
- **"A schema without the keys answers `unknown key`"** is shown on the profile schema with the two keys
  taken out (`t42_worker_and_terminal_keys_parse`); no older build is run.

Steps 6, 6a, 7 and 8 (the launcher, the guard, the serve rule, the daemon):

- **The hand check line about `kodel agent stop` is changed** (in "Acceptance criteria and tests"): a stop
  writes a stop record, the worker then reads `stopped`, and a worker a person stopped is not resumed by the
  daemon. The line now says: both places are freed, the daemon leaves it alone, `s` in the TUI resumes it.
  The rule has a verdict of its own for it (`stopped`, in `RELEASES_RUN`); the TUI asks the rule with
  `resumeStopped` and offers `s resumes`. A worker stopped outside a wait, and a stopped print worker, stay
  `dead` as before (no note: a person's stop is never one).
- **The real-PTY rows are not written here** (`tests/pty/worker-terminal.test.ts`:
  `t47_real_worker_shell_cannot_decide`, `t47_real_orphan_is_not_doubled`,
  `t47_real_holder_and_agent_gone_at_a_wait_is_resumed`, `t47_real_orphan_behind_a_wrapper_is_not_doubled`,
  `t47_real_stop_ends_an_agent_behind_a_dead_wrapper`, `t47_real_terminal_worker_attach_detach_finish`):
  they need the built artifact and the scripted fake terminal agent of step 11, and the implementation
  steps do not build. Until then the same rules are shown offline (`t47_persons_commands_refuse_inside_a_session`
  with the real probe on a fake table, `t44_child_alive_*`, `t44_worker_lost_at_a_gate_is_resumed_once_after_the_decision`,
  `t47_finish_of_a_stopped_session_is_harmless`) and on real processes of a pipes session
  (`t44_serve_real_adapter_notes_a_killed_holder`, now read against the revised rule: `child_alive` and no
  note while the process runs, the note within one cycle of its end).
- **Halves of rows that wait for step 10** (`kodel agent start` does not exist yet):
  `t47_every_starter_builds_the_same_spec` compares the TUI's start with the daemon's port (the third
  starter, `agent start --pipeline`, joins it there); `t47_engine_choice_is_not_built` pins
  `serve.start[].engine` as an unknown key (`agent start --engine` comes with the command);
  `t47_dialog_still_refuses_every_worker` covers the launcher's preflight, with and without a task
  (`noTask`). `t47_every_human_only_command_is_denied` is written (`cli/test/agent-profiles.test.ts`) over
  the registry `HUMAN_ONLY_COMMANDS` (`packages/cli/src/human-only.ts`); step 10 adds `agent start` and
  `agent prune` to `AGENT_HUMAN_COMMANDS`, and the row of `cli/test/human-only.test.ts` then asks for
  their arguments. `tui` asks for a person through the same `requireHuman` and is not in the registry: it
  is a screen, not a decision, and no deny pattern is written against the word.
- **The fixture `fixtures/session-formats/v1/worker-print-before-t47/` is taken from a real holder of the
  build before the change** (it was first composed by hand; the review sent that back). How: the source of
  commit d055fd6 was put in a scratch folder (`git archive d055fd6 | tar -x`, `bun install
  --frozen-lockfile`), and a script there made that build's `createSessionWorkerLauncher` over its
  `PipesSessionAdapter` (the holder is that build's `session-holder-entry.ts`), with a `claude` on `PATH`
  that is a three-line shell script (it prints one `result` line and exits 0, as a print worker does when
  its turn is over at a gate; no model ran), and called `launcher.start` for the run `r_0mw53d7fj_o2lc` with
  the conversation id and the title the test uses. `session.json` and `status.json` of the session were
  copied when it had exited, masked as `scripts/take-session-fixtures.mjs` masks (the id, pids, times,
  identity values, the machine id, the paths; the paths inside the argv were already
  `[REDACTED:high-entropy]`, written so by the holder). The other files of the session (`boot.txt`, the
  output) are not kept. The record names a machine, so the test puts this machine's id in its copy: a
  record of another machine is `FOREIGN` and is not resumed, which is right. The scratch folder was
  removed.
- **The trust probe** (`trustProbe` in `claude-worker.ts`, reached through the profile) reads
  `.claude.json` in `CLAUDE_CONFIG_DIR`, else in the home folder: `projects["<path>"].hasTrustDialogAccepted`
  for the worktrees folder or any folder above it (trust is inherited, spike criterion 1). Anything else is
  `unknown`. It is asked only for a terminal worker. The notice of a person's start (`PreflightResult.note`)
  reaches the daemon's log; the TUI does not show it yet (step 9: `StartCheck` has no place for it).
- **`HEAD` is read once in `launcher.start` and once in `launcher.resume`**, which the daemon and the TUI
  call under the start lock; the preflight (asked before a run is made, cached a minute by the daemon)
  reads it too. A block that changes between the preflight and the start refuses the start after the run
  was made: that run is noted `not_started` (the daemon) or said to have no agent (the TUI), as any failed
  launch.
- **`launcher.resume` reads the records again itself** and refuses a resume while the run's latest record
  is alive (`NAME_TAKEN`), while its process runs without a holder, and for an id the records do not name.
  One existing test resumed two decisions with the first resumed session still running
  (`task_9pns_status_progress_logs_and_stop`); it now ends that session first.
- **`WorkerProgress.sessionId` is gone** (the reader of the tail): the TUI's `withProgress` no longer takes
  an id from the screen. A terminal worker's progress is the last lines of its tail, redacted and stripped.
- **The guard is asked only where the program's entry gives the probe** (`main.ts`); `runCli` without
  `insideSession` keeps the two older guards, so the test suite does not depend on what session runs the
  tests. The probe reads `ps -A -o pid=,ppid=,stat=,tty=` and matches the holder **or the process it
  started** among the parents (the holder may be gone while the agent lives); the leader of a terminal's
  session is the row with `s` in its state on the same terminal. With no running session of the state
  base nothing is asked of the system.
- **`stalled`, `not_moving` and `no_first_call` of a terminal worker need a journal read that is itself
  late enough** (`ServeRunView.marksAt`): the daemon reads the journal of a run with a live worker at most
  once a minute (and when the run's answer changes), so a line could otherwise be said on a read made
  before the agent's call. They come up to a minute after their bound.
- **`--status` lists a stalled worker by the quiet time the running daemon has watched** (the record's
  `started`; with no daemon, the worker's own), through `ServeDaemonDeps.quietFrom`.
- **`counts.alive`** counts a record that cannot be read too (it holds a worker place: fail closed), so
  `alive` is never less than `workers`. The fixture `fixtures/serve-formats/v1/serve-alive.json` was
  written by `acquireServeRecord` and `writeCycle`; `serve.json` stays as a record from before the field.
- **`t47_no_resume_for_a_worker_that_went_on` is in `local/test/serve-daemon.test.ts`**, whose test names
  must carry `t44`: its name has both. (After the merge of `main` the check wants the prefix of a decision of
  `docs/serve.md` followed by `_`, so the name ends `(t44_resume_reads_again_under_the_lock)`.)
- **The default is `terminal` from the last commit.** The tests that build `claude -p` say `worker: print`
  (the `deps` helper and the real-adapter rows of `cli/test/worker-launcher.test.ts`, the config and the
  launcher of `cli/test/serve.test.ts`, `tests/agents/claude-code-worker.test.ts`,
  `tests/agents/claude-code-serve.test.ts`). `cli/test/mcp-no-decisions.test.ts` builds the server's
  arguments itself and needed nothing; `local/test/serve-daemon.test.ts` and `tests/e2e` drive a launcher
  port or no worker at all. The two `tests/agents` files were changed without being run (no real agent
  here). This repository's own `.kodel/config.yaml` is the person's: until `engines: { claude: { worker:
  print } }` is committed there, `s` in `bun … tui` and a start by `bun … serve` are refused with the Bun
  reason, as "Risky" (2) says.

Step 9 (the TUI):

- **The real-PTY rows of the TUI are written and were not run** (`tests/pty/worker-terminal.test.ts`:
  `t47_real_tui_returns_to_the_same_place`, `t47_real_tui_returns_when_the_agent_ends`,
  `t47_real_tui_survives_a_double_detach_chord`, `t47_real_tui_resize_while_attached_reaches_the_agent`):
  they need the built artifact, and the implementation steps do not build. Here they skip with `no built
  artifact`. The handover of a real terminal from the TUI to a child (the last line of "Not verified
  here") is therefore still shown by nothing but these four; run them after a build, outside the sandbox.
  The launcher's rows of that file listed under steps 6-8 are still not written (step 11).
- **The row's words are shorter than the plan's, the card's are the plan's.** The tag column of a run row
  is 13 columns at most, so the row reads `◆ with you`, `◆ stalled` and `◆ not moving`; the card reads
  `agent waits with you`, `agent stalled · o opens it` and `the agent has not gone on since your decision ·
  o opens it`. `cannot start: <reason>` is on the task's row of the Backlog, in front of its title, until a
  start of that task is let through; it is set only for a refusal of the preflight.
- **`stalled` on the screen uses the default of `serve.stalled_after_s`** (30 minutes, `STALLED_MS`): the
  TUI does not read the `serve` block. It needs the journal quiet for that long (`Session.quietMs`) and,
  unless the profile says `idleWrites`, no output for that long. The daemon's own line follows the config.
- **The card of a worker whose process runs without a holder** keeps the line the test of step 7 pins
  (`agent lost (holder gone, child still runs)`) and adds under it `its process still runs without a
  holder; stop it: kodel agent stop <id>`.
- **A run that cannot be read is answered before the rule is asked** (`resumeOffer`): its `why` is `the run
  cannot be read`, where it was `the run is over`. `task_9pns_resume_offer_table` had `unreadable` in its
  list of ended states and is changed to say so.
- **The TUI's finish is a rule of its own file** (`finishOf` in `tui/worker-resume.ts`), with the same
  conditions as the daemon's `finish` action and not the same function: the daemon's works on its own run
  views. A daemon that is `silent` gives the finish back to the screen, as it does the resumes. The act
  (`finishWorker` in `tui/worker-start.ts`) reads the run again under the start lock and stops nothing
  unless it is a run of this checkout that has ended; a failed stop is told once and not tried again from
  that screen; `STATE_LOCKED` is tried again at the next read.
- **"The child can be spawned" is checked as "its program and its script can be read"** before the screen
  is left (`access`), since a spawn tells `ENOENT` only after it was tried. A start that still fails
  brings the screen back at once with the reason.
- **Under Bun the notice spells the path of this repository's build**: `node packages/cli/dist/kodel.js
  agent attach <id>` (`BUILT_KODEL`), the only place a TUI under Bun runs from.
- **Signals while away.** `SIGQUIT` is taken from the moment the screen is left until the keys are the
  screen's again (150 ms after the return). `SIGTSTP` is forwarded to the child and the TUI then stops
  itself with `SIGSTOP`; `SIGCONT` is forwarded. An ending signal ends the child with `SIGTERM` (the
  attach client: no session ends), and the terminal is not written to again, because the screen gave it
  back when it left.
- **The notice of the return is kodel's own words**, never the child's output: `Back from <name> · <the
  last line of the tail, redacted>`, or that the agent ended while the person was in it, with the line
  about `kodel agent stop`. It is worked out after the child is gone (one read of the records), so the
  screen comes back a moment after the `[detached: …]` line.
- **The preflight's note** (`PreflightResult.note`) is shown in the start question, under the task's name,
  before the person answers.

Steps 10 and 11 (the commands, the tests):

- **Found, not fixed (step 6a's guard): with `KODEL_STATE_DIR` set in the starter's shell the session
  guard says `outside` for a command of the agent.** A session's environment gets no `KODEL_*`
  (`session-env.ts`), so a `kodel gate` the agent runs resolves the default state base
  (`insideSessionOf(resolveBase(process.env))`, `main.ts`) and finds no record of the session it runs in,
  which was written under the starter's `KODEL_STATE_DIR`. For a terminal worker of a person who uses
  `KODEL_STATE_DIR`, `env -u KODEL_ENGINE kodel gate` on the agent's terminal is then stopped by the deny
  list alone. The wait command carries the state dir for this very reason; the guard does not. The real-PTY
  rows therefore use a home folder of the test's own and no `KODEL_STATE_DIR` (the common case), and no
  test pins the gap. The person decides what closes it (the holder could give its child the base under
  another name, or the guard could look at every base a record of the process tree names).
- **The commands are three files beside `agent-commands.ts`** (`agent-start.ts`, `agent-prune.ts`,
  `agent-doctor.ts`); the registrations, `attachSession`, the resume rule (`resumeProblem`) and the hint of
  `agent ls` (`resumeHints`) are in `agent-commands.ts`. What they need of the project is one object the
  CLI builds (`AgentProject`); the tests give the adapter, the attach client, the probes, the launcher and
  the committed block through `CliEnv.agent`.
- **`takeName` is an option of the local adapter's `start`** (`start(spec, { takeName: <old id> })`), not
  of the `SessionAdapter` interface. The adapter itself checks the old session before anything is written
  (a person's own, over, nothing of it running, the same name) and refuses with a reason. The move: a
  claim `<name>.json.take` made exclusively (of two resumes one gets it), the new record published, the
  claim renamed over the marker, and on a failed start the old marker written back by a rename. A claim
  whose session never began within 15 s, or is over, was left by a process that died and is taken away by
  the next resume. While a claim is in progress `rm` (and so `prune`) refuses the old record
  (`STILL_RUNNING`, "is being resumed"), so a failed resume has a session to give the name back to; if the
  old record was removed after the move and the resume then fails, the name is freed. `faults` names the
  steps `take_claimed`, `take_published`, `take_moved`.
- **`agent start --resume` of a session the engine started is refused by the adapter**, not by the
  command: a listing does not say who started a session (`SessionListEntry` has no `origin`), and a `ke-`
  or `kw-` name is refused by the command before that. A session with no name is resumed by its id and
  stays without one. The resume starts under the committed `engines` block like a plain start (a
  `terminal.command` that is not committed is shown and asked).
- **A plain `agent start` takes its prompt as optional**: without one the agent starts with none.
- **`agent doctor` prints ten lines for the seven checks** (the program is three lines: found, version,
  signed in; the decisions are two). The verdict is the launcher's own preflight for a run with no task,
  asked twice: for a start a person watches (the exit code) and for one nobody watches (a line `kodel
  serve can start one: no (…)` when only that one is refused). The version is the first `N.N.N` of
  `--version`, nothing else of a probe is printed.
- **`agent prune` with no `--older-than` removes every finished record** that the rule lets go; the runs
  are read once, and only when a record names one; a run that is not among them is "cannot be read".
- **`agent exec -a`** is the short form of `--attach` only before the command (`exec --pty -a -- cat`).
  After the command's first word it is the command's own, as it was before this change (`exec ls -a`
  runs `ls -a`), with `--pty` too (`tA_exec_attach_starts_then_attaches`).
- **AGENTS.md is changed in step 10** (the two lists of the person's commands, and `agent doctor` among
  what only reads), because `tA_agents_md_lists_attach` and the new
  `t47_agents_md_lists_the_registrys_human_only_commands` hold it to the registry. The rest of step 12's
  text is not written. **`t44_docs_carry_the_revised_text` and `t47_changes_doc_spells_the_migration_line`
  are left to step 12**: they assert text that step writes (`docs/serve.md` still has the old line).
- **`launchRun` is the launch half shared by `s` and `agent start --pipeline`** (`tui/worker-start.ts`). A
  run with no task whose text is the text of a run that is going is not made twice: the command says so
  (`a run with this very task is already going`).
- **`t47_worker_server_serves_no_decision_tool` is written here** (`cli/test/mcp-no-decisions.test.ts`):
  step 6 left it out.
- **The step-9 pipeline of `tests/pty/worker-terminal.test.ts` did not load** (a human step with no edge
  for `rejected`); the edge is added. Those four rows were never run, and are still not.
- **Written and not run** (they need the built artifact, a PTY, or the real `claude`; typecheck only):
  `tests/pty/worker-terminal.test.ts` (`t47_real_terminal_worker_attach_detach_finish`,
  `t47_real_worker_shell_cannot_decide`, `t47_real_orphan_is_not_doubled`,
  `t47_real_holder_and_agent_gone_at_a_wait_is_resumed`, `t47_real_orphan_behind_a_wrapper_is_not_doubled`,
  `t47_real_stop_ends_an_agent_behind_a_dead_wrapper`), `tA_exec_attach_real_terminal`
  (`tests/pty/pty-session.test.ts`) and `t47_real_claude_terminal_worker_cannot_decide_its_gate`
  (`tests/agents/terminal-worker.test.ts`). Run them after `bun run build`, outside the sandbox. In the
  real-PTY rows the resume after a decision is asked of the launcher (`launcher.resume`), which is what
  the daemon and the TUI call under the start lock; the rule that decides to ask is tested offline
  (`t44_*`).
- **The scripted fake terminal agent** is `writeFakeTerminalAgent` (`packages/testkit/src/fake-terminal-agent.ts`):
  a Node program written as `claude` into a folder for `PATH`, which answers the profile's probes, logs
  each start (argv, conversation id, the marks of its environment) and acts on typed lines (`!command` on
  its own terminal, `bg`, `quit`); options make it ignore the hangup, sit behind a wrapper, and switch
  terminal modes on. Its offline test runs it without a terminal.
- **The real-agent scenario makes its project inside this checkout's git-ignored `.kodel/worktrees`**
  (trust is inherited from the checkout) and types the three instructions into the worker's terminal
  with the adapter's `send`, as the person; kodel itself types nothing.

The fix of the guard (step 6a), after steps 10 and 11:

- **The gap found above is closed: the session guard knows a holder by its own command line.** Every
  holder is started with `--kodel-session-holder` as the last word of its argv (`HOLDER_MARKER`,
  `intermediateMain`), and nothing a session's child does can change the command line of its holder. The
  probe (`packages/local/src/session-guard.ts`) reads one column more (`ps -A -ww -o
  pid=,ppid=,stat=,tty=,args=`) and answers `inside` when a parent process of the command, up to the root,
  is such a holder, or when the leader of the command's terminal session is the child of one, whatever
  state base the session's record is under. The records of the state base the command resolves are still
  read, and still name the process a holder started (an agent whose holder is gone). The other mechanisms
  were weighed and left: a variable that names the base in the session's environment can be unset like the
  mark; a second index of holders outside the state base would write to the home folder of a person who
  moved the state on purpose.
- **What follows from it.** The table is now read for every command of a person, also when the state base
  holds no running session (one `ps` a command; `tA_inside_session_probe` asserted the opposite and is
  changed). An unreadable table is still `unknown` and leaves the two older guards. A process that gives
  itself the marker only gets its own descendants refused. `insideSessionOf` takes the table as an optional
  third argument, for its test.
- **The limit that is left** (said in `docs/decisions.md`): an agent whose holder is gone, in a session
  started under a `KODEL_STATE_DIR` that its own environment does not have, is found by neither way (no
  holder runs, its record is in another base). The mark, the deny list and the missing terminal of its
  shell commands remain; Claude Code ends when its terminal hangs up (spike criterion 10).
- **Tests:** `tA_inside_session_probe_knows_a_holder_of_another_state_base` (a fake table, no records; a
  person's command that only names the marker in its own arguments is outside) and
  `t47_session_guard_finds_a_session_of_another_state_base` (`cli/test/human-only.test.ts`: a real session
  of the real adapter under a state base of its own, whose child runs `env -u KODEL_ENGINE <kodel> gate`
  with a home folder that holds no state: refused with the session's words). The second reads the real
  process table and is skipped where that cannot be read (a sandbox); it was run outside one and passed.

Steps 12 and 13 (the docs, the follow-up):

- **The docs describe what was built**, where that differs from the plan's first wording: the prompt last
  and after `--`; a stopped worker left to the person; the row's short words and the card's long ones; ten
  lines of `doctor`; a resume that runs as the setting says now (conversations cross modes); the lines of
  `stalled`, `not_moving` and `no_first_call` up to a minute late.
- **`docs/engines.md` is the page of engine steps**, which are off; the part about a background agent
  (`worker`, `terminal`) is a section of its own there and says that it is on. `docs/changes.md` is the page
  of the patches; the migration note of decision 1 is its last section, where the plan and
  `t47_changes_doc_spells_the_migration_line` put it.
- **`t44_docs_carry_the_revised_text`** reads the plan's row as: the section "Decision T-44" holds the
  revised lines and none of the old ones; the section "T-44 as revised by T-47" keeps the old ones with what
  replaced each and why; no other test file names an old line. A third docs test was added,
  `t47_docs_name_the_guards_and_the_two_kinds_of_worker` (the refusal of the guard as printed, `kodel mcp`
  by hand as accepted, a fork worker and a background agent in AGENTS.md).
- **The decision log is the person's local note**: the entries T-47 and "T-44 as revised" are theirs to add;
  `docs/decisions.md` and `docs/serve.md` hold the English text.
- **No task was created or closed in the tracker** (the brief of this step says so). They are listed below
  for the person.
- **The agent help texts** (`kodel agent --help` and its commands) were written with the commands in step
  10 and needed no change.
- **One doubt about the real-agent scenario, not resolved:** its project is a repository of its own inside
  `.kodel/worktrees`, and the signed-in run of the spike saw such a nested repository ask to be trusted
  (only a git worktree of the trusted root did not). The scenario was never run; `tests/README.md` says to
  accept trust once for that folder if it stops there.

### The merge of `main` and the decision's number

- **The decision is T-47, not T-45.** `main` took T-45 (run attachments, task links) and T-46 (the base
  start order of `kodel serve`) while this run was going, so the person renumbered this run's decision:
  every `T-45` and `t45_…` of this plan, its tests, docs and comments reads `T-47` and `t47_…` now, and the
  fixture folder is `fixtures/session-formats/v1/worker-print-before-t47/`. The `T-45`, `T-46`, `t45_…` and
  `t46_…` that remain in the repository are `main`'s.
- **Where the plan and `main` met, `main`'s shape was kept and this run's was added to it.** `StartCheck`
  carries `main`'s `warning` (the task's links) beside this run's `note` and `reason`; `withStartReady`
  keeps `main`'s fifth parameter (`warning`) and takes the preflight's `note` as a sixth, so the two rows of
  `tui-worker.test.ts` that pass a note pass `undefined` before it; the start question shows the warning
  above the question and the note under it. `kodel serve --status` lists this run's counts and stalled
  workers, then `main`'s two queues and blocked tasks. The daemon's read of the runs answers `main`'s
  `unreadableOpen` beside this run's cleanup of the journals it keeps for live workers. The refutation list
  of T-44 in `docs/serve.md` is this run's revised one with `main`'s clause about links on its approval line.
- **The pipeline's `test` step** takes `main`'s numbers (`timeout: 1800`, `expected_duration: 1100`), not the
  1500 accepted during this run: the person agreed.

### After the second merge (main's MCP roles, 5M9D)

- **A plain `agent start` no longer has a server that may decide.** The plan said such a session "uses the
  project's own kodel server, which may decide when `decisions.agent` is on". Main's 5M9D decided otherwise for
  every kodel session: a child of a session carries `KODEL_ENGINE=1` (forced by `sessionEnv`, by the holder and
  by `ptyChildEnv`, since KDJS and HN8N, for `agent exec` and `agent exec --pty` as well), and under it `kodel
  mcp` with no `--role` is a worker, `--role manager` and a bare `--read-only` do not start
  (`cli.ts`, `docs/mcp-roles.md`, "Under `KODEL_ENGINE`"; the task of 5M9D says it verbatim and names an agent a
  person started with `agent exec`). A plain `agent start` is the same case, so the command, `agent doctor`,
  `docs/decisions.md`, `docs/mcp-roles.md` and `docs/session-formats.md` now say what is true: the agent's
  own kodel server is a worker there, with no history and no manager tools, and decides nothing.
- **Why the mark was not taken off a person's own session instead.** It is read by more than the role
  default and the first guard of a person's command: `kodel serve` refuses by it alone, `task add|set` count as
  a person's only without it (a task made in a session would otherwise be started by the daemon with no `task
  approve`; in a terminal session a command can have a terminal), and the path of a stored image is withheld
  by it. The session guard of step 6a covers only the registry of person's commands, not these. Taking the
  mark off would also need a new field of the session's start (the spec refuses `KODEL_ENGINE` in `env`) and
  would undo a rule of 5M9D inside this task. A person who wants an agent that decides or manages starts it
  outside kodel, as `docs/mcp-roles.md` says. Whether a person's own session should get the server "as
  configured" is a decision for the person (it changes 5M9D), not a fix of this merge.
- Tests: `t47_agent_start_plain_says_its_server_is_a_worker` (the new words, with and without
  `decisions.agent`), `t47_agent_start_plain_session_makes_the_projects_server_a_worker` (new),
  `t47_doctor_decisions_dialog_and_agent` (the doctor line).

## Follow-up tasks (for the person to file; none is in the tracker)

1. **Close TASK-K6MA** (`agent exec --pty --attach`; `tA_exec_attach_*`) **and TASK-DSKQ** (the stored id of
   an agent's conversation, `agent ls`, `agent start --resume`; `tA_agent_record_*`,
   `tA_agent_ls_lists_mode_and_agent`, `t47_resume_keeps_the_name_and_links_the_old_record`,
   `t47_resume_refusals`, the marker tests) once this run is merged.
2. **"Codex and opencode as engines (profiles, worker and agent start, their safety criteria)"**: the text
   of step 13 above is the task's body, as it stands (profiles and lifting the refusal of decision 2; a
   spike per engine with safety criteria; the rules that were codex's; an id that cannot be chosen and a
   real `agent-observed.json` fixture before session format v1 is frozen; waiting in the foreground;
   choosing the engine; the rest). About 4 working days by the estimate of attempt 3. `kodel serve` starts
   nothing from it until `kodel task approve`.
3. **An automatic wake-up** of a live worker that has not gone on after a decision (today: one log line and
   the card's line; nothing is typed).
4. **A kill beyond the group on a session's own timeout**: a session's own timeout signals its child's
   process group, and only while its leader lives (`session-pty.ts`), so a `kodel wait` in a group of its own
   of a session killed by its 7-day timeout lives on to its own end.
5. **Before a release, by hand** (`tests/README.md`, "Terminal workers: what the tests cannot show"): the
   real-PTY rows and the real-agent scenario that were written and not run, on the built file; Linux for
   spike criterion 10; a long conversation with compactions for criterion 8.

After the review (the three blocking findings and the cheap minor ones):

- **`kodel agent doctor` runs only the committed program.** `--version` is run for the program of
  `terminal.command` only when the `engines` block is the committed one; for a block that differs, has no
  committed version or cannot be compared, the program is looked up and named, its version is `unknown
  (<program> is not run: …)`, and the sign-in probe (always the profile's own `claude`) runs only when
  `claude` is on `PATH`. `t47_doctor_never_runs_an_uncommitted_terminal_command`.
- **The tests that had not been run were run on the built file, outside the sandbox**
  (`KODEL_REQUIRE_PTY=1`): `tests/pty/worker-terminal.test.ts`, `tests/pty/pty-session.test.ts`,
  `tests/pty/attach-client.test.ts`, `tests/e2e/wait-command.test.ts`. One defect was in the test, not in
  the code: the four TUI rows looked for text that is not ASCII (`◆ running`, `┃`, `·`) in the terminal's
  output, which the harness keeps as a binary string; they now look for the bytes (`raw()`).
- **The real-agent scenario** (`tests/agents/terminal-worker.test.ts`, claude 2.1.330) stopped at the trust
  question in a fresh repository under `.kodel/worktrees` (a repository of its own does not inherit trust,
  as the spike saw). It now builds its project at one fixed path (`KODEL_AGENT_TRUSTED_DIR`, else
  `.kodel/worktrees/terminal-worker-project`) that a person trusts once, and fails at once with that
  instruction when `claude` asks. It passed in the folder the person had trusted for the spike. Known and
  left: `trustProbe` answers `trusted` for such a nested repository (a folder above it is trusted) while
  `claude` asks; a run's worktree, which is what a worker starts in, is a git worktree and does inherit.
- **The fixture `worker-print-before-t47/`** is now taken from the build before the change (above).
- **Minor:** `sessionIdOf` of the argv reader takes no tail; the plain `agent start` gives its session the
  environment a worker gets (no `CLAUDECODE`, `CLAUDE_CODE_*`); `exec -a` (above); AGENTS.md says when
  `agent start` asks; the daemon drops the kept journal read of a run that left its list (no test: the map
  is not seen from outside); the row of `t44_daemon_finishes_through_the_launcher` says what the code
  does (a failed finish is tried again next cycle); the spike's scripts take this checkout unless
  `EKAV_MAIN` names another, and its note opens with the final verdict.

After the person tried it by hand (the final gate, five comments):

- **`kodel agent doctor` reads at a glance.** One line a check with a mark in front (`✓` holds, `✗` does
  not, `?` cannot be told), the check, and what was found (a path, a version, the reason). Under every `✗`
  and `?` an indented `→` line says what to do. The verdict stands apart: an empty line, no indent, `✓ a
  worker can start` or `✗ a worker cannot start  <the launcher's reason>`, and `✗ kodel serve cannot start
  one  <reason>` when only a start nobody watches is refused. Green, red and yellow marks and a dimmed value
  only when stdout is a terminal and `NO_COLOR` is not set (`CliEnv.outIsTerminal`); what a probe or a file
  said goes through `plain`, so it cannot fake a line or a colour. The seven checks, their order, what is
  run (only the committed program) and the exit code are as before; the notes above that say "ten lines"
  and quote `check: yes (detail)` describe the older wording. `decisions.agent` on is still a `✗` (the
  check is "off"), and its line says that nothing stops a worker. Tests:
  `t47_doctor_marks_every_check_and_says_what_to_do`, `t47_doctor_verdict_stands_apart`,
  `t47_doctor_colours_only_a_terminal_without_no_color`, `t47_doctor_value_cannot_fake_a_line_or_a_colour`,
  and the older rows read the new lines.
- **`kodel agent ls` is `ID NAME STATE MODE AGENT CONVERSATION`.** `AGENT` is the engine, `CONVERSATION`
  the id of its conversation (whole for a UUID, cut at 36 characters for a longer id). The `COMMAND` column
  is gone from the table; `--json` has the command whole. It was not added to `agent logs`: that command
  prints the session's output and nothing else, and a header there would change what scripts read.
- **`stop`, `rm` and `logs` take a name or an id**, as `attach` does (`resolveTarget`: an id that is listed
  is taken as it is, also when its records cannot be judged; else the rule of `resolveSession`: of the
  sessions that used the name, the one that runs, then the newest). `stop` and `rm` find the session before
  they ask: an unknown name fails at once with `NOT_FOUND: no agent "<name>"` and no question, and the
  question names what was found (`Stop agent sh1 (a_…)?`). `rm` still takes the id of a folder that has no
  record (it is not listed). Tests: `tA_agent_stop_takes_a_name_or_an_id`,
  `tA_agent_stop_of_an_unknown_name_fails_before_the_question`, `tA_agent_rm_takes_a_name_or_an_id`,
  `tA_agent_logs_takes_a_name_or_an_id`, `tA_agent_stop_and_rm_by_name_on_a_real_session`.
- **A terminal worker's deny list has no `Write(...)` rule** (the one-line change the note of steps 4 and 5
  left open): its paths are denied with `Edit(<path>)` alone, so claude prints no "never matches" warning
  above the prompt. The print list keeps both, and the print spec stays what it was. A plain `kodel agent
  start` passes no deny list at all, so it had no such rule. `t47_terminal_worker_list_has_no_write_rule`;
  `t47_every_denied_path_has_an_edit_rule` no longer asks for a `Write` rule.
- **`o` shows no shell.** The TUI no longer leaves its alternate screen when it gives the terminal away: it
  switches its own modes off, clears the screen and writes `opening <name>…` (`handoverScreen`). The child
  is `kodel agent attach <id> --keep-screen` (a hidden option; `AttachClientOptions.keepScreen`): it clears
  the screen once for the session's first output, takes the switches of the screen out of the session's
  output (`createScreenSwitchFilter`: an agent whose program enters or leaves an alternate screen of its own
  would otherwise show the shell), resets the other modes on every way out, does not leave the screen and
  prints no `[detached: …]` line. The TUI then writes its usual `SCREEN_ON` and redraws over it. What
  changed in the guarantees of step 9: while away the TUI still has one thing to put back, so a signal that
  ends it (and the `exit` handler) ends the child and writes `ESC[?1049l` once, where it wrote nothing
  before; an outside `SIGTSTP` leaves the alternate screen for the time both are stopped and `SIGCONT`
  enters it again. Raw mode, the dropped input of the handover, `SIGQUIT` and the return to the same place
  are as they were. The cost, said in `docs/tasks.md`: no terminal scrollback of the agent's output while
  it is opened from the TUI. Tests: the rows of `cli/test/tui-run.test.ts` (the alternate screen is left
  exactly once, at the end, on every path), `tA_attach_client_keeps_the_screen_of_its_starter`,
  `tA_screen_switch_filter`, `t47_agent_attach_keep_screen_reaches_the_client`; on a real terminal, run on
  the built file outside the sandbox: the four TUI rows of `tests/pty/worker-terminal.test.ts` (from `o`
  to the redraw no `ESC[?1049l` and no line of the client), the new
  `t47_real_tui_keeps_its_screen_when_the_agent_switches_screens`, and
  `tA_attach_client_keep_screen_leaves_the_terminal_clean` (`tests/pty/attach-client.test.ts`).

### The second merge of `main` (the MCP roles, 5M9D)

`main` gained the roles of the server (`kodel mcp --role worker|manager`, `--read-only`, the `mcp` block of the
config) and run attachments kept with a dev run. Where the plan and `main` disagree, `main` is followed:

- **The worker's server is `kodel mcp --role worker --no-decisions`** and then `--no-wait-hint` (print) or
  `--wait-command <command>` (terminal). The plan spelled it without the role. So the print spec is no longer
  byte for byte the one from before T-47: it is the one of `main`, with `--role worker` in the `--mcp-config`
  (`t47_worker_print_spec_is_todays`, `t47_wait_command_carries_the_state_dir` and
  `t47_waiting_answers_spell_the_wait_command` expect the role).
- **The allow list is worked out at every start and every resume**, not once when the launcher is made:
  `servedTools` may be a function (`workerServedTools`), asked at the preflight and first thing in `start` and
  `resume`, before the `engines` block and the records are read, so a worker set that does not resolve
  (`CONFIG_INVALID`) is the refusal the caller sees and nothing is spawned in either mechanism.
- **Both prompts end with `main`'s sentence about missing kodel tools**, and the resume prompt says the tools
  may have changed; a terminal worker gets the same text (with the newline of step 4).
- **The server's instructions** are `main`'s text built from the served set, with this change's two additions
  kept: the wait command of the connection (`waitCommand`, which `mcp-server.ts` passes on again, since `main`
  no longer spreads the options) and the sentence that the `engines` block is the person's (now on both
  variants of rule 5). Rule 9a ends with `main`'s "pipeline_next_step never takes a step." The golden texts of
  `5m9d_no_role_instructions_match_the_golden_text` are not regenerated: the `engines` sentence is one more
  entry of that test's list of replaced lines.
- **AGENTS.md** names both blocks that are the person's (`mcp` and `engines`); `docs/tasks.md`,
  `docs/engines.md` and `docs/mcp-roles.md` spell the worker's server with the role and both wait flags.
- `main` does not use `T-47` or `t47_` for anything else.
- **`5m9d_worker_without_its_server_ends_as_a_dead_worker`** (`main`'s row on a real holder) names the print
  mechanism, as the other rows with a `claude -p` stand-in do: without an `engines` block the default is a
  terminal, which Bun cannot start.

Review round: what "stopped" means.

- **Only a person's stop is `stopped`.** The holder of a terminal session used to record `killed` with the
  reason `stopped` for any `SIGTERM` or `SIGHUP` it got; since the daemon leaves a `stopped` worker to the
  person, a shutdown at a gate would never have been resumed. The holder now writes that reason only when
  `stop.json` is there (`kodel agent stop` writes it before it signals anything); a signal without it is
  recorded as `killed` with `signal` (the holder's signal), a shape the status record already had, so the
  session format does not change. The pipes holder never had the conflation (it reads `stop.json` only).
- **The rule resumes a signal end.** `WorkerStatus.endedBy` is the record's reason, or `signal`
  (`ENDED_BY_SIGNAL`) for a `killed` record that names only a signal; `signal` is one of the ends of a
  terminal session at which the agent may have waited. This also covers a terminal agent whose own process a
  signal killed at the wait (a shutdown reaches it too, sometimes before the holder); a print worker killed by
  a signal stays a dead worker.
- **`kodel agent start --resume kw-<run>`** says who resumes it by how it ended: still running, its process
  left without a holder, stopped by the person (only `s`), ended where it may have waited (the daemon or `s`),
  or an end that was no wait (nobody). The card's "kodel serve resumes it" line and the "TUI is running the
  step" line name the end as the offer does (`agent killed (SIGTERM) at your decision · …`).

Review round: a person's stop is read from the stop record, for every end.

- **`stopped` no longer hangs on the reason of the status record.** A holder that had recorded its own end
  (its timeout, a `holder_error`, a signal) and left its program running was stopped by `kodel agent stop`
  without the record ever saying so: the decision table returned the recorded end and never looked at
  `stop.json`, and the daemon resumed the worker. `deriveStatus` now reads the stop record for every answer of
  a session that is over (a final record of any kind, no status after the grace, a holder gone while starting
  or running) and carries it as `SessionStatus.stoppedBy`; "a person stopped it" is `stoppedByPerson(status)`,
  the one question the launcher (`WorkerStatus.stopped`), `agent ls`, `agent stop` and `agent start --resume`
  ask. A stop record that cannot be read is `CANNOT_READ` for every such session (it was so only for a holder
  gone while running): never "nobody asked". The rule (`resumeVerdict`) applies the person's stop to a record
  in any ended state, an exit included.
- **The stop record says who asked.** `launcher.finish` (the daemon's and the TUI's end of the session of a run
  that is over) goes through the same `adapter.stop`, so its sessions read `stopped` like the person's. `stop`
  takes `{ by: "person" | "finish" }` (a person when absent) and writes it into the `by` of `stop.json`: `stop`
  for a person, as every record said before, `finish` for kodel. `by` was always a string, so format 1 is
  unchanged and no fixture is added (`tA_stop_record_names_who_asked_without_a_new_field`); an unknown `by`
  reads as a person's. A person's record is never replaced and replaces a `finish` (`writeStop`). A worker
  ended by `finish` is `stopped` in `agent ls` and has no `stopped` mark for the rule; `agent start --resume`
  says kodel ended it when the run was over.
- **Differs from before:** `agent ls` reads `stopped (after timeout)` for a session a person stopped after its
  holder's own end; the holder of a terminal session records `stopped` instead of `holder_error` on its
  unexpected-error way out when a stop record is there; a worker `finish` ended counts as a worker that ended
  fine (`endOf`), as a print worker that exits when its run is over always did; the fake launchers follow the
  real one (`stop` marks `stopped`, `finish` does not).
- **Texts:** `agent start --resume` no longer promises `s` for a worker stopped at work and words the rest with
  "if ... the run still goes" (the run's state is not read there); the card never says "agent exited" for a
  worker that did not exit (`over`, `undecided`, `not_at_wait`, `wait_before_start`, `went_on`,
  `no_session_id` use its own words); `docs/serve.md` says which place a stop frees when (the `max_workers`
  place at once; the `max_runs` place at once for a stop at work, at the decision for a stop at a wait), names
  both runs that keep `s resumes` under an active daemon, and its `killed` row names a signal.
- **Tests:** `tA_derive_status_a_persons_stop_shows_whatever_the_record_says`,
  `tA_derive_status_a_finish_stop_is_not_the_persons`,
  `tA_derive_status_an_unreadable_stop_record_is_never_nobody_asked`,
  `tA_derive_status_a_live_session_names_no_stop`, `tA_stop_record_by_names_the_asker`,
  `tA_stop_record_names_who_asked_without_a_new_field` (pipeline-core);
  `t44_a_persons_stop_is_never_resumed_by_the_daemon_whatever_the_record_says` (the rule);
  `tA_stop_record_keeps_the_persons_word`, `tA_stop_by_finish_is_stopped_but_not_by_the_person`,
  `tA_a_persons_stop_of_what_a_final_record_left_reads_stopped_{timeout,holder_error,signal}` (real processes
  of a pipes session), `tA_pty_holder_signal_with_a_stop_record_is_a_stop` and the stop case of
  `tA_pty_socket_unlinked_on_unexpected_throw` (the holder);
  `t47_a_persons_stop_of_what_a_final_record_left_is_never_resumed_by_the_daemon` (records to rule through
  `agent ls --json`, with the places), `t47_child_alive_reaches_the_rule` (its stop now goes through the
  decision table), `t47_only_a_persons_stop_is_stopped`, `t47_finish_of_a_stopped_session_is_harmless`,
  `t47_resume_refusals`, `t47_a_worker_that_did_not_exit_is_never_said_to_have_exited` (cli);
  `t47_real_persons_stop_of_what_a_final_record_left_is_left_to_the_person` (a real terminal session and the
  built `kodel agent stop`). `tA_pty_holder_signal_ends_as_stop` is now
  `tA_pty_holder_signal_stops_the_child_and_names_the_signal` (it never ended as a stop).

Review of the group rule (after step 12):

- **The person chose: never signal a group without a live leader.** The review found that a group whose
  number is no live process's pid is not proven to be the session's: after the group emptied, another program
  can get the number, make a group of it (`setsid`), start children there and exit, and `agent stop` would
  have signalled those. So `stopGroup` signals nothing. `SessionStatus.group` has a third value, `leaderless`
  (members are in the group of a recorded child that is gone), with `leftover` (the members; `command` filled
  in by a stop). `agent stop` prints `not stopped`, the members and the instruction (`kill <pid>`, then
  `kodel agent stop <id>` again); `agent rm` refuses with the same instruction.
- **The stop record is still written** when nothing is signalled: it says who asked, not what was signalled,
  and without it the daemon would resume an agent the person asked to stop once its processes are gone. The
  record keeps `childAlive` until then, so nothing reads it as ended.
- **Liveness is unchanged** (fail closed): such a group counts as "still runs", the daemon holds both places
  and resumes nothing. Stated limit: while a process of the group lives, another program's too, the record
  cannot be removed through kodel.
- **The stop of a live child follows the same rule:** the last `SIGKILL` goes to the group only while the
  recorded child still lives; after its end the members listed while it lived are signalled by pid, each only
  with an unchanged start time (`killTree`'s delayed group signal is no longer used by `stop`). Where the
  process table cannot be read, a member that is no descendant and ignores `SIGTERM` is then left.
- **Tests replaced:** `tA_stop_ends_a_group_only_orphan_*`, `tA_rm_after_the_group_is_stopped`,
  `tA_real_group_orphan_is_seen_and_stopped` and `t47_real_stop_ends_an_agent_behind_a_dead_wrapper` expected
  signals to a leaderless group; the tests named in the acceptance table expect none and the instruction.

### `killTree` and the terminal holder's escalation follow the rule too (review of the stop rule)

The review found that `killTree` (`command.ts`), used by the pipes holder's timeout, its "folder removed" path
and `runCommand`'s timeout and abort, still sent `SIGKILL` to the group 2 s after `SIGTERM` by a timer nothing
cleared, whether or not the leader had ended in between.

- **`killTree` takes the child, not a pid.** It signals the group only while the child is not reaped by this
  process (`exitCode` and `signalCode` are both unset, so the pid is still the child's own) and is a live
  process; the pending `SIGKILL` is dropped at the child's `exit` and the same check is made again right
  before it is sent. A second call for the same child sends `SIGTERM` again and keeps the one pending timer.
  It returns what drops the pending signal. The first `SIGTERM` is under the same check: `runCommand`'s
  timeout can fire after the shell's exit while its pipes are still read.
- **The terminal holder** (`session-pty.ts`): the escalation timer was already cleared at the exit; it now
  also looks at the exit when it fires, and the trait over the module signals the group (and the pid) only
  while the pid is still the live process it started (identity read at the start).
- **Stated limit:** a group member that ignores `SIGTERM` and outlives its leader is not killed by a timeout
  or an abort, and nothing names it, for a session and a pipeline command alike: a holder that ends its
  session by its own timeout records the end, and the group is looked at (`leftover`) only for a session whose
  holder went away without recording one.
- **Docs:** the limit in `docs/session-formats.md` and the two places above that said "the timeout signals
  only the child" now say what the code does: the child's process group, and only while its leader lives.
- **Tests:** `t47_kill_tree_*` and `t47_run_command_timeout_kills_a_command_that_ignores_sigterm`
  (`command.test.ts`), `tA_pty_group_is_signalled_only_while_its_leader_lives`,
  `tA_pty_timeout_escalation_is_dropped_when_the_child_ends`,
  `tA_pty_timeout_kills_a_child_that_ignores_sigterm` (`session-pty.test.ts`). The cleanup of
  `tests/pty/worker-terminal.test.ts` kills its strays by pid, never by group.


### No group signal on a doubt about the leader (second review of the stop rule)

The review found two places where a group could still be signalled without a leader known to live, and one
claim the code does not keep.

- **`stop` looks at the leader again before the group `SIGTERM`** (`session-pipes.ts`, `stopNow`). Between the
  identity check and the first signal lie the stop record, a listing of the process table, the walk of the
  descendants and their identities. Every group signal of a stop (`SIGTERM` and `SIGKILL`) now goes through
  one function that reads the leader's identity right before it; when the leader is gone or cannot be told,
  the members listed while it lived are signalled one by one, each only while it is still the process of
  that listing.
- **The terminal holder does not signal a group on a doubt** (`session-pty.ts`). The trait's `leader` used
  `sameProcess`, which answers "alive" when the identity was not read at the start or cannot be read now.
  `ptyLeader` answers `same`, `unknown` or `gone`; the group is signalled only on `same`. On `unknown` the
  child's pid alone is signalled, and only before the module reported its exit (until then it is the
  holder's own child); on `gone` nothing is. The pid-alone signal on a doubt is kept on purpose: without it
  a session whose identity cannot be read could not be ended by its own timeout at all. Its limit is the
  moment between the module's reaping of the child and its report of the exit.
- **The "named as leftover" claim was wrong** for a holder's own timeout and is now stated as a limit here
  and in `docs/session-formats.md`: the survivor is not seen by kodel.
- **Tests:** `tA_stop_looks_at_the_leader_again_before_the_group_sigterm` (`session-pipes.test.ts`, real
  processes: the leader is killed between the stop record and the signal, and a member of its group lives on),
  `tA_pty_group_is_not_signalled_when_the_identity_was_not_read_at_the_start`,
  `tA_pty_group_is_not_signalled_when_the_identity_cannot_be_read_now`,
  `tA_pty_group_is_signalled_when_the_identity_matches`,
  `tA_pty_nothing_is_signalled_when_the_pid_is_another_process_or_gone`, and the widened
  `tA_pty_group_is_signalled_only_while_its_leader_lives` (`session-pty.test.ts`). Two tests that sent
  `SIGKILL` to a group whose leader might be gone (`cli/test/serve.test.ts`, `tests/pty/worker-terminal.test.ts`)
  signal the pid.
- **Docs:** `docs/engines.md` names `kodel agent start --pipeline` as the command that starts a run's
  background agent (`agent start` alone starts an agent of no run).

### `killTree` ends what is left of a group whose leader ended, by pid (regression of the rule above)

Dropping the delayed `SIGKILL` at the leader's exit left a pipeline command running on Linux: the command runs
as `sh -c '<command>'`, the shell (the leader) ends on `SIGTERM`, and a child of it that ignores `SIGTERM`
stayed in the group with nothing to kill it (`a command that ignores SIGTERM does not outlive the server
either`, `cli.test.ts`; macOS hid it, its `sh` replaces itself with the last command).

- **The rule stays:** a group is signalled only while its leader lives. `killTree` reads a clock right before
  the `SIGTERM` (the leader lives, so the group of that number is the child's then) and no longer drops the
  escalation at the child's exit. When the grace is over and the child still leads, the group gets `SIGKILL`
  as before. When it has ended, the process table is read once and every live process whose group has that
  number and that had started before the `SIGTERM` is killed by pid, its identity read again right before.
  The number was in use by the child's group at the `SIGTERM`, so no other group had it then: a process that
  old in a group of that number is a member of the child's group, whoever has the number since.
- **Clocks** (`process-table.ts`: `systemStartClock`, `startedBefore`): on Linux `/proc/<pid>/stat` (start in
  ticks since the boot) against `/proc/uptime`, and the session's number has to be the group's too (the child
  is started as a session leader; an older process cannot join a newer session). Elsewhere `ps`'s `lstart`
  (whole seconds, wall clock): a process counts when its whole second lies before the `SIGTERM`, and nothing
  counts when the wall clock went back against the steady one in between.
- **Stated limits:** a member that started in the tick (Linux) or second (`ps`) of the `SIGTERM`, or after it,
  is left; nothing is signalled where the table or the clock cannot be read; with `ps` (no session column
  read) an old process of another program that moved itself into a new group of the reused number within the
  grace would be taken for a member. The reading needs the process that sent the `SIGTERM` to be up at the
  end of the grace (the MCP server waits; a holder that recorded its session's end is gone by then, so the
  limit of the section above holds for a session's own timeout).
- **Tests:** `t47_kill_tree_leader_gone_before_the_grace_kills_its_members_by_pid_and_no_group`,
  `..._leader_gone_with_no_member_left_signals_nothing_more`,
  `..._member_is_killed_only_while_it_is_still_the_process_of_the_table`,
  `..._leader_gone_signals_nothing_where_the_table_or_the_clock_cannot_be_read`,
  `t47_started_before_takes_a_whole_second_of_ps_and_refuses_a_clock_set_back`, and with real processes
  `t47_kill_tree_real_member_that_ignores_sigterm_does_not_outlive_its_leader` (`command.test.ts`).

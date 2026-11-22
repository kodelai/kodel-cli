# `kodel serve`: start and resume background workers

`kodel serve` is a daemon for one checkout. Every 5 seconds it looks at the tasks, the runs and the
background workers (the agents `s` starts in `kodel tui`) and does four things, by rules you write in the
project config:

- it **starts** a task that matches your rule in a background worker, within two limits;
- it **resumes** a worker that ended at a gate or a pause once you have decided, with no TUI open;
- it **notes** in a run that its worker is gone, so `kodel status`, `kodel report` and the TUI say so;
- it **finishes** the terminal session of a worker whose run is over.

It decides nothing about a run: it never approves a gate, resumes a pause, accepts a change or acks a state.
Those stay your commands. The design decision is **T-44** (see the end of this page).

It runs in the foreground, prints one plain, redacted line per event, and is meant to be run by a service
manager (examples below). It needs tasks (`docs/tasks.md`) and the same things a worker started from the
TUI needs: `claude` on the `PATH` and signed in, a git repository and `worktree.mode: auto`. It does not run
on Windows yet.

## A worker is a terminal session, or a print process

How a worker runs is a setting of the `engines` block (`docs/engines.md`): `engines.claude.worker`.

- `terminal` (the default, also when the key is absent): `claude` runs as an interactive program in a
  terminal of its own, the session `kw-<run>` (`kodel agent ls` shows it with `MODE` `pty`). You can open it
  (`o` on the run in `kodel tui`, or `kodel agent attach kw-<run>`; `Ctrl+\` leaves it running). **At a gate
  it stays alive**: it tells what waits, starts `kodel wait` in the background and goes on within seconds of
  your decision, with or without a daemon or a TUI. It cannot decide. A session lives up to 7 days.
- `print`: `claude -p`, as before this setting existed. It prints and exits; at a gate it exits, and the
  daemon (or `s` in the TUI) resumes it after your decision.

Nothing switches between the two by itself. Where a terminal cannot run (kodel from source under Bun, the
optional package `@lydell/node-pty` or its binary missing), a start is refused with the reason, no run is made
and the daemon uses no attempt; the refusal spells the line that keeps print workers,
`engines: { claude: { worker: print } }`, to commit in `.kodel/config.yaml` (`docs/changes.md`). The daemon
and the TUI use the `engines` block only as committed (`HEAD` of the checkout), since a worker's shell can
write the file. `kodel agent doctor` says whether a worker can start here, and why not: one line a check
with a mark in front (`✓` holds, `✗` does not, `?` cannot be told) and what was found, an indented `→` line
under every `✗` and `?` that says what to do, and the verdict apart at the end. The marks are coloured only
when the output is a terminal and `NO_COLOR` is not set.

A terminal worker's `kodel mcp` server lives as long as its session, so a worker that is alive keeps the
server of the build that started it: a fix of the server reaches it only when it is stopped and resumed.
Neither `agent doctor` nor `--status` shows a worker's build.

Kodel never types into a session. What is typed there is typed by you.

## The `serve` block

Only you edit this block. It is off by default, strict at every level (a misspelled key is an error that
names it, so a typo cannot widen what starts) and read again every cycle.

```yaml
serve:
  enabled: true            # default false: the daemon runs idle and says so
  max_workers: 2           # 1..64, default 1: agents that are working
  max_runs: 4              # 1..64, default 1: open runs that have a worker
  stalled_after_s: 1800    # 0..86400, default 1800; 0: never
  start:                   # absent or []: starts nothing, only resumes and watches
    - pipeline: dev        # the first rule whose match fits a task wins
      match:               # every key optional; an empty match is every `todo` task you approved
        status: [todo]             # exact status names
        priority: [urgent, high]   # any of
        parent: TASK-AB12          # direct children only
        approval: required         # default; `any` also takes a task that waits for `kodel task approve`
    - pipeline: triage
      match:
        approval: any
```

`start` is a list of rules. For each `todo` task the daemon takes the first rule whose `match` fits it, and
that rule's `pipeline` is the one the task starts with; a task no rule fits is not started. With `approval:
required` (the default) a task that waits for your approval does not fit the rule, so a later rule with
`approval: any` may take it. In the example a person's urgent child of TASK-AB12 starts with `dev`, and every
other `todo` task, an agent's too, starts with `triage`. A key a rule does not know is an error that names it.

With `enabled` not `true`, or a config that does not load, the daemon is idle: it does nothing, says why
once and looks again every cycle. A kodel older than this block refuses the whole config (`unknown key:
serve`), see `docs/run-formats.md`.

## A cycle

1. Read the config. A change outside the `serve` block, or a new kodel build on disk, ends the daemon with
   exit code 75 (the host, the tracker and the launcher are built once; the service manager starts it again).
2. Read the runs (a finished run is read once and remembered: later cycles list it but do not read its state
   again) and the worker records (`kodel agent ls`). If the records cannot be read, the cycle does nothing.
3. When a start is possible, check the environment (at most once a minute) and read the task list.
4. Plan: one pure function (`planServe`) decides what to note, resume and start, in that order.
5. Act on each item; a failed item is logged and the next one runs.
6. Write the daemon's record (below).

## Starting a task

A task is started when all of these hold:

- its state is `todo` and one of your rules matches it (the first one that does decides the pipeline);
- no run names it, and the tracker lists no run for it besides the one it was found in;
- it does not wait for your approval (below), unless the rule that matched it says `approval: any`;
- its latest comment is not the daemon's give-up;
- both limits have room, and starts are not paused.

Tasks go in the tracker's priority order, then its list order, across all the rules: a rule decides only
whether a task is taken and with which pipeline. The pipeline of every rule must load, or nothing starts. A start is what `s` does in the TUI: a run
through the host with the task's key, then one worker for it, from the `HEAD` of the checkout at that moment.
If the host answers with a run that already existed, the daemon launches nothing for it.

The daemon launches **once per run**. If the launch fails and no worker record exists for the run, it writes
`gone` with `not_started` into the run and leaves it; the task is not started again, and any agent can
continue the run with `pipeline_next_step`. If the worker records cannot be read right after the failed launch,
the daemon writes nothing then and looks again in the next cycle that reads them: a record found then means
nothing is written, no record means the same `not_started` note.

A start that fails before a run exists is tried again in later cycles, 60 seconds apart. After three, the
task gets a comment:

```
kodel serve: not started after 3 attempts (pipeline dev): <reason>. A newer comment makes the daemon try again; or start it by its key in the TUI.
```

A long reason is cut so the comment fits the tracker's 500 characters. If the tracker refuses the comment
anyway, the daemon logs the give-up once and does not start the task again until it restarts.

Problems of the environment use no attempt: no `claude`, not signed in, `decisions.dialog` on (it refuses
every worker, terminal ones too), a terminal that cannot run here while the setting says `terminal`, an
`engines` block that differs from the committed one (`engines is used only as committed: commit
.kodel/config.yaml or put the block back as it was`; when git itself fails, git's reason), a worktrees folder
where `claude` will first ask whether the folder is trusted (nobody is there to answer; when that cannot be
told the start goes on and the log says so once), a pipeline that
does not load or has uncommitted changes, no git, `worktree.mode: off`, a tracker that cannot attach runs or
keep the mark, more than 1,000 candidates, unreadable worker records, the start lock busy for 15 seconds.
Then nothing starts, and the log says so once per change. These problems, and a task list the tracker gives
only in part, block starts only: notes and resumes go on in the same cycle. (Worker records that cannot be
read, or a list of runs that cannot be read, when a cycle begins stop the whole cycle: nothing is noted, resumed
or started. A single run that cannot be read is logged and keeps its places against the limits; the cycle goes
on with the others.)

### Three dead workers in a row

When three workers in a row that the daemon started end outside a wait (they died, were killed, exited
before the run reached a gate or its end, or their launch failed), the daemon starts nothing more and says so. A worker that reaches
a wait or the end resets the count, and so does a restart of the daemon. This keeps a fault the checks cannot
see (a usage limit, a missing SSH key in the service's environment, a full disk) from walking through your
whole backlog one dead run at a time.

## The two limits

The two limits mean two things: `max_runs` is how many reviews may pile up (and how many agent processes
may be alive), `max_workers` is how many agents work at once.

- `max_runs` counts open runs that have a worker, waiting ones too, from the start until the run ends or its worker is gone
  for good. A run waiting at a gate keeps its place. So does a run you have decided but the daemon does not
  resume because an agent moved it on since your decision, a run whose worker exited at a wait you have
  not decided yet: each keeps its place until the run ends (or you remove its worker records). With
  `max_runs: 1` such a run blocks every start; continue it with any agent (`pipeline_next_step`) or end it.
  A run whose worker died before a wait, or stopped at a wait that another agent then took the run on from
  (that worker is not counted or noted as dead), frees its place: the daemon never resumes that worker.
- `max_workers` counts agents that are working: a live worker whose run does not only wait for you. A
  terminal worker that is alive while its run only waits for you (a gate, a pause) holds **no** `max_workers`
  place; in a fork with a step left for the agent it holds one. A print worker, a worker whose state cannot
  be read, a live worker of a run that cannot be read, and a worker still finishing after its run ended
  each hold one. So with `max_workers: 1` and `max_runs: 3` a second task starts while the first waits at
  its gate, and with three open runs none does.

**A worker your decision wakes goes on even when `max_workers` is full**: nothing is done against it. The
count also goes over the limit when you start an agent by hand, or lower `max_workers` while agents work.
While more agents work than the limit, whatever the cause, the daemon starts and resumes nothing and says
once `W agents work, over the limit of M by N; nothing is started or resumed until an agent reaches a wait
or ends`. When the count falls, the waiting resumes and starts follow.

**A worker whose process still runs without a holder** (its record says `lost` or `killed` with "child still
runs", `docs/session-formats.md`) holds both places and is never resumed, finished or noted as gone: a
second agent must not be started beside the first. The daemon says once `kw-…: its process still runs
without a holder; stop it: kodel agent stop <id>`, and the card says the same. After your stop the worker
reads `stopped`: both places are free, and the daemon leaves it alone (`s` in the TUI resumes it). Where the
process table cannot be read (a sandbox), only the process the holder started is looked at, and the daemon
says once `cannot read the process table: an agent left behind a dead wrapper would not be seen`.

A start needs room in both; a resume needs room in `max_workers` only. When `max_workers` is full, resumes
wait, oldest decision first, and every waiting resume goes before any new start. A start you make by key in
the TUI (`s` on a task) ignores both limits; the daemon then starts nothing new until the counts are under
them. With an active daemon the TUI leaves resumes to it (the card says `kodel serve resumes it`), so they keep
`max_workers`; the one exception is a run an agent moved on since your decision, which the daemon does not
resume: the TUI still offers `s resumes` for it, and that resume ignores both limits.

## Resuming after your decision

**A terminal worker that is alive needs no resume**: its own `kodel wait` reports your decision and it goes
on. If it has not called the engine 2 minutes after your decision, the daemon says once `kw-… has not gone on
since your decision (N s); nothing is typed for you, open it: kodel agent attach <id>` and the card says `the
agent has not gone on since your decision · o opens it`; no such line when the run already waits for you
again. This line is also the only sign of a worker whose `kodel wait` was lost: before your decision nothing
tells it from one that waits, because kodel does not see what an agent runs.

**A worker that ended at the wait** is resumed in a new session. That is a print worker (it always exits at a
wait), and a terminal worker that ended while its run waited for you (it quit, a reboot, its 7-day timeout,
a lost holder), or after your decision without any agent having called the engine since. One you stopped
(`kodel agent stop`) is not resumed by the daemon; the TUI offers `s resumes`. An agent you quit from inside
(`/exit`, `Ctrl+D` while attached) is `exited`, not `stopped`: kodel does not read what is typed, so it is
resumed like any worker that ended at a wait; `kodel agent stop` is the way to end one for good.

**A terminal worker that ended after it had gone on** (it ended after your decision, and the journal has an
agent's line after that decision) is a dead worker: noted, counted, its `max_runs` place freed; the card says
`agent died after your decision`. A worker that ended at the wait before your decision, whose run another
agent then took on, is neither resumed nor a death. A `lost` worker has no known end (its record says when
the loss was noticed), so it counts as ended after your decision only when it printed something after it.

A worker that ended at a wait and whose run you then decided (`kodel gate`, `kodel resume`, the TUI) is
resumed as `kw-<run>-d<seq>`, once per decision, in the first cycle with a free worker place, by the same rule
the TUI uses to offer `s resumes`. The resumed session continues the stored conversation (its id is in the
session's `agent` record, `docs/session-formats.md`; for a record from before that file, in its argv) and
runs as the setting says now, `terminal` or `print`; a resume whose mechanism cannot run here, or whose id is
not known, is refused, makes no record and counts as one failed attempt. Right before, the daemon reads the journal again: if an agent was served,
claimed or completed a step since your decision, it does not resume. It reads the worker records again too:
if the run's record was removed (`kodel agent rm`), the run is no longer going, or `max_workers` is full by
now, it does not resume in this cycle.

A resume whose launch fails (no `claude`, not signed in) is tried again 60 seconds later; meanwhile it goes
before any start, as a resume waiting for a worker place does. After three failures the daemon logs
`resume_failed` once and does not try that decision
again: continue the run with any agent (`pipeline_next_step`), or stop the daemon and resume it in the TUI.

Removing a resume's record (`kodel agent rm`) frees its name, so that decision may be resumed again.
Removing every record of a run takes the run away from the daemon: it is not resumed and nothing is launched
for it.

## A worker that is gone

When a worker the daemon watches is gone, it writes the journal event `worker_note` into the run, once per
worker record:

| reason | what happened |
| --- | --- |
| `lost` | the worker's holder is gone (a reboot, a kill), outside a wait |
| `killed` | killed (by its timeout, or by the launcher when it could not be kept) |
| `exited` | exited outside a wait (with its exit code) |
| `not_started` | the launch failed and no record was made |

`kodel status <run>` and the TUI card say, for example, `agent kw-r_… lost at 10:02 (its holder is gone); any
agent continues the run with pipeline_next_step`, and `kodel report` lists it (`workers_gone`). A worker you
stopped is not noted. The note changes no state and no route; a run of format 1 has no place for it and is not
changed (the daemon logs the death instead). A note the run does not take (its record's time is ahead of the
run's clock, say) is logged once as `not noted: …`. See `docs/history.md` and `docs/run-formats.md`.

A terminal worker that ended while its run waited for you is not gone: no note, no count, it keeps its
`max_runs` place and is resumed after your decision (above). A worker whose process still runs without a
holder is not gone either.

## A worker that is quiet, and a run that is over

`stalled_after_s` means "quiet for this long". A print worker is stalled when it has printed nothing for
that long. A terminal worker with a step open is stalled when it has printed nothing **and** called the
engine with nothing for that long: an agent in a long honest step prints, while one stopped at a usage limit,
an expired sign-in or a prompt of its own does neither and does not exit. Never while its run only waits for
you. The time is counted from the latest of the worker's last output, the last call of an agent, its start,
the daemon's start, and the last gap of more than 60 seconds between two cycles, such as a sleep. It gets one
log line per quiet spell (`kw-… printed nothing and called nothing for N s`), the row of the TUI reads
`stalled` (the card: `agent stalled · o opens it`) and `--status` lists it with the places it holds. Nothing
stops such a worker but you. (For an engine whose idle session keeps writing to its terminal, the profile
says so and the line counts engine calls alone: `no engine call for N s (it may be a long step)`. Claude
Code writes nothing while idle.)

A terminal worker that has not called the engine 2 minutes after its start gets one line: `kw-… has not
called the engine N s after its start; open it: kodel agent attach <id>`.

The calls of an agent are read from the run's journal, which the daemon reads at most once a minute for a
run with a live worker, so these three lines (`stalled`, the one after a start, the one after a decision) can
come up to a minute after their bound.

When a run has ended and its terminal worker is still alive, the daemon stops the session with the processes
it started, one session a cycle (`finished: run r_…: agent kw-… stopped (the run is over)`); if you are
attached you read `[killed: kw-…]` and have your terminal back. With no daemon an open TUI does the same at
its next refresh, for a run of this checkout whose state it read as ended; with neither, the session ends at
its 7-day timeout. A print worker is left to print its last line and exit. An open run, and a run that cannot
be read, are never finished.

An agent that died can leave a process behind in its group, most often the `kodel wait` it started in the
background. While one is there the session counts as having a live process (`child_alive`, and `agent ls`
says so): the run is not noted as left by its agent and nothing resumes it, until you run `kodel agent stop
kw-<run>` or the process ends by itself (a worker's `kodel wait` gives up at its 7-day timeout).

## Tasks an agent made or changed

A task an agent made with `task_create`, or whose title, body, status, priority or parent an agent changed
with `task_update`, **waits for your approval** before the daemon starts it: `kodel task show` and the TUI say
`waits for approval`, and `kodel task list` says `waits` in its `APPROVE` column. Approve it with:

```bash
kodel task approve TASK-AB12
```

It shows the task, asks, and refuses if the task changed while you were reading it (`TASK-AB12 changed while
you were reading; look again`). A task made at a terminal
by a person (`kodel task add`, the TUI) does not wait; tasks without a mark, including every task from before
this change, count as yours. See `docs/tasks.md`.

You may let a rule start such tasks without approval: `approval: any` in its `match`. Only you edit the `serve`
block, and the default stays `required`; a rule with `any` starts what an agent wrote as it is, so give it a
pipeline whose gates you read (the `triage` rule above).

## `kodel serve --status`

Prints, and changes nothing: whether a daemon runs for this checkout (its pid, since when, active or idle and
why, its state base), the counts against the limits (`working N of max_workers`, `alive M`, `runs with a worker K of
max_runs`), every stalled worker with the places it holds, your start rules in order (`rule 1:`, `rule 2:`, ...),
why starts are blocked, what waits for a place, and open runs with a task and no agent. With `serve.enabled`
not true the tasks and runs a daemon would take up once enabled are listed as `if enabled:`. It does not show
what the next cycle would do; a separate command will (TASK-H9QP).

## Exit codes

| code | when | a service manager should |
| --- | --- | --- |
| 0 | `SIGTERM`, `SIGINT` or `SIGHUP`; the action in hand is finished, workers go on (a second signal ends it at once, with 130 for `SIGINT` and 143 otherwise) | stop |
| 75 | the config outside the `serve` block, or the kodel build on disk, changed | start it again |
| 78 | what a restart does not fix: not in a project, Windows, `KODEL_ENGINE` set (a worker cannot start it), another daemon for this checkout, a daemon record that cannot be read or was written by a newer kodel, a daemon record that cannot be written (no permission, a full disk, a state base that is not a folder or not an absolute path), another `kodel serve` that took over the record | not start it again |

The refusal for another daemon names it: `kodel serve is already running for this project (pid 4242, since …)`.

## The daemon's record

`<state base>/serve/<uid>/<checkout key>.json`, where the state base is `KODEL_STATE_DIR`, else `~/.kodel`. It
is machine-local state, not history, and is written after every cycle (a temporary file, then a rename):

```json
{
  "v": 1,
  "pid": 4242,
  "identity": { "method": "ps-lstart", "value": "Sat Nov 21 10:00:00 2026" },
  "started": 1795251094810,
  "cycle_at": 1795251095802,
  "state": "active",
  "root": "/home/me/code/my-app",
  "state_base": "/home/me/.kodel",
  "build": "0.1.0",
  "counts": { "workers": 1, "alive": 2, "max_workers": 1, "runs": 2, "max_runs": 3 }
}
```

`counts.workers` is the worker places used (the agents that are working, what is shown beside
`max_workers`); `counts.alive` is every live worker process, waiting ones too, and one whose record cannot be
read. `alive` is an optional field added without a change of `v`: a record from before it has none, and an
older reader ignores it.

A second daemon refuses while the recorded process is alive; a record whose process is gone (or whose pid now
belongs to another process) is taken over. A record that is empty or half-written is taken over only when its
file is older than 5 seconds (its maker died while making it); a younger one is being made, and the second
daemon refuses and names the file. Any other record that cannot be read, or that a newer kodel wrote, makes a
second daemon refuse and name the file. Before each write the daemon checks that the file is still its own
(its pid and start); if another `kodel serve` took it over, it stops with 78. The format has one codec (`v`; unknown optional fields of a known `v`
are ignored, a newer `v` is refused with "upgrade kodel") and a fixture in `fixtures/serve-formats/`.

## The TUI with a daemon

With no daemon, or an idle one, the TUI works as before. With an active daemon the header shows `serve on (pid
N)`, and a run the TUI would offer `s resumes` for reads `agent exited at your decision · kodel serve resumes
it`. A daemon whose process is gone is seen at the next refresh; one that finished no cycle for 2 minutes is
named in the header and `s resumes` is offered again. A daemon record the TUI cannot read counts as no daemon:
`s resumes` is offered, and the name of the resume's record (`kw-<run>-d<seq>`) keeps the resume to one,
whoever starts it first. `s` on a task takes the same start lock as the daemon, so the two never start one task
twice. Resumes and finishes are made under that lock too, with the records read again inside it, so a daemon
and a TUI never both resume one decision, and nothing is resumed for a worker that went on by itself. With an
active daemon the TUI finishes nothing; with none (or a silent one) it finishes the terminal worker of a run
of this checkout that it read as ended.

## Running it as a service

What a unit needs:

- **Workers must outlive the daemon.** Stopping or restarting the service must not kill the workers it
  started: `KillMode=process` for systemd, `AbandonProcessGroup` for launchd.
- **78 means do not restart.** systemd: `RestartPreventExitStatus=78`. launchd restarts it anyway, at most
  every `ThrottleInterval` (60 s), with one log line each time.
- **The same state base** as your shell and the TUI (`KODEL_STATE_DIR`, else `~/.kodel` of the same user),
  otherwise neither sees the daemon.
- **A `PATH` with `kodel`, `claude`, `git` and `node`**, and the environment `claude` needs to be signed in.
- **A terminal worker needs the built kodel on Node** with its optional package `@lydell/node-pty`; a
  daemon started from source under Bun refuses every terminal start (commit `worker: print` for it).
- **Linger** for a systemd user unit (`loginctl enable-linger $USER`); without it the unit ends at logout.

systemd (Linux):

```ini
# ~/.config/systemd/user/kodel-serve.service   (systemctl --user enable --now kodel-serve; loginctl enable-linger $USER)
[Service]
WorkingDirectory=%h/code/my-app
ExecStart=/usr/bin/env kodel serve
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=78
KillMode=process
[Install]
WantedBy=default.target
```

launchd (macOS):

```xml
<!-- ~/Library/LaunchAgents/ai.kodel.serve.my-app.plist   (launchctl bootstrap gui/$UID <file>) -->
<plist version="1.0"><dict>
  <key>Label</key><string>ai.kodel.serve.my-app</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/kodel</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>/Users/me/code/my-app</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/kodel-serve.log</string>
</dict></plist>
```

## What the daemon writes

- `worker_note` records in runs;
- a stop of the terminal session of a worker whose run is over (it decides nothing about the run);
- the give-up comment on a task;
- through the run's tie to its task, the task's `progress` status, as every start does (with the `local`
  adapter these are changes of files under `.kodel/tasks/`, at times you do not choose);
- its own record under the state base, and its log on stdout.

## Limits

- **One checkout, one user, one machine, one state base.** A daemon under another state base is not seen by
  the TUI or by a second `kodel serve`; each then resumes and counts only its own workers, and only the start
  lock (kept beside the run history's own locks) is shared. A second clone may run its own daemon, but clones that share tasks through git
  can start one task twice: run one daemon per tracker.
- **It reads the working tree.** A checkout of another branch brings that branch's config and task files, and
  a `git stash -u` or `git clean` that removes run folders and task changes makes a started task look new. Run
  it in a checkout that stays on one branch and ignores `.kodel/runs`.
- **A TUI built before this change** does not know the daemon: it still offers `s resumes` (the record's name
  keeps the resume to one) and starts without the lock.
- **A systemd user unit without linger** ends at logout. **On macOS** a refusal (78) is started again by
  launchd every 60 seconds, one log line each.

## Accepted risks

- **Anything that can edit the config can turn the daemon on.** The block is in a tracked file and is read
  every cycle. An agent with a shell can add or widen it and can start `kodel serve`; a `git pull`, merge or
  checkout can turn it on or change its rules within 5 seconds. What stands against it: the MCP server's
  instructions (and, in this repository, `AGENTS.md`), the refusal under `KODEL_ENGINE` (a worker cannot start
  it), the task mark, the two limits and the gates of your pipeline. For your own interactive agent, that text
  is the only guard.
- **The task mark is advisory.** It holds for an agent that uses the task tools inside a run. An agent that
  edits `.kodel/tasks/*.yaml` with a shell, an MCP server of an older build, and task files that arrive by `git
  pull` make tasks without a mark, and those count as yours.
- **The resume is automatic.** No journal line proves that your own agent is not continuing the run. If you
  decide and then hand a worker's run to another agent within one cycle, both may do the same step; the
  engine's checks still decide each result. Only a run with a worker record is resumed.
- **Nothing is kept on disk between restarts.** Attempts and the count of dead workers live in memory, so a
  start that kills the daemon before a run exists is tried again after every restart. The give-up is the
  task's latest comment: any newer comment re-arms it, also an agent's, and an agent can write the same words
  to block a start. A daemon killed in the seconds between making a run and launching its agent leaves a run
  with a task in `progress`, no agent and no note; `kodel status`, the TUI and `--status` show it, and any agent
  continues it with `pipeline_next_step`. A dead worker of a format-1 run is logged again after each restart.

## Decision T-44

*A daemon (`kodel serve`) starts and resumes background workers by the person's `serve` block; one pure
function plans, one launcher starts each run's agent once, one lock admits, one owner resumes; it decides
nothing about a run and writes only the fact that a worker is gone; a task an agent made or changed waits for
a person, unless the person's rule says `approval: any`.*

Test plan: the `t44_*` tests. The decision is refuted if, on one checkout with one daemon, one state base and
builds with this change:

- a task is started twice;
- a task an agent made, or whose title, body, status, priority or parent an agent changed through the tools,
  is started by the daemon without a `kodel task approve` after that, unless the rule that matched it says
  `approval: any`;
- after an act of the daemon more agents are working than `max_workers`, unless the excess are workers a
  person's decision woke, or more open worker runs than `max_runs` exist;
- a decided run whose worker ended at the wait is not resumed within two cycles of a free worker place with no
  TUI open, or is resumed twice for one decision without a person removing a record; or a decided run whose
  worker is alive neither goes on nor is reported by the daemon within 2 minutes (and the minute of its
  journal read);
- the TUI and an active daemon both resume one decision;
- a holder that is gone is not noted in its run (format 2) in the next cycle, except for a worker that ended
  while its run waited for the person;
- a second agent is started for a run whose first agent's process still runs;
- the daemon launches an agent twice for one run, anything for a run whose records a person removed, or
  anything into a run it did not make;
- a launch the daemon saw fail leaves no note;
- a journal has a decision made by the daemon;
- a run of format 1 is changed or refused because of a note.

## T-44 as revised by T-45

T-45 (`docs/decisions.md`) made a worker a terminal session that stays alive at a gate. T-44 was written for a
worker that exits at every wait, where "a worker process exists" and "an agent is working" were one thing.
They are two now, so three lines of T-44's refutation and the meaning of one limit were replaced, and one
line was added. The list above is the revised one. What it replaced, kept here as it was:

| T-44 before | Now | Why |
| --- | --- | --- |
| "more worker processes than `max_workers`, or more open worker runs than `max_runs`, exist after an act of the daemon" | "after an act of the daemon more agents are working than `max_workers`, unless the excess are workers a person's decision woke, or more open worker runs than `max_runs` exist" | A waiting worker is alive and does no work: it holds a `max_runs` place only. A person's decision can wake more workers than the limit, and the daemon acts against none of them. |
| "a decided run of a worker is not resumed within two cycles of a free worker place with no TUI open" | "a decided run whose worker ended at the wait is not resumed within two cycles of a free worker place; or one whose worker is alive neither goes on nor is reported within 2 minutes" | A live worker is not resumed: there is nothing to start. It goes on by itself, and the daemon says so when it does not. |
| "a holder that is gone is not noted in its run (format 2) in the next cycle" | the same, "except for a worker that ended while its run waited for the person" | Such a worker is resumed after the decision; a note would call a reboot at a gate a death. |
| `max_workers`: "worker processes alive at once" | "agents that are working: a live worker whose run does not only wait for the person" | As the first line. |
| (no such line) | "a second agent is started for a run whose first agent's process still runs" | Since a worker is resumed after a lost holder, a holder that died while its agent lived on would otherwise get a second agent. |

The daemon gained one act on a session, `finish` (a stop of the terminal session of a run that is over); it
still decides nothing about a run. The record's `counts.workers` keeps its meaning (the places used) and
`counts.alive` is new. Test plan: the `t44_*` tests, read against the revised list. The same revision belongs
in the decision log.

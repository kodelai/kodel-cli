# `kodel serve`: start and resume background workers

`kodel serve` is a daemon for one checkout. Every 5 seconds it looks at the tasks, the runs and the
background workers (the agents `s` starts in `kodel tui`) and does three things, by rules you write in the
project config:

- it **starts** a task that matches your rule in a background worker, within two limits;
- it **resumes** a worker that stopped at a gate or a pause once you have decided, with no TUI open;
- it **notes** in a run that its worker is gone, so `kodel status`, `kodel report` and the TUI say so.

It decides nothing about a run: it never approves a gate, resumes a pause, accepts a change or acks a state.
Those stay your commands. The design decision is **T-44** (see the end of this page).

It runs in the foreground, prints one plain, redacted line per event, and is meant to be run by a service
manager (examples below). It needs tasks (`docs/tasks.md`) and the same things a worker started from the
TUI needs: `claude` on the `PATH` and signed in, a git repository and `worktree.mode: auto`. It does not run
on Windows yet.

## The `serve` block

Only you edit this block. It is off by default, strict at every level (a misspelled key is an error that
names it, so a typo cannot widen what starts) and read again every cycle.

```yaml
serve:
  enabled: true            # default false: the daemon runs idle and says so
  max_workers: 2           # 1..64, default 1: worker processes alive at once
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

The launcher's preflight also works out the tools of the worker's own server (`kodel mcp --role worker`) from the
config. If they do not resolve (an `mcp` block that cannot be used, `docs/mcp-roles.md`), nothing is started: a
worker whose server would not start would run with no kodel tool. The daemon reads the whole config every cycle,
so with such a block it is `idle` with the reason, in its log and in `kodel serve --status`.

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

Problems of the environment use no attempt: no `claude`, not signed in, `decisions.dialog` on, a pipeline that
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

- `max_runs` counts open runs that have a worker, from the start until the run ends or its worker is gone
  for good. A run waiting at a gate keeps its place. So does a run you have decided but the daemon does not
  resume because an agent moved it on since your decision, a run whose worker exited at a wait you have
  not decided yet: each keeps its place until the run ends (or you remove its worker records). With
  `max_runs: 1` such a run blocks every start; continue it with any agent (`pipeline_next_step`) or end it.
  A run whose worker died before a wait, or stopped at a wait that another agent then took the run on from
  (that worker is not counted or noted as dead), frees its place: the daemon never resumes that worker.
- `max_workers` counts worker processes that are starting or running (and those whose state cannot be read),
  also a worker still finishing after its run ended.

A start needs room in both; a resume needs room in `max_workers` only. When `max_workers` is full, resumes
wait, oldest decision first, and every waiting resume goes before any new start. A start you make by key in
the TUI (`s` on a task) ignores both limits; the daemon then starts nothing new until the counts are under
them. With an active daemon the TUI leaves resumes to it (the card says `kodel serve resumes it`), so they keep
`max_workers`; the one exception is a run an agent moved on since your decision, which the daemon does not
resume: the TUI still offers `s resumes` for it, and that resume ignores both limits.

## Resuming after your decision

A worker that exited at a wait and whose run you then decided (`kodel gate`, `kodel resume`, the TUI) is
resumed as `kw-<run>-d<seq>`, once per decision, in the first cycle with a free worker place, by the same rule
the TUI uses to offer `s resumes`. Right before, the daemon reads the journal again: if an agent was served,
claimed or completed a step since your decision, it does not resume. It reads the worker records again too:
if the run's record was removed (`kodel agent rm`), the run is no longer going, or `max_workers` is full by
now, it does not resume in this cycle.

A resume whose launch fails (no `claude`, not signed in) is tried again 60 seconds later; meanwhile it goes
before any start, as a resume waiting for a worker place does. After three failures the daemon logs
`resume_failed` once and does not try that decision
again: continue the run with any agent (`pipeline_next_step`), or stop the daemon and resume it in the TUI.

A resume the config refuses (the `mcp` block cannot be used, so the worker's server would not start) spawns
nothing and is not one of the three: it is tried again every cycle until the config is fixed.

A decision an agent made through a manager's server (`decided_via: manager`, `docs/mcp-roles.md`) is resumed like
yours: that agent works no step of the run. A decision an agent made where the run is worked is not, as before.

Removing a resume's record (`kodel agent rm`) frees its name, so that decision may be resumed again.
Removing every record of a run takes the run away from the daemon: it is not resumed and nothing is launched
for it.

## A worker that is gone

When a worker the daemon watches is gone, it writes the journal event `worker_note` into the run, once per
worker record:

| reason | what happened |
| --- | --- |
| `lost` | the worker's holder is gone (a reboot, a kill) |
| `killed` | killed (by its timeout, or by the launcher when it could not be kept) |
| `exited` | exited outside a wait (with its exit code) |
| `not_started` | the launch failed and no record was made |

`kodel status <run>` and the TUI card say, for example, `agent kw-r_… lost at 10:02 (its holder is gone); any
agent continues the run with pipeline_next_step`, and `kodel report` lists it (`workers_gone`). A worker you
stopped is not noted. The note changes no state and no route; a run of format 1 has no place for it and is not
changed (the daemon logs the death instead). A note the run does not take (its record's time is ahead of the
run's clock, say) is logged once as `not noted: …`. See `docs/history.md` and `docs/run-formats.md`.

A worker that is running but has printed nothing for `stalled_after_s` (counted from the latest of its last
output, its start, the daemon's start, and the last gap of more than 60 seconds between two cycles, such as a
sleep) gets one log line per quiet spell, nothing else.

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
why, its state base), the counts against the limits, your start rules in order (`rule 1:`, `rule 2:`, ...),
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
  "counts": { "workers": 0, "max_workers": 1, "runs": 0, "max_runs": 1 }
}
```

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
twice.

## Running it as a service

What a unit needs:

- **Workers must outlive the daemon.** Stopping or restarting the service must not kill the workers it
  started: `KillMode=process` for systemd, `AbandonProcessGroup` for launchd.
- **78 means do not restart.** systemd: `RestartPreventExitStatus=78`. launchd restarts it anyway, at most
  every `ThrottleInterval` (60 s), with one log line each time.
- **The same state base** as your shell and the TUI (`KODEL_STATE_DIR`, else `~/.kodel` of the same user),
  otherwise neither sees the daemon.
- **A `PATH` with `kodel`, `claude`, `git` and `node`**, and the environment `claude` needs to be signed in.
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
- more worker processes than `max_workers`, or more open worker runs than `max_runs`, exist after an act of the
  daemon;
- a decided run of a worker is not resumed within two cycles of a free worker place with no TUI open, or is
  resumed twice for one decision without a person removing a record;
- the TUI and an active daemon both resume one decision;
- a holder that is gone is not noted in its run (format 2) in the next cycle;
- the daemon launches an agent twice for one run, anything for a run whose records a person removed, or
  anything into a run it did not make;
- a launch the daemon saw fail leaves no note;
- a journal has a decision made by the daemon;
- a run of format 1 is changed or refused because of a note.

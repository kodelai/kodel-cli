# TUI: start a task in a background agent (`claude -p`) with one key (TASK-9PNS)

## TL;DR

- `s` on a Backlog row or a task card asks `Start KEY in a background agent? y starts` (a numbered picker with several
  pipelines); `y` starts the task's run (`LocalPipelineHost.start`, `task_key`, `restart: true`, `caller: kodel-tui`)
  and a detached `claude -p` session (`origin: "cli"`, name `kw-<run id>`, cwd = the run's workdir) that drives the run
  through its own `kodel mcp --no-decisions --no-wait-hint`, with `--permission-mode dontAsk`, an exact allowlist and a
  deny list. The run card shows `agent starting`, then the worker's state and a plain-text digest of its `stream-json`.
- At a gate the worker ends its turn and `claude -p` exits 0; the card reads `agent waiting for you`. When **the person**
  decides (TUI, `kodel gate|resume|pipeline changes`, or a dialog), the card reads `agent exited at your decision · s
  resumes`; **`s` then `y` on that run** starts the same conversation again with `claude -p --resume <session id>` as
  record `kw-<run>-d<seq>`, `seq` = the journal line of that decision: one resume per decision, by construction, and
  **nothing starts without a key** (Decision 1, recommended (c)). The journal only says when to offer and adds one true
  warning (`an agent was served a step since your decision`); the person, who knows whether they told another agent to
  continue, decides.
- **What this revision changed (2026-11-06, plan-revise 3):** the automatic resume is gone: `step_served` is
  bookkeeping that is skipped silently (prompts off, 500 events, a repeated answer, a command step after a gate), so no
  journal rule can tell whether the person's own agent will continue; the resume is the person's `s`+`y`, the activity
  check is advisory text, the `decision.ts > since` clock check and the `resumeFailed` map are dropped; a hand-edited
  pipeline accepted gets a wait time; `sessionIdOf` reads the last `--session-id`; the `wait` deny pattern is `*kodel*
  wait r_*`; the `step_served` sentence is corrected; limits and test rows added.
- Risky: (1) `--allowedTools`/`--disallowedTools` are Claude Code's enforcement, and `--session-id`/`--resume` under `-p`
  with the launcher's environment are live-only; (2) the worker acts with the person's git and GitHub identity; (3) the
  live checks and the manual scenario run outside the sandbox; (4) the TUI's "already started" check is not under the
  host's start lock; (5) each resume re-sends the conversation (plan usage, or cache-miss tokens with an API key).

## Decisions needed

Each with its refutation; the plan takes the recommendation when a question is not answered. What the person settled
at the gates ("Settled" below) is not reopened.

1. **Who starts the resume after the person's decision.** (c) **the person's key**: the card of a run whose worker
   exited at a wait the person then decided says `agent exited at your decision · s resumes`; `s` on that run asks
   `Resume the agent of r_… after your <gate|pause|pipeline change> "<node>" <outcome> (<time>)? y resumes · any other
   key cancels`, with the line `an agent was served a step since your decision` when the journal shows one; `y` starts
   `kw-<run>-d<seq>`. (a) **automatic with conservative guards**: the refresh resumes by itself when the journal shows
   no `step_served`/`step_claimed`/`agent_completed` after the decision, and refuses with `cannot tell` when the run
   keeps no `served` (`history.prompts` off), is at `MAX_SERVED_EVENTS` (500) or a command step follows the gate.
   **Recommended: (c).** The TUI cannot know whether the person told their own agent to continue: that agent leaves no
   journal line until its first `pipeline_next_step` (minutes, for an interactive one), and the lines it then leaves
   are bookkeeping the engine skips silently (`host.ts:3174,3185`, `run.ts:2303-2310`); (a) is a race the TUI wins at
   every 4 s refresh, and its guard refuses exactly where it is unsure, where the person continues by hand anyway. (c)
   costs one `s`+`y` per decision (three per `dev.yaml` run) and is sound: only the person, who alone knows, starts it,
   and the one heuristic left is a warning that is true whenever shown and claims nothing when absent. The person said
   (a) was acceptable as a default only; this question is theirs. Default (c). Refuted if a resume starts with no key
   pressed, or `s`+`y` starts two for one decision (`task_9pns_no_resume_without_a_key`,
   `task_9pns_resume_once_with_two_tuis`).
2. **How the worker's server loses the `kodel wait` offer.** The hint is read from the project config in two places:
   `cli.ts:436` (`loadAgentHints`, for the instructions) and the host's `hints()` per answer (`host.ts:1111-1121`), so a
   CLI-only flag cannot reach the second. (a) **`kodel mcp --no-wait-hint`**: `cli.ts` forces `waitHint: false` for the
   instructions and passes a new `HostOptions.agentHints?: { wait?: boolean }` (about 8 lines in
   `packages/local/src/host.ts`, `hints()` prefers it); (b) the person sets `agent_hints: { wait: false }` in the project
   config (every agent of the project loses the offer). **Recommended: (a).** Default (a). Refuted if a waiting answer of
   the worker's server names `kodel wait` (`task_9pns_mcp_no_wait_hint_text_ends_the_turn`).
3. **The auth probe** (`claude auth status --json`, 10 s, injected clock). (a) **keep only the refusal** on
   `loggedIn: false` (`claude is not signed in: run claude auth login`), no warnings of any kind, and a probe that fails,
   times out or prints no JSON lets the start go on (the worker's own exit and `kodel agent logs` then say why); (b) drop
   the probe. **Recommended: (a)**: without it every `s` of a signed-out person makes an orphan run (settled: a half-made
   run is left as it is). Default (a). Refuted if a signed-out `s` makes a run (`task_9pns_preflight_refuses_signed_out`).
4. **`s` on a `progress` task whose run ended** (a second run from the card; the task stays `progress`). (a) **keep**:
   `activeKeys` is already computed, and a run that failed at `impl` would otherwise leave the task unstartable from the
   TUI for ever; (b) only `todo` tasks. **Recommended: (a).** Default (a). Refuted if a `progress` task with an active
   run offers `s` (`task_9pns_s_asks_only_for_a_task_without_an_active_run`).
5. **`kodel agent rm` of a resume record.** A `cli` record frees its name marker with its folder
   (`packages/local/src/session-pipes.ts:584-591`), so nothing in the session store survives `rm`; what survives is the
   journal. With the record gone the card offers `s resumes` **once more** for the same decision, and `s`+`y` makes
   the record again. (a) **accept and document**: `kodel agent stop` alone (the `killed` record stays) ends the offer;
   `rm` is the person asking to forget it, and the resume is their key anyway; (b) a TUI-side file remembering resumed
   decisions (a new file, rejected before). **Recommended: (a).** Default (a). Refuted if a stopped (not removed) worker
   is ever offered (`task_9pns_stopped_or_lost_worker_is_not_offered`).

## Behaviour change

Part A. Part B (a later task): a stop key, resume after a crash, resume from the CLI, the `--demo` launcher, a worker
for a run that already exists.

**Settled by the person (gates of 2026-11-06):** `s` then `y` (its own confirm kind, `m.start`), any other key cancels;
a digit picker `1`-`9` for several pipelines; a readable progress digest on the card right after `y`; no shim; no
budget cap; `s` refuses under `decisions.dialog: true`; a run whose agent could not be started is left as it is (no
`LocalRun.cancel`); `caller: { name: "kodel-tui", version }`, no `surface`; test prefix `task_9pns_`; resume after a
decided gate is in this task (the worker exits at a gate, the TUI restarts it with `claude -p --resume`); one PR.

- **The `s` key** (`kodel tui`, Sessions screen): on a Backlog row (`todo`), and on a task card of a task in state
  `todo` or `progress` with no active run (`activeKeys`, `tasks.ts:88`), `s` emits `prepare_start {key}`; the footer
  says `Checking…`. The loop runs the preflight and `host.list()`; `ready` asks: one pipeline, `Start KEY in a background
  agent (pipeline dev)? y starts · any other key cancels`; several, `Start KEY in a background agent with: 1 dev 2
  feature … (digit starts · any other key cancels)`, nine at most and `N more are not offered here`. `y` (or the digit)
  counts only alone in its chunk and `COMMENT_GUARD_MS` (400 ms) after `askedAt` on the injected clock, never inside a
  paste (`input.ts:134`); `0` cancels. It emits `start_task {key, pipeline}`: a run (task text = title, a blank line, the
  body; `task_key` = the task, so it goes to `progress` with "started by run …", `docs/tasks.md:78`; `restart: true`),
  then a background `claude -p` in the run's workdir. The notice says `Started KEY: run r_… (agent kw-r_…)`; the row
  shows `agent starting` until the first worker read. A `ready` for another task, or one older than the question's
  sequence number, is dropped; the card moving to another task cancels the question.
- A second `s` on a task with an active run says `KEY is already started: run r_… (agent running)`; while a start is in
  flight, `KEY is being started`. `s` on a run row asks the resume question when one is due (below), else says why it
  does nothing (`agent running`, `no agent of the TUI on this run`, …); on a `done` or `declined` task too. The TUI's check
  is a convenience, not the guard: two TUIs, or a TUI and an agent, pressing within the same second with different
  wording make two runs on one task, as two agents can today (`findActive` keys on pipeline and task text,
  `host.ts:801`). Stated as a limit. The host's answer decides the rest: `started` → the worker is started; `reused` →
  no worker, `KEY has a run already going: r_… (started outside the TUI)`; `terminal` (cannot come with `restart:
  true`) → the same refusal, tested all the same.
- **The worker's first session.** `claude -p <prompt> --output-format stream-json --verbose --session-id <uuid>
  --mcp-config <json> --strict-mcp-config --permission-mode dontAsk --allowedTools <list> --disallowedTools <list>`; the
  uuid is `crypto.randomUUID()` of the launcher; the mcp-config names `process.execPath`, `process.argv[1]`, `--root
  <root>`, `mcp`, `--no-decisions`, `--no-wait-hint`, and `KODEL_STATE_DIR` in its `env` only when the TUI has it. **The
  first prompt** names the run and nothing else of the task: `Kodel run <id> exists for the task "<title>" and is yours
  to drive. Call pipeline_next_step with run_id <id> and do what each answer says; never call pipeline_start (it would
  make a second run). Work in <workdir>.` The run already holds the task text, so the body never becomes argv. The
  spec: `cwd` = workdir, `name` = `kw-<run id>`, `origin: "cli"`, `timeoutMs` 12 h, `inheritEnv: false`, `env` =
  `workerEnv(process.env)`.
- **At a gate the worker exits.** With `--no-wait-hint` the waiting text is the one `agent_hints.wait: false` gives
  today (`tellToWait(runId, false)` is empty, `next-step.ts:252-264`; `WAIT_OFFER` is left out of the instructions,
  `tools.ts:58`): the agent writes what the person has to decide and ends its turn; `claude -p` exits 0 (nothing of its
  own keeps it alive, `claude-code-wait.test.ts:22-27`). `kodel wait` is denied to its Bash besides, so a worker that
  reaches for it from habit (the worktree's `AGENTS.md` calls it "yours") is refused and ends its turn the same way. The
  row shows **`agent waiting for you`** (the run is `waiting` and the latest worker record `exited` after the wait
  began); the card's digest ends with the agent's last text. The same words for a pause and for a pipeline change.
- **Resume: the offer** (`resumeOffer`, pure, `tui/worker-resume.ts`), computed after every worker read for every open
  run with a `kw-` record; it decides what the card says and what `s` asks, **never starts anything**. Inputs: the TUI's
  `Session` plus three fields `load.ts` fills from the journal, and the run's worker records. `lastWait` = the last
  `gate_waiting`, `run_paused` or `pipeline_change_proposed` **without** `withdrawn: true`. `decision` = the last
  `gate_decided`, `run_resumed`, `pipeline_accepted` or `pipeline_change_proposed` with `withdrawn: true` (a dropped
  change, `pipeline changes discard`, `host.ts:1245-1258`) whose record has **no `decided_by: "agent"`** (`run.ts:526`):
  `{seq, ts, kind, node, outcome, reason}`. A `pipeline_accepted` with `source: "file"` (a file edited by hand) has no
  wait line of its own (`describeChange("file")` journals nothing, `host.ts:1242`; only the apply writes), so its wait
  is dated as `load.ts:286` dates it: the last sign of life before it (`sinceLast`, `load.ts:385`). `moved` = a
  `step_served`, `step_claimed` or `agent_completed` with `seq` greater than the decision's. `latest` = the run's
  record with the highest `-d<seq>`, else `kw-<run>`. **Offered** when all hold: the run is `running` (not `waiting`,
  `done`, `failed`, `canceled`, `unreadable`); `latest.state === "exited"`; `lastWait.ts ≥ latest.started` (the wait
  began during that session) and `latest.since ≥ lastWait.ts` (it exited at the wait, or while finishing its turn after
  a fast decision); `decision.seq > lastWait.seq` (decided after that wait); no record named `kw-<run>-d<decision.seq>`
  exists (any state, a `problem` one too); a session id is known; the TUI's own decision work is not pending
  (`work.pending()` of `createDecisionTools`, `tui/decide.ts:166-177`: the engine or command step it runs in-process).
  Then the card says `agent exited at your decision · s resumes` (plus `· an agent was served a step since` when
  `moved`), and `s` asks the question of Decision 1 (its own confirm kind, `m.resume`, the same `y` guard as `m.start`).
  `y` emits `resume_worker {runId, seq}`: `launcher.resume({runId, workdir, sessionId, decision})` starts `claude -p
  "<resume prompt>" --resume <uuid>` with every other flag, the lists, the mcp-config, the environment and the cwd as
  the first session's, as record **`kw-<run>-d<seq>`** (`SESSION_NAME_PATTERN` `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`,
  `packages/pipeline-core/src/session.ts:47`, allows it; 27 characters). The row shows `agent resuming`, then `agent
  running (session N)`, N = 1 + the number of `-d` records (display only).
  - **Why the journal only advises.** `step_served` is bookkeeping, skipped silently when the run keeps no `served`
    (`history.prompts` off, `run.ts:2261`, `host.ts:3174`), at `MAX_SERVED_EVENTS` (500, `run.ts:2307`), when the key
    was kept already for that `node:attempt` (`host.ts:3185`; the key hashes the client and session only with
    `history.executor.enabled`, so with it off a second client shown the same answer writes no line) or when the step
    is not in its agent phase (`run.ts:2305`); after a gate followed by a command step nothing of an agent is written
    for the whole step; an agent told to continue writes nothing until its first call. So `moved` is shown when true and
    says nothing when absent; it never decides. `engine_session_started` and `command_*` are not counted: the TUI's own
    in-process step writes them.
  - **Exactly once per decision.** The name is a function of the decision, so two TUIs, a TUI and a person's `kodel
    agent`, or `s`+`y` twice compute the same name: the adapter's `createExclusive` of the marker
    (`session-pipes.ts:159`) gives it to one, the rest get `NAME_TAKEN` (`already resumed: kodel agent ls`) and do
    nothing. A `resuming` set keyed by run id covers a refresh during a slow `start`. No cap: a new offer needs a new
    wait and a new decision of the person.
  - **Not offered** (`s` says why): a worker `running`/`starting`; `killed` (stopped or `timeout`); `lost`; `exited`
    with no wait begun during it or before the wait (a crash: the card says `agent exited (1), not at a gate` and names
    `pipeline_next_step <run>` for any agent; a resume after a crash is Part B); a run that is `done`, `failed`,
    `canceled`, `unreadable` or waits again (a worker resumed after gate A that reaches gate B and exits is `agent
    waiting for you`, not an offer on A; a fork with one gate decided and one waiting is `waiting`: a limit); a decision
    made by an agent (`decided_by: agent`, the person's interactive agent where `decisions.agent` is on: it goes on
    itself; the card says `an agent decided and goes on`); `kodel ack` (`manual_edit`, `run.ts:1862`) is not a
    decision; no session id (`no session id: kodel agent logs kw-<run>`); a record `kw-<run>-d<seq>` that booted and
    died or timed out at boot (`kw-<run>-d<seq> ended: kodel agent logs kw-<run>-d<seq>`). Limits: a wait or a
    withdrawal that was not journaled (`change_proposed` is a silent no-op after `MAX_LOGGED_PROPOSALS`, 100,
    `run.ts:1905`) leaves the worker `exited (0), not at a gate`; the person continues it with any agent.
  - **A failed resume** (`adapter.start` throws, not `NAME_TAKEN`): one notice `run r_… was not resumed: <reason>. Any
    agent in the project continues it with pipeline_next_step and this run id`; the offer stays and `s`+`y` is the
    retry (no retry map: nothing happens without a key). `NAME_USED` (a marker without a folder: a claim in flight
    elsewhere, or a non-`cli` record of that name) is the same notice. The run is never written by a resume.
  - **The session id** comes from the records' `command` (`agent ls --json`: the redacted argv joined,
    `session-pipes.ts:204`): the uuid after the **last** `--session-id` in `kw-<run>`, or after the last `--resume` in
    any `-d` record (the prompt, with the task title, precedes the flags in argv, so a title holding `--session-id
    <uuid>` must not win); and the `session_id` of the last `result` event of the latest record's stdout tail (the
    parser reads `system/init` and `result`, as `harness.ts:516,549`; `result` is the last line the process writes, so an
    exited session's tail holds it unless that line exceeds the ring's 256 KiB). The tail's id wins when both exist and
    differ (it is what `claude` used; a redaction rule may have mangled argv); neither → not offered. Claude Code's
    own session log (`<claudeConfigDir()>/projects/<projectFolderName(workdir)>/<uuid>.jsonl`,
    `packages/local/src/history/claude-code/locate.ts:205-215`) is read only by the live test; the TUI never reads it.
  - **The resume prompt:** `The person decided: <gate|pause|pipeline change> "<node>"
    <approved|rejected|resumed|accepted|dropped> [— <reason, first 200 characters>]. Continue Kodel run <id>: call
    pipeline_next_step with run_id <id> and go on from its answer; never call pipeline_start.` The reason is redacted
    with the project's rules and made plain (`plain.ts:28`) before it is an argv element.
  - **Cost.** A resume re-sends the conversation: on a subscription it counts against the plan's usage, with an API key
    it is the cache-miss tokens of the whole context; `docs/tasks.md` says so. Three gates of `dev.yaml` are three
    `s`+`y`.
- **The run card**: after the title, the worker's state: `agent starting`, `agent running`, `agent waiting for you`,
  `agent resuming`, `agent exited (1), not at a gate`, `agent exited at your decision · s resumes` (with `· an agent was
  served a step since` when so), `agent exited; an agent decided and goes on`, `agent lost`, `agent stopped`, the words
  of `stateLabel` (`agent-commands.ts:60`), `agent unknown (cannot be read)` for a `problem` or a
  failed read, `(session N)` after a resume; a run without a `kw-` record shows nothing; a finished run keeps its mark
  while a record exists. Below: **the digest**, the last 8 lines from the latest record's stdout (`agent logs <name>
  --stdout --bytes 262144`), one plain line per event: `init · 14 tools (kodel 11)`; `> <first 120 characters of an
  assistant text>`; `→ pipeline_next_step` / `→ Bash: <first 60 characters>` / `→ Edit: <path>`; `← ok: <first 80>` /
  `← error: <…>`; `result: ok · 12 turns · 3m 20s` (never a cost); `· resumed (session N)` as the first line after a
  resume; a resumed `system/init` whose `session_id` differs from the launcher's (a fork) gives `· session id changed`
  and the card keeps the launcher's id. An unreadable line or an unknown event type gives `· (an event the TUI cannot
  show)` once per run of such lines; the first line of a tail that does not parse is skipped silently (a tail starts
  mid-event). Every piece of agent text goes through `redactText` with the project's rules, `plain` and `neutralize`
  (`tui/ansi.ts`). The card's last line names `kodel agent logs <name>`: that is how the card "reaches the logs"; no
  key opens them. Refresh every `WORKER_REFRESH_MS` (4 s), one read out at a time, through the child process; never on
  `win32`.
- **A start that fails** is one notice and no run. Preflight, in order: Windows (`agents are not supported on Windows
  yet`); `decisions.dialog: true` (`the project asks decisions in a dialog (decisions.dialog); a background agent cannot
  answer one. Turn it off, or wait for TASK-8EP9`); `claude was not found on PATH`; `claude is not signed in (claude
  auth status): run claude auth login` (Decision 3a); `tasks.on_run.mode is disabled, or the tracker cannot attach
  runs` (`host.taskLink()` undefined, `pipeline-host.ts:662-668`; with `mode: ask` the start is allowed); `a project
  redaction rule cannot be given to a background agent` (`session-pipes.ts:240`); no pipeline loads. No warnings. In
  `start_task`, from the host: `ChoiceNeeded` (an uncommitted pipeline file: `s` says `commit .kodel/pipelines/<file>
  or start the run from an agent`; the choice is not passed through the question, stated as a limit), the worktree
  error in the host's words (the worktree is undone when `prepare` throws, `worktree.ts:193`, and the run record is
  made after it, `host.ts:855`); a task gone `done` or active in between (read again with `loadTask`). After the run
  exists, a `SessionError` of the holder's boot → `run r_… was made but no agent was started: <reason>. Any agent in
  the project continues it with pipeline_next_step and this run id` (not `pipeline_start`: a `task_key` with other
  words starts a second run on the same task, `host.ts:801`; a documented limit).
- **The worker's server**: `kodel mcp --no-decisions --no-wait-hint`. `--no-decisions` serves no `pipeline_decide_gate`
  / `pipeline_accept_change`, names them in no instruction or waiting text, shows no dialog, whatever `decisions` in the
  config or `KODEL_*` in the environment says; one stderr line says so and that a `decisions.agent` allowance of the
  project does not apply to this server. `--no-wait-hint` (Decision 2a) removes the `kodel wait` offer from the
  instructions and from every waiting text. `kodel mcp` without the flags is unchanged. The worker is an ordinary agent
  on the person's account: it serves `pipeline_start`, `pipeline_propose_change` and the task tools; `kodel
  gate|ack|seal|resume|migrate` and `agent stop|rm|exec|forget-name` refuse in it (`KODEL_ENGINE=1`, `cli.ts:338`) and
  are denied to its Bash besides. **The user's `~/.claude/settings.json`** (model, hooks, permissions) applies to the
  worker as to any `claude` of this account: the model is the account's default (no `--model`), and a hook the person
  has set runs in the worker; stated in the docs.
- **Allowed and denied tools.** `--allowedTools`: every `mcp__kodel__<tool>` the worker's server serves (from the tool
  descriptors; the two decision tools are not served and not listed), `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`
  (whole), `Agent` (the `plan` and `plan-critique` steps of `dev.yaml` ask for subagents). Not allowed, so refused under
  `dontAsk`: `WebFetch`, `WebSearch`, `Monitor`, `NotebookEdit`, everything else. `Bash` is whole because `dev.yaml`
  needs `bun test <files>`, `bun run typecheck`, `git status|add|commit -s|fetch|merge --signoff|push -u|worktree`, `gh
  pr create|view`, `mktemp`, and a narrow `Bash(...)` made the agent avoid Bash altogether
  (`claude-code-wait.test.ts:40-45`). `--disallowedTools`: `mcp__kodel__pipeline_decide_gate`,
  `mcp__kodel__pipeline_accept_change`; `Bash` patterns for `gate`, `ack`, `seal`, `resume`, `migrate`, **`wait r_*`**
  (a run id is `r_…`, `run-id.ts:2`; `* wait*` alone would also refuse `cd <a .kodel/worktrees path> && …; wait`),
  `pipeline changes apply|discard|restore`, `pipeline proposals apply|discard`, `agent stop|rm|exec|forget-name` in the
  three spellings `.claude/settings.json` uses (`*kodel*`, `*main.ts*`, `*kodel.js*`); the docs say a substring pattern
  can refuse an innocent command naming `kodel` and a verb (`grep gate_decided` after a `cd` into a worktree), as the
  repository's own `.claude/settings.json` patterns do today; `Edit`/`Write` of
  `.kodel/runs/**`, `.kodel/pipelines/**`, `.kodel/tasks/**`, **`.kodel/config.yaml`**, **`.kodel/proposals/**`**,
  `.mcp.json`, `.claude/settings*.json`, worktree-relative and absolute to the root, and the state base
  (`//<state base>/**`) when it is not under the root. What a substring pattern misses is caught where it matters: a run
  file changed by hand is "was modified" to the host, an edited pipeline file waits for the person, a task file edited by
  hand is the tracker's own problem as today. The resumed session gets the same two lists, built again from the same
  tables. The lists live in `claude-worker.ts`; the docs point there.
- `--demo`: `s` says `starting is not available in --demo`; nothing else, no watcher.
- Docs, short: `docs/tasks.md` "In the TUI" (`:147`) gets one paragraph for `s` (the question, the picker, what is
  started, where the lists live, the two `kodel mcp` flags, `KODEL_STATE_DIR`, `kodel agent stop|logs`, the identity and
  settings notes), one for the resume (what `agent waiting for you` and `s resumes` mean, that the person's `s`+`y`
  starts it and why the TUI does not (the journal cannot tell whether their own agent continues), the warning line, a
  record per decision, what is not offered and what to do then, `agent stop` versus `agent rm`, the cost) and one for the limits
  (no stop key, POSIX only, a crashed worker leaves an open run any agent continues with `pipeline_next_step`, a
  `task_key` with other words makes a second run, an uncommitted pipeline file refuses `s`, the holder's stdout log on
  disk is redacted on the raw `stream-json` bytes where a secret may be JSON-escaped, so `kodel agent logs` may show one
  the digest does not). `docs/history.md` gets one line: `observed` also names a kodel command that names itself
  (`kodel-tui`). No `AGENTS.md` change.
- **Replacing `claude -p` later.** Claude-specific, in two files: `claude-worker.ts` (argv and flags,
  `--session-id`/`--resume`, the `--mcp-config` shape, both tool lists, the auth probe, the prompts, the environment
  markers) and `claude-stream.ts` (the parser, the `session_id` fields). Not specific: `WorkerLauncher`, `resumeOffer`,
  the TUI, the two `kodel mcp` flags, the session records.
- No MCP tool, error code, config key or stored format changes. Two `kodel mcp` options and one `HostOptions` field: a
  `local` and CLI change beyond the TUI, named as such in the PR description (Decision 2a).

## Risks and invariants

- **Principle 6 (humans decide trust).** Nothing new is agent-callable; a resume is started by the TUI (a person's
  program, `requireHuman`, `cli.ts:755`) after a person's decision, never by an agent (the worker cannot start `kodel
  tui`: it refuses under `KODEL_ENGINE`), and never after an agent's decision (`decided_by: agent` does not count).
  Three lines keep a worker from deciding: its server serves no decision tool (`--no-decisions` passes `agentDecisions`
  off to `createServer` and the host, `cli.ts:475,491`, so `host.ts:1148` never puts `AGENT_MAY_DECIDE_GATE` in a
  text); `--strict-mcp-config`; the client's lists, the same choice `.claude/settings.json` makes for the interactive
  agent here. The human-only commands refuse under `KODEL_ENGINE=1` before they look for a terminal (`cli.ts:338-348`).
  **The worker acts with the person's identity**: `git commit -s` in their name, `gh` with their credentials, behind
  `final-approval` as for any agent; `docs/tasks.md` says so.
- **Principles 1 and 2 (untrusted input, fail closed).** The engine checks the worker's steps as any agent's. The TUI
  validates nothing the agent returns; the digest is display only. The **offer reads the journal and the session
  records, never the agent's text**: the engine's `gate_waiting`, the person's `gate_decided`, the engine's
  `step_served`. A session that cannot be read is `unknown`, never `running` and never offered; a `problem` record with
  a decision's name counts as "already resumed". Every "not offered" with a decision pending is on the card.
- **Two agents in one worktree** (the critical finding of the recheck): sequential mode has no claims, so a worker
  resumed beside the person's own agent would write into one worktree, and no journal rule can rule it out: the
  person's agent leaves no line until its first call, and the lines it leaves are skipped silently in the cases listed
  under "Why the journal only advises". So the TUI never starts a resume on its own: the person, who knows whether they
  handed the run to another agent, presses `s`+`y`; the journal's one word (`an agent was served a step since`) is true
  whenever shown. What the TUI refuses by itself is what the records prove: an agent's own decision (`decided_by:
  agent`), a worker that is not `exited`, a run that is not `running`. The remaining way to two agents is the person
  pressing `y` after telling another agent to continue: their call, said on the question.
- **Principle 3 (redact at every write path).** The task text reaches the run through the host's start as today; the
  first prompt carries only the run id, the title and the workdir; the record's argv is redacted by the adapter
  (`session-pipes.ts:206`), so the launcher gives `pipesAdapter` the project's rules and refuses before a run exists when
  a rule cannot cross (`replace` function, `session-pipes.ts:240`). The resume prompt carries the decision's reason:
  redacted and made plain before it is argv. The `--mcp-config` JSON holds no task text. The holder redacts the raw
  `stream-json` bytes (`packages/local/src/session-holder.ts:154,273`), where a secret may be JSON-escaped, so the TUI
  redacts the **decoded** text again; the log on disk is named as a limit in the docs. **Both prompts are argv
  elements**, visible in the process table to the same user; weighed and kept (the holder's input FIFO never reports
  end of file, `session-holder.ts:216`). The session uuid is not a secret.
- **Principle 4.** Nothing in `pipeline-core` changes. `packages/local` gets one optional `HostOptions` field.
  `WorkerLauncher`, the claude profile, the parser and `resumeOffer` live in `packages/cli`. **Principle 5.** The TUI sees
  only `WorkerLauncher`; tests give a fake. The launcher takes the adapter, the PATH lookup, the auth probe (with
  timeout and clock), the child-process runner, the platform, the clock and the uuid source injected. `resumeOffer` and
  the parser are pure. **Principle 7.** No node or check kind is touched.
- **Stored data and executor attribution.** No field of `RunState`, no journal event, no decision written by the TUI; a
  resume writes nothing on the run (tested byte for byte). `run_started.executor` gets `client: { name: kodel-tui }`
  with source `observed` (`clientOf`, `pipeline-core/src/executor.ts:126-130`; `docs/history.md:289`); the `session`
  part is the host's as for any start (`observe`, `executor.ts:236-258`): `CLAUDE_CODE_SESSION_ID` of the TUI's own
  environment when set (a TUI started from a Claude Code terminal then names that session, documented as the existing
  guess), else the newest hooked session, else absent. `t41_*` tables unchanged.
- **Session records and environment.** No new field, no `v` change: the session id lives in the argv the record already
  keeps, the decision in the name. The spec: `argv`, `cwd`, `name`, `origin: "cli"`, `timeoutMs` 12 h, `inheritEnv:
  false`, `env` = `workerEnv(process.env)`: the TUI's environment through `sessionEnv(undefined, true, base)` of
  `@kodel-ai/local` (drops `KODEL_*` and the window variables), minus `KODEL_ENGINE` (the adapter forces it), minus
  `CLAUDECODE` and every `CLAUDE_CODE_*`, minus any key that is not an identifier (`validateSpec`,
  `packages/pipeline-core/src/session.ts:100-104`). Load-bearing: `claude` 2.1.319 stops saving sessions "because
  CLAUDE_CODE_SKIP_PROMPT_HISTORY is set or it was started from inside another Claude Code session", and **an unsaved
  session cannot be resumed**. Kept: PATH, HOME, `CLAUDE_CONFIG_DIR` (the session store the resume reads),
  `ANTHROPIC_API_KEY` if present; the resume takes the environment of the moment it runs (a changed PATH or auth between
  the start and the resume is the resume's, tested). `KODEL_STATE_DIR` reaches only the worker's MCP server through the
  `--mcp-config` `env`. `origin: "cli"` is required (`insideHostSession` withholds tools only in a host session's
  group, `process-group.ts:110`); it is also why `agent rm` frees the name (Decision 5).
- **Verified in the code / live-only.** Verified: the `--resume <id>` shape is the live tests' (`harness.ts:454-478`),
  `session_id` is on `system/init` and `result`, `--session-id` is in `claude --help` ("Findings in the code"). Live-only:
  that `--session-id` is honoured under `-p` (else the tail's `result.session_id` is the source and the test says so);
  that `--resume` finds the session from the worker's cwd with the launcher's environment; that the resumed
  `system/init` carries the same id and the resumed session keeps the lists and `dontAsk`; whether a worker ever reaches
  for `kodel wait` (denied; the live log shows the attempt).
- **Clocks.** Journal lines are ordered by `seq` (the wait before the decision, `moved` after it); only the two
  comparisons with the record's `started` and `since` use `ts`, all `Date.now()` of this machine. A clock set back
  between the start and the wait can hide an offer; `s` then says `the wait is dated before the agent started`, and the
  person continues the run with any agent. A fast decision (made while the worker was still finishing its turn, so
  `decision.ts < since`) is offered: the dropped `decision.ts > since` check misfired exactly there.
- **Second client, dialog.** The worker's server is a kodel client of its own run: wanted. It is not a client of the
  person's decisions: `--no-decisions` (tools and dialog), the lists, the settled guard. A decision the person makes in
  the dialog of their own client is the same `decideHuman` and resumes the same way. `KODEL_ENGINE=1` only widens where
  the group guard looks (`process-group.ts:161`); it finds no `host` session, so the tools are served
  (`t42_cli_origin_session_keeps_tools`).
- **Runaway.** No budget: the worker is bounded by `timeoutMs` (12 h per session), by the person's `y` and decisions
  (one resume per decision), and by `kodel agent stop <name>`; the holder's timeout and `stop()` take the descendants
  with them (`session-holder.ts:319`, `session-pipes.ts:444-475`, tested in `agent.test.ts` already). `agents.max_parallel`
  is not consulted (it caps steps of one run); five `y` are five workers by design.
- **Locks and files.** The worker's server is one more process on the run files; the host's locks cover it. The offer
  is withheld while the TUI's own in-process step runs (`work.pending()`), and the TUI awaits that work before quitting,
  so a resumed worker never meets the TUI inside a step; the open engine-steps race (not new here) is live-only, and the
  manual scenario keeps approve-then-`q` during the command step: one attempt in `kodel status`.
- **Cost of the row state, digest and watcher.** `PipesSessionAdapter.list()` is synchronous and shells out to `ps` per
  record, so `statuses()` and `progress()` run this binary as a child (`agent ls --json`, `agent logs … --stdout --bytes
  262144`, `execFile`, 10 s timeout, `KODEL_STATE_DIR` passed through), parsed with type guards; one read out at a time,
  newest wins, a failed one marks every worker `unknown (cannot be read)` and keeps the last digest; the tail is read for
  the selected run only, `resumeOffer` runs for every run from `statuses()` alone. `kw-` records grow by one per decision
  until a person removes them (`docs/engines.md:171`). **Windows**: `s` is refused before anything is made; the worker
  reads and the watcher are skipped on `win32`.

## Acceptance criteria and tests

Model tests in `packages/cli/test/tui-worker.test.ts` (fake launcher, no terminal; style of `tui-tasks.test.ts`), parser
tests in `packages/cli/test/claude-stream.test.ts` (one fixture `packages/cli/test/fixtures/stream-json/session.jsonl`,
recorded from `claude 2.1.319`: `system/init`, an assistant text, a kodel `tool_use`, a `Bash` and an `Edit` one, an ok
and an `is_error` `tool_result`, `result`; the malformed, unknown-type, cut and oversized lines are built in the test),
rule tests in `packages/cli/test/worker-resume.test.ts` (pure; a golden journal under `fixtures/journals/` taken from a
real format-2 run with a rejected gate, a pause and an accepted change, plus the format-1 fixture of `fixtures/formats/v1`
read through the same loader), launcher and watcher tests in `packages/cli/test/worker-launcher.test.ts`
(`FakeSessionAdapter` / `ScriptedSessionAdapter` from testkit and a fake `exec`; then the real `PipesSessionAdapter`
with a Node script standing for `claude`: skipped where the process table is not readable, **required under
`KODEL_REQUIRE_PROCTABLE=1`**, which the `bun test` matrix job of `.github/workflows/ci.yml:39` sets on Linux and
macOS), host tests in the same file with a real `LocalPipelineHost` in a temporary project and the fake launcher, CLI
tests in `packages/cli/test/mcp-no-decisions.test.ts` (the MCP client of `engine-mcp-guard.test.ts:32`), and
`tests/agents/claude-code-worker.test.ts` (skipped without `KODEL_AGENT_TESTS`). `task_g4jy_backlog_has_no_start_key`
(`tui-tasks.test.ts:598`) is replaced by `task_9pns_backlog_offers_s`. Tests use a temporary project config; none relies
on this repository's `.kodel/config.yaml` (committed: `tasks.enabled` only).

| Criterion | Test |
|---|---|
| The Backlog hint names `s start`; every other key on the Backlog still only loads a task | `task_9pns_backlog_offers_s` |
| `s` on a Backlog row emits one `prepare_start` and shows `Checking…`; on a card of a `todo` or `progress` task without an active run too; on a run row, a `done` or `declined` task, or a task with an active run it emits nothing and says why | `task_9pns_s_asks_only_for_a_task_without_an_active_run` |
| `ready` with one pipeline shows the question; `y` alone emits `start_task {key, pipeline}`; any other key cancels with `Cancelled.`; a late `ready`, and a `ready` for another task, are dropped; the card moving cancels; `y` at `askedAt + 399` says `WAIT_FOR_Y`, at `+400` starts; a chunk `sy`, a bracketed paste holding `y`, a `y` not alone in its chunk start nothing | `task_9pns_y_confirms_any_other_key_cancels`, `task_9pns_guard_refuses_at_399_ms_accepts_at_400`, `task_9pns_a_paste_starts_nothing_a_lone_y_confirms` |
| `a`, `r`, `d` and `m.confirm` are untouched: while the `s` question is up they cancel it and do nothing else; `tui.test.ts` passes unchanged | `task_9pns_start_question_leaves_a_r_d_alone` |
| Picker: N ≤ 9 pipelines numbered; a digit emits `start_task` with that pipeline; `0`, out of range or any other key cancels; not remembered; with 12 pipelines nine offered and `3 more are not offered here` | `task_9pns_picker_chooses_cancels_and_forgets`, `task_9pns_picker_offers_nine_at_most` |
| Five `s`+`y` on five tasks: five effects in order (model); `s` on a started task says `already started: run …`; while in flight `being started` | `task_9pns_five_pairs_five_starts_and_a_repeat_starts_nothing` |
| The outcome lands in the notice: started, refused (each preflight reason, `reused`, `terminal`, no pipeline loads, `ChoiceNeeded`), failed after the run (the "was made but no agent" text), `--demo`; a failed resume in its words, once | `task_9pns_start_outcome_is_told_in_plain_words`, `task_9pns_resume_failure_is_told_once` |
| Right after `y` the row and card show `agent starting`; the first `withWorkers` replaces it with the record's state; digest lines appear as read; a run without a record shows nothing; a finished run with a record keeps its mark; every `SessionState`, `stateLabel` word and `problem` renders | `task_9pns_card_shows_agent_starting_then_running_with_progress` |
| A run `waiting` whose latest worker `exited` after a wait began reads `agent waiting for you`; once decided, `agent exited at your decision · s resumes` (with the warning when `moved`); `exited` with no wait begun reads `agent exited (1), not at a gate` and names `pipeline_next_step <run>`; during a resume `agent resuming`; after it `agent running (session 2)`; each "not offered" reason renders its card line and is what `s` says | `task_9pns_exit_at_a_gate_reads_as_waiting_for_you`, `task_9pns_card_offers_s_after_the_decision`, `task_9pns_card_says_why_a_decision_is_not_offered` |
| `s` on an offered run asks the question naming the kind, node, outcome and time, with the warning line when `moved`; `y` alone (same guard) emits `resume_worker {runId, seq}`; any other key cancels; `s` on a run with no offer says why and emits nothing; twenty refreshes after a decision, with no key, start nothing | `task_9pns_s_asks_to_resume_y_confirms`, `task_9pns_no_resume_without_a_key` |
| A `progress` task whose run ended is back on its card with `s`; `y` starts a second run; the task stays `progress` (Decision 4a) | `task_9pns_progress_task_whose_run_ended_offers_s_again` |
| The digest renders at most 8 lines, each one line; hostile input is harmless (`expectSafe`: ANSI, control, bidi and invisible characters, a hostile `tool_use` argument and `tool_result`); the last line names `kodel agent logs <name>`; a JSON-escaped multi-line secret matching a project rule is not in the digest; a `replace` rule applies | `task_9pns_digest_is_plain_bounded_and_names_the_log`, `task_9pns_digest_redacts_decoded_text` |
| After a resume the digest reads the latest record, opens with `· resumed (session 2)`, does not carry a half-event from the first tail; a resumed `init` with another `session_id` gives `· session id changed` | `task_9pns_digest_spans_two_sessions` |
| Worker read: one at a time; newest wins; a hanging read leaves `reload()` completing; a failed read marks `unknown` and keeps the digest; the tail for the selected run only while `resumeOffer` runs for every run; a hanging `progress()` does not delay an offer; nothing on `win32`; a 2 s fake `exec` does not delay the runs' ticks | `task_9pns_worker_read_one_at_a_time`, `task_9pns_worker_read_newest_wins`, `task_9pns_worker_read_hanging_leaves_reload_completing`, `task_9pns_worker_read_failure_marks_unknown_keeps_digest`, `task_9pns_worker_read_tails_selected_run_only_offers_any_run`, `task_9pns_worker_read_skipped_on_win32`, `task_9pns_worker_read_does_not_block_the_loop` |
| `createTasksRefresh` with the type parameter keeps `task_g4jy_scheduler_one_read_at_a_time_newest_wins` passing | `task_g4jy_scheduler_one_read_at_a_time_newest_wins` |
| Parser over the fixture: one line per event in order, the expected words for each kind; built lines: malformed (text never in the output), unknown type, a 300 KiB line, a cut first line (skipped silently; the same text as a second line is `(an event the TUI cannot show)`), a tail cut inside a UTF-8 character (no replacement character); `result` without `num_turns`/`duration_ms` is `result: ok`; `sessionIdOf(tail)` gives the `result`'s id, else `init`'s, else none | `task_9pns_stream_parser_fixture`, `task_9pns_stream_parser_built_lines`, `task_9pns_stream_parser_session_id_from_result_then_init` |
| Launcher: argv as specified, no `--max-budget-usd`, no `--model`; the uuid is the injected one; the mcp-config names `process.execPath`, `process.argv[1]`, `--root <root>`, `mcp`, `--no-decisions`, `--no-wait-hint`, `KODEL_STATE_DIR` only when set; the first prompt names the run id, the title and the workdir, says never `pipeline_start`, and holds no body text; the spec has `cwd` = workdir, `name` = `kw-<run id>`, `origin: "cli"`, `timeoutMs` 12 h, `inheritEnv: false` | `task_9pns_launch_spec` |
| Launcher, `ScriptedSessionAdapter`: `start`, `finish(id, {state: "exited", exitCode: 0, since})` with a `result` tail carrying the uuid; `resume({…, decision: {seq: 17, …}})` → a second spec: `-p <resume prompt naming the gate, the decision and the run>`, `--resume <the same uuid>`, no `--session-id`, name `kw-<run>-d17`, every other flag, both lists, cwd equal to the first spec's, env built from the environment of the moment (a changed PATH shows up); a reason with a secret-shaped string is redacted in the record; the resume's lists equal the start's | `task_9pns_launcher_resumes_the_same_session_under_the_decisions_name` |
| `sessionIdOf(records, tail)`: the **last** `--session-id <uuid>` of `kw-<run>`'s `command` (a title holding `--session-id <other uuid>` before the flags does not win), else the last `--resume <uuid>` of a `-d` record, else the tail's `result`; the tail's id wins over argv when both exist and differ; a mangled uuid falls through; none → `undefined`; pinned against a `command` string produced by the real adapter in the real-adapter test | `task_9pns_session_id_from_argv_then_tail`, `task_9pns_session_id_last_flag_wins_over_the_title` |
| `workerEnv(base)`: keeps PATH, HOME, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`; drops every `KODEL_*`, `CLAUDECODE`, every `CLAUDE_CODE_*`, the window variables, a non-identifier key; passes `validateSpec` | `task_9pns_worker_env_drops_claude_markers_and_kodel` |
| The allowlist is exactly the set above (every served `mcp__kodel__<name>`, none of `decisionTools({gate:true,pipelineChange:true})`); the deny list names both decision tools, every `AGENT_HUMAN_COMMANDS` entry, every human-only command and `wait r_*` in three spellings, the file denies (incl. `config.yaml`, `proposals/**`) in both forms and the state base; every command `dev.yaml` names is allowed; the pattern matcher of the test (the glob as Claude Code documents it) refuses `kodel wait r_0abc` and lets `cd …/.kodel/worktrees/r_0abc && bun test; wait` through | `task_9pns_allow_and_deny_lists` |
| `statuses()` runs `agent ls --json` once and groups `kw-<run>` and `kw-<run>-d*` by run, `latest` by `seq`, `resumes` = the count of `-d` records; a `problem` entry reads as unknown; `progress()` runs `agent logs <latest> --stdout --bytes 262144` through the parser; `logs()` and `stop()` go through the adapter | `task_9pns_status_progress_logs_and_stop` |
| Preflight refuses before `host.start`, one case each: win32, `decisions.dialog: true`, no `claude`, `loggedIn: false`, a rule with `replace`, no pipeline loads, `taskLink()` undefined; a probe that fails, times out (injected clock) or prints no JSON lets the start go on with no warning; the launcher writes no file | `task_9pns_preflight_refuses_before_any_run_*` (one per case), `task_9pns_preflight_refuses_signed_out`, `task_9pns_unreadable_probe_lets_the_start_go_on` |
| `startTask` order: `prepare_start` → question → `start_task` (`loadTask` → `host.start({restart:true, task_key, caller, pipeline, no title})` → `launcher.start`); a task gone `done` or active is refused; `reused`/`terminal` start no worker; `ChoiceNeeded` and a worktree error make no session; a `SessionError` after `started` gives the "was made but no agent" text and no cancel | `task_9pns_start_order_and_failures_*` (one per outcome) |
| After a successful start the state base holds exactly one new entry (the record); after a resume exactly one more; the run's `journal.jsonl` and `state.json` are byte-identical before and after the resume | `task_9pns_start_and_resume_write_only_the_session_record` |
| Task text = title, blank line, body; a task without a body = the title; a secret-shaped string in the body is in neither the record's `command` nor `agent ls --json`; the mcp-config holds no task text | `task_9pns_run_task_text_and_the_record_hold_no_body` |
| **`resumeOffer` table** (pure, one row each, equal-ms boundaries included): offered for a decided gate, a `run_resumed` pause, an accepted change (tool proposal), an accepted hand edit (`pipeline_accepted` with `source: "file"` and no wait line: the wait dated by `sinceLast`) and a dropped change (`withdrawn: true`) after an exit at the wait; offered when decided while the worker was still finishing its turn (`decision.ts < since`, `decision.seq > lastWait.seq`); offered **with the warning** when a `step_served`, `step_claimed` or `agent_completed` follows the decision; offered without it for a run with no `served` (prompts off) and for a run at `MAX_SERVED_EVENTS` (the journal says nothing; both rows carry a comment that the warning cannot be relied on); not offered for: `running`/`starting`; `killed` (stopped, timeout); `lost`; a `problem` record; `exited` with no wait begun (code 0 and 1); wait begun and decided during the session then exit 1 before the wait; `done`/`failed`/`canceled`/`unreadable`; a run waiting again (the decision older than the last wait: a worker resumed after gate A reached gate B and exited: the card says `agent waiting for you`); a fork with one gate decided and one waiting; `decided_by: agent` on `gate_decided` and on `pipeline_accepted` (`why` = agent decided); a record `kw-<run>-d<seq>` present in any state (`exited`, `killed`, `problem`); no session id; `work.pending()`; `lastWait.ts == started` (offered); a wait dated before `started` (not offered, `why` = clock); a `withdrawn` proposal is not a wait; `manual_edit` is not a decision; each not-offered case with a pending decision carries the right `why` | `task_9pns_resume_offer_table` |
| `decisionOf(journal)` and the three fields: a rejected gate, a pause + `run_resumed`, an accepted change (`pipeline_accepted` with `source`), a dropped change, a reason cut at 200 characters, a hostile reason made plain, the last decision wins; a hand-edit `pipeline_accepted` with no proposal line gives `lastWait` = `sinceLast`; over the golden format-2 journal and the format-1 fixture | `task_9pns_decision_of_golden_journals` |
| Loop, fake launcher and `FakeSessionAdapter`: after a decided gate twenty refreshes start nothing and the card offers; `s`+`y` resumes **once** under three overlapping refreshes, a second `s`+`y` during a slow `start` and after it (`already resumed`); after the resume the same gate is reached again and nothing is offered until a new decision; then the offer returns and `s`+`y` makes exactly one more record, named after the new `seq` | `task_9pns_s_then_y_resumes_once`, `task_9pns_resume_once_under_overlapping_refreshes`, `task_9pns_same_gate_again_offers_only_after_a_new_decision` |
| The offer is withheld while `work.pending()` (a TUI decision whose in-process step runs): the card shows no `s resumes` and `s` says `the TUI is running the step` until `work.wait()` resolves | `task_9pns_offer_waits_for_the_tuis_own_step` |
| Two TUI loops on one adapter and one state, `s`+`y` in both: one resume, the other gets `NAME_TAKEN` and says `already resumed`; the records are `kw-<run>` and one `kw-<run>-d<seq>`; the same with the real adapter (two loops, a Node stand-in) under `KODEL_REQUIRE_PROCTABLE=1` | `task_9pns_resume_once_with_two_tuis`, `task_9pns_resume_once_with_two_tuis_real` |
| The TUI is closed when the decision is made; a new loop's first refresh offers and starts nothing; `s`+`y` resumes once; a second new loop's `s` says `already resumed`; a decision followed by a `step_served` from another client is offered with `an agent was served a step since your decision` on the card and in the question | `task_9pns_offer_when_the_tui_opens_later`, `task_9pns_served_after_the_decision_is_a_warning` |
| A crash is not offered (card `not at a gate`); a `killed/stopped` and a `lost` worker are not; a `kw-<run>-d<seq>` removed with `agent rm` is offered once more and `s`+`y` makes it again (Decision 5a, characterized), with the warning when a step was served since; after the second resume twenty refreshes start nothing | `task_9pns_crash_is_not_offered`, `task_9pns_stopped_or_lost_worker_is_not_offered`, `task_9pns_removed_resume_record` |
| Resume failure: `adapter.start` throwing (not `NAME_TAKEN`) gives one notice, the offer stays, twenty refreshes start nothing, `s`+`y` tries again; `NAME_USED` gives the notice; a holder boot that timed out and kept a `-d<seq>` record is not offered and the card says `ended` | `task_9pns_resume_failure_is_told_and_s_retries`, `task_9pns_resume_name_used_is_told`, `task_9pns_failed_resume_record_blocks_and_is_told` |
| Real host, fake launcher, TUI loop running: `decideHuman` through a **second** host instance (as `kodel gate` and a client's dialog do) → the next refresh offers; `s`+`y` resumes once and the resume prompt names the gate and `approved`; `decideHuman(…, byAgent)` through the second host offers nothing and the card says `an agent decided and goes on` | `task_9pns_decision_from_the_cli_is_offered`, `task_9pns_agent_decision_is_not_offered` |
| Real host, fake launcher: two `host.start` with the same task and `task_key` → `started` then `reused`; one worker | `task_9pns_restart_true_does_not_double_start` |
| Real host, launcher that throws `SessionError`: the run exists, no cancel; a second start answers `reused`; `pipeline_next_step` with the run id answers the first node | `task_9pns_run_made_without_agent_is_reused_on_the_next_start` |
| Real host with `history.executor.enabled`: without `CLAUDE_CODE_SESSION_ID` and a hook index `run_started.executor` is `{ client: { name: "kodel-tui", version } }` only; with `CLAUDE_CODE_SESSION_ID` set it also carries that session with source `observed-env` (documenting the existing guess) | `task_9pns_tui_start_records_client_kodel_tui`, `task_9pns_tui_start_records_the_terminals_session_when_set` |
| Real host, a `progress` task whose run failed: the second start links the task to the second run (`add_run`), status stays `progress` | `task_9pns_progress_restart_links_the_second_run` |
| Real adapter and real `agent ls|logs`, a Node script as `claude` prints its env and argv as stream-json lines and exits 0: the child has the TUI's PATH, HOME, `KODEL_ENGINE=1`, no other `KODEL_*`, no `CLAUDECODE`/`CLAUDE_CODE_*` although the test set them; the mcp-config carries `KODEL_STATE_DIR` when set; `progress()` gives the script's lines; `statuses()` reads the uuid from the real `command`; `resume()` makes `kw-<run>-d<seq>` whose script sees `--resume <uuid>`; five starts make five records and five runs (the five `y` with a stand-in, not five real `claude`) | `task_9pns_child_env_and_resume_real`, `task_9pns_five_workers_real_adapter` |
| `kodel mcp --no-decisions` with `decisions: {dialog: true, agent: {gate: true, pipeline_change: true}}` in a temporary config and `KODEL_*` set: a client with `elicitation` drives a run to a gate and a pipeline change; `listTools` has neither decision tool; the instructions and waiting texts name neither; no `ElicitRequest`; `callTool` of either fails as unknown; the journal has no `gate_decided`/`pipeline_accepted`; the stderr line says `decisions.agent` does not apply | `task_9pns_mcp_no_decisions_serves_no_decision_tool_and_no_dialog`, `task_9pns_mcp_no_decisions_says_the_agent_allowance_is_off` |
| `kodel mcp --no-wait-hint` with `agent_hints.wait: true`: the instructions carry no `WAIT_OFFER` and the waiting answer at a gate is byte-for-byte the one `agent_hints: {wait: false}` gives; without the flag the text is today's; `HostOptions.agentHints` is preferred over the config by `hints()` and `loadAgentHints` agrees with it in the instructions (one test in `packages/local`) | `task_9pns_mcp_no_wait_hint_text_ends_the_turn`, `task_9pns_mcp_without_the_flags_is_unchanged`, `task_9pns_host_option_agent_hints_overrides_the_config` |
| The same client with the launcher's exact `workerMcpConfig` command, args and env behaves the same | `task_9pns_worker_server_cannot_decide` |
| **Live** (`tests/agents`, real `claude`): `TASKS_ON`, `decisions: {agent: {gate: true}}` in the sandbox config, dialog off, one seeded task, `MINI_PIPELINE`; split into one test per claim so a failure names it: the run reaches the gate; the waiting answer has no `kodel wait`; the session exits 0 while the run is `waiting`; no `gate_decided`; `system/init` lists no decision tool; its `session_id` equals the launcher's uuid (else the test records that `--session-id` is not honoured and the tail is the source); the session log exists under `claudeConfigDir()/projects/projectFolderName(workdir)`; `humanHost` approves; `resumeOffer` offers and `resume()` (what `y` calls) makes `kw-<run>-d<seq>`; the resumed `system/init` has the same `session_id`; `verify` runs; the run completes; the task is `done`; no raw JSON in either digest; a Bash call of `kodel wait`, if the agent tried one, is denied in the log. Reject and pause paths are **not live-tested** (the rule tests cover them) | `task_9pns_live_worker_*` (one per claim) |
| Live, adversarial: the prompt tells the worker to call `pipeline_decide_gate` and run `kodel gate approve`; the tool is unknown, the Bash call is denied, `gate_decided` is absent; the same in the resumed session | `task_9pns_live_worker_told_to_decide_is_denied` |

**What only a live run or a person can show**: the real `claude` honouring the lists, `--strict-mcp-config` and
`dontAsk`, in the resumed session too, and its subagents inheriting them; `--session-id` under `-p`; `--resume` finding
the session from the worker's cwd and environment; the engine-steps race (approve then `q` during the command step: one
`verify` attempt in the journal); the row and digest returning after `q` and `kodel tui` again; the picker on a real
second pipeline file; the first-run MCP trust dialog not appearing (`spikes/kdjs-m0/NOTE.md:46`).

Also `bun run typecheck`, `lint`, `test`, `bun run build && node scripts/check-artifact.mjs`. Manual scenario for the
final report (outside the sandbox, zsh; the final-gate report gives the worktree path and these steps): `kodel tui` on
this repository with tasks on; `s` on a Backlog task, read the question, `y`; the row says `agent starting` then `agent
running`; the digest shows the init line and the first tool calls; `kodel agent ls` shows `kw-<run>`; at the gate the
row says `agent waiting for you` and the session is exited; approve in the TUI; the card says `agent exited at your
decision · s resumes` and nothing starts; `s`, read the question, `y`; the row says `agent resuming` then `agent running
(session 2)`, `kodel agent ls` shows `kw-<run>-d<seq>`; the run ends. A second run: `kodel gate approve` in another shell
while the TUI is open: the card offers within 4 s; `s`+`y`. A third: approve, `q` at once, `kodel tui` again: the card
offers, nothing started meanwhile (`kodel agent ls` has no `-d` record), `s`+`y`; approve then `q` during the command
step, `kodel tui` again, one attempt of the step in `kodel status`. A fourth: at the gate tell the interactive Claude
Code of this repository to approve (`decisions.agent` on locally) and continue: the card says `an agent decided and goes
on`, `s` refuses. A fifth: `kodel gate approve`, then tell the interactive agent to continue: once it has called
`pipeline_next_step` the card adds `an agent was served a step since`; press `s`, read the warning, cancel. `kodel agent
stop` on a worker at a gate: not offered after the decision, the card says `stopped`. `claude auth logout` then `s`
gives the signed-in notice and no run. With a second pipeline file in `.kodel/pipelines/` the question becomes the
picker. At the end, the final report asks the person to amend TASK-9PNS with the task tools (below).

**The task's wording.** Its Done-when "after the person decides in the TUI the agent goes on" is met by the resume
after the person's `s`+`y` (Decision 1): the agent is not the same process but the same conversation, restarted once
per decision; the amendment says that one more key is asked. Two items of the task are changed
by the person and should be amended: the budget cap (`--max-budget-usd`, 5 USD) was removed at the gate (subscription);
"Not in this task: resume after a session ended" is lifted for a session that ended at a wait the person then decided (a
crash stays out). The spike note "At a gate the agent starts `kodel wait` in the background" describes the path the
worker no longer takes.

---

## Steps

One PR; the commits follow these steps in this order, and the PR description lists them with the live run's records
(including whether `--session-id` was honoured), and says that step 4 (`HostOptions.agentHints`, the two `kodel mcp`
flags) is a `local` and CLI change beyond the TUI, and that Decision 5 (`agent rm` offers the same decision again) is
documented behaviour.

1. **`WorkerLauncher` and the claude profile** (`packages/cli/src/worker-launcher.ts`,
   `packages/cli/src/claude-worker.ts`): the interface `{ preflight(input), start({runId, workdir, title}),
   resume({runId, workdir, sessionId, decision}), statuses(runIds), progress(runId), logs(runId, bytes?), stop(runId) }`;
   `WorkerStatus = { id, name, state, label, exitCode?, started, since?, sessionId?, resumes, decisionSeq? }`,
   `WorkerProgress = { lines }`, `PreflightResult`; `workerNameOf(runId, decisionSeq?)`, `WORKER_TIMEOUT_MS`,
   `WORKER_REFRESH_MS`; in the profile `WORKER_TOOLS`, `WORKER_DENIED`, `WORKER_DENIED_COMMANDS`,
   `WORKER_DENIED_PATHS`, `CLAUDE_MARKERS`, `workerAllowlist()`, `workerDenylist(root, stateBase)`, `workerArgv({prompt,
   sessionId, resume})`, `workerMcpConfig(...)`, `workerPrompt(runId, title, workdir)`, `resumePrompt(runId, decision)`,
   `workerEnv(base)`, `sessionIdOf(records, tail)`, `authProbe(exec, clock, timeoutMs)`. Pure, tested with the fakes.
2. **`claude-stream.ts`**: the parser of `stream-json` lines to digest lines, given the redaction rules, and
   `sessionIdOf(tail)` from `result` then `system/init`. Claude-specific, said so in its header.
3. **`SessionWorkerLauncher`** (`worker-launcher-session.ts`): built from `pipesAdapter({root, environment, launcher,
   rules})`, `{exec, args}` of this process, the state base, the PATH lookup, the probe, the child runner, the profile,
   the platform, the clock, the uuid source; `preflight`; `start` and `resume` build the spec and map `SessionError`
   codes to plain words (`NAME_TAKEN` on a resume = another TUI did it, silent); `statuses` = one `agent ls --json`
   child, grouped by run, `latest` by `seq`; `progress` = one `agent logs <latest> --stdout --bytes 262144` child;
   `logs` = `tail`; `stop`.
4. **`kodel mcp --no-decisions` and `--no-wait-hint`** (`cli.ts:394`): `--no-decisions` forces `dialog: false` and
   `agentDecisions` off in `settings`, one stderr line naming the lost `decisions.agent` allowance; `--no-wait-hint`
   forces `waitHint: false` in `settings` and passes `agentHints: { wait: false }` to the host (Decision 2a:
   `HostOptions.agentHints`, read first by `hints()`, `packages/local/src/host.ts:1111`). Tests with the MCP client.
5. **TUI model** (`tui/view.ts`, `tui/session.ts`, `tui/tasks.ts`, `tui/load.ts`): `Session.worker?: WorkerStatus & {
   lines }`, `Session.lastWait`, `Session.decision`, `Session.moved` (from the journal, beside `lastTs` and `sinceLast`,
   `load.ts:380-387`), a `starting` and a `resuming` set keyed by run id, `m.start`, `m.resume`; `s` → `prepare_start`
   on a task, the resume question on an offered run; `y`/digit → `start_task`, `y` → `resume_worker`;
   `withWorkers(m, statuses, progress)`; the row mark and the words, the card title line, the offer line, the warning
   and the digest block; the hint `s start`; `--demo` notice. `m.confirm` and `a`/`r`/`d` untouched.
6. **Offer** (`tui/worker-resume.ts`): `resumeOffer(session, workers, pending): { offer: {seq, decision, moved} } |
   { why? }` (pure; the rule above) and `decisionOf(journal)`.
7. **Loop and wiring** (`tui/run.ts`, `tui/worker-start.ts`, `tui/tasks-refresh.ts`, `cli.ts` `tui` action):
   `TuiOptions.prepareStart(key)`, `startTask(key, pipeline)`, `loadWorkers(selectedRunId)`, `resumeWorker(runId,
   seq)`; `perform` handles the effects; `loadWorkers` runs on its own timer through the detached-read helper of
   `tasks-refresh.ts` given a type parameter; after each worker read the loop computes `resumeOffer` for every session
   with `work.pending()` as input and only writes it into the model; `resume_worker` (the person's `y`) is the one
   path to `launcher.resume` (`resuming`, the notice); skipped on `win32`; `startTaskFor(host, tasks, launcher,
   config)` does `loadTask` → `host.start` → `launcher.start`.
8. **Docs**: the three paragraphs in `docs/tasks.md`; one line in `docs/history.md`.
9. **Live scenarios** `tests/agents/claude-code-worker.test.ts` with `tasks-harness.ts`; run outside the sandbox; the
   runs recorded in the PR.

## Affected files

- New: `packages/cli/src/worker-launcher.ts`, `packages/cli/src/claude-worker.ts`, `packages/cli/src/claude-stream.ts`,
  `packages/cli/src/worker-launcher-session.ts`, `packages/cli/src/tui/worker-start.ts`,
  `packages/cli/src/tui/worker-resume.ts`, `packages/cli/test/tui-worker.test.ts`,
  `packages/cli/test/claude-stream.test.ts`, `packages/cli/test/fixtures/stream-json/session.jsonl`,
  `packages/cli/test/worker-resume.test.ts`, `packages/cli/test/fixtures/journals/*.jsonl`,
  `packages/cli/test/worker-launcher.test.ts`, `packages/cli/test/mcp-no-decisions.test.ts`,
  `tests/agents/claude-code-worker.test.ts`.
- Changed: `packages/cli/src/cli.ts` (two `mcp` options; `tui` wiring),
  `packages/cli/src/tui/{run,view,session,tasks,load,tasks-refresh}.ts`, `packages/cli/test/tui-tasks.test.ts` (the G4JY
  key walk), `packages/local/src/host.ts` (`HostOptions.agentHints`, `hints()`; one test in `packages/local`),
  `docs/tasks.md`, `docs/history.md` (one line).
- Not touched: `packages/pipeline-core/**`, `packages/local/**` apart from the one option, `formats/`, `sessions/`,
  `config.ts`, `AGENTS.md`, `.mcp.json`, `.claude/settings*.json`, `.kodel/pipelines/`, `.kodel/tasks/`,
  `.kodel/config.yaml`.

## Rejected review findings

Recheck of 2026-11-06 (plan-revise 3); every finding is fixed above except these:

- **Counting `engine_session_started`/`command_*` after the decision as a guard:** not done; those lines are the
  engine's (the TUI's own in-process step writes them), so they would make the TUI refuse its own work, and under
  Decision 1 (c) no journal line decides. The gate-then-command window is one of the cases "Why the journal only
  advises" names.
- **(b) a staleness bound (no resume for a decision older than N hours):** not an option any more; nothing starts
  without a key, so age is for the person to read on the question (`<time>`).
- **The recheck's "default false" for `history.executor.enabled`:** `DEFAULT_HISTORY` has it `true`
  (`history-config.ts:121`); the point stands for a project that turns it off, and the text says so.

Plan-fix of 2026-11-06 (the review of the resume plan); what is not a fix above:

- **i6, the holder's stdout log may hold a JSON-escaped secret:** not fixed here; the holder redacts every session's
  bytes the same way today, and a decode-then-redact in the holder is a `local` change for every session. Named as a
  limit in the docs; the digest redacts the decoded text.
- **i5, who withdrew a change:** `pipeline_change_proposed` with `withdrawn: true` carries no field saying who; the
  `summary` is `dropped by a person` for `pipeline changes discard` (`host.ts:1253`) and the agent's free text for an
  empty `pipeline_propose_change` (`host.ts:1429`), a wording, not a contract. Both count as a decision: the offer is
  the person's to take, and an agent that withdrew is one more thing the person knows.
- **g5, `kodel ack` as a decision:** not added; an ack accepts run files changed by hand, says nothing about a step, and
  the person who edited by hand chooses the agent that goes on. The card stays on the hand-edit need.
- **g7, passing the uncommitted-pipeline choice through the question:** not done; a third question state for a case
  this project meets only while `dev.yaml` is edited. `s` refuses with the host's words; stated as a limit.
- **g8, relying on the missing hint alone against `kodel wait`:** not enough on its own (the worktree's `AGENTS.md`
  tells the agent the command is its own), so `wait` joins the denied Bash patterns; the live log shows any attempt.
- **t5, a format-1 golden journal with all three decision kinds:** the fixture of `fixtures/formats/v1` is read as it is
  (no format-1 run is fabricated); the three kinds come from the format-2 golden journal.
- **The optional warnings, the cost on the `result` line (s6), the adapter-only tests and the "other words start a
  second run" characterization (s2):** cut; `agent.test.ts` and the host's tests own them, the limits stay documented.
- **A resume cap (old Decision 4):** moot; the name is the decision's, so a resume without a new decision cannot exist.
- **Old Decision 1 (when resumed) and 2 (automatic or `y`):** Decision 1 of this plan; this revision recommends `y`.

Second gate (2026-11-06, resume instead of `kodel wait`), kept: `--wait-command`, the `kodel`-on-PATH warning, the
harness shim, the "without `kodel`" live case, a session-record field or TUI file for the session id, reading Claude
Code's session log from the TUI are all gone or not needed; the live test reads the log once to prove the same session.

Earlier critiques, kept: **1/31** (an opt-out of executor attribution) and **2** (a per-task lock) are `local` changes
outside this task, characterized and documented; **18** (a deterministic test of the engine-steps race): live-only
evidence instead; **29** (a worker thread instead of the child process): untested in the single-file bundle, and
`list({name})` is still synchronous; **37** (the prompt on stdin): the holder's FIFO never reports end of file; **14**
(a config key for the default pipeline): no such key (`config.ts:241`), the picker replaces the refusal; a `Flow` modal
for the question: a footer question with its own model field is a tenth of the code; the gate's premise "without
`kodel wait` the worker falls back to `wait_s`": not what the code does (`tools.ts:273`).

## Findings in the code

- **D-B is not in main.** `TASK-8EP9` is `status: todo`; `mcp-server.ts:92` decides `dialog` from the options alone. **The
  task is not done**: no `WorkerLauncher`, no `s` key (`view.ts` has `t`, `c`, `a`, `r`, `d`;
  `task_g4jy_backlog_has_no_start_key`, `tui-tasks.test.ts:598`), no `--no-decisions` (`cli.ts:394` has no options).
- **The wait hint** is read from the config in two places, `cli.ts:436` (`loadAgentHints`, into `settings.waitHint`) and
  the host's `hints()` per answer (`host.ts:1111-1121`, into `NextStepOptions.waitHint`, `:1133`); `tellToWait` returns
  `""` when off (`next-step.ts:252-264`), `WAIT_OFFER` is left out of the instructions (`tools.ts:58`). `HostOptions`
  (`host.ts:181-191`) has `agentDecisions` as the model for an option the CLI passes.
- **`claude` 2.1.319.** `-p` exits when the turn ends unless a background task of its own runs
  (`claude-code-wait.test.ts:22-27`). `--session-id <uuid>` ("must be a valid UUID", no `--print` restriction), `--resume
  [value]`; the binary's strings hold the "isn't saving sessions here …" text and the marker list `CLAUDECODE,
  CLAUDE_CODE, …`. The live harness already resumes one id three times (`harness.ts:449-479`,
  `dev-pipeline.test.ts:93-99,138-143`); no module in `packages/` parses `stream-json` yet. `claude auth status --json`
  prints `loggedIn`, `authMethod`, `apiProvider`.
- **Session records.** `SESSION_NAME_PATTERN` (`session.ts:47`), folded to lower case (`:50`); `start` claims the name
  with `createExclusive` (`session-pipes.ts:149-184`: a live or unreadable folder → `NAME_TAKEN`, gone → `NAME_USED`);
  **`remove()` frees the marker of a `cli` record with its folder** (`:584-591`). `SessionRecord.spec.argv` is redacted
  (`:206`); `SessionListEntry` (`agent-commands.ts:155-166`) has `command` (the redacted argv joined), `status`,
  `problem`. `validateSpec` refuses `KODEL_*`, non-identifier env keys and origins other than `cli`/`host`
  (`:100-104,118`). `PipesSessionAdapter.list()` (`:595-643`) is synchronous and runs `ps` per record where `/proc` is
  absent (`process-table.ts:20,48-70`); `tail()` returns `{ text, complete }` from a 256 KiB ring
  (`session-holder.ts:63-65`), redacted with pattern rules only (`:154,197,273`); the input FIFO is `O_RDWR` (`:216-226`).
  `AGENT_HUMAN_COMMANDS` (`agent-commands.ts:22-27`) refuse under `KODEL_ENGINE`.
- **The journal** (`pipeline-core/src/run.ts`). `JournalRecord = { v, seq, ts, event, … }` (`:894-900`). Waits:
  `gate_waiting` (`:1261`), `run_paused` (`:1598`), `pipeline_change_proposed` (`:1907`, with `withdrawn: true` when
  taken back or dropped: `host.ts:1245-1258` for `pipeline changes discard`, `:1430` for an agent's empty proposal).
  Decisions: `gate_decided` (`:2196`) and `pipeline_accepted` (`:2811`) carry `decided_by: "agent"` and `instruction`
  when an agent decided (`decidedBy`, `:526-527`); `run_resumed` (`:2954`). Signs of an agent, all best-effort:
  `step_served` (`:2314`; `served` exists only when the run records prompts, `:2261`; a quiet no-op when the run is not
  running, the step is not in its agent phase, at `MAX_SERVED_EVENTS` = 500 or for a key kept already, `:2303-2310`;
  the key is the prompt hash plus client and session only when `history.executor.enabled`, `host.ts:3178-3185`,
  `served.ts:38-44`), `step_claimed` (`:2367`), `agent_completed` (`:2058`). `change_proposed` stops being journaled
  after `MAX_LOGGED_PROPOSALS` = 100 (`:1905`). Not an agent's: `node_entered` (`:1222`, written by the engine right
  after a decision), `command_finished`, `check_finished`, `engine_session_started`. `manual_edit` (`:1862`) is written
  by `kodel ack`. A hand-edited pipeline file is noticed without a journal line (`describeChange("file")`,
  `host.ts:1242,1340`); `pipeline changes apply` writes `pipeline_accepted` with `source: "file"`. The TUI's `load.ts`
  reads the journal per run (`:152`), has `lastTs(journal, event)` (`:380`) and dates a wait from the three wait events
  with `sinceLast(journal, state)` (the last sign of life, `:385-395`) as the fallback (`:286,301,309`).
  `decideHuman(node, decision, reason?, byAgent?)` (`host.ts:3589`) is what `kodel gate`, the dialog and the TUI's
  decision tools call (`tui/decide.ts:75,197`); `createDecisionTools` returns `work: { pending, wait, stop }`
  (`decide.ts:166-190`).
- **The project config of this repository** is committed with `tasks.enabled: true` only; the `decisions.agent` block
  the earlier plan saw is an uncommitted local edit, so the tests build their own config and the manual scenario's
  fourth run depends on that edit. **`kodel` on PATH here is the published beta** (format 1): relevant only to a
  person's `kodel agent logs` in another shell (noted in the docs).
- **Reused.** `plain` (`plain.ts:28`), `neutralize` (`tui/ansi.ts`), `expectSafe` (`tui-neutralize.test.ts:73`);
  `m.confirm` (`view.ts:136`), `COMMENT_GUARD_MS = 400` (`:771,784-786`); a paste is no key (`input.ts:134`);
  `TuiOptions`, `perform`, `reload` (`run.ts:61,239,371`), `createTasksRefresh` (`tasks-refresh.ts:31`); `requireHuman`
  (`cli.ts:755`); `LocalPipelineHost.start` (`pipeline-host.ts:643`), `ChoiceNeeded` (`:694`), `taskLink()` (`:654-669`);
  `host.ts:800-810` `findActive` → `reused`, `findLatest` → `terminal`; the worktree (`:828`) before the run record
  (`:855`); `LocalRun.cancel()` (`:3778`) has no caller; `observe` (`local/src/executor.ts:236-258`) and `clientOf`
  (`pipeline-core/src/executor.ts:126`); `createServer` (`mcp-server.ts:84`). `packages/cli` has no `zod`: type guards.
- **`dev.yaml`**: eight agent steps, three gates (`plan-approval`, `confirm-nothing-to-do`, `final-approval`): three
  `s`+`y` per run; the prompts name subagents, `bun test`, `git commit -s`, `git merge --signoff`, `git push -u`, `gh pr
  create|view`. **Test equipment**: `MINI_PIPELINE` (`harness.ts:116`), `humanHost` (`:586`), `journalEvents` (`:595`),
  `TASKS_ON`/`seedTasks` (`tasks-harness.ts`), `FakeSessionAdapter` (`session-fake.ts:36`), `ScriptedSessionAdapter`
  (`engine-fakes.ts:49`: `specs`, `startGate`, `failStart`, `finish`). The sandbox blocks `ps` and the API; the live
  scenarios and the real-adapter tests run outside it.

## Changed at the final gate (2026-11-08, the person's decisions; they override the plan above where they differ)

- **The start and resume questions are windows, not footer lines.** `s` opens a centred modal (the box of
  `tui/modal.ts`, `boxOf`, shared with the decision Flow) with the task's key and title, the pipeline picker as a
  numbered list when there are several, the `an agent was served a step since your decision` warning for a resume,
  and the keys on their own line (`y start · Esc or any other key cancels`, `1-N choose a pipeline · …`, `y resume
  · …`); the window's buttons answer to the mouse. Every guard stays: a lone `y` or digit, `COMMENT_GUARD_MS` from
  the model's clock, nothing from a paste, any other key cancels, exactly one start or resume per confirmation. The
  "a `Flow` modal for the question: a footer question … is a tenth of the code" line under "Earlier critiques" is
  superseded.
- **A form to create a task (`n`).** From the Backlog (and the first screen of a project with no runs) and from the
  Tasks screen, a modal form with title (required), body (multi-line), priority (tracker's default / high / normal /
  low) and parent; no status field, because `TaskService.create` takes none (a new task starts in `todo`). Enter
  asks, `y` creates through `TaskService.create` (the TUI's second write, beside the comment), the notice names the
  key, the list is read again at once. Tests `task_9pns_form_*`, `task_9pns_n_opens_the_form_*`.
- **The Report tab of a run waiting at a human gate** reads: the agent's answer (its log, a step's summary, or the
  digest's last `>` line; no heading when there is none), the changed files with line counts, then `YOUR DECISION`
  with the gate prompt and `a Approve · r Reject` in words. The `AGENT ·` block (tool calls, `$ kodel agent logs`)
  is shown only while the run is `running`, as the tail of the very lines the Log tab draws (`activityLines` in
  `tui/tabs.ts`: the agent's own log, else the digest), and not on the Log tab itself. Tests
  `task_9pns_gate_report_*`, `task_9pns_gate_with_no_agent_answer_*`, `task_9pns_running_run_shows_the_log_block_*`,
  and the renamed Report-tab tests in `tui.test.ts`.

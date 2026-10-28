# Agent history

Coding agents keep a log of their sessions on disk, each in its own format. Kodel reads those logs, for the
sessions of Kodel projects only, into one **universal event format**. The cost, tool-call and agent-history
features are built on it, and none of them knows which agent wrote the log.

What reads a log is a **collector**, one per agent. Adding an agent means adding a collector and nothing else.

- The event types and the collector interface are in `@kodel-ai/pipeline-core` (`agent-history.ts`, pure).
- The collectors, which read files, are in `@kodel-ai/local` (`@kodel-ai/local/history`). The first is Claude Code.
- The conformance suite every collector must pass is `agentHistoryContract` in `@kodel-ai/testkit`.

Only the normalized events are meant to be kept, never the raw log. Every text in an event is a preview of at
most 500 characters, and every string goes through `redact` before it leaves the collector. (The 500 is the
current behaviour: the per-kind caps decided in "Capture decisions" at the end of this page are not built yet.)

## The event

An event is one JSON object, one per line when stored (JSON Lines). Every event has the same envelope.

| field | meaning |
| --- | --- |
| `v` | format version of the event, `1` |
| `agent` | agent id, for example `claude-code` |
| `agent_version` | version of the agent that wrote the entry (empty when the log does not say) |
| `session_id` | the session; the log of a subagent has a session of its own |
| `parent_session_id` | on the events of a subagent: the session that started it |
| `seq` | 1, 2, 3, ... in the order the collector gives them; the same for the same log |
| `ts` | UTC with milliseconds, `2026-10-21T10:00:00.000Z`; the collector converts epochs and offsets |
| `kind` | `session`, `message`, `usage`, `tool_call`, `tool_result`, `subagent` or `system` |

The fields of each kind:

- `session`: `cwd?`, `git_branch?`. The first event of a session.
- `message`: `role` (`user` or `assistant`), `text_preview`, `message_id?`.
- `usage`: one per model response. `model`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`,
  `semantics`, `message_id`, `request_id?`, `cost?`.
  - `semantics: additive`: the four counts do not overlap and are summed as they are. `overlap`: the agent counts
    the cached tokens inside `input`, so a total subtracts them first.
  - `reasoning` is the part of `output` spent on thinking, when the agent says so. It is inside `output`
    already, never added to it.
  - `cost` is `{ amount?, basis }`; `basis` is `reported` (the agent wrote it), `reported_zero`, `computed` or
    `unknown`. Collectors do not compute a cost: a log that does not carry one gives `unknown`.
- `tool_call`: `id`, `name`, `mcp_server?` (from `mcp__<server>__<tool>`), `input_preview?`, `started`.
- `tool_result`: `id`, `ok`, `ended`, `duration_ms?`, `size?` (bytes), `output_preview?`. It comes after its call;
  `duration_ms` is the difference of the two times and is left out when the call is not in the read part of the log.
- `subagent`: `agent_id`, `child_session_id?` (the session of the subagent's own log), `description_preview?`.
- `system`: `subtype`, `detail?`. Among them `format_drift`, see below.

## Reading a log correctly

These are the rules a collector follows, learned from real logs. Each is covered by a test.

- **Fold repeats.** Claude Code writes one line per content block of a response, all with the same `message.id`
  and `requestId`, and the `usage` grows while the response streams. The collector gives one `usage` event per
  response, with the last values. A line written twice is read once.
- **A result can come later.** A tool result is a separate entry after the call, paired by `tool_use_id`.
- **Subagents have their own files**, `<session>/subagents/agent-<id>.jsonl`. They are listed as sessions with
  `parent_session_id`, after their parent.
- **Unknown is skipped, never guessed.** An entry of a type the collector does not know (attachments, request
  blobs, bookkeeping) is skipped and counted in `ReadStats.skipped_entries`. Unknown fields of a known entry are
  ignored. A line that is not JSON, or longer than 8 MB, is skipped and counted in `invalid_lines`.
- **A torn last line is fine.** The agent may be writing the log right now.
- **An entry without a timestamp** takes the time of the entry before it; one with nothing before it is skipped.
- **Time does not go back.** An entry stamped earlier than the one before it (2 of 16,650 events in real logs)
  takes the earlier one's time, because `from`/`to` windows rely on the order. Times outside years 0001-9999 are
  treated as missing. A time without a zone is read as UTC, never in the zone of the machine, so the same log gives
  the same events everywhere. `started`, `ended` and `duration_ms` follow the same rule as `ts`.
- **Text is redacted, then cut.** A preview is redacted before it is cut to 500 characters (the current cap; see
  "Capture decisions" for the planned per-kind caps), so a secret that straddles the cut cannot survive as a prefix.
- **A response can be split by other lines.** A `user` or `system` line (a tool result, a hook summary) can come
  between the lines of one response; in real logs about 6% of responses are written like that. The fold keeps the
  response open until another response starts, and the events of the lines in between wait behind its `usage`,
  so the `usage` has the last values and the time of the response and the order of events stays that of time.
  Lines of two responses mixed with each other (A, B, A) were not seen in any real log; the first of them would be
  closed at the start of the other and the rest of it dropped.
- **The model is per response**, not per session.
- **Streaming.** A log is read as a stream and never held whole.

## Agent versions

The format of an agent's log changes between its versions. A collector therefore declares **format profiles**:
an ordered list of `{ id, versions, normalize }`, where `versions` is a range such as `<2.0.0` or
`>=2.0.0 <3.0.0` (comparators `<`, `<=`, `>=`, `>` joined by spaces, or `*`). A new format of the agent is a new
profile and a fixture for it.

The version comes from the log: Claude Code writes it on every entry, so a session that crosses a version is read
by two profiles with one `seq`. `selectProfile` picks the profile that lists the version. For a version no profile
lists it still reads: the nearest older profile (`above_known`), or the oldest (`below_known`); no readable
version uses the newest (`unknown_version`). The collector says so, never silently:

- `ReadStats.drift` lists `{ agent_version, profile, match }`;
- the session gets one `system` event with `subtype: "format_drift"` at the first entry of that version.

A real-agent test fails when the installed agent is outside every profile, and says what to add.

## Where the history is kept

By default a project keeps what Kodel writes under its own `.kodel` folder. With `storage: home` the history goes to
the project's folder under the user's home instead, so it is never committed and a `git clean` or a branch switch
cannot touch it:

```yaml
storage: home
project_id: etude-k3f9a2x1
```

| kept in `~/.kodel/projects/<project_id>/` with `storage: home` | stays in the project |
| --- | --- |
| `runs/` (the journal, state, reports, prompts, the agent log of each run) | `config.yaml`, `pipelines/`, `tasks/` |
| `proposals/<checkout key>/` (pipelines the agent proposed outside a run) | `worktrees/` (the run worktrees) |
| `start.lock` | `hooks.log` |
| `sessions.jsonl` (the hook's index of agent sessions) | |

`kodel init --storage home` writes both lines into a **new** config; the id is the folder name (lowercased, cut to
`[a-z0-9._-]`, at most 24 characters) and 8 random characters. An existing config is not rewritten: add the two lines
yourself. The id is a folder name on three systems, so it must be 3 to 64 characters of `a-z`, `0-9`, `.`, `_`, `-`
starting with a letter or a digit, with no `..`, no trailing dot and not a name Windows keeps for a device (`con`, `nul`,
`com1`, ...). Both keys must be written as lines of their own at the top level (`storage: home`, optional quotes and a
trailing comment): the hook reads them with a line matcher, so the config refuses any other spelling (a flow mapping,
an anchor, a block).

**`KODEL_STATE_DIR`** replaces `~/.kodel` as the base (`$KODEL_STATE_DIR/projects/<project_id>/`). It must be an absolute
path. It is also where the integrity hashes are kept, so with it set the history and the hashes share one folder;
`XDG_STATE_HOME` moves the hashes but not the history. Set it in your shell profile, not only in `.mcp.json`: the MCP
server, your shell, the agent's shell and the hook each read their own environment, and `kodel wait` (which the agent
runs) looks where its own environment says. `KODEL_*` is not passed to the commands the engine runs.

**One place is read: the one the config names.** Switching `storage` hides the runs of the other place until you move
them. To carry the history from `.kodel` to `home` (with `$HOME_TREE` for `~/.kodel/projects/<project_id>`, or
`$KODEL_STATE_DIR/projects/<project_id>`; `kodel status` prints it on a terminal once `storage: home` is set):

```sh
mkdir -p "$HOME_TREE/runs"
mv .kodel/runs/* "$HOME_TREE/runs/"
cat .kodel/sessions.jsonl >> "$HOME_TREE/sessions.jsonl"
```

and the other way round with the two places swapped. Pending proposals made outside a run are not moved: the folder
inside `proposals/` is named by a hash of the checkout. **Before** you switch, take them back with
`kodel pipeline proposals discard <name>` (afterwards that command reads only the new place and cannot see them), and let
the agent propose again. Then restart the MCP server: it refuses every call that opens or starts a run while the
config names another place than the one it started with (a checkout of a branch without the keys does the same). A run
that was open when you moved the history does not resume (its `workdir` is an absolute path), as after any move.

**The id is stable, the path is not.** Renaming, moving or re-cloning the project keeps its history, because the folder
is named by `project_id`, not by where the project stands. The integrity hashes are keyed by the id in `home` mode too,
so a moved project keeps its trust. Switching the mode, or editing `project_id`, changes the key: the moved runs read as
*unknown* and are adopted on first use (so does a run whose hash file was deleted; `kodel status` counts the runs
without a recorded hash). Treat both as ways to reset trust.

**Several clones of one project on one machine** share one history, because they share the `project_id`; the same
goes for a fork that copied the config. Each run records the checkout that made it (`root` in `meta.json`); a clone
does not reuse or continue a run of another one (`resume`, `next_step` and the like fail with "belongs to the checkout at
..."), starts its own, and shows the others as `foreign` in `kodel status`. `gate`, `ack` and `seal` by id still work
and say whose run it is. `root` is advisory: it sits in a file the agent can rewrite, so it keeps honest clones from
stepping on each other and is not a security boundary. Outside-a-run proposals are kept per checkout. To separate two
clones, give one of them another `project_id`.

**Who can change it.** `storage` and `project_id` are in the config, which is the person's file, and no MCP tool takes
them. The deny rules of this repository (`Edit/Write` on `.kodel/runs/**`) cover the project place only: with `home`
the person adds rules for the home tree and for the config to the agent's settings (they are the person's file;
nothing is shipped). For Claude Code, in `.claude/settings.json`; the path forms matter there: `~/` is the home folder,
`//` starts a path from the root of the file system, and a path with a single leading `/` is relative to the project, so
it would match nothing here:

```json
"deny": [
  "Edit(~/.kodel/projects/<project_id>/**)",
  "Write(~/.kodel/projects/<project_id>/**)",
  "Edit(.kodel/config.yaml)",
  "Write(.kodel/config.yaml)"
]
```

With `KODEL_STATE_DIR` set the tree is under that folder: write it with `//` (`Edit(//data/kodel/projects/<project_id>/**)`
for `KODEL_STATE_DIR=/data/kodel`).

An agent that edits the config can still move new runs out of the rules, and nothing alerts the person: this is
accepted and stated here, and the requirement "only a person changes the setting" holds by the rule in `AGENTS.md`, not
by enforcement.

**For a team.** The keys are committed, so the mode is the team's and follows the branch. An older kodel refuses a
config with the keys ("unknown key"), so upgrade everybody's kodel before committing them. The history is per user:
teammates and CI do not see each other's runs, and a machine without a writable `$HOME` (CI, a sandboxed agent) cannot
start a run in `home` mode; set `KODEL_STATE_DIR` to a writable folder there. A sandbox that confines writes to the
workspace also stops the hook from writing the session index (it logs the failure and skips; the sessions of that agent
are then not recorded); one that cannot even read `~/.kodel` stops `kodel wait` too, which then does not find the run.

**What `kodel status` shows.** With `storage: home` it prints the mode and the place on its first line (the real
folder on a terminal, `<home>` when it is not one: an agent's shell has none), marks the runs of another clone as
`[foreign]` and counts the runs that have no recorded hash. A project that keeps its history in `.kodel` prints what it
always printed on a machine that has no history under `~/.kodel` (or `KODEL_STATE_DIR`); on a machine that has (the
`projects` folder is there) it adds one line, `storage: project (this project keeps its history in .kodel; ...)`, so a
branch that flips a project from `home` to `project` is named, not just seen as "no runs". The server refuses the
next call that opens or starts a run in that case. A server that is already running writes to the place it started
with until it is restarted: the check stops new calls, it does not move a call that has begun.

**If a run cannot be found** the message says it may be kept in the other place: after a switch, or because
`KODEL_STATE_DIR` is not the same in the shell and in the server. It says so for a `home` project and for any project
on a machine that has the `projects` folder; a machine with no history under `~/.kodel` keeps the plain text. An orphan
folder left by a project that was deleted is removed by hand (the folder name starts with the project's name).

## Which sessions are read

Only the sessions of Kodel projects: a directory tree with the Kodel marker (`.kodel/config.yaml`, found as
`findProjectRoot` does), together with its worktrees.

- A collector works only on a root that has the marker: `locate` of a directory without it returns nothing and `read`
  of a ref into it is refused with `HISTORY_PATH_OUTSIDE_PROJECT`, whatever sessions the agent has for that directory.
- With the session index of the hook transport (`.kodel/sessions.jsonl`, or the project's folder under `~/.kodel` with
  `storage: home`; there the lines whose `cwd` is outside this checkout and its worktrees are ignored), when it has lines
  of the agent, the index is the answer and nothing is scanned. It lists only the sessions started since the hooks were connected.
- Otherwise the agent's own folders for the root and for its worktrees are scanned, and the folders of the
  directories under them (a session started in a subdirectory, or in a worktree that was removed with its run).
  A log counts only when the `cwd` of its first entry that has one, found in the first 256 KB, is in the project;
  a log with none there is not listed. A log of another project (a sibling `app-two` of `app`) is opened for that
  first line and no further.
- The `cwd` of a `SessionRef` is only a hint. It comes from a hook or from whoever built the ref, so `read` always
  takes the `cwd` from the log itself.
- `ReadStats` is filled also when the consumer stops reading early.
- A collector refuses a `SessionRef` whose log is not in the agent's own store (symlinks are followed before the
  check), or whose session does not belong to the project, with `HISTORY_PATH_OUTSIDE_PROJECT`, and one it cannot read with `HISTORY_SESSION_UNREADABLE`.
- A collector opens only session logs. It never reads credential or settings files of the agent.
- Agents delete old logs (Claude Code after 30 days). What is gone is gone.

### Claude Code

Logs are in `$CLAUDE_CONFIG_DIR/projects/<folder>/<session>.jsonl` (`~/.claude` by default). The folder name is the
working directory with every character that is not a letter or digit replaced by `-`; a name over 200 characters
is cut and followed by a hash, which is not reproduced: such a folder is found by its first 200 characters.

The transcript does not contain every request the agent makes (titles, summaries and the like), so the totals of
the events are a little below the agent's own. On a clean one-turn session the test accepts a difference of 10%.

## Writing a collector for another agent

1. Implement `AgentHistoryCollector`: `agent`, `profiles`, `locate(projectRoot)` and `read(ref, window?, options?)`.
   `read` is an async stream, gives `seq` from 1, applies `window` (`from`, `to`, `seq_from`), fills `options.stats`
   and refuses a ref outside the project.
2. Declare a profile per log format with `FormatProfile`; check them with `checkProfiles` (the contract suite does).
3. Add sanitized logs of each version under `fixtures/history/<agent>/<version>/` and the expected events under
   `fixtures/formats/v1/history/`.
4. Run `agentHistoryContract` on it, as `packages/testkit/test/agent-history.test.ts` does for Claude Code and for a
   fake agent whose files look nothing like Claude Code's.
5. Register it in `defaultHistoryRegistry`.

## Who ran a run (`executor` and `engine`)

With `history.executor` on (the default), the journal says who acted and which engine served the run. Nothing in
it comes from the agent's own word: the tools take no such argument, and one that is sent is ignored. Every value
is `{ value, source }`, and a part that cannot be observed is left out, never guessed.

| where | what |
| --- | --- |
| `run_started.engine` | `version`, `commit`, `record_version`, `meta_version`, `contract_version`, `instructions_hash`, `tools_hash` |
| `run_started.executor`, `agent_completed.executor` | `client` (name and version), `session`, `model` |
| `agent_completed.engine_version` | only when the engine that completed the step is not the one that started the run |

| source | meaning |
| --- | --- |
| `observed` | the transport says it (the MCP handshake: the client's name and version) |
| `observed-env` | the environment of the server (`CLAUDE_CODE_SESSION_ID`); exact, since the agent starts a server per session |
| `observed-hook` | the newest session the hooks registered in the session index (`.kodel/sessions.jsonl`, or its place under `~/.kodel` with `storage: home`) for the run's directories; used when the environment has none |
| `derived` | read out of the session's own log (the model of its last answer) |

Strings from outside are stripped of control characters and cut at 200 characters, and the store redacts them like
everything else it writes. `contract_version`, `instructions_hash` and `tools_hash` are there when the host knows what
the agent was served; they change when the instructions or a tool (its name,
description or arguments) change. With `history.executor: false` none of these fields is written.

## What the agent was shown (`served/`)

With `history.prompts` on (the default), the run keeps the text the agent was handed at each step, so it can be
read after the engine's templates have changed. Every `node` answer that the tools `pipeline_start`,
`pipeline_next_step` and `pipeline_complete_step` return is kept, whichever way it reached the agent (a gate
decided in the client's dialog, or by the agent on the person's word, included). `waiting`, `running` and `done`
answers are not.

| where | what |
| --- | --- |
| `served/<node>-<attempt>-<n>.json` | `v`, `node`, `attempt`, `n`, `prompt_hash` and `answer`: the step as the engine built it (`prompt`, `reentry_feedback`, `result_spec`, `outcomes`, `execution`, a waiting `pipeline_change`), redacted |
| `step_served` (journal) | `node`, `attempt`, `n`, `ref` (the file), `prompt_hash` (sha256 of the redacted answer), `executor` (as above, when `history.executor` is on) |
| `served_write_failed` (journal) | the file of a `step_served` could not be written: `node`, `attempt`, `n`, a short `message` |

- **Once per answer and client.** The same answer to the same client is kept once, however often `pipeline_next_step`
  is called. The key is the hash of the answer, the client (name and version) and the session when the environment
  gives it (`CLAUDE_CODE_SESSION_ID`). A session found only through the hook index is written into `executor` but is
  not part of the key: it is the newest session of the directory and changes with the window in front. With
  `history.executor: false` the key is the hash alone. The state keeps only a short hash of each key.
- **Bounded.** At most 20 files per attempt, 500 `step_served` and `served_write_failed` events per run, 256 KiB per
  file. The answer is redacted first; a file over the limit has its biggest field shortened (a text, with a marker) or
  replaced (`result_spec`, `pipeline_change`: `{"omitted": true}`) and says `truncated: true`. `prompt_hash` is that of
  the whole answer, so a cut file cannot be checked against it.
- **The run machine numbers the files.** `n` and the file name come from the machine under the run's lock, and the
  file is written after the event was accepted: there is no file without an event. A crash between the two, or a write
  error (`served_write_failed`), leaves an event without a file; read that as "not stored". The agent still has the
  answer: recording never changes what it is told.
- **Not guaranteed to be complete.** An answer built just before the run is paused or ended, or the step is completed
  by another client, is handed to the agent but not recorded.
- **Old runs.** A run has the `served` key in its state only if it was started with `history.prompts` on by an engine
  that records this. The report says `prompts: <n> served` for such a run and `prompts: not_collected` for any other
  (an older run, a switch off at its start, or a run started before this record existed and continued after).

## Capture decisions

**Planned defaults, not yet built.** They were decided in TASK-52A8 and are built in TASK-3BK2 (the agent log) and
TASK-9JRS (cost and prices). Until those land, the behaviour described above stays: previews of at most 500
characters, and no `agent_log/` in a run. The plan is `docs/plans/task_52a8.md`.

**The agent log is on, and it is `full`.** Each run keeps the session of its agent in `agent_log/` of the run folder,
as normalized events with redacted text previews, with no opt-in (like the other history categories that are on by
default). The raw log is never copied. The run folder is committed when the project tracks `.kodel/runs` (this
repository ignores it, and `kodel init` does not write `.gitignore`); with `storage: home` it is not in the repository at
all. **Projects that upgrade start storing full
sessions.**

| kind | key in `preview_chars` | default cap (characters) | measured p90 / p95 / p99 |
| --- | --- | --- | --- |
| message from the person | `user` | 4 000 | 6 224 / 11 049 / 18 037 |
| message from the agent | `agent` | 4 000 | 1 550 / 2 438 / 4 390 |
| tool input | `tool_input` | 4 000 | 2 011 / 4 108 / 10 822 |
| tool result | `tool_result` | 8 000 | 4 864 / 7 789 / 19 430 |

The caps are `history.agent_log.preview_chars` in `config.yaml`, per kind (the keys above) or as one number; `0` empties
a kind. The subagent description and `system.detail` keep 500. The percentiles come from 647 session files; with these
caps a median session is about 163 KB of events (38 KB gzipped), a p90 session 2.4 MB, the largest 12.9 MB.
`max_kb` (default 20480, bytes after redaction and cut) limits the events of one run. It is split per step so that a
long run does not lose its end: each step may use `max_kb` divided by the number of nodes of the pipeline, and what a
step does not use carries over to the next ones. When a step's share is full, whole events are dropped, one marker event
counts them, and the report names the step. `mode: metadata` keeps the envelope, usage, tool names, times and sizes and
no text; `enabled: false` stores nothing.

- **Which session.** Only a session proven to have called `pipeline_*` with the run's id; a session known only from
  the hook index is not stored ("session unknown"). Only events from the response that issued `pipeline_start` to the end of the run.
- **When.** At the end of each step and of the run, up to the last closed response; nothing is written to a finished
  run, so the tail of the last response may be missing, and the report says so.
- **Switches.** `agent_log` is the privacy switch of this data. `usage` and `tool_calls` read the log themselves;
  `tool_log` stays the switch of the hooks, and `agent_log` stores no tool events when `tool_log` is off. A kind is
  silenced with `preview_chars: 0`, not with `prompts` or `output`.
- **Frozen at the start.** The keys, and the price override, are journaled in `run_started.history`; an edit of the
  config during a run changes nothing for that run. A run without them reads as "not captured".
- **Display data.** `agent_log/` is outside the seal and shown as unverified. It is information only: usage and cost never
  feed a check, a route or a gate.

**Prices.** A table in code (`pipeline-core`, plain data): `format`, `revision` (a date), per model the prices of input,
output, cache read and cache write, and `effectiveFrom`, `sourceUrl`, `checkedAt`. The entry is chosen by the time of
the usage event. A project can override it in `history.usage.prices`; an entry replaces the shipped one of that model
whole, and the cost records `source: shipped | config`. A cost is computed when the usage is collected, stored with the
`revision`, and not recomputed with a later table. A total over a model without a price is `partial`, never `$0`. Every
cost from the table is an estimate. The check of the table (a script with a network mode and a `--local` mode, and a
skill for the maintainers) is built with it. Claude Code's own `cost-state` entry totals a whole session, is written once
when it ends, is missing from about half of the session files and is always above the event totals. It is not an event,
is never in a run and is never shown as a run's cost; only the `--local` check reads it, with the same project scoping
as the collectors (Kodel projects only).

**Residual risk.** `redact` catches known patterns and 32+ character mixed high-entropy words. It does not catch hex-only or
short secrets, a secret split across two events is redacted per event, and `history.changes.exclude` does not apply to
the agent log. A tool that reads an `.env` puts up to 8 000 characters of it into the log; in a tracked history that is
permanent. Lower it with `preview_chars: 0` for a kind, `mode: metadata` or `enabled: false`.

**Constraint.** The format changes this needs (optional `revision`/`source` on `usage.cost`, `text_preview` optional in
`metadata`, a new cut marker, new `run_started.history` keys) are allowed under `v: 1` only before the first release, so
the release waits for them, or the version is bumped with a reader of the previous format.

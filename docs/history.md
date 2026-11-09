# Agent history

Coding agents keep a log of their sessions on disk, each in its own format. Kodel reads those logs, for the
sessions of Kodel projects only, into one **universal event format**. The cost, tool-call and agent-history
features are built on it, and none of them knows which agent wrote the log.

What reads a log is a **collector**, one per agent. Adding an agent means adding a collector and nothing else.

- The event types and the collector interface are in `@kodel-ai/pipeline-core` (`agent-history.ts`, pure).
- The collectors, which read files, are in `@kodel-ai/local` (`@kodel-ai/local/history`). The first is Claude Code.
- The conformance suite every collector must pass is `agentHistoryContract` in `@kodel-ai/testkit`.

Only the normalized events are meant to be kept, never the raw log. Every text in an event is a preview, cut
to 500 characters unless the consumer asks for other caps (the agent log does: see "The agent log"), and every
string goes through `redact` before it leaves the collector.

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
- `message`: `role` (`user` or `assistant`), `text_preview?` (absent in `metadata` mode and when the cap of its kind is
  `0`), `message_id?`.
- `usage`: one per model response. `model`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`,
  `semantics`, `message_id`, `request_id?`, `cost?`.
  - `semantics: additive`: the four counts do not overlap and are summed as they are. `overlap`: the agent counts
    the cached tokens inside `input`, so a total subtracts them first.
  - `reasoning` is the part of `output` spent on thinking, when the agent says so. It is inside `output`
    already, never added to it.
  - `cache_write_1h?` is the part of `cache_write` written with the 1-hour lifetime (priced higher than the
    5-minute one). It is inside `cache_write`, never added to it, and only a read made for usage
    (`ReadOptions.usageDetail`) carries it; the events other readers get have no such field. The same option makes
    a stopped read without `holdBack` keep back the response it was in the middle of; the engine's own usage pass
    reads with `holdBack` and does not need that, so it is a guard for other consumers.
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
- **Text is redacted, then cut.** A preview is redacted before it is cut (to 500 characters, or to the cap of its kind
  when the consumer sets caps), and a cut never splits a surrogate pair, so a secret that straddles the cut cannot
  survive as a prefix.
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

A config without the `storage` key keeps what Kodel writes under the project's own `.kodel` folder, so a project
that already exists does not change. `kodel init` writes `storage: home` and a generated `project_id` into a new config
(`kodel init --storage project` writes neither, and an existing config is never rewritten). With `storage: home` the
history goes to the project's folder under the user's home instead, so it is never committed and a `git clean` or a
branch switch cannot touch it:

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
`$KODEL_STATE_DIR/projects/<project_id>`):

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

**What `kodel status` shows.** With `storage: home` it prints the same table as before (it does not name the folder),
marks the runs of another clone as `[foreign]` and counts the runs that have no recorded hash. A project that keeps its history in `.kodel` prints what it
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
The agent names the folder after the directory it really works in. A project reached through a link (on macOS the
temporary directory is `/var/...`, a link to `/private/var/...`, and a linked home is the same) is therefore looked for
under both names, the one as given and the real one, for the copy of the agent's log and for usage alike; what counts as the
project's is still decided by the log's own `cwd`, so a folder of another project is never credited (its lines are scanned for the
run's id only, and it is refused when its own `cwd` is not in the project).

The transcript does not contain every request the agent makes (titles, summaries and the like), so the totals of
the events are a little below the agent's own. On a clean one-turn session the test accepts a difference of 10%, and
the comparison is **window to window**: the agent's own count for the whole `claude -p` turn is far above the run's by
design, because it holds the requests before the run (a tool search, listing the pipelines, the first large cache write) and
after it (the final answer, the background watch). In the first real run the run held 4 / 319 / 57 612 / 534 tokens (input /
output / cache read / cache write) and the whole turn 14 / 1 133 / 186 722 / 17 448. The real-agent test therefore builds
its reference from the agent's own stream: the responses from the one that issued `pipeline_start` to the one that issued
the last `pipeline_complete_step`, both included, which is what the pass credits to a run. **Output is not compared:** in
Claude Code's stream the per-message `output_tokens` is a streamed placeholder (66 in the stream against 513 in the transcript
in the real run, while input, cache read and cache write were exactly equal), the transcript holds the final value, so the
stream is no independent reference for it and output is only printed. The sum of input, cache read and cache write is held to
10%, and each of them when the agent's own figure for it is at least 100 tokens.
The transcript also undercounts uncached input and cache reads for a session with forks and subagents (a fork does not log the
prompt it inherited, and a cache written again after it went idle is not in it): in a measured session they were 23-51% below
Claude Code's own `/usage`, while output agreed within 1%. The 10% holds for a clean one-turn session only, and the cost of a model
is only as good as its row of the price table.

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
| `run_started.executor`, `agent_completed.executor`, `step_served.executor` | `client` (name and version), `session`, `model`, `session_name` |
| `agent_completed.engine_version` | only when the engine that completed the step is not the one that started the run |

| source | meaning |
| --- | --- |
| `observed` | the transport says it (the MCP handshake: the client's name and version), or a kodel command that names itself (`kodel-tui` for a run started with `s` in the TUI) |
| `observed-env` | the environment of the server (`CLAUDE_CODE_SESSION_ID`): the session that was current when the server started. A server lives as long as its agent process, so after `/clear` it still names the old session |
| `observed-hook` | the newest session the hooks registered in the session index (`.kodel/sessions.jsonl`, or its place under `~/.kodel` with `storage: home`) for the run's directories; used when the environment has none |
| `derived` | read out of the session's own log (the model of its last answer, the name of the session) |

Strings from outside are stripped of control characters and cut at 200 characters, and the store redacts them like
everything else it writes. `contract_version`, `instructions_hash` and `tools_hash` are there when the host knows what
the agent was served; they change when the instructions or a tool (its name,
description or arguments) change. With `history.executor: false` none of these fields is written.

### The name of the session (`session_name`)

`session_name` is what the session is called in the agent's own log: the title the person gave it with `/rename`
(Claude Code's `custom-title` record), else the name the agent shows for it (`agent-name`), else the summary the agent made of the session
(`ai-title`; an automatic session may have only that record). It is
read from the last 512 KB of the log each time a record is written, so a rename shows in the next record, and it is
kept in the record, so it is still there after the agent has deleted its log (Claude Code does so after 30 days by
default).

- **It is personal text.** It is the person's own label, or the agent's summary of their first prompt (an automatic
  `agent-name` equals the `ai-title`). It is written whenever `history.executor` is on, which it is by default, and
  `history.executor` is the only switch: `false` drops the client, the session, the model and the name together. The
  run history is in the repository unless `storage: home` says otherwise, so a project whose history is committed
  starts to commit names when kodel is updated. Records already written are not rewritten.
- **It may belong to another window.** The session of an `observed-hook` record is a guess (the newest session the
  hooks registered), so its name is a guess too, and it is written all the same.
- **It is display text, not the agent's word.** It comes from a file the agent's session can write, so it decides
  nothing, and kodel never names a run by it alone. It is stripped of control, bidirectional and zero-width
  characters, redacted, and only then cut at 120 characters (so that a secret is whole when the rules meet it).
- **A rename shows without a call of the agent.** The copy of the agent's log (`history.agent_log`, every
  `interval_s` seconds while the run goes, and at the end of each step) looks at the name of every session that is
  proven to belong to the run (its log calls the run's tools) and journals `agent_session_named` (`session`,
  `name`) when it is not the name journaled last. The state keeps only the sha256 of that name
  (`agentLog.nameHashes`), never the text, because the state is not redacted. The event is written only when
  `history.executor` and `history.agent_log` are on (also in `metadata` mode), only for a run of format 2, and
  there is no limit to how many are written: one per session per pass at most, and only on a change. A session
  that was proven and has a name gets one on the first pass of every run.
- **When it does not.** The run is `running` (a paused or finished run keeps its last name); the server that
  holds the timer is alive and has seen a call of the run since it started (after a restart, `/resume` or a restart
  of Claude Code nothing is journaled until the agent calls); `interval_s` is not 0 (then only at the end of a
  step); fewer than 4000 `agent_log_saved` events were journaled (the timer stops there; it counts saves, not time);
  with `storage: home` the copy sees only the session of the environment of the server; a cleared title is not
  journaled, so the old name stays; a stopped stream is not looked at.
- **Limits.** A session that was renamed has the name in its log every few KB; one that was not may have it farther
  back than the last 512 KB, and then there is no name. No log, no name. After `/clear` or `/resume` the server still
  names the session it started in (`observed-env`), so it is that session's name that is recorded.

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

## The agent log (`agent_log/`)

Each run keeps the sessions of its agent in `agent_log/` of the run folder, as normalized events with redacted text
previews. It is **on by default and `full`**, with no opt-in (like the other history categories that are on by default).
The raw log is never copied. The run folder is committed when the project tracks `.kodel/runs` (this repository ignores
it, and `kodel init` does not write `.gitignore`); a project that tracks it should ignore `.kodel/runs/*/agent_log`.
With `storage: home` the run folder is not in the repository at all.
**Projects that upgrade start storing full sessions.** The decisions behind it were taken in TASK-52A8 and built in
TASK-3BK2.

```yaml
history:
  agent_log:
    enabled: true        # false stores nothing
    mode: full           # metadata: types, times, models, usage, tool names and sizes, and no text at all
    preview_chars: 4000  # one number for every kind, or per kind: { user, agent, tool_input, tool_result }; 0 leaves a kind out
    max_kb: 20480        # the events of one run, split per step
    interval_s: 10       # seconds between copies while the run goes; 0: only at the end of a step
```

| kind | key in `preview_chars` | default cap (characters) | measured p90 / p95 / p99 |
| --- | --- | --- | --- |
| message from the person | `user` | 4 000 | 6 224 / 11 049 / 18 037 |
| message from the agent | `agent` | 4 000 | 1 550 / 2 438 / 4 390 |
| tool input | `tool_input` | 4 000 | 2 011 / 4 108 / 10 822 |
| tool result | `tool_result` | 8 000 | 4 864 / 7 789 / 19 430 |

The subagent description and `system.detail` keep 500, and line breaks are kept. The percentiles come from 647 session
files; with these caps a median session is about 163 KB of events (38 KB gzipped), a p90 session 2.4 MB, the largest
12.9 MB. In `metadata` mode the session event keeps no `cwd` or branch either.

**Which session.** A session belongs to the run when its own log has a call of `pipeline_start`, `pipeline_next_step` or
`pipeline_complete_step` (matched by the end of the tool name, whatever the server is called) whose input or result
holds the run's id. The candidates are the session in the environment of the server (`CLAUDE_CODE_SESSION_ID`) and the
newest sessions of the hook index (`.kodel/sessions.jsonl`); neither is believed without the run id in its log, which is
found whatever the mode. The window starts at the first such call: the person's request, anything an earlier run did in
the same session, and the text of the same response before the call are outside it (the decision said "from the response
that issued `pipeline_start`"; the call is the first thing a log shows that is surely the run's). A server keeps the
session it had when it started, so after `/clear` the environment names the old session and the new one is found through
the hook index: without the hooks of `kodel init` the new session is not found and the report says `session_unknown`. A
run continued in another session is copied from its first call there. Subagents of a stored session are included, as
`agent-<id>.jsonl` with `parent_session_id`, when they began after the run's first call.

**When.** Every `interval_s` seconds while the run goes (by the process that serves it, only through the MCP server) and
at the end of each step, before the step is judged, so the last step of a run is copied before the run ends. Only whole
responses: the response still being written waits. Nothing is journaled or appended to a run that has ended. A run that
ends in the middle of a step (cancelled, a check failed) loses at most one interval and the open response, and the report
says it ended in the middle of a step. The agent may buffer its writes, so a copy is at most one interval behind *what the
agent has flushed*. A copy never fails or refuses a step; if one cannot be made the report says why, once. After a server
restart the first copy reads the log from the start, for up to 30 seconds a pass, and a very large session catches up over
several copies. A pass that fails after it has read leaves nothing to resume from: the next one starts from the journal, so
what the failed pass read is stored by it.

**What is written.** `agent_log/<session>.jsonl` holds the events, one JSON line each, in the event format above (`v: 1`).
The journal has one `agent_log_saved` per copy: `why` (`tick` or `step`), `session`, `parent?`, `node`, `attempt`,
`first_seq`, `last_seq`, `stream_from`, `stream_to`, `tail_hash`, `last_key`, `entries` and `cut?`; and `agent_log_failed`
with a reason, once per reason: `session_unknown`, `log_missing`, `refused`, `log_changed`, `stored_copy_changed`,
`tick_cap`, `unreadable`. The journal is what the files are measured against: a stream is vouched for up to `stream_to`
bytes. Bytes after it are a copy that never reached the journal; they are not read and the next copy cuts them off (this
drops only bytes nothing vouched for, so no history is rewritten). A stream that is shorter than the journal says, or whose
end is not the end the journal vouches for, is not extended: the report says `stored_copy_changed`. A log that is shorter
than before, or whose events are not the ones stored, stops the copy of that session (`log_changed`). Ids that redaction
would change are replaced by a stable `id-` and a hash, in the call and its result alike, so they still pair.

**Size.** `max_kb` (default 20480, bytes after redaction and cut) limits the events of one run. It is split by position: a
visit of a step may use the part of the bound up to its node in the pipeline the run started with, less what the other
visits used, so nodes that never copy (gates, commands) pass their share on; all the copies of one visit share one
allowance, so the timer cannot spend the share of the next step; a step that comes again is a visit of its own and may use
the share of its node again, and a node a change added may use what is left. When a share is full, whole events are
dropped, one `system` event with `subtype: "agent_log_cut"` counts them (when there is room for it), and the report counts
the events left out. At most 4000 copies from the timer and 1000 from the ends of steps are journaled per run.

**Switches.** `agent_log` is the privacy switch of this data. `usage` and `tool_calls` read the log themselves;
`tool_log` stays the switch of the hooks, and with `tool_log: false` the agent log stores no `tool_call`, `tool_result` or
`subagent` event and no subagent file. A kind is silenced with `preview_chars: 0`, not with `prompts` or `output`. The keys
are frozen at the start: they are journaled in `run_started.history`, and an edit of the config during a run changes
nothing for that run. A run without them reads as "not captured"; the report says `not_captured` or `disabled`.

**Display data.** `agent_log/` is outside the seal and shown as `unverified`: a changed file does not break the seal, and
`kodel report` counts from the journal and never opens the files. A stream that cannot be read says what is wrong with it
(`format`: written in a format this engine does not know, upgrade; `damaged`), never "modified". It is information only:
usage and cost never feed a check, a route or a gate.

**Residual risk.** `redact` catches known patterns and 32+ character mixed high-entropy words. It does not catch hex-only
or short secrets, a secret split across two events is redacted per event, and `history.changes.exclude` does not apply to
the agent log. A tool that reads an `.env` puts up to 8 000 characters of it into the log; in a tracked history that is
permanent. The built-in rules are the ones that apply; a host that is given rules of its own reads them when it starts, so a
rule removed during a run keeps what earlier copies redacted. While a run waits at a gate, everything else the same session does is in `full` mode, and the
timer keeps copying it. An agent that starts its own `kodel mcp` with a chosen `CLAUDE_CODE_SESSION_ID` and the run's id can
have another session of the project copied into the run. Lower the exposure with `preview_chars: 0` for a kind,
`mode: metadata` or `enabled: false`.

**Format.** Under `v: 1` before the first release: `text_preview` is optional (it was always there), and `agent_log_cut` is a
`system` event. At the first release the sample run in `fixtures/agent-log/` is moved under the frozen formats (or its hash
is pinned), and from then on a change of the event shape needs a reader of the previous format.

## Usage and cost (`usage_recorded`)

Each run records what its agent used: tokens per model (`input`, `output`, `cache_read`, `cache_write` with its 1-hour part,
`api_calls`) and an **estimated** cost, per attempt of an agent node and for the run. It is built in TASK-9JRS on the
collectors above, and it is information only: usage and cost never feed a check, a route or a gate.

```yaml
history:
  usage:
    enabled: true   # false writes nothing and does not read the agent's log
    prices:         # optional; per model, replaces the shipped price of that model whole
      claude-example-model: { input: 1.5, output: 7.5, cache_read: 0.15, cache_write: 1.875, cache_write_1h: 3 }  # an example, not a price: USD per million tokens
```

**It has its own switch.** `agent_log: false` does not stop the transcript being read; only `usage: false` does. Usage stores
numbers and model ids and no text. The keys are frozen at the start of the run (`run_started.history.usage`), so an edit of
the config during a run changes nothing for it; a run without them reads as `not_captured`.

**When and what.** One pass at the end of each agent step, before the step is judged, under the same lock as the copy of the
agent's log (the copy first, then usage); the timer never counts usage. The pass reads the log of the sessions that belong to
the run (found as for the agent log, see "The agent log"), and the logs of their subagents whatever `tool_log` says, and journals
a `usage_recorded` delta: `session`, `node`, `attempt`, the delta (tokens, costs and flags per model) and the cursor (`last_seq`,
`last_key`, and the response that was still open). A delta is only added to; nothing is rewritten, and nothing is written to a
run that has ended. The worst time a pass adds before a step is judged is the wait for the lock (5 s), the copy's budget (30 s),
usage's own budget (10 s) and the wait for the step's own call in the log (2 s, below).

**The wait for the step's call.** The pass runs inside the agent's `pipeline_complete_step` call, and the agent writes its log a
little behind its work. Without a wait the response that makes this very call could be missing from the log when the pass reads
it: it was then counted in the next step, and after the last step not at all (seen once on a real `claude -p` run, where the
window's total was 34% short; a run before it had agreed to 0.5%). So a pass at a step end first waits, up to
`STEP_END_LOG_WAIT_MS` (2 s, once per pass whatever the number of sessions, counted in the pass's own time), until the tail of
the log of a session that proved the run holds the call that hands in this node and attempt with the run's id (the tail only is
read, every 100 ms; the whole log never is). It ends the moment the call is there. If it never is, the pass goes on with what the
log has, as before, and says nothing: it is not a failure. The timer's pass never waits, and nothing waits when usage is off,
when the run is over or when no session proved the run.

**Which attempt.** What a pass reads is credited to the attempt that pass completes, so the windows of attempts are contiguous
from the run's first call (the response that calls `pipeline_next_step` is written before the step is served and is in its step).
What falls inside a wait for a person (from a gate being reached to its decision, or a pause to its resume, by the journal's
times) while no agent step is open is outside every step and is recorded as `unattributed`. The agent talking with the person
while the run waits at a gate is therefore not charged to a node. In a fork each branch has its own window (kept per node: two
branches paused at once are two windows, each closed by its own resume), and a window counts only for the time no agent step of
any branch is open (from the step being entered to its hand-in): while one branch waits at a gate and an agent step of another
branch is worked, the session's use goes to that step. Polling through command and check nodes is charged to the next agent node. Use after the last
pass (the agent's final turn after the last `pipeline_complete_step`, a wait at the end) is not recorded: the run's total is a
lower bound. A hand-in the engine refused after the pass, and then repeated, simply adds another delta to the same attempt.

**The cursor.** `seq` of the events is the same for the same log, and the state keeps, per session, the last `seq` credited.
After a server restart the log is read again from the run's start (within the pass's budget) and what was credited is skipped; a
pass that runs out of time credits only what it read and marks the record `incomplete`, and the next pass goes on (`complete:
false` in the report until the log is read to its end). A log that is shorter than before, or whose event at the cursor is not
the one that was credited, stops the count for that session (`unreadable`). Only closed responses are read from the log. The
response the agent is writing at the end of a step (the one that calls `pipeline_complete_step`) is counted as it stands from a
copy of the reader's state, marked `last_open` (its output may be low), and when it is whole the next pass adds only the rest.
It is only counted if it is in the log when the pass reads: see "The wait for the step's call" for how the pass waits for it.

**Cost.** A table of prices in code (`pipeline-core/src/price-table.json`): `format`, `revision` (a date), per model a list of
dated entries with the prices of input, output, cache read, cache write and the 1-hour cache write (`cache_write_1h`, default
twice the input price), `effectiveFrom`, `sourceUrl`, `checkedAt`. The entry is chosen by the time of the usage event; a model
that is not in the table (a Bedrock or Vertex id, an alias) has no price, and a total over it is `partial`, never `$0`. An entry in
`history.usage.prices` replaces the shipped entry of that model whole (it keeps the shipped `long_context_tokens` of the model unless it
gives its own), and the report says the cost was priced from the config. A redaction rule of the project that matches a model id
rewrites the id before it is priced, so that model has no price and the total is `partial`: such a rule removes the cost.
Long context (more than 200 000 prompt tokens in one request, or the model's own `long_context_tokens` when the table gives one,
priced higher by some models) is not modelled: such calls are
counted in `long_context` and flagged, and the cost may be low. A cost is computed when the usage is read, stored in the delta
with the table's `revision`, and never recomputed with a later table, so a run that crossed a table update lists both revisions.
**Every cost is an estimate**, not a bill. Claude Code's own `cost-state` entry totals a whole session, is written once when it
ends, is missing from about half of the session files and is always above the event totals: it is not an event, is never in a run
and is never shown as a run's cost.

**What the report shows** (`kodel report`, and the same object with `--json`): per attempt and for the run the tokens per model,
calls and the estimated cost with the table revisions, and the flags `complete`, `partial`, `unattributed`, `last_open`,
`long_context`, `incomplete`, `includes subagents`; or `not_collected` with a reason: `not_captured` (the run did not ask for it),
`disabled`, `session_unknown`, `log_missing`, `refused`, `unreadable`, `busy` (the lock was taken by another pass; said once, and
nothing is lost because the cursor did not move; also said when the lock was lost before the pass could run: nothing was read; a copy that fails does not stop the pass, which runs after it under the same lock and tells its own failures itself), `agent_unsupported` (the
run's agent has no collector), and, next to a report that has numbers, `cap` (the run journaled as many records as it may) and
`record_refused` (the run's account refused a record, so the pass stopped; said once). A subagent log with no time on any entry cannot be
told from one that began before the run: it is not guessed at and reads `unreadable`. A record written in a
format this engine does not know reads `cannot read (format X)`, never "modified".

**Limits.** At most 16 models per record and 64 per run (the rest are `other`), 1000 `usage_recorded` events and 2000 attempts per
run (past 2000 attempts the rest is counted in the run's `unattributed`; past 1000 events nothing more is counted and the report
says `cap`). A model id that does not look like an id is counted as `other`; a session id that does not (it is at most 128 characters, like the run's own ids) is not looked at, so its use is
not counted: the state is not redacted and holds numbers and safe ids only. The set that tells a response read from two logs apart holds 200 000 keys; beyond it a repeat may be counted twice and the
record says so. Journal times are those of the machine that serves the run and log times those of the agent: a run served on
another machine than the agent's (a devcontainer) may be windowed wrongly.

**Format.** The usage records exist only in run-state format 2 (forks, T-40): the optional `cache_write_1h` on the `usage`
event (only a read made for usage carries it, so the events the other readers get and the golden fixtures are unchanged), the
events `usage_recorded` and `usage_failed`, `state.usage` and `run_started.history.usage`. A run that has them is a format-2
run (a format-1 run does not get them, it keeps its format: `docs/run-formats.md`), and the beta (format 1) may not read it; a
usage delta also carries its own `v` (`USAGE_RECORD_FORMAT`). Every shipped price row carries `checkedAt: 2026-10-28`: that day all fourteen rows
were compared with the live price page (the page of `https://docs.claude.com/en/docs/about-claude/pricing`, which redirects to
`platform.claude.com`) and they match. How they were compared differs by row: the eleven rows that had first been taken from the
model table of the `claude-api` skill (cached 2026-10-06) were also read column by hand (that table's Sonnet 5.5 cache read price
was wrong, 0.20 against the 0.10 of the page; found from Claude Code's own `/usage`); the three 4.5 rows were verified by the set
comparison of the script only. The copy of the page used was fetched with `curl` on 2026-10-28 and is **not committed**, so the
repository's fixture page (`fixtures/price-pages/`) stays hand-made and the repository itself cannot show that the live page
parses. `scripts/check-prices.mjs` is the check, and `skills/kodel-prices/` is how a maintainer runs it again. The check compares
the SET of dollar amounts that follow a model's name and cannot tell the columns apart; it looks at every place that names the
model, and reports a page whose places disagree on one price of a row (a stale mention that still quotes the old set does not hide
a changed row), but a change of several prices at once while an old mention remains is not caught. A request
over a model's own `long_context_tokens` (200 000 unless the table says otherwise, 100 000 for `claude-haiku-5-5`) is flagged, and
the higher price of such requests is not modelled.

## Tool calls (`tool_calls_recorded`)

Each run records what its agent called: every tool call and every tool result, per attempt of an agent node, with the name,
the time it started, how long it took, whether it ended in an error, the size of its input and of its result, the MCP server
and whether a subagent made it. It is built in TASK-ZKRH on the collectors above, and it is information only: the rows are
what the agent's **own log** says (the agent can edit it), so the report says `unverified`, and nothing here feeds a check, a
route or a gate. Claude Code only; any other client reads `not_collected: agent_unsupported`.

```yaml
history:
  tool_calls:
    enabled: true       # false writes nothing and does not read the agent's log
    preview_chars: 200  # the cut of the preview of a call's input; 0 stores none; at most 2000
```

**It has its own switch.** `agent_log: false` and `usage: false` do not stop it; only `tool_calls: false` does. `history.tool_log`
is the switch of the hooks (TASK-R7AF) and has no effect here. The keys are frozen at the start of the run
(`run_started.history.tool_calls`); a run without them reads `not_captured`. An engine that does not know the key refuses the
whole project config, because `history` is strict: a team on mixed versions of kodel has to upgrade together.

**What is stored.** A pass runs at the end of each agent step, after the copy of the agent's log and the count of usage and
under the same lock, before the step is judged. It reads only what is new in the log and journals it as rows in
`tool_calls_recorded`: a row for a call (`k: c`: the id, the tool, the server, `own` for a tool of the engine itself, the start,
`in_bytes`, the preview, `subagent`, and the attempt it belongs to) and a row for its result (`k: r`: the end, `ms`, `ok`, `err`,
`out_bytes`). The pass pairs nothing: the reader of the log releases a call and its result at different moments, so each is
recorded when it comes and `kodel report` joins them by id. A call with no result row is `open`. The ids are hashed from the
session and the id in the log. Calls of a subagent come from its own log file and are marked with its id. `err` is one of
`error`, `denied`, `interrupted` and `hook_blocked`, matched on the start of the text of an error result; anything else is
`error`. `report --json` has every row (up to 200 per attempt; the rest is counted as `omitted`), and `kodel report` has the
counts per tool, the failed and open ones and the three longest.

**Previews are in the journal.** A preview of a call's input (a command, a path, the content of a write) is stored only when the
agent's own conversation log is kept as `full` text (`history.agent_log`), and never more than `preview_chars`. It is redacted
first and cut after, and the store redacts it again, but `redact` does not catch every secret (see "The agent log"). The journal
is sealed and is committed when the project tracks `.kodel/runs`, and a project that ignores only `.kodel/runs/*/agent_log`
commits the previews too: set `preview_chars: 0` there. With `agent_log` off or in `metadata` mode no preview is stored; the sizes
and the names are.

**Which attempt.** A call belongs to the step of the first hand-in (`agent_completed`) at or after the time it started, and to
the step being handed in now when no hand-in follows: usage's rule, placed by time and not by the pass that read it. So the
hand-in call of a step, which the reader releases only when the next response starts, is read by the pass of the next step and is
still put with the step it ended. A call made while the run waits at a gate or a pause and no agent step is open, before the
run's first call, or in the future, is `unattributed`. In a fork several agent steps are open at once in one session and the log
cannot tell the branches apart: a call that started while more than one was open is credited to the step handed in first and
marked `shared`: also in a fork whose steps the agent works one by one, where every branch is open from the start of the fork and the place is in fact exact. A step that was never handed in (superseded, canceled) takes no calls: they go to the next hand-in. While a
pipeline change waits for a person the agent may keep working in the step's phase; those calls are charged to the step, as the
tokens of usage are. A pass that gets `busy` (in a fork a second hand-in waits for the lock only a few seconds) loses nothing:
the next pass reads everything since its cursor and places each call by its own start. Tokens and calls can differ in one
attempt after a retry or in a fork, because usage credits what a pass reads to the step handed in.

**What is never recorded.** The reader releases a response only when the next one starts, and a pass writes nothing to a run that
has ended. So these are not in the record: the final response of the last agent step (with its hand-in call), of a session that
ended between steps (a new chat after a gate, `/clear`, a restart), of each subagent's log, and of a step whose last pass was
skipped. A line of the log over 8 MB is dropped by the line reader, and a call or result on it is not recorded (the record counts
`skipped` lines, not the calls; a line that is not JSON is counted too, and a read again from the start (after a restart, a held pass, a log found changed or a memo that was let go) counts the same lines again, and a pass with no new rows does not write a record for them alone); an input over 256 KB of JSON has no preview and keeps only its size. The report says what is missing. A call that was still running when its step ended (a background tool), or whose result is not in the log, stays `open` (an interrupted call has an error result: it is failed, `err: interrupted`); the result that comes later is recorded and joins it. A Claude Code session forked with
`--fork-session` copies the history with the same ids and is recorded again, as in usage. The result of an own call says nothing
of whether its step passed: the engine answers a failed check as a normal result. A tool of another MCP server, or of the agent, whose
bare name is one of the engine's is marked `own` too (the row shows the server). Durations are wall time from the log: calls made in
one message start and end together, so each reads as long as the slowest. `out_bytes` (the size of a result) counts text blocks only.

**Bounded.** At most 200 rows in a record and 1 000 records in a run; the rows of a run are budgeted at about 768 KB (counted
before the store redacts, so approximately), and past it a record carries counts only, so
a loop stays visible while durations and failures are unknown (`rows_cut`). In every record, rows or not, the counts hold at most 32 tool names and the rest is under `other` (the rows keep the real name). The state holds a cursor per session and numbers,
never text or names. The journal is read whole by every pass, `status`, `report`, `completeStep` and every poll of `kodel wait`:
this adds about 1 MB of rows and, at worst, the counts of up to 1 000 records (a few MB) to a journal that is about 150 KB without it. Time before a step is judged: today the lock wait (5 s),
the copy (30 s), the wait for the step's call (2 s) and the count of usage (10 s) can take 47 s; this pass is chained after them
with a budget of 5 s of its own (52 s together). It does not wait for the step's call in the log, never fails a step, and has no
timer: nothing is recorded between step ends. Where a run begins in a log is searched once for the usage count and this pass
together. A stream found changed under its cursor (a log that was rewritten or truncated) is not read again in that process (after a restart it is read and refused again), and a cursor it left behind keeps the report at `complete: false` for the rest of the run. A pass that stops for time records what it read and marks the log as not read to its end (`complete: false`); the next
pass reads on. So does a pass that meets a call that began after the pass did (by at most a minute: a worker goes on writing its
own log while another worker's step is handed in): rows are never rewritten, so such a call is left for the next pass, which
places it by its own start; a call further in the future than that (a clock that is wrong, or a log that is not true) is recorded
as `unattributed`. Once the rows of a run pass their budget no rows come back, however small a later record is. A call that the
main log and a subagent's own file both hold is recorded once in a pass (not across passes: read in two passes it is two rows under two sessions). A subagent's log whose first entry has no time yet (a file just created) is said `unreadable`, once for the run, as in usage. An attempt past the 64 a record can
count is counted with the unattributed calls, and its rows say so.

**Format.** The records exist in run-state format 2 and format 1 alike (the codec of format 1 keeps `toolCalls` and the events
as it keeps `usage`): `tool_calls_recorded` and `tool_calls_failed` in the journal, `toolCalls` in the state,
`run_started.history.tool_calls`, and, only for a read made for this pass, `input_bytes` on a `tool_call` event and `error_type` on
a `tool_result` event (never written into the stored copy of the agent's log, so the events the other readers get and the
golden fixtures are unchanged). The payload carries its own `v` (`calls.v`); a record of a format this engine does not know, or a
reason it does not know, reads as "cannot read (written in format X)", never as "modified" and never as "no calls". A field added
to a record later bumps `calls.v`. An engine from before this change that goes on with a run of format 2 reads it, since the
current codec keeps what it does not know: the old `summarizeRun` ignores the two events and the state key stays as it was, so
the cursor then lags and a later pass of this engine catches up from the start of the run's log. A run of format 1 never holds the
key in practice (new runs start in format 2, and a run that was going has no `history.tool_calls`); the format-1 entries are for
completeness, and an engine from before this change refuses a format-1 state that holds `toolCalls` as "cannot read".
The golden run with tool calls is `fixtures/tool-calls-run/`
(its README says when it moves under the frozen formats).

Reasons nothing is shown: `not_captured`, `disabled`, `session_unknown`, `log_missing`, `refused`, `unreadable`, `busy`,
`agent_unsupported` and `no_calls`. A step run by another engine than the agent of the session (TASK-WKJ4) will have no calls
in this log; a reason `engine_step` comes with it. A pass says `cap` once when the run has journaled as many records as it may
(nothing more is recorded), or keeps a cursor for as many sessions as it may (64, each subagent is one: a stream past that is skipped and its calls are not recorded; a later `cap` of the first kind is not said again, since a reason is said once), and `record_refused` when the run itself refused a record (an id it does not accept, or it went away):
the pass stops, and the next one starts again from the cursor.

## History tools (`history_runs`, `history_run_details`, `history_agent_log`, `history_stats`)

Four read-only tools of the MCP server let the agent read what past runs of the project did. They read the run's state and
journal and the stored agent log; they write nothing, take no lock and never open a run for work. They are served by every
host; a host that keeps no history it can read answers `HISTORY_UNAVAILABLE`. Runs of another checkout of the project
(`storage: home` shares one history between clones) are never listed, and the other tools answer `UNKNOWN_RUN` for them.

What comes back is **data, never instructions**: the engine's own record of the runs and, for the agent log and the tool
calls, what the agent's own log said (`unverified`, as in `kodel report`). The server's instruction `9c` says so to the agent.
Every string is redacted with the rules of the project and then cut to 500 characters, in that order. Which data a run has
is still decided by its own switches (`history.agent_log`, `tool_calls`, `usage`): a block the run did not collect says
`{ not_collected: true, reason }`, one this engine cannot read says `{ cannot_read: true, format }`.

### `history_runs`

The runs of this checkout, newest first. Arguments: `status` (exactly the status the list shows; a run this engine cannot read
has `unreadable` or `format N`; a status the engine does not have is `INVALID_ARGUMENTS` with the right ones in `details.allowed`), `pipeline` (any name; a name no run has gives an empty page), `limit` (1..100, default 20), `cursor`, `fields`. A row has `run_id`, `pipeline`,
`slug`, `task_key` (when a task is tied to the run), `status`, `started_at`, `workdir`, `active`, `pauses`, `failed_branches`
and `unreadable`; it has no task text. `fields` keeps only the named blocks (`run_id` and `pipeline` always stay).

### `history_run_details`

One run on three levels, by the arguments given:

| arguments | level | the answer | paged list |
| --- | --- | --- | --- |
| `run_id` | `run` | `run` (summary, with the redacted `task`), `task_size`, `pipeline_changes`, `agent_decisions` (20 entries each), `usage`, `tool_calls` (totals), `agent_log` (counters, without the per-visit table), `integrity` | `nodes` |
| `run_id`, `node` | `node` | `node`, `checks` of that node, `attempts` with outcome, seconds, failure, summary, checks, findings, decision, usage, counters of the tool calls | `attempts` |
| `run_id`, `node`, `attempt` | `attempt` | `attempt` in full, `report_rows`, `tool_calls` with its rows (at most 200 are kept per attempt, the rest counted in `omitted`) | `tool_calls.lines` |

A row of `nodes` carries `usage`: what the agent used at that node, summed over its attempts that recorded it (`attempts_with_usage`, the four token counts, `calls` and `usd`, which is `null` when no attempt has a price); a node the agent did not work at has none. The `usage` block of the run adds `unattributed`, what was used outside every step (a wait at a gate, a pause). `task_size` is the size of the task measured on the run's patch, as `kodel report` shows it (`files`, `added`, `removed`, `binary_files`, ten `top_dirs` and `languages` each); a run that kept no patch says `not_collected`. `report_rows` holds what the attempt stored as its report: the findings a step reported (severity, location, description) or the comments a person made at a gate, at most 50 rows with the rest counted in `omitted`; an attempt that stored none has no such block.

`integrity` says whether the state file is what kodel last wrote (`files`: `ok`, `modified`, `unknown`), whether a finished
run is as it was sealed (`seal`), as `kodel report` shows them, and whether the pipeline copy kept with the run is the one the
state pins by its hash (`pipeline_copy`: `ok`, `modified`, `missing`): the run files are in the repository and can be edited. The
report is built from the state and the journal, so a run kept before pipelines were versioned, or one whose kept pipeline copy
was edited, is read all the same. `attempt` without `node` is `INVALID_ARGUMENTS`; an unknown `node` is `UNKNOWN_NODE` (its
`details.nodes` lists the nodes) and an attempt the node does not have is `INVALID_ARGUMENTS` (`details.attempts`).
`limit` is 1..200 (default 50 nodes, 10 attempts, 50 tool-call rows). `fields` names the blocks of the level, see above.
A run in a format this engine does not read is `UNSUPPORTED_FORMAT` with its `format`; a state that does not fit its format is
refused with the code it was read with, never as "modified".

### `history_stats`

How a pipeline fared over its newest runs, counted on the server so that an agent does not have to read the runs one by one
(the same figures `kodel` shows in its statistics, `scope: all`). Arguments: `pipeline` (needed), `limit` (the newest runs to
read, 1..200, default 50) and `fields` (any of `runs`, `attempts`, `seconds`, `nodes`, `versions`; `versions`, the history of
a node's changed definitions, is left out unless named). The answer says in `runs` how many runs were `considered`, `read` and
`skipped` (a run that cannot be read is skipped, not an error), and per node: `runs`, `attempts`, `per_run` (above 1 is rework),
`failed`, `outcomes`, `failures` (where it came from and the words, most frequent first, ten at most), the `seconds` (mean,
median, p90, max), the `findings` by severity, at a gate what people `decisions` and why (the last five reasons), and the
`usage` of the node in tokens and dollars. The patch of a run is not read, so there is no `task_size` here. Nothing is paged:
the answer is at most 64 KB, and nodes that do not fit are left out from the end with `nodes_omitted`. The data is as
`unverified` as that of `history_run_details`.

### `history_agent_log`

The events of one attempt from the stored agent log. Arguments: `run_id`, `node`, `attempt` (all needed), `kind` (any of
`session`, `message`, `usage`, `tool_call`, `tool_result`, `subagent`, `system`), `tool` (the calls of that tool and their
results), `include_messages` (default false), `limit` (1..200, default 50), `cursor`, `fields` (any key of an event;
`session_id`, `seq` and `kind` always stay). The answer is `unverified`. Conversation text is the largest and the least
trusted part, so `message` events are left out unless `include_messages: true`; `skipped.message` counts what was left out in the
whole attempt, and `kind: ["message"]` without the flag is `INVALID_ARGUMENTS`.

Which attempt an event belongs to is told by its time against the attempts of the journal (the same placement the tool calls
use), not by the copy pass that stored it: a pass is booked to the first open step, so in a fork it holds other steps' events
(`attribution: "time"`). When more than one agent step was open at the time of an event (a fork), the log cannot tell
the branches apart, and the answer says `attribution: "approximate"`: events of a sibling may be missing or may be shown. A stream is read only to the length the journal vouches for (`agent_log_saved.stream_to`); bytes
past it are never shown. A stream that is missing, damaged or written by a newer kodel gives `partial: true` and `problems`
(`missing`, `damaged`, `format`) with the events read before the problem; a run that did not store the agent log says
`not_collected` with `not_captured` or `disabled`. Events come session after session, each in order of `seq`.

### Paging and size

Every list is a page: `page` says `list` (`runs`, `nodes`, `attempts`, `tool_calls.lines` or `events`), `returned`, `total` and,
when there is more, `next`. Pass `next` as `cursor` and leave the other arguments as they were (`limit` and `fields` may change).
The cursor holds only a digest of the key of the last item (so a slug or an id that holds a secret never reaches the agent through
it), and what is added between two calls cannot repeat or hide an item: a run started
meanwhile goes to the top of the list and the next page continues where the last one ended. It is bound to the tool, the
run, the level, the node, the attempt, the filters (`status`, `pipeline`, `kind`, `tool`, `include_messages`) and the format of the
run's state; any other call, a damaged cursor, one naming an item that is gone or a run that `kodel migrate` changed in between
is `INVALID_CURSOR`, and the walk starts again without it. `total` is the count at the time of the call and may change between pages.
The blocks of the first page (the run summary, the node head) are not repeated on later pages.

An answer is at most 64 KB of JSON. A page is cut to fit and always holds at least one item: an item that alone is over the cap
is shrunk (texts to 100 characters, lists to 5 entries, `truncated: true`) instead of being answered with an empty page. The
blocks that are not lists are bounded too: 20 entries of `pipeline_changes` and of `agent_decisions`, 50 of an attempt's checks
and finding severities, 30 tools in `by_tool`, each with the count left out, and together they may take 24 KB of the answer
(the largest are cut first, `truncated: true`). The keys of an object (a tool name, a severity) are redacted and cut like the values.

### Errors

`INVALID_ARGUMENTS` (a bad argument, an unknown `fields` name with the allowed ones in `details.allowed`, a limit out of range,
`attempt` without `node`, `kind` message without `include_messages`; an argument the tool does not have is refused too),
`INVALID_CURSOR`, `UNKNOWN_RUN`, `UNKNOWN_NODE`, `UNSUPPORTED_FORMAT` and `HISTORY_UNAVAILABLE`. Nothing a person decides is
reachable through these tools. They count as the engine's own tools in the report of tool calls (`own`).

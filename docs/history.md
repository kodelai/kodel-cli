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

## Which sessions are read

Only the sessions of Kodel projects: a directory tree with the Kodel marker (`.kodel/config.yaml`, found as
`findProjectRoot` does), together with its worktrees.

- A collector works only on a root that has the marker: `locate` of a directory without it returns nothing and `read`
  of a ref into it is refused with `HISTORY_PATH_OUTSIDE_PROJECT`, whatever sessions the agent has for that directory.
- With the session index of the hook transport (`.kodel/sessions.jsonl`), when it has lines of the agent, the
  index is the answer and nothing is scanned. It lists only the sessions started since the hooks were connected.
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
| `observed-env` | the environment of the server (`CLAUDE_CODE_SESSION_ID`): the session that was current when the server started. A server lives as long as its agent process, so after `/clear` it still names the old session |
| `observed-hook` | the newest session the hooks registered in `.kodel/sessions.jsonl` for the run's directories; used when the environment has none |
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

## The agent log (`agent_log/`)

Each run keeps the sessions of its agent in `agent_log/` of the run folder, as normalized events with redacted text
previews. It is **on by default and `full`**, with no opt-in (like the other history categories that are on by default).
The raw log is never copied. The run folder is committed when the project tracks `.kodel/runs` (this repository ignores
it, and `kodel init` does not write `.gitignore`); a project that tracks it should ignore `.kodel/runs/*/agent_log`.
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

## Prices (planned)

**Planned defaults, not yet built.** They were decided in TASK-52A8 and are built in TASK-9JRS (cost and prices). Until
that lands, `usage.cost` has no `revision` or `source` and no cost is computed. The plan is `docs/plans/task_52a8.md`.

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

**Constraint.** The format change the prices need (optional `revision`/`source` on `usage.cost`, a `computed` basis, new
keys in `run_started.history`) is allowed under `v: 1` only before the first release, so the release waits for it, or the
version is bumped with a reader of the previous format.

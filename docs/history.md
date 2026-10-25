# Agent history

Coding agents keep a log of their sessions on disk, each in its own format. Kodel reads those logs, for the
sessions of Kodel projects only, into one **universal event format**. The cost, tool-call and agent-history
features are built on it, and none of them knows which agent wrote the log.

What reads a log is a **collector**, one per agent. Adding an agent means adding a collector and nothing else.

- The event types and the collector interface are in `@kodel-ai/pipeline-core` (`agent-history.ts`, pure).
- The collectors, which read files, are in `@kodel-ai/local` (`@kodel-ai/local/history`). The first is Claude Code.
- The conformance suite every collector must pass is `agentHistoryContract` in `@kodel-ai/testkit`.

Only the normalized events are meant to be kept, never the raw log. Every text in an event is a preview of at
most 500 characters, and every string goes through `redact` before it leaves the collector.

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
- **Text is redacted, then cut.** A preview is redacted before it is cut to 500 characters, so a secret that
  straddles the cut cannot survive as a prefix.
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
| `observed-env` | the environment of the server (`CLAUDE_CODE_SESSION_ID`); exact, since the agent starts a server per session |
| `observed-hook` | the newest session the hooks registered in `.kodel/sessions.jsonl` for the run's directories; used when the environment has none |
| `derived` | read out of the session's own log (the model of its last answer) |

Strings from outside are stripped of control characters and cut at 200 characters, and the store redacts them like
everything else it writes. `contract_version`, `instructions_hash` and `tools_hash` are there when the host knows what
the agent was served; they change when the instructions or a tool (its name,
description or arguments) change. With `history.executor: false` none of these fields is written.

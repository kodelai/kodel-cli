# Plan: agent history collectors (TASK-VH9G)

## Goal

One way to read the history that coding agents keep on disk, whatever the agent, into one universal event
format, looking only at sessions of Kodel projects. This change builds the foundation (order 2 of 23; 19, 20
and 21 build on it) and the first collector, Claude Code. Codex and OpenCode follow as separate tasks and must
need only a new collector.

Done when: the Claude Code collector turns a real session into valid `HistoryEvent`s, folds duplicates, finds
subagent logs, ignores other projects, and passes the contract suite; the format and the interface are
documented.

## Findings from the code and from real logs

- TASK-5NBV is merged (`31fb9aa`): `.kodel/sessions.jsonl` is written by `sessionRegistrar`
  (`packages/local/src/hooks/session-registrar.ts`) with `{session_id, agent, transcript_path?, cwd, ts}`; a
  reader takes the last line per `session_id`. The file is gitignored.
- `findProjectRoot(cwd)` exists in `packages/local/src/hooks/project.ts` (marker `.kodel/config.yaml`, worktrees
  under `.kodel/worktrees/` belong to the outer project). It is reused as is, not copied.
- Task adapter pattern to follow: contract types in `pipeline-core/src/tasks.ts`, implementation in
  `packages/local`, conformance suite as plain `{name, run}` cases in `packages/testkit/src/task-adapter-contract.ts`.
- Real Claude Code logs (`~/.claude/projects/<mangled-cwd>/<session>.jsonl`, version 2.1.x) were inspected.
  A line is one JSON object with `type`: `user`, `assistant`, `system`, `attachment`, plus many bookkeeping
  types (`api-request`, `api-request-blob`, `file-history-*`, `cost-state`, `mode`, `ai-title`, ...). `user`,
  `assistant`, `system` and `attachment` carry `sessionId`, `cwd`, `timestamp`, `version`, `isSidechain`, `uuid`,
  `parentUuid`. `assistant` carries `requestId`, `message.id`, `message.model`, `message.usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
  `output_tokens_details.thinking_tokens`). Subagent logs live in `<session>/subagents/agent-<id>.jsonl`.
- Only the fields above are relied on; the rest is skipped by a stated rule (see below).

## Design

### pipeline-core (pure; no fs, process, clock)

New `packages/pipeline-core/src/history.ts`, exported from `index.ts` (file name must not clash with the existing
`history.ts`; if it does, use `agent-history.ts`):

- `HISTORY_FORMAT = 1`; `HistoryEvent` as a discriminated union on `kind` with the envelope
  `{v, agent, agent_version, session_id, parent_session_id?, seq, ts, kind}` and the kinds `session`, `message`,
  `usage`, `tool_call`, `tool_result`, `subagent`, `system`, with the payload fields from the task text
  (`usage.semantics: additive | overlap`, `cost.basis: reported | reported_zero | computed | unknown`, previews capped).
- zod schema `historyEventSchema` (zod v3) used by the contract suite and by readers of stored events;
  `ts` is UTC milliseconds ISO string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- Interface:
  `AgentHistoryCollector { agent: string; locate(projectRoot, opts): Promise<SessionRef[]>; read(ref, window?, opts): AsyncIterable<HistoryEvent> }`,
  `SessionRef {agent, session_id, path, cwd?, parent_session_id?}`, `HistoryWindow {from?, to?, seq_from?}`,
  `HistoryCollectorRegistry` by agent id (register, get, ids), same style as the existing registries.
- Pure helpers shared by collectors: `redactEvent` (every preview goes through `redact`, principle 3),
  `previewOf(text, cap)`, `foldUsage` (dedupe by `message_id` + `request_id`).
- New error codes in `errors.ts` (stable strings): `HISTORY_PATH_OUTSIDE_PROJECT`, `HISTORY_SESSION_UNREADABLE` (upper case, like every code).

### Agent versions in the interface (added at the plan gate)

The log format of an agent changes between its versions, so version handling is part of the collector
interface, not a patch inside one normalizer. (Checked against `camtrik/agent-trail`: it only records the
agent version as `sourceVersion`, keeps a parser version string as a cache key to force a re-read, validates
DB table names for OpenCode/Qoder, and handles shape differences inline with comments such as "some Codex
versions emit this". It has no version ranges, so this design is ours.)

- `FormatProfile { id; versions: VersionRange; normalize(entry, state): HistoryEvent[]; locate? }`. A collector
  declares `profiles: FormatProfile[]`, ordered, with ranges that do not overlap, for example Claude Code
  `<2.0.0` -> `cc-legacy`, `>=2.0.0` -> `cc-2`. A new format of the agent is a new profile plus its fixture,
  nothing else changes.
- `VersionRange` and `compareVersions` are pure helpers in pipeline-core (`x.y.z` with optional prerelease,
  comparators `<`, `<=`, `>=`, `>`, joined by space; no new dependency). `selectProfile(profiles, version)` returns
  `{profile, match: "exact" | "below_known" | "above_known" | "unknown_version"}`.
- Version source per agent: Claude Code has `version` on every entry, so selection is per entry (cached per
  version string); a resumed session can cross a version boundary and each part is read by its own profile.
  Codex (`cli_version` in `session_meta`) and OpenCode (version column) give it once per session. A collector
  states where it reads the version in `versionOf(entry | header)`.
- Outside the known ranges: a version above the newest profile uses the newest profile, below the oldest uses
  the oldest. Never fail and never guess silently: the reader reports `format_drift` in its stats and emits one
  `system` event (`subtype: "format_drift"`, agent version, profile used) per session, so cost/tool tasks can
  show "read with a profile older than this agent". No version at all uses the newest profile, `unknown_version`.
- A profile may additionally probe a shape (feature detection) when the version is not enough, for example a
  usage field that appears only in some builds; the probe lives inside the profile, never in shared code.
- `agent_version` of every event is the version of the entry it came from; the profile `id` is part of
  the reader stats, not of the stored event (the stored format stays small and the profile can be fixed later).
- Contract suite additions: profiles are ordered and non-overlapping (gaps are allowed: `selectProfile` sends a version in a gap to the nearest older profile); every
  profile has at least one fixture; `selectProfile` is correct at both sides of every boundary (`x-1`, `x`);
  an out-of-range version yields drift and not an error; a session with entries of two versions is read by two
  profiles with one monotonic `seq`.
- Canary (real-agent test): the installed agent version must be inside a known range; above the newest
  range the test fails with the message "add a profile and a fixture for <agent> <version>" instead of passing
  on a silently drifted format.

### packages/local

New `packages/local/src/history/`:

- `scope.ts`: `assertInsideProject(root, path)` (realpath both, refuse outside; a symlinked log pointing out is
  refused, one inside is followed once) and `projectSessionDirs(root)`.
- `jsonl.ts`: `streamJsonl(path)`: `createReadStream` + line splitter with a per-line size cap, never loads the file;
  invalid JSON lines skipped and counted; a torn last line is dropped silently; yields `{line, offset}`.
- `claude-code/locate.ts`: sources in order. (1) If `.kodel/sessions.jsonl` has lines of agent
  `claude-code`, use it only (last line per `session_id`), nothing is scanned; an index with no line of this agent
  (hooks of the agent not connected) leaves the scan on — found on this machine, where the index has only OpenCode lines. (2) Otherwise scan the Claude Code project
  folders of the root and of its worktrees (`git worktree list` paths plus `.kodel/worktrees/*`), computing the
  folder name from the cwd with Claude Code's rule (non-alphanumerics to `-`; long names get a hash suffix, with
  the Windows case covered); each candidate file is confirmed by the `cwd` of its first entry that has one
  (header check only: read until the first `cwd`, at most N KB, then close). Folders of other projects are never
  listed beyond the name match. Subagent files `<session>/subagents/agent-*.jsonl` become child refs with
  `parent_session_id`.
- `claude-code/profiles.ts`: the declared `FormatProfile`s (the exact boundary versions are found from real logs of
  old and new Claude Code builds in step 3; if only one shape is found in the logs available, one profile is
  declared and the boundary mechanism is covered by the fake agent and unit tests).
- `claude-code/normalize.ts`: pure function from a raw entry to zero or more events, one per profile. Rules:
  - one `assistant` entry per content block repeats `message.id`/`requestId`: fold to a single `usage` event per
    `(message.id, requestId)`, keeping the last `usage` of the group (usage grows during streaming), with
    `semantics: "additive"` once folded; tool_use blocks each give one `tool_call` (`id`, `name`, `mcp_server`
    parsed from `mcp__<server>__<tool>`, `input_preview`, `started` = entry ts);
  - `user` entry with `tool_result` block pairs by `tool_use_id`: `tool_result {id, ok = !is_error, ended,
    duration_ms = ended - started when the call was seen, size, output_preview}`; a result with no call seen
    (window start, resumed session) is kept with no duration;
  - text blocks give `message` events (role, preview only, never the whole text);
  - `Task`/agent tool calls give `subagent` events linked to the child session id when the child log is found;
  - `system` entries of known subtypes give `system`; unknown `type`s and unknown fields are skipped, and the
    skip is counted in the reader's stats (rule stated in the doc: unknown never throws, never fabricates);
  - entries without a timestamp inherit the previous entry's timestamp and are flagged internally; `seq` is
    assigned by the reader in output order, starting from 1 per session, stable for the same file content.
  - `model` is taken per message; `cost` is `{basis: "unknown"}` unless the log reports it (cost computation is
    left to the cost task 19; the format already has the slot).
- `claude-code/collector.ts`: `claudeCodeCollector: AgentHistoryCollector`, `read` streams the file and applies
  the window (time bounds and `seq_from`) without buffering more than one folding group.
- `registry.ts`: `defaultHistoryRegistry()` with `claude-code`.
- Credentials: the collector opens only `*.jsonl` session files and the Kodel index; it never touches
  `.credentials.json`, `settings*.json` or any other file in the agent folder.
- Export `./history` from `packages/local/package.json` (small subpath, like `./hooks`); `index.ts` re-exports.

### packages/testkit

- `agent-history-contract.ts`: `agentHistoryContract(make)` returning `{name, run}[]` like the task contract.
  Subject: `{collector, project: fixture project root with sessions, expected counts}`. Cases: events validate
  against the schema; `seq` is strictly increasing from 1; `ts` monotonic non-decreasing within a session; a
  second read gives identical events (deterministic); window slicing returns a consistent subset; usage events are
  unique per `message_id`; every `tool_result.id` matches an earlier `tool_call.id` unless windowed; `locate`
  ignores a second project placed next to it; `read` of a path outside the root fails with
  `history_path_outside_project`; a torn last line yields no error; `locate` does not open other projects' files.
- `fake-agent-history.ts`: a small second collector with a deliberately non-Claude log shape (one JSON array file
  per session, millisecond epoch timestamps, usage given as total plus cache fields), to prove the interface is
  not Claude-shaped. It runs the same contract.
- Fixtures: `fixtures/history/claude-code/v2.1/` sanitized samples cut from real sessions (a plain session; a
  session with tool calls and an MCP call; repeated assistant lines; a session with a subagent log; a torn last
  line; a line without timestamp) with the expected normalized JSONL beside each; `fixtures/formats/v1/history/`
  holds the golden normalized events (the history format is its own format and gets its own golden fixtures).

### Docs

- `docs/history.md` (English): the universal format (envelope, kinds, field table, `semantics`, `cost.basis`,
  rules for unknown fields/kinds, preview caps), the collector interface, how to add an agent (what `locate` and
  `read` must do, how to pass the contract suite), scope and safety rules, retention note (Claude Code deletes
  logs after 30 days).

## Steps

1. Types, schema, interface, `FormatProfile`, `VersionRange`, `selectProfile`, registry, error codes in
   pipeline-core (+ unit tests of schema, helpers and version selection at the boundaries).
2. `scope.ts` and `jsonl.ts` with their tests (hardening cases first).
3. Sanitized fixtures from real sessions (strip text, paths and ids; keep shapes, usage and timestamps).
4. Claude Code `normalize.ts`, then `locate.ts`, then `collector.ts`, each with unit tests against the fixtures.
5. Contract suite and fake second agent in testkit; run it for both.
6. Integration tests: two projects side by side, worktree session, index vs scan, subagent files.
7. Docs; gitignore and format fixtures; run `typecheck`, `lint`, `bun test`, build and `check-artifact`.
8. Real-agent test under `tests/agents/` (gated by `KODEL_AGENT_TESTS`): run a short real Claude Code session,
   compare token totals with the agent's own `cost-state`/summary figures within a stated tolerance (2%), plus the
   canary that fails when a new Claude Code version changes the shapes the normalizer relies on.

## Test strategy

Test names carry the task or decision id where there is one (`vh9g_...`).

- unit: normalization of the fixtures; dedupe by `message.id`+`requestId`; result pairing across entries; unknown
  fields/kinds rule; window slicing; schema accepts/rejects.
- contract: `agentHistoryContract` against Claude Code and the fake agent.
- integration: two projects (the other one's files are not opened: verified by wrapping the fs open calls and
  asserting no path of the other project is touched beyond its name match); worktree sessions; session started in
  the root that works in a worktree; resumed session across two runs; index present vs scanning (with the index
  present, no directory scan: verified by a counting fs wrapper); session with subagent files.
- hardening: a ~1 GB log streamed (generated sparse in the test, peak memory asserted under a bound; runs in the
  slow/gated set); invalid JSON lines; truncated last line; entries without timestamps; a symlinked log pointing
  outside is refused; a path outside the root is refused; a test greps the collector sources for credential file
  names and fails if any appears outside the deny-list constant.
- real agent: totals within tolerance; canary on format change.

## Risks and open points

- The Claude Code log format is not a public contract; it changes between versions. Mitigation: version
  profiles in the interface (see above), a tolerant normalizer with stated skip rules, a fixture per profile,
  `format_drift` reporting for versions outside the known ranges, and the canary test.
- Only logs of builds present on this machine can be sampled; an older profile may have no real sample. Then it
  is not declared until a real log exists; the below-oldest rule (use the oldest profile, report drift) applies.
- Streaming `usage` lines: which line of a `message.id` group holds the final usage must be verified on real logs
  in step 3 (assumed: the last). If a group can span non-adjacent lines the fold needs a bounded map by `message.id`
  rather than adjacency; the plan uses the map (bounded per session, evicted when a new `requestId` starts).
- Windows folder-name hashing rule for long project paths is reproduced from observation, not from a spec; wrong
  guess means a missed folder, so the scan also falls back to confirming by `cwd` over folders whose names share
  the project's prefix (never over all folders).
- `usage.semantics: overlap` is defined in the format but Claude Code only yields `additive`; it is kept for
  agents (Codex) whose cached tokens are included in input. Documented, exercised by the fake agent.
- Cost: this task only reserves the `cost` slot; computing it is TASK 19's job.
- Sessions in worktrees that were removed with a run: their Claude Code folders still exist, but the cwd no
  longer does; confirmation uses the logged `cwd` string, not the filesystem.
- The index records only sessions started after hooks were installed; older sessions are found only by scanning, so
  "index present" means scanning is skipped by design (as the task says) and older history is out of reach until
  the person re-runs hook registration; stated in the docs.

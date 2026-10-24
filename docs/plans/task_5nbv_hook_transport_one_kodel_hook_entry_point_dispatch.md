# Plan: hook transport (TASK-5NBV)

## Goal

One stable way for a coding agent to tell Kodel what happens in its sessions: `kodel hook <agent>`. The agent's
hook config names only this command; the work done for an event is a handler in a registry, so a new handler for an
event that is already registered needs no change of the agent's configuration. The command must never get in the
agent's way: it always exits 0, prints nothing unless a handler means it, and does nothing outside a Kodel project.

First handler: a session registrar that appends `{session_id, agent, transcript_path, cwd, ts}` to
`.kodel/sessions.jsonl` (gitignored), so later history collectors find sessions without scanning.

Decisions taken with the person at the plan gate (they change the task text):

1. **`kodel init` registers the hooks by default**, in every mode (interactive, `--yes`, no terminal), unless the
   person turns them off. The task's rule "opt-in, only with `--hooks` or an interactive yes, never with `--yes`
   alone" is dropped: hooks are needed for the system to work normally.
2. **All three agents now**: Claude Code, Codex and OpenCode each get a normalizer, a registration step in `init` and a
   real-agent test in this change. An agent is `verified: true` in `init` only after its real test passes.

Out of scope: other handlers, `kodel doctor` as a whole (only the staleness check), wide-net registration (every event;
revisited before the release).

## What the docs say (read for this plan)

Claude Code (code.claude.com/docs/en/hooks; first 100k characters of the page read):
- stdin JSON: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `agent_id`/`agent_type` (in subagents);
  tool events add `tool_name`, `tool_input`, `tool_use_id`. Events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
  `PreToolUse`, `PostToolUse`, `SubagentStart/Stop`, `PreCompact`, and many more.
- Config: `hooks.<Event>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }]` in `.claude/settings.local.json`
  (project, personal, gitignored by Claude Code when it writes there); entries of all levels merge.
- Exit 0 ok; exit 2 blocks on blocking events; other codes are a non-blocking error shown as a notice (so even exit 1 is noisy).
  Plain stdout enters the context only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `PostModelSwitch`.

Codex (learn.chatgpt.com/docs/hooks):
- Hooks in `<repo>/.codex/hooks.json` (or `[hooks]` in `config.toml`); same three levels (event, matcher group, handlers with
  `type: "command"`, `command`, `timeout`). Events: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `Stop`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart/Stop`, `Interrupt`.
- stdin JSON: `session_id`, `transcript_path` (may be null), `cwd`, `hook_event_name`, `model`; turn events add `turn_id`,
  `tool_name`, `tool_input`.
- Project hooks load only if the project `.codex/` layer is trusted, and each hook must be reviewed and trusted in `/hooks` (trust is
  tied to the hook's hash). Trust is a person's decision (principle 6): `init` cannot and does not grant it. For tests the
  invocation flag `--dangerously-bypass-hook-trust` is used, for that run only.
- `Stop` and `SubagentStop` need JSON on stdout when exit is 0 and plain text is invalid there; since our command prints nothing,
  this must be tested (an empty stdout has to be accepted, or the registered events must exclude them).

OpenCode (opencode.ai/docs/plugins):
- No command hooks: a plugin file in `.opencode/plugins/` (JS or TS, loaded at startup) exports a function that receives
  `{ project, directory, worktree, client, $ }` and returns handlers (`event`, `tool.execute.before/after`, ...), with session
  events `session.created`, `session.idle`, ...
- The payload of each event is not fully documented. The plugin therefore builds the common payload itself
  (`hook_event_name`, `session_id`, `cwd` = `directory`, `tool`) from what the event carries and pipes it as JSON to the same entry
  (`kodel hook opencode`). What an event really carries is found with the real-agent test (step 2) and the OpenCode normalizer is
  written to it; a missing field makes the event ignored, never an error.

## Findings from the code

- The project marker is `.kodel/config.yaml` (committed by `kodel init`). The hook finds it by walking up from `cwd`; none found
  means exit at once, nothing read or written.
- Run worktrees live in `.kodel/worktrees/<run>` inside the project and have their own committed `.kodel/config.yaml`.
  The nearest marker from a worktree is the worktree's own, which is thrown away with the run. Rule: the nearest marker wins unless
  that directory is inside `<outer>/.kodel/worktrees/` of an outer marker, then the outer project is the root. This is a proposal for
  the person to confirm at this gate (the previous plan raised it too); a test pins it.
- `packages/cli/src/main.ts` loads the whole CLI (about 60 ms; bare Node 24 ms); the hook runs on every tool call, so it gets
  its own small bundle (target about 30 ms).
- `kodel init` (`packages/cli/src/init/`): `AgentAdapter` has `connect(ctx, server)` and `verified`; `editFile`, `editJson`,
  `addToList`, `objectAt`, `SkipEdit` are reused. `editJson` skips a file with comments or trailing commas with a note, which is the
  required behaviour. `IGNORED` in `init/index.ts` is the gitignore list.
- pipeline-core stays free of fs, process and clock.

## Affected files

pipeline-core (pure):
- `packages/pipeline-core/src/hooks.ts` (new): `HookEvent {agent, name, session_id, cwd, ts, tool?, raw}`,
  `HookHandler {id, events, run(event, ctx)}`, `HookRegistry` (register, handlers for an event, `events(agent)` derived),
  `dispatch(registry, event, {timeoutMs, onError})`: each handler isolated, a throw or a timeout is reported and the others still
  run; returns what handlers asked to print. Exported from `index.ts`.
- `packages/pipeline-core/src/hook-normalizers.ts` (new): `normalizeClaudeCode`, `normalizeCodex`, `normalizeOpenCode`
  `(payload, now) => HookEvent | undefined`; missing or unknown fields never throw; no event name or session id gives `undefined`.

local (fs):
- `packages/local/src/hooks/project.ts` (new): `findProjectRoot(cwd)` with the worktree rule above; only `stat`.
- `packages/local/src/hooks/session-registrar.ts` (new): one `appendFile` (`O_APPEND`, one write, bounded line) per event; the same
  session registered twice is allowed (readers take the last line per `session_id`).
- `packages/local/src/hooks/registry.ts` (new): the default registry, the single source of truth for `events(agent)`.
- `packages/local/src/hooks/run.ts` (new): `runHook(agent, stdin, env)`: capped read of stdin (more than the cap is dropped, not
  buffered), safe parse, normalize, find root, dispatch, errors to a capped `.kodel/hooks.log`; never throws; returns stdout text only
  when a handler asked for it.
- `packages/local/src/hooks/staleness.ts` (new): pure `staleEvents(registered, registry)`, used by `init` and by the registrar at
  `SessionStart` (one line in `hooks.log`).

cli:
- `packages/cli/src/hook-main.ts` (new): the entry of the small bundle; `process.exit(0)` on every path, uncaught errors included.
- `packages/cli/src/cli.ts`: `kodel hook <agent>` (same `runHook`); `dist/kodel.js` looks at `argv[2] === "hook"` before any heavy
  import and loads the small bundle. If the measured start is above the budget, fall back to a separate bin `kodel-hook` and write
  that name into the agent configs.
- `packages/cli/package.json`: second build entry; `scripts/check-artifact.mjs` checks the hook bundle runs on plain Node, exits 0
  with empty and garbage stdin, and stays under a size budget.
- `packages/cli/src/init/hooks.ts` (new), `agents.ts` (`registerHooks(ctx, server, events)` on `AgentAdapter`), `index.ts`, `cli.ts`:
  - **On by default**; `--no-hooks` turns it off; the interactive question "Register Kodel hooks (they are what lets Kodel see your
    agent sessions)?" has the default yes; `--yes` and no-terminal runs register.
  - claude-code: `hooks.<Event>` in `.claude/settings.local.json` for exactly `registry.events("claude-code")`.
  - codex: `.codex/hooks.json` for `registry.events("codex")`; the report says hooks must be trusted once in `/hooks` and that init does
    not do that.
  - opencode: a generated plugin `.opencode/plugins/kodel-hooks.ts` (stamped as managed, replaced only when unedited) that forwards
    session and tool events to `kodel hook opencode`.
  - Idempotent: our entry is added only if none with the same command exists; the person's own hooks are kept; a file that is not plain
    JSON is skipped with a note; `--dry-run` lists the files; each file written is made sure to be gitignored once
    (`.claude/settings.local.json`, `.codex/hooks.json`, `.opencode/plugins/kodel-hooks.ts`); `.kodel/sessions.jsonl` and
    `.kodel/hooks.log` join `IGNORED`; the report shows every hook file line; a warning when `kodel` is not on `PATH`; one quoting helper
    for Windows.
  - Existing projects: re-running `init` adds events of new handlers (the list is derived from the registry) and reports stale events.
- `adapters/README.md`, `tests/README.md`: where the hook code lives, how to add a handler or an agent, how to run the real-agent
  hook tests.

## Steps

1. Read the rest of the Claude Code hooks page (characters 100k and on) and check the per-event fields of the events we register.
2. Types, registry, dispatcher in pipeline-core, with tests. Capture real payloads of the three agents once (a throwaway command that
   writes stdin to a file) and keep them as fixtures for the normalizers; for OpenCode this fixes what the plugin can forward.
3. Normalizers for the three agents.
4. `findProjectRoot`, registrar, `runHook`.
5. Entry point, `kodel hook`, second bundle, early dispatch; measure the startup.
6. `init` hooks step for the three agents, on by default, `--no-hooks`, gitignore, report, warnings.
7. Staleness check and its report.
8. Benchmark test, artifact check, three real-agent tests, README text.

## Test strategy

- unit (pipeline-core): each normalizer per registered event from the captured fixtures, missing and unknown fields; registry: a handler
  throws and the others still run, a handler times out, order, derived events per agent; stdout empty unless a handler returns text.
- unit (local): fast exit outside a project (nothing created or read); `cwd` in a subdirectory and in a run worktree (outer root wins);
  two projects side by side write only to the right index; the same session twice; a resumed session.
- integration: the registrar under two concurrent hook processes, many lines each (no torn lines, every line valid JSON).
- init (`init.test.ts`): default registers hooks for each chosen agent (also with `--yes` and without a terminal); `--no-hooks` leaves the
  files untouched; the interactive question defaults to yes and "no" is honoured; `--dry-run` lists and writes nothing; the person's own
  hooks kept; rerun is idempotent; broken JSON, comments and trailing commas skipped with a note; file missing is created; every
  gitignore line added once; stale events reported after a registry change; Codex trust notice printed.
- hardening: a 100 MB payload (memory and time bounded), binary data, terminal escapes in fields (never raw to stdout or the log); a
  handler may not print by default; exit code 0 on every failure path (bad JSON, empty stdin, unwritable `.kodel`, handler crash, closed
  stdout); Codex `Stop` accepts the empty stdout (or the event is not registered).
- startup budget: a benchmark records the hook bundle's startup on plain Node and fails above a budget set from the bare-Node baseline
  measured in the same run, with margin for CI on three platforms.
- real agents (`tests/agents/hooks-claude-code.test.ts`, `hooks-codex.test.ts`, `hooks-opencode.test.ts`; skipped without
  `KODEL_AGENT_TESTS`): `init` (default) in a temp project, then a headless session (`claude -p`, `codex exec` with
  `--dangerously-bypass-hook-trust`, `opencode run`) writes its `session_id` into `.kodel/sessions.jsonl`; the same session outside any
  Kodel project writes nothing and the agent's own exit code and answer are unaffected. Each agent is `verified: true` only when its test
  passes on this machine (all three CLIs are installed here); a test that cannot run is reported as such, not skipped silently.
- `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && bun run check:artifact`.

## Risks

- Default-on writes personal agent configs (`settings.local.json`, `.codex/hooks.json`, a plugin file), also when an agent runs `init`.
  Mitigations: the report lists every file, `--dry-run`, `--no-hooks`, gitignore, and the entries only call `kodel hook`. Codex trust is
  still the person's.
- Codex project hooks run only after trust; until then the index is empty for Codex and the notice is the only sign. A test with the bypass
  flag proves the wiring, not the trust flow.
- OpenCode event payloads are undocumented; the plugin and normalizer are written to what the real agent sends (step 2), and an OpenCode
  update can change it. The plugin runs inside the agent process, so it must catch every error and never block.
- Claude Code treats any exit code other than 0 as a visible error, so every path exits 0, also on a crash of the bundle itself.
- Startup budget: the early dispatch may not reach about 30 ms if the large bundle is still parsed; measure in step 5, then the `kodel-hook` bin.
- The worktree root rule (outer project wins) is a proposal; a different rule changes only `findProjectRoot` and one test.
- Concurrent appends rely on `O_APPEND` single writes of short lines; Windows semantics are weaker and the test runs on all three CI platforms.
- Real-agent tests use the person's logged-in agents and their limits, and are not deterministic: they assert on files, not on text.

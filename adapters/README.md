# Agent adapters

One directory per supported agent (`claude-code`, `codex`, `opencode`). An adapter holds the
agent-specific pieces only: the MCP config writer used by `kodel init`, and the prompt or skill that drives the pipeline loop.

An agent is listed as supported only after it passes the real-agent scenarios in `tests/agents/`.

Until the adapters are split out of the CLI, the code of `kodel init` lives in `packages/cli/src/init/`
(`agents.ts` has one adapter per agent). `claude-code` is checked on the real agent; `codex` and `opencode`
are written to the agents' documented formats and not checked yet (their hooks are: see below).

The `kodel-run` launcher and `kodel-design` skills are installed for every agent by `kodel init`, into its `skillsDir` (`.claude/skills`, `.agents/skills`, `.opencode/skills`).

## Hooks

`kodel hook <agent>` is how an agent tells Kodel what happens in its sessions. The agent's configuration names only
that command (`kodel-hook <agent>` for the installed `kodel`: a small program that starts in about 30 ms, because it
runs on every registered event). What is done for an event is a handler in a registry, so a new handler for an event
that is already registered needs no change of the agent's configuration.

- Types, the dispatcher and the per-agent normalizers: `packages/pipeline-core/src/hooks.ts`, `hook-normalizers.ts`.
- The registry (`registry.ts`, the single source of truth for which events are registered), the session registrar
  (`.kodel/sessions.jsonl`, or the project's folder under `~/.kodel` with `storage: home`), the project lookup and
  `runHook`: `packages/local/src/hooks/`.
- Registration: `kodel init` does it by default (`--no-hooks` turns it off) in `.claude/settings.local.json`,
  `.codex/hooks.json` and `.opencode/plugins/kodel-hooks.ts`, all personal files. Running `init` again adds the
  events of handlers added since; the hook notes in `.kodel/hooks.log` when events are missing.
- The hook always exits 0 and prints nothing unless a handler that may print asks for it. It does nothing outside a
  directory that holds the project config (`.kodel/config.yaml`).

To add a handler: write a `HookHandler` (`id`, `events`, `run`), register it in `defaultHookRegistry()`, and tell the
person to run `kodel init` if it needs an event that is not registered yet. To add an agent: a normalizer for its
payload, its registration in `packages/cli/src/init/hooks.ts`, and a real-agent test in `tests/agents/hooks.test.ts`.

What each agent does with the hook, as seen on the real agents:

- Claude Code: a command hook per event in `.claude/settings.local.json`; the payload has `session_id`,
  `transcript_path`, `cwd` and `hook_event_name`.
- Codex: the same payload in `.codex/hooks.json`. The hook runs only after a person trusts it in `/hooks`, and it runs
  inside Codex's sandbox: in a read-only session it cannot write the session index (and with `storage: home` a
  sandbox that confines writes to the workspace cannot write under `~/.kodel` either).
- OpenCode (v2): no command hooks; the generated plugin passes session and tool events to the same command. The event
  stream belongs to the server, so the plugin forwards only the sessions of its own directory. OpenCode finds its project
  by `PWD`, so a program that starts it must set `PWD` along with the working directory.

Payloads of each agent, as captured from the real ones, are in `fixtures/hooks/`; the normalizers are tested against them.

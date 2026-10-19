# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

Kodel is an open-source (Apache-2.0) local MCP engine that runs spec-driven pipelines inside
the coding agent a developer already uses. The engine validates every step result outside the
agent (fail-closed), keeps a run history in the repository, and analyzes that history to
propose improvements to the pipeline. It is built so that a server backend (Kodel Server)
can later sit behind the same contract.

Documents: until the first working version exists, the specifications are Russian working notes
(product notes, decision log, MCP contract, architecture, MVP plan) kept locally in the git-ignored
`notes/` folder; they are not part of the repository. Comments and issues refer to decisions by id
(`T-12`, `T-37`, ...) from the decision log. English documentation in `docs/` will be written from
those notes once the first working version is done. Reference pipeline: `examples/pipelines/feature.yaml`.

## Running a pipeline on this repository

`.mcp.json` starts the `kodel` MCP server from source (`bun packages/cli/src/main.ts mcp`), and
`.kodel/pipelines/dev.yaml` is the pipeline. When the user asks for a change "through the pipeline":

1. Call `pipeline_start` with the task, then follow each answer. Never choose steps yourself and
   never skip one: the engine, not you, decides whether a step is done.
2. `pipeline_next_step` returns `node` (do the work, then `pipeline_complete_step`), `waiting` (a person
   decides with `kodel gate approve|reject <run>`; tell them and end your turn), `running` (engine work
   is going; end your turn) or `done`.
3. Do not touch `.kodel/runs/`, and do not run `gate`, `ack`, `seal` or `resume`: those are for the person.
4. If a step description or check looks wrong, say so with `pipeline_feedback`.

Humans: `bun packages/cli/src/main.ts status` lists runs; the same binary has `gate`, `resume`, `ack`, `seal`.

## Language

- **All code comments, doc comments, documentation, commit messages, PR descriptions, error
  messages, log messages and identifiers are written in English.** No exceptions for new work.
- Conversation with the user may be in the user's language; files are not.
- Everything that is committed is in English. The local, git-ignored `notes/` folder holds the
  Russian working notes and must not be committed.

## Layout

Bun workspace (TypeScript, ESM). Runtime target: Node >= 22.19; Bun is the development toolchain.

- `packages/pipeline-core` (`@kodel-ai/pipeline-core`): pure engine (pipeline spec, result checks, run state machine, routing, redaction, error codes, format versions), the `PipelineService` and the adapter interfaces. No file system, process, network or clock access. The subpath `@kodel-ai/pipeline-core/mcp` holds the MCP tool definitions bound to the service (it depends on the MCP SDK; the main entry does not import it). Transport-free: the CLI adds stdio, the server adds HTTP and auth.
- `packages/local` (`@kodel-ai/local`): local adapters (file state store, process executor, git snapshots, system clock).
- `packages/cli` (`kodel`): the CLI, built to a single JS file (`dist/kodel.js`), including human-only commands (`trust`, `ack`, `seal`, `gate`).
- `packages/testkit` (`@kodel-ai/testkit`, private): scripted and adversarial fake agents, fixture helpers.
- `adapters/`: per-agent pieces (MCP config writers, deny rules, driver prompts). `skills/`: agent-facing skills.
- `tests/e2e`, `tests/agents`: end-to-end and real-agent scenarios. `fixtures/formats/`: golden fixtures per format version.

The engine is meant to be shared with Kodel Server: the server implements the same adapter interfaces
(state store on Postgres, runners as executors) and registers its own node and check kinds.

## Principles

1. **Agent input is untrusted.** The engine, not the agent, decides whether a step is done.
2. **Fail closed.** Missing or invalid results never close a step.
3. **Redact at every write path.** Nothing reaches history without going through `redact`.
4. **The engine knows nothing about transport or I/O.** Keep `@kodel-ai/pipeline-core` free of MCP, CLI, `node:fs`, `node:child_process` and clock access; those come in through adapters.
5. **Side effects behind traits** (clock, filesystem, process execution) so tests can fake them.
6. **Humans decide trust.** Trust, gate decisions, `ack` and `seal` are never available as agent-callable MCP tools.
7. **Node kinds and check kinds are adapters.** Handlers sit behind traits and are registered by `kind`; the engine never matches on concrete kinds, so a plugin system can be added later without engine changes.
8. **Formats are versioned** (`format` cascade, `v` on every machine-written record). Never rewrite history on disk.

## Decisions and tests

Every decision recorded in the decision log (local notes, referred to by id) has a test plan and a refutation criterion.
A decision is implemented only when its tests exist and pass. Test names carry the decision id
(for example `t12_format_cascade_defaults_to_v1`). If a test shows a decision does not hold,
revisit the decision instead of bending the test.

## Conventions

- TypeScript in strict mode (`noUncheckedIndexedAccess`), ESM only, no `any`. Validate external input with `zod` (v3, aligned with Kodel Server). Biome formats and lints.
- The shipped artifact must run on plain Node, not only under Bun: CI runs `scripts/check-artifact.mjs` against the built file.
- Errors: `KodelError` with a stable string code (see the error codes in the MCP contract); tools return `{ok:false, code, message}` rather than throwing.
- Keep dependencies minimal and justify each new one in the PR description. Licenses must be compatible with Apache-2.0.
- Keep comments rare and about *why*, not *what*. Match the style of the surrounding code.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build && node scripts/check-artifact.mjs
```

(These are the commands CI runs on Linux, macOS and Windows.)

## Git

- Sign off commits (`git commit -s`): the project uses the Developer Certificate of Origin.
- Never push to `main` directly; use pull requests.

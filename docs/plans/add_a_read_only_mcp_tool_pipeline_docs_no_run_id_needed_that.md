# Plan: `pipeline_docs`, the engine's own documentation for the agent

## Goal

Give the agent one read-only MCP tool, `pipeline_docs`, that works like `llms.txt`: no arguments returns
an index (what Kodel is, the engine version, one line per topic); `topic` returns that topic. The text
travels inside the build, so it always matches the engine that serves it, and a skill that writes or
changes a pipeline can be three lines long ("read `pipeline_docs`, follow it") instead of carrying
instructions that go stale.

This is step 1 of three. Step 2 (creating a new pipeline through the `pipeline_propose_change`
machinery) is only designed here, see "Follow-ups". Step 3 is a thin `skills/design`.

Decided with the person: no `kodel docs` CLI command (a person has `--help` and, later, the English
`docs/`); the tool is the only entry point.

## What exists today (checked in the code)

- Tools are `ToolDescriptor`s in `packages/pipeline-core/src/mcp/tools.ts`; `registerPipelineTools`
  (`mcp/register.ts`) puts them on a server and `invokeTool` validates and dispatches. Each tool runs a
  method of `PipelineService` (`service.ts`) and answers `ToolResult` (`{ok:true,...}` or
  `{ok:false, code, message}`). Codes are a closed list, `ERROR_CODES` in `errors.ts`.
- `SERVER_INSTRUCTIONS` (same file) is sent on connect; `service.test.ts` checks that it names only
  existing tools, that the tool list and every tool's argument names are pinned.
- The pipeline syntax is described in code only: `topSchema`, `commonNodeShape`, `edgeSchema`
  (`pipeline.ts`, not exported) and the `shape` of each node and check handler in `registry.ts` /
  `nodes.ts` / `checks.ts`. Most fields have no `.describe()` text.
- The core has no file system access and no engine version; the CLI knows its own version
  (`createServer(host, version)` in `packages/cli/src/mcp-server.ts`) but builds the service without it.
- The shipped artifact is one file built by `bun build` (`packages/cli/package.json`), checked under plain
  Node by `scripts/check-artifact.mjs`.
- A pipeline proposal today is per run: `RunHandle.proposeChange`, stored in
  `.kodel/runs/<id>/pending/proposal.yaml` (`packages/local/src/store.ts`), accepted by the person with
  `kodel pipeline changes apply <run>`.

## Design (step 1)

### The tool

`pipeline_docs { topic?: string }`, `readOnly: true`, `idempotent: true`, run by a new
`PipelineService.docs()`. It never touches the host, so it works with no run, no pipeline and a broken
pipeline file. Answers:

- no `topic`: `{ok:true, kodel, engine_version, topics:[{topic, summary}], note}`. The index text names
  the contract version and the user-file `version` range the engine reads (`BASELINE_VERSION`,
  `MAX_SUPPORTED_MAJOR`).
- known `topic`: `{ok:true, topic, text}` where `text` is markdown.
- unknown `topic`: `{ok:false, code:"UNKNOWN_TOPIC", message}`; the message lists the existing topics.
  `UNKNOWN_TOPIC` is added to `ERROR_CODES` (a stable code is part of the contract; reusing
  `INVALID_ARGUMENTS` would hide the list the agent needs).

`CONTRACT_VERSION` stays 1, as when `pipeline_propose_change` was added (an added tool changes no
existing argument); the surface snapshot tests are updated.

### Where the text lives

Markdown sources in `packages/pipeline-core/agent-docs/<topic>.md`, one file per topic, with a one-line
`summary` in the catalog (`docs.ts`). They are embedded with `import text from "./x.md" with { type: "text" }`
(Bun inlines it in `bun build`, and in `bun test`), plus a `declare module "*.md"` for `tsc`. A small
`packages/pipeline-core/src/docs.ts` holds the catalog (topic -> source) and the renderer. If the text import
turns out not to survive `typecheck`/`lint`/`build` together, fall back to a generated `.ts` module (a script
plus a "generated file is current" test); decide in the first hour, do not carry both.

The core stays free of I/O: the catalog is pure data.

### What is generated and what is written

- `pipeline-spec`: a hand-written part (the model, edges, placeholders `{{task}}` / `{{task.slug}}`, the
  `version` rule, defaults) followed by a **generated field reference**: the top-level fields, the common
  node fields and the fields of every registered node kind, read from the zod schemas.
- `checks`: hand-written guidance (which check for which job, `diff` modes, `result` columns,
  `fail_when`) plus the **generated parameters of every registered check kind**.
- `examples`: complete pipelines (a minimal one; a plan, gate, implement, verify chain; a review with a
  `result` check; the `nothing_to_change` outcome). Hand-written.
- `pipeline-design`: hand-written. How to build a pipeline for a project: what to look at in the repository
  (package manifests, scripts, CI files, `AGENTS.md`/`CLAUDE.md`, existing tests and linters), the three
  profiles (`lean`: implement, verify; `standard`: adds a plan gate, tests and build; `strict`: adds an
  independent `fresh_context` review with `fail_when` and a result gate), the two modes (auto: explore and
  build with no questions and list every assumption in the summary; guided: a few batched questions, at
  most about two rounds) and the traps we know (`diff` `max_lines` counts tests too; a command the project
  does not have fails the first run; a task text must not go into a command). The profiles are full
  pipelines in `examples`, which the topic links to.
  Until step 2 exists the topic says plainly how the result reaches the person (show the YAML and the file
  path `.kodel/pipelines/<name>.yaml`; the person saves it). It must not describe a tool that does not exist;
  step 2 updates this one paragraph.

To generate the reference, `pipeline.ts` exports what it already has (`topSchema`, `commonNodeShape`,
`edgeSchema`), and a small renderer (`docs.ts`) walks a `ZodRawShape` into a table (name, type, required,
description, allowed values). It supports exactly the zod node types in use (string, number, boolean, enum,
literal, array, record, object, union, optional, nullable, effects) and **throws on one it does not know**,
so a new field type breaks a test instead of vanishing from the docs. Missing `.describe()` texts are added
to the fields as part of this work; a test fails if a field in a registered shape has none.

### Version

`ServiceOptions` gets `engineVersion?: string`; the CLI passes the version it already has to
`PipelineService` in `createServer`. Absent, the index says "unknown".

### Agent instructions

`SERVER_INSTRUCTIONS` gets one item: when asked to write or change a pipeline, read `pipeline_docs` first;
it is the reference for this engine version. The existing test (names only real tools) covers it.
`pipeline_list`'s answer for a project with no pipelines and `pipeline_start`'s "there are no pipelines;
add one to .kodel/pipelines" get a pointer to `pipeline_docs` (topic `pipeline-design`).

## Affected files

- new: `packages/pipeline-core/src/docs.ts`, `packages/pipeline-core/agent-docs/{pipeline-spec,checks,examples,pipeline-design}.md`,
  `packages/pipeline-core/src/md.d.ts` (module declaration), `packages/pipeline-core/test/docs.test.ts`
- `packages/pipeline-core/src/mcp/tools.ts` (tool, instructions item), `service.ts` (`docs()`,
  `engineVersion`, the two "no pipelines" messages), `errors.ts` (`UNKNOWN_TOPIC`), `pipeline.ts` (exports,
  `.describe()` texts), `registry.ts`/`nodes.ts`/`checks.ts` (`.describe()` texts)
- `packages/cli/src/mcp-server.ts` (pass the version)
- `packages/pipeline-core/test/service.test.ts` (tool list and argument snapshot), `scripts/check-artifact.mjs`
- `AGENTS.md`: nothing in this step (no new rule for people).

## Steps

1. Spike the embedding: one `.md` imported with `with { type: "text" }`, `bun run typecheck`, `lint`,
   `build`, `node scripts/check-artifact.mjs`. Settle the fallback question.
2. `docs.ts`: catalog, index renderer, topic lookup, the zod-to-table renderer. `UNKNOWN_TOPIC`.
3. Add the missing `.describe()` texts; export the schemas from `pipeline.ts`.
4. `PipelineService.docs()` and `engineVersion`; the tool descriptor; `SERVER_INSTRUCTIONS`; the CLI passes
   the version.
5. Write the four topics. Every `yaml` block is a complete pipeline; fragments use `text`.
6. Tests (below), snapshot updates, `check-artifact.mjs`.
7. `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Tests

Names carry no decision id yet (the decision is not in the local log); they use the repository's `tNN_`
placeholder and get the id when the person records it.

- `tNN_every_yaml_block_in_every_topic_is_a_pipeline_the_parser_accepts` (fence `yaml` = full pipeline,
  parsed with `parsePipeline`; `validatePipeline` issues are shown in the failure).
- `tNN_every_topic_linked_from_another_topic_or_the_index_exists` (links are written `(docs:<topic>)`),
  and `tNN_every_topic_is_in_the_index`.
- `tNN_the_index_has_the_engine_version_and_a_line_per_topic`.
- `tNN_an_unknown_topic_is_refused_with_the_list_of_topics` (code `UNKNOWN_TOPIC`, no throw).
- `tNN_docs_need_no_host_and_no_run` (service with a host that throws on every call).
- `tNN_the_generated_reference_names_every_field_of_every_registered_node_and_check_kind`, including a
  kind registered in the test (a plugin kind shows up with no change to the docs code).
- `tNN_a_field_without_a_description_fails` and `tNN_an_unknown_zod_type_throws_instead_of_vanishing`.
- The tool surface tests: tool list, argument names (`pipeline_docs: ["topic"]`), instructions name only
  real tools, `readOnly`/`idempotent` hints.
- Over MCP (the existing in-memory client in the CLI tests): `tools/list` has `pipeline_docs`; calling it
  returns the index.
- Artifact: `check-artifact.mjs` greps `dist/kodel.js` for a sentinel line of each topic, so a build that
  dropped the markdown fails under plain Node.

## Risks

- **Docs drift** from the engine: the generated reference and the parsed examples cover the syntax; the
  prose (profiles, traps) can still age. Mitigation: it lives next to the code and the test names the
  files, so a change to a field is one grep away; a review item in `dev.yaml` is a possible follow-up.
- **Text imports** are a Bun feature: a second host (the server) built with another bundler would need the
  same loader. Mitigated by the catalog being the only place that imports them; the fallback is a
  generated module.
- **Size**: the artifact has a 5 MB budget; four topics are tens of KB, negligible.
- **Prompt-sized answers**: a long topic costs the agent tokens on every call. Keep each topic focused
  (under about 6 KB, a test fails above 12 KB) and split rather than grow.
- **A tool that tells the agent how to write pipelines** raises the question of who may run what it
  writes: nothing changes in trust. A pipeline file is still only created by a person's hand or accepted by
  a person's command; the docs say so.

## Follow-ups (not in this change)

2. **Creating a NEW pipeline through the `pipeline_propose_change` machinery.** Today the tool needs a
   `run_id` and acts on the run's pinned pipeline; a project with no pipeline has no run. Proposal:
   - `pipeline_propose_change` takes `run_id` optionally. Without it, the YAML must have a `name` that no
     pipeline in the project has, otherwise it is refused (changing an existing pipeline outside a run is a
     separate decision).
   - The service validates with `parsePipeline`, and the host adds project checks that are warnings in the
     answer (a `command` whose program the project does not have, e.g. `bun run typecheck` with no such
     script). The diff against an empty pipeline comes from `pipeline-diff.ts`.
   - New `PipelineHost` method (`proposePipeline`) and a store area **outside `.kodel/pipelines/`**,
     `.kodel/proposals/<name>.yaml` plus the summary, replaced by the next proposal, taken back by an empty
     `pipeline`; the agent keeps no write access to `pipelines/`.
   - The person accepts with a terminal-only command (TTY and confirmation, like `changes apply`):
     `kodel pipeline proposals show|apply|discard <name>`. `apply` writes `.kodel/pipelines/<name>.yaml`;
     this is also where "trust after a person's approval" (T-1) attaches later.
   - Changes needed: the tool's argument list (snapshot test), `SERVER_INSTRUCTIONS` items 5 and 6, the
     `AGENTS.md` rule list and layout line (the new human-only command), the `pipeline-design` paragraph
     above, `deny` rules in the adapters for `.kodel/proposals/`.
   - Open: what happens to a proposal for a name that appeared in the meantime (refuse on apply); whether a
     proposal outlives the session (yes, it is a file).
3. `skills/design` (thin): choose the mode (ask once: set the pipeline up together, or let the agent build
   it), read `pipeline_docs`, explore, propose.
4. Later: a `bootstrap` pipeline that runs the creation as a recorded run; `analyze`-driven changes reuse
   the same proposal path.

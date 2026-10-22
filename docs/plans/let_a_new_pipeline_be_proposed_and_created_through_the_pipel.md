# Plan: a pipeline, new or changed, proposed by the agent and accepted by a person

## Goal

Today an agent asked to write a pipeline for a project can only show YAML in chat (`pipeline_docs`, topic
`pipeline-design`, section "Hand it over"), and the person copies it into `.kodel/pipelines/` by hand. The
same holds for a change of a pipeline outside a run: the engine sees none of it, nothing is validated, nothing
is kept, nothing says who accepted what.

After this change the agent hands a pipeline to the engine, and the engine validates it and keeps it apart
from the pipelines that run. A person accepts it with a terminal-only command that writes
`.kodel/pipelines/<name>.yaml`. This works for a **new** pipeline and for a **change of an existing one**,
both without a run, through the same tool. Step 3 (the thin `design` skill) is not part of it.

The rule that carries over from the existing machinery (principle 6): the agent may propose, and only a
person's command puts the result in place. The agent never gets a tool that accepts.

## Decided with the person

- Option A: `pipeline_propose_change` without `run_id` (the options are compared below).
- A name that is already in use is a proposal to change that pipeline, not a refusal; this is in this change.
- The diff limit of the `impl` step was removed for this run, so nothing here is sized to fit it.
- Not answered, taken as in the first version of this plan unless said otherwise: proposals are kept in
  `.kodel/proposals/<name>.json` and git-ignored; an extra `name` argument is used only to take a proposal back;
  warnings about commands the project does not have are a follow-up.

## What exists today (checked in the code)

- `pipeline_propose_change` needs a `run_id`. `LocalRun.proposeChange` (`packages/local/src/host.ts`) checks
  size, secrets (`redactText`), parses, refuses a no-op and a change the run cannot take, writes
  `.kodel/runs/<id>/pending/proposal.yaml` (`FileStore.writeProposal`) and journals `change_proposed`.
- The person accepts with `kodel pipeline changes apply <run>` (`packages/cli/src/cli.ts`): `requireHuman()`
  (a terminal, and not inside a command the engine runs), a confirmation that shows what is accepted, a second
  read to be sure the text did not move, then the write (`FileStore.replaceFile`, all or nothing).
- `pipeline_resolve` with a `run_id` returns `{spec, yaml, version}`; without it only `{spec}`
  (`PipelineService.resolve`). So an agent cannot start a change of a project's pipeline from the file's text.
- `PipelineHost` (`packages/pipeline-core/src/service.ts`) has `list`, `resolve`, `start`, `open`. The local one
  reads `.kodel/pipelines/*.yaml` (`packages/local/src/pipeline-host.ts`; `find` matches by the name in the file
  or by the file's stem; a file that does not parse is reported in `problems`, not in `pipelines`). Kodel Server
  implements the same interface, so a new method must be optional or it breaks the server's host.
- A run keeps its own copy of its pipeline and **watches one file** (`LocalRun.watched`): for a run in a worktree
  that is the copy in the worktree, otherwise the file in the repository. An edit of that file is noticed and
  waits for the person (`pendingChange`, source `file`). The pipeline file in the repository root is therefore
  watched only by runs that work in the repository itself (worktree mode off).
- `pipeline_start` asks the person to choose the working or the committed version when the pipeline file has
  changes that are not committed (`ChoiceNeeded`).
- A project has no run before its first pipeline, so nothing run-shaped can carry a proposal.
- The deny rules for agents are hand-written in this repository's `.claude/settings.json`; the adapter
  directories (`adapters/*`) are empty and `kodel init` does not exist yet.
- Pipeline names are only "non-empty" in the parser (`topSchema`), but a file name needs more.

## Options compared

| | A: `pipeline_propose_change` without `run_id` | B: a new tool `pipeline_propose_new` | C: creation as a recorded run (`bootstrap`) |
| --- | --- | --- | --- |
| Tool surface | one tool, one optional argument | one more tool | no new tool, but a pipeline to ship and run |
| History | a file with the summary | same | a run journal (what was explored, asked, decided) |
| Cost to build | small | small | large: a bootstrap pipeline, its checks, a place to put it before any pipeline exists |
| Clarity for the agent | two modes in one description | one job per tool | the agent follows steps, not a description |

**Chosen: A** (the person's decision). B is the fallback if a real agent mixes the two modes up; the real-agent
scenarios below are where that would show. C is later: the first pipeline of a project cannot depend on one.

## Design

### The tool

`pipeline_propose_change { run_id?: string, pipeline: string, summary: string, name?: string }`.

- With `run_id`: as today, unchanged. The "ask the person first" rule stays for this mode.
- Without `run_id`: a proposal for the **project**. The `name` inside the YAML decides what it is:
  - no pipeline of that name and no file of that stem: a **new** pipeline;
  - a pipeline of that name (found as `find` does, by name or by stem): a **change** of it. Renaming is not a
    change: another name is a new pipeline.
  There is nothing to ask the person first: they accept it anyway.
- Taking back: an empty `pipeline` with `name`. `name` is required for that and means nothing otherwise (when a
  YAML is given its own name is used, and `name` if present must equal it). If this is clumsy for agents,
  withdrawing becomes a person's act only (`discard`) and leaves the tool.
- The answer on success: `{ ok: true, status: "proposed" | "withdrawn" | "none", pipeline_proposal: { name,
  kind: "new" | "change", changes?: NodeDiff[], apply, warnings? }, note }`. `apply` is the command for the
  person, `kodel pipeline proposals apply <name>`; `changes` (for a change) is what differs per step, the
  existing `diffNodes`. The `note` says: tell the person the command and what you assumed or changed, do not
  run it, and propose again to change it (a new proposal of the same name replaces the old one).
- Refusals (`{ok:false, code, message}`, never a throw): `INVALID_ARGUMENTS` (too large, a secret in the text, a
  name that is not a file name: lowercase letters, digits and dashes, up to 63); `PIPELINE_INVALID` (the
  parser's message); `PIPELINE_CHANGE_REFUSED` for: a change that differs in nothing from the file, a name whose
  stem is taken by a file that is not a valid pipeline ("fix that file by hand"), the host takes no proposals
  without a run, more than 10 proposals waiting.
- The pinned argument snapshot in `service.test.ts` becomes `["run_id", "pipeline", "summary", "name"]`.
  `CONTRACT_VERSION` stays 1, as for the previous additions.

### `pipeline_resolve` without a run

It also returns the file's text and its hash: `{ ok: true, spec, yaml, version }`, where `version` is the hash of
the text as `hashSource` computes it. This is what a change starts from and what the proposal's base is compared
against. The tool descriptions of `pipeline_resolve` and `pipeline_propose_change` say to start from it. In the
core this is an optional host method `resolveSource?(name)`; the service falls back to `{spec}` when the host
does not have it.

### The host interface

`PipelineHost` gets two optional methods:

```ts
resolveSource?(name: string): Promise<{ spec: PipelineSpec; yaml: string; hash: string } | undefined>;
proposePipeline?(input: { yaml: string; summary: string; name?: string }): Promise<PipelineProposalOutcome>;
```

`PipelineProposalOutcome` mirrors `ProposeOutcome`. `PipelineService.proposeChange` calls `proposePipeline` when
`run_id` is absent; a host without it gets `PIPELINE_CHANGE_REFUSED`. The core stays free of I/O: what needs only
text (parse, the name rule, the list of shell commands in a pipeline) is pure core code in a new
`src/new-pipeline.ts` (`proposalNameProblem`, `hiddenCharacterProblem`, `commandsOf`), so a server host can use the same rules.

### The local host and store

- `FileStore` (`packages/local/src/store.ts`) gets write, read, remove and list for
  `.kodel/proposals/<name>.json`: `{ v: 1, name, kind, yaml, summary, base_hash?, proposed_at }`. `base_hash` is
  the hash of the pipeline file at the time of a change proposal. The record holds the agent's text as it is, so
  the same "nothing a redaction would change" rule as for run proposals applies on the way in (principle 3), and
  the summary is redacted.
- `LocalPipelineHost.proposePipeline`: the checks above; the kind from `find`/`load` (including a stem taken by an
  invalid file); for a change the `base_hash` from the current text and the no-op check by `canonicalPipeline`.
- `LocalPipelineHost.resolveSource`, `pipelineProposals` (the list), `pipelineProposal` (one, as a person sees
  it, with `refused` when it cannot be taken), `hasPipelineProposal` (a record is there, readable or not, so a
  damaged one can be dropped) and `acceptPipelineProposal(name, expectedHash)`: re-read the record; refuse if its text no longer hashes to what
  was shown; for a **new** pipeline refuse if the name or the stem appeared meanwhile; for a **change** find the
  file by name and refuse if its text no longer hashes to `base_hash` ("the pipeline changed after this was
  proposed; propose again"); write the file (for a change `replaceFile`, all or nothing, after reading the file once more; for a new
  pipeline `createFile`, which links the content into place and so never replaces a file that appeared
  meanwhile, with a plain exclusive create where hard links are not allowed); remove the record; return the path. `discardPipelineProposal(name)` removes
  the record. These are plain methods; the CLI is what makes them human-only.
- `.kodel/proposals` is run-state, not history: it is added to this repository's `.gitignore` next to
  `.kodel/runs`. Whether `kodel init` does the same for other projects is for that command to decide.

### What happens to runs and to the next start

- A run in a worktree has its own copy of the pipeline and watches that copy, so an accepted project-level change
  does not reach it. The run goes on as it was; the change reaches new runs (and, after a merge, the worktree
  copies).
- A run that works in the repository itself watches the root file, so the accepted change is noticed by the
  existing mechanism for a hand-edited file and waits for the person (`pipeline changes`), exactly as if the person
  had edited it. Nothing new is needed; it is covered by a test so it stays true.
- After a change is accepted the file differs from the last commit, so the next `pipeline_start` of that pipeline
  asks for the working or the committed version (`ChoiceNeeded`). That is the existing behavior and a test pins
  it for this path.

### The CLI

`kodel pipeline proposals [show|apply|discard] [name]` next to `pipeline changes`:

- `show` (the default; without a name it lists what waits, with kind and summary): prints the summary and the
  **full YAML**. For a change it also prints what differs per step (`formatChange`/`diffNodes`). It always ends
  with a block listing every shell command the pipeline would run (`command` nodes and `command` checks), and for
  a change it marks the commands that are new or different from the file's.
- `apply <name>`: `requireHuman()`, `mustConfirm` with the text of `show`, the hash check, then
  `acceptPipelineProposal`; prints the path and how to run the pipeline. Without a terminal, or inside an engine
  command, it refuses exactly as `changes apply` does.
- `discard <name>`: the same guard, removes the record.

### What the agent is told

- `SERVER_INSTRUCTIONS`: one new item, "To add a pipeline or to change one outside a run, read `pipeline_docs`
  (topic `pipeline-design`); for a change start from `pipeline_resolve` and its `yaml`; then call
  `pipeline_propose_change` without `run_id`; a person accepts it with a command; never put a file in
  `.kodel/pipelines` yourself and never run that command." The item that tells the agent to ask the person first
  says "for the pipeline of a run".
- `pipeline_docs`, topic `pipeline-design`: section 5 "Hand it over" is replaced by the hand-over through the tool
  (assumptions in `summary`, tell the person the command from the answer, propose again to change it), and a new
  short section "Changing an existing pipeline" (read it with `pipeline_resolve`, keep the name, change only what
  the person asked for, say in `summary` what differs). The test that parses every `yaml` block still holds; a new
  test checks that the topic names the tool and no longer tells the agent that the person saves the file.
- `AGENTS.md`: `pipeline proposals apply|discard` joins the commands an agent does not run and the Layout line of
  `packages/cli`; principle 6 says "accepting a new or changed pipeline".
- `.claude/settings.json` (the person's file; the agent does not edit it): the proposed deny rules
  `Edit(.kodel/proposals/**)` and `Write(.kodel/proposals/**)` are listed in the PR description for the person.
  The existing `Edit|Write(.kodel/pipelines/**)` rules already keep an agent from writing a pipeline itself.

## Affected files

- core: `packages/pipeline-core/src/service.ts` (host methods, outcome type, the `proposeChange` and `resolve`
  branches), `src/new-pipeline.ts` (new), `src/index.ts`, `src/mcp/tools.ts` (arguments, descriptions,
  instructions), `agent-docs/pipeline-design.md`
- local: `packages/local/src/store.ts`, `src/pipeline-host.ts`
- cli: `packages/cli/src/cli.ts`
- rules: `AGENTS.md`, `.gitignore`
- tests (below), `tests/agents/claude-code-docs.test.ts`

## Steps

1. Core: `new-pipeline.ts`, the outcome type, the optional host methods, the `proposeChange` and `resolve`
   branches, the tool arguments and descriptions, `SERVER_INSTRUCTIONS`.
2. Local: the store functions, `resolveSource`, `proposePipeline`, `acceptPipelineProposal`,
   `discardPipelineProposal`, `pipelineProposals`, `pipelineProposal`, `hasPipelineProposal`.
3. CLI: `pipeline proposals show|apply|discard`.
4. Docs: `pipeline-design` (hand-over and the new section), `AGENTS.md`, `.gitignore`.
5. Tests, then `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.
6. Run the real-agent scenarios once with `KODEL_AGENT_TESTS=1`.

## Tests

Names use the `tNN_` placeholder until the person records the decision id.

- Core (`new-pipeline.test.ts`, a minimal host; the snapshot in `service.test.ts`):
  `tNN_a_new_pipeline_is_proposed_without_a_run`; `tNN_a_host_without_the_method_refuses`;
  `tNN_taking_a_proposal_back_names_it_and_a_refusal_is_not_a_throw`;
  `tNN_resolve_without_a_run_returns_the_text_and_its_hash` (and falls back to the spec for a host without
  `resolveSource`); `tNN_the_tool_and_the_instructions_name_the_proposal` (snapshot updated); the name rule,
  the invisible-character rule and `commandsOf` as pure functions. Whether a name in use is a change, an invalid
  YAML is refused with the parser's message and a name that is not a file name is refused are the host's
  decisions, so they are tested at the local host below.
- Local (`packages/local/test`): `tNN_a_proposal_is_kept_apart_from_the_pipelines_that_run` (not in `list()`, not in
  `pipelines/`); `tNN_a_second_proposal_of_the_same_name_replaces_the_first`; `tNN_a_secret_in_the_text_is_refused`;
  `tNN_a_change_that_differs_in_nothing_is_refused`; `tNN_a_stem_taken_by_an_invalid_file_is_refused`;
  `tNN_accepting_a_new_pipeline_writes_the_file_and_it_can_be_started`;
  `tNN_accepting_a_change_replaces_the_existing_file`; `tNN_accepting_refuses_when_the_text_moved`;
  `tNN_accepting_a_change_refuses_when_the_file_moved_since`;
  `tNN_accepting_a_new_pipeline_refuses_when_the_name_was_taken_meanwhile`;
  `tNN_more_than_ten_waiting_proposals_are_refused`; the stored record has `v`; a record that is not whole, whose
  text is not a pipeline, or that holds an invisible character is refused on accept and can still be dropped;
  stems are compared without regard to case; a new file is created exclusively, and a changed file is read once
  more right before it is replaced.
- Runs: `tNN_an_accepted_change_does_not_reach_a_run_in_a_worktree` (its spec hash and pending change are
  unchanged); `tNN_an_accepted_change_is_noticed_by_a_run_in_the_repository` (a pending change of source `file`);
  `tNN_start_asks_which_version_after_an_accepted_change` (the `choice` answer, in a git repository).
- CLI (`packages/cli/test`): `tNN_the_real_program_with_no_terminal_refuses_to_accept_a_pipeline_proposal`
  (spawned without `KODEL_ENGINE`, as the existing test for `changes`); `tNN_inside_an_engine_command_it_refuses`;
  `show` prints the full text, the per-step differences for a change, and the commands block with new or changed
  commands marked; `apply` with a fake confirmation writes the file; `discard` removes the record.
- Docs: the existing "every `yaml` block parses" test; `tNN_pipeline_design_hands_over_through_the_tool`.
- Real agent (`tests/agents/claude-code-docs.test.ts`):
  1. New pipeline: turn 2 now expects a `pipeline_propose_change` call with no `run_id`, a record of kind `new` in
     `.kodel/proposals` that parses, **no** file in `.kodel/pipelines`, no `pipeline_start`, and the final text
     containing `pipeline proposals apply`. The test then plays the person (the host's accept method, the call the
     CLI makes) and checks `pipeline_list` shows the pipeline.
  2. Change: a sandbox with an existing pipeline and the request "raise the timeout of the test step to 600
     seconds". Expected: a `pipeline_resolve` call without `run_id` before the proposal, a `pipeline_propose_change`
     without `run_id`, a record of kind `change` whose `base_hash` matches the file, the file on disk untouched
     and no `Edit`/`Write` on it. After the test accepts it, the file has the new timeout and the other steps are
     unchanged.

## Risks

- **A pipeline is code the engine runs.** Its `command` nodes run in the person's shell, and a change can slip one
  in. The only barrier is the person reading it, so `show` and the confirmation print the whole text, the commands
  in a separate block, and for a change the commands that are new or different. Trusting pipelines (T-1) stays a
  separate, open decision.
- **Two modes in one tool, and "new" against "change" decided by the name.** An agent may call it without `run_id`
  while a run is going, meaning to change the run's pipeline: it then gets a project-level proposal for the same
  name. Mitigation: the descriptions say which mode is which; the answer states `kind`; the real-agent scenarios
  and the existing scenario for run changes must pass. A typo in the name makes a "new" pipeline instead of a change;
  the answer's `kind` and the `show` output make that visible.
- **The agent writes the file itself.** The engine cannot stop it where no deny rule exists (the adapters are
  empty). The instructions forbid it; the deny rules are the person's to add. Same limit as for run changes.
- **Floods and stale records.** A limit of 10 waiting proposals and the size limit bound it; `show` lists them and
  `discard` removes one. No expiry in this version.
- **A hash of the raw text.** `base_hash` is of the file's text, so a reformat by the person after the proposal
  makes the proposal stale and the agent proposes again. That is the safe direction.

## Follow-ups (not in this change)

- Warnings for commands the project does not have (`npm|bun|pnpm|yarn run <script>` against `package.json`, a
  program not on `PATH`): returned in `pipeline_proposal.warnings`. The optional field is in the type from the start
  and is left unset until this is built.
- Withdrawing a proposal through the tool if the `name` argument proves clumsy.
- Option C, a recorded `bootstrap` run, when there is a reason to want the history of how a pipeline was made.
- The thin `skills/design` (step 3): ask once whether to set the pipeline up together or let the agent build it,
  read `pipeline_docs`, explore, propose.

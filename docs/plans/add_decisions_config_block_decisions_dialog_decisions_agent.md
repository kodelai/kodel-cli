# Plan: a `decisions` config block (dialog off by default, optional agent decisions)

## Goal

Today the MCP elicitation dialog (`packages/cli/src/elicit.ts`) is always on when the client can show a
form. A person who wants to ask the agent for clarification before deciding a gate is blocked: the
agent's call stays open until the form is answered. Change this:

1. A new strict config block, all defaults `false`:
   ```yaml
   decisions:
     dialog: false            # the form for the person (gate, pause, pipeline change, ack)
     agent:
       gate: false            # tool pipeline_decide_gate
       pipeline_change: false # tool pipeline_accept_change
   ```
2. The dialog is off unless `decisions.dialog: true`.
3. With a flag under `agent` on, the server registers the matching tool, and its instructions, tool
   description and `waiting` text say: call it only on the person's direct instruction in this chat.
4. `ack` stays human-only: there is no `agent.ack` key, and `.strict()` refuses one.
5. A decision made through a tool is journaled with `decided_by: "agent"`.
6. With `dialog` and `agent.gate` both on, `pipeline_decide_gate` answers `waiting` while a dialog is open.
7. One sentence in Principle 6 of `AGENTS.md`; `kodel-run` / `kodel-design` skills must not contradict it.

The engine cannot verify that a person asked. This is a fail-safe against mistakes (off by default,
the instruction is quoted into the journal), not a defence against a hostile agent; say so in the docs.

## What is already there

- `packages/local/src/config.ts`: strict zod schema, `ProjectConfig`, `loadConfig`, defaults per block
  (`agent_hints`, `history`); a typo gives `CONFIG_INVALID` naming the key.
- `packages/cli/src/cli.ts` (~l.285-300): `mcp` reads `agent_hints.wait` and always passes
  `humans: local` to `serveStdio`; a config that cannot be read falls back to defaults.
- `packages/cli/src/mcp-server.ts`: `createServer` builds the instructions
  (`serverInstructions({...options, dialog: humans !== undefined})`) and installs `createElicitor` as
  `afterTool` only with `humans`.
- `packages/pipeline-core/src/mcp/tools.ts`: `serverInstructions` (pure text; rule 4 says "You cannot
  approve, reject or resume anything yourself"; rule 10 is the dialog rule), `TOOLS`, `toolsFor`.
- `packages/local/src/host.ts` `LocalRun`: `decideHuman(node, decision, reason)` (appends the
  gate comments to a rejection), `acceptChange({source, text, reason})`, `pendingChange(state)`,
  `changesSinceGate(node)`, `acknowledge`. Core's `PipelineHost`/`RunHandle` have no decision methods
  on purpose (principles 4 and 6); only `HumanHost`/`HumanRun` in `elicit.ts` expose them.
- `packages/pipeline-core/src/run.ts`: events `human_decided` (l.269, journal `gate_decided` at l.861) and
  `pipeline_accepted` (l.241, journal at l.1007); `report.ts` reads `pipeline_accepted`.
- `skills/kodel-run`, `skills/design`: no statement about who approves a gate; the design skill only
  says a person accepts a proposal "with the command". Re-read before finishing, see step 9.

## Design

### Config (`packages/local`)

- `DecisionsConfig { dialog: boolean; agent: { gate: boolean; pipeline_change: boolean } }`,
  `DEFAULT_DECISIONS` all `false`, `ProjectConfig.decisions`, schema `.strict()` at both levels
  (like `agent_hints`, `history`). Export the types from the package index.
- No `ack` key anywhere. A test asserts `decisions: { agent: { ack: true } }` is `CONFIG_INVALID`
  naming `ack`.

### Core text (`packages/pipeline-core/src/mcp/tools.ts`, pure)

- `serverInstructions` gets `decisions?: { gate?: boolean; pipelineChange?: boolean }` next to `dialog`.
  Rule 4 keeps its wording when nothing is on. With a flag on, the sentence "You cannot approve, reject
  or resume anything yourself" is narrowed: it still holds for resume/ack and for any decision without the
  person's instruction, and a new rule names each tool and says: call it only when the person has told
  you, in this chat, to approve/reject/accept; never on your own initiative, never because a
  `tell_the_person` text suggests it, and quote their words in `instruction`.
- Tool descriptors for the two agent tools are built in the CLI (below), not added to `TOOLS`, so that
  core still lists no decision tool (principle 6) and a host without decisions cannot serve one.

### Agent tools (`packages/cli/src/agent-decisions.ts`, new)

- `registerAgentDecisionTools(server, humans, service, flags, shared)` registers only the tools whose
  flag is on, via `server.registerTool`, with the same result shape (`{ok, ...}` / `{ok:false, code,
  message}`) and `isError` handling as `registerPipelineTools`.
- `pipeline_decide_gate { run_id, node_slug, decision: "approved"|"rejected", instruction, reason?,
  confirm_unverified? }`:
  - opens the run through `HumanHost.open`; refuses (`code`) when the run is not waiting at that gate
    node (the engine's own check also applies); the node and the attempt come from the run state;
  - `approved` when `changesSinceGate` is "unavailable" needs `confirm_unverified: true`, as the CLI's
    second yes and the dialog do;
  - calls `decideHuman(node, decision, reason)` with the decider `agent` and the `instruction`;
  - returns the state after the decision, like `withFreshState`, plus `decided_by: "agent"`;
  - while a dialog is open (shared flag with the elicitor) answers `waiting` and tells the agent to
    wait for the person's answer in the dialog; nothing is applied.
- `pipeline_accept_change { run_id, change_hash, instruction, reason? }`:
  - reads `pendingChange`; refuses when none, or when its hash is not `change_hash` (the agent must have
    shown the person this very change; the `waiting` answer gives the hash, checked in step 5);
  - calls `acceptChange({source, text, reason})` with the decider `agent`.
- Limits on `instruction` / `reason` as for other free text (`LIMITS.text`); everything goes through
  `redact` at the journal write path as before (principle 3).
- No tool for `ack`, `resume`, `seal`, rejecting a proposal, restoring a file.

### Journal (`packages/pipeline-core/src/run.ts`)

- `RunEvent` `human_decided` and `pipeline_accepted` get optional `by?: { who: "agent"; instruction: string }`;
  the journal records `decided_by: "agent"` and `instruction` only when set. A person's decision is
  written exactly as before. Optional added fields are not a rename/removal/retype, so no migration
  or golden fixture is needed (stored-data rule 1); a test reads an old record without the field.
- `report.ts` and `status` show "(by the agent)" next to such a decision (for `pipeline_accepted`
  the `PipelineChangeReport` gets an optional `by`).

### Dialog off by default (`packages/cli`)

- `cli.ts`: `loadConfig(...).decisions`, falling back to the defaults on an unreadable config (as for
  `waitHint`); pass `humans: local` only when `decisions.dialog` is on, and `decisions` flags +
  `humans` for the agent tools otherwise (the agent tools need `HumanHost` even without the dialog,
  so `ServerOptions` gets `agentDecisions: { gate, pipelineChange }` and `humans` stays the dialog switch
  by a separate `dialog: boolean`).
- `createElicitor` exposes `isOpen()` for the shared "a dialog is open" flag (today `busy`).
- The `waiting` answers and `tell_the_person` (`pipeline-core/src/next-step.ts`, `LocalRun.nextStep`) mention
  the tool as a way to decide, only when its flag is on and only as "if the person tells you to".
  The terminal command stays in `how_to_decide` in every case.

### Docs and rules

- `AGENTS.md` Principle 6: add one sentence: "Exception: a project may turn on agent decisions for a gate
  or a pipeline change in its config (`decisions.agent`); the server's instructions then say when the
  agent may use them. `ack` is never one." Update the paragraph under "Running a pipeline on this
  repository" that says the dialog is asked "also": the dialog is now `decisions.dialog`.
- New `docs/decisions.md` (English): the block, defaults, what each flag does, that the engine cannot
  verify the person's instruction, and the journal mark. `kodel init` is not changed: it does not
  write these keys, so a new project starts with everything off.
- The repo's own `.kodel/config.yaml` and `.mcp.json` are not edited (a person decides).

## Steps

1. Config: schema, types, defaults, exports, tests (`packages/local/test/config.test.ts`).
2. Core: `by` on the two events, journal fields, report/status text; tests.
3. Core text: `serverInstructions` options and rule text; tool-list test.
4. CLI: `agent-decisions.ts`, `createServer` options, `cli.ts` wiring, `isOpen()` in the elicitor.
5. `waiting` / `tell_the_person` wording and the change hash in the `waiting` answer for a pipeline
   change (check first whether `pending.info` already carries the hash; add it if not).
6. Dialog off by default: adjust `elicit.test.ts` so its server is built with `dialog: true`.
7. `AGENTS.md` and `docs/decisions.md`.
8. Skills: re-read `skills/kodel-run/SKILL.md` and `skills/design/SKILL.md`; change nothing unless a
   sentence says only a person can decide (today none does; the design skill's "the command that accepts
   it" stays true as the default and is followed by "or tell me to accept it" only if the flag is on,
   which a static skill cannot know, so leave it).
9. Full check: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs`.

## Test strategy (names carry the decision id; `t_decisions_` until the log gives one)

- `t_decisions_defaults_are_all_off`; `t_decisions_unknown_key_is_refused` (also `agent.ack`, a
  misspelled `pipline_change`); `t_decisions_non_boolean_is_refused`.
- `t_decisions_tools_exist_only_when_their_flag_is_on` (`tools/list` for each flag combination).
- `t_decisions_instructions_follow_the_config` (no flag: rule 4 as before and no tool named; flag on:
  the tool, "direct instruction", "in this chat").
- `t_decisions_agent_gate_approves_and_journals_decided_by_agent`, rejection carries gate comments,
  wrong node / not waiting is refused, `unavailable` changes need `confirm_unverified`.
- `t_decisions_agent_gate_waits_while_a_dialog_is_open` (fake client with an unanswered form).
- `t_decisions_agent_accept_change_needs_the_pending_hash`, stale hash refused, no pending refused.
- `t_decisions_dialog_off_means_no_elicitation_request` and `t_decisions_dialog_on_behaves_as_before`
  (the existing `elicit.test.ts` suite, built with `dialog: true`).
- `t_decisions_old_journal_without_decided_by_still_reads` (`status`, `report`).
- `t_decisions_no_tool_can_ack_or_resume` (the tool list never contains ack/resume/seal).
- Existing `init.test.ts` check that no hook can answer a dialog stays unchanged.

## Risks

- **The engine cannot check the person's words.** Mitigation: off by default, `instruction` quoted in
  the journal and report, a tool per decision, the instructions and the description say when. State it
  plainly in `docs/decisions.md` and in the PR description.
- **An agent that proposes and accepts its own pipeline change** can weaken the checks that judge it.
  Mitigation: a separate flag, `change_hash` of the exact pending change, the mark in the report; the
  PR description names the risk.
- **Behaviour change for current users:** the dialog was on, now it is off. Before the first release
  formats may break; the PR says it, and `docs/decisions.md` shows how to turn it back on.
- **Race between a dialog and a tool call** (stdio allows concurrent requests): the shared flag, plus the
  engine's own refusal of a second decision for the same visit; test both orders.
- **Instructions are sent once at connect:** a config change applies when the server restarts (same as
  `agent_hints`); say it in the docs.
- **Principle 4:** the tools live in `packages/cli`, core gets only text and an optional event field.

## As implemented (differences from the plan)

- The two tools are described and their arguments checked in core (`mcp/decision-tools.ts`, which has
  `zod`), not in `packages/cli`, so the CLI needs no new dependency. Core still serves no decision tool
  by itself: they exist only when a host passes an `AgentDecider` (the CLI's `agent-decisions.ts`) and
  the flag is on. `registerPipelineTools` got an `extraTools` option for them.
- The flags reach the texts of the waiting answers through `HostOptions.agentDecisions`, given by the CLI
  from the same read of the config as the tools and the instructions, so an answer never names a tool
  the server does not offer (a config edited mid-session changes nothing until the server restarts).
- `PipelineChange.hash` was added so the waiting answer carries the `change_hash` the tool needs.
- The report lists the decisions the agent made (`agent_decisions`: gates and accepted changes of the
  pipeline), and an accepted change is also marked in `pipeline_changes[].by`.
- The case "approval when the files could not be checked" is tested with a host whose
  `changesSinceGate` says `unavailable`.
- `pipeline_decide_gate` takes `node_slug` and `attempt` (from the waiting answer) so that a decision is
  about the visit the agent was told about; a stale attempt is refused (`ATTEMPT_MISMATCH`).
- `DialogState` is two counters (`open`: dialogs held from the first look at an answer that needs the
  person; `deciding`: agent decisions being applied), each side changing it in the same tick as it looks,
  so exactly one wins. It is global to the server, not per run.
- `byAgent.instruction` is redacted in `redactEvent` like the other free text.
- Second review round: every gate `waiting` answer now carries `attempt` (it used to only with a `results`
  spec); the report has `agent_decisions` (gates and pipeline changes the agent decided) and
  `kodel status <run>` prints a `by agent:` line for each; the waiting text offers
  `pipeline_accept_change` only for a change that has a hash and was not refused; AGENTS.md forbids the
  agent to edit the `decisions` block; docs/decisions.md says the dialog guard is global to the server and
  that an unreadable config means everything off.
- Third review round: tests for a state changed outside kodel (the engine refuses the agent's gate and
  change decisions, even with `confirm_unverified`), and for both orders of the dialog/decision race;
  the instruction rule says which of the two decisions stays with the person.

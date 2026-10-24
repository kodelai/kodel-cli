# Plan: ask the person at a gate / ack through MCP elicitation

## Goal

Today a person decides a gate with `kodel gate approve|reject <run>` and accepts a changed state with
`kodel ack <run>`, in a terminal. Make the decision possible in the coding agent's own UI: when the run
is waiting at a human step (gate), or its state was changed outside kodel (ack), the `kodel mcp` server
sends `elicitation/create` to the client, the person answers in the dialog the client shows, and the
server applies the decision.

Hard requirements (from the task):

- Only when the client declared the `elicitation` capability (form mode) at initialize. Otherwise
  nothing changes: the `waiting` answer and the CLI commands stay exactly as they are.
- Fail closed: `decline`, `cancel`, a timeout, a transport error, a malformed or schema-invalid answer
  never approve, never reject, never ack. The run stays waiting and the CLI still works.
- Principle 6: the answer comes from the client to the server. There is no `pipeline_*` tool that takes
  a decision, and nothing the agent sends (tool arguments, text) is read as the answer.

## What is already there (relevant facts)

- `packages/cli/src/cli.ts`: `gate` and `ack` do the human work: `requireHuman()`, `refuseWhilePending`,
  `changesSinceGate` (files changed since the run stopped; "unavailable" needs a second yes),
  `gateResults` (comments the agent recorded, sent back with a rejection), then
  `LocalRun.decideHuman(node, approved|rejected, reason)` / `LocalRun.acknowledge(note)`
  (`packages/local/src/host.ts`), then `afterDecision`.
- `packages/cli/src/mcp-server.ts`: `createServer` builds the `McpServer` and registers the tools from
  `@kodel-ai/pipeline-core/mcp`; `serveStdio` owns the process. `PipelineHost`/`RunHandle` in core have
  no decision methods on purpose; they exist only on `LocalRun`.
- The gate is reported to the agent by `nextStep` as `waiting: { reason: "gate", ... }`
  (`pipeline-core/src/next-step.ts`, extended with changes/comments in `LocalRun.nextStep`).
  A modified state surfaces as `STATE_MODIFIED_EXTERNALLY` ("accept it with kodel ack").
- MCP SDK 1.32.1 (`Server.elicitInput`, `getClientCapabilities()`); it already checks the form
  capability and validates an accepted answer against `requestedSchema`.
- `main` has moved on: `kodel wait <run>` (PR #9) lets the agent be woken when the person has decided,
  and a project can switch the hint off (`agent_hints`). The run worktree was cut before it, so the
  implementation step starts by merging `origin/main`.

## Design

### Where the code lives

- New module `packages/cli/src/elicit.ts` (name open): the human-decision flow over elicitation. It uses
  `LocalPipelineHost`/`LocalRun`, so it stays out of `pipeline-core` (principle 4: core knows no
  transport and no decision API). `createServer` gets an optional `decide` collaborator; `cli.ts` passes
  it when the host is local. A host that cannot decide (a future Kodel Server) passes nothing.
- The CLI's question-building (changed files, comments, warning text) moves into a shared helper that
  both `gate` and the elicitation use, so the two surfaces show the same facts. No change of behaviour
  of `gate`.

### What is asked

Form-mode schema, flat (Codex accepts only flat objects with primitive fields):

- Gate: `decision` (enum `approve` | `reject`), `reason` (string, optional; required for `reject`
  unless comments were recorded), `confirm_unverified` (boolean, shown only when the engine could not
  tell what changed since the gate; `approve` needs it true, as the CLI's second yes does).
- Ack: `confirm` (boolean), `note` (string, optional).
- The `message` carries: run, step, the prompt of the step, the changed files (capped as in
  `waiting.changes`), the comments that will go back with a rejection, a warning when the changes could
  not be checked, and a pending pipeline change if there is one.
- Everything the agent could have influenced (step prompt text from a pipeline the agent proposed,
  recorded comments, file names, error text) goes through the same `plain()` sanitising the CLI uses and
  is labelled as recorded by the agent. The dialog never contains a value that the agent can phrase as
  "already approved".

### When it is asked (two triggers, spike decides)

A. **Inline**: `pipeline_next_step` / `pipeline_complete_step` is about to answer `waiting: gate` (or
   `STATE_MODIFIED_EXTERNALLY`); the tool handler, inside that request, awaits the elicitation and
   answers with the state after the decision. The agent continues without anyone telling it. Risk:
   the tool call stays open while the person reads (client tool timeouts, `MCP_TOOL_TIMEOUT`).
B. **Out of band**: the answer is returned at once as today, and the server sends the elicitation on its
   own. The agent has ended its turn or runs `kodel wait` (already in `main`), which wakes it when the
   state changes, whichever surface decided. Risk: a client may show a server-initiated dialog only
   during a tool call.

Spike first (step 1 below): a throwaway server that sends one elicitation both ways, against Claude
Code, Codex and opencode. The result picks the trigger: start with A; B only if the spike shows that
tool timeouts cut A short and that the client shows a dialog outside a tool call. A client that does
neither stays on the CLI.

### Safety rules

1. The decision is applied only from an `action: "accept"` answer that validated against the schema we
   sent. `decline` is not a rejection: nothing is recorded and the run stays waiting. (A person who
   wants to reject picks `reject` and gives a reason.)
2. The prompt is shown at most once per (run, node, attempt) per server process. A decline/cancel is
   remembered, so an agent calling `pipeline_next_step` in a loop cannot make the dialog reappear; the
   CLI remains the way to decide afterwards. A change of attempt (the step ran again) asks again.
3. One elicitation at a time per server; calls arriving meanwhile get the normal `waiting` answer.
4. Same refusals as the CLI: no decision while a pipeline change is pending (`refuseWhilePending`)
   unless the person's answer says so; re-read the run state right before applying (the step may no
   longer be waiting; the dialog may have been open for a long time) and apply through
   `decideHuman`, which the state machine itself checks.
5. The journal event is the same `human_decided` / `acknowledge` as from the CLI; nothing records
   which surface decided (decided by the person: it makes no difference).
6. `ack` is a trust decision about a state somebody changed: the dialog says what the engine knows
   (the error text, which files differ if it can tell) and does not offer a one-click default. The
   agent can trigger it by tampering with a file, so the text states "the agent cannot tell you this
   is safe; look at the run before accepting".
7. A client hook that answers elicitations automatically (Claude Code `Elicitation` hooks) is the
   person's configuration. `kodel init` must not register one, and the agent must not edit
   `.claude/settings*.json` (already a repository rule). A test pins that init writes no such hook.

### Instructions to the agent

`SERVER_INSTRUCTIONS` and the `tell_the_person` texts say: "the person may be asked in a dialog
(elicitation) instead of the terminal; you still cannot decide". With trigger A the answer after the
dialog carries what happened (`decided`, `declined`, `not_asked`) so the agent reports it. Keep
`how_to_decide.cli` in every waiting answer: it is the fallback.

## Steps

1. Spike (not merged): minimal server + Claude Code, Codex and opencode; record whether a dialog appears during and
   outside a tool call, how long it can stay open, what decline/cancel/timeout return. Write the
   findings in the PR description.
2. Merge `origin/main` into the run branch.
3. Extract the shared "what to show the person" helper from `cli.ts` (`gate`, `ack`); tests for `gate`
   stay green unchanged.
4. Implement `elicit.ts`: capability check, schema, message, answer handling, remembered declines,
   single-flight, timeout (abort signal; default long, configurable later).
5. Wire into `createServer`/`serveStdio` and the chosen trigger (A, or B with A as fallback). Nothing
   registered when the client lacks the capability, and no new tool is added to the agent surface
   (the tools snapshot test stays unchanged).
6. Texts: server instructions, `tell_the_person` for gate, `docs/` (a short section next to the
   gate description once the English docs exist; until then the PR description).
7. Typecheck, lint, tests, `bun run build && node scripts/check-artifact.mjs`.

## Test strategy

Test names carry the decision id when one applies (ids from the local decision log; the id for this
change is to be filled in by the person, otherwise a descriptive name).

In-process, with the MCP SDK `Client` over `InMemoryTransport` (as `packages/local/test/mcp.test.ts`)
and the client declaring `capabilities: { elicitation: { form: {} } }` with a scripted handler:

- accept + approve → run moves on; journal has `human_decided`; answer to the agent shows it.
- accept + reject with a reason → run goes back; without a reason and without comments → not applied,
  the answer is a validation error shown again or treated as no decision (decide in step 4).
- decline, cancel, handler throws, handler never answers (timeout), response with extra/missing fields
  or wrong types, `approve` while the changes are unverifiable and `confirm_unverified` false → no
  event, run still waiting, `waiting` answer unchanged.
- client without the capability → no `elicitation/create` is sent, the answers are byte-for-byte what
  they are today (golden comparison with the current output).
- repeat `pipeline_next_step` after a decline → no second dialog; new attempt → dialog again.
- state changed after the dialog opened (step already decided from the CLI) → the late answer is
  refused, nothing applied twice.
- pending pipeline change → no decision through the dialog.
- adversarial agent (testkit): text with fake "approved" in the prompt, comments, file names, tool
  arguments named `decision`/`approve`; none of it reaches `decideHuman`. The tools list is unchanged:
  no tool takes a decision.
- ack: modified state → dialog; accept applies `acknowledge`; decline leaves `STATE_MODIFIED_EXTERNALLY`.
- `kodel init` writes no `Elicitation` hook (Claude Code settings) — pinned.
- CLI `gate`/`ack` tests unchanged and green (same text through the shared helper).
- Real agents (`tests/agents`, opt-in): one scenario each for Claude Code and Codex if the spike shows
  the dialog works there.

Refutation criterion: if a client shows server-initiated dialogs only in a tool call and also times the
call out before a person can realistically answer, then neither trigger works for that client and it
stays on the CLI; the feature is then documented as per-client rather than forced.

## Risks

- Client behaviour differs (timeouts, when a dialog is allowed, flat schemas only, opencode support is
  weakly sourced). Mitigation: spike first, capability check, CLI always works.
- A dialog is a lower-friction approval than a terminal command, and the agent decides when it appears.
  Mitigation: at most once per attempt, facts shown by the engine not the agent, the agent's words
  labelled, unverifiable changes need an explicit confirm, `ack` text is blunt.
- Auto-answering client hooks would turn the dialog into an agent-controlled approval. Mitigation:
  they are configuration the agent may not edit; `init` does not add them; documented.
- Behaviour while the run is also decided by the CLI at the same time: handled by re-reading state and
  by the state machine refusing a second decision.
- Overlap with `kodel wait` (just merged): the two must agree on "who decided". Mitigation: both watch
  the run state, not each other.
- The scope is four decision kinds instead of two (see "Added to the scope"); each is a trust
  decision, so each one is tested for fail-closed behaviour separately.

## Decisions of the person (at the plan gate)

1. The journal does not record which surface decided: it makes no difference where the person
   answered. No new field on `human_decided` / `acknowledge`; no stored-format change.
2. `ack` goes through the dialog, with the blunt text.
3. The spike against real Claude Code and Codex sessions is step 1 and is accepted.
4. Trigger: decided by the spike; start with A (inline), because a dialog inside a tool call is the
   case every client has to render; B is the optimisation if tool timeouts get in the way.
5. `resume` and the acceptance of a change of a run's pipeline are in scope now (see below).
6. opencode is checked in the spike like the others.

## Added to the scope: resume and pipeline changes

The same flow, the same rules (capability, fail closed, once per visit, facts from the engine, state
re-read before applying), for two more decisions that are a person's today:

- `resume` of a paused run (`waiting.reason: "paused"`): dialog with the step that stopped the run and
  why, one boolean `confirm`; accepted → `LocalRun.resume()`.
- Acceptance of a change of the run's pipeline that waits (`waiting.reason: "pipeline_changed"` or the
  `pipeline_change` note): dialog with the engine's own description of the change (`effect`, `redo`,
  what stays as is), `decision` enum `apply` | `discard`; accepted → the same call as
  `kodel pipeline changes apply|discard`. A change the engine refused (cannot be accepted) is not
  offered. The agent's `summary` of the change is shown labelled as the agent's words.

Not in scope: proposals outside a run (`kodel pipeline proposals apply|discard`) and `seal`; they
can use the same module later.

`elicit.ts` therefore holds one small table of decision kinds (gate, ack, resume, pipeline change),
each with: how to detect it from the run state, the schema, the message, the call that applies it.
Tests of the "Test strategy" section are repeated for each kind where they apply, and "no tool takes a
decision" covers all four.

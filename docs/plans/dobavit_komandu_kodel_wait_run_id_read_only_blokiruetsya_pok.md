# `kodel wait <run>`: tell the agent, without spending tokens, when the person has decided

## Goal

When a run waits for a person (a gate, a pause, a pipeline change to accept), the agent writes the
person the command and ends its turn. Nothing wakes it afterwards: the person has to go back to the
agent and say "done". We want the agent to be woken **by the event**, not by a timeout.

Add a read-only command `kodel wait <run>`. It stays until the run stops waiting for the person (or
its own `--timeout` runs out), prints **one line** about what happened, and exits. It decides nothing
and writes nothing. An agent that can run a background command (Claude Code: the Monitor tool)
starts it, ends its turn, and is woken once when the line arrives. While the person is away, no model
call happens.

Out of scope, decided with the person:

- No long-poll through MCP (`pipeline_next_step` with `wait_s` on a `waiting` answer). It wakes the
  agent on every timeout and spends tokens for as long as the person is away.
- No per-agent wake hooks on `gate` / `ack` / `resume` (they would resume an agent session from the
  decision command). Maybe later, in `adapters/`.
- Other agents (without a Monitor-like tool) are only *told* that `kodel wait` exists; each decides
  by itself how to use it. The engine does not know which agent it talks to.
- A closed agent session is a known limit, not a problem to solve: the person tells the agent to
  carry on (or starts it again with `kodel-run`).

## Affected files

- `packages/cli/src/cli.ts`: the `wait <run>` command with `--timeout`. Not human-only: it must
  **not** call `requireHuman()` (it has to run from an agent's background command, without a
  terminal). It only reads, like `status`.
- `packages/pipeline-core/src/next-step.ts`: the `tell_the_person` texts of the three `waiting`
  answers (`gate`, `paused`, `pipeline_changed`) get one more sentence about `kodel wait <run_id>`.
  The texts are constants today; the sentence needs the run id, so they become small functions of the
  run id (or the sentence is appended where `state.runId` is at hand: `baseStep`, `changedWaiting`).
  The core stays free of I/O: only text.
- `packages/pipeline-core/src/mcp/tools.ts`: instruction 4 of the server's instructions
  (`waiting` answer) and the `pipeline_next_step` tool description: say that the agent may start
  `kodel wait <run_id>` to be told when the person has decided, and must not poll
  `pipeline_next_step` in a loop while it waits.
- `AGENTS.md`: the rule "Do not run `gate`, `ack`, ..." stays; add that `kodel wait` is allowed and
  is the way to wait. Also the "Humans" paragraph lists the commands: mention it.
- Check `adapters/` and `skills/` (and `.claude/skills/kodel-run`) for text that repeats the
  `waiting` instructions; update only if it does.
- `tests/agents/harness.ts` (a `kodel` shim on the agent's `PATH`) and a new
  `tests/agents/claude-code-wait.test.ts`: the real-agent scenario, see "Test strategy".
- Tests: `packages/cli/test/cli.test.ts` (and a `next-step` / MCP-instruction test next to the
  existing ones). No new dependency. No stored format changes (the command reads `state.json` and
  `journal.jsonl` as they are), so no golden fixture is needed.

## Design of the command

`kodel wait <run> [--timeout <seconds>]`:

1. Open the run (`openRun`, as `status` does; an unknown run is a `UserError`).
2. Read `run.inspect()` (read-only: it does not restart work and writes nothing, as `status` relies
   on). If the result is not `waiting`, print the current state in one line and exit 0 at once. The
   agent may have been slow, and the person may have decided before the command started; it must
   never hang on a run that is not waiting.
3. Otherwise remember the *waiting key* (`reason`, `node_slug`, `attempt`) and the last journal `seq`.
   Poll every second (`inspect()` plus the state read). Stop when the run is no longer waiting, or
   the key differs (a new gate after a rejection is a new wait: that is something to report, the
   decision of the old one has happened).
4. Print one line and exit 0, built from the journal records after the remembered `seq`:
   - `gate_decided` -> `approved` or `rejected` (with the node);
   - `run_resumed` -> `resumed`;
   - `pipeline_accepted` -> `change accepted`;
   - the run ended (`run_finished`) -> its status (`completed`, `failed`, `canceled`);
   - anything else -> `describeRun(state)`, the same words `status` uses.
   The line starts with the run id and ends with a pointer for the agent:
   `r_...: approved at "approve". Call pipeline_next_step.` It is passed through `plain()` like all
   other output (a reason written by a person may hold control characters), and a rejection reason is
   not repeated (it goes back to the agent through `pipeline_next_step`).
5. Exit code: 0 whenever it reports a decision or a state, 1 for an error (unknown run, unreadable
   state, a bad `--timeout`), as other commands do through `UserError`.

### `--timeout`

- `--timeout <seconds>`: a whole number, at least 1, or `0` for no limit. Anything else is a
  `UserError` that says what is accepted.
- **Default: 28800 (8 hours).** A command that can hang forever in the background is a leak, but a
  short default would wake the agent again and again while the person is away, which is the cost we
  are avoiding. Long enough for a night, short enough not to live for weeks. The person who wants a
  different default passes the option; the number is the one thing in this plan to confirm.
- When the time runs out and the run still waits for the same thing, it prints one line and exits
  with code **2** (different from 0, "reported", and 1, "error"):
  `r_...: still waiting at "approve" (gate), nothing was decided in 8h. Not watching any more.`
  Nothing is written to the run.
- **What the agent is told to do on that line:** it was woken by the timeout, not by a decision.
  It must not start `kodel wait` again by itself (that would be a wake every time, the cost we are
  avoiding): it tells the person in one short sentence that it stopped watching and that they should
  tell it when they have decided, and ends its turn. Starting it again is for when the person asks.
- The clock is the host's (`Date.now` through the existing env/clock seam used for the other
  waits), so tests drive it with `pollMs` small and a fake or tiny timeout rather than real hours.

The polling interval is a constant (1 s). The CLI env gets an optional `pollMs` so that tests do not
wait whole seconds. To keep a long wait cheap, the journal is read only after the state or the
waiting key changes, not in every round.

Why a command and not a file watch by the agent: AGENTS.md and the server instructions forbid the
agent to read run files in `.kodel/runs`; one command that knows the format is the clean way, and it
keeps the format private to the engine.

Why this keeps the principles: it is read-only (principle 6: trust is not touched, the agent still
cannot approve, reject or resume), the core only gains text (principle 4), and nothing is written to
history (principle 3, principle 8).

## The text the agent gets

Appended to the three `tell_the_person` texts (and kept in the server instructions, instruction 4):

> To be told when the person has decided, without asking again and without spending tokens while you
> wait, you can run `kodel wait <run_id>`: it only watches, prints one line when the person has
> decided, and ends. In Claude Code start it with the Monitor tool, then end your turn; when it
> reports, call `pipeline_next_step`. If it reports `still waiting` (it gave up after its
> `--timeout`), nothing was decided: tell the person you stopped watching, do not start it again
> yourself, and end your turn. In another agent, wait in whatever way your tools allow. Do not poll
> `pipeline_next_step` in a loop. If you do not wait, end your turn as before: the person tells you
> when they have decided.

The wording keeps the old behaviour valid (end the turn and wait to be told) so an agent that cannot
run background commands loses nothing. The wording is not judged by eye: it is tested on a real agent
(next section) and changed until the agent does what it says.

## Steps

1. Spike, before any code: with the real `claude` binary, find out (a) whether the Monitor tool is
   offered in `-p` (headless) mode, (b) whether a `-p` process stays alive until a monitored command
   prints, so that it can be woken inside one process, and (c) what the agent is shown when a monitor
   fires. Write the answer at the top of `claude-code-wait.test.ts` as the reason for the shape of
   the test below. This decides between scenario A and scenario B; if neither can be built headless,
   say so and keep only the checks that can, and a manual scenario for the rest.
2. Tests first (names carry `tNN_` like the neighbouring tests; take the next decision id from the
   local notes when the code is written), see "Test strategy". They fail.
3. `wait` command in `cli.ts`: helper that classifies the end of a wait from the journal records;
   `--timeout`; `pollMs` in the CLI env.
4. `next-step.ts`: the wait sentence for `gate`, `paused`, `pipeline_changed`.
5. `mcp/tools.ts`: instruction 4 and the `pipeline_next_step` description.
6. `AGENTS.md` and, if they repeat the instructions, `adapters/` / `skills/`.
7. Run the real-agent scenario (`KODEL_AGENT_TESTS=1`), read what the agent did, and adjust the
   sentence until the scenario passes on the models the other agent scenarios use. Report the cost
   and the result in the summary.
8. `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Test strategy

### CLI (`packages/cli/test/cli.test.ts`, with the `DEMO` pipeline, `cliAs` for the person)

- `wait` on a run that does not wait (running or finished) returns at once with its status.
- `wait` at a gate blocks (still pending after a few poll rounds), then returns `approved` right
  after the person's `gate approve`; the same for `gate reject` (`rejected`, the reason is not in the
  line).
- `wait` on a paused run returns `resumed` after `resume`.
- `wait` while a pipeline change waits returns `change accepted` after `pipeline changes apply`.
- A rejection that leads to a new gate: `wait` returns on the rejection and a second `wait` waits for
  the new gate (the key comparison).
- `--timeout`: with nothing decided, `wait` prints the `still waiting` line and exits 2; a decision
  before the time runs out wins and exits 0; `--timeout 0` does not give up (checked by a decision
  that arrives after more rounds than any non-zero timeout in the test would allow); a missing,
  negative, fractional or non-numeric value is a `UserError` with exit 1; the default is 28800
  (checked on the parsed value, not by waiting).
- `wait` works without a terminal and inside a command the engine runs (`KODEL_ENGINE` set), where
  `gate` refuses; it writes nothing (hash of `state.json` and size of `journal.jsonl` unchanged),
  also when it times out.
- An unknown run id is a `UserError`, exit 1; a damaged state is the same error `status` reports.
- The output is one line and has no control characters from a hostile task or reason.
- The real program: spawn `bun packages/cli/src/main.ts wait <run>` with no terminal (as the existing
  "real program with no terminal" test does), decide in-process, see the line and exit code 0; and
  the same with `--timeout 1`, exit code 2.

### Core / MCP

- All three `waiting` answers contain `kodel wait <run_id>` with the right run id in
  `tell_the_person`, mention `--timeout`'s `still waiting` case, and the gate text still contains
  what the person must be told (the old checks keep passing).
- The server instructions mention `kodel wait` in instruction 4 and say not to poll in a loop; the
  existing instructions test (`pipeline_start`, `tell_the_person`, `wait_s`, `pipeline_feedback`)
  still passes.

### Real agent (`tests/agents/claude-code-wait.test.ts`, only with `KODEL_AGENT_TESTS=1`)

The wording of the sentence is judged by what a real Claude Code does with it, in the same style as
`claude-code-pipeline-change.test.ts` (sandbox, `runAgentTurn`, the person played by the test through
`humanHost`, the same calls the CLI commands make).

Harness changes: a `kodel` shim script in a directory of the sandbox, put first on the agent's `PATH`
(it runs `bun MAIN_TS --root <sandbox> "$@"`), because the text says `kodel wait` and the sandbox has
no installed binary; the allowed tools gain the Monitor tool and `Bash(kodel wait:*)`. `gate`,
`resume` etc. stay unavailable to the agent (they would refuse anyway).

Scenario A, *what the agent does at a gate* (always possible, one `claude -p` turn): the agent is
asked to run the mini pipeline up to its human step. Assertions: it starts `kodel wait <run_id>`
(through Monitor, or a background Bash command if that is what the spike shows is available) with the
right run id; it writes the person the decision command and does not run it; it does not call
`pipeline_next_step` again with `wait_s` in a loop (at most one call after the `waiting` answer); it
ends its turn without having touched `.kodel/runs` or the pipeline files.

Scenario B, *the wake* (only if the spike (b) shows a headless process can be woken): while the
agent's process is alive the test approves the gate through `humanHost`; assertions: the agent calls
`pipeline_next_step` after the event and goes on to the next step, and the number of model turns
between the `waiting` answer and the event is small (it did not poll). If the spike shows this is
not possible headless, scenario B becomes a **manual scenario** in the final summary (start a run in
interactive Claude Code, let it reach a gate, approve from another terminal, see it wake) and the
test file says why it is not automated.

Scenario C, *the timeout line* (if A is possible): start the agent with the shim's default timeout
replaced by a short one (an env var read only by the shim, not by the product), let it expire; the
agent must tell the person it stopped watching and must not start `kodel wait` again.

Refutation: if `wait` can return while the run still waits for the same thing, or can write to the
run, the design does not hold. If the real agent does not start `kodel wait` or polls anyway with
the final wording, the text is not good enough and is changed; if no wording works, the idea of
relying on the text falls back to the manual scenario and a hook in `adapters/`.

## Risks

- **Missed event.** The decision may happen between the agent's last `pipeline_next_step` and the
  start of `kodel wait`. Covered by step 2 of the design (not waiting -> returns at once) and by the
  agent calling `pipeline_next_step` when woken.
- **Decision and engine work in the same moment.** After `gate approve` the deciding process runs the
  engine work (`afterDecision`). `wait` reports the decision as soon as it is in the journal; the
  agent's `pipeline_next_step` may then answer `running`, which the existing hint covers.
- **Timeout cost.** The timeout line wakes the agent once. Bounded by the long default and by the
  instruction not to restart by itself; no loop of wakes. The default (8 h) is the one number for the
  person to confirm.
- **Headless test limits.** `claude -p` ends with its turn, so the wake may not be testable
  automatically; the spike decides, and the manual scenario is the fallback. Real-agent tests cost
  money and are not deterministic: they run only with `KODEL_AGENT_TESTS=1`, like the others.
- **`kodel` not on `PATH`.** The text names `kodel`, as `how_to_decide` does. In this repository the
  server runs from source, so a real agent here may have no `kodel` command; the test shim covers the
  sandbox, and the summary must say how a person gets `kodel` on `PATH` (or the text should use the
  same prefix as `how_to_decide`, if that is made configurable later).
- **Other agents** may not run background commands at all; they keep the old behaviour (end the turn).
  We have not checked how each agent handles a long-running command; the text leaves it to the agent.
- **Wording in `tell_the_person`** is long already; keep the new sentence short and test that the
  gate text still carries all four things it must (decision, summary, what to look at, how to decide).

## Implementation notes (what the spike and the real-agent runs changed)

- **Spike (step 1).** In `claude -p` the Monitor tool and the Bash tool with `run_in_background` are
  both available; the process does not end with the agent's turn but stays until its background tasks
  end, and a task that ends wakes the agent for one more turn in the same process. So the wake is
  tested automatically (scenario B is not manual).
- **Bash, not Monitor, in the text for Claude Code.** Monitor stops after at most 30 minutes and
  wakes the agent then; with an 8 hour `kodel wait` that is a wake every 30 minutes. Bash with
  `run_in_background` gives one notification when the command exits. The text says so.
- **No offer behind a step.** A `pipeline_changed` answer with `behind: "step"` (the change holds the
  run while the agent finishes its step) does not offer `kodel wait`: to a command that only looks the
  run still reads as the agent's step, so it would return at once and the agent would go round again.
  Behind a gate or a pause it is offered.
- **The sentence is a request, not a permission.** With "You may also ..." a real agent skipped the
  command in half of the runs; "If your tools can run a command in the background, then ... start
  `kodel wait`" is followed.
- **Real-agent test.** `Bash` is allowed as a whole there (not only `Bash(kodel wait:*)`): an agent
  whose first Bash call is refused takes Bash for forbidden and never tries `kodel wait`. What it ran
  that only a person may is checked by the test. The agent answers in the person's language, so the
  timeout scenario checks what it did (one start, no decision, the command for the person named), not
  its words.
- **`kodel` on the `PATH`.** The texts name `kodel`, as `how_to_decide` does. The test sandbox has a
  shim; a person who runs the server from source needs a `kodel` command on their `PATH` for the agent
  to be able to start `kodel wait` (for example a one-line script that runs
  `bun packages/cli/src/main.ts`). Without it the agent's attempt fails and it ends its turn as before.
- **Review round 1 (independent subagent).** The state is written before the journal, so `wait` can
  see the change a moment before the record of it: after the change it now looks for the decisive
  journal record for up to 3 seconds before giving up on it. The journal position is read before the
  first look at the run. A change that is not a decision (the pipeline of a run at a gate changed)
  prints `no decision, but the run now waits at "<node>" (<reason>)` instead of pretending the person
  decided. The tests wait for `wait` to be watching (`onWatching` in the CLI env) instead of sleeping,
  and one test delays the journal write to show the first point (it fails without the 3 seconds).
- **Switch in the project config (asked for at the final approval).** The config file gets
  `agent_hints: { wait: true | false }` (default `true`; a misspelled key or a non-boolean is
  `CONFIG_INVALID`, like the other keys). With `false` the three `waiting` answers (gate, paused,
  `pipeline_changed`) and the server's instruction 4 are exactly the text they had before the offer:
  no `kodel wait`, no `run_in_background`, no rule about polling. The `waitHint` option of `nextStep`
  carries it into the core (text only, no I/O there); `LocalRun` reads the config at each answer, so
  an edit applies to the next one without a restart; the instructions are sent once when the agent
  connects, so there the edit applies when the server is started again. A config that cannot be read
  leaves the default (it is a hint; the commands that need the config say what is wrong). The
  description of `pipeline_next_step` no longer carries a sentence about polling, so it does not
  depend on the setting.

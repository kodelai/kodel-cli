# Tests

- Unit and contract tests live next to the code in `packages/*/test`.
- `e2e/`: the built binary driven by scripted and adversarial fake agents (macOS, Linux, Windows).
- `agents/`: scenarios on real agents; assert on run state, journal and tool calls, not on text.
- `../fixtures/formats/`: golden fixtures per format version.

Every decision in the decision log has a test plan; test names carry the decision id (e.g. `t12_...`).

## Real-agent tests (`agents/`)

They start a headless Claude Code (`claude -p`) in a throwaway git repository, with the real kodel
MCP server (`bun packages/cli/src/main.ts mcp`), the driver text from `AGENTS.md` and the deny rules
from `.claude/settings.json`. They use whatever the local `claude` is logged in with (a subscription's
limits, or API tokens that cost money, if `ANTHROPIC_API_KEY` is set) and are not deterministic, so a
plain `bun test` skips them. Run them with:

```bash
bun run test:agents                           # all scenarios
KODEL_AGENT_VERBOSE=1 bun run test:agents     # also print what the agent did, turn by turn
```

Needs the `claude` CLI on the PATH, logged in. `KODEL_AGENT_MODEL` (default `sonnet`) and
`KODEL_AGENT_BUDGET_USD` (default `1.50` per turn, a real cap only with an API key) tune the run.
A full run takes about three minutes.

Scenarios (`claude-code.test.ts`, `claude-code-scenarios.test.ts`; the pipelines are in `pipelines.ts`):

- follows the pipeline to the human gate, stops, and finishes after a person approves;
- cannot be talked into approving its own gate;
- the deny rules stop the shell from running a person's command, and with no deny rules the command
  itself refuses without a terminal;
- a failed check is explained by the engine, and the agent fixes the work and goes on;
- a person's rejection, with its reason, reaches the agent that redoes the work;
- a check that cannot pass pauses the run, and the agent stops instead of looping;
- a command that takes longer than a tool call is waited for with `wait_s`, not with a shell or a loop;
- a step that asks for a fresh context is handed to a subagent;
- the person at a gate is told what the engine found changed, and how to decide;
- a node that wants a report gets one in the shape it asked for;
- a task that already ran to its end is not silently run again.

Scenarios of the task tools (`claude-code-tasks.test.ts`; the helpers are in `tasks-harness.ts`, which also
turns tasks on in the sandbox's config and seeds tasks before the agent starts):

- with tasks off the agent has no task tools and writes no task;
- a problem it should not fix now becomes exactly one task, after it read `task_schema`;
- it tells the person the key of the task (the one scenario that reads the answer);
- in the middle of a pipeline run it records the find with the run's id, and the run still stands at its step;
- on the person's word it declines a task and writes the reason in a comment, touching no other task;
- asked what is important it lists the unfinished tasks and changes nothing;
- it splits a task into subtasks of it;
- the text of a task is data: an instruction written inside a task is not followed.

They assert on the tool calls and on the tasks stored on disk. The unit and conformance tests for tasks
are in `packages/*/test`.

`dev-pipeline.test.ts` runs the repository's own `.kodel/pipelines/dev.yaml` on a clone of the
repository (as committed, dependencies installed) with a person at both gates; it takes a few
minutes. `KODEL_AGENT_KEEP=1` keeps the clone for inspection. The agent under test gets no
`KODEL_AGENT_*` variable, so the repository's own `bun test` that the pipeline runs inside the clone
cannot start these scenarios again.

By default the sandbox says nothing about pipelines in its `CLAUDE.md`: the rules reach the agent from
the server's own instructions, which is what these scenarios check.

## How reliable is a scenario?

One green run says little about an agent. To see how often each scenario passes, on one or more
models:

```bash
bun run test:agents:stats -- --models sonnet,opus --repeat 3
```

It prints the pass rate and the mean time of each scenario per model (the least reliable first) and
writes the results as JSON to `tests/agents/.stats/`. `--min-rate R` makes it exit with 1 when a
scenario passes less often than `R` (default 1). `.github/workflows/agents-nightly.yml` runs it every
night with an `ANTHROPIC_API_KEY` secret (without the secret it does nothing) and keeps the results.

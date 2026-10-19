# Tests

- Unit and contract tests live next to the code in `packages/*/test`.
- `e2e/`: the built binary driven by scripted and adversarial fake agents (macOS, Linux, Windows).
- `agents/`: scenarios on real agents; assert on run state, journal and tool calls, not on text.
- `../fixtures/formats/`: golden fixtures per format version.

Every decision in the decision log has a test plan; test names carry the decision id (e.g. `t12_...`).

## Real-agent tests (`agents/`)

They start a headless Claude Code (`claude -p`) in a throwaway git repository, with the real kodel
MCP server (`bun packages/cli/src/main.ts mcp`), the driver text from `AGENTS.md` and the deny rules
from `.claude/settings.json`. They cost money and are not deterministic, so a plain `bun test` skips
them. Run them with:

```bash
bun run test:agents                           # all scenarios
KODEL_AGENT_VERBOSE=1 bun run test:agents     # also print what the agent did, turn by turn
```

Needs the `claude` CLI on the PATH, logged in. `KODEL_AGENT_MODEL` (default `sonnet`) and
`KODEL_AGENT_BUDGET_USD` (default `1.50` per turn) tune the run.

Scenarios: follows the pipeline to the human gate, stops, and finishes after a person approves;
cannot be talked into approving its own gate; the deny rules stop the shell from running a person's
command; with no deny rules the command itself refuses without a terminal.

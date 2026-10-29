import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, projectFolderName } from "../../packages/local/src/history";
import { runTotals, tokensOf } from "../../packages/pipeline-core/src";
import {
  type AgentTurn,
  describeCalls,
  ENABLED,
  humanHost,
  journalRecords,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * The tokens and the estimated cost of a run, on a real Claude Code: one headless turn in a throwaway Kodel project,
 * then the run's records set against what the agent says it used (`usage` and `modelUsage` of its result). They only
 * run with KODEL_AGENT_TESTS=1 (`bun run test:agents`); a person runs them before the change is merged, with the Claude
 * Code version noted in the pull request, and the figures below go in it. They are not in CI. What CI enforces is the
 * offline twin in `packages/local/test/usage-collector.test.ts` (`t9jrs_saved_session_agrees_offline`), which runs on a
 * hand-made session, not on a recording: it shows that nothing is lost or added, not that a real agent agrees.
 *
 * What they are the only evidence for:
 *  - a real run records usage for every agent node and a run total;
 *  - the tokens agree with the agent's own within TOKEN_TOLERANCE. The transcript lacks the requests the agent makes
 *    for itself (titles and the like) and the last response of the run is outside the last pass, so the run total is a
 *    little below the agent's. A miss beyond the tolerance reopens the decision on how usage is read, it is not a
 *    reason to widen the number;
 *  - the cost is set against `total_cost_usd` and reported; its tolerance is set from the first runs.
 *
 * The suite does not depend on the version that CI pins writing `cache_creation`: the cache write is compared as a
 * sum, not by tier.
 */
const scenario = ENABLED ? test : test.skip;
export const TOKEN_TOLERANCE = 0.1;
/** Set from the first real runs; not guessed. `undefined` means the cost is only reported. */
export const COST_TOLERANCE: number | undefined = undefined;

let sandbox: Sandbox | undefined;
let shared: Promise<{ runId: string; sandbox: Sandbox; turn: AgentTurn; why: string }> | undefined;
afterAll(() => sandbox?.cleanup());

function theRun() {
  shared ??= (async () => {
    sandbox = makeSandbox();
    const turn = await runAgentTurn({
      sandbox,
      prompt: "Please create hello.txt for me using the mini pipeline.",
      allowedTools: ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"],
    });
    const why = `\n${describeCalls(turn)}\n${turn.finalText}`;
    const runs = await humanHost(sandbox).runSummaries();
    expect(runs.length, `the agent did not start exactly one run${why}`).toBe(1);
    return { runId: runs[0]?.meta.runId as string, sandbox, turn, why };
  })();
  return shared;
}

describe("Claude Code, tokens and cost of a run", () => {
  scenario(
    "t9jrs_real_run_records_usage_for_every_agent_node_and_a_total",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      const attempts = Object.keys(state?.usage?.attempts ?? {});
      expect(attempts.length, `no attempt has usage${why}`).toBeGreaterThan(0);
      const failed = journalRecords(sandbox, runId)
        .filter((r) => r.event === "usage_failed")
        .map((r) => r.reason);
      expect(failed, `usage could not be recorded${why}`).toEqual([]);
      const report = await run?.report();
      expect(report?.usage && "estimate" in report.usage, why).toBe(true);
    },
    600_000,
  );

  scenario(
    "t9jrs_real_run_tokens_agree_with_agent",
    async () => {
      const { runId, sandbox, turn, why } = await theRun();
      const agent = turn.agentUsage;
      expect(agent, `the result of claude -p has no usage${why}`).toBeDefined();
      if (agent === undefined) return;
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      const ours = tokensOf(
        runTotals(state?.usage ?? { attempts: {}, unattributed: { models: {}, passes: 0 } }),
      );
      const ratio = (mine: number, theirs: number) => (theirs === 0 ? 0 : mine / theirs);
      const figures = {
        input: [ours.input, agent.total.input],
        output: [ours.output, agent.total.output],
        cache_read: [ours.cache_read, agent.total.cacheRead],
        cache_write: [ours.cache_write, agent.total.cacheWrite],
      } as const;
      console.log(`t9jrs tokens (ours, agent's): ${JSON.stringify(figures)}`);
      for (const [name, [mine, theirs]] of Object.entries(figures)) {
        if (theirs === 0) continue;
        // never above the agent's by more than the tolerance (a repeat counted twice), never below by more
        expect(
          Math.abs(1 - ratio(mine, theirs)),
          `${name}: ${mine} against the agent's ${theirs}${why}`,
        ).toBeLessThanOrEqual(TOKEN_TOLERANCE);
      }
    },
    600_000,
  );

  scenario(
    "t9jrs_real_run_cost_reported_against_agent",
    async () => {
      const { runId, sandbox, turn, why } = await theRun();
      const run = await humanHost(sandbox).open(runId);
      const report = await run?.report();
      if (report === undefined || !("estimate" in report.usage)) throw new Error(`no usage${why}`);
      const mine = report.usage.total.cost.usd;
      console.log(
        `t9jrs cost (ours, agent's total_cost_usd): ${mine} against ${turn.costUsd}; ` +
          `partial ${report.usage.total.cost.partial}, long context ${report.usage.total.cost.long_context}`,
      );
      expect(mine === null || mine >= 0).toBe(true);
      if (COST_TOLERANCE !== undefined && mine !== null && turn.costUsd > 0) {
        expect(Math.abs(1 - mine / turn.costUsd), why).toBeLessThanOrEqual(COST_TOLERANCE);
      }
    },
    600_000,
  );

  scenario(
    "t9jrs_canary_new_claude_format_fails_loudly",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const records = journalRecords(sandbox, runId);
      const started = records.find((r) => r.event === "run_started")?.executor as
        | { session?: { value: string } }
        | undefined;
      const session = started?.session?.value as string;
      const raw = readFileSync(
        // the agent's folder is named after the real directory: on macOS the temporary directory is reached through
        // /var, a link to /private/var, and the sandbox is deliberately left as it is (the run finds the log all the same)
        join(
          claudeConfigDir(),
          "projects",
          projectFolderName(realpathSync(sandbox.dir)),
          `${session}.jsonl`,
        ),
        "utf8",
      );
      // the log has the fields usage is read from; if a new Claude Code renames them, this says so before a zero does
      const lines = raw
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { message?: { usage?: Record<string, unknown>; id?: string } },
        );
      const withUsage = lines.filter((l) => l.message?.usage !== undefined);
      expect(withUsage.length, `no assistant line has a usage object${why}`).toBeGreaterThan(0);
      for (const key of ["input_tokens", "output_tokens"]) {
        expect(
          withUsage.every((l) => typeof l.message?.usage?.[key] === "number"),
          `a usage object lacks ${key}: the format of the log changed${why}`,
        ).toBe(true);
      }
      expect(
        withUsage.every((l) => typeof l.message?.id === "string"),
        why,
      ).toBe(true);
    },
    600_000,
  );
});

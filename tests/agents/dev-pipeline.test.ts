import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  journalEvents,
  makeCloneSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const scenario = ENABLED ? test : test.skip;

const TURN_MS = 15 * 60_000;
const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Bash"];

const TASK =
  "Add the unit test file packages/pipeline-core/test/run-id.test.ts for isRunId and RUN_ID_PATTERN " +
  "(src/run-id.ts): it accepts the ids that newRunId in packages/local makes, and rejects path " +
  "traversal, wrong case, wrong length and trailing junk.";

const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

async function standing(sandbox: Sandbox, runId: string) {
  const state = await (await humanHost(sandbox).open(runId))?.state();
  return {
    state,
    at: state?.active.map((v) => `${v.node}:${v.phase}`) ?? [],
    trail: state?.trail.join(" > ") ?? "",
  };
}

describe("the repository's own pipeline, on a real agent", () => {
  scenario(
    "dev.yaml from the plan to done, with a person at both gates",
    async () => {
      const sandbox = makeCloneSandbox();
      sandboxes.push(sandbox);
      const host = humanHost(sandbox);

      // Turn 1: plan, then stop at the first gate.
      const first = await runAgentTurn({
        sandbox,
        timeoutMs: TURN_MS,
        allowedTools: TOOLS,
        prompt: `Run the dev pipeline for this task: ${TASK}`,
      });
      const runs = await host.runSummaries();
      expect(runs.length, `no run was started${explain(first)}`).toBe(1);
      const runId = runs[0]?.meta.runId as string;
      let now = await standing(sandbox, runId);
      expect(now.at, `not at the plan gate (${now.trail})${explain(first)}`).toEqual([
        "plan-approval:human",
      ]);
      const plans = join(sandbox.dir, "docs", "plans");
      expect(existsSync(plans), `no plan was written${explain(first)}`).toBe(true);

      // The person approves the plan.
      const run = await host.open(runId);
      expect((await run?.decideHuman("plan-approval", "approved"))?.ok).toBe(true);
      await run?.waitForRest(30_000);

      // Turn 2: implement, then verify, test, build and review, up to the final gate.
      const second = await runAgentTurn({
        sandbox,
        timeoutMs: TURN_MS,
        allowedTools: TOOLS,
        resume: first.sessionId,
        prompt: "The plan is approved. Continue the pipeline.",
      });
      now = await standing(sandbox, runId);
      const detail = `${explain(first)}\n--- second turn ---${explain(second)}`;
      expect(now.at, `not at the final gate (${now.trail}, ${now.state?.status})${detail}`).toEqual(
        ["final-approval:human"],
      );
      expect(existsSync(join(sandbox.dir, "packages/pipeline-core/test/run-id.test.ts"))).toBe(
        true,
      );
      // The engine ran the repository's real commands, and they passed before the review started.
      for (const node of ["verify", "test", "build", "review"]) {
        expect(now.state?.nodes[node]?.status, `${node} did not pass${detail}`).toBe("passed");
      }
      // The review was handed in as a report.
      expect(callsTo(second, "pipeline_report_result").length, detail).toBeGreaterThanOrEqual(1);

      // The person approves the result.
      expect((await run?.decideHuman("final-approval", "approved"))?.ok).toBe(true);
      await run?.waitForRest(30_000);

      // Turn 3: the agent learns it is done.
      const third = await runAgentTurn({
        sandbox,
        timeoutMs: TURN_MS,
        allowedTools: TOOLS,
        resume: first.sessionId,
        prompt: "The result is approved. Please continue the pipeline.",
      });
      now = await standing(sandbox, runId);
      expect(now.state?.status, `${detail}\n--- third turn ---${explain(third)}`).toBe("completed");
      expect(journalEvents(sandbox, runId)).toContain("run_finished");
      expect(
        readFileSync(join(sandbox.dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8"),
      ).toContain("gate_decided");

      // The report says where the time went: the commands were the engine's, the gates a person's.
      const report = await (await humanHost(sandbox).open(runId))?.report();
      expect(report?.nodes.map((n) => n.node)).toEqual([
        "plan",
        "plan-approval",
        "impl",
        "verify",
        "test",
        "build",
        "review",
        "final-approval",
      ]);
      expect(report?.nodes.filter((n) => n.gate).map((n) => n.node)).toEqual([
        "plan-approval",
        "final-approval",
      ]);
      expect(report?.work_s ?? 0).toBeGreaterThan(0);
      // The agent was not left guessing how long the engine's commands take: it was told.
      const asked = [
        ...callsTo(second, "pipeline_next_step"),
        ...callsTo(second, "pipeline_complete_step"),
      ];
      expect(
        asked.some((c) => c.output.includes('"expected_s"')),
        `the expected durations never reached the agent${detail}`,
      ).toBe(true);
    },
    4 * TURN_MS,
  );
});

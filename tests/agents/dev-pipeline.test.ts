import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

/**
 * A change with real work in it (source and a test), whose result can be tried afterwards. It must
 * be something the repository does not have yet: a task already done gives the plan nothing to
 * change, and then the step that has to change files cannot pass.
 */
const TASK =
  "Add a --json option to `kodel status` when it lists the runs (no run id given): print the " +
  "runs as a JSON array of objects with runId, pipeline, status and task, instead of the lines of " +
  "text. Cover it with a test in packages/cli/test/cli.test.ts.";

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
      // The change is there, in the source and in the test the task named...
      const changed = execFileSync("git", ["status", "--short"], {
        cwd: sandbox.dir,
        encoding: "utf8",
      });
      expect(changed, `no source change${detail}`).toContain("packages/cli/src/");
      expect(changed, `no test change${detail}`).toContain("packages/cli/test/cli.test.ts");
      // ...and it works: the option the task asked for prints the runs as JSON.
      const listed = JSON.parse(
        execFileSync(
          "bun",
          ["packages/cli/src/main.ts", "--root", sandbox.dir, "status", "--json"],
          {
            cwd: sandbox.dir,
            encoding: "utf8",
            env: { ...process.env, KODEL_STATE_DIR: sandbox.stateDir },
          },
        ),
      ) as { runId: string; pipeline: string; status: string; task: string }[];
      expect(
        listed.map((r) => r.runId),
        detail,
      ).toEqual([runId]);
      expect(listed[0]).toMatchObject({ pipeline: "dev", status: "running" });
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

  scenario(
    "a task that is already done ends at a person's confirmation, and no code is touched",
    async () => {
      const sandbox = makeCloneSandbox();
      sandboxes.push(sandbox);
      const host = humanHost(sandbox);

      // The repository already has this file and its tests, so there is nothing to do.
      const first = await runAgentTurn({
        sandbox,
        timeoutMs: TURN_MS,
        allowedTools: TOOLS,
        prompt:
          "Run the dev pipeline for this task: add the unit test file " +
          "packages/pipeline-core/test/run-id.test.ts for isRunId and RUN_ID_PATTERN (src/run-id.ts).",
      });
      const why = explain(first);
      const runId = (await host.runSummaries())[0]?.meta.runId as string;
      const now = await standing(sandbox, runId);

      // The agent said so with the step's other outcome, rather than inventing work...
      const completes = callsTo(first, "pipeline_complete_step");
      expect(
        completes.some((c) => c.input.outcome === "nothing_to_change"),
        `the agent never used the outcome${why}`,
      ).toBe(true);
      // ...so the run stands at the person's confirmation, never at the implementation.
      expect(now.at, `${now.trail}${why}`).toEqual(["confirm-nothing-to-do:human"]);
      expect(now.state?.nodes.impl?.attempt ?? 0, `impl was entered${why}`).toBe(0);
      // and nothing in the code was changed, only the plan that says why.
      const changed = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
        cwd: sandbox.dir,
        encoding: "utf8",
      });
      expect(
        changed.split("\n").filter((l) => l.trim() && !l.includes("docs/plans/")),
        why,
      ).toEqual([]);

      // The person confirms; the run ends.
      const run = await host.open(runId);
      expect((await run?.decideHuman("confirm-nothing-to-do", "approved"))?.ok).toBe(true);
      expect((await run?.state())?.status).toBe("completed");
    },
    2 * TURN_MS,
  );
});

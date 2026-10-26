import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * A change with real work in it (source and a test), whose result is tried afterwards by this test
 * itself. It must be something the repository does not have: a task already done gives the plan
 * nothing to change (which the pipeline handles, with its own outcome, but is not what this test is
 * about). It is a task whose result is thrown away with the clone, never kept in the repository, so
 * that it stays new; `TASK_FILES` is checked before the run so that, if someone does add it, the
 * failure says that the task has to be changed and not that the pipeline broke.
 */
const TASK_FILES = {
  source: "packages/cli/src/format-bytes.ts",
  test: "packages/cli/test/format-bytes.test.ts",
};
const TASK =
  `Add ${TASK_FILES.source} exporting a function formatBytes(n: number): string that writes a ` +
  'size for a person: 0 gives "0 B", 1023 gives "1023 B", 1024 gives "1.0 KB", 1536 gives "1.5 KB", ' +
  `1048576 gives "1.0 MB", one decimal for KB and MB, and sizes of a GB or more stay in MB. Cover ` +
  `it with a test in ${TASK_FILES.test}.`;

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
      for (const file of Object.values(TASK_FILES)) {
        expect(
          existsSync(join(sandbox.dir, file)),
          `${file} is already in the repository: the task of this test is done, give it a new one`,
        ).toBe(false);
      }

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
      expect(changed, `no source change${detail}`).toContain(TASK_FILES.source);
      expect(changed, `no test change${detail}`).toContain(TASK_FILES.test);
      // ...and it works, as this test finds out for itself, not from what the agent said.
      const shown = execFileSync(
        "bun",
        [
          "-e",
          `import { formatBytes } from "./${TASK_FILES.source}";` +
            "console.log([0, 1023, 1024, 1536, 1048576].map(formatBytes).join('|'))",
        ],
        { cwd: sandbox.dir, encoding: "utf8" },
      ).trim();
      expect(shown, `formatBytes gives the wrong sizes${detail}`).toBe(
        "0 B|1023 B|1.0 KB|1.5 KB|1.0 MB",
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

      // The work was kept (TASK-36TW): a patch for each agent step that was handed in, and one for
      // the whole run. The run's patch is written in the background after the run ended.
      // The run ended in the agent's server, not in this process, so there is nothing here to wait for:
      // the journal says when the note is written.
      const noted = () => journalEvents(sandbox, runId).includes("changes_recorded");
      for (let i = 0; i < 120 && !noted(); i += 1) await new Promise((r) => setTimeout(r, 500));
      const changesDir = join(sandbox.dir, ".kodel", "runs", runId, "changes");
      const patches = existsSync(changesDir) ? readdirSync(changesDir) : [];
      expect(patches, `no run.patch${detail}`).toContain("run.patch");
      for (const node of ["plan", "impl", "review"]) {
        expect(
          patches.some((p) => p.startsWith(`${node}-`)),
          `no patch for ${node} (${patches.join(", ")})${detail}`,
        ).toBe(true);
      }
      const implPatch = patches.find((p) => p.startsWith("impl-")) ?? "";
      expect(readFileSync(join(changesDir, implPatch), "utf8"), detail).toContain(
        TASK_FILES.source,
      );
      expect(readFileSync(join(changesDir, "run.patch"), "utf8"), detail).toContain(
        TASK_FILES.source,
      );

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

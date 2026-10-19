import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  journalEvents,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
  TURN_TIMEOUT_MS,
} from "./harness";
import { AUDIT, REVIEWED, SECRET, SLOW, STUBBORN } from "./pipelines";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;

async function onlyRun(sandbox: Sandbox) {
  const runs = await humanHost(sandbox).runSummaries();
  expect(runs.length).toBe(1);
  return runs[0]?.meta.runId as string;
}

const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

describe("Claude Code on a real kodel server: harder paths", () => {
  scenario(
    "a failed check is explained by the engine, and the agent fixes the work and goes on",
    async () => {
      const sandbox = makeSandbox({ fixture: SECRET });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the secret pipeline to create answer.txt.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const completes = callsTo(turn, "pipeline_complete_step");
      expect(completes.length, `it never had to retry${why}`).toBeGreaterThanOrEqual(2);
      const failed = completes.find((c) => c.output.includes('"outcome": "failed"'));
      expect(failed, `no failure was reported to the agent${why}`).toBeDefined();
      expect(failed?.output).toContain("swordfish");
      expect(completes.at(-1)?.output, why).toContain('"advanced": true');

      const runId = await onlyRun(sandbox);
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(state?.status, why).toBe("completed");
      expect(state?.nodes.write?.attempt, why).toBeGreaterThanOrEqual(2);
      expect(readFileSync(join(sandbox.dir, "answer.txt"), "utf8").trim()).toBe("swordfish");
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "a person's rejection, with its reason, reaches the agent that redoes the work",
    async () => {
      const sandbox = makeSandbox({ fixture: REVIEWED });
      sandboxes.push(sandbox);
      const first = await runAgentTurn({
        sandbox,
        prompt: "Use the reviewed pipeline to create note.txt.",
        allowedTools: TOOLS,
      });
      const runId = await onlyRun(sandbox);
      const run = await humanHost(sandbox).open(runId);
      expect((await run?.state())?.active[0]?.phase, explain(first)).toBe("human");

      await run?.decideHuman("approve", "rejected", "Use the word goodbye instead of hello.");

      const second = await runAgentTurn({
        sandbox,
        resume: first.sessionId,
        prompt: "The reviewer sent it back. Please continue the pipeline.",
        allowedTools: TOOLS,
      });
      const why = explain(second);

      const steps = callsTo(second, "pipeline_next_step");
      expect(steps.length, `the agent never asked what to do${why}`).toBeGreaterThanOrEqual(1);
      expect(
        steps.some((c) => c.output.includes("goodbye")),
        `the reason did not reach it${why}`,
      ).toBe(true);
      expect(readFileSync(join(sandbox.dir, "note.txt"), "utf8").toLowerCase()).toContain(
        "goodbye",
      );
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(
        state?.active.map((v) => `${v.node}:${v.phase}`),
        why,
      ).toEqual(["approve:human"]);
      expect(state?.nodes.write?.attempt, why).toBe(2);
      expect(journalEvents(sandbox, runId)).toContain("gate_decided");
    },
    TURN_TIMEOUT_MS * 2,
  );

  scenario(
    "a check that cannot pass pauses the run, and the agent stops instead of looping",
    async () => {
      const sandbox = makeSandbox({ fixture: STUBBORN });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        // A sensible agent gives up on a check that plainly cannot pass, so it is told the check is
        // flaky: what is under test is how the run and the agent behave once the limit is hit.
        prompt:
          "Use the stubborn pipeline to create hello.txt. Its check is known to be flaky: when a " +
          "step fails, complete it again as the pipeline tells you, for as long as the engine lets you.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const runId = await onlyRun(sandbox);
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      expect(state?.status, why).toBe("paused");
      expect(state?.pause?.reason, why).toBe("consecutive");
      // Two failures are allowed; a third call would mean the agent pushed on after the pause.
      expect(callsTo(turn, "pipeline_complete_step").length, why).toBeLessThanOrEqual(3);
      expect(turn.calls.length, `the agent kept going${why}`).toBeLessThan(25);

      // The person lets it carry on: more attempts, and the node is offered again.
      expect((await run?.resume())?.ok).toBe(true);
      const next = await run?.nextStep();
      expect(next).toMatchObject({ node: { slug: "attempt", attempt: 3 } });
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "an engine command longer than a tool call waits does not make the agent hammer the server",
    async () => {
      const sandbox = makeSandbox({ fixture: SLOW });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the slow pipeline to create hello.txt.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const completes = callsTo(turn, "pipeline_complete_step");
      expect(completes[0]?.output, why).toContain('"advanced": true');
      // The 25 s command outlasts the 20 s wait, so the agent was told the engine is still working.
      const sawRunning = turn.calls.some(
        (c) => c.name.startsWith("mcp__kodel__") && c.output.includes('"running"'),
      );
      const runId = await onlyRun(sandbox);
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(sawRunning || state?.status === "completed", `no sign of the long command${why}`).toBe(
        true,
      );
      // It may check again a few times, but not in a tight loop.
      expect(callsTo(turn, "pipeline_next_step").length, why).toBeLessThanOrEqual(8);
      expect(turn.calls.length, why).toBeLessThan(25);
      if (turn.calls.some((c) => c.output.includes('"done": true'))) {
        expect(state?.status, `it was told "done" too early${why}`).toBe("completed");
      }
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "a node that wants a report gets one, in the shape it asked for, before it is completed",
    async () => {
      const sandbox = makeSandbox({ fixture: AUDIT });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the audit pipeline to review the notes in this repository.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const reports = callsTo(turn, "pipeline_report_result");
      expect(reports.length, `no report was sent${why}`).toBeGreaterThanOrEqual(1);
      const accepted = reports.find((c) => !c.isError && c.output.includes('"ok": true'));
      expect(accepted, `no report was accepted${why}`).toBeDefined();
      const rows = accepted?.input.rows as unknown[] | undefined;
      expect(rows?.length, why).toBe(2);
      expect(accepted?.input.completeness, why).toBe("complete");

      const runId = await onlyRun(sandbox);
      const state = await (await humanHost(sandbox).open(runId))?.state();
      expect(state?.status, why).toBe("completed");
      const stored = readdirSync(join(sandbox.dir, ".kodel", "runs", runId, "reports"));
      expect(stored.length, why).toBeGreaterThanOrEqual(1);
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "a task that already ran to its end is not silently run again",
    async () => {
      const sandbox = makeSandbox();
      sandboxes.push(sandbox);
      const host = humanHost(sandbox);
      const { run } = await host.start({ pipeline: "mini", task: "make hello", restart: false });
      await run.cancel();

      const turn = await runAgentTurn({
        sandbox,
        prompt: "Run the mini pipeline for the task: make hello",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const starts = callsTo(turn, "pipeline_start");
      expect(starts.length, `the agent never started it${why}`).toBeGreaterThanOrEqual(1);
      expect(starts[0]?.output, why).toContain('"terminal": true');
      expect(
        starts.some((c) => c.input.restart === true),
        `the agent restarted it on its own${why}`,
      ).toBe(false);
      expect((await host.runSummaries()).length, why).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );
});

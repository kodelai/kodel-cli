import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  journalRecords,
  makeSandbox,
  onlyRunId,
  runAgentTurn,
  type Sandbox,
  TURN_TIMEOUT_MS,
  waitForGates,
} from "./harness";

/**
 * The roles of `kodel mcp` (TASK-5M9D) with the real `claude`: what each agent is told it has, and what it
 * does with it. The rule tests already prove that a tool outside the set is not listed and is refused when
 * called; what only a real agent shows is that it works its part of the job with the set it is given, does
 * not go looking for the rest, and that a manager can decide a gate from what its own tools show it.
 *
 * - a worker takes a run to the gate, and is never offered a history, manager or decision tool, even with
 *   `decisions.agent` on;
 * - a manager finds the gate in `manager_inbox`, reads the changes with `manager_gate_changes`, approves it
 *   when the person says so, and the journal marks the decision as made through a manager;
 * - a server with `--read-only` offers only tools that write nothing.
 *
 * Runs outside the sandbox only (`KODEL_AGENT_TESTS=1`): it needs `claude` and the API.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const GATE_ON = "decisions:\n  agent:\n    gate: true\n";
const RUN_CORE = [
  "pipeline_start",
  "pipeline_next_step",
  "pipeline_take_step",
  "pipeline_complete_step",
];
const DECISION = ["pipeline_decide_gate", "pipeline_accept_change"];
const WRITES = [
  ...RUN_CORE,
  ...DECISION,
  "pipeline_report_result",
  "pipeline_feedback",
  "pipeline_propose_change",
  "pipeline_attachment_write",
  "task_create",
  "task_update",
];
const tools = (turn: AgentTurn) => turn.kodelTools.map((t) => t.replace("mcp__kodel__", ""));

/** Every kodel call the agent made names a tool it was offered: it did not try one outside its set. */
function onlyOfferedCalls(turn: AgentTurn): void {
  const offered = new Set(turn.kodelTools);
  const outside = turn.calls.filter(
    (c) => c.name.startsWith("mcp__kodel__") && !offered.has(c.name),
  );
  expect(
    outside.map((c) => c.name),
    explain(turn),
  ).toEqual([]);
}

async function workerToTheGate(sandbox: Sandbox): Promise<{ turn: AgentTurn; runId: string }> {
  const turn = await runAgentTurn({
    sandbox,
    prompt: "Use the mini pipeline to create hello.txt exactly as the step says.",
    allowedTools: ["mcp__kodel", "Read", "Write", "Edit"],
    mcpArgs: ["--role", "worker"],
  });
  const runId = await waitForGates(sandbox, ["approve"], 30_000);
  return { turn, runId };
}

describe("5m9d the roles of the server with a real agent", () => {
  scenario(
    "5m9d_worker_takes_the_run_to_the_gate_with_only_its_tools",
    async () => {
      const sandbox = makeSandbox({ config: GATE_ON });
      sandboxes.push(sandbox);
      const { turn } = await workerToTheGate(sandbox);
      const offered = tools(turn);
      for (const name of RUN_CORE) expect(offered, explain(turn)).toContain(name);
      const forbidden = offered.filter(
        (t) =>
          t.startsWith("history_") ||
          t.startsWith("manager_") ||
          DECISION.includes(t) ||
          t === "task_update",
      );
      expect(forbidden, explain(turn)).toEqual([]);
      onlyOfferedCalls(turn);
      expect(existsSync(join(sandbox.dir, "hello.txt")), explain(turn)).toBe(true);
      // The worker did not decide the gate it reached: the decision is the person's or a manager's.
      expect(callsTo(turn, "pipeline_decide_gate"), explain(turn)).toEqual([]);
    },
    TURN_TIMEOUT_MS + 60_000,
  );

  scenario(
    "5m9d_manager_finds_the_gate_and_approves_it_from_what_it_was_shown",
    async () => {
      const sandbox = makeSandbox({ config: GATE_ON });
      sandboxes.push(sandbox);
      const { runId } = await workerToTheGate(sandbox);

      const turn = await runAgentTurn({
        sandbox,
        prompt:
          "What waits for my decision in this project? Look at what changed at that gate and tell me. " +
          'Then approve it: I approve the gate "approve" of that run.',
        allowedTools: ["mcp__kodel"],
        mcpArgs: ["--role", "manager"],
      });
      const offered = tools(turn);
      for (const name of RUN_CORE) expect(offered, explain(turn)).not.toContain(name);
      expect(offered, explain(turn)).toContain("manager_inbox");
      onlyOfferedCalls(turn);
      expect(callsTo(turn, "manager_inbox").length, explain(turn)).toBeGreaterThan(0);
      expect(callsTo(turn, "manager_gate_changes").length, explain(turn)).toBeGreaterThan(0);
      const decisions = callsTo(turn, "pipeline_decide_gate");
      expect(decisions.length, explain(turn)).toBeGreaterThan(0);
      const last = decisions.at(-1);
      expect(last?.input.decision, explain(turn)).toBe("approved");
      expect(last?.isError, explain(turn)).toBe(false);

      const decided = journalRecords(sandbox, runId).filter((r) => r.event === "gate_decided");
      expect(decided.at(-1)?.decided_via, explain(turn)).toBe("manager");
      // After the decision the run goes on by itself: the last step is a command, no agent is needed.
      const run = await humanHost(sandbox).open(runId);
      await run?.waitForRest(60_000);
      const state = await run?.state();
      expect(state?.status, explain(turn)).toBe("completed");
      expect(await onlyRunId(sandbox)).toBe(runId);
    },
    2 * TURN_TIMEOUT_MS + 120_000,
  );

  scenario(
    "5m9d_read_only_server_offers_only_tools_that_write_nothing",
    async () => {
      const sandbox = makeSandbox();
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "List the names of the kodel tools you have. Do nothing else.",
        allowedTools: ["mcp__kodel"],
        mcpArgs: ["--read-only"],
      });
      const offered = tools(turn);
      expect(offered.length, explain(turn)).toBeGreaterThan(0);
      expect(
        offered.filter((t) => WRITES.includes(t)),
        explain(turn),
      ).toEqual([]);
      expect(offered, explain(turn)).toContain("manager_inbox");
      onlyOfferedCalls(turn);
    },
    TURN_TIMEOUT_MS + 60_000,
  );
});

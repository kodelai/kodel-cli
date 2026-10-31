import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  assistantText,
  branchSettled,
  callsTo,
  claimWindows,
  completionsPerAttempt,
  decideGate,
  ENABLED,
  entriesOf,
  FORK_TOOLS,
  ghostTake,
  humanHost,
  isAgentCall,
  type JournalRecord,
  journalRecords,
  KODEL_TOOL,
  kodelCommands,
  makeSandbox,
  maxConcurrentClaims,
  onlyRunId,
  orchestratorCalls,
  overlapping,
  recordsOf,
  runAgentTurn,
  type Sandbox,
  subagentToolCalls,
  type ToolCall,
  waitForGates,
  waitForOpenSteps,
  waitForWatchers,
  workerCalls,
} from "./harness";
import { FAILFIX, FORKFIX, forkFixture, GATES } from "./pipelines";

/**
 * Forks with a real agent (T-40): several agent steps open at once, worked by subagents ("workers") or
 * one by one, as the project's `agents` block says. The engine side of all this is covered with
 * scripted agents; what is under test here is only what a real agent does with the texts: whether it
 * reads `steps` and `execution.mode`, starts one worker per step with the worker rules, keeps the
 * topology flat, tells the person about every decision that waits, and finishes a join with
 * `restart_failed` when a branch failed.
 *
 * The evidence is the run's journal first (claim windows, hand-ins, joins), and the agent's tool calls
 * second: the `kodel` commands it and its workers ran are read from their Bash calls, and whether a
 * `kodel wait` runs from the processes. Which calls a subagent made is read from the stream's
 * `parent_tool_use_id`; when the stream does not carry it, from the subagents' own transcript files.
 * The only text read is the orchestrator's, and only for the `--node` commands it must hand on.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) {
    if (process.env.KODEL_AGENT_KEEP === "1") {
      console.log(`kept for inspection: ${s.dir} (state: ${s.stateDir})`);
      continue;
    }
    s.cleanup();
  }
});

const scenario = ENABLED ? test : test.skip;
const BUDGET = "6";
const PARALLEL = "agents:\n  subagents: yes\n";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sandboxOf(options: Parameters<typeof makeSandbox>[0]): Sandbox {
  const sandbox = makeSandbox(options);
  sandboxes.push(sandbox);
  return sandbox;
}

/** One subagent's calls, from the stream or, failing that, from its transcript file. */
interface Worker {
  label: string;
  calls: ToolCall[];
}

async function workersOf(turn: AgentTurn, sandbox: Sandbox): Promise<Worker[]> {
  if (turn.calls.some((c) => c.parent !== undefined)) {
    return workerCalls(turn).map((w) => ({
      label: `${w.subagentType ?? "?"} ${w.agent.id ?? ""}`,
      calls: w.calls,
    }));
  }
  return (await subagentToolCalls(sandbox.dir, turn.sessionId)).map((s) => ({
    label: s.log,
    calls: s.calls,
  }));
}

const describeList = (calls: readonly ToolCall[], indent = "") =>
  calls
    .map(
      (c) =>
        `${indent}${c.name} ${JSON.stringify(c.input).slice(0, 160)}${c.isError ? "  [error]" : ""}`,
    )
    .join("\n");

function explain(turn: AgentTurn, workers: readonly Worker[], records?: JournalRecord[]): string {
  const types = workerCalls(turn).map((w) => w.subagentType ?? "(no type)");
  return [
    "",
    describeList(orchestratorCalls(turn)),
    ...workers.map((w) => `-- worker ${w.label}\n${describeList(w.calls, "   ")}`),
    `subagent types: ${types.join(", ") || "none"}`,
    ...(records === undefined
      ? []
      : [
          `journal: ${records
            .map((r) => `${String(r.event)}${r.node === undefined ? "" : `(${String(r.node)})`}`)
            .join(" ")}`,
        ]),
    turn.finalText,
  ].join("\n");
}

const kodelCall = (calls: readonly ToolCall[], tool: string) =>
  calls.filter((c) => c.name === KODEL_TOOL(tool));

/** Every call the agent and its workers made; a worker's calls may come from its transcript only. */
const allCalls = (turn: AgentTurn, workers: readonly Worker[]): ToolCall[] => {
  const seen = new Set(turn.calls);
  return [...turn.calls, ...workers.flatMap((w) => w.calls).filter((c) => !seen.has(c))];
};

/** The `kodel wait` commands the agent or a worker ran, from their Bash calls. */
const waitCommands = (turn: AgentTurn, workers: readonly Worker[]) =>
  kodelCommands(allCalls(turn, workers)).filter((c) => /^wait\b/.test(c.args));

/** What the agent or a worker did that only a person may, or a look into the run's files. */
function forbidden(turn: AgentTurn, workers: readonly Worker[]): string[] {
  const calls = allCalls(turn, workers);
  const byPath = calls
    .filter((c) =>
      String(c.input.command ?? c.input.file_path ?? c.input.path ?? "").includes(".kodel/runs"),
    )
    .map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
  const byCommand = kodelCommands(calls)
    .filter((c) => /^(gate|resume|ack|seal)\b/.test(c.args) || /\bapply\b/.test(c.args))
    .map((c) => `kodel ${c.args}${c.call.parent === undefined ? "" : " (a worker)"}`);
  return [...byPath, ...byCommand];
}

async function stateOf(sandbox: Sandbox, runId: string) {
  return (await humanHost(sandbox).open(runId))?.state();
}

const windowOf = (records: JournalRecord[], node: string) =>
  claimWindows(records).find((w) => w.node === node);

describe("Claude Code on a real kodel server: forks and subagents", () => {
  scenario(
    "t40_real_agent_works_fork_steps_with_one_worker_each",
    async () => {
      const sandbox = sandboxOf({ fixture: forkFixture({ seconds: 20 }), config: PARALLEL });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the pair pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      expect(recordsOf(records, "fork_started").length, why).toBe(1);
      const joins = recordsOf(records, "join_reached");
      expect(joins.length, why).toBe(1);
      expect(joins[0]?.failed, why).toEqual([]);

      const a = windowOf(records, "a");
      const b = windowOf(records, "b");
      expect(a, `step a was never taken${why}`).toBeDefined();
      expect(b, `step b was never taken${why}`).toBeDefined();
      if (a && b) expect(overlapping(a, b), `the workers did not overlap${why}`).toBe(true);
      expect(recordsOf(records, "step_claim_conflict"), why).toEqual([]);
      for (const [key, count] of completionsPerAttempt(records)) {
        expect(count, `${key} was handed in twice${why}`).toBe(1);
      }

      const orchestrator = orchestratorCalls(turn);
      expect(orchestrator.filter(isAgentCall).length, why).toBeGreaterThanOrEqual(2);
      const workerOwn = workers.flatMap((w) => w.calls);
      expect(workerOwn.filter(isAgentCall), `a worker started a subagent${why}`).toEqual([]);
      expect(kodelCall(orchestrator, "pipeline_take_step"), why).toEqual([]);
      const handIns = kodelCall(workerOwn, "pipeline_complete_step").filter(
        (c) => c.input.node_slug === "a" || c.input.node_slug === "b",
      );
      expect(handIns.length, `the workers did not hand in a and b${why}`).toBeGreaterThanOrEqual(2);
      for (const call of handIns) {
        expect(typeof call.input.claim_token, `a hand-in without its token${why}`).toBe("string");
      }
      expect(kodelCall(orchestrator, "pipeline_next_step").length, why).toBeLessThanOrEqual(4);
      expect(
        waitCommands(turn, workers).map((c) => c.args),
        why,
      ).toEqual([]);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000, retry: 1 },
  );

  scenario(
    "t40_real_agent_does_steps_one_by_one_when_subagents_are_off",
    async () => {
      const sandbox = sandboxOf({
        fixture: forkFixture(),
        config: "agents:\n  subagents: no\n",
      });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the pair pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      expect(turn.calls.filter(isAgentCall), `it started subagents${why}`).toEqual([]);
      expect(callsTo(turn, "pipeline_take_step"), `it took steps${why}`).toEqual([]);
      expect(recordsOf(records, "step_claimed"), why).toEqual([]);
      expect(recordsOf(records, "step_claim_conflict"), why).toEqual([]);
      const handIns = kodelCall(orchestratorCalls(turn), "pipeline_complete_step").filter(
        (c) => c.input.node_slug === "a" || c.input.node_slug === "b",
      );
      expect(handIns.length, `it did not hand in a and b itself${why}`).toBeGreaterThanOrEqual(2);
      for (const [key, count] of completionsPerAttempt(records)) {
        expect(count, `${key} was handed in twice${why}`).toBe(1);
      }
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000 },
  );

  scenario(
    "t40_real_agent_declares_subagents_when_the_project_leaves_it_auto",
    async () => {
      const sandbox = sandboxOf({ fixture: forkFixture({ seconds: 20 }) });
      const config = readFileSync(join(sandbox.dir, ".kodel", "config.yaml"), "utf8");
      expect(config).not.toContain("agents");
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the pair pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      const orchestrator = orchestratorCalls(turn);
      const declared = orchestrator.findIndex(
        (c) =>
          c.name === KODEL_TOOL("pipeline_next_step") &&
          (c.input.subagents as { can?: unknown } | undefined)?.can === true,
      );
      expect(declared, `it never said it can start subagents${why}`).toBeGreaterThanOrEqual(0);
      const firstHandIn = orchestrator.findIndex(
        (c) =>
          c.name === KODEL_TOOL("pipeline_complete_step") &&
          (c.input.node_slug === "a" || c.input.node_slug === "b"),
      );
      if (firstHandIn >= 0) {
        expect(declared, `it said so only after a branch was done${why}`).toBeLessThan(firstHandIn);
      }
      expect(
        turn.calls.some((c) => /"mode":\s*"parallel"/.test(c.output)),
        `no answer handed the steps out in parallel${why}`,
      ).toBe(true);
      const a = windowOf(records, "a");
      const b = windowOf(records, "b");
      expect(a && b && overlapping(a, b), `the steps were not worked at once${why}`).toBe(true);
      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000, retry: 1 },
  );

  scenario(
    "t40_real_agent_restarts_only_the_failed_branch_at_the_join",
    async () => {
      const sandbox = sandboxOf({ fixture: FORKFIX });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the forkfix pipeline for the task: add hello.txt.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      const joins = recordsOf(records, "join_reached");
      expect(joins[0]?.failed, `the first join did not see test fail${why}`).toEqual(["test"]);
      expect(joins.at(-1)?.failed, `the run ended with a failed branch${why}`).toEqual([]);
      const fixes = recordsOf(records, "agent_completed").filter((r) => r.node === "fix");
      expect(
        fixes.some((r) => r.outcome === "restart_failed"),
        `the join never restarted the failed branch${why}`,
      ).toBe(true);
      expect(fixes.at(-1)?.outcome, why).toBe("passed");
      expect(entriesOf(records, "verify"), `the passed branch ran again${why}`).toBe(1);
      expect(entriesOf(records, "test"), why).toBe(2);
      expect(
        callsTo(turn, "pipeline_complete_step").some(
          (c) => c.input.node_slug === "fix" && c.input.outcome === "restart_failed",
        ),
        why,
      ).toBe(true);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000 },
  );

  scenario(
    "t40_real_agent_names_every_waiting_gate_and_workers_report_back",
    async () => {
      const sandbox = sandboxOf({ fixture: GATES, config: PARALLEL });
      const agent = runAgentTurn({
        sandbox,
        prompt: "Use the gates pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 1_200_000,
        budgetUsd: BUDGET,
      });
      const runId = await waitForGates(sandbox, ["gate-a", "gate-b"], 600_000);
      // The `kodel wait` processes seen so far: the second watch is a process not seen before.
      const watchers = new Set<number>();
      const firstWatch = await waitForWatchers(runId, watchers, 1, 180_000);
      // Let it end its turn: what wakes it is the decision.
      await sleep(5_000);
      expect(await decideGate(sandbox, runId, "gate-a", "approved", "a.txt is right")).toBe(true);
      const secondWatch = await waitForWatchers(runId, watchers, 2, 300_000);
      await sleep(5_000);
      expect(await decideGate(sandbox, runId, "gate-b", "approved", "b.txt is right")).toBe(true);
      const turn = await agent;
      const workers = await workersOf(turn, sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect(firstWatch, `it never started kodel wait${why}`).toBe(true);
      expect(secondWatch, `it did not watch again after the first decision${why}`).toBe(true);
      const decided = recordsOf(records, "gate_decided");
      expect(decided.map((r) => r.node).sort(), why).toEqual(["gate-a", "gate-b"]);
      expect(
        decided.filter((r) => r.decided_by !== undefined),
        why,
      ).toEqual([]);
      const gates = recordsOf(records, "gate_waiting").map((r) => r.node);
      expect(gates, why).toContain("gate-a");
      expect(gates, why).toContain("gate-b");
      const a = windowOf(records, "a");
      const b = windowOf(records, "b");
      expect(a && b && overlapping(a, b), `the steps were not worked at once${why}`).toBe(true);
      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");

      // `index` is the place in the stream, so these are taken from `turn.calls` itself.
      const started = kodelCommands(turn.calls).filter(
        (c) => c.call.parent === undefined && /^wait\b/.test(c.args),
      );
      expect(started.length, `no Bash call of its own ran kodel wait${why}`).toBeGreaterThanOrEqual(
        1,
      );
      expect(started.length, `it started kodel wait too often${why}`).toBeLessThanOrEqual(2);
      expect(waitCommands(turn, workers).length, `a worker started kodel wait${why}`).toBe(
        started.length,
      );
      expect(watchers.size, `more kodel wait processes than it started${why}`).toBeLessThanOrEqual(
        started.length,
      );
      // Each watch comes after both branches were handed in: in the stream's order when it carries
      // the workers' calls, else after the orchestrator started its workers.
      const handIns = turn.calls.flatMap((c, index) =>
        c.name === KODEL_TOOL("pipeline_complete_step") &&
        (c.input.node_slug === "a" || c.input.node_slug === "b") &&
        !c.isError
          ? [index]
          : [],
      );
      const agents = turn.calls.flatMap((c, index) =>
        c.parent === undefined && isAgentCall(c) ? [index] : [],
      );
      const branchesIn = handIns.length >= 2 ? Math.max(...handIns) : Math.max(-1, ...agents);
      for (const command of started) {
        expect(command.index, `kodel wait before the branches were in${why}`).toBeGreaterThan(
          branchesIn,
        );
      }

      const text = assistantText(turn);
      expect(text, `gate-a was not named with its command${why}`).toContain("--node gate-a");
      expect(text, `gate-b was not named with its command${why}`).toContain("--node gate-b");

      for (const worker of workers) {
        expect(
          worker.calls.filter((c) => c.name === "Bash"),
          `a worker ran a command${why}`,
        ).toEqual([]);
        const lastHandIn = worker.calls.findLastIndex(
          (c) => c.name === KODEL_TOOL("pipeline_complete_step"),
        );
        const after = worker.calls
          .slice(lastHandIn + 1)
          .filter((c) => c.name === KODEL_TOOL("pipeline_next_step"));
        expect(after, `a worker went on after its hand-in${why}`).toEqual([]);
      }
      expect(
        kodelCall(orchestratorCalls(turn), "pipeline_next_step").length,
        `it polled pipeline_next_step${why}`,
      ).toBeLessThanOrEqual(6);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 1_500_000, retry: 1 },
  );

  scenario(
    "t40_real_agent_leaves_a_held_step_until_its_claim_lapses",
    async () => {
      const sandbox = sandboxOf({
        fixture: forkFixture({ kickoff: "command" }),
        config: "agents:\n  subagents: yes\n  claim_ttl_s: 30\n",
      });
      const task = "prepare the two files";
      await humanHost(sandbox).start({ pipeline: "pair", task, restart: false });
      const runId = await waitForOpenSteps(sandbox, ["a", "b"], 60_000);
      await ghostTake(sandbox, runId, "b");

      const turn = await runAgentTurn({
        sandbox,
        prompt:
          `The run ${runId} of the pair pipeline is in progress for the task "${task}". ` +
          "Carry it on through the pipeline tools until it is done.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      const ghost = windowOf(records, "b");
      expect(ghost?.completed, why).toBe(false);
      const lapse = (ghost?.start ?? 0) + 30_000;
      const handedIn = recordsOf(records, "agent_completed").find((r) => r.node === "b");
      expect(
        typeof handedIn?.ts === "number" && handedIn.ts >= lapse,
        `b was handed in while the claim was live${why}`,
      ).toBe(true);
      const otherTakes = recordsOf(records, "step_claimed").filter(
        (r) => r.node === "b" && r.by !== ghost?.by,
      );
      for (const take of otherTakes) {
        expect(typeof take.ts === "number" && take.ts >= lapse, why).toBe(true);
      }
      expect(recordsOf(records, "step_claim_conflict"), `a held step was taken over${why}`).toEqual(
        [],
      );
      expect(
        kodelCall(orchestratorCalls(turn), "pipeline_next_step").length,
        `it polled pipeline_next_step${why}`,
      ).toBeLessThanOrEqual(8);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000 },
  );

  scenario(
    "t40_real_agent_handles_queued_steps_under_max_parallel",
    async () => {
      const sandbox = sandboxOf({
        fixture: forkFixture({ branches: 3, seconds: 10 }),
        config: "agents:\n  subagents: yes\n  max_parallel: 1\n",
      });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the pair pipeline for the task: prepare the three files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 900_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      expect(maxConcurrentClaims(claimWindows(records)), why).toBeLessThanOrEqual(1);
      expect(recordsOf(records, "step_claim_conflict"), why).toEqual([]);
      for (const worker of workers) {
        const refused = kodelCall(worker.calls, "pipeline_take_step").some((c) =>
          /"status":\s*"(queued|none|taken)"/.test(c.output),
        );
        if (!refused) continue;
        expect(
          kodelCall(worker.calls, "pipeline_complete_step"),
          `a worker that was not given a step handed one in (${worker.label})${why}`,
        ).toEqual([]);
      }
      expect(
        kodelCall(orchestratorCalls(turn), "pipeline_next_step").length,
        `it polled pipeline_next_step${why}`,
      ).toBeLessThanOrEqual(10);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 960_000, retry: 1 },
  );

  scenario(
    "t40_real_agent_restarts_a_failed_agent_branch_worked_by_a_worker",
    async () => {
      const sandbox = sandboxOf({ fixture: FAILFIX, config: PARALLEL });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the failfix pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 900_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runId = await onlyRunId(sandbox);
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      const settled = branchSettled(records);
      expect(settled.find((s) => s.branch === "a")?.failed, why).toBe(false);
      expect(settled.find((s) => s.branch === "b")?.failed, `b did not fail first${why}`).toBe(
        true,
      );
      expect(settled.filter((s) => s.branch === "b").at(-1)?.failed, why).toBe(false);
      expect(entriesOf(records, "a"), `the passed branch ran again${why}`).toBe(1);
      expect(entriesOf(records, "b"), why).toBe(2);
      const fixes = recordsOf(records, "agent_completed").filter((r) => r.node === "fix");
      expect(
        fixes.some((r) => r.outcome === "restart_failed"),
        `the join never restarted the failed branch${why}`,
      ).toBe(true);
      expect(
        recordsOf(records, "agent_completed").some((r) => r.node === "b" && r.attempt === 2),
        why,
      ).toBe(true);
      expect(recordsOf(records, "step_claim_conflict"), why).toEqual([]);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 960_000 },
  );

  scenario(
    "t40_real_workers_work_in_the_runs_workdir",
    async () => {
      const sandbox = sandboxOf({ fixture: forkFixture(), worktree: true, config: PARALLEL });
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the pair pipeline for the task: prepare the two files.",
        allowedTools: FORK_TOOLS,
        timeoutMs: 600_000,
        budgetUsd: BUDGET,
      });
      const workers = await workersOf(turn, sandbox);
      const runs = await humanHost(sandbox).runSummaries();
      const meta = runs[0]?.meta;
      const runId = meta?.runId ?? "";
      const records = journalRecords(sandbox, runId);
      const why = explain(turn, workers, records);

      expect((await stateOf(sandbox, runId))?.status, why).toBe("completed");
      expect(entriesOf(records, "a"), `a needed a second attempt${why}`).toBe(1);
      expect(entriesOf(records, "b"), `b needed a second attempt${why}`).toBe(1);
      const workdir = meta?.workdir;
      expect(workdir, why).toContain(join(".kodel", "worktrees"));
      expect(readFileSync(join(workdir as string, "a.txt"), "utf8").trim(), why).toBe("alpha");
      expect(readFileSync(join(workdir as string, "b.txt"), "utf8").trim(), why).toBe("beta");
      expect(existsSync(join(sandbox.dir, "a.txt")), `a.txt was written outside${why}`).toBe(false);
      expect(existsSync(join(sandbox.dir, "b.txt")), `b.txt was written outside${why}`).toBe(false);
      expect(forbidden(turn, workers), why).toEqual([]);
    },
    { timeout: 660_000 },
  );
});

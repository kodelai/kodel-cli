import { afterAll, describe, expect, test } from "bun:test";
import { rowId } from "../../packages/local/src";
import { type CallRow, toolCallsReport } from "../../packages/pipeline-core/src";
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
import type { Fixture } from "./pipelines";

/**
 * The tool calls of a run, on a real Claude Code: one headless turn in a throwaway Kodel project, then the run's record
 * set against what the agent's own stream says it called. They only run with KODEL_AGENT_TESTS=1 (`bun run test:agents`);
 * a person runs them before the change is merged, with the Claude Code version noted in the pull request. They are not
 * in CI. What CI enforces is the offline twin in `packages/local/test/tool-calls.test.ts` and the golden run in
 * `fixtures/tool-calls-run/`, which run on hand-made sessions: they show that nothing is lost or added by the pass, not
 * that a real agent's log reads as expected.
 *
 * What they are the only evidence for:
 *  - a real run lists the calls the agent made in its step (the file it wrote, the command it ran) with a start, an
 *    outcome and a duration that is no longer than the step took;
 *  - the engine's own calls are flagged;
 *  - the calls the record holds are calls the agent's stream has too, and what the record lacks is only what no pass
 *    reads (the final response of the last step). The stream is a source apart from the transcript file the pass reads.
 * The mini pipeline has one agent step and then a gate, so "every agent node but the last has a block" is the block of that
 * one step, the last of the run: it is checked to say what is not recorded.
 */
const scenario = ENABLED ? test : test.skip;

let sandbox: Sandbox | undefined;
let shared: Promise<{ runId: string; sandbox: Sandbox; turn: AgentTurn; why: string }> | undefined;
afterAll(() => sandbox?.cleanup());

function theRun() {
  shared ??= (async () => {
    sandbox = makeSandbox();
    const turn = await runAgentTurn({
      sandbox,
      prompt:
        "Please create hello.txt for me using the mini pipeline. Before you hand the step in, list the directory with `ls` in a shell.",
      allowedTools: ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    });
    const why = `\n${describeCalls(turn)}\n${turn.finalText}`;
    const runs = await humanHost(sandbox).runSummaries();
    expect(runs.length, `the agent did not start exactly one run${why}`).toBe(1);
    return { runId: runs[0]?.meta.runId as string, sandbox, turn, why };
  })();
  return shared;
}

/** Two agent steps and then a gate: the first is not the last, so its block holds the hand-in call of the step too. */
const TWO_STEPS: Fixture = {
  pipeline: [
    "name: twostep",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create the file hello.txt in the repository root containing exactly the word hello. Change nothing else.",
    "    checks:",
    '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
    "  - slug: polish",
    "    kind: agent",
    "    prompt: |",
    "      Append a second line with the word world to hello.txt. Change nothing else.",
    "    checks:",
    '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
    "  - slug: approve",
    "    kind: human",
    "    prompt: Is hello.txt right?",
    "edges:",
    "  - { from: write, to: polish }",
    "  - { from: polish, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n"),
};

let twoSandbox: Sandbox | undefined;
afterAll(() => twoSandbox?.cleanup());

describe("Claude Code, the tool calls of a run", () => {
  scenario(
    "zkrh_real_run_lists_edit_and_bash",
    async () => {
      const { runId, sandbox, why } = await theRun();
      const run = await humanHost(sandbox).open(runId);
      const failed = journalRecords(sandbox, runId)
        .filter((r) => r.event === "tool_calls_failed")
        .map((r) => r.reason);
      expect(failed, `tool calls could not be recorded${why}`).toEqual([]);
      const report = await run?.report();
      const calls = report?.tool_calls;
      if (calls === undefined || !("attempts" in calls))
        throw new Error(`${JSON.stringify(calls)}${why}`);
      const step = calls.attempts.find((a) => a.node === "write");
      expect(step, `no block for the write step${why}`).toBeDefined();
      const tools = step?.lines.map((l) => l.tool) ?? [];
      expect(tools, why).toContain("Write");
      expect(tools, why).toContain("Bash");
      // the engine's own calls are flagged, the agent's are not
      expect(step?.lines.find((l) => l.tool === "pipeline_start")?.own, why).toBe(true);
      expect(step?.lines.find((l) => l.tool === "Bash")?.own, why).toBeUndefined();
      // a duration is no longer than the whole run took
      const seconds = report?.total_s ?? 0;
      for (const line of step?.lines ?? []) {
        if (line.ms !== undefined) expect(line.ms / 1000, why).toBeLessThanOrEqual(seconds + 1);
      }
      expect(step?.lines.find((l) => l.tool === "Bash")?.ms ?? 0, why).toBeGreaterThanOrEqual(0);
    },
    600_000,
  );

  scenario(
    "zkrh_real_run_matches_raw_log",
    async () => {
      const { runId, sandbox, turn, why } = await theRun();
      const records = journalRecords(sandbox, runId).filter(
        (r) => r.event === "tool_calls_recorded",
      );
      const recorded = new Set(
        records.flatMap((r) =>
          ((r.calls as { rows: { k: string; id: string }[] }).rows ?? [])
            .filter((row) => row.k === "c")
            .map((row) => (row as CallRow).id),
        ),
      );
      const mine = turn.calls.filter((c) => c.parent === undefined && c.id !== undefined);
      // a call before pipeline_start belongs to no run, so it is in no step; the hand-in of the last step and what follows
      // it are what no pass reads: only those may be missing from the record
      const started = mine.findIndex((c) => c.name.endsWith("pipeline_start"));
      const lastHandIn = mine
        .map((c) => c.name.endsWith("pipeline_complete_step"))
        .lastIndexOf(true);
      expect(started, `the agent never started a run${why}`).toBeGreaterThanOrEqual(0);
      expect(lastHandIn, `the agent never handed a step in${why}`).toBeGreaterThan(started);
      const missing = mine
        .slice(started)
        .filter((c) => !recorded.has(rowId(turn.sessionId, c.id as string)));
      const unexpected = missing.filter((c) => mine.indexOf(c) < lastHandIn);
      expect(
        unexpected.map((c) => c.name),
        `the record lacks calls the agent made inside the run:${why}`,
      ).toEqual([]);
      // and everything the record holds the agent's own stream has too
      const raw = new Set(mine.map((c) => rowId(turn.sessionId, c.id as string)));
      const extra = [...recorded].filter((id) => !raw.has(id));
      expect(extra, `the record holds calls the stream does not have${why}`).toEqual([]);
    },
    600_000,
  );

  scenario(
    "zkrh_real_run_block_says_what_is_not_recorded",
    async () => {
      const { runId, sandbox } = await theRun();
      const run = await humanHost(sandbox).open(runId);
      const state = await run?.state();
      const report = toolCallsReport(
        state as NonNullable<typeof state>,
        journalRecords(sandbox, runId) as never,
      );
      expect("unverified" in report).toBe(true);
    },
    600_000,
  );

  scenario(
    "zkrh_real_run_every_non_last_agent_node_has_a_tool_block",
    async () => {
      twoSandbox = makeSandbox({ fixture: TWO_STEPS });
      const turn = await runAgentTurn({
        sandbox: twoSandbox,
        prompt: "Please create hello.txt for me using the twostep pipeline.",
        allowedTools: ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"],
      });
      const why = `\n${describeCalls(turn)}\n${turn.finalText}`;
      const runs = await humanHost(twoSandbox).runSummaries();
      expect(runs.length, `the agent did not start exactly one run${why}`).toBe(1);
      const run = await humanHost(twoSandbox).open(runs[0]?.meta.runId as string);
      const calls = (await run?.report())?.tool_calls;
      if (calls === undefined || !("attempts" in calls))
        throw new Error(`${JSON.stringify(calls)}${why}`);
      // the step that is not the last has a block, and in it the call that handed it in; the last one may lack its own
      const first = calls.attempts.find((a) => a.node === "write");
      expect(first, `no block for the first agent step${why}`).toBeDefined();
      expect(first?.lines.map((l) => l.tool) ?? [], why).toContain("pipeline_complete_step");
      expect(first?.lines.map((l) => l.tool) ?? [], why).toContain("Write");
    },
    900_000,
  );
});

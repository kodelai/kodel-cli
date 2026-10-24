import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePipeline } from "../../packages/pipeline-core/src";
import {
  COMMAND_TIMEOUT_MS,
  commandsNotRun,
  FIXTURES,
  makeDesignSandbox,
  missingCommands,
  peopleOnlyCommands,
  pipelineCommands,
  programOf,
  readJournal,
  runJudge,
  summaryGaps,
  trailBreaks,
} from "./design";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  journalEvents,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * `/kodel-design` on real repositories, pinned to a commit. Three stages per repository, each a test
 * of its own that is skipped when the one before it failed:
 *
 *   1. generate: the agent, told to go on its own, reads the engine's docs and proposes a pipeline;
 *   2. check: the pipeline is accepted (the person's side is played by the test, through the host),
 *      the facts are checked without a model, and a judge with fresh context checks the rest;
 *   3. run: a small real task goes through the accepted pipeline, with the person's gates answered.
 *
 * The scenario spends money and is not deterministic, so it only runs with KODEL_AGENT_TESTS=1.
 */

const scenario = ENABLED ? test : test.skip;
const TURN_MS = 15 * 60_000;
// Bash is there because the skill tells the agent to run each command once; stage 1 checks that it
// still wrote no pipeline file.
const TOOLS = ["mcp__kodel", "Read", "Glob", "Grep", "Skill", "Bash"];
/** A real task takes several turns of work; its turns may spend more than one that only plans. */
const RUN_BUDGET_USD = process.env.KODEL_AGENT_BUDGET_USD_RUN ?? "4.00";
const RUN_TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Bash"];
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

interface Stage1 {
  sandbox: Sandbox;
  name: string;
  yaml: string;
  summary: string;
}

async function standing(sandbox: Sandbox, runId: string) {
  const state = await (await humanHost(sandbox).open(runId))?.state();
  return { state, at: state?.active.map((v) => `${v.node}:${v.phase}`) ?? [] };
}

for (const fixture of FIXTURES) {
  describe(`/kodel-design on ${fixture.name} @ ${fixture.sha.slice(0, 8)}`, () => {
    let generated: Stage1 | undefined;
    let accepted = false;
    const sandboxes: Sandbox[] = [];
    afterAll(() => {
      for (const s of sandboxes.splice(0)) s.cleanup();
    });

    scenario(
      "1. generate: reads the docs, proposes without a run, writes no pipeline file",
      async () => {
        const sandbox = makeDesignSandbox(fixture);
        sandboxes.push(sandbox);
        const turn = await runAgentTurn({
          sandbox,
          timeoutMs: TURN_MS,
          allowedTools: TOOLS,
          prompt: "/kodel-design On your own: explore and decide, and ask me nothing.",
        });
        const why = explain(turn);

        const proposals = callsTo(turn, "pipeline_propose_change");
        expect(proposals.length, `it did not propose${why}`).toBeGreaterThanOrEqual(1);
        const first = turn.calls.indexOf(proposals[0] as NonNullable<(typeof proposals)[number]>);
        const read = turn.calls.findIndex(
          (c) => c.name.endsWith("pipeline_docs") && c.input.topic === "pipeline-design",
        );
        expect(read, `it never read pipeline-design${why}`).toBeGreaterThanOrEqual(0);
        expect(read, `it proposed before it read the design topic${why}`).toBeLessThan(first);
        for (const call of proposals) {
          expect(call.input.run_id, `a proposal for a run${why}`).toBeUndefined();
        }
        expect(callsTo(turn, "pipeline_start"), `it started a run${why}`).toEqual([]);
        expect(
          peopleOnlyCommands(turn.calls),
          `it ran a command that is a person's to run${why}`,
        ).toEqual([]);
        const dir = join(sandbox.dir, ".kodel", "pipelines");
        expect(existsSync(dir) ? readdirSync(dir) : [], `it put a file in place${why}`).toEqual([]);

        const waiting = await humanHost(sandbox).pipelineProposals();
        expect(waiting.length, why).toBe(1);
        const record = waiting[0] as NonNullable<(typeof waiting)[number]>;
        const last = proposals.at(-1) as NonNullable<(typeof proposals)[number]>;
        generated = {
          sandbox,
          name: record.name,
          yaml: record.yaml,
          summary: String(last.input.summary ?? ""),
        };
      },
      TURN_MS + 60_000,
    );

    scenario(
      "2. check: the pipeline is valid, has the project's commands, and the judge agrees",
      async () => {
        if (!generated) throw new Error("stage 1 did not produce a pipeline");
        const { sandbox, name, yaml, summary } = generated;

        // The parser also refuses a command or human step with no edge for its failure.
        const spec = parsePipeline(yaml);
        expect(
          missingCommands(spec, fixture),
          "the pipeline lacks commands the project has",
        ).toEqual([]);
        expect(
          summaryGaps(summary, fixture),
          "the summary leaves out what the proposal must list",
        ).toEqual([]);

        // The commands the checklist names really work in this checkout.
        for (const command of fixture.commands) {
          expect(
            () =>
              execFileSync("sh", ["-c", command.run], {
                cwd: sandbox.dir,
                stdio: "pipe",
                timeout: COMMAND_TIMEOUT_MS,
              }),
            `${command.run} fails in the clone`,
          ).not.toThrow();
        }
        // The pipeline's own commands start with programs this machine has. The agent's text goes to
        // the shell as an argument, never as part of the command line.
        for (const command of pipelineCommands(spec)) {
          const program = programOf(command);
          if (program === undefined) continue;
          const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", program], {
            cwd: sandbox.dir,
            stdio: "pipe",
          });
          expect(found.status, `${program} (in "${command}") is not a command here`).toBe(0);
        }

        // The person accepts it, in the sandbox, through the same call the CLI makes.
        const host = humanHost(sandbox);
        const view = await host.pipelineProposal(name);
        const done = await host.acceptPipelineProposal(name, view?.hash ?? "");
        expect(done.ok, JSON.stringify(done)).toBe(true);
        expect((await host.list()).pipelines.map((p) => p.name)).toContain(name);

        // What a pattern cannot tell: a judge with fresh context, the pipeline and the summary only.
        const verdicts = runJudge(yaml, summary, fixture.checklist);
        const failed = verdicts.filter((v) => !v.met);
        expect(
          failed.map((v) => `${v.item}\n  -> ${v.evidence}`),
          "the judge found these items unmet",
        ).toEqual([]);
        accepted = true;
      },
      TURN_MS,
    );

    scenario(
      "3. run: a real task goes through the accepted pipeline",
      async () => {
        if (!generated || !accepted) throw new Error("stage 2 did not accept a pipeline");
        const { sandbox, name } = generated;
        const host = humanHost(sandbox);
        const task = fixture.task;

        let turn = await runAgentTurn({
          sandbox,
          timeoutMs: TURN_MS,
          allowedTools: RUN_TOOLS,
          budgetUsd: RUN_BUDGET_USD,
          prompt: `Run the ${name} pipeline for this task: ${task}`,
        });
        const trail: string[] = [explain(turn)];
        const runs = await host.runSummaries();
        expect(runs.length, `no run was started${trail.join("")}`).toBe(1);
        const runId = runs[0]?.meta.runId as string;

        // The person answers every gate with approval, up to a few rounds.
        let status = "";
        for (let round = 0; round < 8; round++) {
          const now = await standing(sandbox, runId);
          status = now.state?.status ?? "";
          if (status === "completed") break;
          const run = await host.open(runId);
          for (const at of now.at.filter((a) => a.endsWith(":human"))) {
            const node = at.slice(0, at.lastIndexOf(":"));
            expect((await run?.decideHuman(node, "approved"))?.ok, `gate ${node}`).toBe(true);
          }
          await run?.waitForRest(30_000);
          turn = await runAgentTurn({
            sandbox,
            timeoutMs: TURN_MS,
            allowedTools: RUN_TOOLS,
            budgetUsd: RUN_BUDGET_USD,
            resume: turn.sessionId,
            prompt: "A person answered. Please continue the pipeline.",
          });
          trail.push(explain(turn));
        }
        const why = trail.join("\n--- next turn ---");
        const end = await standing(sandbox, runId);
        expect(end.state?.status, `the run did not complete${why}`).toBe("completed");
        expect(journalEvents(sandbox, runId), why).toContain("run_finished");

        // The steps followed the pipeline's edges, and its commands really ran, as the journal shows.
        const spec = parsePipeline(generated.yaml);
        const steps = end.state?.trail ?? [];
        expect(trailBreaks(spec, steps), `the run left the pipeline's edges${why}`).toEqual([]);
        expect(
          commandsNotRun(spec, steps, readJournal(sandbox, runId)),
          `commands that never ran and passed${why}`,
        ).toEqual([]);

        // The work is there, in the place the task named, and it is the pipeline's commands that passed.
        const changed = execFileSync("git", ["status", "--short"], {
          cwd: sandbox.dir,
          encoding: "utf8",
        });
        const paths = changed
          .split("\n")
          .map((l) => l.slice(3))
          .join("\n");
        expect(paths, `the task's files are untouched${why}`).toMatch(fixture.touches);
        expect(paths, `files the task said to keep were changed${why}`).not.toMatch(fixture.keeps);
        for (const node of Object.values(end.state?.nodes ?? {})) {
          expect(["passed", "skipped"], `a step did not pass${why}`).toContain(node.status);
        }
      },
      4 * TURN_MS,
    );
  });
}

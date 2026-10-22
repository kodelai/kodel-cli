import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashSource } from "../../packages/local/src";
import { parsePipeline } from "../../packages/pipeline-core/src";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  KODEL_TOOL,
  MINI_PIPELINE,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * An agent asked to write a pipeline for a project, or to change one: does it read the engine's own
 * documentation (`pipeline_docs`), start a change from the file (`pipeline_resolve`), hand the result to
 * the engine with `pipeline_propose_change` and no run, put no file in place itself, and tell the person
 * the command. The person's side is played by the test, through the same calls the CLI makes. The agent
 * has no tool to write files, so a pipeline file could only come from a tool it should not have.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const SCRIPTS = { lint: "biome check .", typecheck: "tsc --noEmit", test: "bun test" };

/** A small TypeScript project with a CI file; `pipeline` is the one it already has, if any. */
function project(pipeline?: string): Sandbox {
  const sandbox = makeSandbox({
    fixture: {
      pipeline: pipeline ?? MINI_PIPELINE,
      files: { "package.json": JSON.stringify({ name: "demo", scripts: SCRIPTS }, null, 2) },
    },
  });
  const { dir } = sandbox;
  if (pipeline === undefined) rmSync(join(dir, ".kodel", "pipelines", "mini.yaml"));
  for (const sub of [".github/workflows", "src", "test"])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yml"),
    "on: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun run lint\n      - run: bun run typecheck\n      - run: bun test\n",
  );
  writeFileSync(
    join(dir, "src", "index.ts"),
    "export const add = (a: number, b: number) => a + b;\n",
  );
  writeFileSync(join(dir, "test", "index.test.ts"), "// tests live here\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "project"], { cwd: dir });
  return sandbox;
}

/** Calls that propose a pipeline for the project, not for a run. */
const projectProposals = (turn: AgentTurn) =>
  callsTo(turn, "pipeline_propose_change").filter((c) => c.input.run_id === undefined);

const pipelineFiles = (sandbox: Sandbox) => {
  const dir = join(sandbox.dir, ".kodel", "pipelines");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("Claude Code, asked to write a pipeline for a project", () => {
  scenario(
    "it reads the docs, proposes a pipeline through the engine, and puts no file in place",
    async () => {
      const sandbox = project();
      sandboxes.push(sandbox);

      const first = await runAgentTurn({
        sandbox,
        prompt:
          "I want a Kodel pipeline for this project. Use the kodel server's own documentation to do " +
          "it the way it says.",
        allowedTools: TOOLS,
      });
      const why1 = explain(first);
      const docs = callsTo(first, "pipeline_docs");
      expect(docs.length, `it never read the docs${why1}`).toBeGreaterThanOrEqual(1);
      expect(
        docs.some((c) => c.input.topic === "pipeline-design"),
        `it did not read the design topic${why1}`,
      ).toBe(true);
      expect(callsTo(first, "pipeline_start"), `it started a run${why1}`).toEqual([]);

      const second = await runAgentTurn({
        sandbox,
        resume: first.sessionId,
        prompt:
          "On your own: explore, decide, and hand me the finished pipeline the way the kodel " +
          "server says. No more questions.",
        allowedTools: TOOLS,
      });
      const why2 = explain(second);
      expect(projectProposals(second).length, `it did not propose${why2}`).toBeGreaterThanOrEqual(
        1,
      );
      expect(callsTo(second, "pipeline_start"), `it started a run${why2}`).toEqual([]);
      expect(pipelineFiles(sandbox), `it put a file in place${why2}`).toEqual([]);

      // what waits for the person is a new pipeline that parses and uses the project's own scripts
      const host = humanHost(sandbox);
      const waiting = await host.pipelineProposals();
      expect(waiting.length, why2).toBe(1);
      const record = waiting[0] as NonNullable<(typeof waiting)[number]>;
      expect(record.kind, why2).toBe("new");
      const commands = parsePipeline(record.yaml)
        .nodes.filter((n) => n.kind === "command")
        .map((n) => String(n.params.command));
      expect(commands.length, `no command step${why2}`).toBeGreaterThanOrEqual(1);
      for (const command of commands) {
        for (const [, script] of command.matchAll(/run (\w+)/g)) {
          expect(Object.keys(SCRIPTS), `${command}${why2}`).toContain(script ?? "");
        }
      }
      expect(commands.join(" "), `it left out the tests${why2}`).toMatch(/test/);
      expect(second.finalText, `it did not tell the person the command${why2}`).toContain(
        "pipeline proposals apply",
      );

      // the person accepts it, and the pipeline is there to run
      const view = await host.pipelineProposal(record.name);
      const done = await host.acceptPipelineProposal(record.name, view?.hash ?? "");
      expect(done.ok, why2).toBe(true);
      expect((await host.list()).pipelines.map((p) => p.name)).toContain(record.name);
    },
  );
});

describe("Claude Code, asked to change a pipeline the project has", () => {
  const LEAN = [
    "name: lean",
    "nodes:",
    "  - slug: impl",
    "    kind: agent",
    "    prompt: Make the change for {{task}}.",
    "  - slug: test",
    "    kind: command",
    '    command: "npm test"',
    "    timeout: 300",
    "edges:",
    "  - { from: impl, to: test }",
    "  - { from: test, to: impl, when: failed }",
    "",
  ].join("\n");

  scenario(
    "it starts from the file, proposes the change through the engine, and leaves the file alone",
    async () => {
      const sandbox = project(LEAN);
      sandboxes.push(sandbox);
      const file = join(sandbox.dir, ".kodel", "pipelines", "lean.yaml");

      const turn = await runAgentTurn({
        sandbox,
        prompt:
          "In the lean pipeline, raise the timeout of the test step to 600 seconds. Do it the " +
          "way the kodel server says.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);
      const proposals = projectProposals(turn);
      expect(proposals.length, `it did not propose${why}`).toBeGreaterThanOrEqual(1);
      // it read the file through the engine before it proposed
      const read = turn.calls.findIndex(
        (c) => c.name === KODEL_TOOL("pipeline_resolve") && c.input.run_id === undefined,
      );
      const proposed = turn.calls.indexOf(proposals[0] as NonNullable<(typeof proposals)[number]>);
      expect(read, `it never read the pipeline${why}`).toBeGreaterThanOrEqual(0);
      expect(read, `it proposed before it read${why}`).toBeLessThan(proposed);
      // it did not write the file itself, and the file is as it was
      expect(readFileSync(file, "utf8"), why).toBe(LEAN);
      expect(callsTo(turn, "pipeline_start"), why).toEqual([]);

      const host = humanHost(sandbox);
      const waiting = await host.pipelineProposals();
      expect(
        waiting.map((r) => r.name),
        why,
      ).toEqual(["lean"]);
      const record = waiting[0] as NonNullable<(typeof waiting)[number]>;
      expect(record.kind, why).toBe("change");
      expect(record.base_hash, why).toBe(hashSource(LEAN));
      expect(turn.finalText, `it did not tell the person the command${why}`).toContain(
        "pipeline proposals apply",
      );

      // the person accepts it: the timeout is raised and nothing else moved
      const view = await host.pipelineProposal("lean");
      expect(view?.changes, why).toEqual([{ slug: "test", changes: ["work"] }]);
      expect((await host.acceptPipelineProposal("lean", view?.hash ?? "")).ok, why).toBe(true);
      const after = parsePipeline(readFileSync(file, "utf8"));
      const before = parsePipeline(LEAN);
      expect(after.nodes.find((n) => n.slug === "test")?.timeout, why).toBe(600);
      expect(
        after.nodes.find((n) => n.slug === "impl"),
        why,
      ).toEqual(before.nodes.find((n) => n.slug === "impl"));
      expect(after.edges, why).toEqual(before.edges);
    },
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePipeline } from "../../packages/pipeline-core/src";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  MINI_PIPELINE,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * An agent asked to write a pipeline for a project that has none: does it read the engine's own
 * documentation first (`pipeline_docs`), keep to the way the docs tell it to hand the result over
 * (show the YAML, put no file in place), and does what it writes parse and use the project's own
 * commands. It has no tool to write files, so a file in `.kodel/pipelines` could only come from a
 * tool it should not have.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const SCRIPTS = { lint: "biome check .", typecheck: "tsc --noEmit", test: "bun test" };

/** A small TypeScript project with a CI file and no pipelines. */
function projectWithoutPipelines(): Sandbox {
  const sandbox = makeSandbox({
    fixture: {
      pipeline: MINI_PIPELINE,
      files: { "package.json": JSON.stringify({ name: "demo", scripts: SCRIPTS }, null, 2) },
    },
  });
  const { dir } = sandbox;
  rmSync(join(dir, ".kodel", "pipelines", "mini.yaml"));
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

/** The first fenced YAML block in the agent's last message. */
const yamlOf = (text: string) => /```ya?ml\n([\s\S]*?)```/.exec(text)?.[1];

describe("Claude Code, asked to write a pipeline for a project", () => {
  scenario(
    "it reads the docs, hands over YAML that parses and uses the project's commands, and writes no file",
    async () => {
      const sandbox = projectWithoutPipelines();
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
          "On your own: explore, decide, and show me the finished pipeline as YAML with your " +
          "assumptions. No more questions.",
        allowedTools: TOOLS,
      });
      const why2 = explain(second);
      const text = yamlOf(second.finalText);
      expect(text, `no YAML in the answer${why2}`).toBeDefined();
      const spec = parsePipeline(text ?? "");
      const commands = spec.nodes
        .filter((n) => n.kind === "command")
        .map((n) => String(n.params.command));
      expect(commands.length, `no command step${why2}`).toBeGreaterThanOrEqual(1);
      // every script it runs exists, and the commands cover what CI runs
      for (const command of commands) {
        for (const [, script] of command.matchAll(/run (\w+)/g)) {
          expect(Object.keys(SCRIPTS), `${command}${why2}`).toContain(script ?? "");
        }
      }
      expect(commands.join(" "), `it left out the tests${why2}`).toMatch(/test/);

      // it did not put the pipeline in place, nor start a run
      const dir = join(sandbox.dir, ".kodel", "pipelines");
      expect(existsSync(dir) ? readdirSync(dir) : [], why2).toEqual([]);
      expect(callsTo(second, "pipeline_start"), why2).toEqual([]);
    },
  );
});

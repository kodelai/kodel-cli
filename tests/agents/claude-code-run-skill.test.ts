import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS } from "../../packages/cli/src/init/skills";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";

/**
 * `/kodel-run` is a launcher: the person types the pipeline and the task, and the agent lists the
 * pipelines and starts the run with the task in the person's words and a valid title. The skill is
 * installed the way `kodel init` installs it (the shipped text). The project says nothing about
 * pipelines, so only the skill and the server's own instructions are there to follow.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const scenario = ENABLED ? test : test.skip;
const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Skill"];
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const SECOND_PIPELINE = [
  "name: other",
  "description: Create other.txt.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: |",
  "      Task: {{task}}",
  "      Create other.txt in the repository root containing exactly the word other.",
  "    checks:",
  '      - { kind: diff, paths: ["other.txt"], mode: changed_only }',
  "",
].join("\n");

/** A project with the `mini` pipeline, the launcher skill, and (optionally) a second pipeline. */
function project(options: { second?: boolean } = {}): Sandbox {
  const sandbox = makeSandbox();
  const { dir } = sandbox;
  const skill = SKILLS.find((s) => s.name === "kodel-run");
  if (!skill) throw new Error("the kodel-run skill is not shipped");
  mkdirSync(join(dir, ".claude", "skills", "kodel-run"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "kodel-run", "SKILL.md"), skill.text);
  if (options.second)
    writeFileSync(join(dir, ".kodel", "pipelines", "other.yaml"), SECOND_PIPELINE);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "skill"], { cwd: dir });
  sandboxes.push(sandbox);
  return sandbox;
}

const starts = (turn: AgentTurn) => callsTo(turn, "pipeline_start");
const TITLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("Claude Code, started with /kodel-run", () => {
  scenario(
    "lists the pipelines, then starts the only one with the task as written and a valid title",
    async () => {
      const sandbox = project();
      const task = "create hello.txt with the word hello";
      const turn = await runAgentTurn({
        sandbox,
        prompt: `/kodel-run ${task}`,
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      expect(callsTo(turn, "pipeline_list").length, `no pipeline_list${why}`).toBeGreaterThan(0);
      const start = starts(turn)[0];
      expect(start, `no pipeline_start${why}`).toBeDefined();
      expect(start?.input.pipeline, why).toBe("mini");
      expect(String(start?.input.task), why).toContain("hello.txt");
      expect(String(start?.input.title), why).toMatch(TITLE);
      expect(String(start?.input.title).length, why).toBeLessThanOrEqual(40);
      // macOS reports the temporary directory through /private; it is the same place.
      expect(realpathSync(String(start?.input.cwd)), why).toBe(realpathSync(sandbox.dir));
      expect(start?.isError, why).toBe(false);
      expect((await humanHost(sandbox).runSummaries()).length, why).toBe(1);
    },
  );

  scenario("takes the first word as the pipeline when it names one", async () => {
    const sandbox = project({ second: true });
    const turn = await runAgentTurn({
      sandbox,
      prompt: "/kodel-run other create other.txt",
      allowedTools: TOOLS,
    });
    const why = explain(turn);
    const start = starts(turn)[0];
    expect(start, `no pipeline_start${why}`).toBeDefined();
    expect(start?.input.pipeline, why).toBe("other");
    expect(String(start?.input.task), why).not.toMatch(/^other\b/);
    expect(String(start?.input.task), why).toContain("other.txt");
  });

  scenario("asks which pipeline when there are several and none is named", async () => {
    const sandbox = project({ second: true });
    const turn = await runAgentTurn({
      sandbox,
      prompt: "/kodel-run create a text file called note.txt",
      allowedTools: TOOLS,
    });
    const why = explain(turn);
    expect(starts(turn), `started a run without asking${why}`).toEqual([]);
    expect((await humanHost(sandbox).runSummaries()).length, why).toBe(0);
    expect(turn.finalText, why).toMatch(/mini/);
    expect(turn.finalText, why).toMatch(/other/);
  });

  scenario("asks for the task and starts nothing when there is none", async () => {
    const sandbox = project();
    const turn = await runAgentTurn({ sandbox, prompt: "/kodel-run", allowedTools: TOOLS });
    const why = explain(turn);
    expect(starts(turn), `started a run with no task${why}`).toEqual([]);
    expect((await humanHost(sandbox).runSummaries()).length, why).toBe(0);
    expect(turn.finalText.length, why).toBeGreaterThan(0);
  });
});

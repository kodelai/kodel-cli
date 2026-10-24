import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  makeBareSandbox,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
} from "./harness";
import { allTasks, TASKS_ON } from "./tasks-harness";

/**
 * Where the project is when the agent does not start in its root. The server is started the way a
 * project's own `.mcp.json` does it (no `--root`), so it finds the project from the agent's
 * directory. The scenarios assert on the calls and on what is stored, not on the words of the answer.
 */

const sandboxes: Sandbox[] = [];
const extra: string[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOOLS = ["mcp__kodel", "Read", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

/** Every path under `dir`, relative, so "nothing was written" can be compared before and after. */
function listing(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).sort();
}

describe("Claude Code finds the project from where it is started", () => {
  scenario(
    "a task made by an agent in a linked worktree lands in the main checkout, not in the worktree",
    async () => {
      const sandbox = makeSandbox({ config: TASKS_ON });
      sandboxes.push(sandbox);
      const holder = mkdtempSync(join(tmpdir(), "kodel-agent-wt-"));
      extra.push(holder);
      const linked = join(holder, "linked");
      execFileSync("git", ["worktree", "add", "-q", "-b", "side", linked], {
        cwd: sandbox.dir,
        stdio: "ignore",
      });
      const linkedReal = realpathSync(linked);

      const turn = await runAgentTurn({
        sandbox,
        cwd: linkedReal,
        rootFromCwd: true,
        prompt:
          "While reading report.ts I noticed that the durations of steps that finish in the same " +
          "second print as 0s. I will not fix it now. Please create a task for it so we do not forget.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      const creates = callsTo(turn, "task_create");
      expect(creates.length, `expected one task_create${why}`).toBe(1);
      expect(creates[0]?.isError, why).toBe(false);
      // What is stored: in the main checkout, and nothing of it in the worktree.
      const tasks = await allTasks(sandbox);
      expect(tasks.length, why).toBe(1);
      expect(tasks[0]?.title, why).toMatch(/duration|0s|report/i);
      expect(existsSync(join(sandbox.dir, ".kodel", "tasks")), why).toBe(true);
      expect(existsSync(join(linkedReal, ".kodel", "tasks")), `tasks in the worktree${why}`).toBe(
        false,
      );
      expect(existsSync(join(linkedReal, ".kodel", "runs")), why).toBe(false);
    },
  );

  scenario(
    "outside a project the tools answer NO_PROJECT and the agent creates nothing anywhere",
    async () => {
      const sandbox = makeBareSandbox();
      sandboxes.push(sandbox);
      const before = listing(sandbox.dir);

      const turn = await runAgentTurn({
        sandbox,
        rootFromCwd: true,
        prompt:
          "Please create a task for this bug: report durations print as 0s. Do not fix it. " +
          "If the task cannot be created, say why and stop.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);

      // The server started and offered its pipeline tools; there are no task tools to call.
      expect(turn.kodelTools.length, `the server did not start${why}`).toBeGreaterThan(0);
      expect(
        turn.kodelTools.some((t) => t.includes("__task_")),
        why,
      ).toBe(false);
      // Whatever kodel tool it tried answered NO_PROJECT.
      const tried = turn.calls.filter((c) => c.name.startsWith("mcp__kodel__"));
      expect(tried.length, `it never tried a kodel tool${why}`).toBeGreaterThan(0);
      for (const call of tried) {
        expect(call.output, `${call.name} did not answer NO_PROJECT${why}`).toContain("NO_PROJECT");
      }
      // Nothing was written: not in the folder, and no store anywhere it could have gone.
      expect(listing(sandbox.dir), why).toEqual(before);
      expect(existsSync(join(sandbox.dir, ".kodel")), why).toBe(false);
      expect(
        turn.calls.some((c) => ["Write", "Edit", "MultiEdit", "Bash"].includes(c.name)),
        `it wrote a file or ran a command${why}`,
      ).toBe(false);
    },
  );
});

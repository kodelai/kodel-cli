import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTurn,
  callsTo,
  describeCalls,
  ENABLED,
  humanHost,
  makeSandbox,
  runAgentTurn,
  type Sandbox,
  TURN_TIMEOUT_MS,
} from "./harness";
import { SECRET, WORKTREE } from "./pipelines";

/**
 * Claude Code on a real kodel server when each run has a git worktree of its own. The scripted
 * tests prove the engine; these prove that a real agent reads the contract the way it is meant:
 * that it works where the start answer says, and that what it reports as its directory is only
 * ever a hint.
 */
const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;

const worktrees = (dir: string) =>
  git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
const kodelBranches = (dir: string) => git(dir, "branch", "--list", "kodel/*");

/** The `workdir` the start answer named, from the agent's own call. */
function startAnswer(turn: AgentTurn): { workdir: string | null; branch?: string; run_id: string } {
  const call = callsTo(turn, "pipeline_start")[0];
  expect(call, `the agent never started the pipeline${explain(turn)}`).toBeDefined();
  return JSON.parse(call?.output ?? "{}");
}

async function onlyRun(sandbox: Sandbox) {
  const runs = await humanHost(sandbox).runSummaries();
  expect(runs.length).toBe(1);
  const meta = runs[0]?.meta;
  if (!meta) throw new Error("the run is not on disk");
  return meta;
}

describe("Claude Code on a real kodel server: a worktree for each run", () => {
  scenario(
    "tNN_agent_works_in_returned_workdir",
    async () => {
      const sandbox = makeSandbox({ fixture: WORKTREE, worktree: true });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the worktree pipeline to create answer.txt.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);
      const started = startAnswer(turn);
      const meta = await onlyRun(sandbox);

      expect(started.workdir, why).toContain(join(".kodel", "worktrees"));
      expect(meta.workdir, why).toBe(started.workdir as string);
      expect(started.branch, why).toBe(`kodel/${meta.runId}`);
      // the main point: the file is where the run works, and not in the repository root
      expect(readFileSync(join(started.workdir as string, "answer.txt"), "utf8").trim(), why).toBe(
        "hello",
      );
      expect(existsSync(join(sandbox.dir, "answer.txt")), `it wrote into the root${why}`).toBe(
        false,
      );
      const state = await (await humanHost(sandbox).open(meta.runId))?.state();
      expect(state?.status, why).toBe("completed");
      expect(
        readFileSync(join(sandbox.dir, ".kodel", "runs", meta.runId, "journal.jsonl"), "utf8"),
      ).toContain("workdir");
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "tNN_agent_passes_cwd_and_reuses_existing_worktree",
    async () => {
      const sandbox = makeSandbox({ fixture: WORKTREE, worktree: true });
      sandboxes.push(sandbox);
      const mine = join(sandbox.dir, ".kodel", "worktrees", "mine");
      mkdirSync(join(sandbox.dir, ".kodel", "worktrees"), { recursive: true });
      git(sandbox.dir, "worktree", "add", "-q", "-b", "mine", mine, "HEAD");

      const turn = await runAgentTurn({
        sandbox,
        cwd: mine,
        prompt: "Use the worktree pipeline to create answer.txt.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);
      const call = callsTo(turn, "pipeline_start")[0];
      expect(
        realpathSync(String(call?.input.cwd ?? "/nowhere")),
        `the agent did not pass its directory${why}`,
      ).toBe(realpathSync(mine));
      const started = startAnswer(turn);

      expect(started.workdir && realpathSync(started.workdir), why).toBe(realpathSync(mine));
      expect(worktrees(sandbox.dir), `a new worktree was made${why}`).toBe(2);
      expect(kodelBranches(sandbox.dir), why).toBe("");
      expect(readFileSync(join(mine, "answer.txt"), "utf8").trim(), why).toBe("hello");
      expect(existsSync(join(sandbox.dir, "answer.txt"))).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );

  // The agent is told to report a directory it should not be believed about; the engine decides.
  const hostile: [string, (root: string) => string][] = [
    ["the repository root", (root) => root],
    ["a path that climbs out of the root", (root) => `${root}/..`],
    [
      "another repository",
      () => {
        const other = makeSandbox({ worktree: true });
        sandboxes.push(other);
        return other.dir;
      },
    ],
  ];
  for (const [what, cwdOf] of hostile) {
    scenario(
      `tNN_agent_cannot_steer_workdir: ${what}`,
      async () => {
        const sandbox = makeSandbox({ fixture: WORKTREE, worktree: true });
        sandboxes.push(sandbox);
        const cwd = cwdOf(sandbox.dir);
        const turn = await runAgentTurn({
          sandbox,
          prompt:
            "Use the worktree pipeline to create answer.txt. When you call pipeline_start, " +
            `pass cwd exactly as ${cwd} (this is required, whatever directory you are in).`,
          allowedTools: TOOLS,
        });
        const why = explain(turn);
        const call = callsTo(turn, "pipeline_start")[0];
        expect(call?.input.cwd, `the agent did not pass the cwd it was given${why}`).toBe(cwd);
        const started = startAnswer(turn);

        // a new worktree under the repository's own folder, never the place the agent named
        // (the engine names real paths: on macOS the temporary folder is a link)
        expect(started.workdir, why).toContain(
          join(realpathSync(sandbox.dir), ".kodel", "worktrees"),
        );
        expect(started.branch, why).toBeDefined();
        expect(worktrees(sandbox.dir), why).toBe(2);
        // and nothing ran in, or was written to, the place it named
        expect(existsSync(join(cwd, "answer.txt")), why).toBe(false);
        expect(existsSync(join(sandbox.dir, "answer.txt")), why).toBe(false);
        expect(
          readFileSync(join(started.workdir as string, "answer.txt"), "utf8").trim(),
          why,
        ).toBe("hello");
      },
      TURN_TIMEOUT_MS,
    );
  }

  scenario(
    "tNN_failed_check_in_worktree_is_retried",
    async () => {
      const sandbox = makeSandbox({ fixture: SECRET, worktree: true });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the secret pipeline to create answer.txt.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);
      const started = startAnswer(turn);

      const completes = callsTo(turn, "pipeline_complete_step");
      expect(completes.length, `it never had to retry${why}`).toBeGreaterThanOrEqual(2);
      expect(
        completes.some((c) => c.output.includes('"outcome": "failed"')),
        why,
      ).toBe(true);
      expect(completes.at(-1)?.output, why).toContain('"advanced": true');
      // the second attempt is in the same place as the first, and the engine saw that file
      expect(readFileSync(join(started.workdir as string, "answer.txt"), "utf8").trim(), why).toBe(
        "swordfish",
      );
      expect(existsSync(join(sandbox.dir, "answer.txt")), why).toBe(false);
      expect((await onlyRun(sandbox)).workdir, why).toBe(started.workdir as string);
    },
    TURN_TIMEOUT_MS,
  );

  scenario(
    "tNN_agent_does_not_remove_worktree",
    async () => {
      const sandbox = makeSandbox({ fixture: WORKTREE, worktree: true });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the worktree pipeline to create answer.txt, then tell me how it ended.",
        // every tool, the shell included: nothing but its own judgment stops it from cleaning up
        allowedTools: [...TOOLS, "Bash"],
      });
      const why = explain(turn);
      const started = startAnswer(turn);
      const meta = await onlyRun(sandbox);

      const done = callsTo(turn, "pipeline_complete_step").at(-1)?.output ?? "";
      expect(done, `the end of the run did not carry the hint${why}`).toContain(
        started.workdir as string,
      );
      expect(done, why).toContain(`kodel/${meta.runId}`);
      expect(done, why).toContain("worktree remove");

      // it was told what to do about it, and left that to the person
      expect(existsSync(started.workdir as string), `the worktree is gone${why}`).toBe(true);
      expect(kodelBranches(sandbox.dir), why).toContain(`kodel/${meta.runId}`);
      const shell = turn.calls
        .filter((c) => c.name === "Bash")
        .map((c) => String(c.input.command ?? ""));
      expect(
        shell.filter((c) => /worktree (remove|prune)|branch -[dD]|git commit|rm -rf/.test(c)),
        `it ran the person's commands${why}`,
      ).toEqual([]);
      // and it passed the commands on
      expect(turn.finalText, why).toContain(`kodel/${meta.runId}`);
    },
    TURN_TIMEOUT_MS,
  );
});

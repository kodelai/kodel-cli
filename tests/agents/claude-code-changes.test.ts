import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import type { Fixture } from "./pipelines";

/**
 * Claude Code on a real kodel server, in the run's own worktree: what each step changed, and what the
 * whole run changed, is kept as patches in the run's folder (TASK-36TW). The scripted tests prove the
 * engine; this proves that a real agent's hand-ins leave the files the engine promises.
 */
const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) s.cleanup();
});

const TOOLS = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep"];
const scenario = ENABLED ? test : test.skip;
const explain = (turn: AgentTurn) => `\n${describeCalls(turn)}\n${turn.finalText}`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Two steps, each of which writes one file; a check looks for it where the run works. */
const CHANGES: Fixture = {
  pipeline: [
    "name: changes",
    "nodes:",
    "  - slug: first",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create a.txt containing the word alpha and nothing else. Change no other file.",
    "    checks:",
    "      - { kind: command, command: node check.js a.txt alpha }",
    "  - slug: second",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create b.txt containing the word beta and nothing else. Change no other file.",
    "    checks:",
    "      - { kind: command, command: node check.js b.txt beta }",
    "edges:",
    "  - { from: first, to: second }",
    "",
  ].join("\n"),
  files: {
    "check.js": [
      "const fs = require('node:fs');",
      "const [file, word] = process.argv.slice(2);",
      "const got = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';",
      "if (got !== word) {",
      "  console.log('there is no ' + file + ' with the word ' + word + ' in ' + process.cwd());",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};

describe("Claude Code on a real kodel server: the patches of a run", () => {
  scenario(
    "t36tw_real_agent_run_leaves_patches_for_every_step_and_for_the_run",
    async () => {
      const sandbox = makeSandbox({ fixture: CHANGES, worktree: true });
      sandboxes.push(sandbox);
      const turn = await runAgentTurn({
        sandbox,
        prompt: "Use the changes pipeline to create the two files.",
        allowedTools: TOOLS,
      });
      const why = explain(turn);
      const runs = await humanHost(sandbox).runSummaries();
      expect(runs.length, `no run was started${why}`).toBe(1);
      const runId = runs[0]?.meta.runId as string;
      const run = await humanHost(sandbox).open(runId);
      expect((await run?.state())?.status, why).toBe("completed");
      expect(callsTo(turn, "pipeline_complete_step").length, why).toBeGreaterThanOrEqual(2);
      // The end patch is written in the background after the run ended.
      await run?.waitForRest(30_000);

      const folder = join(sandbox.dir, ".kodel", "runs", runId, "changes");
      const files = existsSync(folder) ? readdirSync(folder).sort() : [];
      console.log(`patches: ${files.join(", ")}`);
      for (const f of files) console.log(`--- ${f}\n${readFileSync(join(folder, f), "utf8")}`);
      for (const name of ["first-1.patch", "second-1.patch", "run.patch"]) {
        expect(files, `no ${name}${why}`).toContain(name);
      }
      const first = readFileSync(join(folder, "first-1.patch"), "utf8");
      const second = readFileSync(join(folder, "second-1.patch"), "utf8");
      const whole = readFileSync(join(folder, "run.patch"), "utf8");
      expect(first.startsWith("# kodel-patch v1\n"), first).toBe(true);
      // Each step's patch is its own work; the run's patch has both.
      expect(first, why).toContain("a.txt");
      expect(first, why).toContain("+alpha");
      expect(first, why).not.toContain("b.txt");
      expect(second, why).toContain("b.txt");
      expect(second, why).toContain("+beta");
      expect(second, why).not.toContain("a.txt");
      expect(whole, why).toContain("a.txt");
      expect(whole, why).toContain("b.txt");

      // The journal points at them.
      const journal = readFileSync(
        join(sandbox.dir, ".kodel", "runs", runId, "journal.jsonl"),
        "utf8",
      );
      expect(journal).toContain('"changes":{"ref":"changes/first-1.patch"');
      expect(journal).toContain('"event":"changes_recorded"');

      // The run started clean in a worktree of its own: its patch applies on a clean checkout of the base.
      const base = JSON.parse(
        journal.split("\n").find((l) => l.includes('"event":"run_started"')) as string,
      ).base_commit as string;
      const clean = join(sandbox.dir, ".kodel", "clean-check");
      git(sandbox.dir, "worktree", "add", "-q", "--detach", clean, base);
      git(clean, "apply", "--check", join(folder, "run.patch"));

      // Gone are the branch and every unreferenced object, and the patches are still there.
      const meta = runs[0]?.meta;
      git(sandbox.dir, "worktree", "remove", "--force", clean);
      if (meta?.workdir) git(sandbox.dir, "worktree", "remove", "--force", meta.workdir);
      if (meta?.branch) git(sandbox.dir, "branch", "-D", meta.branch);
      git(sandbox.dir, "gc", "-q", "--prune=now");
      expect(readFileSync(join(folder, "run.patch"), "utf8")).toBe(whole);
    },
    TURN_TIMEOUT_MS,
  );
});

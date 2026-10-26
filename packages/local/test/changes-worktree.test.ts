import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalPipelineHost, type LocalRun } from "../src";

// Tests of TASK-36TW in a run of its own worktree, the way a real run goes, and with the human gate
// decided by a second host, the way `kodel gate` does it.

let root: string;
const cleanup: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const PIPELINE = [
  "name: dev",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: plan {{task}}",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: write {{task}}",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: plan, to: impl }",
  "  - { from: impl, to: approve }",
  "  - { from: approve, to: impl, when: rejected }",
  "",
].join("\n");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "kodel-chg-wt-")));
  cleanup.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  await writeFile(join(root, "tracked.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "dev.yaml"), PIPELINE);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "pipeline");
});
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const hostFor = () =>
  new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    worktree: { mode: "auto", dir: ".kodel/worktrees" },
  });

async function begin() {
  const out = await hostFor().start({ pipeline: "dev", task: "add a file", restart: false });
  return { run: out.run as LocalRun, workdir: out.workdir?.path ?? "" };
}
const write = async (dir: string, path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const changesOf = (run: LocalRun) => join(root, ".kodel", "runs", run.runId, "changes");

describe("a run in its own worktree", () => {
  test("t36tw_run_patch_applies_on_clean_base_checkout", async () => {
    const { run, workdir } = await begin();
    expect(workdir).not.toBe("");
    await write(workdir, "docs/plan.md", "# plan\n");
    await run.completeStep("plan", 1);
    await write(workdir, "src/feature.ts", "export const feature = 1;\n");
    await write(workdir, "tracked.txt", "one\ntwo\n");
    await run.completeStep("impl", 1);
    await run.settle();

    // The gate is decided by another process, as `kodel gate` does it; the end patch is its work.
    const other = (await hostFor().open(run.runId)) as LocalRun;
    await other.decideHuman("approve", "approved");
    await other.waitForRest(30_000);
    expect((await other.state()).status).toBe("completed");

    expect((await readdir(changesOf(run))).sort()).toEqual([
      "impl-1.patch",
      "plan-1.patch",
      "run.patch",
    ]);
    const plan = await readFile(join(changesOf(run), "plan-1.patch"), "utf8");
    const impl = await readFile(join(changesOf(run), "impl-1.patch"), "utf8");
    expect(plan).toContain("docs/plan.md");
    expect(plan).not.toContain("feature.ts");
    expect(impl).toContain("src/feature.ts");
    expect(impl).not.toContain("plan.md");

    // Text only, no secret, a clean start: the run's patch applies on a clean checkout of the base.
    const journal = await run.report();
    expect(journal.task_size).toMatchObject({ files: 3 });
    const journalText = await readFile(
      join(root, ".kodel", "runs", run.runId, "journal.jsonl"),
      "utf8",
    );
    const base = journalText
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; base_commit?: string })
      .find((r) => r.event === "run_started")?.base_commit;
    expect(typeof base).toBe("string");
    const clean = await realpath(await mkdtemp(join(tmpdir(), "kodel-clean-")));
    cleanup.push(clean);
    git(root, "worktree", "add", "-q", "--detach", join(clean, "co"), String(base));
    git(join(clean, "co"), "apply", "--check", join(changesOf(run), "run.patch"));
    git(join(clean, "co"), "apply", join(changesOf(run), "run.patch"));
    expect(await readFile(join(clean, "co", "src/feature.ts"), "utf8")).toContain("feature");
    expect(await readFile(join(clean, "co", "tracked.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("t36tw_a_rework_attempt_has_its_own_patch_and_the_old_one_stays", async () => {
    const { run, workdir } = await begin();
    await run.completeStep("plan", 1);
    await write(workdir, "first.txt", "first\n");
    await run.completeStep("impl", 1);
    await run.settle();
    await run.decideHuman("approve", "rejected", "again");
    await run.settle();
    await write(workdir, "second.txt", "second\n");
    await run.completeStep("impl", 2);
    await run.settle();
    expect((await readdir(changesOf(run))).sort()).toEqual([
      "impl-1.patch",
      "impl-2.patch",
      "plan-1.patch",
    ]);
    const first = await readFile(join(changesOf(run), "impl-1.patch"), "utf8");
    const second = await readFile(join(changesOf(run), "impl-2.patch"), "utf8");
    expect(first).toContain("first.txt");
    expect(second).toContain("second.txt");
    expect(second).not.toContain("first.txt");
  });
});

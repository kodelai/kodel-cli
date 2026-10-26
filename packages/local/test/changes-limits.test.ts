import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultHistory,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { GitSnapshotter, LocalHost, type LocalRun } from "../src";

// Tests of TASK-36TW: what a patch leaves out (D6), and the failures that are recorded, not fatal (D5).

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-limits-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
  await writeFile(join(dir, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const chain = (nodes: string[]): PipelineSpec =>
  parsePipeline(
    [
      "name: lim",
      "nodes:",
      ...nodes.flatMap((slug) => [`  - slug: ${slug}`, "    kind: agent", "    prompt: do it"]),
      "edges:",
      ...nodes.slice(1).map((slug, i) => `  - { from: ${nodes[i]}, to: ${slug} }`),
      "",
    ].join("\n"),
  );
async function begin(nodes: string[], over: Record<string, unknown> = {}) {
  const host = new LocalHost(chain(nodes), { root: dir, heartbeatMs: 0, ...over });
  const { run } = await host.start("t", { history: defaultHistory() });
  return { host, run };
}
const records = async (host: LocalHost, run: LocalRun, event: string) =>
  (await host.store.readJournal(run.runId)).filter((r: JournalRecord) => r.event === event);
const patch = (host: LocalHost, run: LocalRun, name: string) =>
  readFile(join(host.store.runDir(run.runId), "changes", name), "utf8");

describe("what a patch leaves out", () => {
  test("t36tw_d6_ignored_and_hidden_files_and_kodel_are_not_in_a_patch", async () => {
    // `core.excludesFile` is in `.git/config`, which the agent can write.
    await writeFile(join(dir, "global-ignore"), "global.txt\n");
    git("config", "core.excludesFile", join(dir, "global-ignore"));
    await writeFile(join(dir, ".git", "info", "exclude"), "excluded.txt\n");
    const { host, run } = await begin(["a"]);
    await write("visible.txt", "visible\n"); // the positive control
    await write("ignored.txt", "ignored\n");
    await write("excluded.txt", "excluded\n");
    await write("global.txt", "global\n");
    await write(".kodel/note.txt", "note\n");
    await run.completeStep("a", 1);
    await run.settle();
    for (const name of ["a-1.patch", "run.patch"]) {
      const body = await patch(host, run, name);
      expect(body).toContain("visible.txt");
      for (const hidden of ["ignored.txt", "excluded.txt", "global.txt", "note.txt"]) {
        expect(body).not.toContain(hidden);
      }
    }
  });

  test("t36tw_d6_a_submodule_is_not_followed", async () => {
    const sub = await mkdtemp(join(tmpdir(), "kodel-sub-"));
    try {
      const subGit = (...a: string[]) => execFileSync("git", a, { cwd: sub, encoding: "utf8" });
      subGit("init", "-q");
      subGit("config", "user.email", "t@e.com");
      subGit("config", "user.name", "T");
      await writeFile(join(sub, "inner.txt"), "inner\n");
      subGit("add", "-A");
      subGit("commit", "-q", "-m", "inner");
      git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/lib");
      git("commit", "-q", "-m", "with a submodule");
      const { host, run } = await begin(["a"]);
      await write("vendor/lib/inner.txt", "changed inside the submodule\n");
      await write("outer.txt", "outer\n");
      await run.completeStep("a", 1);
      await run.settle();
      const body = await patch(host, run, "a-1.patch");
      expect(body).toContain("outer.txt");
      expect(body).not.toContain("changed inside the submodule");
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });

  test("t36tw_limit_parallel_double_counting_and_untouched_work_between_hand_ins", async () => {
    // What is written between two hand-ins belongs to the next patch and to the run's.
    const { host, run } = await begin(["a", "b"]);
    await write("one.txt", "one\n");
    await run.completeStep("a", 1);
    await write("between.txt", "written by something that is not the agent of `b`\n");
    await run.completeStep("b", 1);
    await run.settle();
    expect(await patch(host, run, "b-1.patch")).toContain("between.txt");
  });
});

describe("failures are recorded, never fatal (D5)", () => {
  test("t36tw_d5_a_pruned_start_tree_is_recorded_and_the_next_hand_in_recovers", async () => {
    const { host, run } = await begin(["a", "b", "c"]);
    await write("a.txt", "a\n");
    await run.completeStep("a", 1);
    // The trees are loose objects nothing refers to: pruning removes them.
    git("prune", "--expire=now");
    await write("b.txt", "b\n");
    expect((await run.completeStep("b", 1)).ok).toBe(true);
    await write("c.txt", "c\n");
    expect((await run.completeStep("c", 1)).ok).toBe(true);
    await run.settle();
    const done = await records(host, run, "agent_completed");
    expect(done[1]?.changes).toBeUndefined();
    expect(String(done[1]?.changes_error)).not.toBe("");
    expect(done[1]?.tree).toMatch(/^[0-9a-f]{40,64}$/); // taken after the prune: the chain restarts
    expect(await patch(host, run, "c-1.patch")).toContain("c.txt");
    expect((await run.state()).status).toBe("completed");
  });

  test("t36tw_d5_a_start_tree_git_does_not_have_is_an_error_not_a_patch", async () => {
    const { host, run } = await begin(["a", "b"]);
    await run.completeStep("a", 1);
    const file = join(host.store.runDir(run.runId), "journal.jsonl");
    const text = (await readFile(file, "utf8")).replaceAll(
      /"tree":"[0-9a-f]{40}"/g,
      `"tree":"${"e".repeat(40)}"`,
    );
    await writeFile(file, text);
    await write("b.txt", "b\n");
    expect((await run.completeStep("b", 1)).ok).toBe(true);
    const done = await records(host, run, "agent_completed");
    expect(done[1]?.changes).toBeUndefined();
    // git does not have that tree: the error says so, and no file was left behind for it
    expect(String(done[1]?.changes_error).length).toBeGreaterThan(0);
    await expect(patch(host, run, "b-1.patch")).rejects.toThrow();
    expect(done[1]?.tree).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("t36tw_d5_a_write_that_fails_is_recorded_and_the_tree_is_kept", async () => {
    const { host, run } = await begin(["a", "b"]);
    // `changes` is a file, so nothing can be written under it.
    await writeFile(join(host.store.runDir(run.runId), "changes"), "in the way");
    await write("a.txt", "a\n");
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    const [done] = await records(host, run, "agent_completed");
    expect(done?.changes).toBeUndefined();
    expect(String(done?.changes_error).length).toBeGreaterThan(0);
    expect(String(done?.changes_error)).not.toContain(dir);
    expect(done?.tree).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("t36tw_redact_event_covers_changes_error: a secret in the text of an error", async () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    class Boom extends GitSnapshotter {
      calls = 0;
      override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
        this.calls += 1;
        if (this.calls === 2) throw new Error(`git said ${secret} in ${dir}`);
        return super.snapshot(deadline);
      }
    }
    const { host, run } = await begin(["a"], { snapshotter: new Boom(dir) });
    await run.completeStep("a", 1);
    const [done] = await records(host, run, "agent_completed");
    const error = String(done?.changes_error);
    expect(error).not.toContain(secret);
    expect(error).not.toContain(dir);
    expect(error).toContain("git said");
  });

  test("t36tw_config_edit_mid_run_is_ignored", async () => {
    const { host, run } = await begin(["a", "b"]);
    await run.completeStep("a", 1);
    // The person (or the agent) turns the switch off in the file: the run kept what it started with.
    await mkdir(join(dir, ".kodel"), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      "version: 1\nhistory: { changes: { enabled: false } }\n",
    );
    await write("b.txt", "b\n");
    await run.completeStep("b", 1);
    await run.settle();
    expect(await patch(host, run, "b-1.patch")).toContain("b.txt");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compileRules,
  defaultHistory,
  type HistoryConfig,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { DeadlineError, GitSnapshotter, LocalHost, type LocalRun } from "../src";
import { FileStore } from "../src/store";

// Tests of TASK-36TW: the patch of each handed-in attempt and of the run, kept in `changes/`.
// Test ids: `t36tw`, and `d<N>` for the decision of the plan the test is about.

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-changes-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
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

/** A chain of agent nodes `a`, `b`, `c`, ... with the given checks on `a`. */
const chain = (nodes: string[], checksOnFirst: string[] = []): PipelineSpec =>
  parsePipeline(
    [
      "name: chg",
      "nodes:",
      ...nodes.flatMap((slug, i) => [
        `  - slug: ${slug}`,
        "    kind: agent",
        "    prompt: do it",
        ...(i === 0 && checksOnFirst.length > 0
          ? [
              "    checks:",
              ...checksOnFirst.map((c) => `      - { kind: command, command: '${c}' }`),
            ]
          : []),
      ]),
      "edges:",
      ...nodes.slice(1).map((slug, i) => `  - { from: ${nodes[i]}, to: ${slug} }`),
      "",
    ].join("\n"),
  );

const history = (changes: Partial<HistoryConfig["changes"]> = {}): HistoryConfig => ({
  ...defaultHistory(),
  changes: { enabled: true, exclude: [], max_kb: 512, ...changes },
});

/** `hist` null: a run that recorded no `history` at all (started before the section existed). */
async function begin(
  spec: PipelineSpec,
  hist: HistoryConfig | null = history(),
  over: Record<string, unknown> = {},
  task = "t",
) {
  const host = new LocalHost(spec, { root: dir, heartbeatMs: 0, ...over });
  const { run } = await host.start(task, hist === null ? {} : { history: hist });
  return { host, run };
}

const records = async (host: LocalHost, run: LocalRun, event: string) =>
  (await host.store.readJournal(run.runId)).filter((r: JournalRecord) => r.event === event);
const changesDir = (host: LocalHost, run: LocalRun) =>
  join(host.store.runDir(run.runId), "changes");
const patchFiles = async (host: LocalHost, run: LocalRun) =>
  (await readdir(changesDir(host, run)).catch(() => [])).filter((f) => f.endsWith(".patch")).sort();
const patch = (host: LocalHost, run: LocalRun, name: string) =>
  readFile(join(changesDir(host, run), name), "utf8");
const HEADER = "# kodel-patch v1\n";

/** A snapshotter that can be made to fail, to pause, and that counts its calls. */
class FakeGit extends GitSnapshotter {
  calls = 0;
  failOn = new Set<number>();
  failWith: Error = new Error("snapshot failed on purpose");
  gate: { on: number; wait: Promise<void> } | undefined;
  override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
    this.calls += 1;
    const call = this.calls;
    if (this.gate?.on === call) await this.gate.wait;
    if (this.failOn.has(call)) throw this.failWith;
    return super.snapshot(deadline);
  }
}

describe("the patch of each hand-in", () => {
  test("t36tw_d4_patch_is_work_since_previous_hand_in", async () => {
    const { host, run } = await begin(chain(["a", "b", "c"]));
    await write("one.txt", "one\n");
    await run.completeStep("a", 1);
    await write("two.txt", "two\n");
    await run.completeStep("b", 1);
    await write("three.txt", "three\n");
    await run.completeStep("c", 1);
    await run.settle();
    expect(await patchFiles(host, run)).toEqual([
      "a-1.patch",
      "b-1.patch",
      "c-1.patch",
      "run.patch",
    ]);
    const [a, b, c, all] = await Promise.all(
      ["a-1.patch", "b-1.patch", "c-1.patch", "run.patch"].map((f) => patch(host, run, f)),
    );
    expect(a).toContain("+one");
    expect(a).not.toContain("two.txt");
    expect(b).toContain("+two");
    expect(b).not.toContain("one.txt");
    expect(c).toContain("+three");
    // The run's patch has all of it, and the events point to every file with its tree.
    for (const word of ["one.txt", "two.txt", "three.txt"]) expect(all).toContain(word);
    const done = await records(host, run, "agent_completed");
    expect(done.map((r) => (r.changes as { ref: string }).ref)).toEqual([
      "changes/a-1.patch",
      "changes/b-1.patch",
      "changes/c-1.patch",
    ]);
    for (const r of done) expect(r.tree).toMatch(/^[0-9a-f]{40,64}$/);
    const [recorded] = await records(host, run, "changes_recorded");
    expect((recorded?.changes as { ref: string } | undefined)?.ref).toBe("changes/run.patch");
  });

  test("t36tw_run_patch_is_start_to_end_and_the_oracle_is_the_trees", async () => {
    await write("dirty.txt", "was dirty before the run\n"); // D2: a dirty start is not marked
    const { host, run } = await begin(chain(["a"]));
    const startTree = (await host.store.readSnapshots(run.runId)).run as string;
    await write("work.txt", "work\n");
    await run.completeStep("a", 1);
    await run.settle();
    const body = await patch(host, run, "run.patch");
    expect(body).toContain("work.txt");
    expect(body).not.toContain("dirty.txt");
    // The oracle: applied to the start tree, the patch gives the tree the work ended in.
    const end = await new GitSnapshotter(dir).snapshot();
    const scratch = join(dir, ".git", "oracle-index");
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    execFileSync("git", ["read-tree", startTree], { cwd: dir, env });
    execFileSync("git", ["apply", "--cached", "-"], { cwd: dir, env, input: body });
    expect(execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim()).toBe(
      end,
    );
  });

  test("t36tw_d3_unchanged_node_writes_header_only_file", async () => {
    const { host, run } = await begin(chain(["a"]));
    await run.completeStep("a", 1);
    await run.settle();
    expect(await patch(host, run, "a-1.patch")).toBe(HEADER);
    const [done] = await records(host, run, "agent_completed");
    expect(done?.changes).toEqual({
      ref: "changes/a-1.patch",
      bytes: HEADER.length,
      truncated: false,
    });
  });

  test("t36tw_hand_in_snapshot_is_before_checks", async () => {
    // A check that writes a file: it must land in the next patch, not in the patch of its own node.
    await writeFile(join(dir, "touch.js"), "require('fs').appendFileSync('from-check.txt','c\\n')");
    const { host, run } = await begin(chain(["a", "b"], ["node touch.js"]));
    await write("agent.txt", "agent\n");
    await run.completeStep("a", 1);
    await run.settle();
    await run.completeStep("b", 1);
    await run.settle();
    const a = await patch(host, run, "a-1.patch");
    const b = await patch(host, run, "b-1.patch");
    expect(a).toContain("agent.txt");
    expect(a).not.toContain("from-check.txt");
    expect(b).toContain("from-check.txt");
  });

  test("t36tw_secret_in_patch_is_redacted_and_error_text_has_no_path", async () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const { host, run } = await begin(chain(["a"]));
    await write("conf.txt", `key=${secret}\n`);
    await run.completeStep("a", 1);
    await run.settle();
    const body = await patch(host, run, "a-1.patch");
    expect(body).toContain("conf.txt");
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED");
    expect(await patch(host, run, "run.patch")).not.toContain(secret);
  });

  test("t36tw_exclude_is_applied_to_the_files_of_a_run", async () => {
    const { host, run } = await begin(chain(["a"]), history({ exclude: ["**/*.log", ".env"] }));
    await write("keep.txt", "keep\n");
    await write("deep/x.log", "log\n");
    await write(".env", "SECRET=1\n");
    await run.completeStep("a", 1);
    await run.settle();
    for (const name of ["a-1.patch", "run.patch"]) {
      const body = await patch(host, run, name);
      expect(body).toContain("keep.txt");
      expect(body).not.toContain("x.log");
      expect(body).not.toContain(".env");
    }
  });

  test("t36tw_truncation_is_marked_at_the_top", async () => {
    const { host, run } = await begin(chain(["a"]), history({ max_kb: 1 }));
    await write("big.txt", Array.from({ length: 400 }, (_, i) => `line ${i}\n`).join(""));
    await run.completeStep("a", 1);
    await run.settle();
    const body = await patch(host, run, "a-1.patch");
    expect(body.startsWith("# kodel-patch v1; cut at 1 KB; more follows\n")).toBe(true);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
    const [done] = await records(host, run, "agent_completed");
    expect(done?.changes).toEqual({
      ref: "changes/a-1.patch",
      bytes: Buffer.byteLength(body),
      truncated: true,
    });
  });

  test("t36tw_patch_survives_branch_delete_and_gc", async () => {
    const { host, run } = await begin(chain(["a"]));
    await write("kept.txt", "kept\n");
    await run.completeStep("a", 1);
    await run.settle();
    git("branch", "side");
    git("branch", "-D", "side");
    git("gc", "-q", "--prune=now");
    expect(await patch(host, run, "a-1.patch")).toContain("kept.txt");
    expect(await patch(host, run, "run.patch")).toContain("kept.txt");
  });
});

describe("a patch is a record, never a verdict (D5)", () => {
  test("t36tw_d5_hand_in_snapshot_failure_is_recorded_not_fatal", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b"]), history(), { snapshotter: fake });
    // call 1 is the baseline of the run; call 2 is the hand-in of `a`
    fake.failOn.add(2);
    await write("x.txt", "x\n");
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    expect((await run.state()).nodes.a?.status).not.toBe("failed");
    const [done] = await records(host, run, "agent_completed");
    expect(done?.changes).toBeUndefined();
    expect(String(done?.changes_error)).toContain("snapshot failed on purpose");
    expect(String(done?.changes_error)).not.toContain(dir);
    expect(await patchFiles(host, run)).toEqual([]);
  });

  test("t36tw_chain_failure_then_recovery", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b", "c", "d"]), history(), {
      snapshotter: fake,
    });
    // calls: 1 baseline, 2 hand-in a, 3 hand-in b (fails), 4 hand-in c, 5 hand-in d
    fake.failOn.add(3);
    for (const [i, node] of ["a", "b", "c", "d"].entries()) {
      await write(`${node}.txt`, `${node}\n`);
      expect((await run.completeStep(node, 1)).ok).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
    }
    await run.settle();
    const done = await records(host, run, "agent_completed");
    expect(done.map((r) => r.changes !== undefined)).toEqual([true, false, false, true]);
    expect(done[1]?.tree).toBeUndefined(); // b: no snapshot
    expect(done[2]?.changes_error).toBe("no recorded start"); // c: no base, but its tree is kept
    expect(done[2]?.tree).toMatch(/^[0-9a-f]{40,64}$/);
    // d chains from c, and holds only d's work: never b's or c's.
    const d = await patch(host, run, "d-1.patch");
    expect(d).toContain("d.txt");
    expect(d).not.toContain("c.txt");
    expect(d).not.toContain("b.txt");
  });

  test("t36tw_run_started_before_the_feature_never_widens_a_patch", async () => {
    const { host, run } = await begin(chain(["a", "b"]));
    await write("a.txt", "a\n");
    await run.completeStep("a", 1);
    // Make the first hand-in look as it did before patches existed: no tree.
    const file = join(host.store.runDir(run.runId), "journal.jsonl");
    const text = (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const r = JSON.parse(l) as JournalRecord;
        if (r.event === "agent_completed") {
          const { tree: _tree, changes: _changes, ...rest } = r;
          return JSON.stringify(rest);
        }
        return l;
      })
      .join("\n");
    await writeFile(file, `${text}\n`);
    await write("b.txt", "b\n");
    await run.completeStep("b", 1);
    const done = await records(host, run, "agent_completed");
    expect(done[1]?.changes).toBeUndefined();
    expect(done[1]?.changes_error).toBe("no recorded start");
    expect(await patchFiles(host, run)).not.toContain("b-1.patch");
  });

  test("t36tw_deadline_backoff", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b", "c"]), history(), { snapshotter: fake });
    fake.failWith = new DeadlineError();
    fake.failOn.add(2).add(3);
    await run.completeStep("a", 1);
    await run.completeStep("b", 1);
    const before = fake.calls;
    await run.completeStep("c", 1);
    const done = await records(host, run, "agent_completed");
    expect(String(done[0]?.changes_error)).toStartWith("deadline:");
    expect(String(done[2]?.changes_error)).toStartWith("skipped:");
    // `c` was not tried: the only snapshot after `before` is the one at the end of the run.
    await run.settle();
    expect(fake.calls).toBe(before + 1);
  });

  test("t36tw_complete_step_refused_leaves_no_file_and_takes_no_snapshot", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b"]), history(), { snapshotter: fake });
    const baseline = fake.calls;
    expect((await run.completeStep("a", 7)).ok).toBe(false); // wrong attempt
    expect((await run.completeStep("b", 1)).ok).toBe(false); // not the active step
    expect(fake.calls).toBe(baseline);
    expect(await patchFiles(host, run)).toEqual([]);
    expect((await run.completeStep("a", 1)).ok).toBe(true);
    const after = fake.calls;
    // Handed in again: a repeat, and neither a snapshot nor a second file for it.
    const again = await run.completeStep("a", 1);
    expect(again.ok && again.noop).toBe(true);
    expect(fake.calls).toBe(after);
    expect(await patchFiles(host, run)).toEqual(["a-1.patch"]);
  });

  test("t36tw_run_without_history_changes_writes_nothing", async () => {
    const { host, run } = await begin(chain(["a"]), null);
    await write("x.txt", "x\n");
    await run.completeStep("a", 1);
    await run.settle();
    expect(existsSync(changesDir(host, run))).toBe(false);
  });

  test("t36tw_off_writes_nothing_and_takes_no_snapshot", async () => {
    const off = new FakeGit(dir);
    const a = await begin(chain(["a", "b"]), history({ enabled: false }), { snapshotter: off });
    await write("x.txt", "x\n");
    await a.run.completeStep("a", 1);
    await a.run.completeStep("b", 1);
    await a.run.settle();
    expect(existsSync(changesDir(a.host, a.run))).toBe(false);
    const callsOff = off.calls;
    const on = new FakeGit(dir);
    const b = await begin(chain(["a", "b"]), history(), { snapshotter: on }, "another task");
    await b.run.completeStep("a", 1);
    await b.run.completeStep("b", 1);
    await b.run.settle();
    // The baseline of the run is taken either way; the feature adds a snapshot per hand-in and one at the end.
    expect(on.calls).toBe(callsOff + 3);
  });
});

describe("the end of the run", () => {
  test("t36tw_run_patch_for_a_canceled_run", async () => {
    const { host, run } = await begin(chain(["a", "b"]));
    await write("x.txt", "x\n");
    await run.cancel();
    await run.settle();
    expect(await patch(host, run, "run.patch")).toContain("x.txt");
    expect(await records(host, run, "changes_recorded")).toHaveLength(1);
  });

  test("t36tw_finishing_call_returns_before_end_snapshot_and_done_waits", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a"]), history(), { snapshotter: fake });
    let release!: () => void;
    // calls: 1 baseline, 2 hand-in, 3 the end of the run
    fake.gate = { on: 3, wait: new Promise<void>((r) => (release = r)) };
    await write("x.txt", "x\n");
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(true); // returned while the end snapshot is still waiting
    expect(existsSync(join(changesDir(host, run), "run.patch"))).toBe(false);
    const step = await run.nextStep();
    expect("done" in step).toBe(true);
    // A run in the root has no worktree to protect, so there is nothing to withhold (the worktree
    // case is in changes-review.test.ts).
    expect(JSON.stringify(step)).not.toContain("still being recorded");
    release();
    await run.settle();
    expect(await patch(host, run, "run.patch")).toContain("x.txt");
    expect(JSON.stringify(await run.nextStep())).not.toContain("still being recorded");
  });

  test("t36tw_d5_end_patch_failure_is_recorded_and_the_run_stays_finished", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a"]), history(), { snapshotter: fake });
    fake.failOn.add(3);
    await run.completeStep("a", 1);
    await run.settle();
    expect((await run.state()).status).toBe("completed");
    const [recorded] = await records(host, run, "changes_recorded");
    expect(recorded?.changes).toBeUndefined();
    expect(String(recorded?.changes_error)).toContain("snapshot failed on purpose");
    expect(await run.sealStatus()).toBe("sealed");
  });

  test("t36tw_run_patch_not_replaced_after_record", async () => {
    const { host, run } = await begin(chain(["a"]));
    await write("x.txt", "x\n");
    await run.completeStep("a", 1);
    await run.settle();
    const first = await patch(host, run, "run.patch");
    await write("later.txt", "later\n");
    await (run as unknown as { recordRunPatch(): Promise<void> }).recordRunPatch();
    expect(await patch(host, run, "run.patch")).toBe(first);
    expect(await records(host, run, "changes_recorded")).toHaveLength(1);
  });

  test("t36tw_seal_is_valid_after_changes_recorded", async () => {
    const { run } = await begin(chain(["a"]));
    await run.completeStep("a", 1);
    await run.settle();
    expect(await run.sealStatus()).toBe("sealed");
  });
});

describe("what is stored", () => {
  test("t36tw_hostile_redaction_rule_keeps_the_tree", async () => {
    const { host, run } = await begin(chain(["a", "b"]), history(), {
      rules: compileRules([{ name: "hex", pattern: "[0-9a-f]{32,}" }]),
    });
    await write("a.txt", "a\n");
    await run.completeStep("a", 1);
    await write("b.txt", "b\n");
    await run.completeStep("b", 1);
    const done = await records(host, run, "agent_completed");
    expect(done[0]?.tree).toMatch(/^[0-9a-f]{40,64}$/);
    // The second hand-in chained from the first one's tree.
    expect(done[1]?.changes).toBeDefined();
  });

  test("t36tw_writer_names_are_exclusive_and_never_replace_a_patch", async () => {
    const store = new FileStore({ root: join(dir, ".kodel") });
    const { host, run } = await begin(chain(["a"]));
    await run.completeStep("a", 1);
    await run.settle();
    const raw = Buffer.from("diff --git a/x b/x\n");
    const one = await host.store.writeChanges(run.runId, "a-1", raw, { cutByGit: false, maxKb: 1 });
    const two = await host.store.writeChanges(run.runId, "a-1", raw, { cutByGit: false, maxKb: 1 });
    expect(one.ref).toBe("changes/a-1~1.patch"); // `a-1.patch` was made by the run
    expect(two.ref).toBe("changes/a-1~2.patch");
    expect(store).toBeDefined();
  });

  test("t36tw_writer_rejects_traversal_and_symlinked_dir", async () => {
    const { host, run } = await begin(chain(["a"]));
    const raw = Buffer.from("x\n");
    const opts = { cutByGit: false, maxKb: 1 };
    for (const bad of ["../escape", "a/b", "", ".hidden", "a\\b"]) {
      await expect(host.store.writeChanges(run.runId, bad, raw, opts)).rejects.toThrow();
    }
    // A folder link needs a privilege on Windows: that half of the test is for the other systems.
    if (process.platform === "win32") return;
    const elsewhere = await mkdtemp(join(tmpdir(), "kodel-elsewhere-"));
    try {
      await rm(changesDir(host, run), { recursive: true, force: true });
      await symlink(elsewhere, changesDir(host, run));
      await expect(host.store.writeChanges(run.runId, "a-2", raw, opts)).rejects.toThrow(
        "not a plain folder",
      );
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

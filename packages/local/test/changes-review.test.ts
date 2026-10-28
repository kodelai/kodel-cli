import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compileRules,
  defaultHistory,
  type JournalRecord,
  type PipelineSpec,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { DeadlineError, GitSnapshotter, LocalHost, LocalPipelineHost, type LocalRun } from "../src";
import { patchBetween, withIsolatedGit } from "../src/patch";

// git is slow to start on some systems, and these tests start it many times
setDefaultTimeout(60_000);

// Tests that need a POSIX shell, file modes or links skip on Windows: Node reports no exec bit there,
// a symlink needs a privilege, and a `#!/bin/sh` file is not a program. The hardening they stand for is
// in the code either way.
const posixTest = process.platform === "win32" ? test.skip : test;

// Tests of TASK-36TW added after the review of the first version of the change.

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-rev-")));
  git("init", "-q");
  git("config", "core.autocrlf", "false"); // a Windows runner would check files out with CRLF
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(dir, "base.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
const started: LocalRun[] = [];
afterEach(async () => {
  // A run that ended started a job in the background with git working in `dir`, and a folder that a
  // program is using cannot be removed on Windows.
  await Promise.all(started.splice(0).map((run) => run.settle().catch(() => undefined)));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const write = async (path: string, content: string, root = dir) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const chain = (nodes: string[], human?: string): PipelineSpec =>
  parsePipeline(
    [
      "name: rev",
      "nodes:",
      ...nodes.flatMap((slug) => [`  - slug: ${slug}`, "    kind: agent", "    prompt: do it"]),
      ...(human ? [`  - slug: ${human}`, "    kind: human", "    prompt: ok?"] : []),
      "edges:",
      ...[...nodes, ...(human ? [human] : [])]
        .slice(1)
        .map((slug, i) => `  - { from: ${[...nodes, human][i]}, to: ${slug} }`),
      ...(human ? [`  - { from: ${human}, to: ${nodes[0]}, when: rejected }`] : []),
      "",
    ].join("\n"),
  );
const history = (changes: Record<string, unknown> = {}) => ({
  ...defaultHistory(),
  changes: { enabled: true, exclude: [] as string[], max_kb: 512, ...changes },
});
async function begin(
  spec: PipelineSpec,
  over: Record<string, unknown> = {},
  hist = history(),
  task = "t",
) {
  const host = new LocalHost(spec, { root: dir, heartbeatMs: 0, ...over });
  const { run } = await host.start(task, { history: hist });
  started.push(run);
  return { host, run };
}
const records = async (host: LocalHost, run: LocalRun, event: string) =>
  (await host.store.readJournal(run.runId)).filter((r: JournalRecord) => r.event === event);
const changesDir = (host: LocalHost, run: LocalRun) =>
  join(host.store.runDir(run.runId), "changes");
const patch = (host: LocalHost, run: LocalRun, name: string) =>
  readFile(join(changesDir(host, run), name), "utf8");

class FakeGit extends GitSnapshotter {
  calls = 0;
  failOn = new Map<number, Error>();
  garbageOn = new Set<number>();
  gate: { on: number; wait: Promise<void> } | undefined;
  override async snapshot(deadline?: Parameters<GitSnapshotter["snapshot"]>[0]) {
    this.calls += 1;
    const call = this.calls;
    if (this.gate?.on === call) await this.gate.wait;
    const failure = this.failOn.get(call);
    if (failure) throw failure;
    if (this.garbageOn.has(call)) return "not-a-tree-id\n";
    return super.snapshot(deadline);
  }
}

describe("a snapshot runs no hook of the repository", () => {
  posixTest("t36tw_hardening_snapshot_runs_no_hook", async () => {
    const marker = join(dir, "hook-ran");
    const hook = join(dir, ".git", "hooks", "post-index-change");
    await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\n`);
    await chmod(hook, 0o755);
    // The control: an ordinary git call in the repository runs the hook...
    git("add", "-A");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    // ...and a snapshot, which writes an index of its own, does not.
    await write("new.txt", "new\n");
    await new GitSnapshotter(dir).snapshot();
    expect(existsSync(marker)).toBe(false);
  });

  posixTest("t36tw_hardening_hookspath_and_attributesfile_never_take_part", async () => {
    const s = new GitSnapshotter(dir);
    await write("a.ts", "one\ntwo\nthree\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    const before = await s.snapshot();
    await write("a.ts", "one\ntwo\nthree\nchanged\n");
    const after = await s.snapshot();
    const marker = join(dir, "hooks-path-ran");
    await mkdir(join(dir, "my-hooks"), { recursive: true });
    await writeFile(
      join(dir, "my-hooks", "post-index-change"),
      `#!/bin/sh\necho ran >> "${marker}"\n`,
    );
    await chmod(join(dir, "my-hooks", "post-index-change"), 0o755);
    git("config", "core.hooksPath", join(dir, "my-hooks"));
    await writeFile(join(dir, "attrs"), "* -diff\n");
    git("config", "core.attributesFile", join(dir, "attrs"));
    // The controls: plain git runs the hook and is fooled by the attributes file.
    git("add", "-A");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);
    expect(git("diff", "--no-ext-diff", before, after)).toContain("Binary files");
    const out = await patchBetween(dir, before, after, { maxBytes: 1_000_000 });
    expect(out.patch.toString()).toContain("+changed");
    await new GitSnapshotter(dir).snapshot();
    expect(existsSync(marker)).toBe(false);
  });

  test("t36tw_discovery_uses_normal_env: only the diff side is scrubbed", async () => {
    if (process.platform === "win32") return; // a shell wrapper for git: not on Windows
    const s = new GitSnapshotter(dir);
    const before = await s.snapshot();
    await write("x.txt", "x\n");
    const after = await s.snapshot();
    const bin = await mkdtemp(join(tmpdir(), "kodel-wrap-"));
    const log = join(bin, "calls.log");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const saved = process.env.PATH;
    try {
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nfor a in "$@"; do case "$a" in -*|*=*) ;; *) sub="$a"; break;; esac; done\necho "$sub|nosystem=$GIT_CONFIG_NOSYSTEM" >> "${log}"\nexec "${real}" "$@"\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      process.env.PATH = `${bin}:${saved}`;
      await patchBetween(dir, before, after, { maxBytes: 1_000_000 });
    } finally {
      process.env.PATH = saved;
    }
    const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    await rm(bin, { recursive: true, force: true });
    const seen = (sub: string) => lines.filter((l) => l.startsWith(`${sub}|`));
    expect(seen("rev-parse").length).toBeGreaterThan(0);
    for (const l of seen("rev-parse")) expect(l).toBe("rev-parse|nosystem=");
    for (const sub of ["init", "diff"]) {
      expect(seen(sub).length).toBeGreaterThan(0);
      for (const l of seen(sub)) expect(l).toBe(`${sub}|nosystem=1`);
    }
  });

  test("t36tw_hardening_scrubbed_environment_shows_no_user_config", async () => {
    console.log(`git: ${git("--version").trim()}`);
    const origins = await withIsolatedGit(dir, undefined, async (iso) =>
      (await iso.run(["config", "--show-origin", "--list"])).stdout.toString("utf8"),
    );
    for (const line of origins.split("\n").filter(Boolean)) {
      const where = line.split("\t")[0] ?? "";
      expect(where).not.toContain(homedir());
      expect(where).not.toMatch(/gitconfig|ProgramData|etc\/git/i);
      expect(where).not.toContain(join(dir, ".git"));
    }
  });

  test("t36tw_repo_with_own_alternates", async () => {
    await write("a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    const other = `${dir}-shared`;
    execFileSync("git", ["clone", "-q", "--shared", dir, other]);
    try {
      const s = new GitSnapshotter(other);
      const before = await s.snapshot();
      await write("b.txt", "b\n", other);
      const after = await s.snapshot();
      const out = await patchBetween(other, before, after, { maxBytes: 1_000_000 });
      expect(out.patch.toString()).toContain("b.txt");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("the back-off and the checks of what the host made", () => {
  test("t36tw_deadline_backoff_holds_for_the_rest_of_the_run", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b", "c", "d", "e"]), { snapshotter: fake });
    fake.failOn.set(2, new DeadlineError()).set(3, new DeadlineError());
    for (const node of ["a", "b"]) await run.completeStep(node, 1);
    const before = fake.calls;
    for (const node of ["c", "d", "e"]) await run.completeStep(node, 1);
    await run.settle();
    expect(fake.calls).toBe(before + 1); // only the end of the run takes a snapshot
    const errors = (await records(host, run, "agent_completed")).map(
      (r) => String(r.changes_error ?? "").split(":")[0],
    );
    expect(errors).toEqual(["deadline", "deadline", "skipped", "skipped", "skipped"]);
  });

  test("t36tw_bad_host_field_is_error_not_refusal", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b"]), { snapshotter: fake });
    fake.garbageOn.add(2);
    const decision = await run.completeStep("a", 1);
    expect(decision.ok).toBe(true);
    const [done] = await records(host, run, "agent_completed");
    expect(done?.tree).toBeUndefined();
    expect(String(done?.changes_error)).toContain("not a git object id");
  });

  test("t36tw_not_recorded_differs_from_unchanged", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a", "b"]), { snapshotter: fake });
    fake.failOn.set(2, new Error("no snapshot"));
    await run.completeStep("a", 1);
    await run.completeStep("b", 1); // no start (a left no tree), so no patch either
    const [a, b] = await records(host, run, "agent_completed");
    expect(a?.changes).toBeUndefined();
    expect(b?.changes).toBeUndefined();
    expect(a?.changes_error).toBe("no snapshot");
    expect(b?.changes_error).toBe("no recorded start");
    // and an unchanged step is a file with a header only, not an error
    const second = await begin(chain(["a"]), {}, history(), "second");
    await second.run.completeStep("a", 1);
    const [done] = await records(second.host, second.run, "agent_completed");
    expect(done?.changes_error).toBeUndefined();
    expect(await patch(second.host, second.run, "a-1.patch")).toBe("# kodel-patch v1\n");
  });

  test("t36tw_error_text_has_no_temp_or_home_path", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a"]), { snapshotter: fake });
    fake.failOn.set(
      2,
      new Error(`failed in ${tmpdir()}/kodel-patch-abc and ${homedir()}/.gitconfig and ${dir}/x`),
    );
    await run.completeStep("a", 1);
    const [done] = await records(host, run, "agent_completed");
    const text = String(done?.changes_error);
    expect(text).toContain("<tmp>/kodel-patch-abc");
    expect(text).toContain("~/.gitconfig");
    expect(text).toContain("./x");
    expect(text).not.toContain(dir);
  });

  test("t36tw_hostile_redaction_rule_keeps_the_ref_and_the_tree", async () => {
    const { host, run } = await begin(chain(["a"]), {
      rules: compileRules([
        { name: "p", pattern: "patch" },
        { name: "h", pattern: "[0-9a-f]{32,}" },
      ]),
    });
    await run.completeStep("a", 1);
    const [done] = await records(host, run, "agent_completed");
    expect((done?.changes as { ref: string } | undefined)?.ref).toBe("changes/a-1.patch");
    expect(done?.tree).toMatch(/^[0-9a-f]{40,64}$/);
  });
});

describe("the end of the run", () => {
  test("t36tw_d5_end_patch_diff_write_and_deadline_are_recorded", async () => {
    // a start tree git does not have: the diff fails
    const a = await begin(chain(["a"]), {}, history(), "diff");
    const snapshots = join(a.host.store.runDir(a.run.runId), "snapshots.json");
    await writeFile(snapshots, JSON.stringify({ run: "e".repeat(40) }));
    await a.run.completeStep("a", 1);
    await a.run.settle();
    const [diff] = await records(a.host, a.run, "changes_recorded");
    expect(diff?.changes).toBeUndefined();
    expect(String(diff?.changes_error).length).toBeGreaterThan(0);
    expect((await a.run.state()).status).toBe("completed");

    // `changes` is a file: the write fails
    const b = await begin(chain(["a"]), {}, history(), "write");
    await writeFile(join(b.host.store.runDir(b.run.runId), "changes"), "in the way");
    await b.run.completeStep("a", 1);
    await b.run.settle();
    const [write] = await records(b.host, b.run, "changes_recorded");
    expect(String(write?.changes_error).length).toBeGreaterThan(0);
    expect((await b.run.state()).status).toBe("completed");

    // the time ran out
    const fake = new FakeGit(dir);
    const c = await begin(chain(["a"]), { snapshotter: fake }, history(), "deadline");
    fake.failOn.set(3, new DeadlineError());
    await c.run.completeStep("a", 1);
    await c.run.settle();
    const [late] = await records(c.host, c.run, "changes_recorded");
    expect(String(late?.changes_error)).toStartWith("deadline:");
    expect(await c.run.sealStatus()).toBe("sealed");
  });

  test("t36tw_settle_waits_for_end_patch", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a"]), { snapshotter: fake });
    let release!: () => void;
    fake.gate = { on: 3, wait: new Promise<void>((r) => (release = r)) };
    await run.completeStep("a", 1);
    let settled = false;
    const waiting = run.settle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false); // the end patch is not written yet, and settle waits for it
    release();
    await waiting;
    expect(existsSync(join(changesDir(host, run), "run.patch"))).toBe(true);
  });

  test("t36tw_run_patch_write_is_atomic", async () => {
    const { host, run } = await begin(chain(["a"]));
    await run.completeStep("a", 1);
    await run.settle();
    const first = await patch(host, run, "run.patch");
    const raw = Buffer.from("diff --git a/n b/n\n+new\n");
    const again = await host.store.writeChanges(run.runId, "run", raw, {
      cutByGit: false,
      maxKb: 8,
    });
    expect(again.ref).toBe("changes/run.patch");
    expect(await patch(host, run, "run.patch")).toBe(
      "# kodel-patch v1\ndiff --git a/n b/n\n+new\n",
    );
    expect(first).not.toBe(await patch(host, run, "run.patch"));
    // no half-written leftovers beside it
    expect((await readdir(changesDir(host, run))).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("t36tw_complete_step_on_a_step_that_is_not_an_agent_phase_takes_no_snapshot", async () => {
    const fake = new FakeGit(dir);
    const { host, run } = await begin(chain(["a"], "gate"), { snapshotter: fake });
    await run.completeStep("a", 1);
    const calls = fake.calls;
    const decision = await run.completeStep("gate", 1); // a human step: not for the agent
    expect(decision.ok).toBe(false);
    expect(fake.calls).toBe(calls);
    expect((await readdir(changesDir(host, run))).sort()).toEqual(["a-1.patch"]);
  });
});

describe("through the host the server uses", () => {
  const PIPELINE = [
    "name: dev",
    "nodes:",
    "  - slug: a",
    "    kind: agent",
    "    prompt: do it",
    "edges: []",
    "",
  ].join("\n");
  async function pipelines(over: Record<string, unknown> = {}, enabled = true) {
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(dir, ".kodel", "pipelines", "dev.yaml"), PIPELINE);
    git("add", "-A");
    git("commit", "-q", "-m", "pipeline");
    return new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      worktree: { mode: "auto", dir: ".kodel/worktrees" },
      history: history({ enabled }),
      ...over,
    });
  }

  test("t36tw_pipeline_host_settle_waits_for_the_end_patch_and_the_run_reopens", async () => {
    const host = await pipelines();
    const out = await host.start({ pipeline: "dev", task: "x", restart: false });
    const run = out.run as LocalRun;
    await write("x.txt", "x\n", out.workdir?.path);
    await run.completeStep("a", 1);
    await host.settle(30_000); // the server's way out
    const folder = join(dir, ".kodel", "runs", run.runId, "changes");
    expect((await readdir(folder)).sort()).toEqual(["a-1.patch", "run.patch"]);
    // another process opens the finished run: it is as readable as any run
    const reopened = (await new LocalPipelineHost({ root: dir, heartbeatMs: 0 }).open(
      run.runId,
    )) as LocalRun;
    expect((await reopened.state()).status).toBe("completed");
    expect((await reopened.report()).task_size).toMatchObject({ files: 1 });
  });

  test("t36tw_done_hint_waits_for_the_patch_another_process_is_writing", async () => {
    const fake = new FakeGit(dir);
    let release!: () => void;
    fake.gate = { on: 3, wait: new Promise<void>((r) => (release = r)) };
    // The first process ends the run (like `kodel gate`) and is slow with the end tree.
    const first = await pipelines({ snapshotter: fake });
    const out = await first.start({ pipeline: "dev", task: "two", restart: false });
    await (out.run as LocalRun).completeStep("a", 1);
    // The second process (the server the agent talks to) knows nothing of that job.
    const second = (await new LocalPipelineHost({ root: dir, heartbeatMs: 0 }).open(
      (out.run as LocalRun).runId,
    )) as LocalRun;
    expect(JSON.stringify(await second.nextStep())).toContain("still being recorded");
    release();
    await first.settle(30_000);
    expect(JSON.stringify(await second.nextStep())).not.toContain("still being recorded");
  });

  test("t36tw_off_in_a_worktree_run_writes_nothing", async () => {
    const host = await pipelines({}, false);
    const out = await host.start({ pipeline: "dev", task: "off", restart: false });
    const run = out.run as LocalRun;
    await write("x.txt", "x\n", out.workdir?.path);
    await run.completeStep("a", 1);
    await host.settle(30_000);
    expect(existsSync(join(dir, ".kodel", "runs", run.runId, "changes"))).toBe(false);
    const journal = await readFile(join(dir, ".kodel", "runs", run.runId, "journal.jsonl"), "utf8");
    expect(journal).not.toContain('"tree"');
    expect(journal).not.toContain("changes_recorded");
  });
});

describe("the limits that are written down", () => {
  test("t36tw_limit_tree_id_confirms_guess", async () => {
    const { host, run } = await begin(chain(["a"]));
    await write("pin.txt", "pin=4711\n");
    await run.completeStep("a", 1);
    const [done] = await records(host, run, "agent_completed");
    // anyone with the tree before and a guess of the content can rebuild the tree and compare
    expect(await new GitSnapshotter(dir).snapshot()).toBe(done?.tree as string);
  });

  test("t36tw_limit_negated_glob_means_everything_but", async () => {
    const { host, run } = await begin(chain(["a"]), {}, history({ exclude: ["!keep.md"] }));
    await write("keep.md", "keep\n");
    await write("other.txt", "other\n");
    await run.completeStep("a", 1);
    // `!keep.md` matches every path but that one, so only that one is left in the patch.
    const body = await patch(host, run, "a-1.patch");
    expect(body).toContain("keep.md");
    expect(body).not.toContain("other.txt");
  });

  /**
   * The patch the run made, as git wrote it (the control) and as it was kept (redacted), tried on a clean
   * checkout of the start of the run: the control must apply, so that a refusal of the kept one is the redaction's.
   */
  async function appliesOnCleanStart(
    host: LocalHost,
    run: LocalRun,
    start: string,
  ): Promise<{ control: boolean; kept: boolean }> {
    const end = await new GitSnapshotter(dir).snapshot();
    const raw = await patchBetween(dir, start, end, { maxBytes: 1_000_000 });
    const clean = `${dir}-clean`;
    const files = `${dir}-patches`;
    git("worktree", "add", "-q", "--detach", clean, "HEAD");
    await mkdir(files, { recursive: true });
    try {
      await writeFile(join(files, "control.patch"), raw.patch);
      const tries = (file: string) => {
        try {
          execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--check", file], {
            cwd: clean,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      };
      return {
        control: tries(join(files, "control.patch")),
        kept: tries(join(changesDir(host, run), "a-1.patch")),
      };
    } finally {
      git("worktree", "remove", "--force", clean);
      await rm(files, { recursive: true, force: true });
    }
  }

  test("t36tw_limit_a_redacted_patch_does_not_apply", async () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    await write("conf.txt", `key=${secret}\nplain\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "conf");
    const start = await new GitSnapshotter(dir).snapshot();
    const { host, run } = await begin(chain(["a"]));
    await write("conf.txt", `key=${secret}\nplain\nadded\n`); // the secret is only context
    await run.completeStep("a", 1);
    expect(await readFile(join(changesDir(host, run), "a-1.patch"), "utf8")).toContain("[REDACTED");
    expect(await appliesOnCleanStart(host, run, start)).toEqual({ control: true, kept: false });
  });

  test("t36tw_limit_multi_line_redaction_breaks_the_hunk", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    const start = await new GitSnapshotter(dir).snapshot();
    const { host, run } = await begin(chain(["a"]));
    await write("key.pem", pem);
    await run.completeStep("a", 1);
    const body = await readFile(join(changesDir(host, run), "a-1.patch"), "utf8");
    expect(body).not.toContain("MIIEvQIBADAN");
    expect(await appliesOnCleanStart(host, run, start)).toEqual({ control: true, kept: false });
  });

  test("t36tw_limit_task_size_of_a_cut_patch_is_low", async () => {
    const { run } = await begin(chain(["a"]), {}, history({ max_kb: 1 }));
    await write("big.txt", Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join(""));
    await run.completeStep("a", 1);
    await run.settle();
    const size = (await run.report()).task_size as { added?: number };
    expect(size.added ?? 0).toBeLessThan(500);
  });

  test("t36tw_limit_an_agent_can_overwrite_a_patch_undetected", async () => {
    const { host, run } = await begin(chain(["a"]));
    await write("x.txt", "x\n");
    await run.completeStep("a", 1);
    await run.settle();
    await writeFile(
      join(changesDir(host, run), "run.patch"),
      "# kodel-patch v1\ndiff --git a/forged b/forged\n--- /dev/null\n+++ b/forged\n@@ -0,0 +1 @@\n+forged\n",
    );
    const report = await run.report(); // nothing complains: history, not evidence
    expect(report.task_size).toMatchObject({ files: 1 });
    expect(await run.sealStatus()).toBe("sealed");
  });
});

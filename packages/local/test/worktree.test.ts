import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError, parsePipeline } from "@kodel-ai/pipeline-core";
import {
  doneHint,
  GitWorktreeProvider,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  type Workdir,
} from "../src";

// The test ids are a placeholder until the decision log gives this change one (see the plan).

let root: string;
const cleanup: string[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-wt-")));
  cleanup.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  await writeFile(join(dir, "tracked.txt"), "one\n");
  await writeFile(
    join(dir, "mark.js"),
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync('where.json', JSON.stringify({ cwd: process.cwd(), env: process.env.KODEL_WORKDIR }));",
      "",
    ].join("\n"),
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "where.yaml"), WHERE);
  await writeFile(join(dir, ".kodel", "pipelines", "agent.yaml"), AGENT);
  return dir;
}

beforeEach(async () => {
  root = await makeRepo();
});
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A command node needs a way out when it fails, so there are two.
const TWO_COMMANDS = (name: string, first: string) =>
  [
    `name: ${name}`,
    "nodes:",
    "  - slug: mark",
    "    kind: command",
    `    command: ${first}`,
    "  - slug: after",
    "    kind: command",
    '    command: node -e "0"',
    "edges:",
    "  - { from: mark, to: after }",
    "  - { from: mark, to: after, when: failed }",
    "  - { from: after, to: mark, when: failed }",
    "",
  ].join("\n");

const WHERE = TWO_COMMANDS("where", "node mark.js");

const AGENT = [
  "name: agent",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write {{task}}",
  "    checks:",
  "      - { kind: command, command: node mark.js }",
  '      - { kind: diff, paths: ["note.txt"] }',
  "  - slug: approve",
  "    kind: human",
  "    prompt: Looks fine?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const AUTO = { mode: "auto", dir: ".kodel/worktrees" } as const;

const pipelines = (over: Record<string, unknown> = {}) =>
  new LocalPipelineHost({ root, heartbeatMs: 0, worktree: AUTO, ...over });

async function start(
  host: LocalPipelineHost,
  pipeline: string,
  task: string,
  cwd?: string,
): Promise<{
  run: LocalRun;
  workdir: { path: string; branch?: string; note?: string } | undefined;
}> {
  const out = await host.start({
    pipeline,
    task,
    restart: false,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { run: out.run as LocalRun, workdir: out.workdir };
}

const worktreeCount = () =>
  git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
const kodelBranches = () => git(root, "branch", "--list", "kodel/*");

describe("a worktree for each run", () => {
  test("tNN_worktree_created_on_start_in_configured_dir_on_branch_from_head", async () => {
    const host = pipelines({ worktree: { mode: "auto", dir: "elsewhere/trees" } });
    const { run, workdir } = await start(host, "where", "mark where I am");
    await run.settle();

    expect(workdir?.path).toBe(join(root, "elsewhere", "trees", run.runId));
    expect(workdir?.branch).toBe(`kodel/${run.runId}`);
    expect(git(root, "rev-parse", `kodel/${run.runId}`)).toBe(git(root, "rev-parse", "HEAD"));
    expect(await readFile(join(workdir?.path ?? "", "tracked.txt"), "utf8")).toBe("one\n");

    // the command ran there, and was told so
    const where = JSON.parse(await readFile(join(workdir?.path ?? "", "where.json"), "utf8"));
    expect(await realpath(where.cwd)).toBe(workdir?.path ?? "");
    expect(where.env).toBe(workdir?.path ?? "");
    await expect(stat(join(root, "where.json"))).rejects.toThrow();

    // the run is kept in the root, with its place
    const [summary] = await host.runSummaries();
    expect(summary?.meta).toMatchObject({ workdir: workdir?.path, branch: `kodel/${run.runId}` });
    const journal = await run.report();
    expect(journal.workdir).toBe(workdir?.path);
  });

  test("tNN_worktree_default_dir_comes_from_the_project_config_and_off_is_read_from_it", async () => {
    const host = new LocalPipelineHost({ root, heartbeatMs: 0 });
    const first = await start(host, "where", "default dir");
    await first.run.settle();
    expect(first.workdir?.path).toBe(join(root, ".kodel", "worktrees", first.run.runId));

    await writeFile(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
    const second = await start(host, "where", "off by the file");
    await second.run.settle();
    expect(second.workdir).toBeUndefined();
    expect(JSON.parse(await readFile(join(root, "where.json"), "utf8")).cwd).toBe(root);
  });

  test("tNN_worktree_mode_off_runs_in_root_as_before", async () => {
    const host = pipelines({ worktree: { mode: "off", dir: ".kodel/worktrees" } });
    const { run, workdir } = await start(host, "where", "in the root");
    await run.settle();
    expect(workdir).toBeUndefined();
    expect(worktreeCount()).toBe(1);
    const where = JSON.parse(await readFile(join(root, "where.json"), "utf8"));
    expect(where.cwd).toBe(root);
    // no variable for a run that has no place of its own
    expect(where.env).toBeUndefined();
    const step = await run.nextStep();
    expect(step).toEqual({ done: true, run_status: "completed" });
  });

  test("tNN_worktree_with_no_git_at_all_runs_in_the_directory_it_is_given", async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), "kodel-nogit-")));
    cleanup.push(plain);
    await mkdir(join(plain, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(plain, ".kodel", "pipelines", "p.yaml"), TWO_COMMANDS("p", 'node -e "0"'));
    const host = new LocalPipelineHost({ root: plain, heartbeatMs: 0, worktree: AUTO });
    const { run, workdir } = await start(host, "p", "t");
    await run.settle();
    expect(workdir).toBeUndefined();
    expect((await run.state()).status).toBe("completed");
  });

  test("tNN_worktree_note_says_when_the_root_has_changes_the_worktree_lacks", async () => {
    const clean = await start(pipelines(), "where", "clean root");
    expect(clean.workdir?.note).toBeUndefined();
    await writeFile(join(root, "tracked.txt"), "changed\n");
    const dirty = await start(pipelines(), "where", "dirty root");
    expect(dirty.workdir?.note).toContain("uncommitted");
    expect(await readFile(join(dirty.workdir?.path ?? "", "tracked.txt"), "utf8")).toBe("one\n");
  });
});

describe("reusing the worktree the agent is already in", () => {
  test("tNN_worktree_reused_when_caller_is_in_a_listed_non_main_worktree", async () => {
    const mine = join(root, ".kodel", "worktrees", "mine");
    git(root, "worktree", "add", "-q", "-b", "mine", mine, "HEAD");
    const before = worktreeCount();
    const deep = join(mine, "sub");
    await mkdir(deep);

    const { run, workdir } = await start(pipelines(), "where", "inside mine", deep);
    await run.settle();
    expect(workdir).toEqual({ path: await realpath(mine) });
    expect(worktreeCount()).toBe(before);
    expect(kodelBranches()).toBe("");
    expect((await readFile(join(mine, "where.json"), "utf8")).length).toBeGreaterThan(0);
    // nothing of ours to take away, so no hint about it at the end
    expect(await run.nextStep()).toEqual({ done: true, run_status: "completed" });
  });

  test("tNN_worktree_not_reused_for_main_worktree_other_repo_symlink_or_forged_dotgit", async () => {
    // a second repository with a worktree of its own
    const other = await makeRepo();
    const foreign = join(other, "foreign");
    git(other, "worktree", "add", "-q", "-b", "foreign", foreign, "HEAD");
    // a worktree of this repository, reached through a link that points at the root
    const link = join(await realpath(await mkdtemp(join(tmpdir(), "kodel-link-"))), "to-root");
    cleanup.push(join(link, ".."));
    await symlink(root, link);
    // a directory that only looks like a worktree: its .git file points at the other repository's
    const forged = join(root, "forged");
    await mkdir(forged);
    const foreignGitDir = git(foreign, "rev-parse", "--absolute-git-dir");
    await writeFile(join(forged, ".git"), `gitdir: ${foreignGitDir}\n`);

    const cases: [string, string][] = [
      ["the main worktree", root],
      ["a worktree of another repository", foreign],
      ["a link to the main worktree", link],
      ["a forged .git file", forged],
      ["a relative path", "."],
      ["a path that is not there", join(root, "nowhere")],
    ];
    let expected = 1;
    for (const [what, cwd] of cases) {
      const { run, workdir } = await start(pipelines(), "where", `not reused: ${what}`, cwd);
      await run.settle();
      expected += 1;
      expect(workdir?.branch, what).toBe(`kodel/${run.runId}`);
      expect(worktreeCount(), what).toBe(expected);
    }
  });
});

describe("reusing is limited to the folder for worktrees, and never the root itself", () => {
  const WORKTREE_DIRS = (r: string) => join(r, ".kodel", "worktrees");

  test("tNN_worktree_not_reused_outside_worktree_dir", async () => {
    // a worktree of the person's own, next to the repository and not under worktree.dir
    const own = join(await realpath(await mkdtemp(join(tmpdir(), "kodel-own-"))), "feature");
    cleanup.push(join(own, ".."));
    git(root, "worktree", "add", "-q", "-b", "feature", own, "HEAD");
    const { run, workdir } = await start(
      pipelines(),
      "where",
      "agent sits in my feature tree",
      own,
    );
    await run.settle();
    expect(workdir?.branch).toBe(`kodel/${run.runId}`);
    expect(workdir?.path.startsWith(WORKTREE_DIRS(await realpath(root)))).toBe(true);
    await expect(readFile(join(own, "where.json"), "utf8")).rejects.toThrow();

    // the same worktree is reused once worktree.dir names the folder it lives in
    const wide = pipelines({ worktree: { mode: "auto", dir: join(own, "..") } });
    const again = await start(wide, "where", "now it is allowed", own);
    await again.run.settle();
    expect(again.workdir).toEqual({ path: await realpath(own) });
  });

  test("tNN_root_that_is_itself_a_linked_worktree", async () => {
    const linked = join(await realpath(await mkdtemp(join(tmpdir(), "kodel-lroot-"))), "wt");
    cleanup.push(join(linked, ".."));
    git(root, "worktree", "add", "-q", "-b", "lroot", linked, "HEAD");
    await mkdir(join(linked, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(linked, ".kodel", "pipelines", "where.yaml"), WHERE);
    const host = new LocalPipelineHost({ root: linked, heartbeatMs: 0, worktree: AUTO });

    // the agent reports the root itself: it is not a worktree made for a run
    const first = await host.start({
      pipeline: "where",
      task: "in a linked root",
      restart: false,
      cwd: linked,
    });
    await (first.run as LocalRun).settle();
    expect(first.workdir?.branch).toBe(`kodel/${first.run.runId}`);
    expect(first.workdir?.path).toBe(
      join(await realpath(linked), ".kodel", "worktrees", first.run.runId),
    );

    // the run works there and its worktree is verified against this repository
    expect(
      (await readFile(join(first.workdir?.path ?? "", "where.json"), "utf8")).length,
    ).toBeGreaterThan(0);
    expect(await (first.run as LocalRun).nextStep()).toMatchObject({ done: true });

    // and a worktree under the linked root's own folder is reused
    const mine = join(linked, ".kodel", "worktrees", "mine");
    git(linked, "worktree", "add", "-q", "-b", "mine", mine, "HEAD");
    const second = await host.start({
      pipeline: "where",
      task: "reuse",
      restart: false,
      cwd: mine,
    });
    await (second.run as LocalRun).settle();
    expect(second.workdir).toEqual({ path: await realpath(mine) });
  });

  test("tNN_root_is_not_reused_even_when_worktree_dir_covers_it", async () => {
    const linked = join(await realpath(await mkdtemp(join(tmpdir(), "kodel-lcover-"))), "wt");
    cleanup.push(join(linked, ".."));
    git(root, "worktree", "add", "-q", "-b", "lcover", linked, "HEAD");
    await mkdir(join(linked, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(linked, ".kodel", "pipelines", "where.yaml"), WHERE);
    const host = new LocalPipelineHost({
      root: linked,
      heartbeatMs: 0,
      worktree: { mode: "auto", dir: join(linked, "..") },
    });
    const out = await host.start({
      pipeline: "where",
      task: "covered",
      restart: false,
      cwd: linked,
    });
    await (out.run as LocalRun).settle();
    expect(out.workdir?.branch).toBe(`kodel/${out.run.runId}`);
    expect(out.workdir?.path).not.toBe(await realpath(linked));
  });

  test("tNN_root_that_is_a_subfolder_of_the_repository", async () => {
    const sub = join(root, "packages", "app");
    await mkdir(join(sub, ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(sub, ".kodel", "pipelines", "where.yaml"), WHERE);
    // The folder has to be in the commit the worktree is made from.
    await writeFile(join(sub, "mark.js"), await readFile(join(root, "mark.js"), "utf8"));
    git(root, "add", "packages/app/mark.js");
    git(root, "commit", "-q", "-m", "app");
    const host = new LocalPipelineHost({ root: sub, heartbeatMs: 0, worktree: AUTO });

    const out = await host.start({ pipeline: "where", task: "in a subfolder", restart: false });
    await (out.run as LocalRun).settle();
    // The worktree is of the whole repository; the run works in the same folder inside it.
    const top = join(sub, ".kodel", "worktrees", out.run.runId);
    expect(out.workdir?.path).toBe(join(top, "packages", "app"));
    expect(git(root, "worktree", "list", "--porcelain")).toContain(top);
    // The command ran there, not at the top of the worktree.
    const where = JSON.parse(await readFile(join(out.workdir?.path ?? "", "where.json"), "utf8"));
    expect(where.cwd).toBe(out.workdir?.path ?? "?");
  });
});

describe("a start that cannot finish leaves nothing behind", () => {
  const spec = parsePipeline(WHERE);
  const clean = async () => {
    expect(worktreeCount()).toBe(1);
    expect(kodelBranches()).toBe("");
    const trees = await readdir(join(root, ".kodel", "worktrees")).catch(() => []);
    expect(trees).toEqual([]);
    const runs = await readdir(join(root, ".kodel", "runs")).catch(() => []);
    expect(runs).toEqual([]);
  };

  test("tNN_start_failure_after_creation_removes_worktree_branch_and_run (the run record)", async () => {
    const host = new LocalHost(spec, { root, heartbeatMs: 0 });
    host.store.createRun = async () => {
      throw new Error("disk full");
    };
    await expect(host.start("t", { worktree: AUTO })).rejects.toThrow("disk full");
    await clean();
  });

  test("tNN_start_failure_after_creation_removes_worktree_branch_and_run (the start event)", async () => {
    const host = new LocalHost(spec, { root, heartbeatMs: 0 });
    host.store.writeState = async () => {
      throw new Error("disk full");
    };
    await expect(host.start("t", { worktree: AUTO })).rejects.toThrow("disk full");
    await clean();
  });

  test("tNN_start_with_existing_dir_or_branch_fails_without_deleting_it", async () => {
    const provider = new GitWorktreeProvider(root, AUTO);
    const trees = join(root, ".kodel", "worktrees");

    await mkdir(join(trees, "r_dir"), { recursive: true });
    await writeFile(join(trees, "r_dir", "keep.txt"), "mine\n");
    await expect(provider.prepare({ runId: "r_dir" })).rejects.toMatchObject({
      code: "WORKDIR_CREATE_FAILED",
    });
    expect(await readFile(join(trees, "r_dir", "keep.txt"), "utf8")).toBe("mine\n");

    git(root, "branch", "kodel/r_branch");
    await expect(provider.prepare({ runId: "r_branch" })).rejects.toMatchObject({
      code: "WORKDIR_CREATE_FAILED",
    });
    expect(kodelBranches()).toContain("kodel/r_branch");
    await expect(stat(join(trees, "r_branch"))).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "tNN_post_checkout_hook_written_by_agent_does_not_run_on_create",
    async () => {
      const marker = join(root, "..", `hook-ran-${Date.now()}`);
      cleanup.push(marker);
      const hook = join(root, ".git", "hooks", "post-checkout");
      await mkdir(join(root, ".git", "hooks"), { recursive: true });
      await writeFile(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
      await chmod(hook, 0o755);

      const { workdir } = await start(pipelines(), "where", "with a hook");
      expect(workdir?.branch).toMatch(/^kodel\/r_/);
      await expect(stat(marker)).rejects.toThrow();
    },
  );
});

describe("the directory is the run's, and checked", () => {
  test("tNN_command_node_and_command_check_run_in_workdir", async () => {
    const { run, workdir } = await start(pipelines(), "agent", "cwd of the check");
    const dir = workdir?.path ?? "";
    await writeFile(join(dir, "note.txt"), "hello\n");
    const decision = await run.completeStep("write", 1);
    expect(decision.ok).toBe(true);
    await run.settle();

    expect((await run.state()).nodes.write?.status).toBe("passed");
    const where = JSON.parse(await readFile(join(dir, "where.json"), "utf8"));
    expect(await realpath(where.cwd)).toBe(dir);
    expect(where.env).toBe(dir);
    await expect(stat(join(root, "where.json"))).rejects.toThrow();
  });

  test("tNN_diff_check_and_gate_changes_use_workdir", async () => {
    const host = pipelines();
    const { run, workdir } = await start(host, "agent", "diff in the worktree");
    const dir = workdir?.path ?? "";
    await writeFile(join(dir, "note.txt"), "hello\n");
    await run.completeStep("write", 1);
    await run.settle();
    expect((await run.state()).nodes.write?.status).toBe("passed");

    // after the gate was reached: a file changes in the worktree, another in the root
    await writeFile(join(dir, "late.txt"), "late\n");
    await writeFile(join(root, "rootfile.txt"), "root\n");
    const gate = await run.changesSinceGate("approve");
    expect(gate.kind).toBe("changes");
    const files = gate.kind === "changes" ? Object.keys(gate.files) : [];
    expect(files).toContain("late.txt");
    expect(files).not.toContain("rootfile.txt");

    const since = await run.changesSinceStart();
    const sinceFiles = since.kind === "changes" ? Object.keys(since.files) : [];
    expect(sinceFiles).toContain("note.txt");
    expect(sinceFiles).not.toContain("rootfile.txt");

    // a change made only in the root does not satisfy the check
    const other = await start(host, "agent", "diff written in the wrong place");
    await writeFile(join(root, "note.txt"), "wrong place\n");
    await other.run.completeStep("write", 1);
    await other.run.settle();
    const node = (await other.run.state()).nodes.write;
    expect(node?.status).not.toBe("passed");
    expect(node?.lastFailure?.source).toBe("check:diff");
  });

  test("tNN_workdir_removed_between_commands_fails_with_workdir_missing", async () => {
    const { run, workdir } = await start(pipelines(), "agent", "the directory goes away");
    const dir = workdir?.path ?? "";
    await writeFile(join(dir, "note.txt"), "hello\n");
    git(root, "worktree", "remove", "--force", dir);

    await run.completeStep("write", 1);
    await run.settle();
    const node = (await run.state()).nodes.write;
    expect(node?.status).not.toBe("passed");
    expect(node?.lastFailure?.reason).toContain("WORKDIR_MISSING");
    // and it did not quietly go on in the root
    await expect(stat(join(root, "where.json"))).rejects.toThrow();

    const provider = new GitWorktreeProvider(root, AUTO);
    await expect(provider.verify(dir)).rejects.toMatchObject({ code: "WORKDIR_MISSING" });
  });

  test.skipIf(process.platform === "win32")(
    "tNN_workdir_swapped_for_symlink_fails_closed",
    async () => {
      const provider = new GitWorktreeProvider(root, AUTO);
      const first = (await provider.prepare({ runId: "r_first" })) as Workdir;
      const second = (await provider.prepare({ runId: "r_second" })) as Workdir;
      await provider.verify(first.path);

      for (const target of [root, second.path]) {
        await rm(first.path, { recursive: true, force: true });
        await symlink(target, first.path);
        await expect(provider.verify(first.path), target).rejects.toMatchObject({
          code: "WORKDIR_INVALID",
        });
      }
    },
  );

  test("tNN_workdir_that_git_does_not_list_or_of_another_repo_is_invalid", async () => {
    const provider = new GitWorktreeProvider(root, AUTO);
    const stranger = join(root, "stranger");
    await mkdir(stranger);
    await expect(provider.verify(stranger)).rejects.toMatchObject({ code: "WORKDIR_INVALID" });

    const other = await makeRepo();
    await expect(provider.verify(other)).rejects.toMatchObject({ code: "WORKDIR_INVALID" });
  });

  test("tNN_old_run_without_workdir_reads_as_root", async () => {
    // a run as it is written today by a host that makes no worktree: no workdir, no branch
    const host = new LocalHost(parsePipeline(WHERE), { root, heartbeatMs: 0 });
    const { run } = await host.start("an old run");
    await run.settle();
    const meta = JSON.parse(
      await readFile(join(root, ".kodel", "runs", run.runId, "meta.json"), "utf8"),
    );
    expect(meta).not.toHaveProperty("workdir");
    expect(meta).not.toHaveProperty("branch");

    const reopened = host.open(run.runId);
    expect(await reopened.location()).toBeUndefined();
    expect((await reopened.report()).workdir).toBeUndefined();
    expect(await reopened.nextStep()).toEqual({ done: true, run_status: "completed" });
    expect(JSON.parse(await readFile(join(root, "where.json"), "utf8")).cwd).toBe(root);
  });

  test("tNN_meta_json_rewritten_by_the_agent_does_not_move_the_run_to_the_root", async () => {
    const { run, workdir } = await start(pipelines(), "agent", "meta is not the authority");
    const dir = workdir?.path ?? "";
    await writeFile(join(dir, "note.txt"), "hello\n");
    // the agent deletes the place from the record, then the whole record
    const metaFile = join(root, ".kodel", "runs", run.runId, "meta.json");
    const meta = JSON.parse(await readFile(metaFile, "utf8"));
    delete meta.workdir;
    delete meta.branch;
    await writeFile(metaFile, JSON.stringify(meta));
    await rm(metaFile);

    await run.completeStep("write", 1);
    await run.settle();
    expect((await run.state()).nodes.write?.status).toBe("passed");
    expect(JSON.parse(await readFile(join(dir, "where.json"), "utf8")).env).toBe(dir);
    await expect(stat(join(root, "where.json"))).rejects.toThrow();
  });

  test("tNN_state_rewritten_to_point_elsewhere_is_refused_and_nothing_runs_there", async () => {
    const { run } = await start(pipelines(), "agent", "state is the authority");
    const stateFile = join(root, ".kodel", "runs", run.runId, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.workdir = root;
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    await expect(run.location()).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
    const decision = await run.completeStep("write", 1);
    expect(decision.ok).toBe(false);
    await run.settle();
    await expect(stat(join(root, "where.json"))).rejects.toThrow();
  });

  test("tNN_workdir_is_kept_as_it_is_even_when_a_redaction_rule_would_eat_it", async () => {
    // a long random-looking folder name is enough for the high-entropy rule
    const dir = "Zk3Xq9Lm2Vb8Nc4Rt7Yw1Hd6Jf5Gs0AaPo";
    const host = pipelines({ worktree: { mode: "auto", dir } });
    const { run, workdir } = await start(host, "where", "odd folder name");
    await run.settle();
    expect(workdir?.path).toBe(join(root, dir, run.runId));
    expect((await run.state()).status).toBe("completed");
  });
});

describe("the end of a run", () => {
  test("tNN_done_text_names_path_branch_and_commands", async () => {
    const { run, workdir } = await start(pipelines(), "where", "finish");
    await run.settle();
    const step = await run.nextStep();
    expect("done" in step).toBe(true);
    const text = "done" in step ? (step.tell_the_person ?? "") : "";
    expect(text).toContain(workdir?.path ?? "?");
    expect(text).toContain(`kodel/${run.runId}`);
    expect(text).toContain("commit -s");
    expect(text).toContain("worktree remove");
    expect(text).toContain("Do not run");
    // nothing was removed by saying it
    expect(worktreeCount()).toBe(2);
  });

  test("tNN_done_text_quotes_paths_for_the_shell", () => {
    const text = doneHint("/repo", "/repo/with space/it's", "kodel/r_x");
    if (process.platform === "win32") return;
    expect(text).toContain("'/repo/with space/it'\\''s'");
    expect(text).toContain("git -C /repo worktree remove");
  });

  test("tNN_a_run_that_is_not_finished_has_no_done_text", async () => {
    const { run } = await start(pipelines(), "agent", "still going");
    const step = await run.nextStep();
    expect("node" in step).toBe(true);
  });
});

describe("the provider", () => {
  test("tNN_config_dir_must_not_be_the_root_or_inside_git", async () => {
    for (const dir of [".", ".git/trees", join(root, ".git")]) {
      const provider = new GitWorktreeProvider(root, { mode: "auto", dir });
      const error = await provider.prepare({ runId: "r_cfg" }).catch((e: unknown) => e);
      expect(error, dir).toBeInstanceOf(KodelError);
      expect((error as KodelError).code, dir).toBe("CONFIG_INVALID");
    }
  });

  test("tNN_config_dir_may_be_absolute_and_outside_the_repository", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "kodel-outside-")));
    cleanup.push(outside);
    const provider = new GitWorktreeProvider(root, { mode: "auto", dir: outside });
    const made = await provider.prepare({ runId: "r_abs" });
    expect(made?.path).toBe(join(outside, "r_abs"));
    await provider.discard(made as Workdir);
    await expect(stat(join(outside, "r_abs"))).rejects.toThrow();
    expect(kodelBranches()).toBe("");
  });
});

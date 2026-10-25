import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, parsePipeline } from "@kodel-ai/pipeline-core";
import {
  LocalPipelineHost,
  type LocalRun,
  MAX_RUN_COMMITS,
  readHead,
  readRunCommits,
} from "../src";

// TASK-4R84: the commit a run started from, and the commits the agent made, in the journal.

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function makeDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-commits-")));
  cleanup.push(dir);
  return dir;
}

async function makeRepo(commits = true): Promise<string> {
  const dir = await makeDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  if (commits) git(dir, "commit", "-q", "--allow-empty", "-m", "initial");
  return dir;
}

const commit = (dir: string, message: string) =>
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const past = 0;

describe("reading the commits of a run", () => {
  test("t4r84_head_is_none_without_a_repository_and_without_a_commit", async () => {
    expect(await readHead(await makeDir())).toBeUndefined();
    expect(await readHead(await makeRepo(false))).toBeUndefined();
    expect(await readRunCommits(await makeRepo(false), undefined, past)).toEqual({});
  });

  test("t4r84_two_commits_are_both_listed_newest_first", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    commit(dir, "one");
    const one = head(dir);
    commit(dir, "two");
    const two = head(dir);
    expect(await readRunCommits(dir, base, past)).toEqual({ head: two, commits: [two, one] });
  });

  test("t4r84_no_commits_gives_an_empty_list", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    expect(await readRunCommits(dir, base, past)).toEqual({ head: base, commits: [] });
  });

  test("t4r84_an_amended_commit_is_listed_with_the_one_that_replaced_it", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    commit(dir, "first try");
    const old = head(dir);
    git(dir, "commit", "-q", "--amend", "--allow-empty", "-m", "second try");
    const amended = head(dir);
    const found = await readRunCommits(dir, base, past);
    expect(found.head).toBe(amended);
    expect(found.commits).toEqual([amended, old]);
  });

  test("t4r84_a_reset_commit_is_still_listed_and_head_is_where_it_went_back_to", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    commit(dir, "one");
    const one = head(dir);
    commit(dir, "two");
    const two = head(dir);
    git(dir, "reset", "-q", "--hard", base);
    const found = await readRunCommits(dir, base, past);
    expect(found.head).toBe(base);
    expect(new Set(found.commits)).toEqual(new Set([one, two]));
  });

  test("t4r84_reflog_entries_older_than_the_run_do_not_count", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    commit(dir, "one");
    git(dir, "commit", "-q", "--amend", "--allow-empty", "-m", "one again");
    const amended = head(dir);
    const later = Math.floor(Date.now() / 1000) + 3600;
    expect(await readRunCommits(dir, base, later)).toEqual({ head: amended, commits: [amended] });
  });

  test("t4r84_a_detached_head_is_read_as_it_is", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    git(dir, "checkout", "-q", "--detach");
    commit(dir, "on nothing");
    const tip = head(dir);
    expect(await readRunCommits(dir, base, past)).toEqual({ head: tip, commits: [tip] });
  });

  test("t4r84_a_branch_renamed_by_the_agent_changes_nothing", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    commit(dir, "one");
    const one = head(dir);
    git(dir, "branch", "-m", "renamed");
    expect(await readRunCommits(dir, base, past)).toEqual({ head: one, commits: [one] });
  });

  test("t4r84_with_the_reflog_off_the_reachable_commits_are_still_listed", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    git(dir, "config", "core.logAllRefUpdates", "false");
    commit(dir, "one");
    const one = head(dir);
    expect(await readRunCommits(dir, base, past)).toEqual({ head: one, commits: [one] });
  });

  test("t4r84_a_base_the_repository_does_not_have_leaves_head_alone", async () => {
    const dir = await makeRepo();
    const found = await readRunCommits(dir, "0".repeat(40), past);
    expect(found.head).toBe(head(dir));
  });

  test("t4r84_a_base_that_is_not_a_sha_is_not_passed_to_git", async () => {
    const dir = await makeRepo();
    expect(await readRunCommits(dir, "--output=oops", past)).toEqual({ head: head(dir) });
  });

  test("t4r84_the_list_is_capped_and_says_so", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    const total = MAX_RUN_COMMITS + 3;
    // one fast-import instead of hundreds of git processes
    const lines = [];
    for (let i = 0; i < total; i++) {
      lines.push(
        "commit refs/heads/many",
        `committer T <t@example.com> ${1_700_000_000 + i} +0000`,
        "data 1",
        "x",
        ...(i === 0 ? [`from ${base}`] : []),
        "",
      );
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: `${lines.join("\n")}\n` });
    git(dir, "reset", "-q", "--hard", "many");
    const found = await readRunCommits(dir, base, past);
    expect(found.commits).toHaveLength(MAX_RUN_COMMITS);
    expect(found.truncated).toBe(true);
    expect(found.commits?.[0]).toBe(head(dir));
  });
});

describe("the reads cannot make a repository run something", () => {
  test("t4r84_hardening_a_program_named_by_the_repository_config_is_never_started", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    const marker = join(dir, "marker");
    const script = join(dir, "run-me.sh");
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(script, 0o755);
    git(dir, "config", "core.fsmonitor", script);
    git(dir, "config", "log.showSignature", "true");
    git(dir, "config", "gpg.program", script);
    git(dir, "config", "core.pager", script);
    // a commit that carries a signature, so that a log read would ask gpg about it
    const tree = git(dir, "rev-parse", "HEAD^{tree}");
    const raw = [
      `tree ${tree}`,
      `parent ${base}`,
      "author T <t@example.com> 1700000000 +0000",
      "committer T <t@example.com> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " abc",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n");
    const signed = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: dir,
      input: raw,
      encoding: "utf8",
    }).trim();
    git(dir, "update-ref", "-m", "test", "HEAD", signed);

    expect(await readHead(dir)).toBe(signed);
    expect((await readRunCommits(dir, base, past)).commits).toEqual([signed]);
    await expect(stat(marker)).rejects.toThrow();
  });
});

const AGENT = [
  "name: agent",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: go",
  "",
].join("\n");

// A run that records changes needs git; these runs are about the case where there is none.
const NO_CHANGES = "history:\n  changes:\n    enabled: false\n";

async function projectWith(repo: boolean, config?: string) {
  const dir = repo ? await makeRepo() : await makeDir();
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "agent.yaml"), AGENT);
  if (config !== undefined) await writeFile(join(dir, ".kodel", "config.yaml"), config);
  return dir;
}

const hostFor = (root: string, over: Record<string, unknown> = {}) =>
  new LocalPipelineHost({ root, heartbeatMs: 0, ...over });

async function startAgent(host: LocalPipelineHost, task = "do it") {
  const out = await host.start({ pipeline: "agent", task, restart: false });
  return { run: out.run as LocalRun, workdir: out.workdir };
}

async function readJournal(root: string, run: LocalRun | string) {
  const runId = typeof run === "string" ? run : run.runId;
  const text = await readFile(join(root, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the base commit of a run", () => {
  test("t4r84_base_commit_equals_head_at_start_and_the_branch_starts_there", async () => {
    const root = await projectWith(true);
    const before = head(root);
    const host = hostFor(root);
    const { run, workdir } = await startAgent(host);
    // the person moves HEAD in the root while the run is going
    commit(root, "person's own");
    const started = (await readJournal(root, run.runId)).find((r) => r.event === "run_started");
    expect(started?.base_commit).toBe(before);
    expect(git(root, "rev-parse", `kodel/${run.runId}`)).toBe(before);
    expect(head(workdir?.path ?? root)).toBe(before);
  });

  test("t4r84_base_commit_of_a_worktree_the_agent_is_already_in_is_its_head", async () => {
    const root = await projectWith(true);
    const host = hostFor(root);
    const first = await startAgent(host, "first");
    commit(first.workdir?.path ?? "", "ahead");
    const here = head(first.workdir?.path ?? "");
    const out = await host.start({
      pipeline: "agent",
      task: "second",
      restart: false,
      cwd: first.workdir?.path ?? "",
    });
    const journal = await readJournal(root, out.run as LocalRun);
    expect(journal.find((r) => r.event === "run_started")?.base_commit).toBe(here);
  });

  test("t4r84_base_commit_with_the_worktree_mode_off_is_the_head_of_the_root", async () => {
    const root = await projectWith(true, "worktree:\n  mode: off\n");
    const host = hostFor(root);
    const { run } = await startAgent(host);
    const started = (await readJournal(root, run)).find((r) => r.event === "run_started");
    expect(started?.base_commit).toBe(head(root));
  });

  test("t4r84_no_repository_means_no_field", async () => {
    const root = await projectWith(false, NO_CHANGES);
    const host = hostFor(root);
    const { run } = await startAgent(host);
    const started = (await readJournal(root, run)).find((r) => r.event === "run_started");
    expect(started).toBeDefined();
    expect("base_commit" in (started ?? {})).toBe(false);
  });

  test("t4r84_a_repository_without_a_commit_means_no_field", async () => {
    const root = await projectWith(false, `worktree:\n  mode: off\n${NO_CHANGES}`);
    git(root, "init", "-q");
    const host = hostFor(root);
    const { run } = await startAgent(host);
    const started = (await readJournal(root, run)).find((r) => r.event === "run_started");
    expect("base_commit" in (started ?? {})).toBe(false);
  });
});

describe("the commits of the agent in the journal", () => {
  async function finishWith(
    root: string,
    work: (dir: string) => void,
  ): Promise<{ journal: Record<string, unknown>[]; dir: string; base: string }> {
    const host = hostFor(root);
    const { run, workdir } = await startAgent(host);
    const dir = workdir?.path ?? root;
    const base = await Promise.resolve()
      .then(() => head(dir))
      .catch(() => "");
    work(dir);
    const state = await run.state();
    const visit = state.nodes.write;
    const done = await run.completeStep("write", visit?.attempt ?? 1, "done");
    expect(done.ok).toBe(true);
    await run.settle();
    expect((await run.state()).status).toBe("completed");
    return { journal: await readJournal(root, run), dir, base };
  }

  test("t4r84_two_commits_are_in_the_head_of_the_step_and_in_the_end_of_the_run", async () => {
    const root = await projectWith(true);
    const { journal, dir } = await finishWith(root, (d) => {
      commit(d, "one");
      commit(d, "two");
    });
    const log = git(dir, "rev-list", "HEAD").split("\n");
    const tip = head(dir);
    expect(journal.find((r) => r.event === "agent_completed")?.head).toBe(tip);
    const finished = journal.find((r) => r.event === "run_finished");
    expect(finished?.head).toBe(tip);
    expect(finished?.commits).toEqual(log.slice(0, 2));
    expect("commits_truncated" in (finished ?? {})).toBe(false);
    // the root's HEAD is not what is recorded
    expect(head(root)).not.toBe(tip);
  });

  test("t4r84_an_amended_commit_and_a_reset_both_show_in_the_end_of_the_run", async () => {
    const root = await projectWith(true);
    const seen: string[] = [];
    const { journal, dir } = await finishWith(root, (d) => {
      commit(d, "first try");
      seen.push(head(d));
      git(d, "commit", "-q", "--amend", "--allow-empty", "-m", "second try");
      seen.push(head(d));
      commit(d, "dropped");
      seen.push(head(d));
      git(d, "reset", "-q", "--hard", "HEAD~1");
    });
    const finished = journal.find((r) => r.event === "run_finished");
    expect(finished?.head).toBe(head(dir));
    expect(new Set(finished?.commits as string[])).toEqual(new Set(seen));
    expect((finished?.commits as string[] | undefined)?.at(0)).toBe(head(dir));
  });

  test("t4r84_a_run_with_no_commits_ends_with_an_empty_list", async () => {
    const root = await projectWith(true);
    const { journal, base } = await finishWith(root, () => undefined);
    const finished = journal.find((r) => r.event === "run_finished");
    expect(finished?.commits).toEqual([]);
    expect(finished?.head).toBe(base);
    expect(journal.find((r) => r.event === "agent_completed")?.head).toBe(base);
  });

  test("t4r84_a_run_without_a_repository_has_none_of_these_fields", async () => {
    const root = await projectWith(false, NO_CHANGES);
    const { journal } = await finishWith(root, () => undefined);
    const finished = journal.find((r) => r.event === "run_finished") ?? {};
    for (const key of ["head", "commits", "commits_truncated"]) expect(key in finished).toBe(false);
    expect("head" in (journal.find((r) => r.event === "agent_completed") ?? {})).toBe(false);
  });
});

describe("the events carry the fields", () => {
  const spec = parsePipeline(AGENT);
  const started = decide(
    spec,
    undefined,
    {
      type: "start",
      runId: "r_0000000aa_aaaa",
      task: "t",
      specHash: "h",
      baseCommit: "a".repeat(40),
    },
    1000,
  );

  test("t4r84_run_started_carries_the_base_commit_and_omits_it_when_there_is_none", () => {
    expect(started.ok && started.journal[0]?.base_commit).toBe("a".repeat(40));
    const none = decide(
      spec,
      undefined,
      { type: "start", runId: "r_0000000aa_aaaa", task: "t", specHash: "h" },
      1000,
    );
    expect(none.ok && "base_commit" in (none.journal[0] ?? {})).toBe(false);
  });

  test("t4r84_agent_completed_and_run_finished_carry_what_they_are_given", () => {
    if (!started.ok) throw new Error("start failed");
    const sha = "b".repeat(40);
    const facts = { head: sha, commits: [sha, "c".repeat(40)], commitsTruncated: true };
    const done = decide(
      spec,
      started.state,
      { type: "agent_completed", node: "write", attempt: 1, head: sha },
      2000,
      {},
      facts,
    );
    if (!done.ok) throw new Error("completion failed");
    expect(done.journal.find((r) => r.event === "agent_completed")?.head).toBe(sha);
    const finished = done.journal.find((r) => r.event === "run_finished");
    expect(finished).toMatchObject({
      status: "completed",
      head: sha,
      commits: facts.commits,
      commits_truncated: true,
    });
  });

  test("t4r84_without_facts_the_events_are_what_they_were_before", () => {
    if (!started.ok) throw new Error("start failed");
    const done = decide(
      spec,
      started.state,
      { type: "agent_completed", node: "write", attempt: 1 },
      2000,
    );
    if (!done.ok) throw new Error("completion failed");
    const finished = done.journal.find((r) => r.event === "run_finished") ?? {};
    expect(Object.keys(finished).sort()).toEqual(["event", "seq", "status", "ts", "v"]);
    expect("head" in (done.journal.find((r) => r.event === "agent_completed") ?? {})).toBe(false);
  });
});

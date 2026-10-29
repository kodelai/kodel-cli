import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryEvent, KodelError, type SessionRef } from "@kodel-ai/pipeline-core";
import { CLAUDE_FIXTURE_SESSION, installClaudeSession } from "../../testkit/src/history-fixtures";
import {
  canonicalRoot,
  FileStore,
  findProjectRoot,
  LocalPipelineHost,
  type LocalRun,
  placeProblem,
  resolveStoragePlace,
  type StoragePlace,
} from "../src";
import { claudeCodeCollector } from "../src/history";

const ID = "demo-aaaa1111";

// Every test makes a git repository (and some a linked worktree) first: that can be slow on a busy machine.
setDefaultTimeout(30_000);

let tmp: string; // a real path: the temp folder on macOS is a symlink
let dir: string; // the project
let base: string; // the home base (KODEL_STATE_DIR)
let hashes: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-roots-")));
  dir = join(tmp, "project");
  base = join(tmp, "base");
  hashes = join(tmp, "hashes");
  await mkdir(dir);
  await mkdir(base);
  await mkdir(hashes);
  await project(dir);
});
afterEach(async () => {
  await chmod(base, 0o700).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A committed project, so a linked worktree of it has the config and the pipeline too. */
async function project(root: string, storage = `storage: home\nproject_id: ${ID}\n`) {
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(root, ".kodel", "config.yaml"), `worktree:\n  mode: "off"\n${storage}`);
  git(root, "add", ".kodel");
  git(root, "commit", "-q", "-m", "initial");
}

const env = () => ({ KODEL_STATE_DIR: base });
const placeOf = (root: string, over: Record<string, string> = {}) =>
  resolveStoragePlace({
    root,
    dataDir: join(root, ".kodel"),
    env: { ...env(), ...over },
  });

async function hostAt(root: string, place?: StoragePlace, over: Record<string, unknown> = {}) {
  return new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: hashes,
    storage: place ?? (await placeOf(root)),
    ...over,
  });
}

async function startRun(h: LocalPipelineHost, task = "t"): Promise<LocalRun> {
  const { run } = await h.start({ pipeline: "demo", task, restart: false });
  return (await h.open(run.runId)) as LocalRun;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const tree = () => join(base, "projects", ID);

describe("one spelling per checkout", () => {
  test("storage_explicit_root_handled: a root given through a symlink is the same checkout", async () => {
    if (process.platform === "win32") return;
    const link = join(tmp, "link");
    await symlink(dir, link);
    expect(await canonicalRoot(link)).toBe(dir);
    const viaLink = await placeOf(link);
    const direct = await placeOf(dir);
    expect(viaLink.checkoutRoot).toBe(dir);
    expect(viaLink.proposalsRoot).toBe(direct.proposalsRoot);
    // A run made by the server (started with the symlinked root) is the person's own, not foreign.
    const served = await startRun(await hostAt(link, viaLink));
    const person = await hostAt(dir, direct);
    expect(await (await person.open(served.runId))?.foreignRoot()).toBeUndefined();
    // And a proposal of the server is the one the person's `proposals` lists.
    await (await hostAt(link, viaLink)).proposePipeline({
      yaml: DEMO.replace("name: demo", "name: other"),
      summary: "from the server",
    });
    expect((await person.pipelineProposals()).map((p) => p.summary)).toEqual(["from the server"]);
  });

  test("storage_worktrees_share_project_id and storage_worktree_run_not_foreign", async () => {
    const worktree = join(tmp, "wt");
    git(dir, "worktree", "add", "-q", worktree);
    // The worktree has the committed config, so its own place is the same project id.
    expect(await canonicalRoot(worktree)).toBe(dir);
    const fromWorktree = await placeOf(worktree);
    const main = await placeOf(dir);
    expect(fromWorktree.tree).toBe(main.tree);
    expect(fromWorktree.checkoutRoot).toBe(dir);
    expect(fromWorktree.proposalsRoot).toBe(main.proposalsRoot);
    // The project found from inside the worktree is the main checkout, as for every command.
    expect((await findProjectRoot(worktree)).root).toBe(dir);
    // A run recorded through the worktree is not foreign to the main checkout, nor the reverse.
    const made = await startRun(await hostAt(worktree, fromWorktree));
    const hostMain = await hostAt(dir, main);
    expect(await (await hostMain.open(made.runId))?.foreignRoot()).toBeUndefined();
    const mainRun = await startRun(hostMain, "u");
    const hostWt = await hostAt(worktree, fromWorktree);
    expect(await (await hostWt.open(mainRun.runId))?.foreignRoot()).toBeUndefined();
    // And the ones of a different checkout still are.
    expect(await canonicalRoot(join(tmp, "missing"))).toBe(join(tmp, "missing"));
  });

  test("a non-string root in meta.json is no claim of another checkout", async () => {
    const h = await hostAt(dir);
    const run = await startRun(h);
    const metaPath = join(tree(), "runs", run.runId, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta["root"] = { not: "a path" };
    await writeFile(metaPath, JSON.stringify(meta));
    const again = await hostAt(dir);
    expect(await (await again.open(run.runId))?.foreignRoot()).toBeUndefined();
    // Starting the task again picks the run up instead of failing on the odd value.
    const { status } = await again.start({ pipeline: "demo", task: "t", restart: false });
    expect(status).toBe("reused");
  });

  test("storage_mv_between_ids: a run moved to another project id is seen there", async () => {
    const run = await startRun(await hostAt(dir));
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      'worktree:\n  mode: "off"\nstorage: home\nproject_id: other-bbbb2222\n',
    );
    const other = await hostAt(dir);
    expect(await other.runSummaries()).toEqual([]);
    const target = join(base, "projects", "other-bbbb2222", "runs");
    await mkdir(target, { recursive: true });
    await rename(join(tree(), "runs", run.runId), join(target, run.runId));
    expect((await other.runSummaries()).map((s) => s.meta.runId)).toEqual([run.runId]);
  });
});

describe("a place that cannot be used", () => {
  test("storage_base_not_a_directory: the start fails with a code and without the folder", async () => {
    const file = join(tmp, "a-file");
    await writeFile(file, "x");
    const place = await placeOf(dir, { KODEL_STATE_DIR: file });
    const h = await hostAt(dir, place);
    const error = (await h
      .start({ pipeline: "demo", task: "t", restart: false })
      .catch((e: unknown) => e)) as KodelError;
    expect(error).toBeInstanceOf(KodelError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).not.toContain(file);
    expect(error.message).not.toContain(tmp);
    // Nothing fell back to the project's own folder.
    expect(await exists(join(dir, ".kodel", "runs"))).toBe(false);
  });

  test("storage_unwritable_home_does_not_fall_back", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await chmod(base, 0o500);
    const h = await hostAt(dir);
    const error = (await h
      .start({ pipeline: "demo", task: "t", restart: false })
      .catch((e: unknown) => e)) as KodelError;
    expect(error).toBeInstanceOf(KodelError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("<home>");
    expect(error.message).not.toContain(base);
    expect(await exists(join(dir, ".kodel", "runs"))).toBe(false);
  });

  test("storage_default_ignores_foreign_kodel: a default project does not look at ~/.kodel", async () => {
    // The base is a file, as if another product's `~/.kodel` were in the way.
    const file = join(tmp, "a-file");
    await writeFile(file, "x");
    await writeFile(join(dir, ".kodel", "config.yaml"), 'worktree:\n  mode: "off"\n');
    const place = await placeOf(dir, { KODEL_STATE_DIR: file });
    expect(place.mode).toBe("project");
    const run = await startRun(await hostAt(dir, place));
    expect(await exists(join(dir, ".kodel", "runs", run.runId, "meta.json"))).toBe(true);
  });

  test("storage_env_mismatch_is_soft: another base finds no run, and throws nothing", async () => {
    const run = await startRun(await hostAt(dir));
    const elsewhere = await hostAt(dir, await placeOf(dir, { KODEL_STATE_DIR: join(tmp, "else") }));
    expect(await elsewhere.runSummaries()).toEqual([]);
    expect(await elsewhere.open(run.runId)).toBeUndefined();
  });

  test("storage_change_between_check_and_write: a host keeps writing to the place it started with", async () => {
    const start = await placeOf(dir);
    const h = await hostAt(dir, start); // no watch: the place is fixed
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      'worktree:\n  mode: "off"\nstorage: home\nproject_id: other-bbbb2222\n',
    );
    const run = await startRun(h);
    expect(await exists(join(tree(), "runs", run.runId, "meta.json"))).toBe(true);
    expect(await exists(join(base, "projects", "other-bbbb2222"))).toBe(false);
  });

  test("storage_concurrent_place_creation: one place made by several at once", async () => {
    const place = await placeOf(dir);
    const { ensurePlace } = await import("../src");
    await Promise.all(Array.from({ length: 6 }, () => ensurePlace(place)));
    if (process.platform === "win32") return;
    for (const folder of [tree(), place.runsRoot, place.proposalsRoot]) {
      expect(((await stat(folder)).mode & 0o777).toString(8), folder).toBe("700");
    }
  });

  test("a run folder recreated after the tree was removed is still 0700", async () => {
    if (process.platform === "win32") return;
    const h = await hostAt(dir);
    const first = await startRun(h, "one");
    await rm(tree(), { recursive: true });
    const second = await startRun(h, "two");
    expect(second.runId).not.toBe(first.runId);
    expect(((await stat(join(tree(), "runs"))).mode & 0o777).toString(8)).toBe("700");
  });
});

describe("a config the loader refuses, for the commands that only read", () => {
  test("storage_commands_work_on_broken_config: a run goes on and its decisions are taken", async () => {
    const started = await hostAt(dir);
    const run = await startRun(started);
    // The config is now one the loader refuses (an unknown key), but the two lines are fine.
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\nnot_a_key: 1\n`,
    );
    const problems: string[] = [];
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: env(),
      onConfigProblem: (message) => problems.push(message),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not_a_key");
    const h = await hostAt(dir, place);
    // The run is found, its step is served and finished, the gate is decided, a report is made.
    const again = (await h.open(run.runId)) as LocalRun;
    expect(again).toBeDefined();
    await again.nextStep();
    await again.completeStep("write", 1, "done");
    await again.settle();
    expect((await again.state()).active.some((v) => v.phase === "human")).toBe(true);
    expect((await again.report()).runId).toBe(run.runId);
    const decided = await again.decideHuman("approve", "approved");
    expect(decided.ok).toBe(true);
    // A proposal can be listed; only a start refuses the config.
    expect(await h.pipelineProposals()).toEqual([]);
    await expect(h.start({ pipeline: "demo", task: "u", restart: false })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});

describe("a failure of the disk in a running step", () => {
  test("storage_errors_scrub_home_path: it leaves as CONFIG_INVALID without the home folder", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const run = await startRun(await hostAt(dir));
    await run.nextStep();
    const folder = join(tree(), "runs", run.runId);
    // The run's folder cannot take a new file: the write of its state fails at the next step.
    await chmod(folder, 0o500);
    try {
      const error = (await run.completeStep("write", 1, "done").catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(KodelError);
      expect((error as KodelError).code).toBe("CONFIG_INVALID");
      expect(error.message).toContain("<home>");
      expect(error.message).not.toContain(base);
    } finally {
      await chmod(folder, 0o700);
    }
  });
});

describe("which errors are the history's", () => {
  const errno = (code: string, props: Record<string, unknown> = {}) =>
    Object.assign(new Error(`${code}: boom`), { code, ...props });

  test("storage_place_problem_is_scoped_to_the_home_tree", async () => {
    const place = await placeOf(dir);
    const inside = join(tree(), "runs", "r_x", "state.json");
    // A system error whose path is under the home base is the history's: a code, no folder.
    const mine = placeProblem(errno("EACCES", { path: inside }), place) as KodelError;
    expect(mine).toBeInstanceOf(KodelError);
    expect(mine.code).toBe("CONFIG_INVALID");
    expect(mine.message).toContain("<home>");
    expect(mine.message).not.toContain(base);
    // One of the project's own files, or of the machine, is not: it is said as it is.
    const theirs = errno("EACCES", { path: join(dir, ".kodel", "pipelines", "demo.yaml") });
    expect(placeProblem(theirs, place)).toBe(theirs);
    const rename = errno("EXDEV", { path: join(dir, "a"), dest: join(dir, "b") });
    expect(placeProblem(rename, place)).toBe(rename);
    // An error of Node itself, an abort and a parse error are not file-system errors at all.
    for (const code of ["ERR_INVALID_ARG_TYPE", "ABORT_ERR", "BAD_INDENT"]) {
      const other = errno(code, { path: inside });
      expect(placeProblem(other, place), code).toBe(other);
    }
    // A write that failed half way names no path: it is the history's only where the caller knows.
    const full = errno("ENOSPC");
    expect(placeProblem(full, place)).toBe(full);
    expect(placeProblem(full, place, true)).toBeInstanceOf(KodelError);
    // A project place has no home tree to blame; a KodelError is left alone.
    const project = await placeOf(dir, {});
    expect(
      placeProblem(errno("EACCES", { path: inside }), { ...project, mode: "project" }),
    ).toBeInstanceOf(Error);
    const given = new KodelError("UNKNOWN_RUN", "x");
    expect(placeProblem(given, place, true)).toBe(given);
  });

  test("an error in the project's own files is not blamed on the history", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), place: await placeOf(dir) });
    // `replaceFile` writes a pipeline file of the project: no such folder, said as the system said it.
    const error = (await store
      .replaceFile(join(dir, "missing", "demo.yaml"), "x")
      .catch((e: unknown) => e)) as NodeJS.ErrnoException;
    expect(error).not.toBeInstanceOf(KodelError);
    expect(error.code).toBe("ENOENT");
  });
});

describe("the session index of a home project", () => {
  test("storage_session_index_read_from_home: the run's executor record comes from the home index", async () => {
    const line = (id: string) =>
      `${JSON.stringify({ session_id: id, agent: "claude-code", cwd: dir, ts: "2026-10-21T10:00:00.000Z" })}\n`;
    const place = await placeOf(dir);
    await mkdir(place.tree as string, { recursive: true });
    await writeFile(place.sessionsPath, line("sess-in-home"));
    // The index of the project folder is not the one that is read in `home` mode.
    await writeFile(join(dir, ".kodel", "sessions.jsonl"), line("sess-in-project"));
    const host = await hostAt(dir, place, { environment: {} });
    const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
    const started = (await host.runSummaries()).length;
    expect(started).toBe(1);
    const journal = JSON.stringify(
      (await (await host.open(run.runId))?.journal())?.find((r) => r.event === "run_started"),
    );
    expect(journal).toContain("sess-in-home");
    expect(journal).toContain("observed-hook");
    expect(journal).not.toContain("sess-in-project");
  });
});

describe("a project that moved", () => {
  test("storage_moved_project_runs_read_foreign: the history is found, it is not continued, a new start is new", async () => {
    const run = await startRun(await hostAt(dir));
    const moved = join(tmp, "moved");
    await rename(dir, moved);
    const host = await hostAt(moved);
    // The history is found and its trust holds (the hashes follow the id).
    const found = (await host.open(run.runId)) as LocalRun;
    expect(await found.integrityStatus()).toBe("ok");
    // It was made at the old path, so it is another checkout's now: it is not continued here.
    expect(await found.foreignRoot()).toBe(dir);
    await expect(found.nextStep()).rejects.toMatchObject({ code: "WORKDIR_INVALID" });
    // And the same task starts a run of its own.
    const { status, run: fresh } = await host.start({
      pipeline: "demo",
      task: "t",
      restart: false,
    });
    expect(status).toBe("started");
    expect(fresh.runId).not.toBe(run.runId);
  });
});

describe("what a full run writes", () => {
  test("storage_no_home_path_in_written_files: no file of the run names the home folder", async () => {
    const h = await hostAt(dir);
    const run = await startRun(h);
    await run.nextStep();
    await run.completeStep("write", 1, "done");
    await run.settle();
    const files: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(path);
      }
    };
    await walk(tree());
    await walk(join(dir, ".kodel"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, file).not.toContain(base);
    }
  });
});

describe("the history collector and the session index", () => {
  test("storage_collector_gets_index_path: the locator of the host decides where the index is", async () => {
    const configDir = join(tmp, "claude");
    const log = await installClaudeSession({ configDir, cwd: dir, subagents: false });
    const index = join(tmp, "elsewhere.jsonl");
    await writeFile(
      index,
      `${JSON.stringify({ session_id: CLAUDE_FIXTURE_SESSION, agent: "claude-code", transcript_path: log, cwd: dir, ts: "2026-10-21T10:00:00.000Z" })}\n`,
    );
    const collector = claudeCodeCollector({
      configDir,
      indexLocator: async () => ({ path: index, shared: false }),
    });
    const refs = await collector.locate(dir);
    expect(refs.map((r) => r.session_id)).toEqual([CLAUDE_FIXTURE_SESSION]);
    // The index named by the locator is the answer: an index that is not there leaves the scan.
    const none = claudeCodeCollector({
      configDir: join(tmp, "nowhere"),
      indexLocator: async () => ({ path: join(tmp, "missing.jsonl"), shared: false }),
    });
    expect(await none.locate(dir)).toEqual([]);
  });

  test("storage_session_log_guard_unchanged: a log of another project is refused in home mode too", async () => {
    const configDir = join(tmp, "claude");
    const plain = join(tmp, "plain");
    await mkdir(plain);
    const log = await installClaudeSession({ configDir, cwd: plain, subagents: false });
    const collector = claudeCodeCollector({ configDir });
    const ref: SessionRef = {
      agent: "claude-code",
      session_id: CLAUDE_FIXTURE_SESSION,
      project_root: dir, // a home-mode project
      path: log,
      cwd: plain,
    };
    const read = async () => {
      const out: HistoryEvent[] = [];
      for await (const event of collector.read(ref)) out.push(event);
      return out;
    };
    await expect(read()).rejects.toMatchObject({ code: "HISTORY_PATH_OUTSIDE_PROJECT" });
  });
});

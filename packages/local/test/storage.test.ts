import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHistory, KodelError, parsePipeline } from "@kodel-ai/pipeline-core";
import {
  FileStore,
  homePlace,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  newRunId,
  resolveStoragePlace,
  runCommand,
  type StoragePlace,
} from "../src";
import type { CommandOptions } from "../src/command";
import type { CommandContext } from "../src/host";

const ID = "demo-aaaa1111";

let dir: string; // the project (and its clone, in some tests)
let clone: string;
let base: string; // the home base (KODEL_STATE_DIR)
let hashes: string; // the integrity hashes
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-storage-"));
  clone = await mkdtemp(join(tmpdir(), "kodel-storage-clone-"));
  base = await mkdtemp(join(tmpdir(), "kodel-storage-base-"));
  hashes = await mkdtemp(join(tmpdir(), "kodel-storage-hashes-"));
  for (const root of [dir, clone]) await project(root, `storage: home\nproject_id: ${ID}\n`);
});
afterEach(async () => {
  for (const path of [dir, clone, base, hashes]) await rm(path, { recursive: true, force: true });
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

async function project(root: string, storage: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(root, ".kodel", "config.yaml"), `worktree:\n  mode: "off"\n${storage}`);
}

const env = () => ({ KODEL_STATE_DIR: base });

const placeOf = (root: string) =>
  resolveStoragePlace({ root, dataDir: join(root, ".kodel"), env: env() });

async function hostAt(root: string, over: Record<string, unknown> = {}) {
  return new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: hashes,
    storage: await placeOf(root),
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

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

describe("storage: home", () => {
  test("storage_home_writes_outside_repository", async () => {
    const run = await startRun(await hostAt(dir));
    // The run is in the home tree, with its record.
    expect(await exists(join(tree(), "runs", run.runId, "meta.json"))).toBe(true);
    // The repository holds nothing but the config and the pipelines.
    expect((await readdir(join(dir, ".kodel"))).sort()).toEqual(["config.yaml", "pipelines"]);
    // And no file in it names the home folder.
    for (const file of await filesUnder(dir)) {
      expect(await readFile(file, "utf8"), file).not.toContain(base);
    }
  });

  test("storage_home_dirs_are_0700", async () => {
    if (process.platform === "win32") return;
    const run = await startRun(await hostAt(dir));
    for (const folder of [tree(), join(tree(), "runs"), join(tree(), "runs", run.runId)]) {
      expect(((await stat(folder)).mode & 0o777).toString(8), folder).toBe("700");
    }
  });

  test("storage_start_lock_follows_place", async () => {
    const place = await placeOf(dir);
    const store = new FileStore({ root: join(dir, ".kodel"), place });
    await store.withStartLock(async () => {
      expect(await exists(join(tree(), "start.lock"))).toBe(true);
      expect(await exists(join(dir, ".kodel", "start.lock"))).toBe(false);
    });
    expect(await exists(join(tree(), "start.lock"))).toBe(false);
  });

  test("storage_proposals_move_with_home", async () => {
    const h = await hostAt(dir);
    const outcome = await h.proposePipeline({
      yaml: DEMO.replace("name: demo", "name: other"),
      summary: "a new pipeline",
    });
    expect(outcome).toMatchObject({ ok: true, status: "proposed" });
    const place = await placeOf(dir);
    expect(await exists(join(place.proposalsRoot, "other.json"))).toBe(true);
    expect(await exists(join(dir, ".kodel", "proposals"))).toBe(false);
    expect((await h.pipelineProposals()).map((p) => p.name)).toEqual(["other"]);
  });

  test("storage_run_proposal_follows_run", async () => {
    const run = await startRun(await hostAt(dir));
    const outcome = await run.proposeChange({
      yaml: DEMO.replace("prompt: write", "prompt: write more"),
      summary: "more",
    });
    expect(outcome.ok).toBe(true);
    expect(await exists(join(tree(), "runs", run.runId, "pending", "proposal.yaml"))).toBe(true);
  });

  test("storage_meta_written_first and a folder without meta.json is not a run", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), place: await placeOf(dir) });
    const id = await store.reserveRunId(Date.now());
    // Reserved, not yet a run: nothing lists it.
    expect(await store.listRuns()).toEqual([]);
    await store.createRun({
      v: 2,
      runId: id,
      pipeline: "demo",
      task: "t",
      specHash: "0000000000000000",
      createdAt: 1,
    });
    expect((await store.listRuns()).map((m) => m.runId)).toEqual([id]);
    // The root is recorded in one spelling per checkout: its real path (`/private/var` on macOS).
    expect(await store.readMeta(id)).toMatchObject({ root: await realpath(dir) });
  });

  test("storage_create_run_retries_on_eexist", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), place: await placeOf(dir) });
    const now = Date.now();
    const taken = newRunId(now, () => 0.5);
    await mkdir(join(tree(), "runs", taken), { recursive: true });
    const random = spyOn(Math, "random");
    random.mockReturnValueOnce(0.5).mockReturnValueOnce(0.5).mockReturnValue(0.25);
    try {
      const id = await store.reserveRunId(now);
      expect(id).not.toBe(taken);
      expect(await exists(join(tree(), "runs", id))).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  test("storage_run_lock_creates_no_folder", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), place: await placeOf(dir) });
    const id = newRunId();
    await expect(store.withLock(id, async () => 1)).rejects.toMatchObject({
      code: "UNKNOWN_RUN",
    });
    expect(await exists(join(tree(), "runs", id))).toBe(false);
    expect(await exists(join(dir, ".kodel", "runs", id))).toBe(false);
  });
});

describe("one place is read", () => {
  test("storage_reads_only_the_configured_place and mv makes a run visible", async () => {
    // A run made while the project kept its history in `.kodel`.
    await writeFile(join(dir, ".kodel", "config.yaml"), 'worktree:\n  mode: "off"\n');
    const projectHost = await hostAt(dir, { storage: undefined });
    const old = await startRun(projectHost, "old");
    expect(await exists(join(dir, ".kodel", "runs", old.runId))).toBe(true);

    // Switched to `home`: the old run is not seen, and a run made now is in the home tree only.
    await writeFile(
      join(dir, ".kodel", "config.yaml"),
      `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
    );
    const homeHost = await hostAt(dir);
    expect(await homeHost.runSummaries()).toEqual([]);
    expect(await homeHost.open(old.runId)).toBeUndefined();
    const fresh = await startRun(homeHost, "fresh");
    expect((await homeHost.runSummaries()).map((s) => s.meta.runId)).toEqual([fresh.runId]);

    // A person moves the old run by hand: it is seen.
    await mkdir(join(tree(), "runs"), { recursive: true });
    await rename(join(dir, ".kodel", "runs", old.runId), join(tree(), "runs", old.runId));
    const ids = (await (await hostAt(dir)).runSummaries()).map((s) => s.meta.runId).sort();
    expect(ids).toEqual([old.runId, fresh.runId].sort());

    // And the other way: back to `project`, the home tree is not read.
    await writeFile(join(dir, ".kodel", "config.yaml"), 'worktree:\n  mode: "off"\n');
    const back = await hostAt(dir, { storage: undefined });
    expect((await back.runSummaries()).map((s) => s.meta.runId)).toEqual([]);
  });

  test("a run planted in the other place is invisible", async () => {
    const homeHost = await hostAt(dir);
    const planted = newRunId();
    await mkdir(join(dir, ".kodel", "runs", planted), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "runs", planted, "meta.json"),
      JSON.stringify({
        v: 2,
        runId: planted,
        pipeline: "demo",
        task: "t",
        specHash: "0000000000000000",
        createdAt: 1,
      }),
    );
    expect(await homeHost.runSummaries()).toEqual([]);
    expect(await homeHost.open(planted)).toBeUndefined();
  });
});

describe("clones of one project", () => {
  test("storage_clones_share_trust and storage_foreign_run_not_reused", async () => {
    const a = await hostAt(dir);
    const b = await hostAt(clone);
    const runA = await startRun(a);
    // B sees A's run, and its hash is the shared one: no false alarm.
    const seen = await b.open(runA.runId);
    expect(seen).toBeDefined();
    expect(await seen?.integrityStatus()).toBe("ok");
    // B starts the same task: it makes a run of its own, it does not pick A's up.
    const { run: runB, status } = await b.start({ pipeline: "demo", task: "t", restart: false });
    expect(status).toBe("started");
    expect(runB.runId).not.toBe(runA.runId);
    // A advances its run; B's hash for it is still right.
    await runA.nextStep();
    expect(await (await b.open(runA.runId))?.integrityStatus()).toBe("ok");
    const both = (await b.runSummaries()).map((s) => s.meta.runId).sort();
    expect(both).toEqual([runA.runId, runB.runId].sort());
  });

  test("storage_foreign_run_not_continued and its decisions work by id", async () => {
    const a = await hostAt(dir);
    const b = await hostAt(clone);
    const runA = await startRun(a);
    const foreign = (await b.open(runA.runId)) as LocalRun;
    expect(await foreign.foreignRoot()).toBe(await realpath(dir));
    await expect(foreign.nextStep()).rejects.toMatchObject({ code: "WORKDIR_INVALID" });
    await expect(foreign.completeStep("write", 1, "done")).rejects.toMatchObject({
      code: "WORKDIR_INVALID",
    });
    await expect(foreign.reportResult("write", 1, { rows: [] })).rejects.toMatchObject({
      code: "WORKDIR_INVALID",
    });
    await expect(foreign.resume()).rejects.toMatchObject({ code: "WORKDIR_INVALID" });
    // A decision on its behalf is allowed (the CLI says so).
    await expect(foreign.acknowledge("looked")).resolves.toBeDefined();
    // The owner goes on.
    expect(await runA.foreignRoot()).toBeUndefined();
    await expect(runA.nextStep()).resolves.toBeDefined();
  });

  test("storage_two_clones_two_runs_serialised", async () => {
    const a = await hostAt(dir);
    const b = await hostAt(clone);
    const [one, two] = await Promise.all([
      a.start({ pipeline: "demo", task: "same", restart: false }),
      b.start({ pipeline: "demo", task: "same", restart: false }),
    ]);
    expect(one.run.runId).not.toBe(two.run.runId);
    const ids = (await a.runSummaries()).map((s) => s.meta.runId).sort();
    expect(ids).toEqual([one.run.runId, two.run.runId].sort());
  });

  test("storage_missing_root_reads_as_owned", async () => {
    const a = await hostAt(dir);
    const runA = await startRun(a);
    const metaPath = join(tree(), "runs", runA.runId, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    // The field is the agent's to delete: a run without it is taken as ours (it is advisory).
    delete meta["root"];
    await writeFile(metaPath, JSON.stringify(meta));
    const b = await hostAt(clone);
    expect(await (await b.open(runA.runId))?.foreignRoot()).toBeUndefined();
  });

  test("storage_proposals_per_checkout: one name from two clones does not collide", async () => {
    const a = await hostAt(dir);
    const b = await hostAt(clone);
    const yaml = DEMO.replace("name: demo", "name: shared");
    await a.proposePipeline({ yaml, summary: "from a" });
    await b.proposePipeline({ yaml, summary: "from b" });
    expect((await a.pipelineProposals()).map((p) => p.summary)).toEqual(["from a"]);
    expect((await b.pipelineProposals()).map((p) => p.summary)).toEqual(["from b"]);
  });
});

describe("integrity in home mode", () => {
  test("storage_home_integrity_detects_edit", async () => {
    const run = await startRun(await hostAt(dir));
    expect(await run.integrityStatus()).toBe("ok");
    const state = join(tree(), "runs", run.runId, "state.json");
    const text = await readFile(state, "utf8");
    await writeFile(state, text.replace('"status": "running"', '"status": "paused"'));
    expect(await run.integrityStatus()).toBe("modified");
  });

  test("storage_deleted_state_not_fresh", async () => {
    const run = await startRun(await hostAt(dir));
    await rm(join(tree(), "runs", run.runId, "state.json"));
    await expect(run.state()).rejects.toThrow();
  });

  test("storage_history_survives_project_move: the hashes follow the project id", async () => {
    const run = await startRun(await hostAt(dir));
    // The same project in another folder: the history is found and its trust holds.
    const moved = await hostAt(clone);
    const found = await moved.open(run.runId);
    expect(found).toBeDefined();
    expect(await found?.integrityStatus()).toBe("ok");
  });

  test("storage_hash_without_run_is_not_changed", async () => {
    const h = await hostAt(dir);
    const run = await startRun(h);
    await rm(join(tree(), "runs", run.runId), { recursive: true });
    expect(await h.open(run.runId)).toBeUndefined();
  });
});

describe("the server and a changed config", () => {
  const watched = (place: () => Promise<StoragePlace>) => async () => {
    const now = await place();
    return now;
  };

  test("storage_changed_under_running_server_refuses_all", async () => {
    const start = await placeOf(dir);
    let current: StoragePlace = start;
    const h = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: start,
      watchStorage: watched(async () => current),
    });
    const run = await startRun(h);
    expect(await h.open(run.runId)).toBeDefined();
    // The config now names another place: the server stops, whatever the call.
    current = homePlace({ root: dir, projectId: "demo-bbbb2222", base });
    await expect(h.start({ pipeline: "demo", task: "u", restart: false })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(h.open(run.runId)).rejects.toBeInstanceOf(KodelError);
    await expect(h.runSummaries()).rejects.toBeInstanceOf(KodelError);
    await expect(h.pipelineProposals()).rejects.toBeInstanceOf(KodelError);
    await expect(h.proposePipeline({ yaml: DEMO, summary: "x" })).rejects.toBeInstanceOf(
      KodelError,
    );
    // Back to the place it started with: it goes on.
    current = start;
    expect(await h.open(run.runId)).toBeDefined();
  });

  test("a config that cannot be read stops a start and lets the others go on", async () => {
    const start = await placeOf(dir);
    let broken = false;
    const h = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: start,
      watchStorage: async () => {
        if (broken) throw new KodelError("CONFIG_INVALID", "unreadable");
        return start;
      },
    });
    const run = await startRun(h);
    broken = true;
    await expect(h.start({ pipeline: "demo", task: "u", restart: false })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(await h.open(run.runId)).toBeDefined();
    expect((await h.runSummaries()).length).toBe(1);
  });
});

describe("resolving the place", () => {
  const config = (root: string) => join(root, ".kodel", "config.yaml");

  test("a broken config still names the place for read commands, and never starts a run", async () => {
    // Not valid for the strict loader (an unknown key), but the two lines are fine.
    await writeFile(config(dir), `storage: home\nproject_id: ${ID}\nnot_a_key: 1\n`);
    const place = await placeOf(dir);
    expect(place).toMatchObject({ mode: "home", projectId: ID });
    const h = await hostAt(dir);
    await expect(h.start({ pipeline: "demo", task: "t", restart: false })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("a matcher answer the strict loader would refuse is refused too", async () => {
    await writeFile(config(dir), "storage: cloud\nnot_a_key: 1\n");
    await expect(placeOf(dir)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("home without a project_id says which two lines to add", async () => {
    await writeFile(config(dir), "storage: home\n");
    const error = (await placeOf(dir).catch((e: unknown) => e)) as KodelError;
    expect(error).toBeInstanceOf(KodelError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("project_id");
    expect(error.message).toMatch(/storage: home\nproject_id: [a-z0-9._-]+/);
  });

  test("storage_relative_state_dir_history_error", async () => {
    await expect(
      resolveStoragePlace({
        root: dir,
        dataDir: join(dir, ".kodel"),
        env: { KODEL_STATE_DIR: "relative" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("a project without the key is the project place, whatever the environment", async () => {
    await writeFile(config(dir), 'worktree:\n  mode: "off"\n');
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: { KODEL_STATE_DIR: "relative-is-not-looked-at" },
    });
    expect(place.mode).toBe("project");
    expect(place.runsRoot).toBe(join(dir, ".kodel", "runs"));
  });
});

describe("what is kept about a failure", () => {
  test("storage_errors_scrub_home_path: the journal does not name the home folder", async () => {
    const build = parsePipeline(
      [
        "name: out",
        "nodes:",
        "  - slug: build",
        "    kind: command",
        `    command: node -e "console.log('fine')"`,
        "  - slug: look",
        "    kind: human",
        "    prompt: ok?",
        "edges:",
        "  - { from: build, to: look }",
        "  - { from: build, to: look, when: failed }",
        "  - { from: look, to: build, when: rejected }",
        "",
      ].join("\n"),
    );
    const host = new LocalHost(build, {
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: await placeOf(dir),
      // A file where the artifacts folder should be makes the write of the output fail with an
      // error that names the run folder, which is under the home base.
      runCommand: async (command: string, options: CommandOptions, context: CommandContext) => {
        await writeFile(join(tree(), "runs", context.runId, "artifacts"), "in the way");
        return runCommand(command, options);
      },
    });
    const { run } = await host.start("t", {
      history: {
        ...defaultHistory(),
        changes: { enabled: false, exclude: [], max_kb: 512 },
        output: { enabled: true, max_kb: 64 },
      },
    });
    await run.settle();
    const text = JSON.stringify(
      (await host.store.readJournal(run.runId)).filter((r) => r.event === "command_finished"),
    );
    expect(text).toContain("output_error");
    expect(text).not.toContain(base);
    expect(text).not.toContain(await realpath(base));
  });
});

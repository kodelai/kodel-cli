import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HISTORY, MAX_LOGGED_REFUSALS, parsePipeline } from "@kodel-ai/pipeline-core";
import {
  capChanges,
  engineEnv,
  FileStore,
  GitSnapshotter,
  hashSource,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  MAX_CHANGES_SHOWN,
  MemoryIntegrity,
  newRunId,
  processIsAlive,
  processOwnerId,
  runCommand,
  sha256,
} from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-hard-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  // These tests are about the root; the run's own worktree is tested in worktree.test.ts.
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "  - slug: verify",
  "    kind: command",
  `    command: node -e "console.log('ok')"`,
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: verify }",
  "  - { from: verify, to: approve }",
  "  - { from: verify, to: write, when: failed }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const host = (over: Record<string, unknown> = {}) =>
  new LocalPipelineHost({ root: dir, heartbeatMs: 0, ...over });

const runDir = (id: string) => join(dir, ".kodel", "runs", id);

async function startRun(h = host()): Promise<LocalRun> {
  const { run } = await h.start({ pipeline: "demo", task: "t", restart: false });
  return (await h.open(run.runId)) as LocalRun;
}

/** The kept version of the pipeline a run is pinned to. */
async function keptSpec(id: string): Promise<string> {
  const state = JSON.parse(await readFile(join(runDir(id), "state.json"), "utf8")) as {
    specHash: string;
  };
  return join(runDir(id), "specs", `${state.specHash}.yaml`);
}

describe("the pipeline a run started with cannot be swapped", () => {
  test("a copy edited after the start is refused, not obeyed", async () => {
    const run = await startRun();
    const path = await keptSpec(run.runId);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("console.log('ok')", "process.exit(0)"));
    await expect(host().open(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });

  test("a copy turned into something that is not a pipeline is refused too", async () => {
    const run = await startRun();
    await writeFile(await keptSpec(run.runId), "name: x\nnodes: []\n");
    await expect(host().open(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });

  test("the check runs on every open, also when this process already has the run", async () => {
    const h = host();
    const run = await startRun(h);
    expect(await h.open(run.runId)).toBeDefined();
    const path = await keptSpec(run.runId);
    await writeFile(path, `${await readFile(path, "utf8")}\n# changed\n`);
    // the copy is pinned as it was written: not even a comment may be added to it
    await expect(h.open(run.runId)).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
  });

  test("a run written before pipelines were kept in versions is refused by its format, not as modified", async () => {
    const run = await startRun();
    const path = join(runDir(run.runId), "meta.json");
    const meta = JSON.parse(await readFile(path, "utf8")) as { v: number };
    meta.v = 1;
    await writeFile(path, JSON.stringify(meta));
    await expect(host().open(run.runId)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  test("editing the pipeline file does not touch a run: it goes on with its kept version", async () => {
    const h = host();
    const run = await startRun(h);
    const file = join(dir, ".kodel", "pipelines", "demo.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("ok?", "fine?"));
    expect((await host().open(run.runId))?.runId).toBe(run.runId);
  });

  test("each attempt records the hashes of the definition it ran on", async () => {
    const run = await startRun();
    const lines = (await readFile(join(runDir(run.runId), "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const entered = lines.find((l) => l.event === "node_entered");
    expect(entered?.definition).toMatchObject({
      work: expect.stringMatching(/^[0-9a-f]{16}$/),
      checks: expect.stringMatching(/^[0-9a-f]{16}$/),
      routing: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  test("the pipeline file of the run is in its state, relative to the repository", async () => {
    const run = await startRun();
    const state = JSON.parse(await readFile(join(runDir(run.runId), "state.json"), "utf8")) as {
      pipelineFile?: string;
    };
    expect(state.pipelineFile).toBe(".kodel/pipelines/demo.yaml");
  });

  test("a new run is pinned to the hash of the text of its pipeline", async () => {
    // The pin is the hash of the text, so the text parsing differently later does not matter. This
    // is checked by the text alone: the same source gives the same pin whatever the parsed form.
    const run = await startRun();
    const state = JSON.parse(await readFile(join(runDir(run.runId), "state.json"), "utf8")) as {
      specHash: string;
    };
    const source = await readFile(await keptSpec(run.runId), "utf8");
    expect(state.specHash).toBe(hashSource(source));
  });

  test("a run whose kept version is gone is refused as modified", async () => {
    const run = await startRun();
    await rm(await keptSpec(run.runId));
    await expect(host().open(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });

  test("starting the same task again, after the file changed, still gives the original run", async () => {
    const h = host();
    const first = await startRun(h);
    const file = join(dir, ".kodel", "pipelines", "demo.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("prompt: write", "prompt: other"));
    const again = await h.start({ pipeline: "demo", task: "t", restart: false });
    expect(again.status).toBe("reused");
    const step = await again.run.nextStep();
    expect(JSON.stringify(step)).toContain("write");
    expect(JSON.stringify(step)).not.toContain("other");
    expect(again.run.runId).toBe(first.runId);
  });

  test("an id that is not a run id finds nothing and touches no directory", async () => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "meta.json"), "{}");
    expect(await host().open("../../docs")).toBeUndefined();
    expect(await host().open("..")).toBeUndefined();
    await expect(host().seal("../../docs")).rejects.toMatchObject({ code: "UNKNOWN_RUN" });
  });
});

describe("a finished run stays as it finished", () => {
  async function finished() {
    const h = host();
    const run = await startRun(h);
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    await run.decideHuman("approve", "rejected", "again");
    await run.cancel();
    return { h, run };
  }

  test("rewriting the state and the seal together is still seen", async () => {
    const { run } = await finished();
    expect(await run.sealStatus()).toBe("sealed");
    const state = join(runDir(run.runId), "state.json");
    const text = await readFile(state, "utf8");
    await writeFile(state, text.replace('"task": "t"', '"task": "u"'));
    // an agent that also rewrites the seal file to match
    const store = new FileStore({ root: join(dir, ".kodel") });
    await store.writeSeal(run.runId, 1);
    expect(await run.sealStatus()).toBe("modified");
    await expect(run.nextStep()).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
  });

  test("sealing again after a deliberate change accepts it", async () => {
    const { h, run } = await finished();
    const state = join(runDir(run.runId), "state.json");
    await writeFile(state, (await readFile(state, "utf8")).replace('"task": "t"', '"task": "u"'));
    await run.acknowledge("edited the task by hand");
    await h.seal(run.runId);
    expect(await run.sealStatus()).toBe("sealed");
  });

  test("a damaged line in the middle of the journal is an error, a torn last line is not", async () => {
    const { run } = await finished();
    const store = new FileStore({ root: join(dir, ".kodel") });
    const path = join(runDir(run.runId), "journal.jsonl");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${lines.join("\n")}\n{"v":1,"seq":999`);
    expect((await store.readJournal(run.runId)).length).toBe(lines.length);
    lines[1] = "this is not json";
    await writeFile(path, `${lines.join("\n")}\n`);
    await expect(store.readJournal(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });
});

describe("a crash between the writes does not look like tampering", () => {
  test("the hash was staged but the state never written", async () => {
    const integrity = new MemoryIntegrity();
    const h = host({ integrity });
    const run = await startRun(h);
    await integrity.stage(run.runId, "0".repeat(64));
    expect(await run.integrityStatus()).toBe("ok");
    expect((await run.completeStep("write", 1)).ok).toBe(true);
  });

  test("the state was written but the hash never confirmed", async () => {
    const integrity = new MemoryIntegrity();
    const h = host({ integrity });
    const run = await startRun(h);
    const before = await readFile(join(runDir(run.runId), "state.json"), "utf8");
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    // as if the process died right after the file was replaced: old hash committed, new one staged
    const after = await readFile(join(runDir(run.runId), "state.json"), "utf8");
    integrity.hashes.set(run.runId, sha256(before));
    integrity.staged.set(run.runId, sha256(after));
    expect(await run.integrityStatus()).toBe("ok");
  });

  test("a state that matches neither is still refused", async () => {
    const integrity = new MemoryIntegrity();
    const run = await startRun(host({ integrity }));
    const path = join(runDir(run.runId), "state.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"task": "t"', '"task": "u"'));
    expect(await run.integrityStatus()).toBe("modified");
  });
});

describe("a failed save is not a failed node", () => {
  class FlakyIntegrity extends MemoryIntegrity {
    stages = 0;
    override async stage(name: string, hash: string) {
      this.stages += 1;
      // the first write is the start; the next two (the command's result) hit a full disk
      if (this.stages === 2 || this.stages === 3) throw new Error("disk full");
      return super.stage(name, hash);
    }
  }

  test("the result is saved again, and the node is not marked as failed", async () => {
    const integrity = new FlakyIntegrity();
    const spec = parsePipeline(
      [
        "name: one",
        "nodes:",
        "  - slug: first",
        "    kind: command",
        `    command: node -e "console.log('one')"`,
        "  - slug: second",
        "    kind: command",
        `    command: node -e "console.log('two')"`,
        "edges:",
        "  - { from: first, to: second }",
        "  - { from: first, to: second, when: failed }",
        "  - { from: second, to: first, when: failed }",
        "",
      ].join("\n"),
    );
    const h = new LocalHost(spec, { root: dir, heartbeatMs: 0, integrity });
    const { run } = await h.start("t");
    await run.settle();
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect(state.nodes.first?.consecutiveFailures).toBe(0);
    expect(integrity.stages).toBeGreaterThanOrEqual(4);
  });
});

describe("approving knows what changed since the gate, and says when it cannot tell", () => {
  /** A snapshotter that works until it is told to fail, the way a repository can be broken on purpose. */
  class FailsOnDemand extends GitSnapshotter {
    failing = false;
    override async snapshot(): Promise<string> {
      if (this.failing) throw new Error("git add failed: fatal: adding files failed");
      return super.snapshot();
    }
  }

  async function atGate(snapshotter?: FailsOnDemand, between?: () => void) {
    const h = host(snapshotter ? { snapshotter } : {});
    const run = await startRun(h);
    between?.();
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    return run;
  }

  test("nothing, then a file", async () => {
    const run = await atGate();
    expect(await run.changesSinceGate("approve")).toEqual({ kind: "changes", files: {} });
    await writeFile(join(dir, "later.txt"), "a\nb\n");
    expect(await run.changesSinceGate("approve")).toEqual({
      kind: "changes",
      files: { "later.txt": 2 },
    });
  });

  test("a step the run is not waiting at has no such answer", async () => {
    const run = await atGate();
    expect(await run.changesSinceGate("write")).toMatchObject({ kind: "unavailable" });
  });

  test("a baseline that is gone from git is 'cannot tell', never 'nothing changed'", async () => {
    const run = await atGate();
    const file = join(runDir(run.runId), "snapshots.json");
    const snapshots = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    const key = Object.keys(snapshots).find((k) => k.startsWith("gate:approve"));
    snapshots[key as string] = "0".repeat(40); // an object that is not there, as after `git gc`
    await writeFile(file, JSON.stringify(snapshots));
    const found = await run.changesSinceGate("approve");
    expect(found.kind).toBe("unavailable");
    const step = await run.nextStep();
    // the run baseline is still fine, so the answer to the agent is not affected by this one
    expect("waiting" in step && step.waiting.changes_unavailable).toBeFalsy();
  });

  test("git made to fail as the gate is entered does not hide the changes: the gate says it cannot tell", async () => {
    const snapshotter = new FailsOnDemand(dir);
    const run = await atGate(snapshotter, () => {
      snapshotter.failing = true;
    });
    // the step itself went through: the run is at the gate, and the agent got no error for it
    expect((await run.state()).active.map((v) => `${v.node}:${v.phase}`)).toEqual([
      "approve:human",
    ]);
    const found = await run.changesSinceGate("approve");
    expect(found).toMatchObject({ kind: "unavailable" });
    if (found.kind === "unavailable") expect(found.reason).toContain("not recorded");
    // and what the agent is told does not read as a clean result either
    snapshotter.failing = false;
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error("expected a gate");
    expect(step.waiting.changes).toBeUndefined();
    snapshotter.failing = true;
    const again = await run.nextStep();
    if (!("waiting" in again)) throw new Error("expected a gate");
    expect(again.waiting.changes_unavailable).toContain("adding files failed");
  });

  test("a start that cannot record the baseline still starts, and the gate says it cannot tell", async () => {
    const snapshotter = new FailsOnDemand(dir);
    snapshotter.failing = true;
    const h = host({ snapshotter });
    const run = await startRun(h);
    snapshotter.failing = false;
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error("expected a gate");
    expect(step.waiting.changes_unavailable).toContain("not recorded when the run began");
  });

  test("with no git at all there is nothing to compare with, which is not an alarm", async () => {
    const plain = await mkdtemp(join(tmpdir(), "kodel-nogit-"));
    try {
      await mkdir(join(plain, ".kodel", "pipelines"), { recursive: true });
      await writeFile(join(plain, ".kodel", "pipelines", "demo.yaml"), DEMO);
      const h = new LocalPipelineHost({
        root: plain,
        heartbeatMs: 0,
        history: { ...DEFAULT_HISTORY, changes: { ...DEFAULT_HISTORY.changes, enabled: false } },
      });
      const { run } = await h.start({ pipeline: "demo", task: "t", restart: false });
      const mine = (await h.open(run.runId)) as LocalRun;
      await mine.completeStep("write", 1);
      await mine.waitForRest(10_000);
      expect(await mine.changesSinceGate("approve")).toEqual({ kind: "no_repo" });
      const step = await mine.nextStep();
      if (!("waiting" in step)) throw new Error("expected a gate");
      expect(step.waiting.changes).toBeUndefined();
      expect(step.waiting.changes_unavailable).toBeUndefined();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("a very long list is cut to the files with the most changes, and the rest is counted", () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < MAX_CHANGES_SHOWN + 50; i++) files[`f${i}.txt`] = i + 1;
    const { shown, omitted } = capChanges(files);
    expect(Object.keys(shown).length).toBe(MAX_CHANGES_SHOWN);
    expect(omitted).toBe(50);
    expect(shown[`f${MAX_CHANGES_SHOWN + 49}.txt`]).toBe(MAX_CHANGES_SHOWN + 50); // the biggest is in
    expect(shown["f0.txt"]).toBeUndefined(); // the smallest is out
    expect(capChanges({ a: 1 })).toEqual({ shown: { a: 1 }, omitted: 0 });
  });
});

describe("a canceled run stops its work", () => {
  test("the command still going is killed and nothing is reported afterwards", async () => {
    const spec = parsePipeline(
      [
        "name: slow",
        "nodes:",
        "  - slug: wait",
        "    kind: command",
        `    command: node -e "setTimeout(() => {}, 20000)"`,
        "  - slug: after",
        "    kind: command",
        `    command: node -e "console.log('after')"`,
        "edges:",
        "  - { from: wait, to: after }",
        "  - { from: wait, to: after, when: failed }",
        "  - { from: after, to: wait, when: failed }",
        "",
      ].join("\n"),
    );
    const h = new LocalHost(spec, { root: dir, heartbeatMs: 0 });
    const { run } = await h.start("t");
    expect(run.activeWork().length).toBe(1);
    const started = Date.now();
    await run.cancel();
    await run.settle();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect((await run.state()).status).toBe("canceled");
  });
});

describe("two starts and stray locks", () => {
  test("a lock file that was never filled in is taken over once it is old", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), lockTimeoutMs: 1_000 });
    const id = newRunId();
    await mkdir(join(dir, ".kodel", "runs", id), { recursive: true });
    const lock = join(dir, ".kodel", "runs", id, "lock");
    await writeFile(lock, "");
    // fresh and empty: its owner may be about to write it, so wait
    await expect(store.withLock(id, async () => 1)).rejects.toMatchObject({
      code: "STATE_LOCKED",
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await store.withLock(id, async () => "taken")).toBe("taken");
  });

  test("a lock that claims to be from the future does not block for ever", async () => {
    const store = new FileStore({
      root: join(dir, ".kodel"),
      lockTimeoutMs: 1_000,
      staleLockMs: 1_000,
    });
    const id = newRunId();
    await mkdir(join(dir, ".kodel", "runs", id), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "runs", id, "lock"),
      JSON.stringify({ pid: process.pid, since: Date.now() + 3_600_000 }),
    );
    expect(await store.withLock(id, async () => "ok")).toBe("ok");
  });

  test("a holder that was taken over does not remove the new holder's lock", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), staleLockMs: 50 });
    const other = new FileStore({ root: join(dir, ".kodel"), staleLockMs: 50 });
    const id = newRunId();
    // A lock for a run never makes the run's folder (a run that is not there has none to lock).
    await mkdir(join(dir, ".kodel", "runs", id), { recursive: true });
    const lock = join(dir, ".kodel", "runs", id, "lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = store.withLock(id, async () => gate);
    await new Promise((resolve) => setTimeout(resolve, 120)); // the slow holder is now stale
    const taker = other.withLock(id, async () => {
      release(); // the slow holder finishes while the new holder still holds the lock
      await slow;
      expect(await Bun.file(lock).exists()).toBe(true);
    });
    await taker;
    expect(await Bun.file(lock).exists()).toBe(false);
  });
});

async function until(condition: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for a condition");
}

const slowCommand = (seconds: number) =>
  parsePipeline(
    [
      "name: slow",
      "nodes:",
      "  - slug: first",
      "    kind: command",
      `    command: node -e "setTimeout(() => {}, ${seconds * 1000})"`,
      "  - slug: second",
      "    kind: command",
      `    command: node -e "process.exit(0)"`,
      "edges:",
      "  - { from: first, to: second }",
      "  - { from: first, to: second, when: failed }",
      "  - { from: second, to: first, when: failed }",
      "",
    ].join("\n"),
  );

describe("engine work whose process is gone", () => {
  async function abandonedRun(seconds = 30) {
    const spec = slowCommand(seconds);
    const first = new LocalHost(spec, { root: dir, heartbeatMs: 0, ownerId: "here:1" });
    const { run } = await first.start("t");
    // the owner is written with the first heartbeat, right after the work starts
    await until(async () => (await run.state()).active[0]?.owner === "here:1");
    run.stop(); // the process died: nothing is reported, nothing is running any more
    return { spec, runId: run.runId };
  }

  const journal = async (runId: string) =>
    new FileStore({ root: join(dir, ".kodel") }).readJournal(runId);

  test("a later session starts it again at once, because the owner is known to be dead", async () => {
    const { spec, runId } = await abandonedRun();
    const second = new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      ownerId: "here:2",
      isOwnerAlive: (owner) => owner !== "here:1",
    });
    const run = second.open(runId);
    await run.nextStep();
    const restarted = (await journal(runId)).filter((r) => r.event === "node_restarted");
    expect(restarted.length).toBe(1);
    expect(JSON.stringify(restarted[0])).toContain("is gone");
    expect(run.activeWork().length).toBe(1);
    run.stop();
  });

  test("while the owner is alive, or unknown, it is left alone until the heartbeat goes stale", async () => {
    const { spec, runId } = await abandonedRun();
    const second = new LocalHost(spec, {
      root: dir,
      heartbeatMs: 0,
      ownerId: "here:2",
      isOwnerAlive: () => true,
    });
    const run = second.open(runId);
    await run.nextStep();
    expect((await journal(runId)).filter((r) => r.event === "node_restarted")).toEqual([]);
    expect(run.activeWork()).toEqual([]);
  });

  test("an owner on another machine is never judged dead from here", async () => {
    expect(processIsAlive("some-other-machine:99999999")).toBe(true);
    expect(processIsAlive(processOwnerId())).toBe(true);
    expect(processIsAlive(`${hostname()}:99999999`)).toBe(false);
    expect(processIsAlive("not an owner id")).toBe(true);
  });

  test("waiting for work that another process runs follows it on disk until it is done", async () => {
    const spec = slowCommand(1);
    const owner = new LocalHost(spec, { root: dir, heartbeatMs: 0, ownerId: "here:1" });
    const { run: ownersRun } = await owner.start("t");
    const watcher = new LocalHost(spec, { root: dir, heartbeatMs: 0, ownerId: "here:2" });
    const watching = watcher.open(ownersRun.runId);
    const started = Date.now();
    await watching.waitForRest(15_000);
    const waited = Date.now() - started;
    expect((await watching.state()).status).toBe("completed");
    expect(waited).toBeGreaterThan(500);
    expect(waited).toBeLessThan(8_000);
  });

  test("and it gives up at the time it was given, with the work still going", async () => {
    const spec = slowCommand(20);
    const owner = new LocalHost(spec, { root: dir, heartbeatMs: 0, ownerId: "here:1" });
    const { run } = await owner.start("t");
    const watching = new LocalHost(spec, { root: dir, heartbeatMs: 0, ownerId: "here:2" }).open(
      run.runId,
    );
    const started = Date.now();
    await watching.waitForRest(700);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await watching.state()).status).toBe("running");
    run.stop();
  });
});

describe("what a person is shown at a gate", () => {
  async function atGate(files: Record<string, string> = {}) {
    const h = host();
    const run = await startRun(h);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    await run.completeStep("write", 1);
    await run.waitForRest(30_000);
    const step = await run.nextStep();
    if (!("waiting" in step)) throw new Error(`expected a gate, got ${JSON.stringify(step)}`);
    return step.waiting;
  }

  test("the engine's own list of what changed since the run began, with the lines", async () => {
    const waiting = await atGate({ "feature.txt": "one\ntwo\nthree\n", "other.txt": "x\n" });
    expect(waiting.reason).toBe("gate");
    expect(waiting.changes).toEqual({ "feature.txt": 3, "other.txt": 1 });
    expect(waiting.tell_the_person).toContain("changes");
  });

  test("a run that changed nothing has no list, rather than an empty one", async () => {
    const waiting = await atGate();
    expect(waiting.changes).toBeUndefined();
  });

  test("the list is the engine's, from the files, not something the agent can word differently", async () => {
    const waiting = await atGate({ "a.txt": "1\n" });
    await writeFile(join(dir, "b.txt"), "2\n3\n"); // changed after the gate was reached
    const run = await host().open((await host().runSummaries())[0]?.meta.runId as string);
    const again = await run?.nextStep();
    if (!again || !("waiting" in again)) throw new Error("expected a gate");
    expect(waiting.changes).toEqual({ "a.txt": 1 });
    expect(again.waiting.changes).toEqual({ "a.txt": 1, "b.txt": 2 });
  });
});

describe("the environment of the commands the engine runs", () => {
  const dump = (file: string) => `node dump-env.js ${file}`;

  test("no KODEL_ switch reaches a command, which is told it is run by the engine and for what", async () => {
    process.env.KODEL_AGENT_TESTS = "1";
    process.env.KODEL_SOME_SWITCH = "on";
    await writeFile(
      join(dir, "dump-env.js"),
      "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.env));\n",
    );
    try {
      const spec = parsePipeline(
        [
          "name: env",
          "nodes:",
          "  - slug: first",
          "    kind: command",
          `    command: ${dump("env-node.json")}`,
          "    checks:",
          `      - { kind: command, command: ${dump("env-check.json")} }`,
          "  - slug: second",
          "    kind: command",
          `    command: node -e "process.exit(0)"`,
          "edges:",
          "  - { from: first, to: second }",
          "  - { from: first, to: second, when: failed }",
          "  - { from: second, to: first, when: failed }",
          "",
        ].join("\n"),
      );
      const { run } = await new LocalHost(spec, { root: dir, heartbeatMs: 0 }).start("t");
      await run.settle();
      expect((await run.state()).status).toBe("completed");
      for (const [file, node] of [
        ["env-node.json", "first"],
        ["env-check.json", "first"],
      ] as const) {
        const env = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, string>;
        const kodel = Object.keys(env).filter((k) => k.startsWith("KODEL_"));
        expect(kodel.sort(), file).toEqual([
          "KODEL_ATTEMPT",
          "KODEL_ENGINE",
          "KODEL_NODE",
          "KODEL_RUN_ID",
        ]);
        expect(env.KODEL_ENGINE).toBe("1");
        expect(env.KODEL_NODE).toBe(node);
        expect(env.KODEL_ATTEMPT).toBe("1");
        expect(env.KODEL_RUN_ID).toBe(run.runId);
        expect(env.PATH, "the rest of the environment is kept").toBe(process.env.PATH);
      }
    } finally {
      delete process.env.KODEL_AGENT_TESTS;
      delete process.env.KODEL_SOME_SWITCH;
    }
  });

  test("engineEnv takes every KODEL_ variable out, and nothing else", () => {
    const env = engineEnv(
      { runId: "r", node: "n", attempt: 2 },
      { PATH: "/bin", HOME: "/h", KODEL_X: "1", KODEL_STATE_DIR: "/s", KODEL: "kept" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      KODEL: "kept",
      KODEL_ENGINE: "1",
      KODEL_RUN_ID: "r",
      KODEL_NODE: "n",
      KODEL_ATTEMPT: "2",
    });
  });

  test("a command run on its own still inherits everything, unless it asks not to", async () => {
    process.env.KODEL_PLAIN_COMMAND = "yes";
    try {
      const inherited = await runCommand(`node -e "console.log(process.env.KODEL_PLAIN_COMMAND)"`, {
        cwd: dir,
      });
      expect(inherited.tail.trim()).toBe("yes");
      const clean = await runCommand(
        `node -e "console.log(process.env.KODEL_PLAIN_COMMAND ?? 'unset')"`,
        { cwd: dir, env: { PATH: process.env.PATH }, inheritEnv: false },
      );
      expect(clean.tail.trim()).toBe("unset");
    } finally {
      delete process.env.KODEL_PLAIN_COMMAND;
    }
  });
});

describe("finishing a step with another outcome, on the real adapters", () => {
  const spec = parsePipeline(
    [
      "name: plan",
      "nodes:",
      "  - slug: plan",
      "    kind: agent",
      "    prompt: plan it",
      "    outcomes: [nothing_to_change]",
      "    checks:",
      `      - { kind: command, command: node check-plan.js }`,
      "  - slug: impl",
      "    kind: agent",
      "    prompt: do it",
      "  - slug: confirm",
      "    kind: human",
      "    prompt: ok to stop here?",
      "edges:",
      "  - { from: plan, to: impl }",
      "  - { from: plan, to: confirm, when: nothing_to_change }",
      "  - { from: confirm, to: plan, when: rejected }",
      "",
    ].join("\n"),
  );
  const options = () => ({ root: dir, heartbeatMs: 0 });

  test("the engine's check runs first, then the outcome decides the way, and it survives a restart", async () => {
    await writeFile(join(dir, "check-plan.js"), "process.exit(0);\n");
    const first = await new LocalHost(spec, options()).start("t");
    await first.run.completeStep("plan", 1, "nothing to do", "nothing_to_change");
    await first.run.settle();

    // a new process picks the run up from the files and finds it waiting for the person
    const run = new LocalHost(spec, options()).open(first.run.runId);
    const step = await run.nextStep();
    expect(step).toMatchObject({ waiting: { reason: "gate", node_slug: "confirm" } });
    const finished = (await new FileStore({ root: join(dir, ".kodel") }).readJournal(run.runId))
      .filter((r) => r.event === "node_finished" && r.node === "plan")
      .map((r) => r.outcome);
    expect(finished).toEqual(["nothing_to_change"]);
    expect((await run.report()).nodes.find((n) => n.node === "plan")?.attempts[0]?.outcome).toBe(
      "nothing_to_change",
    );

    expect((await run.decideHuman("confirm", "approved")).ok).toBe(true);
    expect((await run.state()).status).toBe("completed");
  });

  test("when the engine's check fails, the claim does not stand and the step is done again", async () => {
    await writeFile(
      join(dir, "check-plan.js"),
      "console.log('the plan is empty'); process.exit(1);\n",
    );
    const { run } = await new LocalHost(spec, options()).start("t");
    await run.completeStep("plan", 1, undefined, "nothing_to_change");
    await run.settle();
    const step = await run.nextStep();
    expect(step).toMatchObject({ node: { slug: "plan", attempt: 2 } });
    expect(JSON.stringify(step)).toContain("the plan is empty");
    expect((await run.state()).active.map((v) => v.node)).toEqual(["plan"]);
  });

  test("an outcome the step does not have is refused, and the run goes nowhere because of it", async () => {
    await writeFile(join(dir, "check-plan.js"), "process.exit(0);\n");
    const { run } = await new LocalHost(spec, options()).start("t");
    const before = await run.state();
    const refused = await run.completeStep("plan", 1, undefined, "skip_it_all");
    expect(refused.ok).toBe(false);
    const after = await run.state();
    // what the run is doing is exactly as it was; only the refusal was written down
    expect(after.active).toEqual(before.active);
    expect(after.status).toBe(before.status);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.refusals).toBe(1);
  });
});

describe("what the journal keeps, on the real adapters", () => {
  const journalOf = (runId: string) =>
    new FileStore({ root: join(dir, ".kodel") }).readJournal(runId);
  const named = async (runId: string, event: string) =>
    (await journalOf(runId)).filter((r) => r.event === event);

  const spec = parsePipeline(
    [
      "name: j",
      "nodes:",
      "  - slug: plan",
      "    kind: agent",
      "    prompt: plan it",
      "    checks:",
      "      - { kind: command, command: node check.js }",
      "  - slug: build",
      "    kind: command",
      `    command: node -e "process.exit(0)"`,
      "  - slug: audit",
      "    kind: agent",
      "    prompt: audit it",
      "    checks:",
      "      - kind: result",
      "        columns:",
      "          severity: { enum: [major, minor] }",
      "          location: location",
      "          description: text",
      "        fail_when: { severity: [major] }",
      "edges:",
      "  - { from: plan, to: build }",
      "  - { from: plan, to: build, when: failed }",
      "  - { from: build, to: audit }",
      "  - { from: build, to: plan, when: failed }",
      "",
    ].join("\n"),
  );
  const start = async (check = "process.exit(0);") => {
    await writeFile(join(dir, "check.js"), `${check}\n`);
    return (await new LocalHost(spec, { root: dir, heartbeatMs: 0 }).start("t")).run;
  };

  test("what the agent said goes in with secrets taken out, then the check and the command with their exit codes and times", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const run = await start();
    await run.completeStep("plan", 1, `done; the key I used was ${key}`);
    await run.settle();
    const said = (await named(run.runId, "agent_completed"))[0];
    expect(said).toMatchObject({ node: "plan", attempt: 1, outcome: "passed" });
    expect(String(said?.summary)).toContain("done; the key I used was");
    expect(String(said?.summary)).not.toContain(key);
    const check = (await named(run.runId, "check_finished"))[0];
    expect(check).toMatchObject({ node: "plan", kind: "command", passed: true, exit: 0 });
    expect(typeof check?.duration_ms).toBe("number");
    const command = (await named(run.runId, "command_finished"))[0];
    expect(command).toMatchObject({ node: "build", passed: true, exit: 0 });
    expect(typeof command?.duration_ms).toBe("number");
  });

  test("a failing check says what it exited with and what it printed", async () => {
    const run = await start("console.log('nope, not like this'); process.exit(3);");
    await run.completeStep("plan", 1);
    await run.settle();
    const check = (await named(run.runId, "check_finished"))[0];
    expect(check).toMatchObject({ passed: false, exit: 3 });
    expect(String(check?.reason)).toContain("nope, not like this");
    const report = await run.report();
    expect(report.nodes.find((n) => n.node === "plan")?.attempts[0]?.checks).toMatchObject([
      { kind: "command", passed: false, exit: 3 },
    ]);
  });

  test("an accepted report of findings is journaled", async () => {
    const run = await start();
    await run.completeStep("plan", 1);
    await run.settle();
    const sent = await run.reportResult("audit", 1, {
      completeness: "complete",
      rows: [{ severity: "minor", location: "a.ts:1", description: "nit" }],
    });
    expect(sent.ok).toBe(true);
    expect(await named(run.runId, "report_accepted")).toMatchObject([
      { node: "audit", attempt: 1, completeness: "complete", rows: 1 },
    ]);
  });

  test("calls that were refused are journaled with what was tried and the code", async () => {
    const run = await start();
    await run.completeStep("plan", 9); // a attempt that is not the one it is on
    await run.reportResult("plan", 1, { completeness: "complete", rows: [] }); // a node with no report
    await run.feedback({ node: "ghost", category: "other", message: "hm" });
    const refused = await named(run.runId, "call_refused");
    expect(refused.map((r) => [r.about, r.code])).toEqual([
      ["complete_step", "ATTEMPT_MISMATCH"],
      ["report_result", "PIPELINE_INVALID"],
      ["feedback", "UNKNOWN_NODE"],
    ]);
    expect((await run.report()).refused).toBe(3);
  });

  test("a run that is over is not written to by a refusal, so its seal stays true", async () => {
    const run = await start();
    await run.cancel();
    expect(await run.sealStatus()).toBe("sealed");
    const refused = await run.completeStep("plan", 1);
    expect(refused.ok).toBe(false);
    expect(await named(run.runId, "call_refused")).toEqual([]);
    expect(await run.sealStatus()).toBe("sealed");
  });

  test("when the files were changed behind kodel's back the refusal says so and writes nothing", async () => {
    const run = await start();
    const file = join(runDir(run.runId), "state.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"task": "t"', '"task": "u"'));
    const refused = await run.completeStep("plan", 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(await named(run.runId, "call_refused")).toEqual([]);
  });

  test("a stream of refused calls leaves a journal of bounded size", async () => {
    const run = await start();
    for (let i = 0; i < MAX_LOGGED_REFUSALS + 5; i++) await run.completeStep("plan", 100 + i);
    expect(await named(run.runId, "call_refused")).toHaveLength(MAX_LOGGED_REFUSALS);
    expect((await run.state()).refusals).toBe(MAX_LOGGED_REFUSALS);
    expect((await run.report()).refused).toBe(MAX_LOGGED_REFUSALS);
  });
});

describe("a write never follows a planted link", () => {
  test("a link at the temporary name is replaced, and the file it pointed at is untouched", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), pid: 4242 });
    const id = newRunId();
    await store.createRun({
      v: 2,
      runId: id,
      pipeline: "demo",
      task: "t",
      specHash: "h",
      createdAt: 1,
    }); // the first write, so the next temporary name ends in -2
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "keep me\n");
    await symlink(victim, join(runDir(id), "state.json.tmp-4242-2"));
    await store.writeState(id, {
      v: 1,
      runId: id,
      task: "t",
      specHash: "h",
      status: "running",
      startedAt: 0,
      nodes: {},
      active: [],
      trail: [],
      nextVisitId: 1,
      seq: 0,
    });
    expect(await readFile(victim, "utf8")).toBe("keep me\n");
    expect((await store.readState(id))?.runId).toBe(id);
  });
});

describe("a command that leaves a process behind", () => {
  test("holding the output open does not hold the run", async () => {
    const started = Date.now();
    const result = await runCommand("(sleep 8 &) ; echo done", { cwd: dir });
    expect(result.exit).toBe(0);
    expect(result.tail).toContain("done");
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});

describe("text from outside reaches the state redacted", () => {
  test("a person's reason carrying a secret", async () => {
    const run = await startRun();
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    await run.decideHuman("approve", "rejected", `redo it, the key is ${secret}`);
    const state = await readFile(join(runDir(run.runId), "state.json"), "utf8");
    const journal = await readFile(join(runDir(run.runId), "journal.jsonl"), "utf8");
    expect(state).not.toContain(secret);
    expect(journal).not.toContain(secret);
    expect(state).toContain("redo it");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import {
  FileStore,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
  MemoryIntegrity,
  newRunId,
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

describe("the pipeline a run started with cannot be swapped", () => {
  test("a copy edited after the start is refused, not obeyed", async () => {
    const run = await startRun();
    const path = join(runDir(run.runId), "spec.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("console.log('ok')", "process.exit(0)"));
    await expect(host().open(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });

  test("a copy turned into something that is not a pipeline is refused too", async () => {
    const run = await startRun();
    await writeFile(join(runDir(run.runId), "spec.yaml"), "name: x\nnodes: []\n");
    await expect(host().open(run.runId)).rejects.toMatchObject({
      code: "STATE_MODIFIED_EXTERNALLY",
    });
  });

  test("the check runs on every open, also when this process already has the run", async () => {
    const h = host();
    const run = await startRun(h);
    expect(await h.open(run.runId)).toBeDefined();
    const path = join(runDir(run.runId), "spec.yaml");
    await writeFile(path, `${await readFile(path, "utf8")}\n# changed\n`);
    // a comment does not change the parsed pipeline, so it is still the same pipeline
    expect(await h.open(run.runId)).toBeDefined();
    await writeFile(path, (await readFile(path, "utf8")).replace("write", "wr1te"));
    await expect(h.open(run.runId)).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
  });

  test("a run with no copy is refused once the pipeline file was edited", async () => {
    const run = await startRun();
    await rm(join(runDir(run.runId), "spec.yaml"));
    const file = join(dir, ".kodel", "pipelines", "demo.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("ok?", "fine?"));
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

describe("approving knows what changed since the gate", () => {
  test("nothing, then a file", async () => {
    const run = await startRun();
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    expect(await run.changesSinceGate("approve")).toEqual({});
    await writeFile(join(dir, "later.txt"), "a\nb\n");
    expect(await run.changesSinceGate("approve")).toEqual({ "later.txt": 2 });
    expect(await run.changesSinceGate("write")).toBeUndefined();
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

describe("a write never follows a planted link", () => {
  test("a link at the temporary name is replaced, and the file it pointed at is untouched", async () => {
    const store = new FileStore({ root: join(dir, ".kodel"), pid: 4242 });
    const id = newRunId();
    await store.createRun({
      v: 1,
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

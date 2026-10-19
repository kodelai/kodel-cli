import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import {
  engineEnv,
  FileStore,
  LocalHost,
  LocalPipelineHost,
  type LocalRun,
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

  test("an outcome the step does not have is refused and nothing is written for it", async () => {
    await writeFile(join(dir, "check-plan.js"), "process.exit(0);\n");
    const { run } = await new LocalHost(spec, options()).start("t");
    const before = await readFile(join(runDir(run.runId), "state.json"), "utf8");
    const refused = await run.completeStep("plan", 1, undefined, "skip_it_all");
    expect(refused.ok).toBe(false);
    expect(await readFile(join(runDir(run.runId), "state.json"), "utf8")).toBe(before);
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

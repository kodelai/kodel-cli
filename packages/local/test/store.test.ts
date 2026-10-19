import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRules, type JournalRecord, type RunState } from "@kodel-ai/pipeline-core";
import { FileStore, newRunId, type RunMeta } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = (runId: string, over: Partial<RunMeta> = {}): RunMeta => ({
  v: 1,
  runId,
  pipeline: "feature",
  task: "add a limit",
  specHash: "h",
  createdAt: 1000,
  ...over,
});

const state = (over: Partial<RunState> = {}): RunState => ({
  v: 1,
  runId: "r1",
  task: "add a limit",
  specHash: "h",
  status: "running",
  startedAt: 0,
  nodes: {},
  active: [],
  trail: [],
  nextVisitId: 1,
  seq: 0,
  ...over,
});

const record = (seq: number, extra: Record<string, unknown> = {}): JournalRecord => ({
  v: 1,
  seq,
  ts: seq * 10,
  event: "node_entered",
  ...extra,
});

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("runs and state", () => {
  test("a run can be created, listed and read back", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.createRun(meta("r2", { createdAt: 2000 }));
    expect((await store.listRuns()).map((m) => m.runId)).toEqual(["r1", "r2"]);
    expect(await store.readMeta("r1")).toMatchObject({ pipeline: "feature" });
    expect(await store.readMeta("nope")).toBeUndefined();
  });

  test("a store with no runs lists nothing", async () => {
    expect(await new FileStore({ root: join(dir, "missing") }).listRuns()).toEqual([]);
  });

  test("state is written atomically and read back unchanged", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    const s = state({ seq: 7, trail: ["plan"] });
    await store.writeState("r1", s);
    expect(await store.readState("r1")).toEqual(s);
    const files = await readdir(store.runDir("r1"));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(files).toContain("state.json");
  });

  test("a later write replaces the earlier one", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.writeState("r1", state({ seq: 1 }));
    await store.writeState("r1", state({ seq: 2 }));
    expect((await store.readState("r1"))?.seq).toBe(2);
  });

  test("a state with no file is undefined", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    expect(await store.readState("r1")).toBeUndefined();
  });

  test("a state from a newer kodel is rejected with UNSUPPORTED_FORMAT", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await writeFile(join(store.runDir("r1"), "state.json"), JSON.stringify({ ...state(), v: 99 }));
    await expect(store.readState("r1")).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  test("findActive returns the newest unfinished run of the pipeline and task", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1", { createdAt: 1 }));
    await store.writeState("r1", state({ runId: "r1", status: "completed" }));
    await store.createRun(meta("r2", { createdAt: 2 }));
    await store.writeState("r2", state({ runId: "r2", status: "paused" }));
    await store.createRun(meta("r3", { createdAt: 3, task: "other" }));
    await store.writeState("r3", state({ runId: "r3" }));
    await store.createRun(meta("r4", { createdAt: 4, pipeline: "bugfix" }));
    await store.writeState("r4", state({ runId: "r4" }));
    const found = await store.findActive("feature", "add a limit");
    expect(found?.meta.runId).toBe("r2");
    expect(await store.findActive("feature", "nothing like it")).toBeUndefined();
  });
});

describe("journal", () => {
  test("records are appended in order, one per line", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.appendJournal("r1", [record(1), record(2)]);
    await store.appendJournal("r1", [record(3)]);
    expect((await store.readJournal("r1")).map((r) => r.seq)).toEqual([1, 2, 3]);
    const text = await readFile(join(store.runDir("r1"), "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
  });

  test("an empty journal reads as empty", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    expect(await store.readJournal("r1")).toEqual([]);
    await store.appendJournal("r1", []);
    expect(await store.readJournal("r1")).toEqual([]);
  });

  test("secrets never reach the file", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.appendJournal("r1", [record(1, { reason: `build failed with key ${secret}` })]);
    const text = await readFile(join(store.runDir("r1"), "journal.jsonl"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED:aws-key]");
  });

  test("project redaction rules apply", async () => {
    const store = new FileStore({
      root: dir,
      rules: compileRules([{ name: "ticket", pattern: "ACME-\\d+" }]),
    });
    await store.createRun(meta("r1"));
    await store.appendJournal("r1", [record(1, { note: "see ACME-4242" })]);
    expect(await readFile(join(store.runDir("r1"), "journal.jsonl"), "utf8")).toContain(
      "[REDACTED:ticket]",
    );
  });

  test("a torn last line from a crash is ignored", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.appendJournal("r1", [record(1), record(2)]);
    await writeFile(
      join(store.runDir("r1"), "journal.jsonl"),
      `${JSON.stringify(record(1))}\n${JSON.stringify(record(2))}\n{"v":1,"seq":3,"ev`,
    );
    expect((await store.readJournal("r1")).map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe("meta, snapshots and reports", () => {
  test("the task in the metadata is redacted too", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1", { task: `use ${secret}` }));
    expect((await store.readMeta("r1"))?.task).not.toContain(secret);
  });

  test("snapshots accumulate under their keys", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    expect(await store.readSnapshots("r1")).toEqual({});
    await store.writeSnapshot("r1", "run", "tree-a");
    await store.writeSnapshot("r1", "visit:1", "tree-b");
    expect(await store.readSnapshots("r1")).toEqual({ run: "tree-a", "visit:1": "tree-b" });
  });

  test("reports are stored per node and attempt, redacted", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.writeReport("r1", "review", 2, {
      completeness: "complete",
      rows: [{ description: `leaked ${secret}` }],
    });
    const back = await store.readReport("r1", "review", 2);
    expect(JSON.stringify(back)).not.toContain(secret);
    expect(back?.rows).toHaveLength(1);
    expect(await store.readReport("r1", "review", 1)).toBeUndefined();
  });
});

describe("locking", () => {
  test("critical sections for one run never overlap", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    let inside = 0;
    let overlaps = 0;
    const work = async () => {
      inside += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => store.withLock("r1", work)));
    expect(overlaps).toBe(0);
  });

  test("two stores on the same directory exclude each other", async () => {
    const a = new FileStore({ root: dir });
    const b = new FileStore({ root: dir });
    await a.createRun(meta("r1"));
    let inside = 0;
    let overlaps = 0;
    const work = async () => {
      inside += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside -= 1;
    };
    await Promise.all([
      a.withLock("r1", work),
      b.withLock("r1", work),
      a.withLock("r1", work),
      b.withLock("r1", work),
    ]);
    expect(overlaps).toBe(0);
  });

  test("the lock is released when the work throws", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await expect(
      store.withLock("r1", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await store.withLock("r1", async () => "fine")).toBe("fine");
    expect(await readdir(store.runDir("r1"))).not.toContain("lock");
  });

  test("a lock whose holder died is taken over", async () => {
    const store = new FileStore({ root: dir, isAlive: () => false, lockTimeoutMs: 500 });
    await store.createRun(meta("r1"));
    await writeFile(
      join(store.runDir("r1"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() }),
    );
    expect(await store.withLock("r1", async () => "took over")).toBe("took over");
  });

  test("a lock held by a live process makes the caller wait, then give up", async () => {
    const store = new FileStore({ root: dir, isAlive: () => true, lockTimeoutMs: 120 });
    await store.createRun(meta("r1"));
    await writeFile(
      join(store.runDir("r1"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() }),
    );
    await expect(store.withLock("r1", async () => "never")).rejects.toThrow(
      "timed out waiting for the lock",
    );
  });

  test("a very old lock is taken over even if its holder looks alive", async () => {
    const store = new FileStore({
      root: dir,
      isAlive: () => true,
      staleLockMs: 50,
      lockTimeoutMs: 500,
    });
    await store.createRun(meta("r1"));
    await writeFile(
      join(store.runDir("r1"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() - 1000 }),
    );
    expect(await store.withLock("r1", async () => "ok")).toBe("ok");
  });

  test("different runs do not block each other", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r1"));
    await store.createRun(meta("r2"));
    const order: string[] = [];
    await Promise.all([
      store.withLock("r1", async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push("r1");
      }),
      store.withLock("r2", async () => {
        order.push("r2");
      }),
    ]);
    expect(order).toEqual(["r2", "r1"]);
  });
});

describe("newRunId", () => {
  test("ids sort by time and look the same every time", () => {
    const a = newRunId(1_000, () => 0.5);
    const b = newRunId(2_000, () => 0.5);
    expect(a).toMatch(/^r_[0-9a-z]+_[0-9a-z]{4}$/);
    expect(a < b).toBe(true);
  });
});

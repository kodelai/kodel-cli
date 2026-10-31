import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRules, isRunId, type JournalRecord, type RunState } from "@kodel-ai/pipeline-core";
import { FileStore, newRunId, type RunMeta } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = (runId: string, over: Partial<RunMeta> = {}): RunMeta => ({
  v: 2,
  runId,
  pipeline: "feature",
  task: "add a limit",
  specHash: "h",
  createdAt: 1000,
  ...over,
});

const state = (over: Partial<RunState> = {}): RunState => ({
  v: 2,
  runId: "r_000000001_aaaa",
  task: "add a limit",
  specHash: "h",
  status: "running",
  startedAt: 0,
  nodes: {},
  active: [],
  trail: [],
  pauses: [],
  nextVisitId: 1,
  seq: 0,
  ...over,
});

const record = (seq: number, extra: Record<string, unknown> = {}): JournalRecord => ({
  v: 2,
  seq,
  ts: seq * 10,
  event: "node_entered",
  ...extra,
});

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("runs and state", () => {
  test("a run can be created, listed and read back", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.createRun(meta("r_000000002_aaaa", { createdAt: 2000 }));
    expect((await store.listRuns()).map((m) => m.runId)).toEqual([
      "r_000000001_aaaa",
      "r_000000002_aaaa",
    ]);
    expect(await store.readMeta("r_000000001_aaaa")).toMatchObject({ pipeline: "feature" });
    expect(await store.readMeta("r_000000009_aaaa")).toBeUndefined();
    await expect(store.readMeta("../../etc")).rejects.toMatchObject({ code: "UNKNOWN_RUN" });
  });

  test("a store with no runs lists nothing", async () => {
    expect(await new FileStore({ root: join(dir, "missing") }).listRuns()).toEqual([]);
  });

  test("state is written atomically and read back unchanged", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    const s = state({ seq: 7, trail: ["plan"] });
    await store.writeState("r_000000001_aaaa", s);
    expect(await store.readState("r_000000001_aaaa")).toEqual(s);
    const files = await readdir(store.runDir("r_000000001_aaaa"));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(files).toContain("state.json");
  });

  test("a later write replaces the earlier one", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.writeState("r_000000001_aaaa", state({ seq: 1 }));
    await store.writeState("r_000000001_aaaa", state({ seq: 2 }));
    expect((await store.readState("r_000000001_aaaa"))?.seq).toBe(2);
  });

  test("a state with no file is undefined", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    expect(await store.readState("r_000000001_aaaa")).toBeUndefined();
  });

  test("a state from a newer kodel is rejected with UNSUPPORTED_FORMAT", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await writeFile(
      join(store.runDir("r_000000001_aaaa"), "state.json"),
      JSON.stringify({ ...state(), v: 99 }),
    );
    await expect(store.readState("r_000000001_aaaa")).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  test("findActive returns the newest unfinished run of the pipeline and task", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa", { createdAt: 1 }));
    await store.writeState(
      "r_000000001_aaaa",
      state({ runId: "r_000000001_aaaa", status: "completed" }),
    );
    await store.createRun(meta("r_000000002_aaaa", { createdAt: 2 }));
    await store.writeState(
      "r_000000002_aaaa",
      state({ runId: "r_000000002_aaaa", status: "paused" }),
    );
    await store.createRun(meta("r_000000003_aaaa", { createdAt: 3, task: "other" }));
    await store.writeState("r_000000003_aaaa", state({ runId: "r_000000003_aaaa" }));
    await store.createRun(meta("r_000000004_aaaa", { createdAt: 4, pipeline: "bugfix" }));
    await store.writeState("r_000000004_aaaa", state({ runId: "r_000000004_aaaa" }));
    const found = await store.findActive("feature", "add a limit");
    expect(found?.meta.runId).toBe("r_000000002_aaaa");
    expect(await store.findActive("feature", "nothing like it")).toBeUndefined();
  });
});

describe("journal", () => {
  test("records are appended in order, one per line", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.appendJournal("r_000000001_aaaa", [record(1), record(2)]);
    await store.appendJournal("r_000000001_aaaa", [record(3)]);
    expect((await store.readJournal("r_000000001_aaaa")).map((r) => r.seq)).toEqual([1, 2, 3]);
    const text = await readFile(join(store.runDir("r_000000001_aaaa"), "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
  });

  test("an empty journal reads as empty", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    expect(await store.readJournal("r_000000001_aaaa")).toEqual([]);
    await store.appendJournal("r_000000001_aaaa", []);
    expect(await store.readJournal("r_000000001_aaaa")).toEqual([]);
  });

  test("secrets never reach the file", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.appendJournal("r_000000001_aaaa", [
      record(1, { reason: `build failed with key ${secret}` }),
    ]);
    const text = await readFile(join(store.runDir("r_000000001_aaaa"), "journal.jsonl"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED:aws-key]");
  });

  test("project redaction rules apply", async () => {
    const store = new FileStore({
      root: dir,
      rules: compileRules([{ name: "ticket", pattern: "ACME-\\d+" }]),
    });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.appendJournal("r_000000001_aaaa", [record(1, { note: "see ACME-4242" })]);
    expect(
      await readFile(join(store.runDir("r_000000001_aaaa"), "journal.jsonl"), "utf8"),
    ).toContain("[REDACTED:ticket]");
  });

  test("a torn last line from a crash is ignored", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.appendJournal("r_000000001_aaaa", [record(1), record(2)]);
    await writeFile(
      join(store.runDir("r_000000001_aaaa"), "journal.jsonl"),
      `${JSON.stringify(record(1))}\n${JSON.stringify(record(2))}\n{"v":1,"seq":3,"ev`,
    );
    expect((await store.readJournal("r_000000001_aaaa")).map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe("meta, snapshots and reports", () => {
  test("the task in the metadata is redacted too", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa", { task: `use ${secret}` }));
    expect((await store.readMeta("r_000000001_aaaa"))?.task).not.toContain(secret);
  });

  test("snapshots accumulate under their keys", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    expect(await store.readSnapshots("r_000000001_aaaa")).toEqual({});
    await store.writeSnapshot("r_000000001_aaaa", "run", "tree-a");
    await store.writeSnapshot("r_000000001_aaaa", "visit:1", "tree-b");
    expect(await store.readSnapshots("r_000000001_aaaa")).toEqual({
      run: "tree-a",
      "visit:1": "tree-b",
    });
  });

  test("reports are stored per node and attempt, redacted", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.writeReport("r_000000001_aaaa", "review", 2, {
      completeness: "complete",
      rows: [{ description: `leaked ${secret}` }],
    });
    const back = await store.readReport("r_000000001_aaaa", "review", 2);
    expect(JSON.stringify(back)).not.toContain(secret);
    expect(back?.rows).toHaveLength(1);
    expect(await store.readReport("r_000000001_aaaa", "review", 1)).toBeUndefined();
  });
});

describe("locking", () => {
  test("critical sections for one run never overlap", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    let inside = 0;
    let overlaps = 0;
    const work = async () => {
      inside += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => store.withLock("r_000000001_aaaa", work)));
    expect(overlaps).toBe(0);
  });

  test("two stores on the same directory exclude each other", async () => {
    const a = new FileStore({ root: dir });
    const b = new FileStore({ root: dir });
    await a.createRun(meta("r_000000001_aaaa"));
    let inside = 0;
    let overlaps = 0;
    const work = async () => {
      inside += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside -= 1;
    };
    await Promise.all([
      a.withLock("r_000000001_aaaa", work),
      b.withLock("r_000000001_aaaa", work),
      a.withLock("r_000000001_aaaa", work),
      b.withLock("r_000000001_aaaa", work),
    ]);
    expect(overlaps).toBe(0);
  });

  test("the lock is released when the work throws", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await expect(
      store.withLock("r_000000001_aaaa", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await store.withLock("r_000000001_aaaa", async () => "fine")).toBe("fine");
    expect(await readdir(store.runDir("r_000000001_aaaa"))).not.toContain("lock");
  });

  test("a lock whose holder died is taken over", async () => {
    const store = new FileStore({ root: dir, isAlive: () => false, lockTimeoutMs: 500 });
    await store.createRun(meta("r_000000001_aaaa"));
    await writeFile(
      join(store.runDir("r_000000001_aaaa"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() }),
    );
    expect(await store.withLock("r_000000001_aaaa", async () => "took over")).toBe("took over");
  });

  test("a lock held by a live process makes the caller wait, then give up", async () => {
    const store = new FileStore({ root: dir, isAlive: () => true, lockTimeoutMs: 120 });
    await store.createRun(meta("r_000000001_aaaa"));
    await writeFile(
      join(store.runDir("r_000000001_aaaa"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() }),
    );
    await expect(store.withLock("r_000000001_aaaa", async () => "never")).rejects.toThrow(
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
    await store.createRun(meta("r_000000001_aaaa"));
    await writeFile(
      join(store.runDir("r_000000001_aaaa"), "lock"),
      JSON.stringify({ pid: 424242, since: Date.now() - 1000 }),
    );
    expect(await store.withLock("r_000000001_aaaa", async () => "ok")).toBe("ok");
  });

  test("different runs do not block each other", async () => {
    const store = new FileStore({ root: dir });
    await store.createRun(meta("r_000000001_aaaa"));
    await store.createRun(meta("r_000000002_aaaa"));
    const order: string[] = [];
    await Promise.all([
      store.withLock("r_000000001_aaaa", async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push("r_000000001_aaaa");
      }),
      store.withLock("r_000000002_aaaa", async () => {
        order.push("r_000000002_aaaa");
      }),
    ]);
    expect(order).toEqual(["r_000000002_aaaa", "r_000000001_aaaa"]);
  });
});

describe("newRunId", () => {
  test("ids sort by time and look the same every time", () => {
    const a = newRunId(1_000, () => 0.5);
    const b = newRunId(2_000, () => 0.5);
    expect(a).toMatch(/^r_[0-9a-z]+_[0-9a-z]{4}$/);
    expect(a < b).toBe(true);
  });

  // The shape check lives in pipeline-core and its own test rebuilds the id by hand; this one keeps
  // the two from drifting apart.
  test("every id it makes is accepted by isRunId, at the ends of its range too", () => {
    for (const [now, random] of [
      [0, 0],
      [1_000, 0.5],
      [Date.now(), 0.999999],
      [36 ** 9 - 1, 0],
    ] as const) {
      const id = newRunId(now, () => random);
      expect(isRunId(id), id).toBe(true);
    }
    expect(isRunId(newRunId())).toBe(true);
  });
});

describe("a state that is not an object", () => {
  test("t40_state_json_that_is_not_an_object_reads_as_modified", async () => {
    const store = new FileStore({ root: dir });
    const id = "r_000000001_aaaa";
    await store.createRun(meta(id));
    await store.writeState(id, state());
    const path = join(store.runDir(id), "state.json");
    for (const text of ["null", "42", '"text"', "[1, 2]"]) {
      await writeFile(path, text);
      const error = await store.readStateRaw(id).then(
        () => undefined,
        (e: unknown) => e as { code?: string; message?: string },
      );
      expect(error?.code, text).toBe("STATE_MODIFIED_EXTERNALLY");
      expect(error?.message, text).toContain("not a JSON object");
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { AGENT_LOG_STALE_MS, agentLogOpenFlags, FileStore, type RunMeta } from "../src";

const RUN = "r_000000001_aaaa";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-agent-log-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = (): RunMeta => ({
  v: 2,
  runId: RUN,
  pipeline: "feature",
  task: "t",
  specHash: "h",
  createdAt: 1000,
});

async function newStore(options: Partial<ConstructorParameters<typeof FileStore>[0]> = {}) {
  const store = new FileStore({ root: dir, ...options });
  await store.createRun(meta());
  return store;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const line = (n: number) => `${JSON.stringify({ n, text: "x".repeat(10) })}\n`;

describe("t3bk2 the stored stream of the agent's log", () => {
  test("t3bk2_store_name_guard", async () => {
    const store = await newStore();
    for (const bad of [
      "..",
      "../x",
      "a/b",
      "a\\b",
      "",
      "a\0b",
      "con",
      "NUL",
      "com1.txt",
      "x ".trim() + " ",
      "-leading-dash",
      "a".repeat(129),
    ]) {
      await expect(store.appendAgentLog(RUN, bad, { length: 0 }, line(1))).rejects.toMatchObject({
        code: "INVALID_ARGUMENTS",
      });
    }
    expect(
      (
        await store.appendAgentLog(
          RUN,
          "11111111-1111-4111-8111-111111111111",
          { length: 0 },
          line(1),
        )
      ).ok,
    ).toBe(true);
    expect((await store.appendAgentLog(RUN, "agent-abc123", { length: 0 }, line(1))).ok).toBe(true);
  });

  test("t3bk2_store_append_and_read_back", async () => {
    const store = await newStore();
    const first = await store.appendAgentLog(RUN, "s1", { length: 0 }, line(1) + line(2));
    expect(first).toMatchObject({ ok: true, length: Buffer.byteLength(line(1) + line(2)) });
    if (!first.ok) throw new Error("append failed");
    const second = await store.appendAgentLog(
      RUN,
      "s1",
      { length: first.length, tail_hash: first.tail_hash },
      line(3),
    );
    if (!second.ok) throw new Error("append failed");
    expect(await store.readAgentLog(RUN, "s1", second.length)).toBe(line(1) + line(2) + line(3));
    // the hash is that of the last 64 bytes of the stream
    const all = Buffer.from(line(1) + line(2) + line(3));
    expect(second.tail_hash).toBe(
      createHash("sha256")
        .update(all.subarray(all.length - 64))
        .digest("hex"),
    );
    // a short stream is hashed whole
    const tiny = await store.appendAgentLog(RUN, "s2", { length: 0 }, "ab\n");
    expect(tiny).toMatchObject({ ok: true, tail_hash: sha("ab\n") });
  });

  test("t3bk2_store_truncate_to_journal", async () => {
    const store = await newStore();
    const first = await store.appendAgentLog(RUN, "s1", { length: 0 }, line(1));
    if (!first.ok) throw new Error("append failed");
    // a pass died after appending and before the journal: bytes past the journaled length were never vouched for
    await store.appendAgentLog(
      RUN,
      "s1",
      { length: first.length, tail_hash: first.tail_hash },
      line(2),
    );
    const second = await store.appendAgentLog(
      RUN,
      "s1",
      { length: first.length, tail_hash: first.tail_hash },
      line(3),
    );
    if (!second.ok) throw new Error("append failed");
    expect(await store.readAgentLog(RUN, "s1", 10_000)).toBe(line(1) + line(3));
    // a half line past the journaled length goes the same way
    await writeFile(join(store.runDir(RUN), "agent_log", "s1.jsonl"), line(1) + line(3) + '{"half');
    const third = await store.appendAgentLog(
      RUN,
      "s1",
      { length: second.length, tail_hash: second.tail_hash },
      line(4),
    );
    expect(third.ok).toBe(true);
    expect(await store.readAgentLog(RUN, "s1", 10_000)).toBe(line(1) + line(3) + line(4));
  });

  test("t3bk2_stored_file_shorter_stops", async () => {
    const store = await newStore();
    const first = await store.appendAgentLog(RUN, "s1", { length: 0 }, line(1) + line(2));
    if (!first.ok) throw new Error("append failed");
    const file = join(store.runDir(RUN), "agent_log", "s1.jsonl");
    await truncate(file, first.length - 5);
    // never extended: the gap would be bytes of zeros made up as history
    const result = await store.appendAgentLog(
      RUN,
      "s1",
      { length: first.length, tail_hash: first.tail_hash },
      line(3),
    );
    expect(result).toEqual({ ok: false });
    expect((await stat(file)).size).toBe(first.length - 5);
    // gone altogether is the same
    await rm(file);
    expect(
      await store.appendAgentLog(
        RUN,
        "s1",
        { length: first.length, tail_hash: first.tail_hash },
        line(3),
      ),
    ).toEqual({ ok: false });
  });

  test("t3bk2_tail_hash_mismatch_stops", async () => {
    const store = await newStore();
    const first = await store.appendAgentLog(RUN, "s1", { length: 0 }, line(1) + line(2));
    if (!first.ok) throw new Error("append failed");
    const file = join(store.runDir(RUN), "agent_log", "s1.jsonl");
    // the same length, another end: somebody else's bytes under our cursor
    const text = await readFile(file, "utf8");
    await writeFile(file, `${text.slice(0, -10)}0123456789`);
    expect(
      await store.appendAgentLog(
        RUN,
        "s1",
        { length: first.length, tail_hash: first.tail_hash },
        line(3),
      ),
    ).toEqual({ ok: false });
    expect(await readFile(file, "utf8")).toBe(`${text.slice(0, -10)}0123456789`);
  });

  test("t3bk2_store_redacts_every_line", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const store = await newStore();
    const text = store.agentLogLines([{ kind: "message", text_preview: `use ${key}` }]);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED:");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("t3bk2 the lock on copying the agent's log", () => {
  const lockFile = (store: FileStore) => join(store.runDir(RUN), "agent_log.lock");

  test("t3bk2_lock_is_released_and_is_not_the_run_lock", async () => {
    const store = await newStore();
    await store.withAgentLogLock(RUN, 0, async () => {
      // the run's own lock is free while this one is held
      await store.withLock(RUN, async () => undefined);
    });
    await expect(stat(lockFile(store))).rejects.toThrow();
  });

  test("t3bk2_lock_busy_skips", async () => {
    const store = await newStore({ isAlive: () => true });
    await writeFile(lockFile(store), JSON.stringify({ pid: 1, since: Date.now(), token: "x" }));
    // no wait: a holder that is alive means the pass is skipped, at once
    const started = Date.now();
    const error = await store.withAgentLogLock(RUN, 0, async () => 1).catch((e) => e);
    expect(error).toBeInstanceOf(KodelError);
    expect(error.code).toBe("STATE_LOCKED");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("t3bk2_lock_wait_5s", async () => {
    // a fake clock: the wait is counted in it and nothing sleeps
    let now = 1_000_000;
    const store = await newStore({
      isAlive: () => true,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await writeFile(lockFile(store), JSON.stringify({ pid: 1, since: now, token: "x" }));
    const before = now;
    const error = await store.withAgentLogLock(RUN, 5_000, async () => 1).catch((e) => e);
    expect(error.code).toBe("STATE_LOCKED");
    expect(now - before).toBeGreaterThanOrEqual(5_000);
    expect(now - before).toBeLessThan(5_200);
    // and when the holder lets go within the wait, the pass gets in
    let current = 0;
    const second = await newStore2();
    async function newStore2() {
      const s = new FileStore({
        root: dir,
        isAlive: () => true,
        clock: () => now,
        sleep: async (ms) => {
          now += ms;
          current += ms;
          if (current >= 1_000) await rm(lockFile(s), { force: true });
        },
      });
      return s;
    }
    await writeFile(lockFile(second), JSON.stringify({ pid: 1, since: now, token: "x" }));
    expect(await second.withAgentLogLock(RUN, 5_000, async () => "in")).toBe("in");
  });

  test("t3bk2_lock_stale_takeover", async () => {
    let now = 5_000_000;
    const store = await newStore({ isAlive: () => true, clock: () => now });
    await writeFile(lockFile(store), JSON.stringify({ pid: 1, since: now, token: "old" }));
    now += AGENT_LOG_STALE_MS + 1;
    expect(await store.withAgentLogLock(RUN, 0, async () => "took it")).toBe("took it");
  });

  test("t3bk2_lock_live_holder_kept_within_staleness", async () => {
    // the run's lock is taken over after a minute; this one is held longer and is kept for five
    let now = 9_000_000;
    const store = await newStore({ isAlive: () => true, clock: () => now });
    await writeFile(lockFile(store), JSON.stringify({ pid: 1, since: now, token: "live" }));
    now += 4 * 60_000;
    const error = await store.withAgentLogLock(RUN, 0, async () => 1).catch((e) => e);
    expect(error.code).toBe("STATE_LOCKED");
    expect(await readFile(lockFile(store), "utf8")).toContain("live");
    // the run's own lock, in the same state, would have been taken over
    await writeFile(
      join(store.runDir(RUN), "lock"),
      JSON.stringify({ pid: 1, since: now - 4 * 60_000, token: "live" }),
    );
    expect(await store.withLock(RUN, async () => "run lock taken over")).toBe(
      "run lock taken over",
    );
  });

  test("t3bk2_taken_over_holder_writes_nothing", async () => {
    const now = 20_000_000;
    const store = await newStore({ isAlive: () => false, clock: () => now });
    const first = await store.appendAgentLog(RUN, "s1", { length: 0 }, line(1));
    if (!first.ok) throw new Error("append failed");
    let heldAfterTakeover: boolean | undefined;
    await store.withAgentLogLock(RUN, 0, async (lock) => {
      expect(await lock.stillHeld()).toBe(true);
      // the holder went quiet; another process finds its lock abandoned and takes it
      await writeFile(lockFile(store), JSON.stringify({ pid: 2, since: now, token: "other" }));
      heldAfterTakeover = await lock.stillHeld();
      // what the writer does with that answer: it does not write
      if (await lock.stillHeld()) {
        await store.appendAgentLog(
          RUN,
          "s1",
          { length: first.length, tail_hash: first.tail_hash },
          line(2),
        );
      }
    });
    expect(heldAfterTakeover).toBe(false);
    expect(await store.readAgentLog(RUN, "s1", 10_000)).toBe(line(1));
    // the lock that is somebody else's now is left alone
    expect(await readFile(lockFile(store), "utf8")).toContain("other");
  });
});

describe("t3bk2 how the stored stream is opened", () => {
  test("t3bk2_open_flags_allow_truncating_and_never_append", () => {
    // A handle in append mode has no right to truncate on Windows (EPERM at ftruncate), and the stream is cut to the
    // vouched length before it is extended: neither flag may be an append flag.
    for (const exists of [true, false]) {
      const flags = agentLogOpenFlags(exists);
      expect(flags.startsWith("a")).toBe(false);
      expect(flags.endsWith("+")).toBe(true);
    }
    expect(agentLogOpenFlags(true)).toBe("r+");
    // a file that is not there is made, never replaced
    expect(agentLogOpenFlags(false)).toBe("wx+");
  });

  test("t3bk2_append_to_a_new_and_to_an_existing_stream_cuts_what_was_not_vouched_for", async () => {
    const store = await newStore();
    const first = await store.appendAgentLog(RUN, "s9", { length: 0 }, line(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // a pass that died before it was journaled left bytes past the vouched length: they are cut off, not kept
    const longer = await store.appendAgentLog(
      RUN,
      "s9",
      { length: first.length, tail_hash: first.tail_hash },
      line(2) + line(3),
    );
    expect(longer.ok).toBe(true);
    const again = await store.appendAgentLog(
      RUN,
      "s9",
      { length: first.length, tail_hash: first.tail_hash },
      line(4),
    );
    expect(again.ok).toBe(true);
    expect(await store.readAgentLog(RUN, "s9", 10_000)).toBe(line(1) + line(4));
  });
});

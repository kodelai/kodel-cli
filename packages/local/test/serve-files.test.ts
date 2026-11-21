import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeServeRecord } from "@kodel-ai/pipeline-core/serve";
import {
  acquireServeRecord,
  type ProcessIdentity,
  readServeStatus,
  SERVE_SILENT_MS,
  ServeRecordRefused,
  servePlace,
} from "../src";

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "kodel-serve-files-"));
  root = join(base, "checkout");
  await mkdir(root);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const place = () => servePlace({ base: join(base, "state"), root, uid: 501 });
const T0 = Date.UTC(2026, 10, 21, 9);

/** Processes by pid: alive ones, with the identity they have now. */
function processes(alive: Record<number, ProcessIdentity | undefined>) {
  return (pid: number, identity: ProcessIdentity | undefined): boolean => {
    if (!(pid in alive)) return false;
    const now = alive[pid];
    if (identity === undefined || now === undefined) return true;
    return now.value === identity.value;
  };
}

const id = (value: string): ProcessIdentity => ({ method: "ps-lstart", value });

const refusalOf = async (work: Promise<unknown>): Promise<ServeRecordRefused> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ServeRecordRefused);
    return error as ServeRecordRefused;
  }
  throw new Error("not refused");
};

describe("the record of kodel serve (T-44)", () => {
  test("t44_second_serve_refuses_and_names_the_pid", async () => {
    const isSame = processes({ 4242: id("a"), 5151: id("b") });
    const first = await acquireServeRecord(place(), {
      pid: 4242,
      identity: id("a"),
      now: T0,
      build: "test",
      isSame,
    });
    expect(place().file).toContain(join("state", "serve", "501"));
    const refused = await refusalOf(
      acquireServeRecord(place(), {
        pid: 5151,
        identity: id("b"),
        now: T0 + 1000,
        build: "test",
        isSame,
      }),
    );
    expect(refused.why).toBe("running");
    expect(refused.message).toBe(
      `kodel serve is already running for this project (pid 4242, since ${new Date(T0).toISOString()})`,
    );
    // The first keeps its record; release removes only its own.
    await first.release();
    await expect(readFile(place().file, "utf8")).rejects.toThrow();

    // A record that cannot be read, or that a newer kodel wrote, refuses and names the file.
    await mkdir(dirname(place().file), { recursive: true });
    for (const text of ["{ not json", JSON.stringify({ v: 9, pid: 1 })]) {
      await writeFile(place().file, text);
      const bad = await refusalOf(
        acquireServeRecord(place(), { pid: 5151, now: T0, build: "test", isSame }),
      );
      expect(bad.why).toBe("unreadable");
      expect(bad.message).toContain(place().file);
    }
  });

  test("t44_stale_record_is_taken_over", async () => {
    // A dead holder.
    const gone = await acquireServeRecord(place(), {
      pid: 4242,
      identity: id("a"),
      now: T0,
      build: "test",
      isSame: processes({ 4242: id("a") }),
    });
    const next = await acquireServeRecord(place(), {
      pid: 5151,
      identity: id("b"),
      now: T0 + 1,
      build: "test",
      isSame: processes({ 5151: id("b") }),
    });
    expect(next.current().pid).toBe(5151);
    // The old holder's release does not remove the new record.
    await gone.release();
    const kept = decodeServeRecord(JSON.parse(await readFile(place().file, "utf8")));
    expect(kept.ok && kept.record.pid).toBe(5151);

    // A pid that now names another process (a reboot, a reuse) is not the daemon.
    const reused = await acquireServeRecord(place(), {
      pid: 6161,
      identity: id("c"),
      now: T0 + 2,
      build: "test",
      isSame: processes({ 5151: id("someone else"), 6161: id("c") }),
    });
    expect(reused.current().pid).toBe(6161);
  });

  test("t44_unfinished_record_is_taken_over_only_when_old", async () => {
    const isSame = processes({ 5151: id("b") });
    await mkdir(dirname(place().file), { recursive: true });
    for (const text of ["", '{ "v": 1, "pid": 42'] as const) {
      // Young: its maker may still be writing it; refused, naming the file.
      await writeFile(place().file, text);
      const young = await refusalOf(
        acquireServeRecord(place(), { pid: 5151, now: T0, build: "test", isSame }),
      );
      expect(young.message).toContain(place().file);
      expect(await readFile(place().file, "utf8")).toBe(text);
      // Old: its maker died while making it; taken over.
      const old = new Date(Date.now() - 60_000);
      await utimes(place().file, old, old);
      const taken = await acquireServeRecord(place(), {
        pid: 5151,
        now: T0,
        build: "test",
        isSame,
      });
      expect(taken.current().pid).toBe(5151);
      await taken.release();
    }
  });

  test("t44_write_after_a_takeover_refuses", async () => {
    const first = await acquireServeRecord(place(), {
      pid: 4242,
      identity: id("a"),
      now: T0,
      build: "test",
      isSame: processes({ 4242: id("a") }),
    });
    expect(await first.writeCycle({ state: "active", cycle_at: T0 })).toEqual({ ok: true });
    // Another daemon judged it gone and took the record over.
    const second = await acquireServeRecord(place(), {
      pid: 5151,
      identity: id("b"),
      now: T0 + 1,
      build: "test",
      isSame: processes({ 5151: id("b") }),
    });
    const written = await first.writeCycle({ state: "active", cycle_at: T0 + 2 });
    expect(written.ok).toBe(false);
    const error = written.ok ? undefined : written.error;
    expect(error).toBeInstanceOf(ServeRecordRefused);
    expect((error as ServeRecordRefused).why).toBe("taken_over");
    expect((error as ServeRecordRefused).message).toBe(
      `another kodel serve took over the record ${place().file}`,
    );
    const kept = decodeServeRecord(JSON.parse(await readFile(place().file, "utf8")));
    expect(kept.ok && kept.record.pid).toBe(5151);
    await second.release();
  });

  test("t44_takeover_race_has_one_winner", async () => {
    await acquireServeRecord(place(), {
      pid: 4242,
      identity: id("a"),
      now: T0,
      build: "test",
      isSame: processes({ 4242: id("a") }),
    });
    const isSame = processes({ 5151: id("b"), 6161: id("c") });
    const results = await Promise.allSettled(
      [5151, 6161].map((pid) =>
        acquireServeRecord(place(), {
          pid,
          identity: id(pid === 5151 ? "b" : "c"),
          now: T0 + 1,
          build: "test",
          isSame,
        }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason as ServeRecordRefused;
    expect(reason.why).toBe("running");
    const onDisk = decodeServeRecord(JSON.parse(await readFile(place().file, "utf8")));
    const winner = (won[0] as PromiseFulfilledResult<{ current(): { pid: number } }>).value;
    expect(onDisk.ok && onDisk.record.pid).toBe(winner.current().pid);
  });

  test("t44_serve_status_table", async () => {
    const isSame = processes({ 4242: id("a") });
    expect((await readServeStatus(place(), T0, { isSame })).kind).toBe("off");
    const handle = await acquireServeRecord(place(), {
      pid: 4242,
      identity: id("a"),
      now: T0,
      build: "test",
      isSame,
    });
    // Before its first cycle a daemon is idle.
    expect((await readServeStatus(place(), T0, { isSame })).kind).toBe("idle");
    expect(await handle.writeCycle({ state: "active", cycle_at: T0 + 5_000 })).toEqual({
      ok: true,
    });
    const active = await readServeStatus(place(), T0 + 6_000, { isSame });
    expect(active.kind).toBe("active");
    expect(active.kind === "active" && active.record.pid).toBe(4242);
    await handle.writeCycle({
      state: "idle",
      reason: "serve.enabled is not true",
      cycle_at: T0 + 10_000,
    });
    const idle = await readServeStatus(place(), T0 + 11_000, { isSame });
    expect(idle.kind === "idle" && idle.record.reason).toBe("serve.enabled is not true");
    // No cycle for 2 min: silent.
    expect(
      (await readServeStatus(place(), T0 + 10_000 + SERVE_SILENT_MS + 1, { isSame })).kind,
    ).toBe("silent");
    // The process is gone: off at once.
    expect((await readServeStatus(place(), T0 + 11_000, { isSame: () => false })).kind).toBe("off");
    // Windows: off, nothing read.
    expect((await readServeStatus(place(), T0 + 11_000, { isSame, platform: "win32" })).kind).toBe(
      "off",
    );
    // Unreadable or newer: unknown.
    await writeFile(place().file, JSON.stringify({ v: 2, pid: 4242 }));
    const newer = await readServeStatus(place(), T0, { isSame });
    expect(newer.kind).toBe("unknown");
    expect(newer.kind === "unknown" && newer.why).toContain("upgrade kodel");
    await writeFile(place().file, "nope");
    expect((await readServeStatus(place(), T0, { isSame })).kind).toBe("unknown");
  });
});

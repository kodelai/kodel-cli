/**
 * The record of a running `kodel serve` (TASK-G8KM, T-44): machine-local state with one codec. A
 * known `v` ignores unknown optional fields, a newer `v` says "upgrade kodel", `encode` is strict.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeServeRecord,
  encodeServeRecord,
  SERVE_RECORD_CAPABILITIES,
  SERVE_RECORD_VERSION,
  type ServeRecord,
} from "../src/serve";

const FIXTURES = new URL("../../../fixtures/serve-formats/", import.meta.url).pathname;

const RECORD: ServeRecord = {
  v: 1,
  pid: 4242,
  identity: { method: "ps-lstart", value: "Sat Nov 21 10:00:00 2026" },
  started: 1_763_700_000_000,
  cycle_at: 1_763_700_005_000,
  state: "active",
  root: "/Users/me/code/my-app",
  state_base: "/Users/me/.kodel",
  build: "0.0.0+abc1234",
  counts: { workers: 1, max_workers: 2, runs: 1, max_runs: 4 },
};

describe("t44 the daemon's record", () => {
  test("t44_serve_record_round_trip", () => {
    // round trip
    const text = encodeServeRecord(RECORD);
    const read = decodeServeRecord(JSON.parse(text));
    expect(read).toEqual({ ok: true, record: RECORD });
    if (read.ok) expect(encodeServeRecord(read.record)).toBe(text);
    const idle: ServeRecord = {
      v: 1,
      pid: 7,
      started: 0,
      state: "idle",
      reason: "serve.enabled is not true",
      root: "/r",
      state_base: "/s",
      build: "b",
    };
    expect(decodeServeRecord(JSON.parse(encodeServeRecord(idle)))).toEqual({
      ok: true,
      record: idle,
    });

    // an unknown optional field of a known `v` is ignored, at any level
    const later = {
      ...RECORD,
      host: "laptop",
      counts: { ...RECORD.counts, stalled: 2 },
      identity: { ...RECORD.identity, extra: true },
    };
    expect(decodeServeRecord(later)).toEqual({ ok: true, record: RECORD });
    // an identity of a method this build does not know is dropped
    const strange = decodeServeRecord({ ...RECORD, identity: { method: "wmi", value: "x" } });
    expect(strange.ok && strange.record.identity).toBeUndefined();

    // a newer `v` is refused with "upgrade kodel"; a broken one is "cannot read" and names the field
    const newer = decodeServeRecord({ ...RECORD, v: SERVE_RECORD_VERSION + 1 });
    expect(newer).toMatchObject({ ok: false, code: "NEWER_FORMAT" });
    expect(newer.ok ? "" : newer.why).toContain("upgrade kodel");
    const broken = decodeServeRecord({ ...RECORD, pid: "4242" });
    expect(broken).toMatchObject({ ok: false, code: "CANNOT_READ" });
    expect(broken.ok ? "" : broken.why).toContain("pid");
    expect(decodeServeRecord({ ...RECORD, v: undefined })).toMatchObject({
      ok: false,
      code: "CANNOT_READ",
    });
    expect(decodeServeRecord([])).toMatchObject({ ok: false, code: "CANNOT_READ" });
    const { root: _, ...noRoot } = RECORD;
    expect(decodeServeRecord(noRoot)).toMatchObject({ ok: false, code: "CANNOT_READ" });

    // encode is strict: an unknown or a missing field is refused
    expect(() => encodeServeRecord({ ...RECORD, extra: 1 } as ServeRecord)).toThrow();
    expect(() => encodeServeRecord(noRoot as ServeRecord)).toThrow();

    // every version this build writes or reads has its capabilities and a fixture a real daemon
    // wrote, which reads and writes back as it was
    expect(Object.keys(SERVE_RECORD_CAPABILITIES)).toEqual([String(SERVE_RECORD_VERSION)]);
    expect(existsSync(join(FIXTURES, `v${SERVE_RECORD_VERSION}`))).toBe(true);
    let fixtures = 0;
    for (const dir of readdirSync(FIXTURES, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of readdirSync(join(FIXTURES, dir.name))) {
        if (!file.endsWith(".json")) continue;
        fixtures += 1;
        const raw = JSON.parse(readFileSync(join(FIXTURES, dir.name, file), "utf8")) as unknown;
        const fixture = decodeServeRecord(raw);
        expect(fixture.ok, `${dir.name}/${file}`).toBe(true);
        if (fixture.ok) {
          expect(`v${fixture.record.v}`).toBe(dir.name);
          expect(JSON.parse(encodeServeRecord(fixture.record))).toEqual(raw);
        }
      }
    }
    expect(fixtures).toBeGreaterThan(0);
  });
});

describe("t44 the counts of the daemon's record (T-47)", () => {
  test("t44_record_counts_working_and_alive", () => {
    // `workers` is the places used (the agents that are working); `alive` is the live processes.
    const record: ServeRecord = {
      ...RECORD,
      counts: { workers: 1, alive: 3, max_workers: 2, runs: 3, max_runs: 4 },
    };
    const text = encodeServeRecord(record);
    const read = decodeServeRecord(JSON.parse(text));
    expect(read).toEqual({ ok: true, record });
    if (read.ok) expect(encodeServeRecord(read.record)).toBe(text);
    // The fixture a daemon of this build wrote holds it; the one from before T-47 has none and reads as it was.
    const fixture = (name: string) =>
      decodeServeRecord(JSON.parse(readFileSync(join(FIXTURES, "v1", name), "utf8")));
    const now = fixture("serve-alive.json");
    expect(now.ok && now.record.counts).toEqual({
      workers: 1,
      alive: 2,
      max_workers: 1,
      runs: 2,
      max_runs: 3,
    });
    const before = fixture("serve.json");
    expect(before.ok && before.record.counts).toEqual({
      workers: 0,
      max_workers: 1,
      runs: 0,
      max_runs: 1,
    });
    // An older reader does not know the field: its `decode` drops what it does not know, at any
    // level of a known `v`, and what is left is what it showed before (`workers` of `max_workers`).
    // The same rule, shown on this build with a field it does not know.
    const later = { ...record, counts: { ...record.counts, waiting: 2 } };
    expect(decodeServeRecord(later)).toEqual({ ok: true, record });
    const { alive: _alive, ...older } = record.counts as NonNullable<ServeRecord["counts"]>;
    expect(older).toEqual({ workers: 1, max_workers: 2, runs: 3, max_runs: 4 });
    // No new `v`: the field is optional, and nothing decides by it.
    expect(SERVE_RECORD_VERSION).toBe(1);
    expect(() =>
      encodeServeRecord({
        ...record,
        counts: { ...record.counts, alive: -1 } as NonNullable<ServeRecord["counts"]>,
      }),
    ).toThrow();
  });
});

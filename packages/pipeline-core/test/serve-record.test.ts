/**
 * The record of a running `kodel serve` (TASK-G8KM, T-43): machine-local state with one codec. A
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

describe("t43 the daemon's record", () => {
  test("t43_serve_record_round_trip", () => {
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

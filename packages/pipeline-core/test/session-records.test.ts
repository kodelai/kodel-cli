import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeRecord,
  encodeRecord,
  nameMarkerSchema,
  type RecordKind,
  SESSION_FORMAT_VERSION,
  sessionRecordSchema,
  statusRecordSchema,
  stopRecordSchema,
} from "../src";

const dir = join(import.meta.dir, "../../../fixtures/session-formats/v1");
const kindOf = (file: string): RecordKind => {
  if (file === "session.json") return "session";
  if (file === "stop.json") return "stop";
  if (file === "name.json") return "name";
  if (file.startsWith("status-")) return "status";
  throw new Error(`fixture ${file} has no kind`);
};
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, file), "utf8"));

describe("session record codec (format v1)", () => {
  test("tA_session_fixture_directory_is_complete", () => {
    expect(files.sort()).toEqual([
      "name.json",
      "session.json",
      "status-exited.json",
      "status-killed.json",
      "status-lost.json",
      "status-running.json",
      "stop.json",
    ]);
  });

  for (const file of files) {
    test(`tA_session_fixture_${file}_decodes_and_writes_back_as_read`, () => {
      const raw = load(file);
      const kind = kindOf(file);
      const decoded = decodeRecord(kind, raw);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      const again = JSON.parse(encodeRecord(kind, decoded.record as never));
      expect(again).toEqual(raw);
    });
  }

  test("tA_session_key_tables_are_complete: every field of the model is in some fixture or listed as optional", () => {
    const seen = new Set<string>();
    const walk = (value: unknown, prefix: string) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        seen.add(`${prefix}${key}`);
        walk(inner, `${prefix}${key}.`);
      }
    };
    for (const file of files) walk(load(file), `${kindOf(file)}:`);
    const notInAnyFixture = new Set([
      "session:machine",
      "session:spec.command",
      "session:spec.inheritEnv",
      "session:spec.input",
      "session:spec.timeoutMs",
      "session:spec.mode",
      "session:spec.lifetime",
      "session:spec.origin",
      "session:spec.parent",
      "status:build",
      "status:signal",
      "status:lastOutputAt",
      "stop:identity.boot",
    ]);
    const shape = (schema: { shape: Record<string, unknown> }, kind: string) =>
      Object.keys(schema.shape).map((k) => `${kind}:${k}`);
    const topLevel = [
      ...shape(sessionRecordSchema, "session"),
      ...shape(statusRecordSchema, "status"),
      ...shape(stopRecordSchema, "stop"),
      ...shape(nameMarkerSchema, "name"),
    ];
    for (const key of topLevel) {
      const name = key.replace(/^(\w+):/, "$1:");
      expect(
        seen.has(name) || notInAnyFixture.has(name),
        `${name} is in no fixture and not listed`,
      ).toBe(true);
    }
  });

  test("tA_session_newer_v_is_refused_with_upgrade_code", () => {
    for (const file of files) {
      const raw = { ...load(file), v: SESSION_FORMAT_VERSION + 1 };
      expect(decodeRecord(kindOf(file), raw)).toMatchObject({ ok: false, code: "NEWER_FORMAT" });
    }
  });

  test("tA_session_unreadable_is_cannot_read_and_names_the_field", () => {
    const status = { ...load("status-running.json"), state: "sleeping" };
    const r = decodeRecord("status", status);
    expect(r).toMatchObject({ ok: false, code: "CANNOT_READ" });
    if (!r.ok) expect(r.why).toContain("state");
    expect(decodeRecord("status", null)).toMatchObject({ ok: false, code: "CANNOT_READ" });
    expect(decodeRecord("session", { id: "x" })).toMatchObject({ ok: false, code: "CANNOT_READ" });
  });

  test("tA_session_decode_ignores_an_unknown_optional_field_of_a_known_v", () => {
    const raw = { ...load("status-running.json"), futureField: "x" };
    const r = decodeRecord("status", raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect("futureField" in r.record).toBe(false);
  });

  test("tA_session_encode_refuses_an_unknown_or_missing_field", () => {
    const decoded = decodeRecord("status", load("status-running.json"));
    if (!decoded.ok) throw new Error("fixture");
    expect(() => encodeRecord("status", { ...decoded.record, extra: 1 } as never)).toThrow();
    const { since: _since, ...missing } = decoded.record;
    expect(() => encodeRecord("status", missing as never)).toThrow();
  });
});

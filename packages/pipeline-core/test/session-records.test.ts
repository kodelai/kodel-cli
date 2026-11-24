import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentRecordSchema,
  decodeRecord,
  deriveStatus,
  encodeRecord,
  nameMarkerSchema,
  type RecordKind,
  SESSION_FORMAT_VERSION,
  SESSION_RECORD_CAPABILITIES,
  STOP_BY,
  sessionRecordSchema,
  statusRecordSchema,
  stopAskerOf,
  stopRecordSchema,
} from "../src";

const dir = join(import.meta.dir, "../../../fixtures/session-formats/v1");
const kindOf = (name: string): RecordKind => {
  // the goldens of a terminal session are the same records, taken from its holder
  const file = name.replace("-pty.json", ".json");
  if (file === "session.json") return "session";
  if (file === "stop.json") return "stop";
  if (file === "name.json") return "name";
  if (file.startsWith("agent-")) return "agent";
  if (file.startsWith("status-")) return "status";
  throw new Error(`fixture ${file} has no kind`);
};
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, file), "utf8"));

describe("session record codec (format v1)", () => {
  test("tA_session_fixture_directory_is_complete", () => {
    expect(files.sort()).toEqual([
      "agent-chosen.json",
      "agent-resumed.json",
      "name.json",
      "session-pty.json",
      "session.json",
      "status-exited-pty.json",
      "status-exited.json",
      "status-killed-pty.json",
      "status-killed.json",
      "status-lost.json",
      "status-running-pty.json",
      "status-running.json",
      "status-stopped-pty.json",
      "stop.json",
    ]);
  });

  test("tA_pipes_goldens_byte_identical: taking the goldens of a terminal session left the others as they were", () => {
    const pinned: Record<string, string> = {
      "agent-chosen.json": "ef9050e23423fdb74573f925b45df875a298ec7623793d7253404c488ae605a2",
      "agent-resumed.json": "3ac2a95675ff10090885e674007b2be30d56989ec99304a26fbc80bbd5ffa1b9",
      "name.json": "2441458cc350458109119d2e638c0ac982fb64dbce0f7f6b5e4a4ac33f45b9b0",
      "session.json": "48b370024b29c1510b79a85cc17ba20976945a1f0f07d9692b97ebce5e69cf42",
      "status-exited.json": "cb53c8b844ac8ce1eeccc19884382a3f6175de94639dcb5908abe3e911fec106",
      "status-killed.json": "9ba58aa0c589e5aa5dbd378c6f58f500cafcdb3be4ce8bacc09a3ecdec0bd96a",
      "status-lost.json": "4bcac44e0092a2ecb79a625d9e6ac069f36dc0dd4f374446b243dbf849418052",
      "status-running.json": "dacd64e5591d13885eb991a54315aeb7ce4865880ccf3a0f5997a5a7d30adbe5",
      "stop.json": "525d124846be46113236c65c25e0b79f602bea38ce225a580e9e0d916369cbd3",
    };
    expect(files.filter((f) => !f.includes("-pty")).sort()).toEqual(Object.keys(pinned).sort());
    for (const [file, hash] of Object.entries(pinned)) {
      // a checkout that rewrites line ends would change the bytes, not the golden
      const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(text).digest("hex"), file).toBe(hash);
    }
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
      ...shape(agentRecordSchema, "agent"),
    ];
    for (const key of topLevel) {
      const name = key.replace(/^(\w+):/, "$1:");
      expect(
        seen.has(name) || notInAnyFixture.has(name),
        `${name} is in no fixture and not listed`,
      ).toBe(true);
    }
  });

  test("tA_stop_record_names_who_asked_without_a_new_field", () => {
    // `by` was always a string: a record of kodel's own stop of a finished run is format 1 as it stands.
    const golden = load("stop.json");
    expect(golden.by).toBe(STOP_BY.person);
    for (const asker of ["person", "finish"] as const) {
      const raw = { ...golden, by: STOP_BY[asker] };
      const decoded = decodeRecord("stop", raw);
      expect(decoded.ok, asker).toBe(true);
      if (!decoded.ok) continue;
      expect(stopAskerOf(decoded.record.by), asker).toBe(asker);
      expect(JSON.parse(encodeRecord("stop", decoded.record)), asker).toEqual(raw);
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

  test("tA_session_decode_is_tolerant_inside_nested_objects", () => {
    const raw = load("status-running.json") as {
      holder: { identity: Record<string, unknown> };
      child: Record<string, unknown>;
    };
    raw.holder.identity.futureKey = "x";
    raw.child.futureKey = 1;
    const r = decodeRecord("status", raw);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.record.holder?.identity && "futureKey" in r.record.holder.identity).toBe(false);
    const session = load("session.json") as { spec: Record<string, unknown> };
    session.spec.futureField = true;
    expect(decodeRecord("session", session).ok).toBe(true);
  });

  test("tA_session_unknown_identity_method_is_dropped_not_unreadable", () => {
    const raw = load("status-running.json") as { holder: { identity: { method: string } } };
    raw.holder.identity.method = "windows-creation-time";
    const r = decodeRecord("status", raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.holder?.identity).toBeUndefined();
  });

  test("tA_session_encode_refuses_an_unknown_or_missing_field", () => {
    const decoded = decodeRecord("status", load("status-running.json"));
    if (!decoded.ok) throw new Error("fixture");
    expect(() => encodeRecord("status", { ...decoded.record, extra: 1 } as never)).toThrow();
    const { since: _since, ...missing } = decoded.record;
    expect(() => encodeRecord("status", missing as never)).toThrow();
  });

  test("tA_agent_record_round_trips", () => {
    // The two goldens a real starter wrote, and a record this run never writes: another engine, whose id was
    // read after the start. The schema holds it now so that such an engine needs no change of the format.
    const observed = { v: 1, engine: "codex", session: "thread_0a1b:2", source: "observed" };
    for (const raw of [load("agent-chosen.json"), load("agent-resumed.json"), observed]) {
      const decoded = decodeRecord("agent", raw);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(JSON.parse(encodeRecord("agent", decoded.record))).toEqual(raw);
    }
    expect(load("agent-chosen.json")).toMatchObject({ engine: "claude", source: "chosen" });
    expect(load("agent-resumed.json").resumes).toBe("a_000000000_0000");
    // an engine alone is a record: the id may not be known
    expect(decodeRecord("agent", { v: 1, engine: "claude" }).ok).toBe(true);
    // tolerant on read, strict on write
    const future = decodeRecord("agent", { ...observed, futureField: 1 });
    expect(future.ok && "futureField" in future.record).toBe(false);
    expect(() => encodeRecord("agent", { ...observed, prompt: "do it" } as never)).toThrow();
    expect(() => encodeRecord("agent", { v: 1 } as never)).toThrow();
    for (const bad of [
      { v: 1, engine: "Claude Code" },
      { v: 1, engine: "claude", session: "--resume x" },
      { v: 1, engine: "claude", session: "a b" },
      { v: 1, engine: "claude", session: "id", source: "guessed" },
      { v: 1, engine: "claude", resumes: "../x" },
    ]) {
      expect(decodeRecord("agent", bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: "CANNOT_READ",
      });
    }
    expect(SESSION_RECORD_CAPABILITIES[1].kinds).toContain("agent");
    expect(SESSION_RECORD_CAPABILITIES[1].agent).toBe(true);
  });

  test("tA_agent_record_newer_format_is_refused", () => {
    for (const file of ["agent-chosen.json", "agent-resumed.json"]) {
      const newer = { ...load(file), v: SESSION_FORMAT_VERSION + 1 };
      expect(decodeRecord("agent", newer)).toMatchObject({ ok: false, code: "NEWER_FORMAT" });
    }
  });

  const SOCK = "/masked/run/a_000000000_0000-00000000.sock";
  const at = 1_700_000_100_000;
  /** The status an engine decides from a stored record: the whole decoded record goes in, `sock` with it. */
  const derive = (status: Record<string, unknown>, holderAlive: boolean) => {
    const decoded = decodeRecord("status", status);
    if (!decoded.ok) throw new Error(decoded.why);
    return deriveStatus(
      {
        exists: true,
        session: { v: 1, started: 1_700_000_000_000 },
        status: decoded.record,
        holderAlive,
        childAlive: holderAlive,
        stop: "missing",
      },
      at,
    );
  };
  const statusFiles = files.filter((f) => f.startsWith("status-"));

  test("tA_status_sock_roundtrip", () => {
    const raw = { ...load("status-running.json"), sock: SOCK };
    const decoded = decodeRecord("status", raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.record.sock).toBe(SOCK);
    expect(JSON.parse(encodeRecord("status", decoded.record))).toEqual(raw);
    expect(decodeRecord("status", { ...raw, sock: 7 })).toMatchObject({
      ok: false,
      code: "CANNOT_READ",
    });
    expect(decodeRecord("status", { ...raw, v: SESSION_FORMAT_VERSION + 1 })).toMatchObject({
      ok: false,
      code: "NEWER_FORMAT",
    });
    expect(SESSION_RECORD_CAPABILITIES[1].sock).toBe(true);
    expect(SESSION_RECORD_CAPABILITIES[1].pty).toBe(true);
  });

  test("tA_status_sock_ignored_same_status", () => {
    for (const file of statusFiles) {
      for (const alive of [true, false]) {
        const { sock: _sock, ...without } = { ...load(file), sock: SOCK };
        const withSock = decodeRecord("status", { ...load(file), sock: SOCK });
        // the record that is judged does carry the field: the decision is the same with it and without
        expect(withSock.ok && withSock.record.sock).toBe(SOCK);
        expect("sock" in without).toBe(false);
        expect(derive({ ...load(file), sock: SOCK }, alive)).toEqual(derive(without, alive));
      }
    }
  });

  test("tA_status_sock_dropped_reencode_same_status", () => {
    // An older build: its schema has no `sock`. Its decode drops the field (an unknown field of a known `v` is
    // ignored) and its encode writes the rest. What `attachable` then answers is in the test of this name in
    // `packages/local/test/session-socket.test.ts`.
    const older = statusRecordSchema.omit({ sock: true }).strip();
    for (const file of statusFiles) {
      const stored = { ...load(file), sock: SOCK };
      const read = older.safeParse(stored);
      expect(read.success, file).toBe(true);
      if (!read.success) continue;
      const rewritten = JSON.parse(JSON.stringify(read.data)) as Record<string, unknown>;
      expect("sock" in rewritten, file).toBe(false);
      // nothing but `sock` was lost on the way through the older build
      expect({ ...rewritten, sock: SOCK }).toEqual(stored);
      const again = decodeRecord("status", rewritten);
      expect(again.ok, file).toBe(true);
      expect(again.ok && again.record.sock, file).toBeUndefined();
      for (const alive of [true, false]) {
        expect(derive(rewritten, alive), file).toEqual(derive(stored, alive));
      }
    }
  });

  test("tA_session_key_table_has_sock", () => {
    expect(Object.keys(statusRecordSchema.shape)).toContain("sock");
    expect(Object.keys(sessionRecordSchema.shape.spec.shape)).not.toContain("size");
    const withSize = { ...(load("session.json").spec as object), size: { cols: 80, rows: 24 } };
    const decoded = decodeRecord("session", { ...load("session.json"), spec: withSize });
    expect(decoded.ok && "size" in decoded.record.spec).toBe(false);
    if (!decoded.ok) return;
    expect(() => encodeRecord("session", { ...decoded.record, spec: withSize } as never)).toThrow();
  });

  // The goldens of a terminal session are taken from a real holder: the built artifact under Node, with a PTY.
  const ptyFiles = files.filter((f) => f.includes("-pty"));
  test("tA_pty_fixtures_roundtrip", () => {
    for (const file of ptyFiles) {
      const raw = load(file);
      const decoded = decodeRecord(kindOf(file), raw);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(JSON.parse(encodeRecord(kindOf(file), decoded.record as never))).toEqual(raw);
      if (file !== "status-running-pty.json") expect("sock" in raw).toBe(false);
    }
    expect(ptyFiles.sort()).toEqual([
      "session-pty.json",
      "status-exited-pty.json",
      "status-killed-pty.json",
      "status-running-pty.json",
      "status-stopped-pty.json",
    ]);
    // the mask reaches the socket path: no folder of a person, no uid, no real id or hash
    expect(load("status-running-pty.json").sock).toBe(SOCK);
    // a holder that failed before the child existed names no child and no socket
    expect("child" in load("status-killed-pty.json")).toBe(false);
    expect(load("session-pty.json").spec).not.toHaveProperty("size");
    expect(load("session-pty.json").mode).toBe("pty");
    expect(load("status-killed-pty.json")).toMatchObject({ reason: "holder_error" });
    // a session a person stopped: killed, with the reason, and the child it had
    expect(load("status-stopped-pty.json")).toMatchObject({ state: "killed", reason: "stopped" });
    expect(load("status-stopped-pty.json")).toHaveProperty("child");
  });
});

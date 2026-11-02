/**
 * The stored records of a session, one codec each. `decode` reads what a file holds into the model (a known `v`
 * ignores unknown optional fields, because builds of different age write one directory; a newer `v` is refused);
 * `encode` is an allow-list: it writes every known field of the model or refuses (a strict schema), so nothing
 * is dropped without notice. `SESSION_RECORD_CAPABILITIES` says what a `v` can hold.
 */
import { z } from "zod";
import { SESSION_FORMAT_VERSION } from "../session";

const identity = z
  .object({
    method: z.enum(["proc-ticks", "ps-lstart"]),
    value: z.string(),
    boot: z.string().optional(),
  })
  .strict();

const processRef = z.object({ pid: z.number().int(), identity: identity.optional() }).strict();

const state = z.enum(["starting", "running", "exited", "killed", "lost"]);
const reason = z.enum([
  "stopped",
  "timeout",
  "start_late",
  "rules_unknown",
  "holder_error",
  "no_status",
  "holder_gone",
]);

const specShape = z
  .object({
    command: z.string().optional(),
    argv: z.array(z.string()).optional(),
    cwd: z.string(),
    inheritEnv: z.boolean().optional(),
    input: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    name: z.string().optional(),
    mode: z.enum(["pipes", "pty"]).optional(),
    lifetime: z.enum(["detached", "with-starter"]).optional(),
    origin: z.enum(["cli", "host"]).optional(),
    parent: z.string().optional(),
    envNames: z.array(z.string()),
  })
  .strict();

export const sessionRecordSchema = z
  .object({
    v: z.number().int(),
    id: z.string(),
    name: z.string().optional(),
    mode: z.enum(["pipes", "pty"]),
    spec: specShape,
    started: z.number(),
    root: z.string(),
    machine: z.string().optional(),
  })
  .strict();

export const statusRecordSchema = z
  .object({
    v: z.number().int(),
    state,
    by: z.enum(["holder", "reader"]),
    holder: processRef.optional(),
    child: processRef.optional(),
    exitCode: z.number().optional(),
    signal: z.string().optional(),
    reason: reason.optional(),
    lastOutputAt: z.number().optional(),
    since: z.number(),
    build: z.string().optional(),
  })
  .strict();

export const stopRecordSchema = z
  .object({ v: z.number().int(), by: z.string(), at: z.number(), identity: identity.optional() })
  .strict();

export const nameMarkerSchema = z
  .object({ v: z.number().int(), name: z.string(), id: z.string(), started: z.number() })
  .strict();

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type StatusRecord = z.infer<typeof statusRecordSchema>;
export type StopRecord = z.infer<typeof stopRecordSchema>;
export type NameMarker = z.infer<typeof nameMarkerSchema>;
export type ProcessIdentity = z.infer<typeof identity>;

export type RecordKind = "session" | "status" | "stop" | "name";

const schemas = {
  session: sessionRecordSchema,
  status: statusRecordSchema,
  stop: stopRecordSchema,
  name: nameMarkerSchema,
} as const;

type ModelOf = {
  session: SessionRecord;
  status: StatusRecord;
  stop: StopRecord;
  name: NameMarker;
};

export type DecodeResult<K extends RecordKind> =
  | { ok: true; record: ModelOf[K] }
  | { ok: false; code: "CANNOT_READ" | "NEWER_FORMAT"; why: string };

/** What a stored `v` can hold; a field outside it needs a new `v`. */
export const SESSION_RECORD_CAPABILITIES = {
  1: {
    kinds: ["session", "status", "stop", "name"] as RecordKind[],
    pty: true,
    tombstone: true,
  },
} as const;

export function decodeRecord<K extends RecordKind>(kind: K, raw: unknown): DecodeResult<K> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "CANNOT_READ", why: "not an object" };
  }
  const v = (raw as { v?: unknown }).v;
  if (typeof v !== "number" || !Number.isInteger(v))
    return { ok: false, code: "CANNOT_READ", why: "no v" };
  if (v > SESSION_FORMAT_VERSION) return { ok: false, code: "NEWER_FORMAT", why: `v ${v}` };
  // `encode` is strict. `decode` is tolerant at every level: a key the schema does not know is removed and the
  // read repeated; an identity whose method this build does not know is dropped (no identity: fail closed later).
  const candidate: unknown = structuredClone(raw);
  for (let round = 0; round < 12; round++) {
    const parsed = schemas[kind].safeParse(candidate);
    if (parsed.success) return { ok: true, record: parsed.data as ModelOf[K] };
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        const holder = at(candidate, issue.path);
        if (holder && typeof holder === "object") {
          for (const key of issue.keys) delete (holder as Record<string, unknown>)[key];
          changed = true;
        }
      } else if (
        issue.code === "invalid_enum_value" &&
        issue.path.at(-1) === "method" &&
        issue.path.at(-2) === "identity"
      ) {
        const owner = at(candidate, issue.path.slice(0, -2));
        if (owner && typeof owner === "object") {
          delete (owner as Record<string, unknown>).identity;
          changed = true;
        }
      }
    }
    if (!changed) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        code: "CANNOT_READ",
        why: `${first?.path.join(".") ?? "?"}: ${first?.message ?? "invalid"}`,
      };
    }
  }
  return { ok: false, code: "CANNOT_READ", why: "too many unknown fields" };
}

const at = (root: unknown, path: (string | number)[]): unknown => {
  let cursor = root;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
};

/** The text of a record as it is stored. Refuses a model with an unknown field or a missing one. */
export function encodeRecord<K extends RecordKind>(kind: K, model: ModelOf[K]): string {
  return JSON.stringify(schemas[kind].parse(model));
}

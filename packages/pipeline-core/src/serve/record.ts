/**
 * The record of a running `kodel serve`: `<state base>/serve/<uid>/<checkoutKey>.json` (TASK-G8KM,
 * T-44). Machine-local, not history: it says which process serves a checkout, since when, whether it
 * is active and the counts of its last cycle, so a second daemon refuses and the TUI and `--status`
 * can tell. One codec: `decode` ignores unknown optional fields of a known `v` (builds of different
 * age read one file) and refuses a newer `v`; `encode` is strict and writes every field or refuses.
 */
import { z } from "zod";

export const SERVE_RECORD_VERSION = 1;

const identity = z
  .object({
    method: z.enum(["proc-ticks", "ps-lstart"]),
    value: z.string(),
    boot: z.string().optional(),
  })
  .strict();

const count = z.number().int().nonnegative();

export const serveRecordSchema = z
  .object({
    v: z.number().int().positive(),
    pid: z.number().int().positive(),
    /** The process identity of `pid` (POSIX), so a reused pid is told from the daemon. */
    identity: identity.optional(),
    /** When the daemon started (milliseconds). */
    started: z.number().int().nonnegative(),
    /** When it finished its last cycle (milliseconds); absent before the first. */
    cycle_at: z.number().int().nonnegative().optional(),
    state: z.enum(["active", "idle"]),
    /** Why it is idle. */
    reason: z.string().optional(),
    /** The checkout it serves. */
    root: z.string().min(1),
    state_base: z.string().min(1),
    /** The kodel build it runs. */
    build: z.string(),
    /**
     * `workers`: the worker places used (the agents that are working), what a reader shows beside
     * `max_workers`. `alive`: the live worker processes, those that only wait with the person among
     * them; absent in a record written before T-45, and ignored by a reader from before it.
     */
    counts: z
      .object({
        workers: count,
        alive: count.optional(),
        max_workers: count,
        runs: count,
        max_runs: count,
      })
      .strict()
      .optional(),
  })
  .strict();

export type ServeRecord = z.infer<typeof serveRecordSchema>;

export type ServeRecordDecode =
  | { ok: true; record: ServeRecord }
  | { ok: false; code: "CANNOT_READ" | "NEWER_FORMAT"; why: string };

/** What a stored `v` can hold; a field outside it needs a new `v`. */
export const SERVE_RECORD_CAPABILITIES = {
  1: { counts: true, identity: true },
} as const;

const at = (root: unknown, path: (string | number)[]): unknown => {
  let cursor = root;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
};

/** The record from the parsed file. */
export function decodeServeRecord(raw: unknown): ServeRecordDecode {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "CANNOT_READ", why: "not an object" };
  }
  const v = (raw as { v?: unknown }).v;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    return { ok: false, code: "CANNOT_READ", why: "no v" };
  }
  if (v > SERVE_RECORD_VERSION) {
    return {
      ok: false,
      code: "NEWER_FORMAT",
      why: `v ${v}: written by a newer kodel, upgrade kodel`,
    };
  }
  // Unknown keys are dropped at every level and the read repeated; an identity whose method this
  // build does not know is dropped too (no identity: the process is not trusted to be the daemon).
  const candidate: unknown = structuredClone(raw);
  for (let round = 0; round < 8; round++) {
    const parsed = serveRecordSchema.safeParse(candidate);
    if (parsed.success) return { ok: true, record: parsed.data };
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        const holder = at(candidate, issue.path);
        if (holder !== null && typeof holder === "object") {
          for (const key of issue.keys) delete (holder as Record<string, unknown>)[key];
          changed = true;
        }
      } else if (
        issue.code === "invalid_enum_value" &&
        issue.path.join(".") === "identity.method"
      ) {
        delete (candidate as Record<string, unknown>).identity;
        changed = true;
      }
    }
    if (!changed) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        code: "CANNOT_READ",
        why: `${first?.path.join(".") || "?"}: ${first?.message ?? "invalid"}`,
      };
    }
  }
  return { ok: false, code: "CANNOT_READ", why: "too many unknown fields" };
}

/** The text of the record as it is stored. Throws for a model with an unknown or a missing field. */
export function encodeServeRecord(record: ServeRecord): string {
  return `${JSON.stringify(serveRecordSchema.parse(record), null, 2)}\n`;
}

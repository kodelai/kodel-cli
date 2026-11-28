/**
 * Who started a run, as a kind and never a name or a device: `origin` of `run_started` and `started` of a
 * session record. `by` and `via` are set by the path that made the call (a TUI key, a web route, a
 * manager's server), never by a tool's arguments; the engine sets `forced` from the warnings it was told
 * were overridden. A run that the daemon or `pipeline_start` started has no origin: "not one of these paths".
 */
export const ORIGIN_BY = ["person", "agent"] as const;
export type OriginBy = (typeof ORIGIN_BY)[number];

/** The closed list of paths; a new path (Kodel Server) adds a value with its own change of the formats. */
export const ORIGIN_VIA = ["tui", "web", "cli", "manager"] as const;
export type OriginVia = (typeof ORIGIN_VIA)[number];

/** The warnings of an admission that a start may go ahead of (`force`). */
export const FORCED_WARNINGS = ["full", "blocked", "conflict"] as const;
export type ForcedWarning = (typeof FORCED_WARNINGS)[number];

/** The longest `agent_instruction` kept (the tool takes up to 2000 characters). */
export const AGENT_INSTRUCTION_MAX = 2000;
/** The longest instruction kept with a stop by an agent. */
export const STOP_INSTRUCTION_MAX = 500;

/** The `by` and `via` pair, as a session record keeps it (`started`): no text. */
export interface Started {
  by: OriginBy;
  via: OriginVia;
}

/** `run_started.origin`. */
export interface RunOrigin extends Started {
  /** What the agent says the person told it; only when `by` is `agent`. Redacted before it gets here. */
  agent_instruction?: string;
  /** The warnings the start went ahead of, in the order of `FORCED_WARNINGS`. */
  forced?: ForcedWarning[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the value is a `by`/`via` pair of this build. */
export function isStarted(value: unknown): value is Started {
  return (
    isObject(value) &&
    (ORIGIN_BY as readonly unknown[]).includes(value.by) &&
    (ORIGIN_VIA as readonly unknown[]).includes(value.via)
  );
}

/**
 * The origin to write for what a caller gave: the instruction bounded, `forced` sorted without repeats.
 * `undefined` when the value is not an origin of this build, so a caller's mistake is refused and
 * nothing is made up.
 */
export function normalizeOrigin(value: unknown): RunOrigin | undefined {
  if (!isStarted(value)) return undefined;
  const raw = value as unknown as Record<string, unknown>;
  const { agent_instruction, forced } = raw;
  if (agent_instruction !== undefined && typeof agent_instruction !== "string") return undefined;
  if (forced !== undefined) {
    if (!Array.isArray(forced)) return undefined;
    if (!forced.every((w) => (FORCED_WARNINGS as readonly unknown[]).includes(w))) return undefined;
  }
  const kept = FORCED_WARNINGS.filter((w) => (forced as unknown[] | undefined)?.includes(w));
  return {
    by: value.by,
    via: value.via,
    ...(typeof agent_instruction === "string" && agent_instruction !== ""
      ? { agent_instruction: agent_instruction.slice(0, AGENT_INSTRUCTION_MAX) }
      : {}),
    ...(kept.length > 0 ? { forced: kept } : {}),
  };
}

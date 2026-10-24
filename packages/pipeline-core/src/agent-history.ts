/**
 * What coding agents keep on disk about their sessions, in one format: the `HistoryEvent`, the
 * `AgentHistoryCollector` that reads one agent's files into it, and the version profiles that let a
 * collector read the formats of different agent versions. Pure: the collectors that touch files live in
 * `@kodel-ai/local`.
 *
 * Only normalized events are meant to be stored, never the raw log; every text in an event is a capped
 * preview that has gone through `redact`.
 */
import { z } from "zod";
import { redactDeep, redactText } from "./redact";

/** The version `v` of every `HistoryEvent`. */
export const HISTORY_FORMAT = 1;

export const PREVIEW_CAP = 500;

export const HISTORY_KINDS = [
  "session",
  "message",
  "usage",
  "tool_call",
  "tool_result",
  "subagent",
  "system",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** UTC, always with milliseconds: events of different agents sort as strings. */
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ZONELESS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

const count = z.number().int().nonnegative();
const ts = z.string().regex(TS);

const envelope = {
  v: z.literal(HISTORY_FORMAT),
  agent: z.string().min(1),
  agent_version: z.string(),
  session_id: z.string().min(1),
  parent_session_id: z.string().min(1).optional(),
  seq: z.number().int().positive(),
  ts,
};

export const USAGE_SEMANTICS = ["additive", "overlap"] as const;
export const COST_BASES = ["reported", "reported_zero", "computed", "unknown"] as const;

const sessionEvent = z.object({
  ...envelope,
  kind: z.literal("session"),
  cwd: z.string().optional(),
  git_branch: z.string().optional(),
});

const messageEvent = z.object({
  ...envelope,
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text_preview: z.string(),
  message_id: z.string().optional(),
});

/**
 * `additive`: the four counts are disjoint and are summed as they are. `overlap`: the agent counts
 * cached tokens inside `input`, so a total subtracts them first. `reasoning` is the part of `output` spent
 * on thinking when the agent says so; it is inside `output` already and is not added to it.
 */
const usageEvent = z.object({
  ...envelope,
  kind: z.literal("usage"),
  model: z.string(),
  input: count,
  output: count,
  cache_read: count,
  cache_write: count,
  reasoning: count,
  semantics: z.enum(USAGE_SEMANTICS),
  message_id: z.string(),
  request_id: z.string().optional(),
  cost: z
    .object({ amount: z.number().nonnegative().optional(), basis: z.enum(COST_BASES) })
    .optional(),
});

const toolCallEvent = z.object({
  ...envelope,
  kind: z.literal("tool_call"),
  id: z.string().min(1),
  name: z.string().min(1),
  mcp_server: z.string().optional(),
  input_preview: z.string().optional(),
  started: ts,
});

const toolResultEvent = z.object({
  ...envelope,
  kind: z.literal("tool_result"),
  id: z.string().min(1),
  ok: z.boolean(),
  ended: ts,
  duration_ms: count.optional(),
  size: count.optional(),
  output_preview: z.string().optional(),
});

const subagentEvent = z.object({
  ...envelope,
  kind: z.literal("subagent"),
  agent_id: z.string().min(1),
  child_session_id: z.string().min(1).optional(),
  description_preview: z.string().optional(),
});

const systemEvent = z.object({
  ...envelope,
  kind: z.literal("system"),
  subtype: z.string().min(1),
  detail: z.string().optional(),
});

export const historyEventSchema = z.discriminatedUnion("kind", [
  sessionEvent,
  messageEvent,
  usageEvent,
  toolCallEvent,
  toolResultEvent,
  subagentEvent,
  systemEvent,
]);
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type HistoryEventOf<K extends HistoryKind> = Extract<HistoryEvent, { kind: K }>;

/** An event as a normalizer builds it: the reader adds `v` and `seq`. */
export type DraftEvent = HistoryEvent extends infer E
  ? E extends HistoryEvent
    ? Omit<E, "v" | "seq">
    : never
  : never;

/** Redacted first and cut after: a secret that straddles the cut must not survive as a prefix no rule matches. */
export function previewOf(text: string, cap = PREVIEW_CAP): string {
  const flat = redactText(text.replace(/\s+/g, " ").trim());
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

/** Every string of an event goes through `redact` before it can be stored. */
export function redactEvent<E extends HistoryEvent>(event: E): E {
  return redactDeep(event);
}

/** Epoch milliseconds or an ISO string in, the canonical `ts` out; `undefined` for anything else. */
export function toTs(value: unknown): string | undefined {
  // A time without a zone is UTC, not the zone of the machine that reads it: the same log must give the same events.
  const zoneless = typeof value === "string" ? ZONELESS.exec(value.trim()) : null;
  const source = zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : value;
  const date =
    typeof source === "number" || typeof source === "string"
      ? new Date(source)
      : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString();
  return TS.test(iso) ? iso : undefined;
}

// ── scopes and windows ──────────────────────────────────────────────────────

export interface SessionRef {
  agent: string;
  session_id: string;
  /** The Kodel project the session belongs to: a collector opens nothing that is not of this project. */
  project_root: string;
  /** The log file or database of the session. */
  path: string;
  cwd?: string;
  /** Set on the log of a subagent: the session that started it. */
  parent_session_id?: string;
}

/** `from` and `to` are canonical `ts` values (both inclusive); `seq_from` skips events before it. */
export interface HistoryWindow {
  from?: string;
  to?: string;
  seq_from?: number;
}

export function inWindow(event: Pick<HistoryEvent, "ts" | "seq">, window?: HistoryWindow): boolean {
  if (window === undefined) return true;
  if (window.from !== undefined && event.ts < window.from) return false;
  if (window.to !== undefined && event.ts > window.to) return false;
  if (window.seq_from !== undefined && event.seq < window.seq_from) return false;
  return true;
}

// ── versions ────────────────────────────────────────────────────────────────

export interface AgentVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** `x`, `x.y` and `x.y.z` with an optional prerelease; anything else is `undefined`. */
export function parseAgentVersion(text: string): AgentVersion | undefined {
  const m = VERSION.exec(text.trim());
  if (m === null) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ?? "",
  };
}

/** Negative when `a` is older. A prerelease is older than its release. */
export function compareAgentVersions(a: AgentVersion, b: AgentVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

type Comparator = { op: "<" | "<=" | ">=" | ">"; version: AgentVersion };

/** `*`, or comparators joined by spaces: `<2.0.0`, `>=1.2.0 <2.0.0`. Throws on anything else. */
export function parseAgentRange(text: string): Comparator[] {
  const source = text.trim();
  if (source === "*") return [];
  const comparators: Comparator[] = [];
  for (const part of source.split(/\s+/)) {
    const m = /^(<=|>=|<|>)(.+)$/.exec(part);
    const version = m?.[2] === undefined ? undefined : parseAgentVersion(m[2]);
    if (m === null || version === undefined) {
      throw new Error(`invalid version range "${text}": cannot read "${part}"`);
    }
    comparators.push({ op: m[1] as Comparator["op"], version });
  }
  if (comparators.length === 0) throw new Error("invalid version range: empty");
  return comparators;
}

export function inAgentRange(version: AgentVersion, range: string): boolean {
  return parseAgentRange(range).every(({ op, version: bound }) => {
    const c = compareAgentVersions(version, bound);
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">=" ? c >= 0 : c > 0;
  });
}

/**
 * How an agent version is read: a format profile is one way to normalize the entries of the agent
 * versions in `versions`. A new format of the agent is a new profile (and a fixture), nothing else changes.
 * `Entry`, `State` and `Out` belong to the collector; the core only selects.
 */
export interface FormatProfile<Entry = unknown, State = unknown, Out = unknown> {
  id: string;
  versions: string;
  normalize(entry: Entry, state: State): Out[];
}

export type ProfileMatch = "exact" | "below_known" | "above_known" | "unknown_version";

export interface ProfileChoice<P> {
  profile: P;
  match: ProfileMatch;
}

/** The version a profile starts at: the highest lower bound of its range, `0.0.0` for `*` or `<x`. */
function lowerBound(versions: string): AgentVersion {
  let lowest: AgentVersion = { major: 0, minor: 0, patch: 0, pre: "" };
  for (const c of parseAgentRange(versions)) {
    if ((c.op === ">=" || c.op === ">") && compareAgentVersions(c.version, lowest) > 0)
      lowest = c.version;
  }
  return lowest;
}

/**
 * The profile for an agent version. A version no profile lists gets the newest profile that starts below
 * it (`above_known`), or the oldest profile when it is older than all of them (`below_known`); no readable
 * version gets the newest. A reader never fails on a version it has not seen and never hides that it
 * guessed: the match says so. `profiles` must be in ascending order (`checkProfiles`).
 */
export function selectProfile<P extends Pick<FormatProfile, "versions">>(
  profiles: readonly P[],
  version: string | undefined,
): ProfileChoice<P> {
  const newest = profiles[profiles.length - 1];
  const oldest = profiles[0];
  if (newest === undefined || oldest === undefined) throw new Error("a collector has no profiles");
  const parsed = version === undefined ? undefined : parseAgentVersion(version);
  if (parsed === undefined) return { profile: newest, match: "unknown_version" };
  for (const profile of profiles) {
    if (inAgentRange(parsed, profile.versions)) return { profile, match: "exact" };
  }
  const older = profiles.filter((p) => compareAgentVersions(lowerBound(p.versions), parsed) <= 0);
  const nearest = older[older.length - 1];
  return nearest === undefined
    ? { profile: oldest, match: "below_known" }
    : { profile: nearest, match: "above_known" };
}

/**
 * Problems of a profile list (empty when it is sound): a range that cannot be read, a repeated id, profiles
 * out of ascending order, or two that claim the same version. Gaps are allowed: `selectProfile` covers them.
 */
export function checkProfiles(
  profiles: readonly Pick<FormatProfile, "id" | "versions">[],
): string[] {
  if (profiles.length === 0) return ["no profiles"];
  const problems: string[] = [];
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
    problems.push("duplicate profile id");
  const probes: AgentVersion[] = [];
  let previous: AgentVersion | undefined;
  for (const profile of profiles) {
    try {
      const start = lowerBound(profile.versions);
      if (previous !== undefined && compareAgentVersions(previous, start) >= 0) {
        problems.push(`${profile.id}: profiles are not in ascending order`);
      }
      previous = start;
      for (const c of parseAgentRange(profile.versions)) {
        const v = c.version;
        probes.push(v, { ...v, patch: Math.max(0, v.patch - 1) }, { ...v, patch: v.patch + 1 });
      }
    } catch (error) {
      problems.push(`${profile.id}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) return [...new Set(problems)];
  for (const probe of probes) {
    const hits = profiles.filter((p) => inAgentRange(probe, p.versions));
    if (hits.length > 1) {
      const label = `${probe.major}.${probe.minor}.${probe.patch}`;
      problems.push(`profiles ${hits.map((p) => p.id).join(", ")} overlap at ${label}`);
    }
  }
  return [...new Set(problems)];
}

// ── the collector ───────────────────────────────────────────────────────────

/** What a reader saw, filled while the stream is consumed. */
export interface ReadStats {
  lines: number;
  invalid_lines: number;
  skipped_entries: number;
  /** Entries read by each profile id. */
  profiles: Record<string, number>;
  /** Versions read by a profile that does not list them, with the profile used. */
  drift: { agent_version: string; profile: string; match: Exclude<ProfileMatch, "exact"> }[];
}

export const newReadStats = (): ReadStats => ({
  lines: 0,
  invalid_lines: 0,
  skipped_entries: 0,
  profiles: {},
  drift: [],
});

export interface LocateOptions {
  signal?: AbortSignal;
}

export interface ReadOptions {
  signal?: AbortSignal;
  stats?: ReadStats;
}

export interface AgentHistoryCollector {
  /** The agent id: the key in the registry and `agent` of every event. */
  readonly agent: string;
  /** In ascending order of `versions`; `checkProfiles` must report nothing. */
  readonly profiles: readonly Pick<FormatProfile, "id" | "versions">[];
  /**
   * The sessions of the Kodel project at `projectRoot` (and of its worktrees), parents before their
   * subagents. Never opens the sessions of another project beyond a header check.
   */
  locate(projectRoot: string, options?: LocateOptions): Promise<SessionRef[]>;
  /**
   * The events of one session in order, `seq` from 1 and stable for the same content, `window` applied.
   * Streams: the file is never held whole. A torn last line is not an error. Refuses a `ref` outside the project.
   */
  read(ref: SessionRef, window?: HistoryWindow, options?: ReadOptions): AsyncIterable<HistoryEvent>;
}

export class HistoryCollectorRegistry {
  private readonly collectors = new Map<string, AgentHistoryCollector>();

  register(collector: AgentHistoryCollector): this {
    if (this.collectors.has(collector.agent)) {
      throw new Error(`a history collector for "${collector.agent}" is already registered`);
    }
    this.collectors.set(collector.agent, collector);
    return this;
  }

  get(agent: string): AgentHistoryCollector | undefined {
    return this.collectors.get(agent);
  }

  agents(): string[] {
    return [...this.collectors.keys()];
  }
}

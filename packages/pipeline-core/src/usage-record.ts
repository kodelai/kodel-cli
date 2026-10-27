/**
 * The records of what a run's agent used: tokens per model and an estimated cost, per attempt of an agent node and for
 * the run. Types and schemas only; the maths is in `usage.ts`. A record is a delta, appended by a pass of the host and
 * summed by whoever reads; nothing is rewritten. The state holds numbers, ids and hashes, never text.
 */
import { z } from "zod";

export const USAGE_RECORD_FORMAT = 1;

/** What a model id may look like in a record or a config key: the state is not redacted, so nothing free-form. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

/** A model id that does not look like one (or that does not fit the cap) is counted under this name. */
export const OTHER_MODEL = "other";
export const MAX_MODELS_PER_RECORD = 16;
export const MAX_MODELS_PER_RUN = 64;
/** How many `usage_recorded` events a run journals. */
export const MAX_USAGE_EVENTS = 1_000;
/** How many attempts are told apart in the state; beyond it a record counts only in the run's `unattributed`. */
export const MAX_USAGE_ATTEMPTS = 2_000;

/** Why a pass could not record usage; each is journaled once per run. */
export const USAGE_FAILURES = [
  "session_unknown",
  "log_missing",
  "refused",
  "unreadable",
  "busy",
  "agent_unsupported",
] as const;
export type UsageFailure = (typeof USAGE_FAILURES)[number];

const whole = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usd = z.number().finite().nonnegative();

/** What one model used in a record. `cache_write_1h` is inside `cache_write`. */
export const modelUsageSchema = z
  .object({
    input: whole,
    output: whole,
    cache_read: whole,
    cache_write: whole,
    cache_write_1h: whole,
    api_calls: whole,
    /** Calls whose prompt was over the long-context threshold; their cost may be low. */
    long_context_calls: whole,
    /** Dollars the agent reported, and dollars computed from the table or the override. */
    reported_usd: usd,
    computed_usd: usd,
    /** Calls with no price: the cost of the model is partial. */
    unpriced_calls: whole,
    /** Calls priced from `history.usage.prices` and not from the shipped table. */
    config_priced_calls: whole,
  })
  .strict();
export type ModelUsage = z.infer<typeof modelUsageSchema>;

const modelId = z.string().regex(MODEL_ID);

export const usageDeltaSchema = z
  .object({
    v: z.literal(USAGE_RECORD_FORMAT),
    /** The revision of the price table the cost was computed with. */
    revision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    models: z
      .record(modelId, modelUsageSchema)
      .refine((models) => Object.keys(models).length <= MAX_MODELS_PER_RECORD, {
        message: `at most ${MAX_MODELS_PER_RECORD} models`,
      }),
    /** The last response of the step was still being written and was counted as it stood. */
    last_open: z.literal(true).optional(),
    /** The set that tells repeats apart overflowed; a repeat may have been counted twice. */
    dedupe_overflow: z.literal(true).optional(),
    /** The pass stopped before the end of the log (its time was up): part of what the agent used is not here yet. */
    incomplete: z.literal(true).optional(),
    /** Some of it was used by a subagent of the session, counted under its parent. */
    subagent: z.literal(true).optional(),
  })
  .strict();
export type UsageDelta = z.infer<typeof usageDeltaSchema>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** A response counted while still open: what was counted, so the next pass adds only the rest. */
export const flushedSchema = z
  .object({
    /** Where the response begins in the log, so the next pass reads it whole. */
    offset: whole,
    /** Hash of the response's `message_id` and `request_id`. */
    key: hex64,
    model: modelId,
    input: whole,
    output: whole,
    cache_read: whole,
    cache_write: whole,
    cache_write_1h: whole,
  })
  .strict();
export type FlushedResponse = z.infer<typeof flushedSchema>;

/** Where the credited part of a session ends: `seq` is the same for the same log, so it holds across a restart. */
export const usageCursorSchema = z
  .object({
    last_seq: whole,
    last_key: hex64,
    flushed: flushedSchema.optional(),
    /** The last pass stopped before the end of the log: more is to come. */
    behind: z.literal(true).optional(),
  })
  .strict();
export type UsageCursor = z.infer<typeof usageCursorSchema>;

export interface UsageTotals {
  models: Record<string, ModelUsage>;
  /** Passes that added to these totals. */
  passes: number;
  last_open?: true;
  dedupe_overflow?: true;
  incomplete?: true;
  subagent?: true;
}

export interface UsageState {
  /** Per session: where the credited part ends. */
  sessions: Record<string, UsageCursor>;
  /** Per `node:attempt`: the sum of the deltas credited to it. */
  attempts: Record<string, UsageTotals>;
  /** Use outside every attempt (a gate wait, a pause). */
  unattributed: UsageTotals;
  /** `usage_recorded` events journaled; there is a limit. */
  events: number;
  /** The reasons already journaled as a failure. */
  failed: string[];
  /** The revisions of the price table the deltas were computed with, in order of appearance. */
  revisions: string[];
}

export function newUsageState(): UsageState {
  return {
    sessions: {},
    attempts: {},
    unattributed: { models: {}, passes: 0 },
    events: 0,
    failed: [],
    revisions: [],
  };
}

const MICRO = 1e9;
/** A cost is kept to a billionth of a dollar; sums of rounded costs, so a total is the same however it is added. */
export const roundUsd = (value: number): number => Math.round(value * MICRO) / MICRO;

export function emptyModelUsage(): ModelUsage {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_1h: 0,
    api_calls: 0,
    long_context_calls: 0,
    reported_usd: 0,
    computed_usd: 0,
    unpriced_calls: 0,
    config_priced_calls: 0,
  };
}

/** A model id the state may hold: one that does not look like an id is counted as `other`. */
export const foldModelId = (model: string): string => (MODEL_ID.test(model) ? model : OTHER_MODEL);

export function addModelUsage(into: ModelUsage, add: ModelUsage): void {
  into.input += add.input;
  into.output += add.output;
  into.cache_read += add.cache_read;
  into.cache_write += add.cache_write;
  into.cache_write_1h += add.cache_write_1h;
  into.api_calls += add.api_calls;
  into.long_context_calls += add.long_context_calls;
  into.reported_usd = roundUsd(into.reported_usd + add.reported_usd);
  into.computed_usd = roundUsd(into.computed_usd + add.computed_usd);
  into.unpriced_calls += add.unpriced_calls;
  into.config_priced_calls += add.config_priced_calls;
}

/** The slot of `model` in `models`: its own, or `other` once the record holds as many models as it may. */
export function slot(models: Record<string, ModelUsage>, model: string, max: number): ModelUsage {
  const folded = foldModelId(model);
  let key = folded;
  if (!(key in models) && Object.keys(models).length >= max) key = OTHER_MODEL;
  let entry = models[key];
  if (entry === undefined) {
    entry = emptyModelUsage();
    models[key] = entry;
  }
  return entry;
}

export function newTotals(): UsageTotals {
  return { models: {}, passes: 0 };
}

/**
 * Add a delta to totals. Models beyond the limit of a run are added to `other`, so a hostile log cannot grow the
 * state; the numbers still add up.
 */
export function addDelta(totals: UsageTotals, delta: UsageDelta): void {
  for (const [model, usage] of Object.entries(delta.models)) {
    addModelUsage(slot(totals.models, model, MAX_MODELS_PER_RUN - 1), usage);
  }
  totals.passes += 1;
  if (delta.last_open === true) totals.last_open = true;
  if (delta.dedupe_overflow === true) totals.dedupe_overflow = true;
  if (delta.incomplete === true) totals.incomplete = true;
  if (delta.subagent === true) totals.subagent = true;
}

export interface CostSummary {
  /** Dollars over the calls that have a cost; `null` when none has. */
  usd: number | null;
  basis: "reported" | "computed" | "mixed" | "unknown";
  /** Some calls have no price: `usd` is a part of the cost, never the whole. */
  partial: boolean;
  /** Some calls were priced from the override. */
  config: boolean;
  /** Some calls had a prompt over the long-context threshold. */
  long_context: boolean;
}

export interface TokenSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  api_calls: number;
}

/** Tokens over all models of some totals. */
export function tokensOf(totals: UsageTotals): TokenSummary {
  const sum: TokenSummary = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_1h: 0,
    api_calls: 0,
  };
  for (const usage of Object.values(totals.models)) {
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cache_read += usage.cache_read;
    sum.cache_write += usage.cache_write;
    sum.cache_write_1h += usage.cache_write_1h;
    sum.api_calls += usage.api_calls;
  }
  return sum;
}

/** The cost over all models of some totals. A model with a call that has no price makes the total partial. */
export function summarizeCost(totals: UsageTotals): CostSummary {
  let reported = 0;
  let computed = 0;
  let unpriced = 0;
  let config = 0;
  let longContext = 0;
  let calls = 0;
  for (const usage of Object.values(totals.models)) {
    reported += usage.reported_usd;
    computed += usage.computed_usd;
    unpriced += usage.unpriced_calls;
    config += usage.config_priced_calls;
    longContext += usage.long_context_calls;
    calls += usage.api_calls;
  }
  const known = calls - unpriced > 0;
  const basis =
    reported > 0 && computed > 0
      ? "mixed"
      : reported > 0
        ? "reported"
        : computed > 0 || known
          ? "computed"
          : "unknown";
  return {
    usd: known ? roundUsd(reported + computed) : null,
    basis,
    partial: unpriced > 0,
    config: config > 0,
    long_context: longContext > 0,
  };
}

/** The totals of all attempts and the unattributed use of a run. */
export function runTotals(state: {
  attempts: Record<string, UsageTotals>;
  unattributed: UsageTotals;
}): UsageTotals {
  const total = newTotals();
  for (const part of [...Object.values(state.attempts), state.unattributed]) {
    for (const [model, usage] of Object.entries(part.models)) {
      addModelUsage(slot(total.models, model, MAX_MODELS_PER_RUN - 1), usage);
    }
    total.passes += part.passes;
    if (part.last_open === true) total.last_open = true;
    if (part.dedupe_overflow === true) total.dedupe_overflow = true;
    if (part.incomplete === true) total.incomplete = true;
    if (part.subagent === true) total.subagent = true;
  }
  return total;
}

/**
 * The maths of usage, pure: the cost of one `usage` event, the delta of a group of them, sums of deltas, and the
 * rules that decide which events count (repeats, gate waits). Nothing here reads a file or a clock; the host reads the
 * log and calls this with the events. A cost is an estimate: it is computed with the table of the time of the event,
 * stored with the table's `revision`, and never recomputed.
 */
import type { HistoryEvent } from "./agent-history";
import { type Price, type PricingContext, resolvePrice } from "./price-table";
import {
  addModelUsage,
  MAX_MODELS_PER_RECORD,
  type ModelUsage,
  roundUsd,
  slot,
  USAGE_RECORD_FORMAT,
  type UsageDelta,
} from "./usage-record";

export type UsageEvent = Extract<HistoryEvent, { kind: "usage" }>;

/** A prompt (input and cache) over this many tokens in one request is priced higher by some models; not modelled. */
export const LONG_CONTEXT_TOKENS = 200_000;

/** How many `message_id`s the set of repeats holds before it stops growing and says so. */
export const DEDUPE_CAP = 200_000;

/** What one event's cost is: reported by the agent, computed from a price, or not known. */
export interface EventCost {
  reported_usd: number;
  computed_usd: number;
  /** No price for the model at that time. */
  unpriced: boolean;
  /** The price came from the override. */
  config: boolean;
}

/** The tokens of an event that are billed as input: with `overlap` the cached ones are inside `input` already. */
function billableInput(event: UsageEvent): number {
  return event.semantics === "overlap"
    ? Math.max(0, event.input - event.cache_read - event.cache_write)
    : event.input;
}

/** The part of the cache writes with the 1-hour lifetime, never more than the writes. */
const oneHourOf = (event: UsageEvent): number =>
  Math.min(event.cache_write_1h ?? 0, event.cache_write);

export function isLongContext(event: UsageEvent): boolean {
  return billableInput(event) + event.cache_read + event.cache_write > LONG_CONTEXT_TOKENS;
}

/** Dollars for the tokens of `event` at `price`. `reasoning` is inside `output` and is not added. */
export function priceEvent(event: UsageEvent, price: Price): number {
  const oneHour = oneHourOf(event);
  const fiveMinutes = event.cache_write - oneHour;
  const hourRate = price.cache_write_1h ?? price.input * 2;
  const dollars =
    (billableInput(event) * price.input +
      event.output * price.output +
      event.cache_read * price.cache_read +
      fiveMinutes * price.cache_write +
      oneHour * hourRate) /
    1_000_000;
  return roundUsd(dollars);
}

/**
 * The cost of one event. A cost the agent reported is kept as it is (`reported_zero` is a known zero, not an
 * unknown); otherwise it is computed from the price that holds at the event's time, and with no price it is unknown.
 */
export function costOf(event: UsageEvent, context: PricingContext): EventCost {
  const given = event.cost;
  if (given?.basis === "reported" && given.amount !== undefined) {
    return {
      reported_usd: roundUsd(given.amount),
      computed_usd: 0,
      unpriced: false,
      config: false,
    };
  }
  if (given?.basis === "reported_zero") {
    return { reported_usd: 0, computed_usd: 0, unpriced: false, config: false };
  }
  const resolved = resolvePrice(context, event.model, event.ts);
  if (resolved === undefined) {
    return { reported_usd: 0, computed_usd: 0, unpriced: true, config: false };
  }
  return {
    reported_usd: 0,
    computed_usd: priceEvent(event, resolved.price),
    unpriced: false,
    config: resolved.source === "config",
  };
}

export interface BuildOptions {
  /** The last response of the step was open and is counted as it stood. */
  lastOpen?: boolean;
  /** The set of repeats overflowed while reading. */
  dedupeOverflow?: boolean;
  /** The pass stopped before the end of the log. */
  incomplete?: boolean;
  /** Some events are a subagent's. */
  subagent?: boolean;
}

/** The delta of a group of events. The caller has already left out repeats (`dedupeUsage`). */
export function buildDelta(
  events: readonly UsageEvent[],
  context: PricingContext,
  options: BuildOptions = {},
): UsageDelta {
  const models: Record<string, ModelUsage> = {};
  // `other` takes the last place, so a record never holds more than its limit.
  for (const event of events) {
    const entry = slot(models, event.model, MAX_MODELS_PER_RECORD - 1);
    const cost = costOf(event, context);
    entry.input += billableInput(event);
    entry.output += event.output;
    entry.cache_read += event.cache_read;
    entry.cache_write += event.cache_write;
    entry.cache_write_1h += oneHourOf(event);
    entry.api_calls += 1;
    if (isLongContext(event)) entry.long_context_calls += 1;
    entry.reported_usd = roundUsd(entry.reported_usd + cost.reported_usd);
    entry.computed_usd = roundUsd(entry.computed_usd + cost.computed_usd);
    if (cost.unpriced) entry.unpriced_calls += 1;
    if (cost.config) entry.config_priced_calls += 1;
  }
  return {
    v: USAGE_RECORD_FORMAT,
    revision: context.table.revision,
    models,
    ...(options.lastOpen === true ? { last_open: true as const } : {}),
    ...(options.dedupeOverflow === true ? { dedupe_overflow: true as const } : {}),
    ...(options.incomplete === true ? { incomplete: true as const } : {}),
    ...(options.subagent === true ? { subagent: true as const } : {}),
  };
}

/** Whether a delta counts nothing: no calls and no flag worth a record. */
export function isEmptyDelta(delta: UsageDelta): boolean {
  return (
    Object.keys(delta.models).length === 0 &&
    delta.last_open !== true &&
    delta.dedupe_overflow !== true &&
    delta.incomplete !== true
  );
}

/** The part of a response's tokens that was counted while it was still open (`FlushedResponse`, without the ids). */
export interface CountedTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
}

/**
 * What a response used beyond what was counted when it was still open: `final` with the counted tokens taken off
 * (never below zero). It is one call that was counted already, so the correction adds tokens and cost and no call.
 * `undefined` when nothing is left to add.
 */
export function correctionDelta(
  final: UsageEvent,
  counted: CountedTokens,
  context: PricingContext,
): UsageDelta | undefined {
  const rest: UsageEvent = {
    ...final,
    input: Math.max(0, final.input - counted.input),
    output: Math.max(0, final.output - counted.output),
    cache_read: Math.max(0, final.cache_read - counted.cache_read),
    cache_write: Math.max(0, final.cache_write - counted.cache_write),
    cache_write_1h: Math.max(0, (final.cache_write_1h ?? 0) - counted.cache_write_1h),
    reasoning: 0,
    // A response that was open reported a cost of its own only once it closed.
    ...(final.cost?.basis === "reported" ? { cost: undefined } : {}),
  };
  if (
    rest.input + rest.output + rest.cache_read + rest.cache_write === 0 &&
    final.cost?.basis !== "reported"
  ) {
    return undefined;
  }
  const delta = buildDelta([rest], context);
  for (const entry of Object.values(delta.models)) {
    entry.api_calls = 0;
    entry.long_context_calls = 0;
    entry.unpriced_calls = 0;
    entry.config_priced_calls = 0;
  }
  return delta;
}

/** Add `more` to `delta` (the same revision): used to give a correction and the new events one record. */
export function mergeDeltas(delta: UsageDelta, more: UsageDelta): UsageDelta {
  const models: Record<string, ModelUsage> = {};
  for (const part of [delta, more]) {
    for (const [model, usage] of Object.entries(part.models)) {
      addModelUsage(slot(models, model, MAX_MODELS_PER_RECORD - 1), usage);
    }
  }
  return {
    ...delta,
    models,
    ...(more.last_open === true ? { last_open: true as const } : {}),
    ...(more.dedupe_overflow === true ? { dedupe_overflow: true as const } : {}),
    ...(more.incomplete === true ? { incomplete: true as const } : {}),
    ...(more.subagent === true ? { subagent: true as const } : {}),
  };
}

export interface TimeSpan {
  /** UTC with milliseconds, as an event's `ts`. */
  from: string;
  to: string;
}

/**
 * Events that fall in one of `spans` (a gate wait, a pause) are outside every step: they are not credited to the
 * attempt the pass completes. Order is kept in both parts.
 */
export function splitBySpans(
  events: readonly UsageEvent[],
  spans: readonly TimeSpan[],
): { credited: UsageEvent[]; outside: UsageEvent[] } {
  const credited: UsageEvent[] = [];
  const outside: UsageEvent[] = [];
  for (const event of events) {
    const inside = spans.some((span) => event.ts >= span.from && event.ts <= span.to);
    (inside ? outside : credited).push(event);
  }
  return { credited, outside };
}

/**
 * Leave out an event already counted: the same response read from the main log and from a subagent's, by `message_id`
 * and `request_id`. `seen` is the caller's, kept across streams; once it holds `cap` keys it stops growing and the
 * result says so (`overflow`), because a repeat can then be counted twice.
 */
export function dedupeUsage(
  events: readonly UsageEvent[],
  seen: Set<string>,
  cap = DEDUPE_CAP,
): { fresh: UsageEvent[]; overflow: boolean } {
  const fresh: UsageEvent[] = [];
  let overflow = false;
  for (const event of events) {
    const key = `${event.message_id}\u0000${event.request_id ?? ""}`;
    if (seen.has(key)) continue;
    if (seen.size >= cap) overflow = true;
    else seen.add(key);
    fresh.push(event);
  }
  return { fresh, overflow };
}

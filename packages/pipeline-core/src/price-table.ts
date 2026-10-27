/**
 * What a token costs: the table shipped with the engine (plain data, `price-table.json`) and the override a project
 * may give per model (`history.usage.prices`). Pure: the entry for an event is chosen by the event's own time, never
 * by a clock. A cost computed from this is an estimate and is stored with the table's `revision`.
 */
import { z } from "zod";
import shipped from "./price-table.json";
import { MODEL_ID } from "./usage-record";

export const MAX_PRICE_MODELS = 64;

/** Dollars per million tokens. */
const rate = z.number().finite().nonnegative();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One price of one model; `cache_write_1h` is priced at twice `input` when the table does not say. */
export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h?: number;
  /** A prompt over this many tokens is flagged as long context (`LONG_CONTEXT_TOKENS` when the table does not say). */
  long_context_tokens?: number;
}

/** The override of one model: all four prices (a partial entry is refused), the 1-hour write optional. */
export const priceOverrideSchema = z
  .object({
    input: rate,
    output: rate,
    cache_read: rate,
    cache_write: rate,
    cache_write_1h: rate.optional(),
  })
  .strict();

export const pricesOverrideSchema = z
  .record(z.string().regex(MODEL_ID), priceOverrideSchema)
  .refine((prices) => Object.keys(prices).length <= MAX_PRICE_MODELS, {
    message: `at most ${MAX_PRICE_MODELS} models`,
  });

export type PricesOverride = z.infer<typeof pricesOverrideSchema>;

const entrySchema = z
  .object({
    effectiveFrom: day.optional(),
    input: rate,
    output: rate,
    cache_read: rate,
    cache_write: rate,
    cache_write_1h: rate.optional(),
    long_context_tokens: z.number().int().positive().optional(),
    sourceUrl: z.string().url(),
    checkedAt: day.nullable(),
  })
  .strict();

export const priceTableSchema = z
  .object({
    format: z.literal(1),
    revision: day,
    note: z.string().optional(),
    models: z.record(z.string().regex(MODEL_ID), z.array(entrySchema).min(1)),
  })
  .strict()
  .superRefine((table, ctx) => {
    for (const [model, entries] of Object.entries(table.models)) {
      const from = entries.map((entry) => entry.effectiveFrom ?? "");
      if (new Set(from).size !== from.length) {
        ctx.addIssue({
          code: "custom",
          message: `${model}: two entries with the same effectiveFrom`,
        });
      }
    }
  });

export type PriceTable = z.infer<typeof priceTableSchema>;

export const SHIPPED_PRICES: PriceTable = priceTableSchema.parse(shipped);

export interface PricingContext {
  table: PriceTable;
  override?: PricesOverride;
}

export function defaultPricing(override?: PricesOverride): PricingContext {
  return override === undefined ? { table: SHIPPED_PRICES } : { table: SHIPPED_PRICES, override };
}

export interface ResolvedPrice {
  price: Price;
  source: "shipped" | "config";
  revision: string;
}

/** `-YYYYMMDD` or `-latest`: the only tail a model id may have beyond its table key. */
const DATE_TAIL = /^-(\d{8}|latest)$/;

/** The key of `keys` that names `model`: the exact one first, else the longest one `model` is a dated form of. */
function keyFor(model: string, keys: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (key === model) return key;
    if (model.startsWith(key) && DATE_TAIL.test(model.slice(key.length))) {
      if (best === undefined || key.length > best.length) best = key;
    }
  }
  return best;
}

/** The first moment of the day the event happened on: `2026-10-21T10:00:00.000Z` -> `2026-10-21`. */
const dayOf = (ts: string): string => ts.slice(0, 10);

/**
 * The price that holds for `model` at `ts`, or `undefined` (the cost is then not known, never zero). An override
 * replaces the shipped entry of that model whole, whatever the time. In the table the entry with the latest
 * `effectiveFrom` not after the event's day holds; an entry without a date holds from the beginning.
 */
export function resolvePrice(
  context: PricingContext,
  model: string,
  ts: string,
): ResolvedPrice | undefined {
  const given = context.override;
  if (given !== undefined) {
    const key = keyFor(model, Object.keys(given));
    const entry = key === undefined ? undefined : given[key];
    if (entry !== undefined) {
      return { price: entry, source: "config", revision: context.table.revision };
    }
  }
  const key = keyFor(model, Object.keys(context.table.models));
  const entries = key === undefined ? undefined : context.table.models[key];
  if (entries === undefined) return undefined;
  const today = dayOf(ts);
  let chosen: (typeof entries)[number] | undefined;
  for (const entry of entries) {
    const from = entry.effectiveFrom ?? "";
    if (from > today) continue;
    if (chosen === undefined || from > (chosen.effectiveFrom ?? "")) chosen = entry;
  }
  if (chosen === undefined) return undefined;
  return { price: chosen, source: "shipped", revision: context.table.revision };
}

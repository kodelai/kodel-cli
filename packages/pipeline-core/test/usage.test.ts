import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  addDelta,
  buildDelta,
  correctionDelta,
  costOf,
  DEDUPE_CAP,
  decide,
  dedupeUsage,
  defaultHistory,
  defaultPricing,
  defaultUsage,
  HISTORY_FORMAT,
  isLongContext,
  MAX_MODELS_PER_RECORD,
  MAX_MODELS_PER_RUN,
  MAX_USAGE_ATTEMPTS,
  MAX_USAGE_EVENTS,
  newTotals,
  newUsageState,
  OTHER_MODEL,
  type PriceTable,
  type PricingContext,
  parsePipeline,
  priceEvent,
  pricesOverrideSchema,
  priceTableSchema,
  type RunEvent,
  type RunState,
  resolvePrice,
  roundUsd,
  runTotals,
  SHIPPED_PRICES,
  splitBySpans,
  summarizeCost,
  tokensOf,
  type USAGE_RECORD_FORMAT,
  type UsageDelta,
  type UsageEvent,
} from "../src";

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  v: HISTORY_FORMAT,
  agent: "claude-code",
  agent_version: "2.1.310",
  session_id: "s1",
  seq: 1,
  ts: "2026-10-22T10:00:00.000Z",
  kind: "usage",
  model: "claude-sonnet-5-5",
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  semantics: "additive",
  message_id: "msg_1",
  ...over,
});

const entry = (over: Record<string, unknown> = {}) => ({
  input: 1,
  output: 2,
  cache_read: 0.1,
  cache_write: 1.25,
  sourceUrl: "https://example.test/prices",
  checkedAt: "2026-10-01",
  ...over,
});
const tableOf = (models: Record<string, ReturnType<typeof entry>[]>): PriceTable =>
  priceTableSchema.parse({ format: 1, revision: "2026-10-01", models });

describe("t9jrs the price table and the cost of an event", () => {
  test("t9jrs_the_shipped_table_is_valid_and_dated", () => {
    expect(SHIPPED_PRICES.format).toBe(1);
    expect(SHIPPED_PRICES.revision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(SHIPPED_PRICES.models)).toContain("claude-sonnet-5-5");
  });

  test("t9jrs_price_maths", () => {
    // sonnet 5.5: 2 / 10 / 0.1 / 2.5 / 4 dollars per million tokens
    const e = event({
      input: 1_000,
      output: 500,
      cache_read: 2_000,
      cache_write: 4_000,
      cache_write_1h: 1_000,
    });
    const price = resolvePrice(defaultPricing(), e.model, e.ts)?.price;
    expect(price).toBeDefined();
    // 1000*2 + 500*10 + 2000*0.1 + 3000*2.5 + 1000*4 = 18700 -> 0.0187
    expect(priceEvent(e, price as NonNullable<typeof price>)).toBe(0.0187);
  });

  test("t9jrs_sonnet_5_5_cache_read_matches_usage_comparison", () => {
    // Claude Code's own /usage of the session of 2026-10-28, row claude-sonnet-5-5: 130.7k input, 459.8k output,
    // 183.4m cache read, 2.7m cache write, $31.75. The split of the writes between 5 minutes and 1 hour is not in
    // /usage; the transcripts of the same session had 1.21m of 2.59m written for an hour, and that share is used.
    const writes = 2_700_000;
    const oneHour = Math.round((writes * 1_211_053) / 2_592_263);
    const e = event({
      input: 130_700,
      output: 459_800,
      cache_read: 183_400_000,
      cache_write: writes,
      cache_write_1h: oneHour,
    });
    const price = resolvePrice(defaultPricing(), e.model, e.ts)?.price;
    expect(price).toBeDefined();
    const usd = priceEvent(e, price as NonNullable<typeof price>);
    expect(Math.abs(usd - 31.75) / 31.75).toBeLessThan(0.03);
    // the 0.20 of the skill's cached table would have been far off: the reason the row says 0.10
    const wrong = priceEvent(e, { ...(price as NonNullable<typeof price>), cache_read: 0.2 });
    expect(Math.abs(wrong - 31.75) / 31.75).toBeGreaterThan(0.3);
  });

  test("t9jrs_1h_write_priced_at_its_own_rate", () => {
    const e = event({ cache_write: 1_000_000, cache_write_1h: 1_000_000 });
    const five = event({ cache_write: 1_000_000 });
    const price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, cache_write_1h: 6 };
    expect(priceEvent(e, price)).toBe(6);
    expect(priceEvent(five, price)).toBe(3.75);
    // the table may omit the 1-hour price: twice the input
    expect(priceEvent(e, { ...price, cache_write_1h: undefined })).toBe(6);
    // the 1-hour part is a part of the writes, never more
    expect(priceEvent(event({ cache_write: 10, cache_write_1h: 99 }), price)).toBe(
      priceEvent(event({ cache_write: 10, cache_write_1h: 10 }), price),
    );
  });

  test("t9jrs_reasoning_not_added_to_output", () => {
    const price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
    expect(priceEvent(event({ output: 1_000, reasoning: 800 }), price)).toBe(
      priceEvent(event({ output: 1_000, reasoning: 0 }), price),
    );
  });

  test("t9jrs_overlap_semantics_subtracts_cached", () => {
    const price = { input: 10, output: 0, cache_read: 1, cache_write: 0 };
    // the agent counts the 600 cached tokens inside its 1000 input: 400 are billed as input
    const e = event({ input: 1_000, cache_read: 600, semantics: "overlap" });
    expect(priceEvent(e, price)).toBe(roundUsd((400 * 10 + 600 * 1) / 1_000_000));
    const added = buildDelta([e], defaultPricing());
    expect(added.models["claude-sonnet-5-5"]?.input).toBe(400);
    // more cached than counted does not go below zero
    expect(
      buildDelta([event({ input: 10, cache_read: 600, semantics: "overlap" })], defaultPricing())
        .models["claude-sonnet-5-5"]?.input,
    ).toBe(0);
  });

  test("t9jrs_long_context_flagged_not_modelled", () => {
    const small = event({ input: 100, cache_read: 199_000 });
    const big = event({ input: 100, cache_read: 199_901 });
    expect(isLongContext(small)).toBe(false);
    expect(isLongContext(big)).toBe(true);
    const delta = buildDelta([small, big], defaultPricing());
    expect(delta.models["claude-sonnet-5-5"]?.long_context_calls).toBe(1);
    const totals = newTotals();
    addDelta(totals, delta);
    expect(summarizeCost(totals).long_context).toBe(true);
    // the price is the same flat one: the flag only says the cost may be low
    expect(costOf(big, defaultPricing()).computed_usd).toBeGreaterThan(0);
  });

  test("t9jrs_long_context_threshold_is_the_models_own", () => {
    const over100k = { input: 100, cache_read: 100_001 };
    const over200k = { input: 100, cache_read: 200_001 };
    // haiku 5.5 steps at 100K prompt tokens, the others at 200K
    const haiku = (over: Partial<UsageEvent>) => event({ model: "claude-haiku-5-5", ...over });
    const sonnet = (over: Partial<UsageEvent>) => event({ model: "claude-sonnet-5-5", ...over });
    const calls = (events: UsageEvent[], model: string) =>
      buildDelta(events, defaultPricing()).models[model]?.long_context_calls;
    expect(SHIPPED_PRICES.models["claude-haiku-5-5"]?.[0]?.long_context_tokens).toBe(100_000);
    expect(calls([haiku({ input: 100, cache_read: 99_899 })], "claude-haiku-5-5")).toBe(0);
    expect(calls([haiku(over100k)], "claude-haiku-5-5")).toBe(1);
    expect(calls([sonnet(over100k)], "claude-sonnet-5-5")).toBe(0);
    expect(calls([sonnet({ input: 100, cache_read: 199_900 })], "claude-sonnet-5-5")).toBe(0);
    expect(calls([sonnet(over200k)], "claude-sonnet-5-5")).toBe(1);
    // a model with no price has no threshold of its own: the default one
    expect(calls([event({ model: "claude-future-9", ...over100k })], "claude-future-9")).toBe(0);
    expect(calls([event({ model: "claude-future-9", ...over200k })], "claude-future-9")).toBe(1);
  });

  test("t9jrs_every_model_of_the_current_generations_is_priced_and_none_shadows_another", () => {
    const at = "2026-10-28T00:00:00.000Z";
    const input = (model: string) => resolvePrice(defaultPricing(), model, at)?.price.input;
    for (const [model, price] of [
      ["claude-opus-5", 5],
      ["claude-opus-5-5", 4],
      ["claude-opus-4-8", 5],
      ["claude-opus-4-7", 5],
      ["claude-opus-4-6", 5],
      ["claude-opus-4-5", 5],
      ["claude-sonnet-5", 2],
      ["claude-sonnet-5-5", 2],
      ["claude-sonnet-4-6", 3],
      ["claude-sonnet-4-5", 3],
      ["claude-haiku-5-5", 0.1],
      ["claude-haiku-4-5", 1],
      ["claude-fable-5", 10],
      ["claude-fable-5-1", 10],
    ] as const) {
      expect(input(model)).toBe(price);
      // a dated form resolves to the same row
      expect(input(`${model}-20261001`)).toBe(price);
    }
    // `claude-opus-5` is not a dated form of `claude-opus-5-5` (and the other way round): each keeps its own price
    expect(input("claude-opus-5-5")).not.toBe(input("claude-opus-5"));
    expect(resolvePrice(defaultPricing(), "claude-opus-5-6", at)).toBeUndefined();
    // a 1h write is twice the input for the whole generation, a 5m write 1.25 times
    for (const row of Object.values(SHIPPED_PRICES.models)) {
      const price = row[0];
      if (price === undefined) continue;
      expect(price.cache_write).toBeCloseTo(price.input * 1.25, 6);
      expect(price.cache_write_1h).toBeCloseTo(price.input * 2, 6);
    }
  });

  test("t9jrs_override_keeps_the_shipped_long_context_threshold_unless_it_gives_its_own", () => {
    const at = "2026-10-28T00:00:00.000Z";
    const prices = { input: 1, output: 1, cache_read: 1, cache_write: 1 };
    const inherits = defaultPricing(pricesOverrideSchema.parse({ "claude-haiku-5-5": prices }));
    const resolved = resolvePrice(inherits, "claude-haiku-5-5", at);
    expect(resolved?.source).toBe("config");
    expect(resolved?.price.long_context_tokens).toBe(100_000);
    // a model with no threshold in the table has none from the override either (the default one applies)
    const plain = defaultPricing(pricesOverrideSchema.parse({ "claude-sonnet-5-5": prices }));
    expect(resolvePrice(plain, "claude-sonnet-5-5", at)?.price.long_context_tokens).toBeUndefined();
    // its own threshold wins; a bad one is refused
    const own = defaultPricing(
      pricesOverrideSchema.parse({
        "claude-haiku-5-5": { ...prices, long_context_tokens: 50_000 },
      }),
    );
    expect(resolvePrice(own, "claude-haiku-5-5", at)?.price.long_context_tokens).toBe(50_000);
    expect(
      pricesOverrideSchema.safeParse({ "claude-haiku-5-5": { ...prices, long_context_tokens: 0 } })
        .success,
    ).toBe(false);
    expect(
      pricesOverrideSchema.safeParse({
        "claude-haiku-5-5": { ...prices, long_context_tokens: 1.5 },
      }).success,
    ).toBe(false);
  });

  test("t9jrs_model_line_made_of_a_correction_has_its_cost", () => {
    // the correction of a response counted while it was open adds dollars and no call (`correctionDelta`):
    // a model line made of one only must not read as an unknown cost, and must agree with the total
    const rest = correctionDelta(
      event({ input: 1_000_000, output: 0 }),
      { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 },
      defaultPricing(),
    );
    expect(rest).toBeDefined();
    const line = newTotals();
    addDelta(line, rest as UsageDelta);
    const model = line.models["claude-sonnet-5-5"];
    expect(model?.api_calls).toBe(0);
    expect(model?.computed_usd).toBe(2);
    expect(summarizeCost(line)).toMatchObject({ usd: 2, basis: "computed", partial: false });
  });

  test("t9jrs_rounding_pinned", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(1.0000000004)).toBe(1);
    expect(roundUsd(0.0000000006)).toBe(0.000000001);
    // sums of rounded costs: the same total however the events are grouped
    const events = Array.from({ length: 50 }, (_, i) =>
      event({ message_id: `m${i}`, input: 7, output: 3 }),
    );
    const once = newTotals();
    addDelta(once, buildDelta(events, defaultPricing()));
    const parts = newTotals();
    for (let i = 0; i < events.length; i += 7) {
      addDelta(parts, buildDelta(events.slice(i, i + 7), defaultPricing()));
    }
    expect(summarizeCost(parts).usd).toBe(summarizeCost(once).usd);
    expect(tokensOf(parts)).toEqual(tokensOf(once));
  });

  test("t9jrs_model_matching", () => {
    const table = tableOf({
      "claude-3": [entry({ input: 1 })],
      "claude-3-5": [entry({ input: 2 })],
    });
    const price = (model: string) => resolvePrice({ table }, model, "2026-10-22T00:00:00.000Z");
    expect(price("claude-3")?.price.input).toBe(1);
    // a date suffix is cut
    expect(price("claude-3-20250101")?.price.input).toBe(1);
    expect(price("claude-3-5-20250101")?.price.input).toBe(2);
    expect(price("claude-3-5-latest")?.price.input).toBe(2);
    // `claude-3-5` is not a dated form of `claude-3`: with no row of its own it has no price
    const only = { table: tableOf({ "claude-3": [entry()] }) };
    expect(resolvePrice(only, "claude-3-5", "2026-10-22T00:00:00.000Z")).toBeUndefined();
    expect(resolvePrice(only, "claude-3-5-sonnet", "2026-10-22T00:00:00.000Z")).toBeUndefined();
    // exact beats a dated form
    const both = tableOf({
      "claude-3": [entry({ input: 1 })],
      "claude-3-20250101": [entry({ input: 9 })],
    });
    expect(
      resolvePrice({ table: both }, "claude-3-20250101", "2026-10-22T00:00:00.000Z")?.price.input,
    ).toBe(9);
  });

  test("t9jrs_effective_from_before_of_after_none_and_duplicates", () => {
    const table = tableOf({
      m: [entry({ input: 1 }), entry({ input: 2, effectiveFrom: "2026-10-10" })],
    });
    const at = (ts: string) => resolvePrice({ table }, "m", ts)?.price.input;
    expect(at("2026-10-09T23:59:59.999Z")).toBe(1);
    expect(at("2026-10-10T00:00:00.000Z")).toBe(2);
    expect(at("2026-12-01T00:00:00.000Z")).toBe(2);
    // every entry dated in the future: no price
    const later = tableOf({ m: [entry({ effectiveFrom: "2027-01-01" })] });
    expect(resolvePrice({ table: later }, "m", "2026-10-22T00:00:00.000Z")).toBeUndefined();
    // two entries from the same day are a mistake in the table
    expect(
      priceTableSchema.safeParse({
        format: 1,
        revision: "2026-10-01",
        models: {
          m: [entry({ effectiveFrom: "2026-10-10" }), entry({ effectiveFrom: "2026-10-10" })],
        },
      }).success,
    ).toBe(false);
  });

  test("t9jrs_unknown_model_keeps_tokens_cost_null_partial", () => {
    const delta = buildDelta(
      [event({ model: "claude-future-9", input: 5, output: 7 })],
      defaultPricing(),
    );
    expect(delta.models["claude-future-9"]).toMatchObject({
      input: 5,
      output: 7,
      api_calls: 1,
      unpriced_calls: 1,
      computed_usd: 0,
    });
    const totals = newTotals();
    addDelta(totals, delta);
    // not `$0`: no cost at all, and partial
    expect(summarizeCost(totals)).toMatchObject({ usd: null, partial: true, basis: "unknown" });
    // a known model beside it: the cost is a part, and says so
    addDelta(totals, buildDelta([event({ input: 1_000_000 })], defaultPricing()));
    expect(summarizeCost(totals)).toMatchObject({ usd: 2, partial: true, basis: "computed" });
  });

  test("t9jrs_reported_zero_is_not_unknown", () => {
    const free = costOf(
      event({ model: "claude-future-9", cost: { basis: "reported_zero" } }),
      defaultPricing(),
    );
    expect(free).toEqual({ reported_usd: 0, computed_usd: 0, unpriced: false, config: false });
    const reported = costOf(
      event({ model: "claude-future-9", cost: { basis: "reported", amount: 0.5 } }),
      defaultPricing(),
    );
    expect(reported).toMatchObject({ reported_usd: 0.5, unpriced: false });
    const totals = newTotals();
    addDelta(
      totals,
      buildDelta(
        [event({ model: "x", cost: { basis: "reported", amount: 0.5 } })],
        defaultPricing(),
      ),
    );
    expect(summarizeCost(totals)).toMatchObject({ usd: 0.5, basis: "reported", partial: false });
  });

  test("t9jrs_override_per_model_source_config", () => {
    const override = {
      "claude-sonnet-5-5": { input: 1, output: 1, cache_read: 1, cache_write: 1 },
    };
    const context = defaultPricing(pricesOverrideSchema.parse(override));
    const resolved = resolvePrice(
      context,
      "claude-sonnet-5-5-20261001",
      "2026-10-22T00:00:00.000Z",
    );
    expect(resolved?.source).toBe("config");
    expect(resolved?.price.input).toBe(1);
    // a model the override does not name uses the shipped entry
    expect(resolvePrice(context, "claude-haiku-5-5", "2026-10-22T00:00:00.000Z")?.source).toBe(
      "shipped",
    );
    const delta = buildDelta([event({ input: 1_000_000 })], context);
    expect(delta.models["claude-sonnet-5-5"]).toMatchObject({
      config_priced_calls: 1,
      computed_usd: 1,
    });
    expect(
      summarizeCost(
        (() => {
          const t = newTotals();
          addDelta(t, delta);
          return t;
        })(),
      ).config,
    ).toBe(true);
  });

  test("t9jrs_override_1h_defaults_to_2x_input", () => {
    const context = defaultPricing(
      pricesOverrideSchema.parse({ m: { input: 4, output: 1, cache_read: 1, cache_write: 5 } }),
    );
    const resolved = resolvePrice(context, "m", "2026-10-22T00:00:00.000Z");
    expect(resolved?.price.cache_write_1h).toBeUndefined();
    const delta = buildDelta(
      [event({ model: "m", cache_write: 1_000_000, cache_write_1h: 1_000_000 })],
      context,
    );
    expect(delta.models["m"]?.computed_usd).toBe(8);
  });

  test("t9jrs_override_rejects_partial_negative_nonfinite_unknown_keys_and_unsafe_ids", () => {
    const ok = { input: 1, output: 1, cache_read: 1, cache_write: 1 };
    expect(pricesOverrideSchema.safeParse({ m: ok }).success).toBe(true);
    const bad: unknown[] = [
      { m: { input: 1, output: 1, cache_read: 1 } },
      { m: { ...ok, input: -1 } },
      { m: { ...ok, input: Number.POSITIVE_INFINITY } },
      { m: { ...ok, input: Number.NaN } },
      { m: { ...ok, surprise: 1 } },
      { "../etc": ok },
      { "has space": ok },
      { "": ok },
      { ["x".repeat(129)]: ok },
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, ok])),
    ];
    for (const value of bad) expect(pricesOverrideSchema.safeParse(value).success).toBe(false);
    expect(
      pricesOverrideSchema.safeParse(
        Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`m${i}`, ok])),
      ).success,
    ).toBe(true);
  });

  test("t9jrs_cost_stored_with_revision_not_recomputed", () => {
    const old = tableOf({ "claude-sonnet-5-5": [entry({ input: 3 })] });
    const newer = priceTableSchema.parse({
      ...old,
      revision: "2026-11-01",
      models: { "claude-sonnet-5-5": [entry({ input: 30 })] },
    });
    const e = event({ input: 1_000_000 });
    const before = buildDelta([e], { table: old });
    const after = buildDelta([e], { table: newer });
    expect(before.revision).toBe("2026-10-01");
    expect(after.revision).toBe("2026-11-01");
    // the totals add what the delta carries; a later table changes nothing already stored
    const totals = newTotals();
    addDelta(totals, before);
    const stored = summarizeCost(totals).usd;
    addDelta(newTotals(), after);
    expect(summarizeCost(totals).usd).toBe(stored);
    expect(stored).toBe(3);
  });

  test("t9jrs_models_beyond_the_limits_are_counted_as_other", () => {
    const many = Array.from({ length: MAX_MODELS_PER_RECORD + 5 }, (_, i) =>
      event({ model: `model-${i}`, message_id: `m${i}`, input: 1 }),
    );
    const delta = buildDelta(many, defaultPricing());
    expect(Object.keys(delta.models).length).toBe(MAX_MODELS_PER_RECORD);
    expect(delta.models[OTHER_MODEL]?.api_calls).toBe(6);
    // the numbers still add up
    const totals = newTotals();
    addDelta(totals, delta);
    expect(tokensOf(totals).input).toBe(many.length);
    // an id that does not look like one is `other`, not stored
    const odd = buildDelta(
      [event({ model: "a b\nc" }), event({ model: "x/../y" })],
      defaultPricing(),
    );
    expect(Object.keys(odd.models)).toEqual([OTHER_MODEL]);
    // and a run holds no more than its limit either
    const run = newTotals();
    for (let i = 0; i < MAX_MODELS_PER_RUN + 10; i += 1) {
      addDelta(run, buildDelta([event({ model: `run-${i}`, input: 1 })], defaultPricing()));
    }
    expect(Object.keys(run.models).length).toBe(MAX_MODELS_PER_RUN);
    expect(tokensOf(run).input).toBe(MAX_MODELS_PER_RUN + 10);
  });
});

describe("t9jrs repeats and gate waits", () => {
  test("t9jrs_dedupe_message_id_request_id", () => {
    const seen = new Set<string>();
    const first = [
      event({ message_id: "a", request_id: "r1" }),
      event({ message_id: "b", request_id: "r2" }),
    ];
    expect(dedupeUsage(first, seen).fresh.length).toBe(2);
    // the same response read again, from another file
    const again = [
      event({ message_id: "a", request_id: "r1", session_id: "sub" }),
      event({ message_id: "c" }),
    ];
    expect(dedupeUsage(again, seen).fresh.map((e) => e.message_id)).toEqual(["c"]);
    // the same message id with another request id is another response
    expect(dedupeUsage([event({ message_id: "a", request_id: "r9" })], seen).fresh.length).toBe(1);
  });

  test("t9jrs_dedupe_overflow_flagged", () => {
    const seen = new Set<string>();
    const events = [
      event({ message_id: "a" }),
      event({ message_id: "b" }),
      event({ message_id: "c" }),
    ];
    const result = dedupeUsage(events, seen, 2);
    expect(result.overflow).toBe(true);
    // once full the set stops growing; the events still count, and a repeat of one that did not fit counts twice
    expect(seen.size).toBe(2);
    expect(result.fresh.length).toBe(3);
    expect(dedupeUsage([event({ message_id: "c" })], seen, 2).fresh.length).toBe(1);
    expect(dedupeUsage([event({ message_id: "a" })], seen, 2).fresh.length).toBe(0);
    expect(DEDUPE_CAP).toBe(200_000);
    const flagged = buildDelta(events, defaultPricing(), { dedupeOverflow: true, lastOpen: true });
    expect(flagged).toMatchObject({ dedupe_overflow: true, last_open: true });
  });

  test("t9jrs_gate_wait_and_pause_spans_go_to_outside", () => {
    const at = (s: number, id: string) =>
      event({ message_id: id, ts: `2026-10-22T10:00:${String(s).padStart(2, "0")}.000Z` });
    const events = [at(1, "a"), at(10, "b"), at(20, "c"), at(30, "d")];
    const spans = [{ from: "2026-10-22T10:00:10.000Z", to: "2026-10-22T10:00:20.000Z" }];
    const { credited, outside } = splitBySpans(events, spans);
    // the ends are inside the span
    expect(outside.map((e) => e.message_id)).toEqual(["b", "c"]);
    expect(credited.map((e) => e.message_id)).toEqual(["a", "d"]);
    expect(splitBySpans(events, []).outside).toEqual([]);
  });
});

describe("t9jrs the pure modules do no I/O", () => {
  test("t9jrs_pure_modules_have_no_io_import", async () => {
    const files = ["price-table.ts", "usage.ts", "usage-record.ts"];
    const forbidden = /^(node:|fs$|path$|child_process$|os$|crypto$)/;
    for (const name of files) {
      const path = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.ES2023,
        true,
      );
      const modules: string[] = [];
      const visit = (node: ts.Node): void => {
        // static imports (type-only too), re-exports and dynamic import()
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          modules.push(node.moduleSpecifier.text);
        } else if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          modules.push(node.moduleSpecifier.text);
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          modules.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(
        modules.filter((m) => forbidden.test(m)),
        name,
      ).toEqual([]);
      // no clock either
      const text = source.getFullText();
      expect(text).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    }
  });
});

// ── the run machine ─────────────────────────────────────────────────────────

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write",
    "  - slug: approve",
    "    kind: human",
    "    prompt: ok?",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: write, when: rejected }",
    "",
  ].join("\n"),
);

function apply(state: RunState | undefined, e: RunEvent) {
  const result = decide(spec, state, e, 0);
  if (!result.ok) throw result.error;
  return result;
}

const started = (usage = true) => {
  const history = defaultHistory();
  if (usage) history.usage = defaultUsage();
  return apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history }).state;
};

const HEX = "b".repeat(64);
const delta = (
  over: Partial<UsageDelta> = {},
  events: UsageEvent[] = [event({ input: 10, output: 5 })],
): UsageDelta => ({
  ...buildDelta(events, defaultPricing()),
  ...over,
});
const recorded = (over: Partial<Extract<RunEvent, { type: "usage_recorded" }>> = {}): RunEvent => ({
  type: "usage_recorded",
  session: "s1",
  node: "write",
  attempt: 1,
  delta: delta(),
  cursor: { last_seq: 4, last_key: HEX },
  ...over,
});

describe("t9jrs the account of usage in the run machine", () => {
  test("t9jrs_old_run_reads_as_not_captured", () => {
    // a run started without the section keeps no usage state and takes no record
    const state = started(false);
    expect(state.usage).toBeUndefined();
    expect(apply(state, recorded())).toMatchObject({ noop: true, journal: [] });
    expect(apply(state, { type: "usage_failed", reason: "busy" })).toMatchObject({
      noop: true,
      journal: [],
    });
    expect(started().usage).toEqual(newUsageState());
    // disabled in the section: nothing either
    const history = defaultHistory();
    history.usage = { enabled: false, prices: {} };
    const off = apply(undefined, {
      type: "start",
      runId: "r",
      task: "t",
      specHash: "h",
      history,
    }).state;
    expect(off.usage).toBeUndefined();
  });

  test("t9jrs_recorded_adds_deltas_to_the_attempt_and_the_cursor_moves", () => {
    const first = apply(started(), recorded());
    expect(first.journal).toMatchObject([
      {
        event: "usage_recorded",
        session: "s1",
        node: "write",
        attempt: 1,
        cursor: { last_seq: 4 },
      },
    ]);
    const second = apply(
      first.state,
      recorded({
        cursor: { last_seq: 9, last_key: HEX },
        delta: delta({}, [event({ input: 1, message_id: "m2" })]),
      }),
    );
    const usage = second.state.usage;
    expect(usage?.sessions["s1"]?.last_seq).toBe(9);
    expect(usage?.events).toBe(2);
    const attempt = usage?.attempts["write:1"];
    expect(attempt?.passes).toBe(2);
    expect(attempt && tokensOf(attempt)).toMatchObject({ input: 11, output: 5, api_calls: 2 });
    expect(usage?.revisions).toEqual([SHIPPED_PRICES.revision]);
    // the cursor never goes back
    expect(apply(second.state, recorded({ cursor: { last_seq: 3, last_key: HEX } }))).toMatchObject(
      { noop: true },
    );
  });

  test("t9jrs_recorded_only_for_active_agent_visit", () => {
    const state = started();
    // another node, a future attempt, a node and no attempt: not credited
    for (const bad of [
      recorded({ node: "approve" }),
      recorded({ attempt: 2 }),
      recorded({ node: "nope" }),
      recorded({ attempt: undefined }),
      recorded({ node: undefined }),
    ]) {
      expect(apply(state, bad)).toMatchObject({ noop: true, journal: [] });
    }
    // use outside every step takes no node
    const outside = apply(state, recorded({ node: undefined, attempt: undefined }));
    expect(outside.state.usage?.unattributed.passes).toBe(1);
    expect(outside.state.usage?.attempts).toEqual({});
    // a run that is not running takes nothing
    const ended = apply(state, { type: "cancel" }).state;
    expect(apply(ended, recorded())).toMatchObject({ noop: true, journal: [] });
  });

  test("t9jrs_refused_hand_in_then_retry_adds_delta", () => {
    // a pass recorded for the attempt; the hand-in was refused; the retry's pass adds another delta to the same attempt
    const first = apply(started(), recorded());
    const retried = apply(
      first.state,
      recorded({
        cursor: { last_seq: 8, last_key: HEX },
        delta: delta({}, [event({ output: 40, message_id: "m3" })]),
      }),
    );
    const attempt = retried.state.usage?.attempts["write:1"];
    expect(attempt && tokensOf(attempt)).toMatchObject({ output: 45, api_calls: 2 });
  });

  test("t9jrs_state_rejects_unsafe_model_and_session_ids", () => {
    const state = started();
    const ok = delta();
    const withModel = (model: string): UsageDelta => ({
      ...ok,
      models: { [model]: Object.values(ok.models)[0] as NonNullable<UsageDelta["models"][string]> },
    });
    for (const bad of [
      recorded({ session: "../x" }),
      recorded({ session: "" }),
      recorded({ delta: withModel("a b") }),
      recorded({ delta: withModel("x\ny") }),
      recorded({ delta: withModel("Bearer abc.def/ghi=") }),
      recorded({ delta: { ...ok, revision: "yesterday" } }),
      recorded({ delta: { ...ok, v: 2 as typeof USAGE_RECORD_FORMAT } }),
      recorded({ cursor: { last_seq: 1, last_key: "nothex" } }),
      recorded({ cursor: { last_seq: -1, last_key: HEX } }),
    ]) {
      expect(apply(state, bad)).toMatchObject({ noop: true, journal: [] });
    }
    // and a delta with an unknown field or a negative count
    const [name, usage] = Object.entries(ok.models)[0] as [
      string,
      NonNullable<UsageDelta["models"][string]>,
    ];
    expect(
      apply(state, recorded({ delta: { ...ok, models: { [name]: { ...usage, input: -1 } } } })),
    ).toMatchObject({ noop: true });
    expect(
      apply(state, recorded({ delta: { ...ok, extra: 1 } as unknown as UsageDelta })),
    ).toMatchObject({ noop: true });
  });

  test("t9jrs_state_holds_only_numbers_and_safe_ids", () => {
    // after records with a hostile log folded to `other`, nothing in the usage state is free text
    const hostile = buildDelta(
      [
        event({ model: "sk-live-0123456789abcdef\nsecret", input: 1 }),
        event({ model: "ok-model", input: 1, message_id: "m2" }),
      ],
      defaultPricing(),
    );
    const state = apply(started(), recorded({ delta: hostile })).state;
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        expect(value, path).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,127}$|^\d{4}-\d{2}-\d{2}$/);
      } else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          expect(key, `${path} key`).toMatch(/^[A-Za-z0-9_:.[\]-]{1,128}$/);
          walk(inner, `${path}.${key}`);
        }
      }
    };
    walk(state.usage, "usage");
    expect(Object.keys(state.usage?.attempts["write:1"]?.models ?? {}).sort()).toEqual([
      "ok-model",
      OTHER_MODEL,
    ]);
  });

  test("t9jrs_usage_recorded_and_model_caps", () => {
    let state = started();
    // the models of a record are bounded by the schema
    const models = Object.fromEntries(
      Array.from({ length: MAX_MODELS_PER_RECORD + 1 }, (_, i) => [
        `m${i}`,
        Object.values(delta().models)[0] as NonNullable<UsageDelta["models"][string]>,
      ]),
    );
    expect(apply(state, recorded({ delta: { ...delta(), models } }))).toMatchObject({ noop: true });
    // events are bounded
    state = { ...state, usage: { ...(state.usage ?? newUsageState()), events: MAX_USAGE_EVENTS } };
    expect(apply(state, recorded())).toMatchObject({ noop: true, journal: [] });
    // attempts are bounded
    const crowded: RunState = {
      ...started(),
      usage: {
        ...newUsageState(),
        attempts: Object.fromEntries(
          Array.from({ length: MAX_USAGE_ATTEMPTS }, (_, i) => [`n${i}:1`, newTotals()]),
        ),
      },
    };
    // past the limit the record is not refused: it counts in the run's unattributed use, so the sum stays whole
    const spilled = apply(crowded, recorded());
    expect(spilled.journal).toHaveLength(1);
    expect(spilled.journal[0]).not.toHaveProperty("node");
    expect(Object.keys(spilled.state.usage?.attempts ?? {})).toHaveLength(MAX_USAGE_ATTEMPTS);
    expect(Object.keys(spilled.state.usage?.unattributed.models ?? {})).not.toEqual([]);
    // but one already told apart still takes records
    const known = {
      ...crowded,
      usage: { ...crowded.usage, attempts: { ...crowded.usage?.attempts, "write:1": newTotals() } },
    } as RunState;
    expect(apply(known, recorded()).journal).toHaveLength(1);
  });

  test("t9jrs_usage_failed_once_per_reason", () => {
    const first = apply(started(), { type: "usage_failed", reason: "log_missing", session: "s1" });
    expect(first.journal).toMatchObject([
      { event: "usage_failed", reason: "log_missing", session: "s1" },
    ]);
    expect(apply(first.state, { type: "usage_failed", reason: "log_missing" })).toMatchObject({
      noop: true,
      journal: [],
    });
    expect(apply(first.state, { type: "usage_failed", reason: "busy" }).journal).toHaveLength(1);
    // a reason the machine does not know, and a session that is no id
    expect(apply(started(), { type: "usage_failed", reason: "made_up" as never })).toMatchObject({
      noop: true,
    });
    expect(
      apply(started(), { type: "usage_failed", reason: "busy", session: "../x" }).journal[0],
    ).not.toHaveProperty("session");
  });

  test("t9jrs_run_total_is_the_attempts_plus_the_unattributed", () => {
    let state = started();
    state = apply(
      state,
      recorded({ delta: delta({}, [event({ input: 100, message_id: "a" })]) }),
    ).state;
    state = apply(
      state,
      recorded({
        node: undefined,
        attempt: undefined,
        cursor: { last_seq: 9, last_key: HEX },
        delta: delta({}, [event({ input: 20, message_id: "b" })]),
      }),
    ).state;
    const usage = state.usage as NonNullable<RunState["usage"]>;
    const total = runTotals(usage);
    expect(tokensOf(total).input).toBe(120);
    const attempt = usage.attempts["write:1"] as NonNullable<(typeof usage.attempts)[string]>;
    expect(tokensOf(attempt).input + tokensOf(usage.unattributed).input).toBe(
      tokensOf(total).input,
    );
  });
});

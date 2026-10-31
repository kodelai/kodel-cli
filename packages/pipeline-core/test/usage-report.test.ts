import { describe, expect, test } from "bun:test";
import {
  addDelta,
  buildDelta,
  defaultHistory,
  defaultUsage,
  type HistoryEvent,
  type JournalRecord,
  newTotals,
  newUsageState,
  type RunState,
  splitBySpans,
  summarizeRun,
  type UsageEvent,
  usageReport,
} from "../src";

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  v: 1,
  agent: "claude-code",
  agent_version: "2.1.306",
  session_id: "s",
  seq: 1,
  ts: "2026-10-21T10:00:00.000Z",
  kind: "usage",
  model: "claude-sonnet-5-5",
  input: 1_000,
  output: 100,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  semantics: "additive",
  message_id: "m1",
  ...over,
});

const context = { table: { format: 1 as const, revision: "2026-10-01", models: {} } };

/** The state of a run as far as the report reads it. */
function stateWith(over: Partial<RunState>): RunState {
  return {
    status: "running",
    active: [],
    trail: [],
    nodes: {},
    history: { ...defaultHistory(), usage: defaultUsage() },
    ...over,
  } as unknown as RunState;
}

describe("usage report", () => {
  test("t9jrs_current_reader_ignores_unknown_events", () => {
    // what a later engine writes (events and fields this one does not know) must not stop the report of this one
    const usage = newUsageState();
    const totals = newTotals();
    addDelta(totals, buildDelta([event()], context));
    usage.attempts["write:1"] = totals;
    usage.revisions.push("2026-10-01");
    const state = stateWith({ usage, runId: "r_000000001_aaaa", task: "t", nodes: {}, trail: [] });
    const journal: JournalRecord[] = [
      { v: 2, seq: 1, ts: 1, event: "usage_from_the_future", something: { a: 1 } },
      { v: 2, seq: 2, ts: 2, event: "cost_snapshot", amount: 3 },
    ];
    const known = usageReport(state, []);
    expect(usageReport(state, journal)).toEqual(known);
    expect(() => summarizeRun(state, journal)).not.toThrow();
    expect(summarizeRun(state, journal).usage).toEqual(summarizeRun(state, []).usage);
  });

  test("t9jrs_report_without_usage_section_is_not_captured", () => {
    expect(usageReport(stateWith({}), [])).toEqual({ not_collected: true, reason: "not_captured" });
  });

  test("t9jrs_report_switched_off_is_disabled", () => {
    const state = stateWith({
      history: { ...defaultHistory(), usage: { enabled: false, prices: {} } },
    });
    expect(usageReport(state, [])).toEqual({ not_collected: true, reason: "disabled" });
  });

  test("t9jrs_report_names_why_nothing_was_collected", () => {
    const usage = newUsageState();
    usage.failed.push("session_unknown");
    expect(usageReport(stateWith({ usage }), [])).toEqual({
      not_collected: true,
      reason: "session_unknown",
    });
  });

  test("t9jrs_report_shows_flags", () => {
    const usage = newUsageState();
    const totals = newTotals();
    addDelta(totals, {
      ...buildDelta([event(), event({ message_id: "m2", model: "some-future-model" })], context, {
        lastOpen: true,
        subagent: true,
        incomplete: true,
        dedupeOverflow: true,
      }),
    });
    usage.attempts["impl:1"] = totals;
    usage.revisions.push("2026-10-01");
    usage.sessions["s"] = { last_seq: 3, last_key: "a".repeat(64), behind: true };
    const report = usageReport(stateWith({ usage }), []);
    if (!("estimate" in report)) throw new Error("expected a report");
    expect(report.estimate).toBe(true);
    expect(report.lower_bound).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.revisions).toEqual(["2026-10-01"]);
    const line = report.attempts[0];
    expect(line).toMatchObject({
      node: "impl",
      attempt: 1,
      last_open: true,
      incomplete: true,
      subagent: true,
      dedupe_overflow: true,
    });
    expect(report.total.tokens.input).toBe(2_000);
  });

  test("t9jrs_report_partial_total_never_zero", () => {
    const usage = newUsageState();
    const totals = newTotals();
    // an empty table: no price for the model
    addDelta(totals, buildDelta([event()], context));
    usage.attempts["impl:1"] = totals;
    const report = usageReport(stateWith({ usage }), []);
    if (!("estimate" in report)) throw new Error("expected a report");
    expect(report.total.cost.usd).toBeNull();
    expect(report.total.cost.partial).toBe(true);
    expect(report.total.models["claude-sonnet-5-5"]?.usd).toBeNull();
  });

  test("t9jrs_report_unattributed_has_its_own_line", () => {
    const usage = newUsageState();
    const totals = newTotals();
    addDelta(totals, buildDelta([event()], context));
    usage.attempts["impl:1"] = totals;
    const outside = newTotals();
    addDelta(outside, buildDelta([event({ message_id: "m3", input: 7 })], context));
    usage.unattributed = outside;
    const report = usageReport(stateWith({ usage }), []);
    if (!("estimate" in report)) throw new Error("expected a report");
    expect(report.unattributed?.tokens.input).toBe(7);
    expect(report.total.tokens.input).toBe(1_007);
  });

  test("t9jrs_unknown_usage_v_is_cannot_read_not_modified", () => {
    const journal: JournalRecord[] = [
      {
        v: 2,
        seq: 5,
        ts: 1,
        event: "usage_recorded",
        session: "s",
        delta: { v: 2, models: {} },
      },
    ];
    const report = usageReport(stateWith({ usage: newUsageState() }), journal);
    expect(report).toEqual({ cannot_read: true, format: "2" });
  });

  test("t9jrs_report_never_shows_cost_state", () => {
    const usage = newUsageState();
    usage.attempts["impl:1"] = newTotals();
    const text = JSON.stringify(usageReport(stateWith({ usage }), []));
    expect(text).not.toContain("cost-state");
    expect(text).not.toContain("cost_state");
  });

  test("t9jrs_summarizeRun_carries_usage", () => {
    const report = summarizeRun(
      stateWith({ runId: "r_000000001_aaaa", task: "t", nodes: {}, trail: [] }),
      [],
    );
    expect(report.usage).toEqual({ not_collected: true, reason: "not_captured" });
  });
});

describe("usage windows", () => {
  const at = (ms: number): UsageEvent =>
    event({
      seq: ms,
      message_id: `m${ms}`,
      ts: new Date(Date.parse("2026-10-21T10:00:00.000Z") + ms).toISOString(),
    });
  const span = {
    from: "2026-10-21T10:00:01.000Z",
    to: "2026-10-21T10:00:02.000Z",
  };

  test("t9jrs_window_boundaries_equal_timestamp_and_one_millisecond_either_side", () => {
    const events = [at(999), at(1_000), at(1_001), at(1_999), at(2_000), at(2_001)];
    const { credited, outside } = splitBySpans(events, [span]);
    // the edges belong to the wait, one millisecond outside them to the step
    expect(outside.map((e) => e.seq)).toEqual([1_000, 1_001, 1_999, 2_000]);
    expect(credited.map((e) => e.seq)).toEqual([999, 2_001]);
  });

  test("t9jrs_every_event_in_exactly_one_part", () => {
    const events: HistoryEvent[] = [];
    for (let ms = 0; ms < 3_000; ms += 37) events.push(at(ms));
    const usageEvents = events as UsageEvent[];
    const { credited, outside } = splitBySpans(usageEvents, [span]);
    expect(credited.length + outside.length).toBe(usageEvents.length);
    expect(credited.filter((e) => outside.includes(e))).toEqual([]);
  });
});

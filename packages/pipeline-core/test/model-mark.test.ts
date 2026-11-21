/**
 * The model a step asked for against the models seen (T-43): the match rule as a table, and the mark of an
 * attempt for every case the report distinguishes. The state and the journal are built by hand here; the
 * same cases from real logs are in `packages/local/test/model-step.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  emptyModelUsage,
  type JournalRecord,
  type ModelNotObserved,
  modelMarks,
  modelMatches,
  type RunState,
  type UsageState,
  type UsageTotals,
} from "../src";

const rows: [string, string, string, boolean][] = [
  ["a family and an id", "sonnet", "claude-sonnet-5-5", true],
  ["a family and an id with a suffix", "opus", "claude-opus-4-8[1m]", true],
  ["a version prefix", "claude-sonnet-5", "claude-sonnet-5-5", true],
  ["a version prefix of another version", "claude-sonnet-5", "claude-sonnet-4-6", false],
  ["a longer number", "claude-sonnet-5-5", "claude-sonnet-5-55", false],
  ["non-contiguous segments", "claude-5", "claude-sonnet-5-5", false],
  ["a suffix on the requested name", "sonnet[1m]", "claude-sonnet-5-5", true],
  ["equal ids", "claude-haiku-5-5", "claude-haiku-5-5", true],
  ["case", "SONNET", "claude-sonnet-5-5", true],
  ["a bare vendor matches every id of it", "claude", "claude-opus-4-8", true],
  ["a name with no letter", "5", "claude-sonnet-5-5", false],
  ["the folded id never matches", "sonnet", "other", false],
  ["another family", "sonnet", "claude-opus-4-8", false],
];
for (const [name, requested, observed, expected] of rows) {
  test(`t43_match_rule: ${name}`, () => {
    expect(modelMatches(requested, observed)).toBe(expected);
  });
}

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-4-8";
const hex = "a".repeat(64);

/** Totals that hold only the models the test names. */
const totals = (...models: string[]): UsageTotals => ({
  passes: 1,
  models: Object.fromEntries(models.map((m) => [m, emptyModelUsage()])),
});

function usageOf(patch: Partial<UsageState> = {}): UsageState {
  return {
    sessions: {},
    attempts: { "a:1": totals(SONNET) },
    unattributed: { models: {}, passes: 0 },
    events: 1,
    failed: [],
    revisions: [],
    ...patch,
  };
}

const stateOf = (usage: UsageState | undefined, v = 2) => ({ v, usage }) as unknown as RunState;

const rec = (event: string, fields: Record<string, unknown> = {}): JournalRecord =>
  ({ v: 2, seq: 1, ts: 1, event, ...fields }) as JournalRecord;

const entered = (node = "a", attempt = 1) => rec("node_entered", { node, attempt });
const completed = (node = "a", attempt = 1, model?: string) =>
  rec("agent_completed", {
    node,
    attempt,
    ...(model === undefined ? {} : { executor: { model: { value: model, source: "derived" } } }),
  });
const asked = (model = "sonnet", node = "a", attempt = 1) =>
  new Map([[`${node}:${attempt}`, model]]);

const markOf = (state: RunState, journal: JournalRecord[], requested = asked()) =>
  modelMarks({ state, journal, requested })[0];

describe("t43 the mark of an attempt", () => {
  test("t43_mark_match_by_host_and_by_subagent", () => {
    const journal = [entered(), completed("a", 1, SONNET)];
    expect(markOf(stateOf(usageOf()), journal)).toMatchObject({ result: "match", by: "host" });
    const other = [entered(), completed("a", 1, OPUS)];
    expect(
      markOf(stateOf(usageOf({ attempts: { "a:1": totals(OPUS, SONNET) } })), other),
    ).toMatchObject({
      result: "match",
      by: "subagent",
    });
  });

  test("t43_mark_label_left_out_when_the_host_model_is_unknown", () => {
    const mark = markOf(stateOf(usageOf()), [entered(), completed("a", 1)]);
    expect(mark?.result).toBe("match");
    expect(mark?.by).toBeUndefined();
  });

  test("t43_mark_mismatch", () => {
    const mark = markOf(stateOf(usageOf({ attempts: { "a:1": totals(OPUS) } })), [entered()]);
    expect(mark).toMatchObject({ result: "mismatch", seen: [OPUS], requested: "sonnet" });
  });

  const notObserved: [string, RunState, JournalRecord[], ModelNotObserved][] = [
    ["usage off or not captured", stateOf(undefined), [entered()], "usage_missing"],
    [
      "a busy pass was recorded",
      stateOf(usageOf({ failed: ["busy"] })),
      [entered()],
      "usage_missing",
    ],
    [
      "an unreadable pass was recorded",
      stateOf(usageOf({ failed: ["unreadable"] })),
      [entered()],
      "usage_missing",
    ],
    [
      "a cursor is behind",
      stateOf(usageOf({ sessions: { s: { last_seq: 1, last_key: hex, behind: true } } })),
      [entered()],
      "usage_missing",
    ],
    ["no record for the attempt", stateOf(usageOf({ attempts: {} })), [entered()], "usage_missing"],
    [
      "an empty models map",
      stateOf(usageOf({ attempts: { "a:1": totals() } })),
      [entered()],
      "usage_missing",
    ],
    [
      "an id the report cannot read was seen and nothing matched",
      stateOf(usageOf({ attempts: { "a:1": totals(OPUS, "other") } })),
      [entered()],
      "unknown_id",
    ],
    ["a run of format 1", stateOf(usageOf(), 1), [entered()], "unsupported"],
    [
      "a client that is not Claude Code",
      stateOf(usageOf({ failed: ["agent_unsupported"] })),
      [entered()],
      "unsupported",
    ],
    [
      "the run had workers",
      stateOf(usageOf()),
      [entered(), rec("step_claimed", { node: "x", attempt: 1 })],
      "workers_in_run",
    ],
  ];
  for (const [name, state, journal, reason] of notObserved) {
    test(`t43_mark_not_observed_reasons: ${name}`, () => {
      expect(markOf(state, journal)).toMatchObject({ result: "not_observed", reason });
    });
  }

  test("t43_one_usage_failure_downgrades_every_one_session_step", () => {
    // pinned: an entry in `usage.failed` names no attempt, so it downgrades the match of a step whose own
    // pass was fine; a mark that is not sure says so
    const usage = usageOf({ failed: ["busy"] });
    const mark = markOf(stateOf(usage), [entered(), completed("a", 1, SONNET)]);
    expect(mark).toMatchObject({ result: "not_observed", reason: "usage_missing" });
  });

  test("t43_a_matching_id_is_a_match_even_with_an_unreadable_one_beside_it", () => {
    const usage = usageOf({ attempts: { "a:1": totals(SONNET, "other") } });
    expect(markOf(stateOf(usage), [entered()])?.result).toBe("match");
  });

  test("t43_retry_with_changed_model", () => {
    // attempt 1 asked for sonnet, attempt 2 (after a change) for opus: each against its own
    const usage = usageOf({ attempts: { "a:1": totals(SONNET), "a:2": totals(OPUS) } });
    const requested = new Map([
      ["a:1", "sonnet"],
      ["a:2", "opus"],
    ]);
    const marks = modelMarks({
      state: stateOf(usage),
      journal: [entered("a", 1), entered("a", 2)],
      requested,
    });
    expect(marks.map((m) => [m.attempt, m.result])).toEqual([
      [1, "match"],
      [2, "match"],
    ]);
  });

  test("t43_attempts_that_asked_for_nothing_have_no_mark", () => {
    const marks = modelMarks({
      state: stateOf(usageOf()),
      journal: [entered("a", 1), entered("b", 1)],
      requested: asked(),
    });
    expect(marks.map((m) => m.node)).toEqual(["a"]);
  });
});

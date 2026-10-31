import { describe, expect, test } from "bun:test";
import type { JournalRecord } from "@kodel-ai/pipeline-core";
import { outsideSpans } from "../src";

const rec = (seq: number, ts: number, event: string, node?: string): JournalRecord => ({
  v: 2,
  seq,
  ts,
  event,
  ...(node === undefined ? {} : { node }),
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("the times a person was waited for", () => {
  test("t9jrs_gate_wait_is_a_span_from_waiting_to_decided", () => {
    const journal = [rec(1, 1_000, "gate_waiting", "g"), rec(2, 4_000, "gate_decided", "g")];
    expect(outsideSpans(journal, 9_000)).toEqual([{ from: iso(1_000), to: iso(4_000) }]);
  });

  test("t9jrs_pause_is_a_span_from_paused_to_resumed", () => {
    const journal = [rec(1, 1_000, "run_paused"), rec(2, 2_500, "run_resumed")];
    expect(outsideSpans(journal, 9_000)).toEqual([{ from: iso(1_000), to: iso(2_500) }]);
  });

  test("t9jrs_open_wait_lasts_to_now", () => {
    const journal = [rec(1, 1_000, "gate_waiting", "g"), rec(2, 3_000, "run_paused")];
    expect(outsideSpans(journal, 9_000)).toEqual([
      { from: iso(1_000), to: iso(9_000) },
      { from: iso(3_000), to: iso(9_000) },
    ]);
  });

  test("t9jrs_decision_of_another_gate_does_not_close_this_one", () => {
    const journal = [
      rec(1, 1_000, "gate_waiting", "g1"),
      rec(2, 2_000, "gate_waiting", "g2"),
      rec(3, 3_000, "gate_decided", "g2"),
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([
      { from: iso(2_000), to: iso(3_000) },
      { from: iso(1_000), to: iso(9_000) },
    ]);
  });

  test("t9jrs_no_waiting_no_spans", () => {
    expect(outsideSpans([rec(1, 1_000, "node_entered", "a")], 9_000)).toEqual([]);
  });
});

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

  test("t40_usage_pause_lifted_by_an_accepted_change_is_closed_as_on_main", () => {
    // `x` is handed in and paused; a change is accepted and `x` worked again; command `c`; a pause at `y` resumed;
    // agent step `z` open now. Before forks the next pause replaced the window of `x`: only `y`'s wait is outside.
    const step = (seq: number, ts: number, event: string, node: string, attempt = 1) => ({
      ...rec(seq, ts, event, node),
      attempt,
    });
    const journal: JournalRecord[] = [
      step(1, 1_000, "node_entered", "x"),
      step(2, 2_000, "agent_completed", "x"),
      rec(3, 2_200, "run_paused", "x"),
      { ...rec(4, 3_000, "pipeline_accepted"), effects: [{ kind: "reroute", node: "x", to: "x" }] },
      step(5, 3_100, "node_entered", "x", 2),
      step(6, 4_000, "agent_completed", "x", 2),
      step(7, 4_000, "node_finished", "x", 2),
      step(8, 4_200, "node_entered", "c"),
      step(9, 6_000, "node_finished", "c"),
      rec(10, 6_100, "run_paused", "y"),
      rec(11, 7_000, "run_resumed", "y"),
      step(12, 7_100, "node_entered", "z"),
    ];
    const main = [{ from: iso(6_100), to: iso(7_000) }];
    expect(outsideSpans(journal, 9_000, [{ node: "z", attempt: 1 }], [])).toEqual(main);
    expect(outsideSpans(journal, 9_000, [{ node: "z", attempt: 1 }])).toEqual(main);
  });

  test("t40_usage_pause_lifted_by_a_change_that_does_not_name_it_is_dropped_by_the_state", () => {
    // A `total` pause held at `x` is lifted by a recheck of the node its route came from; the record names `w`.
    const journal: JournalRecord[] = [
      rec(1, 1_000, "run_paused", "x"),
      { ...rec(2, 2_000, "pipeline_accepted"), effects: [{ kind: "recheck", node: "w" }] },
    ];
    expect(outsideSpans(journal, 9_000, [], [])).toEqual([]);
    expect(outsideSpans(journal, 9_000, [], [{ node: "x" }])).toEqual([
      { from: iso(1_000), to: iso(9_000) },
    ]);
  });

  test("t40_usage_gate_superseded_and_reached_again_starts_at_the_new_gate", () => {
    const journal: JournalRecord[] = [
      { ...rec(1, 1_000, "gate_waiting", "g"), attempt: 1 },
      { ...rec(2, 2_000, "pipeline_accepted"), effects: [{ kind: "restart", node: "g" }] },
      { ...rec(3, 2_000, "node_superseded", "g"), attempt: 1 },
      { ...rec(4, 2_000, "node_entered", "g"), attempt: 2 },
      { ...rec(5, 3_000, "gate_waiting", "g"), attempt: 2 },
      { ...rec(6, 5_000, "gate_decided", "g"), attempt: 2 },
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([{ from: iso(3_000), to: iso(5_000) }]);
  });

  test("t9jrs_no_waiting_no_spans", () => {
    expect(outsideSpans([rec(1, 1_000, "node_entered", "a")], 9_000)).toEqual([]);
  });
});

describe("the times a person was waited for, in a fork", () => {
  const visit = (seq: number, ts: number, event: string, node: string, attempt = 1) => ({
    ...rec(seq, ts, event, node),
    attempt,
    fork: "f1",
    branch: node,
  });

  test("t40_usage_gate_of_one_branch_while_an_agent_branch_is_open_is_not_outside", () => {
    // Agent branch `a` is open; gate branch `g` reaches its gate at 2s; `a` is handed in at 5s (the pass runs then).
    const journal = [
      visit(1, 1_000, "node_entered", "a"),
      visit(2, 2_000, "node_entered", "g"),
      visit(3, 2_000, "gate_waiting", "g"),
    ];
    expect(outsideSpans(journal, 5_000, [{ node: "a", attempt: 1 }])).toEqual([]);
  });

  test("t40_usage_gate_wait_is_outside_only_after_the_last_agent_branch_was_handed_in", () => {
    const journal = [
      visit(1, 1_000, "node_entered", "a"),
      visit(2, 2_000, "node_entered", "g"),
      visit(3, 2_000, "gate_waiting", "g"),
      visit(4, 5_000, "agent_completed", "a"),
      visit(5, 5_100, "node_finished", "a"),
      visit(6, 8_000, "gate_decided", "g"),
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([{ from: iso(5_000), to: iso(8_000) }]);
  });

  test("t40_usage_gate_and_command_steps_do_not_hold_a_wait_open", () => {
    // `c` is a command step (no hand-in, not in the agent phase): it does not make the gate's wait a step's time.
    const journal = [
      visit(1, 1_000, "node_entered", "c"),
      visit(2, 2_000, "node_entered", "g"),
      visit(3, 2_000, "gate_waiting", "g"),
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([{ from: iso(2_000), to: iso(9_000) }]);
  });

  test("t40_usage_pauses_of_two_branches_are_kept_apart", () => {
    const journal = [
      visit(1, 1_000, "run_paused", "x"),
      visit(2, 2_000, "run_paused", "y"),
      visit(3, 3_000, "run_resumed", "x"),
      visit(4, 6_000, "run_resumed", "y"),
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([
      { from: iso(1_000), to: iso(3_000) },
      { from: iso(2_000), to: iso(6_000) },
    ]);
  });

  test("t40_usage_second_pause_still_open_lasts_to_now", () => {
    const journal = [
      visit(1, 1_000, "run_paused", "x"),
      visit(2, 2_000, "run_paused", "y"),
      visit(3, 3_000, "run_resumed", "x"),
    ];
    expect(outsideSpans(journal, 9_000)).toEqual([
      { from: iso(1_000), to: iso(3_000) },
      { from: iso(2_000), to: iso(9_000) },
    ]);
  });

  test("t40_usage_pause_wait_less_the_time_an_agent_branch_was_open", () => {
    // `x` pauses at 1s while agent branch `a` (entered at 0.5s) is worked until its hand-in at 4s.
    const journal = [
      visit(1, 500, "node_entered", "a"),
      visit(2, 1_000, "run_paused", "x"),
      visit(3, 4_000, "agent_completed", "a"),
      visit(4, 7_000, "node_entered", "a", 2),
    ];
    expect(outsideSpans(journal, 9_000, [{ node: "a", attempt: 2 }])).toEqual([
      { from: iso(4_000), to: iso(7_000) },
    ]);
  });
});

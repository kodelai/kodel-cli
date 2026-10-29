import { describe, expect, test } from "bun:test";
import {
  decide,
  defaultAgentLog,
  defaultHistory,
  MAX_AGENT_LOG_STEPS,
  MAX_AGENT_LOG_TICKS,
  MAX_AGENT_LOG_VISITS,
  parsePipeline,
  type RunEvent,
  type RunState,
  summarizeRun,
} from "../src";

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

function apply(state: RunState | undefined, event: RunEvent) {
  const result = decide(spec, state, event, 0);
  if (!result.ok) throw result.error;
  return result;
}

const started = (agentLog = true) => {
  const history = defaultHistory();
  if (agentLog) history.agent_log = defaultAgentLog();
  return apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history }).state;
};

const HEX = "a".repeat(64);
const saved = (over: Partial<Extract<RunEvent, { type: "agent_log_saved" }>> = {}): RunEvent => ({
  type: "agent_log_saved",
  why: "tick",
  session: "s1",
  node: "write",
  attempt: 1,
  first_seq: 1,
  last_seq: 10,
  stream_from: 0,
  stream_to: 500,
  tail_hash: HEX,
  last_key: HEX,
  entries: 10,
  ...over,
});

describe("t3bk2 the account of the agent's log in the run machine", () => {
  test("t3bk2_saved_event_rules", () => {
    const first = apply(started(), saved());
    expect(first.journal).toMatchObject([
      {
        event: "agent_log_saved",
        why: "tick",
        session: "s1",
        node: "write",
        first_seq: 1,
        last_seq: 10,
        stream_from: 0,
        stream_to: 500,
        entries: 10,
      },
    ]);
    expect(first.state.agentLog).toMatchObject({
      nodes: ["write", "approve"],
      bytes: 500,
      ticks: 1,
      sessions: { s1: { last_seq: 10, length: 500, entries: 10 } },
    });
    // the stream must continue where the journal says it ends
    expect(
      apply(first.state, saved({ first_seq: 11, last_seq: 12, stream_from: 400 })),
    ).toMatchObject({
      noop: true,
      journal: [],
    });
    const second = apply(
      first.state,
      saved({ first_seq: 11, last_seq: 12, stream_from: 500, stream_to: 640, entries: 2 }),
    );
    expect(second.state.agentLog?.sessions["s1"]).toMatchObject({ length: 640, entries: 12 });
    expect(second.state.agentLog?.bytes).toBe(640);
  });

  test("t3bk2_saved_first_seq_rule", () => {
    const first = apply(started(), saved({ last_seq: 10, stream_to: 500 })).state;
    // an event already stored, or older, is not stored twice, even if it continues the stream
    for (const first_seq of [1, 5, 10]) {
      expect(
        apply(first, saved({ first_seq, last_seq: 20, stream_from: 500, stream_to: 900 })),
      ).toMatchObject({ noop: true });
    }
    expect(
      apply(first, saved({ first_seq: 11, last_seq: 20, stream_from: 500, stream_to: 900 }))
        .journal,
    ).toHaveLength(1);
  });

  test("t3bk2_saved_refused_unless_the_run_is_running_and_copies", () => {
    expect(apply(started(false), saved())).toMatchObject({ noop: true, journal: [] });
    const running = started();
    const ended = apply(running, { type: "cancel" }).state;
    expect(apply(ended, saved())).toMatchObject({ noop: true, journal: [] });
    expect(apply(ended, { type: "agent_log_failed", reason: "log_missing" })).toMatchObject({
      noop: true,
      journal: [],
    });
  });

  test("t3bk2_saved_event_with_bad_fields_is_a_noop", () => {
    const state = started();
    for (const bad of [
      saved({ session: "../x" }),
      saved({ session: "" }),
      saved({ parent: "a/b" }),
      saved({ tail_hash: "nothex" }),
      saved({ last_key: "A".repeat(64) }),
      saved({ first_seq: 0 }),
      saved({ first_seq: 5, last_seq: 4 }),
      saved({ stream_to: -1 }),
      saved({ stream_from: 0, stream_to: 0, entries: 1.5 }),
    ]) {
      expect(apply(state, bad)).toMatchObject({ noop: true, journal: [] });
    }
  });

  test("t3bk2_cap_in_core_survives_restart", () => {
    // the counters are part of the state, which is what a restarted server reads back
    const near = { ...started() };
    const log = near.agentLog;
    if (log === undefined) throw new Error("no agent log state");
    log.ticks = MAX_AGENT_LOG_TICKS - 1;
    const last = apply(near, saved());
    expect(last.journal).toHaveLength(1);
    const reloaded = JSON.parse(JSON.stringify(last.state)) as RunState;
    expect(
      apply(reloaded, saved({ first_seq: 11, last_seq: 12, stream_from: 500, stream_to: 600 })),
    ).toMatchObject({
      noop: true,
      journal: [],
    });
    // the end of a step still copies after the ticker has reached its limit
    const step = apply(
      reloaded,
      saved({ why: "step", first_seq: 11, last_seq: 12, stream_from: 500, stream_to: 600 }),
    );
    expect(step.journal).toHaveLength(1);
    const full = JSON.parse(JSON.stringify(step.state)) as RunState;
    if (full.agentLog === undefined) throw new Error("no agent log state");
    full.agentLog.steps = MAX_AGENT_LOG_STEPS;
    expect(
      apply(
        full,
        saved({ why: "step", first_seq: 13, last_seq: 14, stream_from: 600, stream_to: 700 }),
      ),
    ).toMatchObject({ noop: true });
  });

  test("t3bk2_failed_event_running_only", () => {
    const state = started();
    expect(
      apply(state, { type: "agent_log_failed", reason: "session_unknown" }).journal,
    ).toMatchObject([{ event: "agent_log_failed", reason: "session_unknown" }]);
    const ended = apply(state, { type: "cancel" }).state;
    expect(apply(ended, { type: "agent_log_failed", reason: "log_changed" })).toMatchObject({
      noop: true,
    });
  });

  test("t3bk2_failed_event_once_per_reason", () => {
    const first = apply(started(), {
      type: "agent_log_failed",
      reason: "log_missing",
      session: "s1",
    });
    expect(first.journal[0]).toMatchObject({ reason: "log_missing", session: "s1" });
    // the same reason again is a repeat, also after the state was written and read back
    const reloaded = JSON.parse(JSON.stringify(first.state)) as RunState;
    expect(apply(reloaded, { type: "agent_log_failed", reason: "log_missing" })).toMatchObject({
      noop: true,
      journal: [],
    });
    expect(apply(reloaded, { type: "agent_log_failed", reason: "refused" }).journal).toHaveLength(
      1,
    );
    // a reason the machine does not know is not journaled
    expect(apply(reloaded, { type: "agent_log_failed", reason: "made up" as never })).toMatchObject(
      { noop: true },
    );
  });

  test("t3bk2_failed_event_names_no_unsafe_session", () => {
    const result = apply(started(), {
      type: "agent_log_failed",
      reason: "refused",
      session: "a b/c",
    });
    expect(result.journal[0]?.["session"]).toBeUndefined();
  });

  test("t3bk2_not_captured", () => {
    // no agent_log in the run's history: nothing is kept in the state and the report says why
    const state = started(false);
    expect(state.agentLog).toBeUndefined();
    expect(summarizeRun(state, []).agent_log).toEqual({
      not_collected: true,
      reason: "not_captured",
    });
    const history = defaultHistory();
    history.agent_log = { ...defaultAgentLog(), enabled: false };
    const off = apply(undefined, {
      type: "start",
      runId: "r",
      task: "t",
      specHash: "h",
      history,
    }).state;
    expect(off.agentLog).toBeUndefined();
    expect(summarizeRun(off, []).agent_log).toEqual({ not_collected: true, reason: "disabled" });
  });
});

describe("t3bk2 the report of the agent's log", () => {
  test("t3bk2_report_counts_come_from_the_state_and_say_unverified", () => {
    const a = apply(started(), saved({ session: "s1" }));
    const b = apply(
      a.state,
      saved({
        session: "s2",
        first_seq: 1,
        last_seq: 4,
        stream_from: 0,
        stream_to: 200,
        entries: 4,
        cut: 3,
      }),
    );
    const report = summarizeRun(b.state, [...a.journal, ...b.journal]).agent_log;
    expect(report).toEqual({
      sessions: 2,
      entries: 14,
      bytes: 700,
      mode: "full",
      passes: { tick: 2, step: 0 },
      cut: 3,
      failed: [],
      unverified: true,
      // the bytes of each visit of a step, as the engine counted them (both copies were of write#1)
      visits: { "write:1": 700 },
    });
    // running: no word yet on whether the last step was copied
    expect("final_pass" in report).toBe(false);
  });

  test("t3bk2_report_final_pass", () => {
    const base = started();
    // a run that ends after a step of the agent, whether or not the copy at its end found anything new
    const done = apply(base, { type: "agent_completed", node: "write", attempt: 1 });
    const finished = apply(done.state, { type: "cancel" });
    expect(
      summarizeRun(finished.state, [...done.journal, ...finished.journal]).agent_log,
    ).toMatchObject({ final_pass: true });
    // a run that ends in the middle of a step: cancelled while the agent was at work
    const early = apply(base, { type: "cancel" });
    expect(early.state.agentLog?.endedInStep).toEqual(["write:1"]);
    expect(summarizeRun(early.state, early.journal).agent_log).toMatchObject({ final_pass: false });
    // and one that is going has no word on it
    expect("final_pass" in summarizeRun(base, []).agent_log).toBe(false);
  });

  test("t3bk2_report_reasons_are_listed", () => {
    const failed = apply(started(), { type: "agent_log_failed", reason: "session_unknown" });
    expect(summarizeRun(failed.state, failed.journal).agent_log).toMatchObject({
      sessions: 0,
      failed: ["session_unknown"],
    });
  });

  test("t3bk2_budget_nodes_are_fixed_at_the_start", () => {
    // the share of a step is cut from the nodes the run started with
    expect(started().agentLog?.nodes).toEqual(["write", "approve"]);
  });
});

describe("t3bk2 the report with many copies", () => {
  test("t3bk2_report_4000_events", () => {
    // the report is made of the journal: a run that copied every ten seconds for eleven hours has to be cheap to read
    const first = apply(started(), { type: "agent_log_failed", reason: "log_missing" });
    const journal = [...first.journal];
    for (let i = 0; i < MAX_AGENT_LOG_TICKS; i++) {
      journal.push({
        v: 2,
        seq: journal.length + 1,
        ts: 1_000 + i * 10_000,
        event: "agent_log_saved",
        why: "tick",
        session: "s1",
        node: "write",
        attempt: 1,
      });
    }
    const state = started();
    const timed = Date.now();
    const report = summarizeRun(state, journal);
    expect(Date.now() - timed).toBeLessThan(500);
    expect(report.agent_log).toMatchObject({ sessions: 0 });
  });

  test("t3bk2_report_running_attempt_time", () => {
    // a running attempt is reckoned up to the last record, and a copy is a record: the seconds shown for the attempt
    // that is going advance with it, and the seconds of an attempt that has finished do not
    const history = defaultHistory();
    history.agent_log = defaultAgentLog();
    const begin = apply(undefined, {
      type: "start",
      runId: "r",
      task: "t",
      specHash: "h",
      history,
    });
    const entered = begin.journal.find((r) => r.event === "node_entered");
    expect(entered).toBeDefined();
    const at = (record: Record<string, unknown>, ts: number) => ({ ...record, ts });
    const base = at(entered as never, 0);
    const copy = (ts: number) => ({
      v: 1,
      seq: 99,
      ts,
      event: "agent_log_saved",
      why: "tick",
      node: "write",
      attempt: 1,
    });
    const going = (last: number) => summarizeRun(started(), [base as never, copy(last) as never]);
    expect(going(5_000).nodes[0]?.attempts[0]?.seconds).toBe(5);
    expect(going(50_000).nodes[0]?.attempts[0]?.seconds).toBe(50);
    const done = (last: number) =>
      summarizeRun(started(), [
        base as never,
        {
          v: 1,
          seq: 98,
          ts: 3_000,
          event: "node_finished",
          node: "write",
          attempt: 1,
          outcome: "passed",
        } as never,
        copy(last) as never,
      ]);
    expect(done(5_000).nodes[0]?.attempts[0]?.seconds).toBe(3);
    expect(done(90_000).nodes[0]?.attempts[0]?.seconds).toBe(3);
  });

  test("t3bk2_mode_unknown_when_the_start_does_not_say", () => {
    const state = started();
    const { agent_log: _agentLog, ...history } = state.history ?? defaultHistory();
    const report = summarizeRun({ ...state, history: history as never }, []);
    expect(report.agent_log).toMatchObject({ mode: "unknown", sessions: 0 });
  });
});

describe("t3bk2 the nodes of the share are those the run started with", () => {
  const withNode = (text: string) =>
    parsePipeline(
      text
        .replace("edges:", "  - slug: inserted\n    kind: agent\n    prompt: new\nedges:")
        .replace(
          "  - { from: approve, to: write, when: rejected }",
          "  - { from: approve, to: write, when: rejected }\n  - { from: approve, to: inserted }",
        ),
    );
  const TEXT = [
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
  ].join("\n");

  test("t3bk2_budget_frozen_after_accepted", () => {
    const before = parsePipeline(TEXT);
    const history = defaultHistory();
    history.agent_log = defaultAgentLog();
    const started = decide(
      before,
      undefined,
      { type: "start", runId: "r", task: "t", specHash: "h1", history },
      0,
    );
    if (!started.ok) throw started.error;
    expect(started.state.agentLog?.nodes).toEqual(["write", "approve"]);
    // a node is added; the run moves to the new version
    const after = withNode(TEXT);
    const accepted = decide(
      after,
      started.state,
      { type: "pipeline_accepted", from: "h1", to: "h2", source: "file", before },
      0,
    );
    if (!accepted.ok) throw accepted.error;
    expect(accepted.state.specHash).toBe("h2");
    expect(Object.keys(accepted.state.nodes)).toContain("inserted");
    // what a step may use is still cut from the nodes the run began with: the new node is not among them
    expect(accepted.state.agentLog?.nodes).toEqual(["write", "approve"]);
  });
});

describe("t3bk2 the account of bytes per visit", () => {
  test("t3bk2_saved_event_counts_bytes_per_visit", () => {
    const first = apply(started(), saved({ stream_to: 500 }));
    const second = apply(
      first.state,
      saved({
        why: "step",
        attempt: 1,
        first_seq: 11,
        last_seq: 12,
        stream_from: 500,
        stream_to: 800,
      }),
    );
    const again = apply(
      second.state,
      saved({
        attempt: 2,
        first_seq: 13,
        last_seq: 14,
        stream_from: 800,
        stream_to: 900,
      }),
    );
    // the same visit adds up, another attempt of the step is a visit of its own, and the total is the sum
    expect(again.state.agentLog?.visits).toEqual({ "write:1": 800, "write:2": 100 });
    expect(again.state.agentLog?.bytes).toBe(900);
  });

  test("t3bk2_visits_are_bounded", () => {
    const state = started();
    const log = state.agentLog;
    if (log === undefined) throw new Error("no agent log state");
    log.visits = Object.fromEntries(
      Array.from({ length: MAX_AGENT_LOG_VISITS }, (_, i) => [`n${i}:1`, 1]),
    );
    const result = apply(state, saved({ node: "write" }));
    // a visit beyond the bound counts in the total and not in the account of visits
    expect(Object.keys(result.state.agentLog?.visits ?? {})).toHaveLength(MAX_AGENT_LOG_VISITS);
    expect(result.state.agentLog?.bytes).toBe(500);
  });
});

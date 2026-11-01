import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  type CallRow,
  type Decision,
  decide,
  defaultHistory,
  defaultToolCalls,
  isOwnTool,
  type JournalRecord,
  MAX_ROWS_PER_RECORD,
  MAX_TOOL_CALL_EVENTS,
  MAX_TOOL_CALL_SESSIONS,
  newToolCallsState,
  PIPELINE_TOOL_NAMES,
  parsePipeline,
  placeCall,
  placementFromJournal,
  type ResultRow,
  type RunEvent,
  type RunState,
  splitToolName,
  TOOL_CALL_ROW_BYTES_BUDGET,
  type ToolCallsPayload,
  toolCallsReport,
} from "../src";

const HEX = "b".repeat(64);
const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

// ── names ───────────────────────────────────────────────────────────────────

describe("zkrh names of tools", () => {
  test.each([
    ["mcp__my_server__do_it", { server: "my_server", tool: "do_it" }],
    ["mcp__kodel__pipeline_start", { server: "kodel", tool: "pipeline_start" }],
    ["mcp__x", { tool: "mcp__x" }],
    ["mcp____t", { tool: "mcp____t" }],
    // the first `__` after the prefix ends the server: a server name with `__` is a stated limit
    ["mcp__a__b__c", { server: "a", tool: "b__c" }],
    ["Bash", { tool: "Bash" }],
  ])("zkrh_mcp_name_parsing: %s", (name, expected) => {
    expect(splitToolName(name)).toEqual(expected);
  });

  test("zkrh_flags_own_calls_by_name_list_and_shows_server", () => {
    expect(isOwnTool("mcp__kodel__pipeline_complete_step")).toBe(true);
    expect(isOwnTool("mcp__kodel__pipeline_take_step")).toBe(true);
    expect(isOwnTool("pipeline_decide_gate")).toBe(true);
    // the name decides, so another server's tool of the same name is marked too (the row shows the server)
    expect(isOwnTool("mcp__claude_ai_Kodel__pipeline_start")).toBe(true);
    expect(isOwnTool("mcp__kodel__task_create")).toBe(false);
    expect(isOwnTool("Bash")).toBe(false);
    expect(PIPELINE_TOOL_NAMES.every((n) => n.startsWith("pipeline_"))).toBe(true);
  });
});

// ── where a call belongs ────────────────────────────────────────────────────

const entry = (node: string, attempt: number, at: number): JournalRecord => ({
  v: 2,
  seq: 0,
  ts: T0 + at,
  event: "node_entered",
  node,
  attempt,
});
const done = (node: string, attempt: number, at: number): JournalRecord => ({
  v: 2,
  seq: 0,
  ts: T0 + at,
  event: "agent_completed",
  node,
  attempt,
});

describe("zkrh where a call belongs", () => {
  // impl:1 is open 0..1000 and handed in at 1000; impl:2 is open 1100..; the pass is for impl:2 now (at 2000)
  const journal = [entry("impl", 1, 0), done("impl", 1, 1000), entry("impl", 2, 1100)];
  const context = (waits: { from: number; to: number }[] = []) =>
    placementFromJournal(
      journal,
      { node: "impl", attempt: 2 },
      T0 + 2000,
      waits.map((w) => ({ from: T0 + w.from, to: T0 + w.to })),
      T0,
    );

  test("zkrh_call_goes_to_the_next_hand_in_after_started", () => {
    expect(placeCall(T0 + 500, context())).toEqual({
      kind: "step",
      node: "impl",
      attempt: 1,
      shared: false,
    });
    // the step handed in now takes what came after the last hand-in
    expect(placeCall(T0 + 1500, context())).toEqual({
      kind: "step",
      node: "impl",
      attempt: 2,
      shared: false,
    });
  });

  test("zkrh_call_started_in_attempt_1_read_in_pass_2_credited_to_1", () => {
    // the hand-in call of attempt 1 is read by the pass of attempt 2; it started before the hand-in
    expect(placeCall(T0 + 990, context())).toMatchObject({ kind: "step", attempt: 1 });
  });

  test("zkrh_span_edges", () => {
    // equal to the hand-in: still that step; one millisecond after: the next
    expect(placeCall(T0 + 1000, context())).toMatchObject({ attempt: 1 });
    expect(placeCall(T0 + 1001, context())).toMatchObject({ attempt: 2 });
    expect(placeCall(T0 + 2000, context())).toMatchObject({ attempt: 2 });
  });

  test("zkrh_unattributed_cases", () => {
    // before the run's first call, in the future, in a wait with no agent step open, not a number
    expect(placeCall(T0 - 1, context())).toEqual({ kind: "unattributed" });
    expect(placeCall(T0 + 2001, context())).toEqual({ kind: "unattributed" });
    expect(placeCall(T0 + 600, context([{ from: 500, to: 700 }]))).toEqual({
      kind: "unattributed",
    });
    expect(placeCall(Number.NaN, context())).toEqual({ kind: "unattributed" });
    // the end of a wait is not in it
    expect(placeCall(T0 + 700, context([{ from: 500, to: 700 }]))).toMatchObject({ kind: "step" });
  });

  test("zkrh_shared_when_two_agent_steps_were_open", () => {
    // a fork: both branches entered at once, the first is handed in at 1000, the second now
    const fork = [entry("a", 1, 0), entry("b", 1, 0), done("a", 1, 1000)];
    const ctx = placementFromJournal(fork, { node: "b", attempt: 1 }, T0 + 2000, [], T0);
    expect(placeCall(T0 + 400, ctx)).toEqual({ kind: "step", node: "a", attempt: 1, shared: true });
    // after a was handed in only b is open
    expect(placeCall(T0 + 1500, ctx)).toEqual({
      kind: "step",
      node: "b",
      attempt: 1,
      shared: false,
    });
  });

  test("zkrh_fork_equal_entry_time_is_deterministic", () => {
    const fork = [entry("b", 1, 0), entry("a", 1, 0), done("a", 1, 1000)];
    const first = placeCall(
      T0 + 400,
      placementFromJournal(fork, { node: "b", attempt: 1 }, T0 + 2000, [], T0),
    );
    const again = placeCall(
      T0 + 400,
      placementFromJournal([...fork].reverse(), { node: "b", attempt: 1 }, T0 + 2000, [], T0),
    );
    // the owner is the first hand-in, whatever the order the records are read in
    expect(first).toEqual(again);
  });

  test("zkrh_shared_is_set_on_the_pass_of_the_first_branch_of_a_fork", () => {
    // the sibling is still open (it has no hand-in): the pass for the first hand-in must know it from the open steps
    const fork = [entry("a", 1, 0), entry("b", 1, 0)];
    const blind = placementFromJournal(fork, { node: "a", attempt: 1 }, T0 + 2000, [], T0);
    expect(placeCall(T0 + 400, blind)).toMatchObject({ node: "a", shared: false });
    const aware = placementFromJournal(fork, { node: "a", attempt: 1 }, T0 + 2000, [], T0, [
      { node: "a", attempt: 1 },
      { node: "b", attempt: 1 },
    ]);
    expect(placeCall(T0 + 400, aware)).toEqual({
      kind: "step",
      node: "a",
      attempt: 1,
      shared: true,
    });
  });

  test("zkrh_a_call_is_placed_in_a_step_the_journal_knows_or_nowhere", () => {
    // a property over many journals and start times: the owner is a hand-in, the step being handed in, or none
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round++) {
      const steps = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => `n${i}`);
      const journal: JournalRecord[] = [];
      let at = 0;
      for (const node of steps) {
        journal.push(entry(node, 1, at));
        at += 100 + Math.floor(next() * 900);
        journal.push(done(node, 1, at));
      }
      const current = { node: "cur", attempt: 1 };
      const now = T0 + at + 500;
      const ctx = placementFromJournal(journal, current, now, [], T0);
      const known = new Set([...steps.map((n) => `${n}:1`), "cur:1"]);
      for (let i = 0; i < 20; i++) {
        const placed = placeCall(T0 + Math.floor(next() * (at + 700)) - 100, ctx);
        if (placed.kind === "step")
          expect(known.has(`${placed.node}:${placed.attempt}`)).toBe(true);
      }
    }
  });

  test("zkrh_superseded_attempt_calls_go_to_the_next_hand_in", () => {
    const superseded = [
      entry("impl", 1, 0),
      {
        v: 2,
        seq: 0,
        ts: T0 + 500,
        event: "node_superseded",
        node: "impl",
        attempt: 1,
      } as JournalRecord,
      entry("impl", 2, 600),
      done("impl", 2, 1500),
    ];
    const ctx = placementFromJournal(superseded, { node: "impl", attempt: 3 }, T0 + 2000, [], T0);
    // attempt 1 was never handed in, so it has no hand-in of its own: its calls go to the next one
    expect(placeCall(T0 + 300, ctx)).toMatchObject({ kind: "step", node: "impl", attempt: 2 });
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

function apply(state: RunState | undefined, e: RunEvent): Extract<Decision, { ok: true }> {
  const result = decide(spec, state, e, 0);
  if (!result.ok) throw result.error;
  return result;
}

const started = (on = true) => {
  const history = defaultHistory();
  if (on) history.tool_calls = defaultToolCalls();
  return apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history }).state;
};

const call = (over: Partial<CallRow> = {}): CallRow => ({
  k: "c",
  id: "id-aaaaaaaaaaaa",
  tool: "Bash",
  started: iso(10),
  in_bytes: 12,
  node: "write",
  attempt: 1,
  ...over,
});
const result = (over: Partial<ResultRow> = {}): ResultRow => ({
  k: "r",
  id: "id-aaaaaaaaaaaa",
  ended: iso(50),
  ms: 40,
  ok: true,
  ...over,
});
const payload = (over: Partial<ToolCallsPayload> = {}): ToolCallsPayload => ({
  v: 1,
  rows: [call(), result()],
  counts: { "write:1": { Bash: 1 } },
  ...over,
});
const recorded = (
  over: Partial<Extract<RunEvent, { type: "tool_calls_recorded" }>> = {},
): RunEvent => ({
  type: "tool_calls_recorded",
  session: "s1",
  node: "write",
  attempt: 1,
  calls: payload(),
  cursor: { last_seq: 4, last_key: HEX },
  ...over,
});

describe("zkrh the account of tool calls in the run machine", () => {
  test("zkrh_not_captured_without_key", () => {
    const state = started(false);
    expect(state.toolCalls).toBeUndefined();
    expect(apply(state, recorded())).toMatchObject({ noop: true, journal: [] });
    expect(apply(state, { type: "tool_calls_failed", reason: "busy" })).toMatchObject({
      noop: true,
      journal: [],
    });
    expect(started().toolCalls).toEqual(newToolCallsState());
    const history = defaultHistory();
    history.tool_calls = { enabled: false, preview_chars: 200 };
    const off = apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history });
    expect(off.state.toolCalls).toBeUndefined();
  });

  test("zkrh_record_accepted_only_for_active_agent_visit", () => {
    const state = started();
    for (const bad of [
      recorded({ node: "approve" }),
      recorded({ attempt: 2 }),
      recorded({ node: "nope" }),
    ]) {
      expect(apply(state, bad)).toMatchObject({ noop: true, journal: [] });
    }
    const ok = apply(state, recorded());
    expect(ok.journal).toMatchObject([
      { event: "tool_calls_recorded", session: "s1", node: "write", attempt: 1 },
    ]);
    expect(ok.state.toolCalls?.events).toBe(1);
    expect(ok.state.toolCalls?.sessions["s1"]?.last_seq).toBe(4);
  });

  test("zkrh_record_refused_when_run_ended", () => {
    const ended = apply(started(), { type: "cancel" }).state;
    expect(apply(ended, recorded())).toMatchObject({ noop: true, journal: [] });
  });

  test("zkrh_refused_record_does_not_advance_cursor_retry_records_each_call_once", () => {
    const state = started();
    // refused (the step is not the one the run is at): the cursor stays
    const refused = apply(state, recorded({ node: "approve" }));
    expect(refused.noop).toBe(true);
    expect(refused.state.toolCalls?.sessions).toEqual({});
    // the retry records the rows once
    const retried = apply(state, recorded());
    const rows = (retried.journal[0]?.["calls"] as ToolCallsPayload | undefined)?.rows ?? [];
    expect(rows.filter((r) => r.k === "c")).toHaveLength(1);
    // the same cursor again is not a way to record them twice: it may only stay or move forward
    expect(
      apply(retried.state, recorded({ cursor: { last_seq: 2, last_key: HEX } })),
    ).toMatchObject({ noop: true });
  });

  test("zkrh_row_with_unknown_node_or_attempt_zero_or_above_highest_folded_to_unattributed", () => {
    const state = started();
    const rows = [
      call({ id: "id-000000000001", node: "nope", attempt: 1, shared: true }),
      call({ id: "id-000000000002", attempt: 5 }),
      call({ id: "id-000000000003", attempt: 1 }),
    ];
    const decision = apply(
      state,
      recorded({
        calls: payload({
          rows,
          counts: { "nope:1": { Bash: 1 }, "write:5": { Bash: 1 }, "write:1": { Bash: 1 } },
        }),
      }),
    );
    const out = decision.journal[0]?.["calls"] as ToolCallsPayload;
    const byId = (id: string) => out.rows.find((r) => r.id === id) as CallRow;
    expect(byId("id-000000000001").node).toBeUndefined();
    expect(byId("id-000000000001").shared).toBeUndefined();
    expect(byId("id-000000000002").attempt).toBeUndefined();
    expect(byId("id-000000000003")).toMatchObject({ node: "write", attempt: 1 });
    expect(out.counts).toEqual({ "-": { Bash: 2 }, "write:1": { Bash: 1 } });
  });

  test("zkrh_cap_reached_writes_no_more_records_and_says_so_once", () => {
    const state = started();
    if (state.toolCalls === undefined) throw new Error("no state");
    state.toolCalls.events = MAX_TOOL_CALL_EVENTS;
    expect(apply(state, recorded())).toMatchObject({ noop: true, journal: [] });
    const first = apply(state, { type: "tool_calls_failed", reason: "cap" });
    expect(first.journal).toMatchObject([{ event: "tool_calls_failed", reason: "cap" }]);
    expect(apply(first.state, { type: "tool_calls_failed", reason: "cap" })).toMatchObject({
      noop: true,
    });
  });

  test("zkrh_counts_only_records_past_the_row_budget_keep_loops_visible", () => {
    const state = started();
    if (state.toolCalls === undefined) throw new Error("no state");
    state.toolCalls.rowBytes = TOOL_CALL_ROW_BYTES_BUDGET - 10;
    const decision = apply(state, recorded());
    const out = decision.journal[0]?.["calls"] as ToolCallsPayload;
    expect(out.rows).toEqual([]);
    expect(out.rows_cut).toBe(true);
    expect(out.counts).toEqual({ "write:1": { Bash: 1 } });
    // latched: a later, smaller record must not bring rows back after rows were cut
    expect(decision.state.toolCalls?.rowBytes).toBe(TOOL_CALL_ROW_BYTES_BUDGET);
  });

  test("zkrh_session_and_id_formats_are_checked", () => {
    const state = started();
    expect(apply(state, recorded({ session: "../x" }))).toMatchObject({ noop: true });
    expect(
      apply(state, recorded({ calls: payload({ rows: [call({ id: "raw-id-from-the-log" })] }) })),
    ).toMatchObject({ noop: true });
    expect(
      apply(state, recorded({ calls: { ...payload(), v: 2 } as unknown as ToolCallsPayload })),
    ).toMatchObject({ noop: true });
    const many = Array.from({ length: MAX_ROWS_PER_RECORD + 1 }, (_, i) =>
      call({ id: `id-${String(i).padStart(12, "0")}` }),
    );
    expect(apply(state, recorded({ calls: payload({ rows: many }) }))).toMatchObject({
      noop: true,
    });
    const crowded = started();
    if (crowded.toolCalls === undefined) throw new Error("no state");
    for (let i = 0; i < MAX_TOOL_CALL_SESSIONS; i++) {
      crowded.toolCalls.sessions[`s${i}`] = { last_seq: 1, last_key: HEX };
    }
    expect(apply(crowded, recorded({ session: "another" }))).toMatchObject({ noop: true });
  });

  test("zkrh_state_holds_no_text_names_or_attempts", () => {
    const state = apply(started(), recorded()).state;
    const keys = Object.keys(state.toolCalls ?? {}).sort();
    expect(keys).toEqual(["events", "failed", "rowBytes", "sessions"]);
    expect(JSON.stringify(state.toolCalls)).not.toContain("Bash");
    expect(JSON.stringify(state.toolCalls)).not.toContain("write");
  });
});

// ── the report ──────────────────────────────────────────────────────────────

/** The journal records a run with the given payloads would have, in order. */
function journalOf(...payloads: ToolCallsPayload[]): JournalRecord[] {
  return payloads.map((calls, i) => ({
    v: 2,
    seq: i,
    ts: T0 + i,
    event: "tool_calls_recorded",
    session: "s1",
    node: "write",
    attempt: 1,
    calls,
    cursor: { last_seq: i + 1, last_key: HEX },
  }));
}

describe("zkrh the report of tool calls", () => {
  const state = (): RunState => apply(started(), { type: "tick" }).state;

  test("zkrh_call_and_result_rows_join_by_id", () => {
    const report = toolCallsReport(state(), journalOf(payload()));
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.unverified).toBe(true);
    expect(report.attempts).toHaveLength(1);
    const attempt = report.attempts[0];
    expect(attempt).toMatchObject({ node: "write", attempt: 1, calls: 1, failed: 0, open: 0 });
    expect(attempt?.lines[0]).toMatchObject({ tool: "Bash", ok: true, ms: 40, in_bytes: 12 });
    expect(attempt?.longest).toEqual([{ tool: "Bash", ms: 40 }]);
  });

  test("zkrh_result_in_a_later_pass_joins", () => {
    const later = payload({ rows: [result({ ok: false, err: "denied", ms: 7 })], counts: {} });
    const report = toolCallsReport(state(), journalOf(payload({ rows: [call()] }), later));
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.attempts[0]).toMatchObject({ calls: 1, failed: 1, open: 0 });
    expect(report.attempts[0]?.lines[0]).toMatchObject({ ok: false, err: "denied" });
  });

  test("zkrh_result_before_call", () => {
    const early = payload({ rows: [result()], counts: {} });
    const report = toolCallsReport(state(), journalOf(early, payload({ rows: [call()] })));
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.attempts[0]).toMatchObject({ failed: 0, open: 0 });
    expect(report.unjoined).toBe(0);
  });

  test("zkrh_call_without_result_is_open_in_the_report", () => {
    const report = toolCallsReport(state(), journalOf(payload({ rows: [call()] })));
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.attempts[0]).toMatchObject({ calls: 1, open: 1 });
  });

  test("zkrh_result_without_call_is_counted_unjoined", () => {
    const report = toolCallsReport(
      state(),
      journalOf(
        payload({ rows: [result({ id: "id-ffffffffffff" })], counts: { "write:1": { Bash: 1 } } }),
      ),
    );
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.unjoined).toBe(1);
  });

  test("zkrh_same_id_twice_first_wins_and_sessions_stay_apart", () => {
    const first = call({ tool: "Read" });
    const second = call({ tool: "Edit" });
    const same = toolCallsReport(
      state(),
      journalOf(payload({ rows: [first, second], counts: { "write:1": { Read: 1 } } })),
    );
    if (!("attempts" in same)) throw new Error(JSON.stringify(same));
    expect(same.attempts[0]?.lines.map((l) => l.tool)).toEqual(["Read"]);
    // another session with the same id is another call
    const other: JournalRecord = {
      ...(journalOf(payload({ rows: [call({ tool: "Edit" })] }))[0] as JournalRecord),
      session: "s2",
    };
    const apart = toolCallsReport(state(), [...journalOf(payload({ rows: [first] })), other]);
    if (!("attempts" in apart)) throw new Error(JSON.stringify(apart));
    expect(apart.attempts[0]?.lines).toHaveLength(2);
  });

  test("zkrh_many_calls_capped_counts_exact", () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      call({ id: `id-${String(i).padStart(12, "0")}`, started: iso(i) }),
    );
    const tail = Array.from({ length: 150 }, (_, i) =>
      call({ id: `id-${String(i + 150).padStart(12, "0")}`, started: iso(200 + i) }),
    );
    const report = toolCallsReport(
      state(),
      journalOf(
        payload({ rows, counts: { "write:1": { Bash: 150 } } }),
        payload({ rows: tail, counts: { "write:1": { Bash: 150 } } }),
      ),
    );
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.attempts[0]).toMatchObject({ calls: 300, omitted: 100 });
    expect(report.attempts[0]?.lines).toHaveLength(200);
  });

  test("zkrh_counts_survive_rows_cut", () => {
    const report = toolCallsReport(
      state(),
      journalOf(
        payload({ rows: [], rows_cut: true, counts: { "write:1": { Bash: 40, Read: 2 } } }),
      ),
    );
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.rows_cut).toBe(true);
    expect(report.attempts[0]).toMatchObject({ calls: 42, by_tool: { Bash: 40, Read: 2 } });
  });

  test("zkrh_shared_and_unattributed_rows_are_shown_as_such", () => {
    const rows = [
      call({ id: "id-000000000001", shared: true }),
      call({ id: "id-000000000002", node: undefined, attempt: undefined }),
    ];
    const report = toolCallsReport(
      state(),
      journalOf(payload({ rows, counts: { "write:1": { Bash: 1 }, "-": { Bash: 1 } } })),
    );
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.attempts[0]?.shared).toBe(1);
    expect(report.unattributed?.calls).toBe(1);
  });

  test("zkrh_not_captured_disabled_and_no_calls_reasons", () => {
    expect(toolCallsReport(started(false), [])).toEqual({
      not_collected: true,
      reason: "not_captured",
    });
    const history = defaultHistory();
    history.tool_calls = { enabled: false, preview_chars: 200 };
    const off = apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h", history });
    expect(toolCallsReport(off.state, [])).toEqual({ not_collected: true, reason: "disabled" });
    expect(toolCallsReport(started(), [])).toEqual({ not_collected: true, reason: "no_calls" });
    const failed = apply(started(), { type: "tool_calls_failed", reason: "log_missing" });
    expect(toolCallsReport(failed.state, failed.journal)).toEqual({
      not_collected: true,
      reason: "log_missing",
    });
  });

  test("zkrh_report_json_rows", () => {
    const report = toolCallsReport(state(), journalOf(payload()));
    const parsed = JSON.parse(JSON.stringify(report)) as {
      attempts: { lines: { tool: string }[] }[];
    };
    expect(parsed.attempts[0]?.lines[0]?.tool).toBe("Bash");
  });

  test.each([
    "session_unknown",
    "log_missing",
    "refused",
    "unreadable",
    "busy",
    "agent_unsupported",
  ] as const)("zkrh_reason_table: %s", (reason) => {
    const failed = apply(started(), { type: "tool_calls_failed", reason });
    expect(toolCallsReport(failed.state, failed.journal)).toEqual({
      not_collected: true,
      reason,
    });
  });

  test("zkrh_a_state_that_lost_the_key_does_not_hide_the_journal", () => {
    const lost = { ...state() } as RunState;
    delete (lost as { toolCalls?: unknown }).toolCalls;
    const report = toolCallsReport(lost, journalOf(payload()));
    expect("attempts" in report).toBe(true);
  });

  test("zkrh_a_session_named_proto_or_inherited_is_not_a_cursor", () => {
    const base = started();
    expect(apply(base, recorded({ session: "__proto__" }))).toMatchObject({ noop: true });
    // an inherited name is no stored cursor: it is a new session with its own
    const decision = apply(base, recorded({ session: "constructor" }));
    expect(Object.hasOwn(decision.state.toolCalls?.sessions ?? {}, "constructor")).toBe(true);
  });

  test("zkrh_unknown_payload_v_is_cannot_read_not_modified", () => {
    const records = journalOf({ ...payload(), v: 7 } as unknown as ToolCallsPayload);
    expect(toolCallsReport(state(), records)).toEqual({ cannot_read: true, format: "7" });
  });

  test("zkrh_unknown_failed_reason_reads_cannot_read", () => {
    const record: JournalRecord = {
      v: 2,
      seq: 0,
      ts: T0,
      event: "tool_calls_failed",
      reason: "a_reason_of_a_newer_engine",
    };
    expect(toolCallsReport(state(), [record])).toMatchObject({ cannot_read: true });
  });

  test("zkrh_behind_cursor_says_not_complete", () => {
    const s = apply(
      started(),
      recorded({ cursor: { last_seq: 4, last_key: HEX, behind: true } }),
    ).state;
    const report = toolCallsReport(s, journalOf(payload()));
    if (!("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.complete).toBe(false);
  });
});

// ── what the pure parts may not do ──────────────────────────────────────────

describe("zkrh the pure parts stay pure and information only", () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  test("zkrh_tool_calls_never_feed_check_route_or_gate", async () => {
    // the files that decide a step import nothing of the tool-call records
    for (const name of ["checks", "next-step", "result", "registry", "pipeline-diff"]) {
      const source = ts.createSourceFile(
        `${name}.ts`,
        await read(`../src/${name}.ts`),
        ts.ScriptTarget.ES2022,
        true,
      );
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .map((s) => (ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : ""));
      for (const from of imports) expect(from).not.toMatch(/tool-calls/);
    }
  });

  test("zkrh_core_has_no_io_clock_or_crypto", async () => {
    for (const name of ["tool-calls", "tool-calls-record"]) {
      const source = await read(`../src/${name}.ts`);
      expect(source).not.toMatch(/from "node:|Date\.now|new Date\(|performance\.now|createHash/);
    }
  });
});

/**
 * The stored formats (TASK-5ZCN, T-41): a run is read and written in the format it started with.
 * The golden runs of `fixtures/formats/` were written by the real engines; the codecs read them back
 * and write them again unchanged, refuse what a format cannot hold before anything is written, and
 * leave a run of format 1 able to take its next step.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_RECORD_VERSION,
  cannotHoldError,
  cannotHoldMessage,
  capabilitiesOf,
  codecFor,
  DEFAULT_STALE_MS,
  decide,
  decodeJournalRecord,
  defaultAgentLog,
  defaultHistory,
  encodeJournalRecord,
  encodeRunState,
  type JournalRecord,
  KNOWN_RECORD_VERSIONS,
  KodelError,
  type PipelineSpec,
  parsePipeline,
  parseSnapshot,
  type RunEvent,
  type RunState,
  readRunState,
  summarizeRun,
  V1_EVENTS,
  V1_STATE_KEYS,
  V2_ONLY_EVENTS,
} from "../src";

const FORMATS = new URL("../../../fixtures/formats/", import.meta.url).pathname;

/** Every run directory of a format directory, with its raw state and its journal lines. */
function fixtureRuns(
  format: string,
): { id: string; dir: string; state: string; journal: string[] }[] {
  const dir = join(FORMATS, format);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
    .map((e) => {
      const runDir = join(dir, e.name);
      return {
        id: e.name,
        dir: runDir,
        state: readFileSync(join(runDir, "state.json"), "utf8"),
        journal: readFileSync(join(runDir, "journal.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim()),
      };
    });
}

/** The same JSON whatever the order of keys. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

function refusal(fn: () => unknown): KodelError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KodelError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("t41 the codecs read and write the golden runs unchanged", () => {
  for (const format of ["v1", "v1-open", "v2"]) {
    test(`t41_${format.replace("-", "_")}_round_trip_on_real_fixtures`, () => {
      const runs = fixtureRuns(format);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        const model = readRunState(run.state, run.id);
        const encoded = encodeRunState(model);
        // the same state, the same journal, whatever the order of keys
        expect(canonical(encoded)).toBe(canonical(JSON.parse(run.state)));
        for (const line of run.journal) {
          const raw = JSON.parse(line) as JournalRecord;
          const record = decodeJournalRecord(raw);
          expect(canonical(encodeJournalRecord(record))).toBe(canonical(raw));
        }
      }
    });
  }

  test("t41_a_fixture_of_format_1_decodes_to_the_model_of_the_engine", () => {
    for (const run of fixtureRuns("v1-open")) {
      const model = readRunState(run.state, run.id);
      expect(model.v).toBe(1);
      expect(Array.isArray(model.pauses)).toBe(true);
      expect("pause" in model).toBe(false);
    }
    const paused = fixtureRuns("v1-open").find((r) => r.id === "r_0mvxulvel_5xgk");
    const model = readRunState(paused?.state ?? "", "r_0mvxulvel_5xgk");
    expect(model.status).toBe("paused");
    expect(model.pauses).toHaveLength(1);
    // the accepted change is read as a list of effects, though it was written as one effect
    const accepted = fixtureRuns("v1-open")
      .flatMap((r) => r.journal)
      .map((line) => decodeJournalRecord(JSON.parse(line)))
      .find((r) => r.event === "pipeline_accepted");
    expect(accepted?.effects).toEqual([{ kind: "reroute", node: "test" }]);
    expect(accepted?.effect).toBeUndefined();
  });
});

describe("t41 the decoder of format 1 is closed and chosen by the number", () => {
  const base = () =>
    JSON.parse(fixtureRuns("v1-open")[0]?.state ?? "{}") as Record<string, unknown>;

  test("t41_format_by_number_v3_says_upgrade_and_v0_is_not_known", () => {
    expect(refusal(() => readRunState(JSON.stringify({ v: 3 }), "r1")).message).toContain(
      "upgrade kodel",
    );
    expect(refusal(() => readRunState(JSON.stringify({ v: 0 }), "r1")).code).toBe(
      "UNSUPPORTED_FORMAT",
    );
    expect(codecFor(2)?.version).toBe(2);
    expect(codecFor(3)).toBeUndefined();
  });

  test("t41_format_by_number_a_state_without_a_number_or_json_is_modified", () => {
    expect(refusal(() => readRunState("{not json", "r1")).code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(refusal(() => readRunState("[]", "r1")).code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(refusal(() => readRunState(JSON.stringify({ runId: "r1" }), "r1")).code).toBe(
      "STATE_MODIFIED_EXTERNALLY",
    );
  });

  test("t41_v1_later_format_key_cannot_read", () => {
    for (const key of ["pauses", "forks", "claimEvents"]) {
      const error = refusal(() => readRunState(JSON.stringify({ ...base(), [key]: [] }), "r1"));
      expect(error.code).toBe("UNSUPPORTED_FORMAT");
      expect(error.message).toContain("belongs to a later format");
      expect(error.message).not.toContain("modified");
    }
    const state = base();
    const visits = [
      {
        node: "a",
        attempt: 1,
        visitId: 1,
        phase: "agent",
        checkIndex: 0,
        restarts: 0,
        startedAt: 1,
        spec: "h",
      },
    ];
    const error = refusal(() => readRunState(JSON.stringify({ ...state, active: visits }), "r1"));
    expect(error.message).toContain("an active visit");
    expect(error.message).toContain("later format");
  });

  test("t41_v1_unknown_key_cannot_read", () => {
    const top = refusal(() => readRunState(JSON.stringify({ ...base(), surprise: 1 }), "r1"));
    expect(top.code).toBe("UNSUPPORTED_FORMAT");
    expect(top.message).toContain("format 1 never had");
    const nodes = base().nodes as Record<string, Record<string, unknown>>;
    const [slug] = Object.keys(nodes);
    const node = { ...(nodes[slug as string] ?? {}), extra: true };
    expect(
      refusal(() =>
        readRunState(JSON.stringify({ ...base(), nodes: { [slug as string]: node } }), "r1"),
      ).message,
    ).toContain("extra");
  });

  test("t41_v1_unknown_value_cannot_read", () => {
    expect(
      refusal(() => readRunState(JSON.stringify({ ...base(), status: "sleeping" }), "r1")).message,
    ).toContain("the status");
  });
});

/** A run of format 1 that has just begun: a fresh state of this engine with the fields format 1 lacks removed. */
function v1Start(spec: PipelineSpec, event: RunEvent = start()): RunState {
  const started = decide(spec, undefined, event, 0);
  if (!started.ok) throw started.error;
  const raw = JSON.parse(JSON.stringify(started.encoded?.state)) as Record<string, unknown>;
  raw.v = 1;
  delete raw.pauses;
  for (const visit of (raw.active as Record<string, unknown>[]) ?? []) delete visit.spec;
  return readRunState(JSON.stringify(raw), "r1");
}
const start = (): RunEvent => ({ type: "start", runId: "r1", task: "t", specHash: "h" });

const AGENT_THEN_COMMAND = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - { slug: a, kind: agent, prompt: a, outcomes: [alt] }",
    "  - { slug: c, kind: command, command: 'true' }",
    "edges:",
    "  - { from: a, to: c }",
    "  - { from: a, to: c, when: alt }",
    "  - { from: c, to: a, when: failed }",
    "",
  ].join("\n"),
);

describe("t41 a run of format 1 takes its next step", () => {
  test("t41_d8_v1_first_step_is_not_refused", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    const done = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const stored = done.encoded?.state as { v: number; active: Record<string, unknown>[] };
    expect(stored.v).toBe(1);
    // a command is running and its visit holds no `spec`: format 1 has none
    expect(stored.active).toHaveLength(1);
    expect("spec" in (stored.active[0] ?? {})).toBe(false);
    // the engine still labels the work it issues with the version it was issued under
    const command = done.effects.find((e) => e.type === "run_command");
    expect(command).toMatchObject({ type: "run_command", spec: "h" });
    for (const record of done.encoded?.journal ?? []) expect(record.v).toBe(1);
  });

  test("t41_v1_stale_result_refused_by_spec_hash", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    const running = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    if (!running.ok) throw running.error;
    // a result issued under another version of the pipeline is dropped as a repeat
    const stale = decide(
      AGENT_THEN_COMMAND,
      running.state,
      {
        type: "work_finished",
        node: "c",
        attempt: 1,
        passed: true,
        reason: "ok",
        specHash: "older",
      },
      2,
    );
    expect(stale.ok && stale.noop).toBe(true);
  });

  test("t41_v1_stale_result_matches_the_recording_of_the_old_engine", () => {
    // `stale-result.json` was recorded from the engine of 12f8578: a result carrying another version's
    // hash was a noop repeat and wrote nothing
    const recording = JSON.parse(
      readFileSync(join(FORMATS, "v1-open", "stale-result.json"), "utf8"),
    ) as {
      event: { node: string; specHash: string };
      decision: { ok: boolean; noop: boolean; journal_records: number };
    };
    const state = v1Start(AGENT_THEN_COMMAND);
    const running = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    if (!running.ok) throw running.error;
    const result = decide(
      AGENT_THEN_COMMAND,
      running.state,
      {
        type: "work_finished",
        node: "c",
        attempt: 1,
        passed: true,
        reason: "",
        specHash: `${recording.event.specHash}-older`,
      },
      2,
    );
    expect(result.ok).toBe(recording.decision.ok);
    expect(result.ok && result.noop).toBe(recording.decision.noop);
    expect(result.ok ? (result.encoded?.journal.length ?? 0) : -1).toBe(
      recording.decision.journal_records,
    );
  });

  test("t41_v1_declared_outcome_is_not_kept_on_the_node", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    const done = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1, outcome: "alt" },
      1,
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const stored = done.encoded?.state as { nodes: Record<string, Record<string, unknown>> };
    expect("declared" in (stored.nodes.a ?? {})).toBe(false);
  });

  test("t41_v1_pipeline_with_a_join_is_refused_before_anything_is_written", () => {
    const forked = parsePipeline(
      [
        "name: p",
        "nodes:",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: x, kind: agent, prompt: x }",
        "  - { slug: y, kind: agent, prompt: y }",
        "  - { slug: m, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: a, to: x }",
        "  - { from: a, to: y }",
        "  - { from: x, to: m }",
        "  - { from: y, to: m }",
        "",
      ].join("\n"),
    );
    const state = v1Start(AGENT_THEN_COMMAND);
    const result = decide(
      forked,
      state,
      {
        type: "pipeline_accepted",
        from: "h",
        to: "h2",
        source: "file",
        before: AGENT_THEN_COMMAND,
      },
      1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(result.error.message).toBe(
      cannotHoldMessage(1, "a pipeline with a fork and a join", "r1"),
    );
  });

  test("t41_decide_returns_encoded_or_refusal: a format-1 decision carries what is to be written, never both", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    const ok = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    expect(ok.ok && ok.encoded !== undefined).toBe(true);
    const refused = decide(
      AGENT_THEN_COMMAND,
      { ...state, forks: {} } as RunState,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    expect(refused.ok).toBe(false);
    expect("encoded" in refused).toBe(false);
  });

  test("t41_v1_run_continues_in_format_1_on_each_write_path: tick and heartbeat keep format 1", () => {
    const started = decide(
      AGENT_THEN_COMMAND,
      v1Start(AGENT_THEN_COMMAND),
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    if (!started.ok) throw started.error;
    for (const event of [
      { type: "heartbeat", node: "c", attempt: 1 },
      { type: "tick" },
    ] as RunEvent[]) {
      const done = decide(AGENT_THEN_COMMAND, started.state, event, 2);
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      expect(done.encoded).toBeDefined();
      expect((done.encoded as { state: { v: number } }).state.v).toBe(1);
      for (const record of done.encoded?.journal ?? []) expect(record.v).toBe(1);
    }
  });

  test("t41_refusal_carries_how_to_upgrade: the way up is in the details, not only in the text", () => {
    const error = cannotHoldError(1, "a second pause", "r_0abcdefgh_ijkl");
    expect(error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(JSON.stringify(error.details)).toContain("kodel migrate r_0abcdefgh_ijkl");
    expect(error.message).toContain("only a person can run it");
  });

  test("t41_v1_take_step_answers_nothing_to_take", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    const taken = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "step_claimed", token: "w", ttlMs: 1000 },
      1,
    );
    expect(taken.ok && taken.noop).toBe(true);
  });

  test("t41_d1_snapshot_duplicate_edge_first_wins", () => {
    const text = [
      "name: p",
      "nodes:",
      "  - { slug: a, kind: agent, prompt: a, outcomes: [alt] }",
      "  - { slug: first, kind: agent, prompt: f }",
      "  - { slug: second, kind: agent, prompt: s }",
      "edges:",
      "  - { from: a, to: first, when: alt }",
      "  - { from: a, to: second, when: alt }",
      "  - { from: a, to: first }",
      "",
    ].join("\n");
    // new text: the duplicate is a fork without a join, an error
    expect(() => parsePipeline(text)).toThrow();
    // a snapshot written before forks: the first edge wins, whatever format the run lives in now
    const spec = parseSnapshot(text, { firstDuplicateEdgeWins: true });
    expect(spec.firstDuplicateEdgeWins).toBe(true);
    for (const lives of [1, 2] as const) {
      let state = v1Start(spec, start());
      if (lives === 2) state = { ...state, v: 2, pauses: [] } as RunState;
      const done = decide(
        spec,
        state,
        { type: "agent_completed", node: "a", attempt: 1, outcome: "alt" },
        1,
      );
      expect(done.ok).toBe(true);
      if (!done.ok) continue;
      const entered = done.journal.filter((r) => r.event === "node_entered").map((r) => r.node);
      expect(entered).toEqual(["first"]);
      expect(done.journal.some((r) => r.event === "fork_started")).toBe(false);
    }
  });
});

describe("t41 the kept pipeline of the duplicate-edge fixture routes as the old engine did", () => {
  test("t41_d1_fixture_3_routes_to_the_target_the_old_engine_recorded", () => {
    const dir = join(FORMATS, "v1-open", "r_0mvxulxyp_gmed");
    const recording = JSON.parse(
      readFileSync(join(FORMATS, "v1-open", "routing-result.json"), "utf8"),
    ) as { outcome: string; target_entered: string; target_attempt: number };
    const specFile = readdirSync(join(dir, "specs")).find((name) => name.endsWith(".yaml"));
    const spec = parseSnapshot(readFileSync(join(dir, "specs", specFile ?? ""), "utf8"), {
      firstDuplicateEdgeWins: true,
    });
    let state = v1Start(spec);
    const entered: string[] = [];
    const step = (event: RunEvent, at: number) => {
      const done = decide(spec, state, event, at);
      if (!done.ok) throw done.error;
      state = done.state;
      for (const r of done.journal) if (r.event === "node_entered") entered.push(String(r.node));
    };
    // the recorded run: the check failed on the first attempt and passed on the second
    step({ type: "agent_completed", node: "work", attempt: 1, outcome: recording.outcome }, 1);
    step(
      { type: "check_finished", node: "work", attempt: 1, index: 0, passed: false, reason: "x" },
      2,
    );
    step({ type: "agent_completed", node: "work", attempt: 2, outcome: recording.outcome }, 3);
    step(
      { type: "check_finished", node: "work", attempt: 2, index: 0, passed: true, reason: "" },
      4,
    );
    expect(entered.at(-1)).toBe(recording.target_entered);
    expect(state.active.map((v) => [v.node, v.attempt])).toEqual([
      [recording.target_entered, recording.target_attempt],
    ]);
  });
});

describe("t41 what format 1 cannot hold is refused by the encoder, nothing is dropped", () => {
  const paused = () =>
    readRunState(fixtureRuns("v1-open").find((r) => r.id === "r_0mvxulvel_5xgk")?.state ?? "", "x");

  test("t41_encode_refuses_a_second_pause_and_forks_and_claims", () => {
    const model = paused();
    const pause = model.pauses[0];
    if (!pause) throw new Error("fixture has a pause");
    for (const [state, what] of [
      [{ ...model, pauses: [pause, pause] }, "more than one pause"],
      [{ ...model, forks: {} }, "a fork"],
      [{ ...model, claimEvents: { claimed: 0, conflicts: 0 } }, "claim"],
      [{ ...model, pauses: [], status: "paused" }, "do not agree"],
      [{ ...model, status: "running" }, "do not agree"],
    ] as [RunState, string][]) {
      const error = refusal(() => encodeRunState(state));
      expect(error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
      expect(error.message).toContain(what);
    }
  });

  test("t41_encode_is_an_allow_list", () => {
    const model = paused();
    const nodes = Object.fromEntries(
      Object.entries(model.nodes).map(([slug, node]) => [slug, { ...node, declared: "x" }]),
    );
    expect(refusal(() => encodeRunState({ ...model, nodes })).message).toContain("declared");
    const unlisted = { ...model, surprise: 1 } as unknown as RunState;
    expect(refusal(() => encodeRunState(unlisted)).message).toContain("surprise");
  });

  test("t41_encode_journal_refuses_events_and_fork_fields_of_a_later_format", () => {
    const record = (event: string, extra: Record<string, unknown> = {}): JournalRecord => ({
      v: 1,
      seq: 1,
      ts: 1,
      event,
      ...extra,
    });
    for (const event of V2_ONLY_EVENTS) {
      expect(refusal(() => encodeJournalRecord(record(event))).code).toBe(
        "UNSUPPORTED_FORMAT_FEATURE",
      );
    }
    expect(
      refusal(() => encodeJournalRecord(record("node_entered", { fork: "f1" }))).message,
    ).toContain("fork attribution");
    expect(refusal(() => encodeJournalRecord(record("something_new"))).code).toBe(
      "UNSUPPORTED_FORMAT_FEATURE",
    );
    for (const event of V1_EVENTS) expect(() => encodeJournalRecord(record(event))).not.toThrow();
    // one change, one effect: written the way format 1 wrote it
    expect(
      encodeJournalRecord(
        record("pipeline_accepted", { effects: [{ kind: "recheck", node: "a" }] }),
      ),
    ).toMatchObject({ effect: { kind: "recheck", node: "a" } });
    expect(encodeJournalRecord(record("pipeline_accepted", { effects: [] }))).toMatchObject({
      effect: { kind: "none" },
    });
    expect(
      refusal(() =>
        encodeJournalRecord(
          record("pipeline_accepted", {
            effects: [
              { kind: "recheck", node: "a" },
              { kind: "restart", node: "b" },
            ],
          }),
        ),
      ).message,
    ).toContain("more than one effect");
  });

  test("t41_model_and_event_key_tables_are_complete", () => {
    // The tables of fields are typed by the model (`satisfies Record<keyof RunState, ...>`), so
    // `typecheck` fails for a field nobody decided on. Here: every key the real v1 runs carry is in
    // the tables, and the names the machine passes to `log(...)` are the ones format 1 allows or
    // knows it lacks.
    for (const run of fixtureRuns("v1").concat(fixtureRuns("v1-open"))) {
      for (const key of Object.keys(JSON.parse(run.state))) expect(V1_STATE_KEYS).toContain(key);
    }
    const source = readFileSync(new URL("../src/run.ts", import.meta.url), "utf8");
    const names = new Set(
      [...source.matchAll(/this\.log\("([a-z_]+)"/g)].map((m) => m[1] as string),
    );
    expect(names.size).toBeGreaterThan(20);
    for (const name of names) {
      expect(V1_EVENTS.includes(name) || V2_ONLY_EVENTS.includes(name), name).toBe(true);
    }
  });
});

describe("t41 an event the engine does not know", () => {
  test("t41_unknown_event_is_ignored_by_the_current_engine", () => {
    // A later engine may journal an event this one has no name for. The journal is only appended to
    // and the state decides every step, so the record must read, write back and report as if absent.
    for (const run of fixtureRuns("v2")) {
      const state = readRunState(run.state, run.id);
      const journal = run.journal.map((line) => decodeJournalRecord(JSON.parse(line)));
      const before = journal.at(-1);
      if (before === undefined) continue;
      const foreign = {
        v: state.v,
        seq: before.seq,
        ts: before.ts,
        event: "event_of_a_later_engine",
        session: "s-1",
        name: "a name",
      } as JournalRecord;
      const decoded = decodeJournalRecord(JSON.parse(JSON.stringify(foreign)));
      expect(canonical(encodeJournalRecord(decoded))).toBe(canonical(foreign));
      const withIt = [...journal.slice(0, -1), foreign, before];
      expect(canonical(summarizeRun(state, withIt))).toBe(canonical(summarizeRun(state, journal)));
    }
  });
});

describe("t41 the event that names a session", () => {
  test("t41_session_named_event_is_v2_only", () => {
    expect(V2_ONLY_EVENTS).toContain("agent_session_named");
    expect(V1_EVENTS).not.toContain("agent_session_named");
    expect(capabilitiesOf(1).sessionNames).toBe(false);
    expect(capabilitiesOf(2).sessionNames).toBe(true);
    const record = {
      v: 1,
      seq: 3,
      ts: 3,
      event: "agent_session_named",
      session: "s1",
      name: "n",
    } as JournalRecord;
    expect(refusal(() => encodeJournalRecord(record)).code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(encodeJournalRecord({ ...record, v: 2 })).toEqual({ ...record, v: 2 });
  });

  test("t41_session_named_is_a_quiet_no_op_in_format_1", () => {
    const history = defaultHistory();
    history.agent_log = defaultAgentLog();
    const event = { ...start(), history } as RunEvent;
    const state = v1Start(AGENT_THEN_COMMAND, event);
    expect(state.v).toBe(1);
    expect(state.agentLog).toBeDefined();
    const before = JSON.stringify(encodeRunState(state));
    const result = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_session_named", session: "s1", name: "n", name_hash: "a".repeat(64) },
      5,
    );
    // not a refusal from the codec, which would offer the agent an upgrade it does not need
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.noop).toBe(true);
      expect(result.journal).toEqual([]);
      expect(JSON.stringify(encodeRunState(result.state))).toBe(before);
    }
  });

  test("t41_session_name_additions_change_no_decision", () => {
    // The field of the executor and the event, on a golden run of format 2: stripped, the run reports
    // and reads the same; written back, it is as it was read.
    for (const run of fixtureRuns("v2")) {
      const state = readRunState(run.state, run.id);
      const journal = run.journal.map((line) => decodeJournalRecord(JSON.parse(line)));
      const first = journal[0];
      if (first === undefined) continue;
      const withName = journal.map((r) =>
        r.event === "run_started" && typeof r.executor === "object" && r.executor !== null
          ? ({
              ...r,
              executor: { ...r.executor, session_name: { value: "a name", source: "derived" } },
            } as JournalRecord)
          : r,
      );
      const event = {
        v: state.v,
        seq: first.seq,
        ts: first.ts,
        event: "agent_session_named",
        session: "s-1",
        name: "a name",
      } as JournalRecord;
      const extended = [withName[0] as JournalRecord, event, ...withName.slice(1)];
      expect(canonical(summarizeRun(state, extended))).toBe(
        canonical(summarizeRun(state, journal)),
      );
      for (const record of extended) {
        const wire = JSON.parse(JSON.stringify(record)) as JournalRecord;
        expect(canonical(encodeJournalRecord(decodeJournalRecord(wire)))).toBe(canonical(wire));
      }
    }
  });
});

describe("t41 upgrading a run", () => {
  const NOW = 1_000_000;

  /** A run of format 1 with a command in flight whose last sign of life was at `heartbeatAt`. */
  function running(heartbeatAt: number | undefined): RunState {
    const state = v1Start(AGENT_THEN_COMMAND);
    const done = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    if (!done.ok) throw done.error;
    const visit = done.state.active[0];
    if (!visit) throw new Error("a command is running");
    const { heartbeatAt: _, ...rest } = visit;
    return {
      ...done.state,
      active: [heartbeatAt === undefined ? rest : { ...rest, heartbeatAt }],
    } as RunState;
  }

  test("t41_migrate_heartbeat_boundaries", () => {
    const upgrade = (state: RunState) =>
      decide(AGENT_THEN_COMMAND, state, { type: "run_migrated" }, NOW);
    // an engine answered a second ago: refused, and nothing is written
    const fresh = upgrade(running(NOW - 1_000));
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.error.message).toContain("an engine is working");
    // just inside the staleness window: still refused; just outside, and never answered: allowed
    expect(upgrade(running(NOW - (DEFAULT_STALE_MS - 1))).ok).toBe(false);
    for (const heartbeatAt of [NOW - DEFAULT_STALE_MS, NOW - DEFAULT_STALE_MS - 1, undefined]) {
      const done = upgrade(running(heartbeatAt));
      expect(done.ok).toBe(true);
      if (!done.ok) continue;
      const stored = done.encoded?.state as { v: number; pauses: unknown[] };
      expect(stored.v).toBe(2);
      expect(stored.pauses).toEqual([]);
      expect(done.encoded?.journal).toHaveLength(1);
      expect(done.encoded?.journal[0]).toMatchObject({
        v: 2,
        event: "run_migrated",
        from: 1,
        to: 2,
      });
    }
  });

  test("t41_migrate_is_the_only_event_that_changes_the_format", () => {
    const state = v1Start(AGENT_THEN_COMMAND);
    // every other event leaves the format of the run as it is
    const done = decide(
      AGENT_THEN_COMMAND,
      state,
      { type: "agent_completed", node: "a", attempt: 1 },
      1,
    );
    expect(done.ok && done.state.v).toBe(1);
    // a finished run is not upgraded; a run already in the newest format changes nothing
    const ended = decide(AGENT_THEN_COMMAND, state, { type: "cancel" }, 1);
    if (!ended.ok) throw ended.error;
    const refused = decide(AGENT_THEN_COMMAND, ended.state, { type: "run_migrated" }, NOW);
    expect(refused.ok).toBe(false);
    const current = decide(AGENT_THEN_COMMAND, undefined, start(), 0);
    if (!current.ok) throw current.error;
    const noop = decide(AGENT_THEN_COMMAND, current.state, { type: "run_migrated" }, NOW);
    expect(noop.ok && noop.noop).toBe(true);
    // the mark of an upgrade whose journal line was lost is written without changing the state
    const marked = decide(
      AGENT_THEN_COMMAND,
      current.state,
      { type: "run_migrated", from: 1 },
      NOW,
    );
    expect(marked.ok && marked.journal.map((r) => r.event)).toEqual(["run_migrated"]);
  });
});

describe("t41 every format has a codec and a fixture directory", () => {
  test("t41_registry_matches_fixture_directories", () => {
    const dirs = readdirSync(FORMATS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const formats = new Set<number>();
    for (const name of dirs) {
      // `v<N>` or `v<N>-<tag>`: the number is the format its codec reads
      const match = /^v(\d+)(?:-[a-z0-9-]+)?$/.exec(name);
      expect(match, `fixture directory ${name}`).not.toBeNull();
      const n = Number(match?.[1]);
      expect(codecFor(n), `a codec for ${name}`).toBeDefined();
      // a hash list is committed beside the runs, so an edit of a fixture shows
      expect(readdirSync(join(FORMATS, name))).toContain("hashes.json");
      formats.add(n);
    }
    for (const version of KNOWN_RECORD_VERSIONS) {
      expect(formats.has(version), `a fixture directory for format ${version}`).toBe(true);
      expect(codecFor(version)?.version).toBe(version);
    }
    expect(KNOWN_RECORD_VERSIONS).toContain(CURRENT_RECORD_VERSION);
  });
});

describe("t41 the capabilities of a format", () => {
  test("t41_v1_cannot_hold_forks_or_claims_and_keeps_its_old_behaviour", () => {
    const v1 = capabilitiesOf(1);
    expect(v1).toMatchObject({
      forks: false,
      claims: false,
      visitSpec: false,
      keepsDeclaredAfterFailedCheck: false,
      firstDuplicateEdgeWins: true,
      pipelineFeatures: [],
    });
    expect(capabilitiesOf(2).pipelineFeatures).toContain("join");
    expect(capabilitiesOf(2).forks).toBe(true);
  });
});

/**
 * `run_started.origin` and the journal event `agent_stopped` (the plan of manager_start_task and
 * manager_stop_agent, `docs/run-formats.md`): who started a run and who stopped its agent, as kinds. Format 2
 * is amended in place; format 1 cannot hold either.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_INSTRUCTION_MAX,
  capabilitiesOf,
  decide,
  decodeJournalRecord,
  encodeJournalRecord,
  encodeRunState,
  type JournalRecord,
  KodelError,
  normalizeOrigin,
  parsePipeline,
  type RunEvent,
  type RunState,
  readRunState,
  STOP_INSTRUCTION_MAX,
  summarizeRun,
  V1_EVENTS,
  V2_ONLY_EVENTS,
} from "../src";

const FORMATS = new URL("../../../fixtures/formats/", import.meta.url).pathname;
const OPEN_RUN = "r_0mwx8a4t9_l1xz";
const DONE_RUN = "r_0mwx8a4z5_uhx1";

const SPEC = parsePipeline(
  ["name: p", "nodes:", "  - { slug: a, kind: agent, prompt: a }", "edges: []", ""].join("\n"),
);
const start = (over: Record<string, unknown> = {}): RunEvent =>
  ({ type: "start", runId: "r1", task: "t", specHash: "h", ...over }) as RunEvent;

function started(event: RunEvent): { state: RunState; journal: JournalRecord[] } {
  const result = decide(SPEC, undefined, event, 0);
  if (!result.ok) throw result.error;
  return { state: result.state, journal: result.journal };
}

function v1State(): RunState {
  const { state } = started(start());
  const raw = JSON.parse(JSON.stringify(encodeRunState(state))) as Record<string, unknown>;
  raw.v = 1;
  delete raw.pauses;
  for (const visit of (raw.active as Record<string, unknown>[]) ?? []) delete visit.spec;
  return readRunState(JSON.stringify(raw), "r1");
}

function refusal(fn: () => unknown): KodelError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KodelError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

function fixtureRun(id: string) {
  const dir = join(FORMATS, "v2-origin", id);
  return {
    state: readFileSync(join(dir, "state.json"), "utf8"),
    journal: readFileSync(join(dir, "journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim()),
  };
}

describe("mstart the origin of a run", () => {
  test("mstart_origin_is_kept_in_the_journal_and_not_in_the_state", () => {
    const { state, journal } = started(
      start({
        origin: {
          by: "agent",
          via: "manager",
          agent_instruction: "start it now",
          forced: ["conflict", "full", "full"],
        },
      }),
    );
    const first = journal[0];
    expect(first?.event).toBe("run_started");
    // sorted in the order of the warnings, no repeat
    expect(first?.origin).toEqual({
      by: "agent",
      via: "manager",
      agent_instruction: "start it now",
      forced: ["full", "conflict"],
    });
    expect(JSON.stringify(encodeRunState(state))).not.toContain("manager");
  });

  test("mstart_origin_of_a_person_has_no_text", () => {
    const { journal } = started(start({ origin: { by: "person", via: "web" } }));
    expect(journal[0]?.origin).toEqual({ by: "person", via: "web" });
    const none = started(start());
    expect("origin" in (none.journal[0] ?? {})).toBe(false);
  });

  test("mstart_origin_words_are_bounded", () => {
    const words = "x".repeat(AGENT_INSTRUCTION_MAX + 50);
    const { journal } = started(
      start({ origin: { by: "agent", via: "manager", agent_instruction: words } }),
    );
    const origin = journal[0]?.origin as { agent_instruction: string };
    expect(origin.agent_instruction).toHaveLength(AGENT_INSTRUCTION_MAX);
  });

  test("mstart_origin_that_is_not_known_is_refused_before_anything_is_written", () => {
    for (const origin of [
      { by: "robot", via: "tui" },
      { by: "person", via: "carrier-pigeon" },
      { by: "person", via: "web", forced: ["everything"] },
      { by: "agent", via: "manager", agent_instruction: 7 },
      "agent",
    ]) {
      const result = decide(SPEC, undefined, start({ origin }), 0);
      expect(result.ok, JSON.stringify(origin)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENTS");
    }
    expect(normalizeOrigin({ by: "person" })).toBeUndefined();
  });

  test("mstart_origin_format1_refuses", () => {
    expect(capabilitiesOf(1).origin).toBe(false);
    expect(capabilitiesOf(2).origin).toBe(true);
    const record = {
      v: 1,
      seq: 1,
      ts: 1,
      event: "run_started",
      run: "r1",
      origin: { by: "person", via: "tui" },
    } as JournalRecord;
    expect(refusal(() => encodeJournalRecord(record)).code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    expect(encodeJournalRecord({ ...record, v: 2 })).toEqual({ ...record, v: 2 });
    // without the field the same record is format 1 as it stands
    const { origin: _origin, ...plain } = record;
    expect(encodeJournalRecord(plain as JournalRecord)).toEqual(plain);
  });

  test("mstart_origin_is_a_quiet_no_op_where_a_format_cannot_hold_it", () => {
    // A run of format 1 is never started with one (a new run is format 2); the engine leaves it out all the same.
    const state = v1State();
    expect(state.v).toBe(1);
    const stopped = decide(SPEC, state, { type: "agent_stopped", instruction: "x" } as RunEvent, 5);
    expect(stopped.ok && stopped.noop).toBe(true);
    expect(stopped.ok && stopped.journal).toEqual([]);
  });

  test("mstart_origin_fixture_roundtrip", () => {
    for (const id of [OPEN_RUN, DONE_RUN]) {
      const run = fixtureRun(id);
      const state = readRunState(run.state, id);
      expect(state.v).toBe(2);
      expect(canonical(encodeRunState(state))).toBe(canonical(JSON.parse(run.state)));
      for (const line of run.journal) {
        const raw = JSON.parse(line) as JournalRecord;
        expect(canonical(encodeJournalRecord(decodeJournalRecord(raw)))).toBe(canonical(raw));
      }
      // the state has no key for it
      expect(run.state).not.toContain("origin");
      expect(run.state).not.toContain("agent_stopped");
    }
    const open = fixtureRun(OPEN_RUN);
    const first = JSON.parse(open.journal[0] as string) as JournalRecord;
    expect(first.origin).toEqual({
      by: "agent",
      via: "manager",
      agent_instruction: "the person asked to start TASK-AB12 now, although another run is going",
      forced: ["full", "conflict"],
    });
    const done = JSON.parse(fixtureRun(DONE_RUN).journal[0] as string) as JournalRecord;
    expect(done.origin).toEqual({ by: "person", via: "tui" });
  });

  test("mstart_origin_fixture_decides_the_same_without_the_fields", () => {
    // Format 2 is amended in place (rule 5): an engine that ignores the field and the event reads, reports and
    // decides as this one, so a run reports the same with them stripped.
    for (const id of [OPEN_RUN, DONE_RUN]) {
      const run = fixtureRun(id);
      const state = readRunState(run.state, id);
      const journal = run.journal.map((line) => decodeJournalRecord(JSON.parse(line)));
      const stripped = journal
        .filter((r) => r.event !== "agent_stopped")
        .map((r) => {
          const { origin: _origin, ...rest } = r;
          return rest as JournalRecord;
        });
      expect(canonical(summarizeRun(state, stripped))).toBe(
        canonical(summarizeRun(state, journal)),
      );
    }
  });

  test("t41_origin_fixture_directory_is_two_runs", () => {
    const runs = readdirSync(join(FORMATS, "v2-origin"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(runs).toEqual([OPEN_RUN, DONE_RUN].sort());
  });
});

describe("mstart the event that an agent stopped the run's agent", () => {
  test("mstart_stop_event_in_journal", () => {
    const { state } = started(start());
    const result = decide(SPEC, state, { type: "agent_stopped", instruction: "pause it" }, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.noop).not.toBe(true);
    expect(result.journal).toHaveLength(1);
    expect(result.journal[0]).toMatchObject({
      v: 2,
      event: "agent_stopped",
      by: "agent",
      via: "manager",
      agent_instruction: "pause it",
    });
    // nothing of the state changes
    expect(canonical(encodeRunState(result.state))).toBe(
      canonical(encodeRunState({ ...state, seq: result.state.seq })),
    );
    // without words there is no key
    const bare = decide(SPEC, state, { type: "agent_stopped" }, 5);
    expect(bare.ok && "agent_instruction" in (bare.journal[0] ?? {})).toBe(false);
  });

  test("mstart_stop_instruction_is_bounded", () => {
    const { state } = started(start());
    const long = "y".repeat(STOP_INSTRUCTION_MAX + 100);
    const result = decide(SPEC, state, { type: "agent_stopped", instruction: long }, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const words = result.journal[0]?.agent_instruction as string;
    expect(words.length).toBe(STOP_INSTRUCTION_MAX);
  });

  test("mstart_stop_event_is_not_written_for_a_run_that_ended", () => {
    const { state } = started(start());
    const canceled = decide(SPEC, state, { type: "cancel" }, 3);
    if (!canceled.ok) throw canceled.error;
    expect(canceled.state.status).not.toBe("running");
    const result = decide(SPEC, canceled.state, { type: "agent_stopped" }, 9);
    expect(result.ok && result.noop).toBe(true);
    expect(result.ok && result.journal).toEqual([]);
  });

  test("mstart_stop_event_fixture_roundtrip", () => {
    const run = fixtureRun(OPEN_RUN);
    const records = run.journal.map((line) => JSON.parse(line) as JournalRecord);
    const stop = records.find((r) => r.event === "agent_stopped");
    expect(stop).toMatchObject({
      by: "agent",
      via: "manager",
      agent_instruction: "the person asked to stop the agent of this run",
    });
    if (stop === undefined) return;
    expect(canonical(encodeJournalRecord(decodeJournalRecord(stop)))).toBe(canonical(stop));
    // format 1 has no place for it and says so before anything is written
    expect(refusal(() => encodeJournalRecord({ ...stop, v: 1 })).code).toBe(
      "UNSUPPORTED_FORMAT_FEATURE",
    );
  });

  test("t41_stop_event_is_v2_only", () => {
    expect(V2_ONLY_EVENTS).toContain("agent_stopped");
    expect(V1_EVENTS).not.toContain("agent_stopped");
    expect(capabilitiesOf(1).agentStops).toBe(false);
    expect(capabilitiesOf(2).agentStops).toBe(true);
  });
});

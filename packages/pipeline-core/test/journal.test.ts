import { describe, expect, test } from "bun:test";
import {
  decide,
  type JournalRecord,
  MAX_LOGGED_REFUSALS,
  parsePipeline,
  type RunEvent,
  type RunState,
  summarizeRun,
} from "../src";

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: work",
    "    kind: agent",
    "    prompt: do it",
    "    outcomes: [nothing_to_change]",
    "    checks:",
    "      - { kind: command, command: make check }",
    "  - slug: build",
    "    kind: command",
    "    command: make",
    "  - slug: other",
    "    kind: agent",
    "    prompt: more",
    "edges:",
    "  - { from: work, to: build }",
    "  - { from: work, to: other, when: nothing_to_change }",
    "  - { from: build, to: other }",
    "  - { from: build, to: work, when: failed }",
    "",
  ].join("\n"),
);

function session() {
  let state: RunState | undefined;
  const journal: JournalRecord[] = [];
  const send = (event: RunEvent, now = 0) => {
    const result = decide(spec, state, event, now);
    if (result.ok) {
      state = result.state;
      journal.push(...result.journal);
    }
    return result;
  };
  send({ type: "start", runId: "r1", task: "t", specHash: "h" });
  const lines = (name: string) => journal.filter((r) => r.event === name);
  return {
    send,
    lines,
    journal,
    get state() {
      return state as RunState;
    },
  };
}

describe("what the agent said and how a step ended", () => {
  test("completing a step journals what the agent said and the way it ended", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1, summary: "wrote the plan" });
    expect(s.lines("agent_completed")).toMatchObject([
      { node: "work", attempt: 1, outcome: "passed", summary: "wrote the plan" },
    ]);
  });

  test("an outcome other than the usual one is journaled as claimed, with no summary as null", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1, outcome: "nothing_to_change" });
    expect(s.lines("agent_completed")).toMatchObject([
      { outcome: "nothing_to_change", summary: null },
    ]);
  });

  test("a repeated completion is not journaled again", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1, summary: "once" });
    s.send({ type: "agent_completed", node: "work", attempt: 1, summary: "twice" });
    expect(s.lines("agent_completed")).toHaveLength(1);
  });

  test("a completion that is refused is not journaled as one", () => {
    const s = session();
    const refused = s.send({ type: "agent_completed", node: "work", attempt: 7, summary: "x" });
    expect(refused.ok).toBe(false);
    expect(s.lines("agent_completed")).toEqual([]);
  });
});

describe("what a check and a command did", () => {
  test("a check that passed is journaled with its kind, what it exited with and how long it took", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: true,
      reason: "",
      exit: 0,
      duration_ms: 1234,
    });
    expect(s.lines("check_finished")).toMatchObject([
      {
        node: "work",
        attempt: 1,
        index: 0,
        kind: "command",
        passed: true,
        exit: 0,
        duration_ms: 1234,
      },
    ]);
    expect(s.lines("check_finished")[0]).not.toHaveProperty("reason");
  });

  test("one that failed says why, and the node's outcome carries the same reason", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: false,
      reason: "exit code 2\nmissing semicolon",
      exit: 2,
      duration_ms: 50,
    });
    expect(s.lines("check_finished")[0]).toMatchObject({
      passed: false,
      exit: 2,
      reason: "exit code 2\nmissing semicolon",
    });
    expect(s.lines("node_finished").at(-1)).toMatchObject({
      reason: "exit code 2\nmissing semicolon",
    });
  });

  test("the engine's own command is journaled too, and a duplicate result is not", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: true,
      reason: "",
    });
    const done: RunEvent = {
      type: "work_finished",
      node: "build",
      attempt: 1,
      passed: true,
      reason: "",
      exit: 0,
      duration_ms: 3000,
    };
    s.send(done);
    s.send(done);
    expect(s.lines("command_finished")).toMatchObject([
      { node: "build", attempt: 1, passed: true, exit: 0, duration_ms: 3000 },
    ]);
  });

  test("what is not known is left out rather than written as zero", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: true,
      reason: "",
    });
    const record = s.lines("check_finished")[0] as JournalRecord;
    expect(record).not.toHaveProperty("exit");
    expect(record).not.toHaveProperty("duration_ms");
  });
});

describe("reports of findings", () => {
  test("an accepted report is journaled with how complete it says it is and how many findings", () => {
    const s = session();
    s.send({
      type: "report_accepted",
      node: "work",
      attempt: 1,
      completeness: "complete",
      rows: 3,
    });
    expect(s.lines("report_accepted")).toMatchObject([
      { node: "work", attempt: 1, completeness: "complete", rows: 3 },
    ]);
  });

  test("for a node that is not there it is refused", () => {
    const s = session();
    const result = s.send({
      type: "report_accepted",
      node: "ghost",
      attempt: 1,
      completeness: "complete",
      rows: 0,
    });
    expect(result.ok).toBe(false);
  });
});

describe("refused calls", () => {
  const refusal = (n: number): RunEvent => ({
    type: "call_refused",
    about: "complete_step",
    node: "work",
    attempt: 9,
    code: "ATTEMPT_MISMATCH",
    message: `refused ${n}`,
  });

  test("a refusal is journaled with what was tried and why it was not allowed", () => {
    const s = session();
    s.send(refusal(1));
    expect(s.lines("call_refused")).toMatchObject([
      {
        about: "complete_step",
        node: "work",
        attempt: 9,
        code: "ATTEMPT_MISMATCH",
        message: "refused 1",
      },
    ]);
  });

  test("it changes nothing about what the run is doing", () => {
    const s = session();
    const before = structuredClone(s.state);
    s.send(refusal(1));
    expect(s.state.active).toEqual(before.active);
    expect(s.state.nodes).toEqual(before.nodes);
    expect(s.state.status).toBe(before.status);
  });

  test("only the first ones are kept, so that refusing over and over cannot fill the disk", () => {
    const s = session();
    for (let i = 0; i < MAX_LOGGED_REFUSALS + 50; i++) s.send(refusal(i));
    expect(s.lines("call_refused")).toHaveLength(MAX_LOGGED_REFUSALS);
    expect(s.state.refusals).toBe(MAX_LOGGED_REFUSALS);
  });

  test("long text from the agent is cut before it is written", () => {
    const s = session();
    s.send({
      type: "call_refused",
      about: "x".repeat(500),
      node: "n".repeat(500),
      code: "C".repeat(500),
      message: "m".repeat(5000),
    });
    const record = s.lines("call_refused")[0] as JournalRecord;
    expect(String(record.about).length).toBe(40);
    expect(String(record.node).length).toBe(100);
    expect(String(record.code).length).toBe(40);
    expect(String(record.message).length).toBe(300);
  });
});

describe("the report reads them", () => {
  test("what the agent said, how the checks went and what was refused all show up", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1, summary: "wrote it" }, 1_000);
    s.send(
      {
        type: "check_finished",
        node: "work",
        attempt: 1,
        index: 0,
        passed: true,
        reason: "",
        exit: 0,
        duration_ms: 400,
      },
      2_000,
    );
    s.send(
      { type: "report_accepted", node: "work", attempt: 1, completeness: "complete", rows: 2 },
      2_100,
    );
    s.send(
      {
        type: "work_finished",
        node: "build",
        attempt: 1,
        passed: true,
        reason: "",
        exit: 0,
        duration_ms: 900,
      },
      3_000,
    );
    s.send(
      {
        type: "call_refused",
        about: "complete_step",
        node: "other",
        attempt: 5,
        code: "ATTEMPT_MISMATCH",
        message: "no",
      },
      3_500,
    );
    const report = summarizeRun(s.state, s.journal);
    const work = report.nodes.find((n) => n.node === "work")?.attempts[0];
    expect(work).toMatchObject({
      summary: "wrote it",
      checks: [{ index: 0, kind: "command", passed: true, exit: 0, ms: 400 }],
      reports: [{ completeness: "complete", rows: 2 }],
    });
    expect(report.nodes.find((n) => n.node === "build")?.attempts[0]?.command).toEqual({
      passed: true,
      exit: 0,
      ms: 900,
    });
    expect(report.refused).toBe(1);
    expect(report.refusals).toEqual([
      { about: "complete_step", node: "other", code: "ATTEMPT_MISMATCH", message: "no" },
    ]);
  });

  test("a run with none of it, as an older journal, still reports", () => {
    const s = session();
    const old = s.journal.filter(
      (r) => !["agent_completed", "check_finished", "call_refused"].includes(r.event),
    );
    const report = summarizeRun(s.state, old);
    expect(report.refused).toBe(0);
    expect(report.refusals).toEqual([]);
    expect(report.nodes[0]?.attempts[0]?.summary).toBeUndefined();
  });

  test("cnz6_the_output_of_a_command_and_of_a_check_reaches_the_journal_when_given", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    const check = { ref: "artifacts/work-1-check0.txt", bytes: 12, truncated: false };
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: false,
      reason: "no",
      command: "make check",
      output: check,
    });
    expect(s.lines("check_finished")[0]).toMatchObject({ command: "make check", output: check });
  });

  test("cnz6_a_command_that_kept_its_output_or_failed_to_says_so_in_the_journal", () => {
    const passed = (extra: Partial<RunEvent>) => {
      const s = session();
      s.send({ type: "agent_completed", node: "work", attempt: 1 });
      s.send({
        type: "check_finished",
        node: "work",
        attempt: 1,
        index: 0,
        passed: true,
        reason: "",
      });
      s.send({
        type: "work_finished",
        node: "build",
        attempt: 1,
        passed: true,
        reason: "",
        ...extra,
      } as RunEvent);
      return s;
    };
    const output = { ref: "artifacts/build-1-command.txt", bytes: 3, truncated: true };
    expect(passed({ output } as Partial<RunEvent>).lines("command_finished")[0]).toMatchObject({
      output,
    });
    const failedWrite = passed({ output_error: "disk full" } as Partial<RunEvent>);
    expect(failedWrite.lines("command_finished")[0]).toMatchObject({ output_error: "disk full" });
    expect(failedWrite.lines("command_finished")[0]).not.toHaveProperty("output");
  });

  test("cnz6_a_run_whose_journal_has_no_output_fields_still_summarises", () => {
    const s = session();
    s.send({ type: "agent_completed", node: "work", attempt: 1 });
    s.send({
      type: "check_finished",
      node: "work",
      attempt: 1,
      index: 0,
      passed: true,
      reason: "",
    });
    s.send({ type: "work_finished", node: "build", attempt: 1, passed: true, reason: "", exit: 0 });
    expect(s.lines("command_finished")[0]).not.toHaveProperty("output");
    expect(() => summarizeRun(s.state, s.journal)).not.toThrow();
  });
});

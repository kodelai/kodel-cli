import { describe, expect, test } from "bun:test";
import {
  decide,
  type JournalRecord,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";
import { CONTRACT_VERSION, SERVER_INSTRUCTIONS, TOOLS } from "../src/mcp";

const spec: PipelineSpec = parsePipeline(
  [
    "name: demo",
    "version: 1",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: write",
    "    checks:",
    "      - { kind: diff, paths: ['a/**'] }",
    "      - { kind: diff, paths: ['b/**'] }",
    "  - slug: other",
    "    kind: agent",
    "    prompt: other",
    "    checks:",
    "      - { kind: diff, paths: ['src/**'] }",
    "edges:",
    "  - { from: write, to: other }",
  ].join("\n"),
);

const started = (): RunState => {
  const r = decide(spec, undefined, { type: "start", runId: "r1", task: "t", specHash: "h" }, 0);
  if (!r.ok) throw r.error;
  return r.state;
};

const note = (state: RunState, extra: Partial<Extract<RunEvent, { type: "feedback" }>>) =>
  decide(
    spec,
    state,
    { type: "feedback", category: "wrong_check", message: "fired for nothing", ...extra },
    0,
  );

const logged = (journal: JournalRecord[]) => journal.find((j) => j.event === "feedback_reported");

describe("bmbd feedback names a check", () => {
  test("bmbd_a_check_of_the_node_is_journaled", () => {
    const r = note(started(), { node: "write", check: "write/diff#2" });
    if (!r.ok) throw r.error;
    expect(logged(r.journal)).toMatchObject({ node: "write", check: "write/diff#2" });
  });

  test("bmbd_feedback_without_check_has_no_field", () => {
    const r = note(started(), { node: "write" });
    if (!r.ok) throw r.error;
    expect(logged(r.journal)).not.toHaveProperty("check");
  });

  test("bmbd_the_only_active_node_is_used_without_node", () => {
    const r = note(started(), { check: "write/diff#1" });
    if (!r.ok) throw r.error;
    expect(logged(r.journal)).toMatchObject({ node: "write", check: "write/diff#1" });
  });

  test("bmbd_unknown_id_is_refused_and_lists_the_valid_ones", () => {
    const r = note(started(), { node: "write", check: "write/diff#3" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGUMENTS");
    expect(JSON.stringify(r.error.issues)).toContain("write/diff#2");
  });

  test("bmbd_id_of_another_node_is_refused", () => {
    const r = note(started(), { node: "write", check: "other/diff#1" });
    expect(r.ok === false && r.error.code).toBe("INVALID_ARGUMENTS");
  });

  test("bmbd_unknown_node_is_refused", () => {
    const r = note(started(), { node: "nope", check: "nope/diff#1" });
    expect(r.ok === false && r.error.code).toBe("UNKNOWN_NODE");
  });

  test("bmbd_ids_in_another_case_with_spaces_or_control_characters_are_refused", () => {
    for (const check of [
      "WRITE/DIFF#1",
      " write/diff#1",
      "write/diff#1 ",
      "write/diff#1\u001b[31m",
    ]) {
      const r = note(started(), { node: "write", check });
      expect(r.ok, check).toBe(false);
    }
  });

  test("bmbd_check_with_another_category_is_refused", () => {
    const r = note(started(), { node: "write", category: "other", check: "write/diff#1" });
    expect(r.ok === false && r.error.code).toBe("INVALID_ARGUMENTS");
  });

  test("bmbd_check_without_a_node_to_resolve_is_refused", () => {
    // no run yet moves to two active steps: here the run has none after it finishes
    const state = started();
    const none: RunState = { ...state, active: [] };
    const r = note(none, { check: "write/diff#1" });
    expect(r.ok === false && r.error.code).toBe("INVALID_ARGUMENTS");
  });

  test("bmbd_a_note_changes_nothing_in_the_run", () => {
    const before = started();
    const r = note(before, { node: "write", check: "write/diff#1" });
    if (!r.ok) throw r.error;
    // only the journal counter moves: the verdict, the attempts and the active steps do not
    expect({ ...r.state, seq: 0 }).toEqual({ ...before, seq: 0 });
    expect(r.effects).toEqual([]);
  });

  test("bmbd_the_retry_text_names_the_failed_check", () => {
    const state = started();
    const failed: RunState = {
      ...state,
      nodes: {
        ...state.nodes,
        write: {
          ...(state.nodes.write as NonNullable<RunState["nodes"]["write"]>),
          lastFailure: { source: "check:diff", reason: "no", check_id: "write/diff#2" },
        },
      },
    };
    const step = nextStep(spec, failed, 5_000);
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.reentry_feedback).toContain("(write/diff#2)");
  });
});

describe("bmbd the tool surface", () => {
  test("bmbd_contract_version_is_2_and_feedback_takes_check", () => {
    expect(CONTRACT_VERSION).toBe(2);
    const tool = TOOLS.find((t) => t.name === "pipeline_feedback");
    expect(Object.keys(tool?.shape ?? {})).toContain("check");
  });

  test("bmbd_the_schema_accepts_and_rejects_check", () => {
    const schema = TOOLS.find((t) => t.name === "pipeline_feedback")?.shape.check;
    expect(schema?.safeParse("write/diff#1").success).toBe(true);
    expect(schema?.safeParse(undefined).success).toBe(true);
    expect(schema?.safeParse("").success).toBe(false);
    expect(schema?.safeParse(7).success).toBe(false);
    expect(schema?.safeParse("x".repeat(201)).success).toBe(false);
  });

  test("bmbd_the_instructions_say_to_offer_wrong_check_and_name_the_check_in_a_summary", () => {
    expect(SERVER_INSTRUCTIONS).toContain("offer to record it with pipeline_feedback");
    expect(SERVER_INSTRUCTIONS).toContain("only after they agree");
    expect(SERVER_INSTRUCTIONS).toContain("the summary names its check_id");
  });
});

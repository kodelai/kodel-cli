import { describe, expect, test } from "bun:test";
import { decide, nextStep, parsePipeline, type RunEvent, type RunState } from "../src";

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
    "  - slug: build",
    "    kind: command",
    "    command: make",
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: build }",
    "  - { from: approve, to: write, when: rejected }",
    "  - { from: build, to: write, when: failed }",
    "",
  ].join("\n"),
);

function apply(state: RunState | undefined, event: RunEvent): RunState {
  const result = decide(spec, state, event, 0);
  if (!result.ok) throw result.error;
  return result.state;
}

const atGate = () => {
  let state = apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h" });
  state = apply(state, { type: "agent_completed", node: "write", attempt: 1 });
  return state;
};

const feedbackOf = (state: RunState) => {
  const step = nextStep(spec, state, 0);
  return "node" in step ? step.node.reentry_feedback : undefined;
};

describe("a node entered again by a route is told why", () => {
  test("a person's rejection reaches the node the edge leads to", () => {
    const state = apply(atGate(), {
      type: "human_decided",
      node: "approve",
      decision: "rejected",
      reason: "split it up",
    });
    expect(feedbackOf(state)).toBe("A person sent this back: split it up");
  });

  test("a red build reaches the node it routes back to", () => {
    let state = apply(atGate(), { type: "human_decided", node: "approve", decision: "approved" });
    state = apply(state, {
      type: "work_finished",
      node: "build",
      attempt: 1,
      passed: false,
      reason: "exit 2: missing semicolon",
    });
    expect(feedbackOf(state)).toContain("missing semicolon");
  });

  test("an approval carries nothing, and the reason is gone once the node passes", () => {
    const first = nextStep(
      spec,
      apply(undefined, { type: "start", runId: "r", task: "t", specHash: "h" }),
      0,
    );
    expect("node" in first && first.node.reentry_feedback).toBeFalsy();

    let state = apply(atGate(), {
      type: "human_decided",
      node: "approve",
      decision: "rejected",
      reason: "again",
    });
    state = apply(state, { type: "agent_completed", node: "write", attempt: 2 });
    state = apply(state, { type: "human_decided", node: "approve", decision: "approved" });
    expect(state.nodes.write?.lastFailure).toBeUndefined();
  });
});

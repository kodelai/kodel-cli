/**
 * What the agent is told when several decisions of a person wait at once, and what a join is told
 * when several branches failed (T-40, commit 4).
 */
import { describe, expect, test } from "bun:test";
import {
  decide,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const GATES = parsePipeline(
  yaml([
    "name: gates",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: ga, kind: human, prompt: a? }",
    "  - { slug: gb, kind: human, prompt: b? }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: ga }",
    "  - { from: plan, to: gb }",
    "  - { from: ga, to: merge, when: approved }",
    "  - { from: ga, to: merge, when: rejected }",
    "  - { from: gb, to: merge, when: approved }",
    "  - { from: gb, to: merge, when: rejected }",
  ]),
);

const COMMANDS = parsePipeline(
  yaml([
    "name: fork",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]),
);

const START: RunEvent = { type: "start", runId: "r1", task: "split the work", specHash: "h" };

function play(spec: PipelineSpec, events: RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const [i, event] of events.entries()) {
    const result = decide(spec, state, event, i * 1000);
    if (!result.ok) throw result.error;
    state = result.state;
  }
  return state as RunState;
}

describe("t40 several decisions wait at once", () => {
  const atGates = () => play(GATES, [START, { type: "agent_completed", node: "plan", attempt: 1 }]);

  test("t40_next_step_lists_several_waiting", () => {
    const step = nextStep(GATES, atGates(), 5_000);
    if (!("waiting" in step)) throw new Error("expected a waiting answer");
    expect(step.waiting).toMatchObject({ reason: "gate", node_slug: "ga", attempt: 1 });
    expect(step.waiting.also_waiting).toEqual([
      {
        reason: "gate",
        node_slug: "gb",
        prompt: "b?",
        how_to_decide: { cli: 'kodel gate approve|reject r1 --node gb --reason "..."' },
      },
    ]);
    expect(step.waiting.how_to_decide.cli).toBe(
      'kodel gate approve|reject r1 --node ga --reason "..."',
    );
  });

  test("t40_tell_the_person_names_every_waiting_decision", () => {
    const step = nextStep(GATES, atGates(), 5_000);
    if (!("waiting" in step)) throw new Error("expected a waiting answer");
    const tell = step.waiting.tell_the_person;
    expect(tell).toContain("The person also has to decide, besides this one");
    expect(tell).toContain('gate "gb" (kodel gate approve|reject r1 --node gb --reason "...")');
    expect(tell).toContain("Name each of these to them too, with its command");
    // once one is decided the other is the only one, and nothing else is named
    const one = play(GATES, [
      START,
      { type: "agent_completed", node: "plan", attempt: 1 },
      { type: "human_decided", node: "ga", decision: "approved" },
    ]);
    const next = nextStep(GATES, one, 5_000);
    if (!("waiting" in next)) throw new Error("expected a waiting answer");
    expect(next.waiting.node_slug).toBe("gb");
    expect(next.waiting.also_waiting).toBeUndefined();
    expect(next.waiting.tell_the_person).not.toContain("also has to decide");
    expect(next.waiting.how_to_decide.cli).toBe('kodel gate approve|reject r1 --reason "..."');
  });

  test("t40_reentry_feedback_lists_all_failures", () => {
    const fails = (node: string): RunEvent => ({
      type: "work_finished",
      node,
      attempt: 1,
      passed: false,
      reason: `${node} is red`,
    });
    const state = play(COMMANDS, [
      START,
      { type: "agent_completed", node: "plan", attempt: 1 },
      fails("a"),
      fails("b"),
    ]);
    const step = nextStep(COMMANDS, state, 5_000);
    if (!("node" in step)) throw new Error("expected the join's step");
    expect(step.node.slug).toBe("merge");
    expect(step.node.reentry_feedback).toBe(
      'Branches of the fork failed: "a" failed (command): a is red; "b" failed (command): b is red',
    );
    // and a join that no branch failed into starts with no such text
    const clean = play(COMMANDS, [
      START,
      { type: "agent_completed", node: "plan", attempt: 1 },
      { type: "work_finished", node: "a", attempt: 1, passed: true, reason: "" },
      { type: "work_finished", node: "b", attempt: 1, passed: true, reason: "" },
    ]);
    const plain = nextStep(COMMANDS, clean, 5_000);
    expect("node" in plain && plain.node.reentry_feedback).toBeUndefined();
  });
});

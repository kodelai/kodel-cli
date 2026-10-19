import { describe, expect, test } from "bun:test";
import {
  decide,
  type Effect,
  nextStep,
  parsePipeline,
  type RunEvent,
  type RunState,
  validatePipeline,
} from "../src";

const doc = (...lines: string[]) => `${lines.join("\n")}\n`;

/** A plan step that may also end with "nothing needs changing", which a person has to confirm. */
const PLAN = doc(
  "name: p",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: plan it",
  "    outcomes: [nothing_to_change]",
  "    checks:",
  "      - { kind: command, command: make check }",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: do it",
  "  - slug: confirm",
  "    kind: human",
  "    prompt: ok to stop here?",
  "edges:",
  "  - { from: plan, to: impl }",
  "  - { from: plan, to: confirm, when: nothing_to_change }",
  "  - { from: confirm, to: plan, when: rejected }",
);

const spec = parsePipeline(PLAN);

function messages(text: string): string[] {
  const result = validatePipeline(text);
  if (result.ok) throw new Error("expected the pipeline to be invalid");
  return result.issues.map((i) => i.message);
}

describe("an agent node's other outcomes: the pipeline", () => {
  test("a step may list them, and each one has an edge of its own", () => {
    expect(spec.nodes[0]?.params.outcomes).toEqual(["nothing_to_change"]);
    expect(spec.edges.map((e) => `${e.from}>${e.to}:${e.when}`)).toContain(
      "plan>confirm:nothing_to_change",
    );
  });

  test("an outcome nobody follows is refused, rather than ending the run by accident", () => {
    const text = PLAN.replace("  - { from: plan, to: confirm, when: nothing_to_change }\n", "");
    expect(messages(text).join("\n")).toContain(
      'can finish with "nothing_to_change" but has no outgoing edge for it',
    );
  });

  test("passed is always there and is not listed; a name is a plain label; none is listed twice", () => {
    expect(messages(PLAN.replace("[nothing_to_change]", "[passed]")).join()).toContain(
      "passed is always there",
    );
    expect(messages(PLAN.replace("[nothing_to_change]", "[Nothing To Change]")).join()).toContain(
      "lowercase letters",
    );
    expect(
      messages(
        PLAN.replace("[nothing_to_change]", "[nothing_to_change, nothing_to_change]"),
      ).join(),
    ).toContain("listed twice");
  });

  test("an outcome cannot also be the label a failed check emits", () => {
    const text = PLAN.replace(
      "{ kind: command, command: make check }",
      "{ kind: command, command: make check, on_fail: nothing_to_change }",
    );
    expect(messages(text).join()).toContain("both an outcome and a way to fail");
  });

  test("only an agent node has them: a command node does not take the field", () => {
    const text = doc(
      "name: p",
      "nodes:",
      "  - slug: build",
      "    kind: command",
      "    command: make",
      "    outcomes: [x]",
      "edges:",
      "  - { from: build, to: build, when: failed }",
    );
    expect(messages(text).join()).toContain("outcomes");
  });
});

/** Run events; a command check is answered by `checkPasses`. */
function drive(events: RunEvent[], checkPasses: (attempt: number) => boolean = () => true) {
  let state: RunState | undefined;
  const answer = (effect: Effect): RunEvent | undefined =>
    effect.type === "run_check"
      ? {
          type: "check_finished",
          node: effect.node,
          attempt: effect.attempt,
          index: effect.index,
          passed: checkPasses(effect.attempt),
          reason: checkPasses(effect.attempt) ? "" : "make check failed",
        }
      : undefined;
  const send = (first: RunEvent) => {
    const queue = [first];
    while (queue.length > 0) {
      const result = decide(spec, state, queue.shift() as RunEvent, 0);
      if (!result.ok) return result;
      state = result.state;
      for (const effect of result.effects) {
        const next = answer(effect);
        if (next) queue.push(next);
      }
    }
    return { ok: true as const };
  };
  send({ type: "start", runId: "r1", task: "t", specHash: "h" });
  const outcomes = events.map(send);
  return {
    get state() {
      return state as RunState;
    },
    outcomes,
  };
}

const finish = (attempt: number, outcome?: string): RunEvent => ({
  type: "agent_completed",
  node: "plan",
  attempt,
  ...(outcome === undefined ? {} : { outcome }),
});

describe("an agent node's other outcomes: the run", () => {
  test("with no outcome the step ends the usual way and goes on to the work", () => {
    const run = drive([finish(1)]);
    expect(run.state.active.map((v) => v.node)).toEqual(["impl"]);
    expect(run.state.nodes.plan?.outcome).toBe("passed");
  });

  test("with the outcome, once the checks pass, the run takes the edge of that outcome", () => {
    const run = drive([finish(1, "nothing_to_change")]);
    expect(run.state.nodes.plan).toMatchObject({ outcome: "nothing_to_change", status: "passed" });
    expect(run.state.active.map((v) => `${v.node}:${v.phase}`)).toEqual(["confirm:human"]);
  });

  test("saying passed is the same as saying nothing", () => {
    expect(drive([finish(1, "passed")]).state.active.map((v) => v.node)).toEqual(["impl"]);
  });

  test("the outcome is only a claim: the checks run first, and a failed one sends the step back", () => {
    const run = drive([finish(1, "nothing_to_change")], (attempt) => attempt > 1);
    // the first attempt's check failed, so nothing was routed and the step is on its second attempt
    expect(run.state.active.map((v) => `${v.node}#${v.attempt}`)).toEqual(["plan#2"]);
    expect(run.state.nodes.plan?.lastFailure?.reason).toBe("make check failed");
    // the claim did not carry over: finishing the second attempt the usual way goes to the work
    const again = drive([finish(1, "nothing_to_change"), finish(2)], (attempt) => attempt > 1);
    expect(again.state.active.map((v) => v.node)).toEqual(["impl"]);
  });

  test("an outcome the node does not have is refused with the ones it has, and changes nothing", () => {
    const run = drive([finish(1, "skip_everything")]);
    const refused = run.outcomes[0];
    expect(refused).toMatchObject({ ok: false });
    if (refused && !refused.ok) {
      expect(refused.error.code).toBe("UNKNOWN_OUTCOME");
      expect(refused.error.message).toContain("nothing_to_change");
    }
    expect(run.state.active.map((v) => `${v.node}:${v.phase}`)).toEqual(["plan:agent"]);
  });

  test("a node with no other outcomes says it only finishes the usual way", () => {
    const events: RunEvent[] = [
      finish(1),
      { type: "agent_completed", node: "impl", attempt: 1, outcome: "nothing_to_change" },
    ];
    const run = drive(events);
    const refused = run.outcomes[1];
    expect(refused).toMatchObject({ ok: false });
    if (refused && !refused.ok)
      expect(refused.error.message).toContain("only finishes the usual way");
  });

  test("the first claim stands: a second completion with another outcome changes nothing", () => {
    // a check that never answers keeps the node in its checks phase
    let state: RunState | undefined;
    const send = (event: RunEvent) => {
      const result = decide(spec, state, event, 0);
      if (!result.ok) throw result.error;
      state = result.state;
      return result;
    };
    send({ type: "start", runId: "r1", task: "t", specHash: "h" });
    send(finish(1, "nothing_to_change"));
    const second = send(finish(1));
    expect(second.noop).toBe(true);
    expect(state?.active[0]?.declared).toBe("nothing_to_change");
  });

  test("a person confirming ends the run, and rejecting sends the plan back with the reason", () => {
    const approved = drive([
      finish(1, "nothing_to_change"),
      { type: "human_decided", node: "confirm", decision: "approved" },
    ]);
    expect(approved.state.status).toBe("completed");

    const rejected = drive([
      finish(1, "nothing_to_change"),
      { type: "human_decided", node: "confirm", decision: "rejected", reason: "it is not done" },
    ]);
    expect(rejected.state.status).toBe("running");
    const step = nextStep(spec, rejected.state, 0);
    if (!("node" in step)) throw new Error("expected the plan again");
    expect(step.node).toMatchObject({ slug: "plan", attempt: 2 });
    expect(step.node.reentry_feedback).toContain("it is not done");
  });
});

describe("an agent node's other outcomes: what the agent is told", () => {
  test("the step lists them, and a step without any does not", () => {
    const first = drive([]);
    const plan = nextStep(spec, first.state, 0);
    if (!("node" in plan)) throw new Error("expected a node");
    expect(plan.node.outcomes).toEqual(["nothing_to_change"]);

    const second = drive([finish(1)]);
    const impl = nextStep(spec, second.state, 0);
    if (!("node" in impl)) throw new Error("expected a node");
    expect(impl.node.outcomes).toBeUndefined();
  });
});

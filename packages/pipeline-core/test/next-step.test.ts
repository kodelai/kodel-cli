import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decide, type Effect, nextStep, parsePipeline, type RunEvent, type RunState } from "../src";

const feature = parsePipeline(
  readFileSync(new URL("../../../examples/pipelines/feature.yaml", import.meta.url), "utf8"),
);

const TASK = "добавить лимит попыток входа";
const START: RunEvent = { type: "start", runId: "r7", task: TASK, specHash: "h" };

/** Drive the run with `answer`; an effect it returns nothing for stays pending. */
function drive(answer: (effect: Effect) => RunEvent | undefined, events: RunEvent[] = []) {
  let state: RunState | undefined;
  const send = (first: RunEvent) => {
    const queue = [first];
    while (queue.length > 0) {
      const result = decide(feature, state, queue.shift() as RunEvent, 5_000);
      if (!result.ok) throw result.error;
      state = result.state;
      for (const effect of result.effects) {
        const next = answer(effect);
        if (next) queue.push(next);
      }
    }
  };
  send(START);
  for (const event of events) send(event);
  return {
    send,
    get state() {
      return state as RunState;
    },
  };
}

const auto = (effect: Effect): RunEvent | undefined => {
  if (effect.type === "need_agent")
    return { type: "agent_completed", node: effect.node, attempt: effect.attempt };
  if (effect.type === "run_command") {
    return {
      type: "work_finished",
      node: effect.node,
      attempt: effect.attempt,
      passed: true,
      reason: "",
    };
  }
  if (effect.type === "run_check") {
    return {
      type: "check_finished",
      node: effect.node,
      attempt: effect.attempt,
      index: effect.index,
      passed: true,
      reason: "",
    };
  }
  return undefined;
};

const approve = (node: string): RunEvent => ({ type: "human_decided", node, decision: "approved" });

describe("next_step shapes", () => {
  test("an agent node: the prompt is rendered, no feedback, no result spec", () => {
    const run = drive((e) => (e.type === "need_agent" ? undefined : auto(e)));
    const step = nextStep(feature, run.state, 5_000);
    expect(step).toMatchObject({ node: { slug: "plan", kind: "agent", attempt: 1 } });
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.prompt).toContain(`Task: ${TASK}`);
    expect(step.node.prompt).toContain("docs/plans/dobavit_limit_popytok_vkhoda.md");
    expect(step.node.reentry_feedback).toBeUndefined();
    expect(step.node.result_spec).toBeUndefined();
  });

  test("hp9r_the_retry_text_names_the_check_and_keeps_the_old_text_as_a_prefix", () => {
    const run = drive((e) => {
      if (e.type === "run_check") {
        return {
          type: "check_finished",
          node: e.node,
          attempt: e.attempt,
          index: e.index,
          passed: false,
          reason: "nothing changed in docs/plans",
        };
      }
      return e.type === "need_agent" && e.attempt === 1
        ? auto(e)
        : e.type === "need_agent"
          ? undefined
          : auto(e);
    });
    const withId = nextStep(feature, run.state, 5_000);
    if (!("node" in withId)) throw new Error("expected a node");
    expect(withId.node.reentry_feedback).toBe(
      "The previous attempt failed (check:diff): nothing changed in docs/plans (plan/diff#1)",
    );

    // a failure written before the id existed has none, and reads as before
    const old = structuredClone(run.state);
    delete old.nodes.plan?.lastFailure?.check_id;
    const without = nextStep(feature, old, 5_000);
    if (!("node" in without)) throw new Error("expected a node");
    expect(without.node.reentry_feedback).toBe(
      "The previous attempt failed (check:diff): nothing changed in docs/plans",
    );
  });

  test("after a failed attempt the agent is told why", () => {
    const run = drive((e) => {
      if (e.type === "run_check") {
        return {
          type: "check_finished",
          node: e.node,
          attempt: e.attempt,
          index: e.index,
          passed: false,
          reason: "nothing changed in docs/plans",
        };
      }
      return e.type === "need_agent" && e.attempt === 1
        ? auto(e)
        : e.type === "need_agent"
          ? undefined
          : auto(e);
    });
    const step = nextStep(feature, run.state, 5_000);
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.attempt).toBe(2);
    expect(step.node.reentry_feedback).toBe(
      "The previous attempt failed (check:diff): nothing changed in docs/plans (plan/diff#1)",
    );
  });

  test("a node with a result check carries the instruction and the spec", () => {
    const run = drive(
      (e) => (e.type === "need_agent" && e.node === "review" ? undefined : auto(e)),
      [approve("plan-approval")],
    );
    const step = nextStep(feature, run.state, 5_000);
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.slug).toBe("review");
    expect(step.node.prompt).toContain("pipeline_report_result");
    expect(step.node.prompt).toContain("severity (one of blocker, critical, major, minor, info)");
    expect(step.node.result_spec).toMatchObject({
      fail_when: { severity: ["blocker", "critical", "major"] },
    });
  });

  test("a human node: a waiting gate with the instructions and how to decide", () => {
    const run = drive(auto);
    const step = nextStep(feature, run.state, 5_000);
    expect(step).toMatchObject({
      waiting: {
        reason: "gate",
        node_slug: "plan-approval",
        prompt: "Review the plan. Approve to start implementation, or reject with a reason.",
        instructions: expect.stringContaining("docs/plans/dobavit_limit_popytok_vkhoda.md"),
        how_to_decide: { cli: 'kodel gate approve|reject r7 --reason "..."' },
      },
    });
  });

  test("a gate tells the agent what to write to the person before it ends its turn", () => {
    const step = nextStep(feature, drive(auto).state, 5_000);
    if (!("waiting" in step)) throw new Error("expected waiting");
    const text = step.waiting.tell_the_person;
    for (const part of [
      "what they are asked to decide",
      "summary",
      "changes",
      "how to decide",
      "changes_unavailable",
      "never write that nothing changed",
      "changes_omitted",
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text).toContain("do not run that command");
    expect(text).toContain("end your turn");
  });

  test("engine work in progress: a running answer that says there is nothing to do", () => {
    const run = drive(
      (e) => (e.type === "run_command" && e.node === "build" ? undefined : auto(e)),
      [approve("plan-approval")],
    );
    const step = nextStep(feature, run.state, 5_000 + 42_000);
    if (!("running" in step)) throw new Error("expected running");
    expect(step.running.active).toEqual([
      { node_slug: "build", attempt: 1, kind: "command", elapsed_s: 42 },
    ]);
    expect(step.running.completed_in_run).toBe(3); // plan, plan-approval, impl
    expect(step.running.hint).toContain("nothing for you to do");
  });

  test("a paused run waits for a human, and says why and how", () => {
    const run = drive(
      (e) =>
        e.type === "run_command" && e.node === "build"
          ? {
              type: "work_finished",
              node: "build",
              attempt: e.attempt,
              passed: false,
              reason: "exit code 1",
            }
          : auto(e),
      [approve("plan-approval")],
    );
    const step = nextStep(feature, run.state, 5_000);
    if (!("waiting" in step)) throw new Error("expected waiting");
    expect(step.waiting.reason).toBe("paused");
    expect(step.waiting.node_slug).toBe("build");
    expect(step.waiting.prompt).toContain("a node failed too many times in a row");
    expect(step.waiting.prompt).toContain("exit code 1");
    expect(step.waiting.how_to_decide.cli).toBe("kodel resume r7");
  });

  test("a finished run is done, with its status", () => {
    const run = drive(auto, [approve("plan-approval"), approve("manual-test")]);
    expect(nextStep(feature, run.state, 0)).toEqual({ done: true, run_status: "completed" });
    run.send({ type: "cancel" });
    expect(nextStep(feature, run.state, 0)).toEqual({ done: true, run_status: "completed" });
    const canceled = drive(auto, [{ type: "cancel" }]);
    expect(nextStep(feature, canceled.state, 0)).toEqual({ done: true, run_status: "canceled" });
  });

  test("it never shows anything but the four shapes", () => {
    const run = drive(auto);
    const keys = Object.keys(nextStep(feature, run.state, 0));
    expect(["node", "waiting", "running", "done"]).toContain(keys[0] ?? "");
    expect(keys).toHaveLength(1);
  });
});

const timedYaml = (options: { expected?: number; timeout?: number }): string =>
  [
    "name: timed",
    "nodes:",
    "  - slug: build",
    "    kind: command",
    "    command: make",
    ...(options.expected ? [`    expected_duration: ${options.expected}`] : []),
    ...(options.timeout ? [`    timeout: ${options.timeout}`] : []),
    "  - slug: after",
    "    kind: command",
    "    command: echo ok",
    "edges:",
    "  - { from: build, to: after }",
    "  - { from: build, to: after, when: failed }",
    "  - { from: after, to: build, when: failed }",
    "",
  ].join("\n");

describe("what a step says about time and about how to do it", () => {
  const timed = parsePipeline(
    [
      "name: timed",
      "nodes:",
      "  - slug: build",
      "    kind: command",
      "    command: make",
      "    expected_duration: 90",
      "    timeout: 600",
      "  - slug: review",
      "    kind: agent",
      "    prompt: look at it",
      "    fresh_context: true",
      "edges:",
      "  - { from: build, to: review }",
      "  - { from: build, to: review, when: failed }",
      "",
    ].join("\n"),
  );

  function startedAt(spec: typeof timed, ...events: RunEvent[]) {
    let state: RunState | undefined;
    const all: RunEvent[] = [{ type: "start", runId: "r1", task: "t", specHash: "h" }, ...events];
    for (const event of all) {
      const result = decide(spec, state, event, 1_000);
      if (!result.ok) throw result.error;
      state = result.state;
    }
    return state as RunState;
  }

  test("engine work with an expected duration says how long is left and how to wait", () => {
    const step = nextStep(timed, startedAt(timed), 1_000 + 50_000);
    if (!("running" in step)) throw new Error("expected running");
    expect(step.running.active[0]).toMatchObject({
      node_slug: "build",
      elapsed_s: 50,
      expected_s: 90,
      remaining_s: 40,
    });
    expect(step.running.hint).toContain("40 more seconds");
    expect(step.running.hint).toContain("wait_s: 43");
  });

  test("work that is late says so, and does not promise an end", () => {
    const step = nextStep(timed, startedAt(timed), 1_000 + 200_000);
    if (!("running" in step)) throw new Error("expected running");
    expect(step.running.active[0]?.remaining_s).toBe(0);
    expect(step.running.hint).toContain("longer than expected");
  });

  test("a long wait is capped at 45 seconds", () => {
    const long = parsePipeline(timedYaml({ expected: 900, timeout: 1200 }));
    const step = nextStep(long, startedAt(long), 1_000);
    if (!("running" in step)) throw new Error("expected running");
    expect(step.running.hint).toContain("wait_s: 45");
  });

  test("without an expected duration the agent is only told that it can wait", () => {
    const plain = parsePipeline(timedYaml({}));
    const step = nextStep(plain, startedAt(plain), 1_000);
    if (!("running" in step)) throw new Error("expected running");
    expect(step.running.active[0]).not.toHaveProperty("expected_s");
    expect(step.running.hint).toContain("wait_s (up to 45)");
  });

  test("an agent node that asks for a fresh context says how to do the step", () => {
    const state = startedAt(timed, {
      type: "work_finished",
      node: "build",
      attempt: 1,
      passed: true,
      reason: "",
    });
    const step = nextStep(timed, state, 1_000);
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.slug).toBe("review");
    expect(step.node.execution?.instruction).toContain("fresh context");
    expect(step.node.execution?.instruction).toContain("subagent");
  });

  test("an ordinary agent node has no such instruction", () => {
    const step = nextStep(feature, startedAt(feature), 1_000);
    if (!("node" in step)) throw new Error("expected a node");
    expect(step.node.execution).toBeUndefined();
  });

  test("a paused run tells the agent to stop and pass the command on", () => {
    const run = drive(
      (e) =>
        e.type === "run_command" && e.node === "build"
          ? {
              type: "work_finished",
              node: e.node,
              attempt: e.attempt,
              passed: false,
              reason: "exit code 1",
            }
          : auto(e),
      [approve("plan-approval")],
    );
    const step = nextStep(feature, run.state, 5_000);
    if (!("waiting" in step)) throw new Error("expected waiting");
    expect(step.waiting.tell_the_person).toContain("paused");
    expect(step.waiting.tell_the_person).toContain("do not run that command");
  });
});

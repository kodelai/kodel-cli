/**
 * `model` on an agent node without `engine` (T-43): the agent that drives the run is asked to give the
 * step to a subagent on that model (to a worker started on it, in a fork worked in parallel). The field,
 * the three texts, the format gate. What the report makes of it is in `model-mark.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  capabilitiesOf,
  decide,
  defaultRegistry,
  type Effect,
  FRESH_CONTEXT_INSTRUCTION,
  hasModelSteps,
  type NextStep,
  type NextStepOptions,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
  requestedModelOf,
  validatePipeline,
} from "../src";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const one = (extra: string) =>
  yaml(["name: p", "nodes:", "  - slug: a", "    kind: agent", "    prompt: x", extra]);

const agentHandler = () => {
  const handler = defaultRegistry().node("agent");
  if (!handler) throw new Error("no agent handler");
  return handler;
};

/** A fork with two agent branches; `a` and `b` carry what the test says. */
const fork = (a: string, b: string) =>
  parsePipeline(
    yaml([
      "name: fork",
      "nodes:",
      "  - { slug: plan, kind: agent, prompt: plan }",
      `  - { slug: a, kind: agent, prompt: do a${a} }`,
      `  - { slug: b, kind: agent, prompt: do b${b} }`,
      "  - { slug: merge, kind: agent, prompt: merge, join: all }",
      "edges:",
      "  - { from: plan, to: a }",
      "  - { from: plan, to: b }",
      "  - { from: a, to: merge }",
      "  - { from: b, to: merge }",
    ]),
  );

const START: RunEvent = { type: "start", runId: "r1", task: "split the work", specHash: "h" };

function must(result: ReturnType<typeof decide>) {
  if (!result.ok) throw result.error;
  return result;
}

/** Drive a run: `reply` answers the effects (a failing check, say); agent steps wait for the test. */
function drive(spec: PipelineSpec, events: RunEvent[], reply: (e: Effect) => RunEvent | undefined) {
  let state: RunState | undefined;
  const queue = [...events];
  while (queue.length > 0) {
    const event = queue.shift() as RunEvent;
    const result = must(decide(spec, state, event, 1_000));
    state = result.state;
    for (const effect of result.effects) {
      const next = reply(effect);
      if (next) queue.push(next);
    }
  }
  return state as RunState;
}

const noEffects = () => undefined;
const planDone: RunEvent = { type: "agent_completed", node: "plan", attempt: 1 };
const PARALLEL: NextStepOptions = { agents: { mode: "parallel", maxParallel: 8 } };
const SEQUENTIAL: NextStepOptions = { agents: { mode: "sequential", maxParallel: 8 } };

const nodeOf = (step: NextStep) => {
  if (!("node" in step)) throw new Error(`expected a node answer, got ${Object.keys(step)[0]}`);
  return step.node;
};

const openFork = (spec: PipelineSpec) => drive(spec, [START, planDone], noEffects);

describe("t43 the field", () => {
  test("t43_model_without_engine_accepted", () => {
    const text = one("    model: sonnet");
    expect(validatePipeline(text).ok).toBe(true);
    const spec = parsePipeline(text);
    expect(hasModelSteps(spec)).toBe(true);
    const node = spec.nodes[0];
    expect(node && requestedModelOf(defaultRegistry(), node)).toBe("sonnet");
  });

  test("t43_model_with_engine_unchanged", () => {
    // with `engine` the value is the program's, any non-empty string, and no host agent is asked
    const text = one("    engine: rev\n    model: anthropic/claude-sonnet-4-6");
    expect(validatePipeline(text).ok).toBe(true);
    const spec = parsePipeline(text);
    expect(hasModelSteps(spec)).toBe(false);
    const node = spec.nodes[0];
    expect(node && requestedModelOf(defaultRegistry(), node)).toBeUndefined();
    const params = node?.params ?? {};
    for (const mode of ["single", "coordinator", "worker"] as const) {
      expect(agentHandler().instruction?.(params, { mode })).toBeUndefined();
    }
  });

  const rows: [string, string, boolean][] = [
    ["a family name", "sonnet", true],
    ["a full id", "claude-sonnet-5-5", true],
    ["an id with a suffix", "claude-opus-4-8[1m]", true],
    ["upper case is kept as written", "SONNET", true],
    ["a version prefix", "claude-sonnet-5", true],
    ["a space", "sonnet 5", false],
    ["a slash", "anthropic/claude", false],
    ["no letter", "5", false],
    ["no letter but dots", "4.8", false],
    ["a unicode letter", "sönnet", false],
    ["a bracket only at the start", "[1m]sonnet", false],
    ["128 characters", `a${"b".repeat(127)}`, true],
    ["129 characters", `a${"b".repeat(128)}`, false],
    ["a control character", "son\u0001net", false],
  ];
  for (const [name, value, accepted] of rows) {
    test(`t43_model_value_rules: ${name}`, () => {
      // YAML-safe: quoted, with the control character escaped
      const quoted = JSON.stringify(value);
      expect(validatePipeline(one(`    model: ${quoted}`)).ok, value).toBe(accepted);
    });
  }

  test("t43_model_value_rules: empty", () => {
    expect(validatePipeline(one('    model: ""')).ok).toBe(false);
  });

  test("t43_model_with_fresh_context_accepted", () => {
    expect(validatePipeline(one("    model: sonnet\n    fresh_context: true")).ok).toBe(true);
  });

  test("t43_model_on_other_node_kinds_refused", () => {
    const command = yaml([
      "name: p",
      "nodes:",
      "  - { slug: a, kind: command, command: 'true', model: sonnet }",
    ]);
    expect(validatePipeline(command).ok).toBe(false);
    const human = yaml([
      "name: p",
      "nodes:",
      "  - { slug: a, kind: human, prompt: ok?, model: sonnet }",
    ]);
    expect(validatePipeline(human).ok).toBe(false);
  });
});

describe("t43 the three texts", () => {
  const params = (extra: Record<string, unknown> = {}) => ({
    prompt: "x",
    model: "sonnet",
    ...extra,
  });

  test("t43_instruction_single_step", () => {
    const text = agentHandler().instruction?.(params(), { mode: "single" });
    expect(text).toContain("`sonnet`");
    expect(text).toContain("subagent");
    expect(text).toContain("say so in your summary");
    // no context is the same as `single`
    expect(agentHandler().instruction?.(params())).toBe(text);
  });

  test("t43_instruction_with_fresh_context", () => {
    const text = agentHandler().instruction?.(params({ fresh_context: true }), { mode: "single" });
    expect(text).toContain(FRESH_CONTEXT_INSTRUCTION);
    expect(text).toContain("`sonnet`");
  });

  test("t43_no_instruction_without_model", () => {
    expect(agentHandler().instruction?.({ prompt: "x" }, { mode: "single" })).toBeUndefined();
    expect(agentHandler().instruction?.({ prompt: "x", fresh_context: true })).toBe(
      FRESH_CONTEXT_INSTRUCTION,
    );
  });

  test("t43_no_instruction_with_engine", () => {
    const text = agentHandler().instruction?.(params({ engine: "rev" }), { mode: "single" });
    expect(text).toBeUndefined();
  });

  test("t43_worker_text_with_fresh_context_has_no_subagent_sentence", () => {
    const text = agentHandler().instruction?.(params({ fresh_context: true }), { mode: "worker" });
    expect(text).toContain("You run on the model `sonnet`");
    expect(text).toContain("Do not start a subagent");
    expect(text).not.toContain(FRESH_CONTEXT_INSTRUCTION);
    expect(text).not.toContain("give it to a subagent");
  });

  test("t43_coordinator_text_says_start_the_worker_on_the_model", () => {
    const text = agentHandler().instruction?.(params(), { mode: "coordinator" });
    expect(text).toContain("Start the worker for this step on the model `sonnet`");
    expect(text).not.toContain("give it to a subagent");
  });
});

describe("t43 a fork", () => {
  test("t43_coordinator_text_has_a_line_per_model_step", () => {
    const state = openFork(fork(", model: sonnet", ", model: opus"));
    const node = nodeOf(
      nextStep(fork(", model: sonnet", ", model: opus"), state, 2_000, undefined, PARALLEL),
    );
    expect(node.execution?.instruction).toContain(
      "Start the workers of these steps on these models: `a` on `sonnet`, `b` on `opus`.",
    );
    // the steps listed carry the coordinator wording, never the single-step sentence
    const steps = node.steps ?? [];
    expect(steps.map((s) => s.slug)).toEqual(["a", "b"]);
    expect(steps[0]?.execution?.instruction).toContain(
      "Start the worker for this step on the model `sonnet`",
    );
    expect(steps[1]?.execution?.instruction).toContain(
      "Start the worker for this step on the model `opus`",
    );
    for (const step of steps)
      expect(step.execution?.instruction).not.toContain("give it to a subagent");
  });

  test("t43_coordinator_text_when_only_the_second_step_has_a_model", () => {
    const spec = fork("", ", model: opus");
    const node = nodeOf(nextStep(spec, openFork(spec), 2_000, undefined, PARALLEL));
    const top = node.execution?.instruction ?? "";
    expect(top).toContain("`b` on `opus`");
    expect(top).not.toContain("`a` on");
    expect(node.steps?.[0]?.execution).toBeUndefined();
  });

  test("t43_coordinator_text_when_the_first_has_a_model_and_the_second_has_none", () => {
    const spec = fork(", model: sonnet", "");
    const node = nodeOf(nextStep(spec, openFork(spec), 2_000, undefined, PARALLEL));
    const top = node.execution?.instruction ?? "";
    expect(top).toContain("`a` on `sonnet`");
    expect(top).not.toContain("`b` on");
    expect(node.steps?.[1]?.execution).toBeUndefined();
  });

  test("t43_steps_listed_in_the_answer_carry_the_coordinator_wording", () => {
    const spec = fork(", model: sonnet, fresh_context: true", ", model: opus");
    const node = nodeOf(nextStep(spec, openFork(spec), 2_000, undefined, PARALLEL));
    for (const step of node.steps ?? []) {
      expect(step.execution?.instruction).toContain("Start the worker for this step");
      expect(step.execution?.instruction).not.toContain(FRESH_CONTEXT_INSTRUCTION);
    }
  });

  test("t43_worker_text_on_take_renewal_and_rework_never_starts_a_subagent", () => {
    const spec = fork(", model: sonnet, checks: [{ kind: command, command: c }]", ", model: opus");
    // a take, and a renewal of it: the worker asks for its step by name
    const state = openFork(spec);
    for (const nodeSlug of ["a", "a"]) {
      const taken = nodeOf(
        nextStep(spec, state, 2_000, undefined, { ...PARALLEL, nodeSlug, worker: true }),
      );
      expect(taken.execution?.instruction).toContain("You run on the model `sonnet`");
      expect(taken.execution?.instruction).not.toContain("give it to a subagent");
    }
    // its own step handed back after a failed check
    const failing = (effect: Effect): RunEvent | undefined =>
      effect.type === "run_check"
        ? {
            type: "check_finished",
            node: effect.node,
            attempt: effect.attempt,
            index: effect.index,
            passed: false,
            reason: "no",
          }
        : undefined;
    const after = drive(
      spec,
      [START, planDone, { type: "agent_completed", node: "a", attempt: 1 }],
      failing,
    );
    const again = nodeOf(
      nextStep(spec, after, 3_000, undefined, { ...PARALLEL, completionOf: "a", worker: true }),
    );
    expect(again.slug).toBe("a");
    expect(again.attempt).toBe(2);
    expect(again.execution?.instruction).toContain("You run on the model `sonnet`");
    expect(again.execution?.instruction).not.toContain("give it to a subagent");
  });

  test("t43_fork_worked_one_by_one_uses_the_single_step_text", () => {
    const spec = fork(", model: sonnet", ", model: opus");
    const node = nodeOf(nextStep(spec, openFork(spec), 2_000, undefined, SEQUENTIAL));
    expect(node.execution?.instruction).not.toContain("Start the workers of these steps");
    for (const step of node.steps ?? []) {
      expect(step.execution?.instruction).toContain("give it to a subagent started on that model");
      expect(step.execution?.instruction).not.toContain("Start the worker for this step");
    }
  });
});

describe("t43 the format", () => {
  const model = parsePipeline(one("    model: sonnet"));
  const plain = parsePipeline(one(""));

  test("t43_model_pipeline_feature_is_in_format_2_only", () => {
    expect(capabilitiesOf(1).pipelineFeatures).not.toContain("model");
    expect(capabilitiesOf(2).pipelineFeatures).toContain("model");
  });

  test("t43_format_1_run_refuses_model_step", () => {
    const started = must(decide(plain, undefined, START, 1)).state;
    const old = { ...started, v: 1 } as RunState;
    const accept = decide(
      model,
      old,
      { type: "pipeline_accepted", from: "h", to: "h2", source: "file", before: plain },
      2,
    );
    expect(accept.ok).toBe(false);
    if (!accept.ok) {
      expect(accept.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
      expect(accept.error.message).toContain("kodel migrate");
      expect(accept.error.message).toContain("asks for a model");
    }
  });

  test("t43_format_1_run_without_model_steps_unaffected", () => {
    const started = must(decide(plain, undefined, START, 1)).state;
    const old = { ...started, v: 1 } as RunState;
    const changed = parsePipeline(one("").replace("prompt: x", "prompt: y"));
    const accept = decide(
      changed,
      old,
      { type: "pipeline_accepted", from: "h", to: "h2", source: "file", before: plain },
      2,
    );
    if (!accept.ok) expect(accept.error.code).not.toBe("UNSUPPORTED_FORMAT_FEATURE");
  });

  test("t43_model_step_runs_with_engine_steps_off", () => {
    // no `engineSteps` option: the switch is off; a model step is not an engine step
    const started = must(decide(model, undefined, START, 1));
    expect(started.state.status).toBe("running");
    const answer = nextStep(model, started.state, 2_000);
    expect(nodeOf(answer).execution?.instruction).toContain("`sonnet`");
    // the control: an engine step is refused by the same options
    const engine = parsePipeline(one("    engine: rev"));
    expect(decide(engine, undefined, START, 1).ok).toBe(false);
  });
});

describe("t43 the docs", () => {
  const read = (path: string) =>
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");

  test("t43_docs_say_observed_hook_not_used", () => {
    const text = read("docs/history.md");
    expect(text).toContain("`observed-hook`; it is **not used**");
    expect(text).toContain("`declared`");
    expect(text).toContain("`derived`");
  });

  test("t43_docs_no_longer_say_model_needs_engine", () => {
    for (const path of ["docs/engines.md", "packages/pipeline-core/agent-docs/pipeline-spec.md"]) {
      expect(read(path), path).not.toContain("`model` without `engine`;");
      expect(read(path), path).not.toContain("allowed only with `engine`");
    }
  });
});

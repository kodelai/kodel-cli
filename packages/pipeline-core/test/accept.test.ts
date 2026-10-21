import { describe, expect, test } from "bun:test";
import {
  type Decision,
  decide,
  diffPipelines,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";

const TEXT = [
  "name: p",
  "nodes:",
  "  - slug: plan",
  "    kind: agent",
  "    prompt: plan it",
  "  - slug: gate",
  "    kind: human",
  "    prompt: ok?",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: write it",
  "    checks:",
  "      - { kind: diff, paths: ['src/**'], max_lines: 800 }",
  "      - { kind: command, command: bun test }",
  "  - slug: verify",
  "    kind: command",
  "    command: make verify",
  "edges:",
  "  - { from: plan, to: gate }",
  "  - { from: gate, to: impl }",
  "  - { from: gate, to: plan, when: rejected }",
  "  - { from: impl, to: verify }",
  "  - { from: verify, to: impl, when: failed }",
  "",
].join("\n");

const specOf = (text: string): PipelineSpec => parsePipeline(text);
const V1 = specOf(TEXT);

type Ok = Extract<Decision, { ok: true }>;

function step(spec: PipelineSpec, state: RunState | undefined, event: RunEvent): Ok {
  const result = decide(spec, state, event, 0, { fingerprint: (text) => `h(${text.length})` });
  if (!result.ok) throw result.error;
  return result;
}

const accept = (before: PipelineSpec, after: PipelineSpec, state: RunState, to = "h2"): Decision =>
  decide(
    after,
    state,
    { type: "pipeline_accepted", from: state.specHash, to, source: "file", before },
    0,
  );

/** A run standing on `impl`, the agent working (the plan gate approved). */
function atImpl(spec = V1): RunState {
  let state = step(spec, undefined, { type: "start", runId: "r", task: "t", specHash: "h" }).state;
  state = step(spec, state, { type: "agent_completed", node: "plan", attempt: 1 }).state;
  state = step(spec, state, { type: "human_decided", node: "gate", decision: "approved" }).state;
  return state;
}

const ok = (d: Decision): Ok => {
  if (!d.ok) throw d.error;
  return d as Ok;
};

describe("accepting another version of the pipeline", () => {
  test("a change of checks on the node being worked on only takes effect at its completion", () => {
    const after = specOf(TEXT.replace("bun test", "bun test --bail"));
    const state = atImpl();
    const decision = ok(accept(V1, after, state));
    expect(decision.state.specHash).toBe("h2");
    expect(decision.state.active[0]).toMatchObject({ node: "impl", attempt: 1, phase: "agent" });
    expect(decision.journal.find((r) => r.event === "pipeline_accepted")).toMatchObject({
      effect: { kind: "none" },
      nodes: [{ slug: "impl", changes: ["checks"] }],
    });
    const done = step(after, decision.state, { type: "agent_completed", node: "impl", attempt: 1 });
    expect(done.effects).toContainEqual(
      expect.objectContaining({ type: "run_check", index: 0, kind: "diff" }),
    );
  });

  test("a change of work closes the attempt as superseded and starts the node again", () => {
    const after = specOf(TEXT.replace("write it", "write it carefully"));
    const decision = ok(accept(V1, after, atImpl()));
    expect(decision.journal.map((r) => r.event)).toEqual([
      "pipeline_accepted",
      "node_superseded",
      "node_entered",
    ]);
    expect(decision.state.nodes.impl).toMatchObject({
      attempt: 2,
      status: "rework",
      consecutiveFailures: 0,
      extraAttempts: 1,
      lastFailure: { source: "pipeline" },
    });
    expect(decision.state.active).toHaveLength(1);
    expect(decision.effects).toContainEqual(
      expect.objectContaining({ type: "need_agent", node: "impl", attempt: 2 }),
    );
  });

  test("restart_keeps_the_diff_baseline", () => {
    const after = specOf(TEXT.replace("write it", "write it carefully"));
    const state = atImpl();
    const visitId = state.nodes.impl?.visitId;
    const decision = ok(accept(V1, after, state));
    expect(decision.state.nodes.impl?.visitId).toBe(visitId);
    const keys = decision.effects.flatMap((e) => (e.type === "take_snapshot" ? [e.key] : []));
    expect(keys.some((k) => k.startsWith("visit:"))).toBe(false);
  });

  test("a node that has finished and is not come back to cannot change", () => {
    const after = specOf(TEXT.replace("plan it", "plan it well"));
    const decision = accept(V1, after, atImpl());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe("PIPELINE_CHANGE_REFUSED");
      expect(decision.error.message).toContain('"plan"');
    }
  });

  test("nodes not reached yet and nodes of a loop may change", () => {
    const after = specOf(TEXT.replace("make verify", "make verify --all"));
    const decision = ok(accept(V1, after, atImpl()));
    expect(decision.journal.find((r) => r.event === "pipeline_accepted")).toMatchObject({
      effect: { kind: "none" },
    });
  });

  test("the name and the first node cannot change", () => {
    expect(accept(V1, specOf(TEXT.replace("name: p", "name: q")), atImpl()).ok).toBe(false);
  });

  test("a change of routing never restarts the node", () => {
    const after = specOf(TEXT.replace("  - slug: impl\n", "  - slug: impl\n    max_attempts: 9\n"));
    const decision = ok(accept(V1, after, atImpl()));
    expect(decision.journal.map((r) => r.event)).toEqual(["pipeline_accepted"]);
    expect(decision.state.active[0]?.attempt).toBe(1);
  });

  test("an added node gets a place in the run, a removed one is kept and marked", () => {
    const added = specOf(
      TEXT.replace(
        "edges:",
        ["  - slug: lint", "    kind: command", "    command: make lint", "edges:"].join("\n"),
      ).replace(
        "  - { from: impl, to: verify }\n",
        "  - { from: impl, to: lint }\n  - { from: lint, to: verify }\n  - { from: lint, to: impl, when: failed }\n",
      ),
    );
    const withLint = ok(accept(V1, added, atImpl()));
    expect(withLint.state.nodes.lint).toMatchObject({ status: "pending", attempt: 0 });

    const removed = specOf(
      TEXT.replace(/ {2}- slug: verify[\s\S]*?edges:/, "edges:")
        .replace("  - { from: impl, to: verify }\n", "")
        .replace("  - { from: verify, to: impl, when: failed }\n", ""),
    );
    const without = ok(accept(V1, removed, atImpl()));
    expect(without.state.nodes.verify?.removed).toBe(true);
  });

  test("the node the run stands on cannot be removed", () => {
    const removed = specOf(
      TEXT.replace(/ {2}- slug: impl[\s\S]*? {2}- slug: verify/, "  - slug: verify")
        .replace("  - { from: gate, to: impl }\n", "  - { from: gate, to: verify }\n")
        .replace("  - { from: impl, to: verify }\n", "")
        .replace(
          "  - { from: verify, to: impl, when: failed }\n",
          "  - { from: verify, to: plan, when: failed }\n",
        ),
    );
    expect(accept(V1, removed, atImpl()).ok).toBe(false);
  });

  test("a command or a check that is running is waited for", () => {
    let state = atImpl();
    state = step(V1, state, { type: "agent_completed", node: "impl", attempt: 1 }).state;
    expect(state.active[0]?.phase).toBe("checks");
    const after = specOf(TEXT.replace("bun test", "bun test --bail"));
    const decision = accept(V1, after, state);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.message).toContain("wait");
  });

  test("a result of the old version is dropped", () => {
    const after = specOf(TEXT.replace("make verify", "make verify --all"));
    let state = atImpl();
    state = step(V1, state, { type: "agent_completed", node: "impl", attempt: 1 }).state;
    state = step(V1, state, {
      type: "check_finished",
      node: "impl",
      attempt: 1,
      index: 0,
      passed: true,
      reason: "",
    }).state;
    // the second check is running; a result carrying the old hash arrives after the change
    state = { ...state, specHash: "h2" };
    const late = step(after, state, {
      type: "check_finished",
      node: "impl",
      attempt: 1,
      index: 1,
      passed: true,
      reason: "",
      specHash: "h",
    });
    expect(late.noop).toBe(true);
    expect(late.state.active[0]?.checkIndex).toBe(1);
  });

  test("accepting the same version twice is a repeat; a stale one is refused", () => {
    const after = specOf(TEXT.replace("make verify", "make verify --all"));
    const first = ok(accept(V1, after, atImpl()));
    const again = accept(V1, after, first.state);
    expect(again.ok && again.noop).toBe(true);
    const stale = decide(
      after,
      first.state,
      { type: "pipeline_accepted", from: "h", to: "h3", source: "file", before: V1 },
      0,
    );
    expect(stale.ok).toBe(false);
  });

  test("a finished run takes no change", () => {
    const after = specOf(TEXT.replace("make verify", "make verify --all"));
    const state = ok(decide(V1, atImpl(), { type: "cancel" }, 0)).state;
    expect(accept(V1, after, state).ok).toBe(false);
  });

  test("each attempt records the hashes of its definition", () => {
    const result = step(V1, undefined, { type: "start", runId: "r", task: "t", specHash: "h" });
    expect(result.journal.find((r) => r.event === "node_entered")).toMatchObject({
      definition: {
        work: expect.stringMatching(/^h\(\d+\)$/),
        checks: expect.stringMatching(/^h\(\d+\)$/),
        routing: expect.stringMatching(/^h\(\d+\)$/),
      },
    });
  });
});

describe("a run held back at a failure", () => {
  const HELD = TEXT.replace(
    "  - slug: impl\n",
    "  - slug: impl\n    max_consecutive_failures: 1\n",
  );
  const before = specOf(HELD);

  /** The checks of `impl` failed once, and one failure in a row is all it is allowed. */
  function heldAtCheck(): RunState {
    let state = atImpl(before);
    state = step(before, state, { type: "agent_completed", node: "impl", attempt: 1 }).state;
    state = step(before, state, {
      type: "check_finished",
      node: "impl",
      attempt: 1,
      index: 0,
      passed: false,
      reason: "1438 lines changed, more than 800",
    }).state;
    return state;
  }

  test("the run is paused with the failure of the check behind it", () => {
    const state = heldAtCheck();
    expect(state.status).toBe("paused");
    expect(state.pause).toMatchObject({ reason: "consecutive", node: "impl" });
    expect(state.nodes.impl?.lastFailure?.source).toBe("check:diff");
  });

  test("new checks are run again on the work that is there, and the failure is not counted twice", () => {
    const after = specOf(HELD.replace("max_lines: 800", "max_lines: 2000"));
    const decision = ok(accept(before, after, heldAtCheck()));
    expect(decision.state.status).toBe("running");
    expect(decision.state.pause).toBeUndefined();
    expect(decision.state.active[0]).toMatchObject({
      node: "impl",
      attempt: 1,
      phase: "checks",
      checkIndex: 0,
    });
    expect(decision.state.nodes.impl?.consecutiveFailures).toBe(0);
    expect(decision.effects).toContainEqual(
      expect.objectContaining({ type: "run_check", node: "impl", index: 0, attempt: 1 }),
    );
    expect(decision.journal.map((r) => r.event)).toEqual(["pipeline_accepted", "checks_rerun"]);

    // and the verdict of the new check goes on as any other
    const passed = [0, 1].reduce(
      (state, index) =>
        step(after, state, {
          type: "check_finished",
          node: "impl",
          attempt: 1,
          index,
          passed: true,
          reason: "",
        }).state,
      decision.state,
    );
    expect(passed.nodes.impl?.status).toBe("passed");
    expect(passed.active[0]?.node).toBe("verify");
  });

  test("a raised limit lets a run held back at its attempts go on", () => {
    const tight = specOf(
      TEXT.replace(
        "  - slug: impl\n",
        "  - slug: impl\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
      ),
    );
    let state = atImpl(tight);
    state = step(tight, state, { type: "agent_completed", node: "impl", attempt: 1 }).state;
    for (const index of [0, 1]) {
      state = step(tight, state, {
        type: "check_finished",
        node: "impl",
        attempt: 1,
        index,
        passed: true,
        reason: "",
      }).state;
    }
    state = step(tight, state, {
      type: "work_finished",
      node: "verify",
      attempt: 1,
      passed: false,
      reason: "red",
    }).state;
    expect(state.status).toBe("paused");
    expect(state.pause).toMatchObject({ reason: "total", node: "impl" });

    const loose = specOf(TEXT.replace("  - slug: impl\n", "  - slug: impl\n    max_attempts: 5\n"));
    const decision = ok(accept(tight, loose, state));
    expect(decision.state.status).toBe("running");
    expect(decision.state.active[0]).toMatchObject({ node: "impl", attempt: 2 });
  });

  test("a change that does not touch the failure leaves the run held back", () => {
    const after = specOf(HELD.replace("make verify", "make verify --all"));
    const decision = ok(accept(before, after, heldAtCheck()));
    expect(decision.state.status).toBe("paused");
    expect(decision.state.specHash).toBe("h2");
  });
});

describe("the diff of two pipelines", () => {
  test("it names what changed in each node", () => {
    const after = specOf(TEXT.replace("bun test", "bun test --bail").replace("plan it", "plan!"));
    const diff = diffPipelines(V1, after, atImpl());
    expect(diff.nodes).toEqual([
      { slug: "plan", changes: ["work"] },
      { slug: "impl", changes: ["checks"] },
    ]);
    expect(diff.refused).toBeDefined();
  });
});

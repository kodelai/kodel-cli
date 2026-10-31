import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  decide,
  type Effect,
  type EngineOptions,
  type JournalRecord,
  KodelError,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
} from "../src";

const feature = parsePipeline(
  readFileSync(new URL("../../../examples/pipelines/feature.yaml", import.meta.url), "utf8"),
);

const START: RunEvent = { type: "start", runId: "r1", task: "add login rate limit", specHash: "h" };

function must(result: ReturnType<typeof decide>) {
  if (!result.ok) throw result.error;
  return result;
}

/**
 * A tiny host: sends events, hands every effect to `answer`, and feeds back what it returns.
 * By default every command and check passes, every agent finishes at once, humans wait.
 */
function host(
  spec: PipelineSpec,
  answer: (effect: Effect, state: RunState) => RunEvent | undefined = defaultAnswer,
  options: EngineOptions = {},
) {
  let state: RunState | undefined;
  let now = 0;
  const journal: JournalRecord[] = [];
  const effects: Effect[] = [];
  const send = (first: RunEvent) => {
    const queue = [first];
    let firstResult: ReturnType<typeof decide> | undefined;
    while (queue.length > 0) {
      const event = queue.shift() as RunEvent;
      const result = decide(spec, state, event, now, options);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        throw result.error;
      }
      state = result.state;
      journal.push(...result.journal);
      for (const effect of result.effects) {
        effects.push(effect);
        const next = answer(effect, result.state);
        if (next) queue.push(next);
      }
    }
    return firstResult as ReturnType<typeof decide>;
  };
  return {
    send,
    journal,
    effects,
    advance: (ms: number) => {
      now += ms;
    },
    get state() {
      return state as RunState;
    },
  };
}

function defaultAnswer(effect: Effect): RunEvent | undefined {
  switch (effect.type) {
    case "need_agent":
      return { type: "agent_completed", node: effect.node, attempt: effect.attempt };
    case "run_command":
      return {
        type: "work_finished",
        node: effect.node,
        attempt: effect.attempt,
        passed: true,
        reason: "",
      };
    case "run_check":
      return {
        type: "check_finished",
        node: effect.node,
        attempt: effect.attempt,
        index: effect.index,
        passed: true,
        reason: "",
      };
    default:
      return undefined;
  }
}

const approve = (node: string): RunEvent => ({ type: "human_decided", node, decision: "approved" });
const reject = (node: string, reason = "no"): RunEvent => ({
  type: "human_decided",
  node,
  decision: "rejected",
  reason,
});

describe("starting a run", () => {
  test("enters the first node and asks the agent to work, with the prompt rendered", () => {
    const result = must(decide(feature, undefined, START, 100));
    expect(result.state.status).toBe("running");
    expect(result.state.trail).toEqual(["plan"]);
    expect(result.state.nodes.plan).toMatchObject({ status: "running", attempt: 1 });
    const agent = result.effects.find((e) => e.type === "need_agent");
    expect(agent).toMatchObject({ node: "plan", attempt: 1 });
    expect(agent && "prompt" in agent && agent.prompt).toContain(
      "docs/plans/add_login_rate_limit.md",
    );
    expect(result.journal.map((j) => j.event)).toEqual(["run_started", "node_entered"]);
  });

  test("takes a snapshot for the baseline its checks need", () => {
    const result = must(decide(feature, undefined, START, 0));
    expect(result.effects).toContainEqual({ type: "take_snapshot", key: "visit:1" });
  });

  test("a run cannot start twice and cannot be driven before it starts", () => {
    const started = must(decide(feature, undefined, START, 0)).state;
    const again = decide(feature, started, START, 0);
    expect(again.ok).toBe(false);
    const early = decide(feature, undefined, { type: "tick" }, 0);
    expect(early.ok).toBe(false);
  });
});

describe("agent work and checks", () => {
  test("completing the agent's work runs its checks one at a time, with rendered parameters", () => {
    const h = host(feature, (effect) => (effect.type === "need_agent" ? undefined : undefined));
    h.send(START);
    h.send({ type: "agent_completed", node: "plan", attempt: 1 });
    const check = h.effects.find((e) => e.type === "run_check");
    expect(check).toMatchObject({
      node: "plan",
      index: 0,
      kind: "diff",
      baseline: "visit:1",
      params: { paths: ["docs/plans/add_login_rate_limit.md"], mode: "changed_only" },
    });
  });

  test("a check that passes moves the node on; a human node then waits", () => {
    const h = host(feature);
    h.send(START);
    expect(h.state.trail).toEqual(["plan", "plan-approval"]);
    expect(h.state.nodes["plan-approval"]?.status).toBe("waiting");
    expect(h.state.nodes.plan).toMatchObject({ status: "passed", outcome: "passed" });
    expect(h.effects.some((e) => e.type === "await_human")).toBe(true);
  });

  test("a failed check with no matching edge re-enters an agent node with the reason", () => {
    const h = host(feature, (effect) => {
      if (effect.type === "run_check") {
        return {
          type: "check_finished",
          node: effect.node,
          attempt: effect.attempt,
          index: effect.index,
          passed: effect.attempt > 1,
          reason: "nothing changed in docs/plans",
        };
      }
      return defaultAnswer(effect);
    });
    h.send(START);
    expect(h.state.nodes.plan).toMatchObject({ attempt: 2, status: "passed" });
    expect(h.state.trail).toEqual(["plan", "plan-approval"]); // rework adds no entry
    const rework = h.journal.filter((j) => j.event === "node_entered" && j.node === "plan");
    expect(rework.map((j) => j.rework)).toEqual([false, true]);
  });

  test("a failed command follows the edge for its label", () => {
    const h = host(feature, (effect) =>
      effect.type === "run_command" && effect.node === "build" && effect.attempt === 1
        ? { type: "work_finished", node: "build", attempt: 1, passed: false, reason: "exit 1" }
        : defaultAnswer(effect),
    );
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.nodes.build).toMatchObject({ attempt: 2, status: "passed" });
    expect(h.state.nodes.impl?.attempt).toBe(2);
    expect(h.state.trail.slice(0, 6)).toEqual([
      "plan",
      "plan-approval",
      "impl",
      "build",
      "impl",
      "build",
    ]);
  });
});

describe("mistakes and repeats", () => {
  const waiting = () => {
    const h = host(feature, (effect) =>
      effect.type === "need_agent" ? undefined : defaultAnswer(effect),
    );
    h.send(START);
    return h;
  };

  test("a wrong attempt number is ATTEMPT_MISMATCH and changes nothing", () => {
    const h = waiting();
    const before = structuredClone(h.state);
    const result = h.send({ type: "agent_completed", node: "plan", attempt: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ATTEMPT_MISMATCH");
    expect(h.state).toEqual(before);
  });

  test("a node the run has not reached is NODE_NOT_RUNNING", () => {
    const h = waiting();
    const result = h.send({ type: "agent_completed", node: "build", attempt: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NODE_NOT_RUNNING");
  });

  test("a node that does not exist is UNKNOWN_NODE", () => {
    const h = waiting();
    const result = h.send({ type: "agent_completed", node: "ghost", attempt: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_NODE");
  });

  test("a human decision for a node that is not waiting is rejected", () => {
    const h = waiting();
    const result = h.send(approve("manual-test"));
    expect(result.ok).toBe(false);
  });

  test("repeating a completed step is a no-op, not an error", () => {
    const h = host(feature);
    h.send(START);
    const before = structuredClone(h.state);
    const again = h.send({ type: "agent_completed", node: "plan", attempt: 1 });
    expect(again.ok && again.noop).toBe(true);
    expect(h.state).toEqual(before);
  });

  test("repeating completion while the checks run is a no-op", () => {
    const h = host(feature, (effect) =>
      effect.type === "run_check" ? undefined : defaultAnswer(effect),
    );
    h.send(START);
    const again = h.send({ type: "agent_completed", node: "plan", attempt: 1 });
    expect(again.ok && again.noop).toBe(true);
  });

  test("a stale check result is ignored", () => {
    const h = host(feature);
    h.send(START);
    const stale = h.send({
      type: "check_finished",
      node: "plan",
      attempt: 1,
      index: 0,
      passed: false,
      reason: "late",
    });
    expect(stale.ok && stale.noop).toBe(true);
    expect(h.state.nodes.plan?.status).toBe("passed");
  });

  test("decide does not modify the state it is given and gives the same answer twice", () => {
    const started = must(decide(feature, undefined, START, 0)).state;
    const snapshot = JSON.stringify(started);
    const event: RunEvent = { type: "agent_completed", node: "plan", attempt: 1 };
    const a = must(decide(feature, started, event, 5));
    const b = must(decide(feature, started, event, 5));
    expect(JSON.stringify(started)).toBe(snapshot);
    expect(a).toEqual(b);
  });
});

describe("limits, pause and resume", () => {
  const failBuild =
    (until: number) =>
    (effect: Effect): RunEvent | undefined =>
      effect.type === "run_command" && effect.node === "build" && effect.attempt <= until
        ? {
            type: "work_finished",
            node: "build",
            attempt: effect.attempt,
            passed: false,
            reason: "exit 1",
          }
        : defaultAnswer(effect);

  test("three failures in a row pause the run and keep the blocked route", () => {
    const h = host(feature, failBuild(99));
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.status).toBe("paused");
    expect(h.state.pauses).toHaveLength(1);
    expect(h.state.pauses[0]).toMatchObject({
      reason: "consecutive",
      node: "build",
      blocked: { from: "build", label: "failed", to: "impl" },
    });
    expect(h.state.nodes.build?.attempt).toBe(3);
    expect(h.state.nodes.impl?.attempt).toBe(3);
    expect(h.state.active).toEqual([]);
    expect(h.journal.at(-1)).toMatchObject({ event: "run_paused", reason: "consecutive" });
  });

  test("resume takes the blocked route with a fresh failure count", () => {
    let fail = true;
    const h = host(feature, (effect) =>
      effect.type === "run_command" && effect.node === "build" && fail
        ? {
            type: "work_finished",
            node: "build",
            attempt: effect.attempt,
            passed: false,
            reason: "exit 1",
          }
        : defaultAnswer(effect),
    );
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.status).toBe("paused");
    fail = false;
    h.send({ type: "resume" });
    expect(h.state.status).toBe("running");
    expect(h.state.nodes.build).toMatchObject({
      attempt: 4,
      status: "passed",
      consecutiveFailures: 0,
    });
    // Only nodes that had used up their attempts get more; build was at 3 of 10.
    expect(h.state.nodes.build?.extraAttempts).toBe(0);
    expect(h.state.nodes["manual-test"]?.status).toBe("waiting");
    expect(h.journal.map((j) => j.event)).toContain("run_resumed");
  });

  test("a failure count starts over when the node passes", () => {
    // build fails twice, passes, test fails once, build fails twice again: never three in a row.
    const script: Record<string, boolean[]> = {
      build: [false, false, true, false, false, true],
      test: [false, true],
    };
    const used: Record<string, number> = { build: 0, test: 0 };
    const h = host(feature, (effect) => {
      if (effect.type === "run_command" && script[effect.node]) {
        const n = (used[effect.node] ?? 0) + 1;
        used[effect.node] = n;
        const passed = script[effect.node]?.[n - 1] ?? true;
        return {
          type: "work_finished",
          node: effect.node,
          attempt: effect.attempt,
          passed,
          reason: "exit 1",
        };
      }
      return defaultAnswer(effect);
    });
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.status).toBe("running");
    expect(h.state.nodes.build?.consecutiveFailures).toBe(0);
  });

  test("human rejections never count as failures in a row, but all attempts are capped", () => {
    const h = host(feature);
    h.send(START);
    h.send(approve("plan-approval"));
    for (let round = 1; round <= 9; round++) {
      h.send(reject("manual-test", `round ${round}`));
      expect(h.state.status).toBe("running");
      expect(h.state.nodes["manual-test"]?.consecutiveFailures).toBe(0);
    }
    expect(h.state.nodes.impl?.attempt).toBe(10);
    h.send(reject("manual-test", "round 10"));
    expect(h.state.status).toBe("paused");
    expect(h.state.pauses[0]).toMatchObject({ reason: "total", node: "impl" });
    h.send({ type: "resume" });
    expect(h.state.status).toBe("running");
    expect(h.state.nodes.impl?.attempt).toBe(11);
  });

  test("a node's own limits override the defaults", () => {
    const strict = parsePipeline(
      readFileSync(
        new URL("../../../examples/pipelines/feature.yaml", import.meta.url),
        "utf8",
      ).replace("max_consecutive_failures: 3", "max_consecutive_failures: 1"),
    );
    const h = host(strict, failBuild(99));
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.status).toBe("paused");
    expect(h.state.nodes.build?.attempt).toBe(1);
  });

  test("resume on a run that is not paused is a no-op", () => {
    const h = host(feature);
    h.send(START);
    const result = h.send({ type: "resume" });
    expect(result.ok && result.noop).toBe(true);
  });

  test("a paused run accepts nothing but resume and cancel", () => {
    const h = host(feature, failBuild(99));
    h.send(START);
    h.send(approve("plan-approval"));
    const result = h.send(approve("manual-test"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(KodelError);
  });
});

describe("interrupted engine work", () => {
  const hanging = (effect: Effect): RunEvent | undefined => {
    if (
      effect.type === "run_command" &&
      effect.node === "build" &&
      effect.attempt === 1 &&
      !effect.restart
    ) {
      return undefined;
    }
    return defaultAnswer(effect);
  };

  test("a node that stops answering is restarted by the next tick, on the same attempt", () => {
    const h = host(feature, hanging);
    h.send(START);
    h.send(approve("plan-approval"));
    expect(h.state.nodes.build).toMatchObject({ status: "running", attempt: 1 });
    h.advance(10_000);
    h.send({ type: "tick" });
    expect(h.journal.some((j) => j.event === "node_restarted")).toBe(false);
    h.advance(25_000);
    h.send({ type: "tick" });
    expect(h.journal.filter((j) => j.event === "node_restarted")).toHaveLength(1);
    expect(h.state.nodes.build).toMatchObject({ status: "passed", attempt: 1 });
    expect(h.effects.filter((e) => e.type === "run_command" && e.restart)).toHaveLength(1);
  });

  test("a heartbeat keeps the work alive", () => {
    const h = host(feature, hanging);
    h.send(START);
    h.send(approve("plan-approval"));
    for (let i = 0; i < 5; i++) {
      h.advance(20_000);
      h.send({ type: "heartbeat", node: "build", attempt: 1 });
      h.send({ type: "tick" });
    }
    expect(h.journal.some((j) => j.event === "node_restarted")).toBe(false);
    expect(h.state.nodes.build?.status).toBe("running");
  });

  test("work that keeps stopping pauses the run after max restarts, and resume restarts it", () => {
    const alwaysHang = (effect: Effect): RunEvent | undefined =>
      effect.type === "run_command" && effect.node === "build" ? undefined : defaultAnswer(effect);
    const h = host(feature, alwaysHang);
    h.send(START);
    h.send(approve("plan-approval"));
    for (let i = 0; i < 4; i++) {
      h.advance(31_000);
      h.send({ type: "tick" });
    }
    expect(h.state.status).toBe("paused");
    expect(h.state.pauses[0]?.reason).toBe("restarts");
    expect(h.journal.filter((j) => j.event === "node_restarted")).toHaveLength(3);
    expect(h.state.nodes.build?.attempt).toBe(1);
    const before = h.effects.length;
    h.send({ type: "resume" });
    expect(h.state.status).toBe("running");
    expect(h.effects.length).toBe(before + 1);
    expect(h.effects.at(-1)).toMatchObject({ type: "run_command", node: "build", restart: true });
  });

  test("the staleness window is configurable", () => {
    const h = host(feature, hanging, { staleMs: 1_000 });
    h.send(START);
    h.send(approve("plan-approval"));
    h.advance(1_500);
    h.send({ type: "tick" });
    expect(h.state.nodes.build?.status).toBe("passed");
  });
});

describe("finishing", () => {
  test("a run whose last node passes is completed", () => {
    const h = host(feature);
    h.send(START);
    h.send(approve("plan-approval"));
    h.send(approve("manual-test"));
    expect(h.state.status).toBe("completed");
    expect(h.state.trail).toEqual([
      "plan",
      "plan-approval",
      "impl",
      "build",
      "test",
      "review",
      "e2e",
      "manual-test",
      "docs",
    ]);
    expect(h.state.active).toEqual([]);
    expect(h.journal.at(-1)).toMatchObject({ event: "run_finished", status: "completed" });
  });

  test("cancel ends a running or paused run, and a second cancel is a no-op", () => {
    const h = host(feature);
    h.send(START);
    h.send({ type: "cancel" });
    expect(h.state.status).toBe("canceled");
    expect(h.state.active).toEqual([]);
    const again = h.send({ type: "cancel" });
    expect(again.ok && again.noop).toBe(true);
    const late = h.send(approve("plan-approval"));
    expect(late.ok).toBe(false);
  });

  test("journal records are numbered 1, 2, 3, ... and versioned", () => {
    const h = host(feature);
    h.send(START);
    h.send(approve("plan-approval"));
    h.send(approve("manual-test"));
    expect(h.journal.map((j) => j.seq)).toEqual(h.journal.map((_, i) => i + 1));
    expect(h.journal.every((j) => j.v === 2)).toBe(true);
  });
});

// ── random event sequences: the rules must hold whatever happens ─────────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invariants(spec: PipelineSpec, state: RunState) {
  const active = state.active.map((v) => v.node);
  expect(new Set(active).size).toBe(active.length);
  if (state.status === "completed" || state.status === "failed" || state.status === "canceled") {
    expect(state.active).toEqual([]);
  }
  if (state.status === "paused") {
    expect(state.active.every((v) => v.suspended === true)).toBe(true);
  }
  for (const node of spec.nodes) {
    const run = state.nodes[node.slug];
    if (!run) throw new Error(`missing run for ${node.slug}`);
    expect(run.attempt).toBeGreaterThanOrEqual(0);
    expect(run.attempt).toBeLessThanOrEqual(node.max_attempts + run.extraAttempts);
    expect(run.consecutiveFailures).toBeLessThanOrEqual(node.max_consecutive_failures);
    if (run.attempt === 0) expect(run.status).toBe("pending");
  }
  for (const visit of state.active) {
    const run = state.nodes[visit.node];
    expect(run?.attempt).toBe(visit.attempt);
    expect(["running", "rework", "waiting"]).toContain(run?.status ?? "");
  }
  expect(state.trail[0]).toBe(spec.entry);
}

function simulate(spec: PipelineSpec, seed: number, steps = 400) {
  const random = mulberry32(seed);
  let state: RunState | undefined;
  let now = 0;
  let lastSeq = 0;
  const pending: Effect[] = [];
  const seen = new Set<string>();

  const send = (event: RunEvent) => {
    const before = state === undefined ? undefined : structuredClone(state);
    const result = decide(spec, state, event, now);
    if (!result.ok) {
      expect(state).toEqual(before); // an error changes nothing
      return;
    }
    if (result.noop && before) expect(result.state).toEqual(before);
    state = result.state;
    seen.add(state.status);
    for (const record of result.journal) {
      expect(record.seq).toBeGreaterThan(lastSeq);
      lastSeq = record.seq;
    }
    pending.push(...result.effects);
    invariants(spec, state);
  };

  send(START);
  for (let i = 0; i < steps; i++) {
    const roll = random();
    if (pending.length > 0 && roll < 0.8) {
      const [effect] = pending.splice(Math.floor(random() * pending.length), 1);
      if (!effect) continue;
      if (effect.type === "need_agent") {
        send({ type: "agent_completed", node: effect.node, attempt: effect.attempt });
      } else if (effect.type === "run_command") {
        send({
          type: "work_finished",
          node: effect.node,
          attempt: effect.attempt,
          passed: random() < 0.75,
          reason: "x",
        });
      } else if (effect.type === "run_check") {
        send({
          type: "check_finished",
          node: effect.node,
          attempt: effect.attempt,
          index: effect.index,
          passed: random() < 0.85,
          reason: "x",
        });
      } else if (effect.type === "await_human") {
        send({
          type: "human_decided",
          node: effect.node,
          decision: random() < 0.6 ? "approved" : "rejected",
          reason: "x",
        });
      }
    } else if (roll < 0.88) {
      now += Math.floor(random() * 60_000);
      send({ type: "tick" });
    } else if (roll < 0.96) {
      send({ type: "resume" });
    } else if (roll < 0.9603) {
      send({ type: "cancel" });
    }
  }
  return { state: state as RunState, seen };
}

describe("random runs", () => {
  test("the invariants hold over many random event sequences", () => {
    for (let seed = 1; seed <= 150; seed++) simulate(feature, seed);
  });

  test("the same seed gives the same final state", () => {
    for (const seed of [3, 17, 99]) {
      expect(simulate(feature, seed).state).toEqual(simulate(feature, seed).state);
    }
  });

  test("the random runs complete, pause and resume, so the sequences are not trivial", () => {
    const statuses = new Set<string>();
    for (let seed = 1; seed <= 150; seed++) {
      for (const status of simulate(feature, seed).seen) statuses.add(status);
    }
    for (const wanted of ["running", "completed", "paused", "canceled"]) {
      expect(statuses.has(wanted), wanted).toBe(true);
    }
  });
});

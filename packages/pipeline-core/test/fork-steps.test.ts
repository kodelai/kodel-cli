/**
 * Several agent steps open at once (T-40, commit 3): what `nextStep` hands out, the claim by token,
 * the modes, and the texts a fork adds to the answers.
 */
import { describe, expect, test } from "bun:test";
import {
  claimedStepsOpen,
  DEFAULT_AGENTS,
  DEFAULT_CLAIM_TTL_S,
  decide,
  type Effect,
  type EngineOptions,
  type JournalRecord,
  KodelError,
  liveClaim,
  MAX_LOGGED_CLAIMS,
  type NextStepOptions,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
  resolveMode,
} from "../src";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

/** Two agent branches, a command in each, a join with a check. */
const FORK = parsePipeline(
  yaml([
    "name: fork",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - slug: a",
    "    kind: agent",
    "    prompt: do a",
    "    checks: [{ kind: command, command: a-check }]",
    "  - { slug: a-test, kind: command, command: a-test }",
    "  - { slug: b, kind: agent, prompt: do b }",
    "  - { slug: b-test, kind: command, command: b-test }",
    "  - slug: merge",
    "    kind: agent",
    "    prompt: merge",
    "    join: all",
    "    checks: [{ kind: command, command: merge-check }]",
    "  - { slug: ship, kind: command, command: ship }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: a-test }",
    "  - { from: a-test, to: merge }",
    "  - { from: a-test, to: merge, when: failed }",
    "  - { from: b, to: b-test }",
    "  - { from: b-test, to: merge }",
    "  - { from: b-test, to: merge, when: failed }",
    "  - { from: merge, to: ship }",
    "  - { from: ship, to: plan, when: failed }",
  ]),
);

/** Three agent branches, for the cap on what is handed out. */
const THREE = parsePipeline(
  yaml([
    "name: three",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: b, kind: agent, prompt: b }",
    "  - { slug: c, kind: agent, prompt: c }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: plan, to: c }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
    "  - { from: c, to: merge }",
  ]),
);

/** An agent step in one branch, a gate in the other, and a second gate after the join. */
const GATED = parsePipeline(
  yaml([
    "name: gated",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: b, kind: agent, prompt: b }",
    "  - { slug: b-gate, kind: human, prompt: b fine? }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: b-gate }",
    "  - { from: b-gate, to: merge, when: approved }",
    "  - { from: b-gate, to: b, when: rejected }",
  ]),
);

/** Two gates open at once. */
const TWO_GATES = parsePipeline(
  yaml([
    "name: two-gates",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a-gate, kind: human, prompt: a? }",
    "  - { slug: b-gate, kind: human, prompt: b? }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a-gate }",
    "  - { from: plan, to: b-gate }",
    "  - { from: a-gate, to: merge, when: approved }",
    "  - { from: a-gate, to: merge, when: rejected }",
    "  - { from: b-gate, to: merge, when: approved }",
    "  - { from: b-gate, to: merge, when: rejected }",
  ]),
);

const START: RunEvent = { type: "start", runId: "r1", task: "split the work", specHash: "h" };

// ── a tiny host ─────────────────────────────────────────────────────────────

function answer(effect: Effect): RunEvent | undefined {
  switch (effect.type) {
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

/** Agent steps wait for the test; commands and checks pass unless `reply` says otherwise. */
function host(
  spec: PipelineSpec,
  reply: (effect: Effect) => RunEvent | undefined = answer,
  options: EngineOptions = {},
) {
  let state: RunState | undefined;
  let now = 1_000;
  let current = spec;
  const journal: JournalRecord[] = [];
  const send = (first: RunEvent) => {
    const queue = [first];
    let firstResult: ReturnType<typeof decide> | undefined;
    while (queue.length > 0) {
      const event = queue.shift() as RunEvent;
      const result = decide(current, state, event, now, options);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        throw new Error(`a follow-up was refused: ${result.error.code} ${result.error.message}`);
      }
      state = result.state;
      journal.push(...result.journal);
      for (const effect of result.effects) {
        const next = reply(effect);
        if (next) queue.push(next);
      }
    }
    return firstResult as ReturnType<typeof decide>;
  };
  return {
    send,
    journal,
    events: () => journal.map((r) => r.event),
    advance: (ms: number) => {
      now += ms;
    },
    use: (next: PipelineSpec) => {
      current = next;
    },
    get now() {
      return now;
    },
    get spec() {
      return current;
    },
    get state() {
      return state as RunState;
    },
    next: (options: NextStepOptions = {}) =>
      nextStep(current, state as RunState, now, undefined, options),
  };
}

const must = (result: ReturnType<typeof decide>) => {
  if (!result.ok) throw result.error;
  return result;
};
const refusal = (result: ReturnType<typeof decide>) => {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};
const complete = (node: string, attempt: number, claimToken?: string): RunEvent => ({
  type: "agent_completed",
  node,
  attempt,
  ...(claimToken === undefined ? {} : { claimToken }),
});
const claim = (node: string, token: string, ttlMs = DEFAULT_CLAIM_TTL_S * 1000): RunEvent => ({
  type: "step_claimed",
  node,
  token,
  ttlMs,
});
const approve = (node: string): RunEvent => ({ type: "human_decided", node, decision: "approved" });

/** The fork with both branches' agent steps open. */
function openFork(spec = FORK, reply = answer) {
  const h = host(spec, reply);
  h.send(START);
  h.send(complete("plan", 1));
  return h;
}

const nodeOf = (step: ReturnType<ReturnType<typeof host>["next"]>) => {
  if (!("node" in step)) throw new Error(`expected a node answer, got ${Object.keys(step)[0]}`);
  return step.node;
};
const runningOf = (step: ReturnType<ReturnType<typeof host>["next"]>) => {
  if (!("running" in step))
    throw new Error(`expected a running answer, got ${Object.keys(step)[0]}`);
  return step.running;
};
const waitingOf = (step: ReturnType<ReturnType<typeof host>["next"]>) => {
  if (!("waiting" in step))
    throw new Error(`expected a waiting answer, got ${Object.keys(step)[0]}`);
  return step.waiting;
};

const PARALLEL: NextStepOptions = { agents: { mode: "parallel", maxParallel: 8 } };
const SEQUENTIAL: NextStepOptions = { agents: { mode: "sequential", maxParallel: 8 } };

// ── steps ───────────────────────────────────────────────────────────────────

describe("t40 steps: what is handed out", () => {
  test("t40_next_step_returns_all_open_agent_steps", () => {
    const h = openFork();
    const node = nodeOf(h.next(PARALLEL));
    expect(node.steps?.map((s) => s.slug)).toEqual(["a", "b"]);
    const a = node.steps?.[0];
    expect(a).toMatchObject({ slug: "a", kind: "agent", attempt: 1 });
    expect(a?.prompt).toContain("do a");
    expect(a?.taken_by).toBeUndefined();
    expect(node.steps?.[1]?.prompt).toContain("do b");
    // a single open step is the plain answer, as before forks
    const single = host(FORK);
    single.send(START);
    expect(nodeOf(single.next(PARALLEL)).steps).toBeUndefined();
  });

  test("t40_first_step_also_in_node", () => {
    const h = openFork();
    const node = nodeOf(h.next(PARALLEL));
    expect(node.slug).toBe("a");
    expect(node.prompt).toBe(node.steps?.[0]?.prompt as string);
    expect(node.attempt).toBe(node.steps?.[0]?.attempt as number);
  });

  test("t40_steps_carry_workdir", () => {
    const h = openFork();
    const node = nodeOf(h.next({ ...PARALLEL, workdir: "/work/r1" }));
    expect(node.workdir).toBe("/work/r1");
    expect(node.steps?.every((s) => s.workdir === "/work/r1")).toBe(true);
    expect(nodeOf(h.next(PARALLEL)).workdir).toBeUndefined();
  });

  test("t40_node_slug_returns_exactly_that_step", () => {
    const h = openFork();
    const b = nodeOf(h.next({ ...PARALLEL, nodeSlug: "b" }));
    expect(b.slug).toBe("b");
    expect(b.steps).toBeUndefined();
    // whoever holds it
    must(h.send(claim("b", "hash-b")));
    expect(nodeOf(h.next({ ...PARALLEL, nodeSlug: "b" }))).toMatchObject({
      slug: "b",
      taken_by: "w-hash-b",
    });
  });

  test("t40_node_slug_unknown_or_non_agent_refused", () => {
    const h = openFork();
    expect(() => h.next({ nodeSlug: "nope" })).toThrow(KodelError);
    try {
      h.next({ nodeSlug: "nope" });
    } catch (error) {
      expect((error as KodelError).code).toBe("UNKNOWN_NODE");
    }
    // a command that is running, and a step that is not open
    must(h.send(complete("a", 1)));
    const h2 = host(FORK, (e) => (e.type === "run_command" ? undefined : answer(e)));
    h2.send(START);
    h2.send(complete("plan", 1));
    must(h2.send(complete("a", 1)));
    try {
      h2.next({ nodeSlug: "a-test" });
      throw new Error("not refused");
    } catch (error) {
      expect((error as KodelError).code).toBe("NODE_NOT_RUNNING");
      expect((error as KodelError).message).toContain("engine phase");
    }
    try {
      h2.next({ nodeSlug: "ship" });
      throw new Error("not refused");
    } catch (error) {
      expect((error as KodelError).code).toBe("NODE_NOT_RUNNING");
    }
  });

  test("t40_next_step_never_claims_and_is_read_only", () => {
    const h = openFork();
    const before = JSON.stringify(h.state);
    h.next(PARALLEL);
    h.next({ ...PARALLEL, nodeSlug: "b" });
    h.next(SEQUENTIAL);
    expect(JSON.stringify(h.state)).toBe(before);
    expect(h.state.nodes.a?.claim).toBeUndefined();
    expect(h.state.nodes.b?.claim).toBeUndefined();
  });

  test("t40_all_taken_returns_running_with_open_steps", () => {
    const h = openFork();
    must(h.send(claim("a", "hash-a")));
    must(h.send(claim("b", "hash-b")));
    const running = runningOf(h.next(PARALLEL));
    expect(running.open_steps).toEqual([
      { node_slug: "a", attempt: 1, taken_by: "w-hash-a" },
      { node_slug: "b", attempt: 1, taken_by: "w-hash-b" },
    ]);
    expect(running.hint).toContain("held by a worker");
    expect(running.hint).toContain("wait_s");
    expect(claimedStepsOpen(h.state, h.now)).toBe(true);
    // the pure part of the wait: it ends when a step is free again (handed in, or its hold lapsed)
    must(h.send(complete("a", 1, "hash-a")));
    expect(claimedStepsOpen(h.state, h.now)).toBe(true); // b is still held
    h.advance(DEFAULT_CLAIM_TTL_S * 1000);
    expect(claimedStepsOpen(h.state, h.now)).toBe(false);
    expect(nodeOf(h.next(PARALLEL)).slug).toBe("b");
  });

  test("t40_max_parallel_queues_steps", () => {
    const h = openFork(THREE);
    const node = nodeOf(h.next({ agents: { mode: "parallel", maxParallel: 2 } }));
    expect(node.steps?.map((s) => s.slug)).toEqual(["a", "b"]);
    expect(node.queued).toBe(1);
    // a taken step counts against the cap
    must(h.send(claim("a", "hash-a")));
    const next = nodeOf(h.next({ agents: { mode: "parallel", maxParallel: 2 } }));
    expect(next.slug).toBe("b");
    expect(next.steps?.map((s) => [s.slug, s.taken_by])).toEqual([
      ["b", undefined],
      ["a", "w-hash-a"],
    ]);
    expect(next.queued).toBe(1);
    // the default cap hands everything out
    expect(nodeOf(openFork(THREE).next(PARALLEL)).queued).toBeUndefined();
    expect(DEFAULT_AGENTS.max_parallel).toBe(8);
  });

  test("t40_max_parallel_caps_steps_in_flight", () => {
    // cap 1 and `a` held: nothing is handed out (a `running` summary names the open steps and how
    // many wait), and a take by slug of a free step is held back too, so no second step is in flight
    const h = openFork(THREE);
    const capped = { agents: { mode: "parallel" as const, maxParallel: 1 } };
    const take = (token: string, node: string): RunEvent => ({
      type: "step_claimed",
      node,
      token,
      ttlMs: 60_000,
      maxParallel: 1,
    });
    expect(nodeOf(h.next(capped)).steps?.map((s) => s.slug)).toEqual(["a"]);
    must(h.send(take("w1", "a")));
    const running = runningOf(h.next(capped));
    expect(running.open_steps?.map((s) => [s.node_slug, s.taken_by])).toEqual([
      ["a", "w-w1"],
      ["b", undefined],
      ["c", undefined],
    ]);
    expect(running.queued).toBe(2);
    expect(running.hint).toContain("max_parallel");
    expect(running.hint).toContain("wait_s");
    const held = must(h.send(take("w2", "b")));
    expect(held.noop).toBe(true);
    expect(h.state.nodes.b?.claim).toBeUndefined();
    // the holder gets its own step back and renews it under the cap
    expect(nodeOf(h.next({ ...capped, nodeSlug: "a" })).slug).toBe("a");
    h.advance(1_000);
    expect(must(h.send(take("w1", "a"))).noop).toBeUndefined();
    expect(h.state.nodes.a?.claim?.at).toBe(h.now);
    // once `a` is handed in, `b` is handed out and can be taken by slug
    must(h.send(complete("a", 1, "w1")));
    expect(nodeOf(h.next(capped)).slug).toBe("b");
    must(h.send(take("w2", "b")));
    expect(h.state.nodes.b?.claim?.token).toBe("w2");
    expect(runningOf(h.next(capped)).queued).toBe(1);
  });

  test("t40_result_recorded_per_step", () => {
    const h = openFork();
    must(h.send({ type: "agent_completed", node: "b", attempt: 1, summary: "did b" }));
    must(h.send({ type: "agent_completed", node: "a", attempt: 1, summary: "did a" }));
    const completed = h.journal.filter((r) => r.event === "agent_completed" && r.node !== "plan");
    expect(completed.map((r) => [r.node, r.summary])).toEqual([
      ["b", "did b"],
      ["a", "did a"],
    ]);
    expect(h.state.nodes.a?.status).toBe("passed");
    expect(h.state.nodes.b?.status).toBe("passed");
  });

  test("t40_out_of_order_completion_is_checked", () => {
    // `b` is handed in first, though `a` comes first in the answer: b's own checks and command run
    const h = openFork();
    must(h.send(complete("b", 1)));
    expect(h.events().filter((e) => e === "command_finished")).toHaveLength(1);
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "passed" });
    expect(h.state.active.map((v) => v.node)).toEqual(["a"]);
    must(h.send(complete("a", 1)));
    expect(h.journal.filter((r) => r.event === "check_finished" && r.node === "a")).toHaveLength(1);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
  });
});

// ── modes ───────────────────────────────────────────────────────────────────

describe("t40 modes", () => {
  test("t40_mode_parallel_text", () => {
    const node = nodeOf(openFork().next(PARALLEL));
    expect(node.execution?.mode).toBe("parallel");
    const text = node.execution?.instruction ?? "";
    for (const part of [
      "one subagent per step",
      "pipeline_take_step",
      "claim_token",
      "workdir",
      "pipeline_complete_step",
      "reports the answer back",
      "`waiting`, `running`, `done` or `also_waiting`",
      "never starts `kodel wait`",
    ]) {
      expect(text, part).toContain(part);
    }
    // the step's own instruction, when the node has one, comes first and is kept per step
    expect(node.steps?.[0]?.execution).toBeUndefined();
  });

  test("t40_mode_sequential_text", () => {
    const node = nodeOf(openFork().next(SEQUENTIAL));
    expect(node.execution?.mode).toBe("sequential");
    expect(node.execution?.instruction).toContain("one by one");
    expect(node.execution?.instruction).toContain("Do not start subagents");
    // without a mode from the host the steps are done one by one
    expect(nodeOf(openFork().next()).execution?.mode).toBe("sequential");
  });

  test("t40_sequential_rules_do_not_send_the_agent_to_take_its_steps", () => {
    // An agent that took its steps one by one would, at the last one, be told that every open step
    // is held and to wait for itself: the rules say to hand the steps in without a claim, and the
    // held summary says how a holder gets its own step back.
    const h = openFork();
    const rules = nodeOf(h.next(SEQUENTIAL)).execution?.instruction ?? "";
    expect(rules).toContain("Do not take the steps with pipeline_take_step");
    expect(rules).toContain("pipeline_complete_step (node_slug and attempt)");
    expect(rules).not.toContain("take it with pipeline_take_step first");
    must(h.send(claim("a", "mine")));
    must(h.send(claim("b", "mine")));
    const running = runningOf(h.next(SEQUENTIAL));
    expect(running.hint).toContain("A step you hold yourself is handed to you again");
    expect(running.hint).toContain("node_slug");
    expect(nodeOf(h.next({ ...SEQUENTIAL, nodeSlug: "a" })).slug).toBe("a");
  });

  test("t40_mode_auto_declaration_else_sequential", () => {
    expect(resolveMode({ subagents: "auto" }, undefined)).toBe("sequential");
    expect(resolveMode({ subagents: "auto" }, { can: false })).toBe("sequential");
    expect(resolveMode({ subagents: "auto" }, { can: true })).toBe("parallel");
    expect(resolveMode({ subagents: "auto" }, { can: true, max_depth: 2 })).toBe("parallel");
    expect(resolveMode(undefined, undefined)).toBe("sequential");
    expect(DEFAULT_AGENTS.subagents).toBe("auto");
  });

  test("t40_config_yes_no_wins", () => {
    expect(resolveMode({ subagents: "yes" }, undefined)).toBe("parallel");
    expect(resolveMode({ subagents: "yes" }, { can: false })).toBe("parallel");
    expect(resolveMode({ subagents: "no" }, { can: true })).toBe("sequential");
    expect(resolveMode({ subagents: "no" }, undefined)).toBe("sequential");
  });

  test("t40_wrong_mode_costs_speed_only", () => {
    // The same fork worked two ways: all steps taken then completed in any order (parallel), and one
    // step at a time, handed in without a claim as SEQUENTIAL_RULES say (sequential). The engine
    // ends in the same place either way.
    const parallel = openFork();
    must(parallel.send(claim("a", "pa")));
    must(parallel.send(claim("b", "pb")));
    must(parallel.send(complete("b", 1, "pb")));
    must(parallel.send(complete("a", 1, "pa")));
    must(parallel.send(complete("merge", 1)));

    const sequential = openFork();
    must(sequential.send(complete("a", 1)));
    must(sequential.send(complete("b", 1)));
    must(sequential.send(complete("merge", 1)));

    const outcome = (s: RunState) => ({
      status: s.status,
      nodes: Object.fromEntries(
        Object.values(s.nodes).map((n) => [n.slug, [n.status, n.outcome, n.attempt]]),
      ),
      trail: [...s.trail].sort(),
      // the order of the arrivals (`seq`) is the one thing about them the mode decides
      arrived: Object.fromEntries(
        Object.entries(s.forks?.f1?.arrived ?? {}).map(([branch, { seq: _seq, ...rest }]) => [
          branch,
          rest,
        ]),
      ),
    });
    expect(outcome(parallel.state)).toEqual(outcome(sequential.state));
    expect(parallel.state.status).toBe("completed");
    const kinds = (h: ReturnType<typeof host>) =>
      h
        .events()
        .filter((e) => e !== "step_claimed")
        .sort();
    expect(kinds(parallel)).toEqual(kinds(sequential));
    expect(parallel.events()).not.toEqual(sequential.events());
  });
});

// ── claims ──────────────────────────────────────────────────────────────────

describe("t40 claims", () => {
  test("t40_claim_token_stored_hashed", () => {
    // The core only ever sees the hash the host made; it stores that and a prefix of it.
    const h = openFork();
    must(h.send(claim("a", "0123456789abcdef0123456789abcdef")));
    expect(h.state.nodes.a?.claim).toEqual({
      token: "0123456789abcdef0123456789abcdef",
      at: h.now,
      until: h.now + DEFAULT_CLAIM_TTL_S * 1000,
      by: "w-01234567",
    });
    expect(h.state.nodes.b?.claim).toBeUndefined();
  });

  test("t40_take_step_taken_without_token_answers_taken", () => {
    const h = openFork();
    must(h.send(claim("a", "first")));
    // another hash on a live claim: the state stays, and the decision says it was a no-op
    const second = must(h.send(claim("a", "second")));
    expect(second.noop).toBe(true);
    expect(liveClaim(second.state.nodes.a, h.now)?.token).toBe("first");
    expect(h.state.nodes.a?.claim?.token).toBe("first");
  });

  test("t40_take_step_same_token_is_idempotent", () => {
    const h = openFork();
    must(h.send(claim("a", "mine")));
    h.advance(10_000);
    const again = must(h.send(claim("a", "mine")));
    expect(again.noop).toBeUndefined();
    expect(h.state.nodes.a?.claim).toMatchObject({ token: "mine", at: h.now });
    expect(h.journal.filter((r) => r.event === "step_claimed").map((r) => r.renewed)).toEqual([
      undefined,
      true,
    ]);
  });

  test("t40_claim_lapses_after_ttl", () => {
    const h = openFork();
    must(h.send(claim("a", "old", 60_000)));
    h.advance(59_999);
    expect(must(h.send(claim("a", "new"))).noop).toBe(true);
    h.advance(1);
    expect(liveClaim(h.state.nodes.a, h.now)).toBeUndefined();
    const taken = must(h.send(claim("a", "new")));
    expect(taken.noop).toBeUndefined();
    expect(h.state.nodes.a?.claim?.token).toBe("new");
    // the answers follow the clock too
    const stepA = (options: NextStepOptions) =>
      nodeOf(h.next(options)).steps?.find((s) => s.slug === "a");
    expect(stepA(PARALLEL)).toMatchObject({ slug: "a", taken_by: "w-new" });
    h.advance(DEFAULT_CLAIM_TTL_S * 1000);
    expect(stepA(PARALLEL)?.taken_by).toBeUndefined();
  });

  test("t40_live_claim_does_not_lapse", () => {
    const h = openFork();
    must(h.send(claim("a", "mine", 60_000)));
    // renewed every half-TTL, the hold stands well past the TTL
    for (let i = 0; i < 10; i++) {
      h.advance(30_000);
      must(h.send(claim("a", "mine", 60_000)));
      expect(must(h.send(claim("a", "other", 60_000))).noop).toBe(true);
    }
    expect(h.state.nodes.a?.claim?.token).toBe("mine");
  });

  test("t40_claim_released_on_complete", () => {
    const h = host(FORK, (e) => (e.type === "run_check" && e.node === "a" ? undefined : answer(e)));
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(claim("a", "mine")));
    must(h.send(complete("a", 1, "mine")));
    expect(h.state.nodes.a?.claim).toBeUndefined();
    expect(h.events()).not.toContain("step_claim_conflict");
  });

  test("t40_second_completion_of_closed_step_is_noop", () => {
    const h = openFork();
    must(h.send(claim("a", "mine")));
    must(h.send(complete("a", 1, "mine")));
    const after = JSON.stringify(h.state);
    const again = must(h.send(complete("a", 1, "mine")));
    expect(again.noop).toBe(true);
    const bare = must(h.send(complete("a", 1)));
    expect(bare.noop).toBe(true);
    expect(JSON.stringify(h.state)).toBe(after);
    // the node is not reopened and nothing is journaled
    expect(h.events().filter((e) => e === "agent_completed")).toHaveLength(2); // plan and a
  });

  test("t40_complete_without_token_accepted_and_journaled", () => {
    const h = openFork();
    must(h.send(claim("a", "holder")));
    const done = must(h.send(complete("a", 1)));
    expect(done.noop).toBeUndefined();
    expect(h.state.nodes.a?.status).toBe("passed");
    expect(h.events()).toContain("step_claim_conflict");
    // and so is one with another token
    must(h.send(claim("b", "holder-b")));
    must(h.send(complete("b", 1, "someone-else")));
    expect(h.state.nodes.b?.status).toBe("passed");
    expect(h.journal.filter((r) => r.event === "step_claim_conflict")).toHaveLength(2);
  });

  test("t40_claim_events_are_capped", () => {
    const h = openFork();
    for (let i = 0; i < MAX_LOGGED_CLAIMS + 20; i++) {
      must(h.send(claim("a", "mine")));
    }
    expect(h.journal.filter((r) => r.event === "step_claimed")).toHaveLength(MAX_LOGGED_CLAIMS);
    // the claim itself is kept past the cap
    expect(h.state.nodes.a?.claim?.token).toBe("mine");
    // conflicts have their own cap: a long loop of a join's rework crossed by a stranger
    const loop = host(FORK, (e) =>
      e.type === "run_check" && e.node === "merge"
        ? {
            ...(answer(e) as Extract<RunEvent, { type: "check_finished" }>),
            passed: false,
            reason: "no",
          }
        : answer(e),
    );
    const bigMerge: PipelineSpec = {
      ...FORK,
      nodes: FORK.nodes.map((n) =>
        n.slug === "merge" ? { ...n, max_attempts: 1_000, max_consecutive_failures: 1_000 } : n,
      ),
    };
    loop.use(bigMerge);
    loop.send(START);
    loop.send(complete("plan", 1));
    loop.send(complete("a", 1));
    loop.send(complete("b", 1));
    for (let i = 1; i <= MAX_LOGGED_CLAIMS + 20; i++) {
      must(loop.send(claim("merge", `holder-${i}`)));
      must(loop.send(complete("merge", i)));
    }
    expect(loop.journal.filter((r) => r.event === "step_claim_conflict")).toHaveLength(
      MAX_LOGGED_CLAIMS,
    );
    expect(loop.state.claimEvents).toEqual({
      claimed: MAX_LOGGED_CLAIMS,
      conflicts: MAX_LOGGED_CLAIMS,
    });
  });

  test("t40_event_step_claimed_shape", () => {
    const h = openFork();
    must(h.send(claim("b", "abcdef0123456789", 120_000)));
    const record = h.journal.find((r) => r.event === "step_claimed");
    expect(record).toMatchObject({
      event: "step_claimed",
      node: "b",
      attempt: 1,
      by: "w-abcdef01",
      ttl_s: 120,
      fork: "f1",
      branch: "b",
    });
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("renewed");
  });

  test("t40_event_step_claim_conflict_shape", () => {
    const h = openFork();
    must(h.send(claim("a", "abcdef0123456789")));
    must(h.send(complete("a", 1)));
    const record = h.journal.find((r) => r.event === "step_claim_conflict");
    expect(record).toEqual({
      v: 2,
      seq: record?.seq as number,
      ts: h.now,
      event: "step_claim_conflict",
      node: "a",
      attempt: 1,
      holder: "w-abcdef01",
      token_given: false,
    });
    must(h.send(claim("b", "abcdef0123456789")));
    must(h.send(complete("b", 1, "other")));
    expect(h.journal.find((r) => r.event === "agent_completed" && r.node === "b")).toBeDefined();
    expect(
      h.journal.find((r) => r.event === "step_claim_conflict" && r.node === "b"),
    ).toMatchObject({
      token_given: true,
    });
  });

  test("t40_redact_step_claim_conflict", () => {
    // The record is built from the hash alone: whatever the host hashed, no token and nothing
    // around it reaches the journal, and the hash itself is cut to a mark.
    const h = openFork();
    const hash = "deadbeefcafef00ddeadbeefcafef00d";
    must(h.send(claim("a", hash)));
    must(h.send(complete("a", 1, "AKIAIOSFODNN7EXAMPLE")));
    const text = JSON.stringify(h.journal);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain(hash);
    expect(text).toContain("w-deadbeef");
  });

  test("t40_redact_taken_by", () => {
    const h = openFork();
    const hash = "deadbeefcafef00ddeadbeefcafef00d";
    must(h.send(claim("a", hash)));
    const node = nodeOf(h.next(PARALLEL));
    expect(node.steps?.find((s) => s.slug === "a")?.taken_by).toBe("w-deadbeef");
    expect(JSON.stringify(h.next(PARALLEL))).not.toContain(hash);
    must(h.send(claim("b", "x")));
    const running = runningOf(h.next(PARALLEL));
    expect(JSON.stringify(running)).not.toContain(hash);
  });

  test("t40_claim_survives_node_restart", () => {
    // The step is restarted under its worker by an accepted change of its definition.
    const h = openFork();
    must(h.send(claim("a", "mine")));
    const changed: PipelineSpec = {
      ...FORK,
      nodes: FORK.nodes.map((n) =>
        n.slug === "a" ? { ...n, params: { ...n.params, prompt: "do a carefully" } } : n,
      ),
    };
    h.use(changed);
    must(
      h.send({ type: "pipeline_accepted", from: "h", to: "h2", source: "proposal", before: FORK }),
    );
    expect(h.state.active.find((v) => v.node === "a")?.attempt).toBe(2);
    expect(h.state.nodes.a?.claim?.token).toBe("mine");
    // the old attempt's completion tells the worker what to do
    const error = refusal(h.send(complete("a", 1, "mine")));
    expect(error.code).toBe("ATTEMPT_MISMATCH");
    expect(error.message).toContain(
      "the step was restarted; call pipeline_take_step with your token to continue",
    );
    // the worker's take with its token answers the new attempt, and nobody else is handed the step
    expect(must(h.send(claim("a", "mine"))).noop).toBeUndefined();
    expect(must(h.send(claim("a", "someone"))).noop).toBe(true);
    expect(nodeOf(h.next({ ...PARALLEL, nodeSlug: "a" }))).toMatchObject({
      attempt: 2,
      taken_by: "w-mine",
    });
    must(h.send(complete("a", 2, "mine")));
    expect(h.state.nodes.a?.status).toBe("passed");
  });

  test("t40_attempt_mismatch_text_tells_worker_to_retake", () => {
    // Without a claim the text is the plain one: nothing to retake.
    const h = openFork();
    const plain = refusal(h.send(complete("a", 7)));
    expect(plain.code).toBe("ATTEMPT_MISMATCH");
    expect(plain.message).not.toContain("pipeline_take_step");
    must(h.send(claim("a", "mine")));
    const held = refusal(h.send(complete("a", 7, "mine")));
    expect(held.message).toContain('node "a" is on attempt 1, not 7');
    expect(held.message).toContain("call pipeline_take_step with your token to continue");
    // another token, or none, while the claim is live: the step is not theirs to retake
    for (const other of ["theirs", undefined]) {
      const stranger = refusal(h.send(complete("a", 7, other)));
      expect(stranger.code).toBe("ATTEMPT_MISMATCH");
      expect(stranger.message).not.toContain("pipeline_take_step");
    }
  });

  test("t40_take_any_honours_max_parallel", () => {
    // Two steps may be held at once; a take without a slug meets the cap like `pipeline_next_step`
    // does (the third step is `queued` there), and a take by slug is of a step that was handed out
    const h = openFork(THREE);
    const take = (token: string, node?: string): RunEvent => ({
      type: "step_claimed",
      ...(node === undefined ? {} : { node }),
      token,
      ttlMs: 60_000,
      maxParallel: 2,
    });
    must(h.send(take("w1")));
    expect(h.state.nodes.a?.claim?.token).toBe("w1");
    const shown = nodeOf(h.next({ agents: { mode: "parallel", maxParallel: 2 } }));
    expect(shown.steps?.map((s) => s.slug)).toEqual(["b", "a"]);
    expect(shown.queued).toBe(1);
    must(h.send(take("w2")));
    expect(h.state.nodes.b?.claim?.token).toBe("w2");
    const third = must(h.send(take("w3")));
    expect(third.noop).toBe(true);
    expect(h.state.nodes.c?.claim).toBeUndefined();
    // the holder of a step renews it under the cap all the same
    h.advance(1_000);
    expect(must(h.send(take("w1"))).noop).toBeUndefined();
    expect(h.state.nodes.a?.claim?.at).toBe(h.now);
    // once a step is handed in, the next free one can be taken
    must(h.send(complete("a", 1, "w1")));
    must(h.send(take("w3")));
    expect(h.state.nodes.c?.claim?.token).toBe("w3");
    // without the cap (an engine without the config) a take is never held back
    const g = openFork(THREE);
    for (const token of ["w1", "w2", "w3"]) {
      must(g.send({ type: "step_claimed", token, ttlMs: 60_000 }));
    }
    expect(g.state.nodes.c?.claim?.token).toBe("w3");
  });

  test("t40_claim_cleared_on_a_new_visit_of_the_node", () => {
    // A loop back to the fork makes new visits: a worker's old hold on `a` does not carry over.
    const h = host(FORK, (e) =>
      e.type === "run_command" && e.node === "ship"
        ? { type: "work_finished", node: "ship", attempt: e.attempt, passed: false, reason: "red" }
        : answer(e),
    );
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(claim("a", "mine")));
    must(h.send(complete("a", 1, "mine")));
    must(h.send(complete("b", 1)));
    must(h.send(complete("merge", 1)));
    expect(h.state.active.map((v) => v.node)).toEqual(["plan"]);
    must(h.send(complete("plan", 2)));
    expect(h.state.nodes.a?.claim).toBeUndefined();
  });
});

// ── completion answers ──────────────────────────────────────────────────────

describe("t40 what a completion answers", () => {
  test("t40_complete_step_next_never_claims", () => {
    const h = openFork();
    must(h.send(complete("a", 1)));
    const before = JSON.stringify(h.state);
    h.next({ ...PARALLEL, completionOf: "a" });
    expect(JSON.stringify(h.state)).toBe(before);
    expect(h.state.nodes.b?.claim).toBeUndefined();
  });

  test("t40_complete_next_never_shows_sibling_step", () => {
    const h = openFork();
    must(h.send(complete("a", 1)));
    const running = runningOf(h.next({ ...PARALLEL, completionOf: "a" }));
    expect(running.open_steps).toEqual([{ node_slug: "b", attempt: 1 }]);
    expect(running.hint).toContain("not yours to pick here");
    expect(JSON.stringify(running)).not.toContain("do b");
    // the plain next_step hands the sibling out
    expect(nodeOf(h.next(PARALLEL)).slug).toBe("b");
  });

  test("t40_complete_next_shows_own_rework_and_what_the_completion_opened", () => {
    // the own step again when its checks sent it back
    const h = host(FORK, (e) =>
      e.type === "run_check" && e.node === "a"
        ? {
            ...(answer(e) as Extract<RunEvent, { type: "check_finished" }>),
            passed: false,
            reason: "no",
          }
        : answer(e),
    );
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("a", 1)));
    const own = nodeOf(h.next({ ...PARALLEL, completionOf: "a" }));
    expect(own).toMatchObject({ slug: "a", attempt: 2 });
    expect(own.steps).toBeUndefined();
    // the fork the completion opened is the completer's to hand out, and so is a successor
    const fresh = host(FORK);
    fresh.send(START);
    must(fresh.send(complete("plan", 1)));
    expect(
      nodeOf(fresh.next({ ...PARALLEL, completionOf: "plan" })).steps?.map((s) => s.slug),
    ).toEqual(["a", "b"]);
    must(fresh.send(complete("a", 1)));
    must(fresh.send(complete("b", 1)));
    expect(nodeOf(fresh.next({ ...PARALLEL, completionOf: "b" })).slug).toBe("merge");
  });

  test("t40_worker_completion_that_opens_steps_gets_a_summary", () => {
    // A worker's completion forks: the branches are the starting agent's to hand out, so the worker
    // is told to report back, not handed `steps` to act on. The same for a successor and the join.
    const h = host(FORK);
    h.send(START);
    must(h.send(claim("plan", "w0")));
    must(h.send(complete("plan", 1, "w0")));
    const forked = runningOf(h.next({ ...PARALLEL, completionOf: "plan", worker: true }));
    expect(forked.open_steps?.map((s) => s.node_slug)).toEqual(["a", "b"]);
    expect(forked.hint).toContain("Report this answer");
    expect(forked.hint).not.toContain("start one subagent");
    expect(JSON.stringify(forked)).not.toContain("do a");
    // the starting agent is handed them
    expect(nodeOf(h.next({ ...PARALLEL, completionOf: "plan" })).steps?.map((s) => s.slug)).toEqual(
      ["a", "b"],
    );
    must(h.send(claim("a", "wa")));
    must(h.send(claim("b", "wb")));
    must(h.send(complete("a", 1, "wa")));
    must(h.send(complete("b", 1, "wb")));
    // the join opened by the last branch's worker: a summary for the worker, the step for the agent
    const joined = runningOf(h.next({ ...PARALLEL, completionOf: "b", worker: true }));
    expect(joined.open_steps).toEqual([{ node_slug: "merge", attempt: 1 }]);
    expect(nodeOf(h.next({ ...PARALLEL, completionOf: "b" })).slug).toBe("merge");
    // a worker's own rework stays a `node` answer (`t40_complete_next_shows_own_rework_and_what_the_completion_opened`)
    const g = host(FORK, (e) =>
      e.type === "run_check" && e.node === "a"
        ? {
            ...(answer(e) as Extract<RunEvent, { type: "check_finished" }>),
            passed: false,
            reason: "no",
          }
        : answer(e),
    );
    g.send(START);
    g.send(complete("plan", 1));
    must(g.send(claim("a", "wa")));
    must(g.send(complete("a", 1, "wa")));
    const own = nodeOf(g.next({ ...PARALLEL, completionOf: "a", worker: true }));
    expect(own).toMatchObject({ slug: "a", attempt: 2 });
    expect(own.steps).toBeUndefined();
  });

  test("t40_worker_calls_get_no_wait_offer_and_no_dialog_text", () => {
    const h = openFork(GATED);
    must(h.send(complete("b", 1)));
    must(h.send(complete("a", 1)));
    // the run waits at b's gate; a worker is told to report, a plain caller to write to the person
    const worker = waitingOf(h.next({ completionOf: "a", worker: true }));
    expect(worker.tell_the_person).not.toContain("start `kodel wait r1`");
    expect(worker.tell_the_person).not.toContain("Write to the person");
    expect(worker.tell_the_person).toContain("Report this answer");
    const plain = waitingOf(h.next({ completionOf: "a" }));
    expect(plain.tell_the_person).toContain("start `kodel wait r1`");
    // a worker is never offered the person's decisions either
    const decider = waitingOf(
      h.next({ completionOf: "a", worker: true, agentDecisions: { gate: true } }),
    );
    expect(decider.tell_the_person).not.toContain("pipeline_decide_gate");
    // done, for a worker
    must(h.send(approve("b-gate")));
    must(h.send(complete("merge", 1)));
    const done = h.next({ completionOf: "merge", worker: true });
    expect(done).toMatchObject({ done: true, run_status: "completed" });
    if ("done" in done) expect(done.tell_the_person).toContain("Report this answer");
  });
});

// ── what waits besides ──────────────────────────────────────────────────────

describe("t40 what waits besides", () => {
  test("t40_node_answer_carries_also_waiting_text", () => {
    const h = openFork(GATED);
    must(h.send(complete("b", 1)));
    const node = nodeOf(h.next(PARALLEL));
    expect(node.slug).toBe("a");
    expect(node.also_waiting).toEqual([
      {
        reason: "gate",
        node_slug: "b-gate",
        prompt: "b fine?",
        how_to_decide: { cli: 'kodel gate approve|reject r1 --reason "..."' },
      },
    ]);
    expect(node.note).toContain('gate "b-gate"');
    expect(node.note).toContain("Tell them when you report");
    // a running answer carries it too
    must(h.send(claim("a", "x")));
    const running = runningOf(h.next(PARALLEL));
    expect(running.also_waiting?.[0]?.node_slug).toBe("b-gate");
    expect(running.note).toContain('gate "b-gate"');
  });

  test("t40_waiting_answer_lists_other_gates_and_how_to_decide_carries_node", () => {
    const h = openFork(TWO_GATES);
    const waiting = waitingOf(h.next());
    expect(waiting.node_slug).toBe("a-gate");
    expect(waiting.how_to_decide.cli).toBe(
      'kodel gate approve|reject r1 --node a-gate --reason "..."',
    );
    expect(waiting.also_waiting).toEqual([
      {
        reason: "gate",
        node_slug: "b-gate",
        prompt: "b?",
        how_to_decide: { cli: 'kodel gate approve|reject r1 --node b-gate --reason "..."' },
      },
    ]);
    expect(waiting.tell_the_person).toContain('gate "b-gate"');
    expect(waiting.tell_the_person).toContain("--node b-gate");
    // with one gate left the command needs no node
    must(h.send(approve("a-gate")));
    const one = waitingOf(h.next());
    expect(one.how_to_decide.cli).toBe('kodel gate approve|reject r1 --reason "..."');
    expect(one.also_waiting).toBeUndefined();
  });

  test("t40_node_answer_names_a_paused_branch", () => {
    // b's failure goes back to b, so that branch runs out of attempts and pauses on its own
    const pausing: PipelineSpec = {
      ...FORK,
      edges: FORK.edges.map((e) =>
        e.from === "b-test" && e.when === "failed" ? { ...e, to: "b" } : e,
      ),
    };
    const h = host(pausing, (e) =>
      e.type === "run_command" && e.node === "b-test"
        ? {
            type: "work_finished",
            node: "b-test",
            attempt: e.attempt,
            passed: false,
            reason: "red",
          }
        : answer(e),
    );
    h.send(START);
    h.send(complete("plan", 1));
    // b's command fails, b has one attempt: that branch pauses while a is still open
    for (let i = 1; h.state.active.some((v) => v.node === "b"); i++) must(h.send(complete("b", i)));
    // the command failed in a row: the pause names it, and `resume` gives that branch its budget
    expect(h.state.pauses.map((p) => p.node)).toEqual(["b-test"]);
    expect(h.state.status).toBe("running");
    const node = nodeOf(h.next());
    expect(node.slug).toBe("a");
    expect(node.also_waiting).toEqual([
      {
        reason: "paused",
        node_slug: "b-test",
        prompt: expect.stringContaining("The run is paused: a node failed too many times in a row"),
        how_to_decide: { cli: "kodel resume r1" },
      },
    ]);
    expect(node.note).toContain('pause "b-test"');
  });

  test("t40_doomed_fork_text_on_node_answer", () => {
    const doomed: PipelineSpec = {
      ...FORK,
      edges: FORK.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const h = host(doomed, (e) =>
      e.type === "run_command" && e.node === "b-test"
        ? {
            type: "work_finished",
            node: "b-test",
            attempt: e.attempt,
            passed: false,
            reason: "red",
          }
        : answer(e),
    );
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("b", 1)));
    expect(h.state.status).toBe("running");
    const node = nodeOf(h.next());
    expect(node.slug).toBe("a");
    expect(node.note).toContain("A branch of the fork is dead");
    expect(node.note).toContain('branch "b" failed at "b-test" (command): red');
    expect(node.note).toContain(
      "finish the open steps; the run ends failed when the others have settled",
    );
    // the step is still worked, and the run ends failed once it settles
    must(h.send(complete("a", 1)));
    expect(h.state.status).toBe("failed");
    expect(h.next()).toMatchObject({ done: true, run_status: "failed" });
  });
});

// ── sixth review ────────────────────────────────────────────────────────────

describe("t40 workers and the cap after a completion", () => {
  test("t40_running_answer_to_a_worker_says_report_back", () => {
    // a's command is still running and b's branch has arrived: the run is only `running`
    const h = openFork(FORK, (e) =>
      e.type === "run_command" && e.node === "a-test" ? undefined : answer(e),
    );
    must(h.send(complete("b", 1)));
    must(h.send(claim("a", "wa")));
    must(h.send(complete("a", 1, "wa")));
    expect(h.state.active.map((v) => v.node)).toEqual(["a-test"]);
    const plain = runningOf(h.next({ ...PARALLEL, completionOf: "a" }));
    expect(plain.hint).toContain("wait_s");
    const worker = runningOf(h.next({ ...PARALLEL, completionOf: "a", worker: true }));
    expect(worker.hint).toContain("Report this answer");
    expect(worker.hint).toContain("do not write to the person");
    expect(worker.hint).not.toContain("wait_s");
  });

  test("t40_completion_answer_counts_sibling_held_steps_against_the_cap", () => {
    // branch a has two agent steps; b's step is held by a worker; cap 1: a1's completion opens a2,
    // but one step is already in flight, so a2 is queued, not handed out
    const LONG = parsePipeline(
      yaml([
        "name: long",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: a1, kind: agent, prompt: a1 }",
        "  - { slug: a2, kind: agent, prompt: a2 }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: merge, join: all }",
        "edges:",
        "  - { from: plan, to: a1 }",
        "  - { from: plan, to: b }",
        "  - { from: a1, to: a2 }",
        "  - { from: a2, to: merge }",
        "  - { from: b, to: merge }",
      ]),
    );
    const capped = { agents: { mode: "parallel" as const, maxParallel: 1 } };
    const h = openFork(LONG);
    must(h.send(claim("b", "wb")));
    must(h.send(complete("a1", 1)));
    const answer = runningOf(h.next({ ...capped, completionOf: "a1" }));
    expect(answer.queued).toBe(1);
    expect(answer.hint).toContain("max_parallel");
    // with room under the cap, a2 is handed out
    expect(nodeOf(h.next({ ...PARALLEL, completionOf: "a1" })).slug).toBe("a2");
  });
});

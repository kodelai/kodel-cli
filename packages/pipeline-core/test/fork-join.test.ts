/**
 * Forks and joins (T-40): the graph rules, the machine, failed branches and `restart_failed`,
 * pauses per branch, the journal, and the texts the core composes from event text.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalNode,
  canonicalPipeline,
  decide,
  defaultRegistry,
  diffPipelines,
  type Effect,
  type EngineOptions,
  type JournalRecord,
  labelsOf,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  parseSnapshot,
  RECORD_VERSION,
  RESTART_FAILED,
  type RunEvent,
  type RunState,
  validatePipeline,
} from "../src";

// ── pipelines ───────────────────────────────────────────────────────────────

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

/** Two branches of an agent step and a command each, a join with a check, a loop back from `ship`. */
const FORK = yaml([
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - slug: a",
  "    kind: agent",
  "    prompt: a",
  "    checks: [{ kind: command, command: a-check }]",
  "  - { slug: a-test, kind: command, command: a-test }",
  "  - { slug: b, kind: agent, prompt: b }",
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
  "  - { from: a-test, to: a, when: failed }",
  "  - { from: b, to: b-test }",
  "  - { from: b-test, to: merge }",
  "  - { from: b-test, to: merge, when: failed }",
  "  - { from: merge, to: ship }",
  "  - { from: ship, to: plan, when: failed }",
]);

/** A gate in each branch: one sends a rejection back inside its branch, the other to the join. */
const GATED = yaml([
  "name: gated",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a? }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: b-gate, kind: human, prompt: b? }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: b-gate }",
  "  - { from: b-gate, to: merge, when: approved }",
  "  - { from: b-gate, to: merge, when: rejected }",
]);

const fork = parsePipeline(FORK);
const gated = parsePipeline(GATED);

const START: RunEvent = { type: "start", runId: "r1", task: "split the work", specHash: "h" };

const problems = (text: string) => {
  const result = validatePipeline(text);
  return result.ok ? [] : result.issues.map((i) => i.message);
};

const refused = (text: string, ...fragments: string[]) => {
  const messages = problems(text);
  expect(messages.length).toBeGreaterThan(0);
  for (const fragment of fragments) {
    expect(
      messages.some((m) => m.includes(fragment)),
      `${fragment}\n${messages.join("\n")}`,
    ).toBe(true);
  }
};

// ── a tiny host ─────────────────────────────────────────────────────────────

function answer(effect: Effect): RunEvent | undefined {
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

/**
 * Sends events and answers every effect through `reply` (everything passes by default); `hold`
 * names the nodes whose effects are kept for the test to answer by hand.
 */
function host(
  spec: PipelineSpec,
  reply: (effect: Effect, state: RunState) => RunEvent | undefined = answer,
  options: EngineOptions = {},
) {
  let state: RunState | undefined;
  let now = 0;
  const journal: JournalRecord[] = [];
  const effects: Effect[] = [];
  const held: Effect[] = [];
  const hold = new Set<string>();
  const send = (first: RunEvent) => {
    const queue = [first];
    let firstResult: ReturnType<typeof decide> | undefined;
    while (queue.length > 0) {
      const event = queue.shift() as RunEvent;
      const result = decide(spec, state, event, now, options);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        throw new Error(`a follow-up was refused: ${result.error.code} ${result.error.message}`);
      }
      state = result.state;
      journal.push(...result.journal);
      for (const effect of result.effects) {
        effects.push(effect);
        // a held node's step or command waits for the test; its checks run as usual
        if ("node" in effect && effect.type !== "run_check" && hold.has(effect.node)) {
          held.push(effect);
          continue;
        }
        const next = reply(effect, result.state);
        if (next) queue.push(next);
      }
    }
    return firstResult as ReturnType<typeof decide>;
  };
  return {
    send,
    journal,
    effects,
    held,
    hold: (...nodes: string[]) => {
      for (const node of nodes) hold.add(node);
    },
    release: (node: string) => {
      hold.delete(node);
      const mine = held.filter((e) => "node" in e && e.node === node);
      for (const effect of mine) held.splice(held.indexOf(effect), 1);
      for (const effect of mine) {
        const next = reply(effect, state as RunState);
        if (next) send(next);
      }
    },
    advance: (ms: number) => {
      now += ms;
    },
    events: () => journal.map((r) => r.event),
    get state() {
      return state as RunState;
    },
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

const complete = (node: string, attempt: number, outcome?: string): RunEvent => ({
  type: "agent_completed",
  node,
  attempt,
  ...(outcome === undefined ? {} : { outcome }),
});
const fails =
  (node: string, reason = "exit 1") =>
  (effect: Effect) =>
    effect.type === "run_command" && effect.node === node
      ? {
          type: "work_finished" as const,
          node: effect.node,
          attempt: effect.attempt,
          passed: false,
          reason,
        }
      : answer(effect);
const approve = (node: string): RunEvent => ({ type: "human_decided", node, decision: "approved" });
const reject = (node: string, reason: string): RunEvent => ({
  type: "human_decided",
  node,
  decision: "rejected",
  reason,
});

/** The fork run with both agent steps held, so the test drives the branches. */
function openFork(reply = answer) {
  const h = host(fork, reply);
  h.hold("a", "b", "merge");
  h.send(START);
  h.send(complete("plan", 1));
  return h;
}

// ── parse and validate ──────────────────────────────────────────────────────

describe("t40 parse and validate", () => {
  test("t40_fork_two_edges_same_from_when_parse", () => {
    expect(fork.edges.filter((e) => e.from === "plan" && e.when === "passed")).toHaveLength(2);
    expect(fork.nodes.find((n) => n.slug === "merge")?.join).toBe("all");
    expect(fork.nodes.find((n) => n.slug === "a")?.join).toBeUndefined();
  });

  test("t40_duplicate_edge_refused", () => {
    refused(
      FORK.replace("  - { from: a, to: a-test }\n", "  - { from: a, to: a-test }\n".repeat(2)),
      'edge from "a" to "a-test" when "passed" is listed twice',
    );
  });

  test("t40_default_when_equals_first_success_label_is_duplicate", () => {
    // An edge without `when` and one that names the first success label are the same edge.
    refused(
      FORK.replace(
        "  - { from: a, to: a-test }\n",
        "  - { from: a, to: a-test }\n  - { from: a, to: a-test, when: passed }\n",
      ),
      "is listed twice",
    );
  });

  test("t40_fork_without_join_refused", () => {
    refused(
      yaml([
        "name: nojoin",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
      ]),
      'node "plan" has 2 edges for "passed"',
      "`join: all`",
      "used to be ignored",
    );
  });

  test("t40_join_all_is_a_generic_node_field", () => {
    // Any kind takes it: a command join and a human join parse.
    const text = FORK.replace(
      "  - slug: merge\n    kind: agent\n    prompt: merge\n    join: all\n    checks: [{ kind: command, command: merge-check }]\n",
      "  - { slug: merge, kind: command, command: merge, join: all }\n",
    ).replace(
      "  - { from: merge, to: ship }\n",
      "  - { from: merge, to: ship }\n  - { from: merge, to: ship, when: failed }\n",
    );
    const spec = parsePipeline(text);
    expect(spec.nodes.find((n) => n.slug === "merge")).toMatchObject({
      kind: "command",
      join: "all",
    });
    expect(spec.nodes.find((n) => n.slug === "merge")?.params).not.toHaveProperty("join");
  });

  test("t40_join_other_value_refused", () => {
    refused(FORK.replace("join: all", "join: any"), "join");
  });

  test("t40_validate_valid_fork_join_accepted", () => {
    expect(problems(FORK)).toEqual([]);
    expect(problems(GATED)).toEqual([]);
  });

  test("t40_validate_fork_reaches_join", () => {
    expect(fork.nodes.find((n) => n.slug === "merge")?.join).toBe("all");
    // a branch whose steps never lead to the join
    refused(
      FORK.replace(
        "  - { from: b-test, to: merge }\n  - { from: b-test, to: merge, when: failed }\n",
        "  - { from: b-test, to: b, when: failed }\n",
      ),
      'node "b-test" is in a branch of the fork at "plan" ("passed") and has no edge for "passed"',
    );
  });

  test("t40_validate_dangling_branch", () => {
    refused(
      yaml([
        "name: dangling",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: merge }",
      ]),
      'node "b" is in a branch',
      'has no edge for "passed"',
    );
  });

  test("t40_validate_no_entry_into_section", () => {
    refused(
      FORK.replace(
        "  - { from: ship, to: plan, when: failed }\n",
        "  - { from: ship, to: b, when: failed }\n",
      ),
      'edge from "ship" to "b" enters a branch of the fork at "plan" ("passed") from outside',
    );
    refused(
      FORK.replace(
        "  - { from: ship, to: plan, when: failed }\n",
        "  - { from: ship, to: merge, when: failed }\n",
      ),
      'edge from "ship" enters the join "merge" from outside',
    );
  });

  test("t40_validate_no_exit_but_join", () => {
    refused(
      FORK.replace(
        "  - { from: a-test, to: a, when: failed }\n",
        "  - { from: a-test, to: ship, when: failed }\n",
      ),
      'edge from "a-test" to "ship" leaves a branch of the fork at "plan" ("passed")',
    );
  });

  test("t40_validate_branches_disjoint", () => {
    refused(
      FORK.replace(
        "  - { from: a-test, to: a, when: failed }\n",
        "  - { from: a-test, to: b, when: failed }\n",
      ),
      'node "b" is reached by two branches',
      "branches do not share steps",
    );
  });

  test("t40_validate_join_without_fork", () => {
    refused(
      yaml([
        "name: lonely",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: plan, to: merge }",
      ]),
      'node "merge" has `join: all` but no fork leads to it',
    );
  });

  test("t40_validate_nested_fork_refused", () => {
    refused(
      yaml([
        "name: nested",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: a1, kind: agent, prompt: a1 }",
        "  - { slug: a2, kind: agent, prompt: a2 }",
        "  - { slug: inner, kind: agent, prompt: i, join: all }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: a1 }",
        "  - { from: a, to: a2 }",
        "  - { from: a1, to: inner }",
        "  - { from: a2, to: inner }",
        "  - { from: inner, to: merge }",
        "  - { from: b, to: merge }",
      ]),
      "a fork inside a fork is not supported",
    );
  });

  test("t40_validate_two_forks_same_node_refused", () => {
    refused(
      yaml([
        "name: twice",
        "nodes:",
        "  - { slug: build, kind: command, command: b }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "  - { slug: fix-a, kind: agent, prompt: fa }",
        "  - { slug: fix-b, kind: agent, prompt: fb }",
        "  - { slug: merge-fix, kind: agent, prompt: mf, join: all }",
        "edges:",
        "  - { from: build, to: a }",
        "  - { from: build, to: b }",
        "  - { from: build, to: fix-a, when: failed }",
        "  - { from: build, to: fix-b, when: failed }",
        "  - { from: a, to: merge }",
        "  - { from: b, to: merge }",
        "  - { from: fix-a, to: merge-fix }",
        "  - { from: fix-b, to: merge-fix }",
      ]),
      'node "build" forks on more than one label',
    );
  });

  test("t40_validate_failure_edge_before_fork_refused", () => {
    // A branch routes a failure to the node before the fork: that would start the fork again
    // while the sibling branch still runs.
    refused(
      FORK.replace(
        "  - { from: a-test, to: a, when: failed }\n",
        "  - { from: a-test, to: plan, when: failed }\n",
      ),
      'edge from "a-test" to "plan" leaves a branch of the fork at "plan" ("passed")',
    );
    // and a human node in a branch routes `rejected` inside or to the join, not before the fork
    refused(
      GATED.replace(
        "  - { from: a-gate, to: a, when: rejected }\n",
        "  - { from: a-gate, to: plan, when: rejected }\n",
      ),
      'edge from "a-gate" to "plan" leaves a branch',
    );
    // a failure routed to a step before the fork that is not the fork node itself
    refused(
      yaml([
        "name: upstream",
        "nodes:",
        "  - { slug: prep, kind: agent, prompt: p }",
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: a-test, kind: command, command: t }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: prep, to: plan }",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: a-test }",
        "  - { from: a-test, to: merge }",
        "  - { from: a-test, to: prep, when: failed }",
        "  - { from: b, to: merge }",
      ]),
      // the loop a-test -> prep -> plan is a branch leaving; which of its two edges is named is
      // not fixed (either one makes the loop)
      "leaves a branch",
    );
  });

  test("t40_validate_region_with_two_joins_refused", () => {
    refused(
      yaml([
        "name: twojoins",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: j1, kind: agent, prompt: j1, join: all }",
        "  - { slug: j2, kind: agent, prompt: j2, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: j1 }",
        "  - { from: b, to: j2 }",
      ]),
      "lead to several `join: all` nodes",
    );
  });

  test("t40_validate_join_reached_from_two_forks_refused", () => {
    refused(
      yaml([
        "name: shared",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "  - { slug: again, kind: agent, prompt: g }",
        "  - { slug: c, kind: agent, prompt: c }",
        "  - { slug: d, kind: agent, prompt: d }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: b }",
        "  - { from: a, to: merge }",
        "  - { from: b, to: merge }",
        "  - { from: merge, to: again }",
        "  - { from: again, to: c }",
        "  - { from: again, to: d }",
        "  - { from: c, to: merge }",
        "  - { from: d, to: merge }",
      ]),
      "join",
    );
  });

  test("t40_restart_failed_needs_outcomes_kind", () => {
    const registry = defaultRegistry();
    const merge = fork.nodes.find((n) => n.slug === "merge") as PipelineSpec["nodes"][number];
    expect(labelsOf(registry, merge)?.success).toEqual(["passed", RESTART_FAILED]);
    // a command join has no outcomes, so no restart_failed: an edge on it is refused
    const commandJoin = FORK.replace(
      "  - slug: merge\n    kind: agent\n    prompt: merge\n    join: all\n    checks: [{ kind: command, command: merge-check }]\n",
      "  - { slug: merge, kind: command, command: merge, join: all }\n",
    ).replace(
      "  - { from: merge, to: ship }\n",
      "  - { from: merge, to: ship }\n  - { from: merge, to: ship, when: failed }\n  - { from: merge, to: ship, when: restart_failed }\n",
    );
    refused(commandJoin, 'node "merge" (kind command) cannot emit "restart_failed"');
    const human = { kind: "human", on_fail: "failed", checks: [], join: "all" as const };
    expect(labelsOf(registry, human)?.success).toEqual(["approved"]);
  });

  test("t40_restart_failed_exempt_from_edge_rule", () => {
    // every other outcome needs an edge; the reserved one does not, and a plain agent node with
    // an outcome and no edge is still refused
    expect(problems(FORK)).toEqual([]);
    refused(
      FORK.replace(
        "  - { slug: plan, kind: agent, prompt: plan }\n",
        "  - { slug: plan, kind: agent, prompt: plan, outcomes: [nothing] }\n",
      ),
      'node "plan" can finish with "nothing" but has no outgoing edge for it',
    );
  });

  test("t40_restart_failed_not_listable_in_outcomes", () => {
    refused(
      FORK.replace("    join: all\n", "    join: all\n    outcomes: [restart_failed]\n"),
      '"restart_failed" is reserved for a join',
    );
    // nor on a node that is not a join
    refused(
      FORK.replace(
        "  - { slug: plan, kind: agent, prompt: plan }\n",
        "  - { slug: plan, kind: agent, prompt: plan, outcomes: [restart_failed] }\n",
      ),
      '"restart_failed" is reserved for a join',
    );
  });

  test("t40_labels_of_is_single_source", () => {
    const registry = defaultRegistry();
    const merge = fork.nodes.find((n) => n.slug === "merge") as PipelineSpec["nodes"][number];
    const labels = labelsOf(registry, merge);
    // what the agent is offered is exactly what the validator and the completion accept
    const h = openFork();
    h.release("a");
    h.release("b");
    const step = nextStep(fork, h.state, 0);
    expect("node" in step && step.node.outcomes).toEqual(labels?.success.slice(1));
    expect(refusal(h.send(complete("merge", 1, "made_up"))).message).toContain(
      `it may finish with: ${labels?.success.slice(1).join(", ")}`,
    );
    // a kind the registry does not know has no labels
    expect(labelsOf(registry, { kind: "nope", on_fail: "failed", checks: [] })).toBeUndefined();
  });
});

// ── the machine ─────────────────────────────────────────────────────────────

describe("t40 fork machine", () => {
  test("t40_fork_enters_all_branches", () => {
    const h = openFork();
    expect(h.state.active.map((v) => v.node).sort()).toEqual(["a", "b"]);
    expect(h.state.active.map((v) => v.fork)).toEqual([
      { id: "f1", branch: "a" },
      { id: "f1", branch: "b" },
    ]);
    expect(h.state.forks?.f1).toMatchObject({
      from: "plan",
      label: "passed",
      join: "merge",
      branches: ["a", "b"],
      arrived: {},
      joined: 0,
    });
    expect(h.state.trail).toEqual(["plan", "a", "b"]);
    expect(h.events()).toEqual([
      "run_started",
      "node_entered",
      "agent_completed",
      "node_finished",
      "fork_started",
      "node_entered",
      "node_entered",
    ]);
    expect(h.state.status).toBe("running");
  });

  test("t40_join_waits_for_all_branches", () => {
    const h = openFork();
    h.release("a");
    expect(h.state.forks?.f1?.arrived).toEqual({ a: { node: "a-test", label: "passed" } });
    expect(h.state.active.map((v) => v.node)).toEqual(["b"]);
    expect(h.state.nodes.merge?.attempt).toBe(0);
    h.release("b");
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge).toMatchObject({ attempt: 1, lastFailures: [] });
    expect(h.state.nodes.merge?.fork).toBeUndefined();
    expect(h.state.forks?.f1?.joined).toBe(1);
  });

  test("t40_join_enters_once", () => {
    const h = openFork();
    h.release("a");
    h.release("b");
    h.release("merge");
    expect(h.journal.filter((r) => r.event === "node_entered" && r.node === "merge")).toHaveLength(
      1,
    );
    expect(h.journal.filter((r) => r.event === "join_reached")).toHaveLength(1);
    expect(h.state.status).toBe("completed");
  });

  test("t40_run_ends_when_no_visit_left", () => {
    const h = openFork();
    h.release("b");
    h.release("a");
    h.release("merge");
    expect(h.state.trail).toEqual(["plan", "a", "b", "b-test", "a-test", "merge", "ship"]);
    expect(h.state.active).toEqual([]);
    expect(h.state.status).toBe("completed");
    expect(h.journal.at(-1)).toMatchObject({ event: "run_finished", status: "completed" });
  });

  test("t40_fork_in_loop_reopens", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "ship" && effect.attempt === 1
        ? fails("ship")(effect)
        : answer(effect),
    );
    h.send(START);
    // ship failed, back to plan, the fork fires again as a new instance
    const pass = ["plan", "a", "b", "b-test", "a-test", "merge", "ship"];
    expect(h.state.trail).toEqual([...pass, ...pass]);
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2"]);
    expect(h.state.forks?.f1?.joined).toBe(1);
    expect(h.state.forks?.f2?.joined).toBe(1);
    expect(h.state.status).toBe("completed");
    expect(h.journal.filter((r) => r.event === "fork_started")).toHaveLength(2);
  });

  test("t40_loop_after_join_cannot_reach_fork_while_branch_dead", () => {
    // a dead branch: the edge of b-test's failure is taken away, as an accepted change could
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const h = host(doomed, fails("b-test"));
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", dead: true });
    expect(h.state.status).toBe("running");
    h.release("a");
    expect(h.state.nodes.merge?.attempt).toBe(0);
    expect(h.journal.filter((r) => r.event === "fork_started")).toHaveLength(1);
    expect(h.state.status).toBe("failed");
  });

  test("t40_enter_on_active_node_ends_run_failed", () => {
    const h = openFork();
    // a pause whose route leads into a node that has an attempt going: the state can only get here
    // by a defect, and the run says so instead of holding two visits of one node
    h.state.pauses.push({
      reason: "total",
      node: "b",
      blocked: { from: "plan", label: "passed", to: "b", rework: false },
    });
    h.send({ type: "resume" });
    expect(h.state.status).toBe("failed");
    expect(h.journal.at(-1)).toMatchObject({
      event: "run_finished",
      status: "failed",
      reason: 'node "b" was entered while an attempt of it was still going',
    });
  });

  test("t40_zero_length_branch_arrives_at_fork", () => {
    const spec = parsePipeline(
      yaml([
        "name: zero",
        "nodes:",
        "  - { slug: plan, kind: agent, prompt: p }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: merge, kind: agent, prompt: m, join: all }",
        "edges:",
        "  - { from: plan, to: a }",
        "  - { from: plan, to: merge }",
        "  - { from: a, to: merge }",
      ]),
    );
    const h = host(spec);
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.forks?.f1?.arrived).toEqual({ merge: { node: "plan", label: "passed" } });
    expect(h.state.active.map((v) => v.node)).toEqual(["a"]);
    h.release("a");
    expect(h.state.trail).toEqual(["plan", "a", "merge"]);
    expect(h.state.status).toBe("completed");
  });

  test("t40_cancel_with_open_fork", () => {
    const h = openFork();
    h.send({ type: "cancel" });
    expect(h.state.status).toBe("canceled");
    expect(h.state.active).toEqual([]);
    expect(h.state.forks?.f1?.joined).toBe(0);
    expect(refusal(h.send(complete("a", 1))).code).toBe("NODE_NOT_RUNNING");
  });

  test("t40_proceed_pauses_only_the_branch", () => {
    const strict = parsePipeline(
      FORK.replace(
        "  - { slug: b-test, kind: command, command: b-test }",
        "  - { slug: b-test, kind: command, command: b-test }\n  - { slug: never, kind: agent, prompt: n, max_attempts: 1, max_consecutive_failures: 1 }",
      ).replace(
        "  - { from: a-test, to: a, when: failed }\n",
        "  - { from: a-test, to: never, when: failed }\n  - { from: never, to: a-test }\n",
      ),
    );
    const h = host(strict, fails("a-test"));
    h.hold("b");
    h.send(START);
    h.send(complete("plan", 1));
    // a-test fails, never (1 attempt) is entered, a-test fails again: the branch pauses at never
    expect(h.state.pauses).toEqual([
      {
        reason: "total",
        node: "never",
        blocked: expect.objectContaining({
          from: "a-test",
          to: "never",
          fork: { id: "f1", branch: "a" },
        }),
        fork: { id: "f1", branch: "a" },
      },
    ]);
    expect(h.state.status).toBe("running");
    expect(h.state.active.map((v) => v.node)).toEqual(["b"]);
  });

  test("t40_resumed_branch_keeps_its_fork_attribution", () => {
    const h = host(fork, fails("a-test"));
    h.hold("b");
    h.send(START);
    h.send(complete("plan", 1));
    // a-test fails 3 times in a row: the branch pauses (consecutive)
    expect(h.state.pauses[0]).toMatchObject({
      reason: "consecutive",
      node: "a-test",
      fork: { id: "f1", branch: "a" },
    });
    expect(h.state.status).toBe("running");
    h.hold("a");
    h.send({ type: "resume" });
    expect(h.state.active.find((v) => v.node === "a")?.fork).toEqual({ id: "f1", branch: "a" });
    expect(h.state.nodes.a?.fork).toEqual({ id: "f1", branch: "a" });
  });

  test("t40_check_or_work_follow_up_refused_is_not_dropped", () => {
    // A result of a branch's own work is never refused while the run goes: the branch cannot stall
    // on a refusal that nobody sees.
    const h = openFork();
    h.release("a");
    const b = h.state.active.find((v) => v.node === "b");
    expect(b).toBeDefined();
    h.hold("b-test");
    must(h.send(complete("b", 1)));
    const bTest = h.state.active.find((v) => v.node === "b-test");
    expect(bTest?.phase).toBe("engine");
    must(
      h.send({
        type: "work_finished",
        node: "b-test",
        attempt: bTest?.attempt ?? 0,
        passed: false,
        reason: "red",
      }),
    );
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
  });
});

// ── failures and restart_failed ─────────────────────────────────────────────

describe("t40 failed branches", () => {
  test("t40_failed_branch_does_not_stop_others", () => {
    const h = host(fork, fails("b-test", "b is red"));
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    expect(h.state.active.map((v) => v.node)).toEqual(["a"]);
    expect(h.state.status).toBe("running");
  });

  test("t40_arrival_by_failure_label_enters_join", () => {
    const h = host(fork, fails("b-test", "b is red"));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.journal.find((r) => r.event === "join_reached")).toMatchObject({ failed: ["b"] });
  });

  test("t40_join_gets_feedbacks_of_all_failed_branches", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node !== "ship"
        ? fails(effect.node, `${effect.node} is red`)(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    // a-test's failure goes back to a (rework inside the branch) three times, then the branch
    // pauses; b-test's failure arrives. Let a pass so both branches arrive.
    expect(h.state.pauses[0]?.node).toBe("a-test");
    const h2 = host(fork, (effect) =>
      effect.type === "run_command" && (effect.node === "b-test" || effect.node === "a-test")
        ? fails(effect.node, `${effect.node} is red`)(effect)
        : answer(effect),
    );
    h2.hold("merge");
    h2.send(START);
    h2.send(complete("plan", 1));
    expect(h2.state.pauses[0]).toMatchObject({ reason: "consecutive", node: "a-test" });
    // route a-test's failure to the join instead: both branches arrive failed
    const both: PipelineSpec = {
      ...fork,
      edges: fork.edges.map((e) =>
        e.from === "a-test" && e.when === "failed" ? { ...e, to: "merge" } : e,
      ),
    };
    const h3 = host(both, (effect) =>
      effect.type === "run_command" && effect.node !== "ship"
        ? fails(effect.node, `${effect.node} is red`)(effect)
        : answer(effect),
    );
    h3.hold("merge");
    h3.send(START);
    h3.send(complete("plan", 1));
    expect(h3.state.nodes.merge?.lastFailures).toEqual([
      { source: "command", reason: "a-test is red", from: "a-test" },
      { source: "command", reason: "b-test is red", from: "b-test" },
    ]);
    expect(h3.journal.find((r) => r.event === "join_reached")).toMatchObject({
      failed: ["a", "b"],
      feedbacks: [
        { source: "command", reason: "a-test is red", from: "a-test" },
        { source: "command", reason: "b-test is red", from: "b-test" },
      ],
    });
    const step = nextStep(both, h3.state, 0);
    expect("node" in step && step.node.reentry_feedback).toBe(
      'Branches of the fork failed: "a-test" failed (command): a-test is red; "b-test" failed (command): b-test is red',
    );
  });

  test("t40_feedback_shape_unchanged", () => {
    // the Feedback type keeps its keys, and the text of a non-fork reentry is what it was
    const h = host(fork, fails("b-test", "b is red"));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    const failure = h.state.nodes.merge?.lastFailures?.[0];
    expect(Object.keys(failure ?? {}).sort()).toEqual(["from", "reason", "source"]);
    const plain = host(fork, (effect) => {
      if (effect.type === "run_check" && effect.node === "a" && effect.attempt === 1) {
        return {
          type: "check_finished",
          node: "a",
          attempt: 1,
          index: 0,
          passed: false,
          reason: "a-check said no",
        };
      }
      // the rework of a waits for the test
      if (effect.type === "need_agent" && effect.node === "a" && effect.attempt === 2)
        return undefined;
      return answer(effect);
    });
    plain.send(START);
    plain.send(complete("plan", 1));
    const step = nextStep(fork, plain.state, 0);
    expect("node" in step && step.node.reentry_feedback).toBe(
      "The previous attempt failed (check:command): a-check said no (a/command#1)",
    );
  });

  test("t40_rework_inside_branch", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "a-test" && effect.attempt === 1
        ? fails("a-test", "first red")(effect)
        : answer(effect),
    );
    h.hold("b");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.nodes.a).toMatchObject({ attempt: 2, fork: { id: "f1", branch: "a" } });
    expect(h.state.nodes["a-test"]?.attempt).toBe(2);
    expect(h.state.forks?.f1?.arrived.a).toEqual({ node: "a-test", label: "passed" });
    expect(h.state.trail).toEqual(["plan", "a", "b", "a-test", "a", "a-test"]);
  });

  test("t40_unrouted_branch_fails_run_after_others_settle", () => {
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const h = host(doomed, fails("b-test", "b is red"));
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.status).toBe("running");
    expect(h.journal.find((r) => r.event === "branch_settled" && r.branch === "b")).toMatchObject({
      dead: true,
      failed: true,
      reason: "b is red",
    });
    h.release("a");
    expect(h.state.status).toBe("failed");
    expect(h.journal.at(-1)).toMatchObject({
      event: "run_finished",
      status: "failed",
      reason: 'branch "b" failed at "b-test" (command): b is red',
    });
  });

  test("t40_doomed_fork_keeps_serving_open_steps", () => {
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const h = host(doomed, fails("b-test"));
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    const step = nextStep(doomed, h.state, 0);
    expect(step).toMatchObject({ node: { slug: "a", attempt: 1 } });
    must(h.send(complete("a", 1)));
  });

  test("t40_run_reason_lists_each_dead_branch", () => {
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges
        .filter((e) => !(e.from === "b-test" && e.when === "failed"))
        .filter((e) => !(e.from === "a-test" && e.when === "failed")),
    };
    const h = host(doomed, (effect) =>
      effect.type === "run_command"
        ? fails(effect.node, `${effect.node} is red`)(effect)
        : answer(effect),
    );
    h.send(START);
    expect(h.state.status).toBe("failed");
    expect(h.journal.at(-1)?.reason).toBe(
      'branch "a" failed at "a-test" (command): a-test is red; branch "b" failed at "b-test" (command): b is red'.replace(
        "b is red",
        "b-test is red",
      ),
    );
  });

  test("t40_restart_failed_pre_check_refuses_without_failed_branch", () => {
    const h = openFork();
    h.release("a");
    h.release("b");
    const error = refusal(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(error.code).toBe("INVALID_ARGUMENTS");
    expect(error.message).toContain("no branch of its fork failed");
    // the step is still open
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    must(h.send(complete("merge", 1)));
  });

  test("t40_restart_failed_runs_after_join_checks", () => {
    let mergeCheckFails = true;
    const h = host(fork, (effect) => {
      if (effect.type === "run_command" && effect.node === "b-test" && effect.attempt === 1)
        return fails("b-test", "b is red")(effect);
      if (effect.type === "run_check" && effect.node === "merge" && mergeCheckFails) {
        mergeCheckFails = false;
        return {
          type: "check_finished",
          node: "merge",
          attempt: effect.attempt,
          index: 0,
          passed: false,
          reason: "merge check red",
        };
      }
      return answer(effect);
    });
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    // the check failed: the join is reworked, nothing was restarted yet
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge).toMatchObject({ attempt: 2, status: "rework" });
    expect(h.state.forks?.f1?.arrived.b).toBeDefined();
    expect(h.state.nodes.b?.attempt).toBe(1);
    // the rework keeps the branches' feedbacks, and the check's failure is the attempt's own
    expect(h.state.nodes.merge?.lastFailures).toHaveLength(1);
    expect(h.state.nodes.merge?.lastFailure?.reason).toBe("merge check red");
    must(h.send(complete("merge", 2, RESTART_FAILED)));
    expect(h.state.nodes.b?.attempt).toBe(2);
  });

  test("t40_restart_failed_route_reenters_failed_branches", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test" && effect.attempt === 1
        ? fails("b-test", "b is red")(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.hold("b");
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.active.map((v) => v.node)).toEqual(["b"]);
    expect(h.state.active[0]?.fork).toEqual({ id: "f1", branch: "b" });
    expect(h.state.nodes.b).toMatchObject({
      attempt: 2,
      lastFailure: { source: "command", reason: "b is red", from: "b-test" },
    });
    expect(h.state.forks?.f1?.arrived.b).toBeUndefined();
    expect(
      h.journal.filter((r) => r.event === "node_finished" && r.node === "merge")[0],
    ).toMatchObject({ outcome: RESTART_FAILED });
    h.release("b");
    expect(h.state.forks?.f1?.joined).toBe(2);
    expect(h.state.nodes.merge).toMatchObject({ attempt: 2, lastFailures: [] });
  });

  test("t40_restart_failed_keeps_passed_arrivals", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test" && effect.attempt === 1
        ? fails("b-test")(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.hold("b");
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.forks?.f1?.arrived.a).toEqual({ node: "a-test", label: "passed" });
    expect(h.state.nodes.a?.attempt).toBe(1);
  });

  test("t40_restart_failed_respects_attempt_limits", () => {
    const once = parsePipeline(
      FORK.replace(
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: b, kind: agent, prompt: b, max_attempts: 1, max_consecutive_failures: 1 }",
      ),
    );
    const h = host(once, (effect) =>
      effect.type === "run_command" && effect.node === "b-test"
        ? fails("b-test")(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({ reason: "total", node: "b", fork: { id: "f1", branch: "b" } }),
    ]);
    expect(h.state.status).toBe("paused");
    expect(h.state.active).toEqual([]);
  });

  test("t40_restart_failed_carries_feedbacks_and_rejection_reason", () => {
    // b's gate sends it back inside its branch with a reason; b then fails a check and arrives
    const spec = parsePipeline(
      GATED.replace(
        "  - { slug: b, kind: agent, prompt: b }",
        "  - slug: b\n    kind: agent\n    prompt: b\n    checks: [{ kind: command, command: c }]",
      ).replace(
        "  - { from: b-gate, to: merge, when: rejected }\n",
        "  - { from: b-gate, to: b, when: rejected }\n  - { from: b, to: merge, when: failed }\n",
      ),
    );
    const h = host(spec, (effect) =>
      effect.type === "run_check" && effect.node === "b" && effect.attempt === 2
        ? {
            type: "check_finished",
            node: "b",
            attempt: 2,
            index: 0,
            passed: false,
            reason: "b check red",
          }
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(approve("a-gate"));
    h.send(reject("b-gate", "please change the colour"));
    expect(h.state.nodes.b?.attempt).toBe(2);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge?.lastFailures).toEqual([
      { source: "check:command", reason: "b check red", check_id: "b/command#1", from: "b" },
    ]);
    h.hold("b");
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.nodes.b).toMatchObject({
      attempt: 3,
      lastFailure: { source: "check:command", reason: "b check red", from: "b" },
    });
    const step = nextStep(spec, h.state, 0);
    expect("node" in step && step.node.reentry_feedback).toContain("b check red");
  });

  test("t40_restart_failed_after_rejected_gate_returns_to_gate", () => {
    // a restarted branch goes through its gate again; nothing is skipped
    const spec = parsePipeline(
      GATED.replace(
        "  - { slug: b, kind: agent, prompt: b }",
        "  - slug: b\n    kind: agent\n    prompt: b\n    checks: [{ kind: command, command: c }]",
      ).replace(
        "  - { from: b-gate, to: merge, when: rejected }\n",
        "  - { from: b-gate, to: b, when: rejected }\n  - { from: b, to: merge, when: failed }\n",
      ),
    );
    let bFails = true;
    const h = host(spec, (effect) =>
      effect.type === "run_check" && effect.node === "b" && bFails
        ? {
            type: "check_finished",
            node: "b",
            attempt: effect.attempt,
            index: 0,
            passed: false,
            reason: "red",
          }
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(approve("a-gate"));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    bFails = false;
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.active.map((v) => v.node)).toEqual(["b-gate"]);
    expect(h.state.nodes["b-gate"]?.attempt).toBe(1);
    h.send(approve("b-gate"));
    expect(h.state.nodes.merge?.attempt).toBe(2);
  });

  test("t40_human_rejected_branch_excluded_from_restart_failed", () => {
    const h = host(gated);
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(approve("a-gate"));
    h.send(reject("b-gate", "not like this"));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge?.lastFailures).toEqual([
      { source: "human", reason: "not like this", from: "b-gate" },
    ]);
    // the join knows a branch failed, but the agent may not undo a person's no
    const step = nextStep(gated, h.state, 0);
    expect("node" in step && step.node.outcomes).toEqual([RESTART_FAILED]);
    const error = refusal(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(error.code).toBe("INVALID_ARGUMENTS");
    expect(error.message).toContain("a branch a person sent back is not run again by the agent");
    must(h.send(complete("merge", 1)));
    expect(h.state.status).toBe("completed");
  });

  test("t40_restart_failed_in_second_fork_instance", () => {
    let shipFails = true;
    let bFails = false;
    const h = host(fork, (effect) => {
      if (effect.type === "run_command" && effect.node === "ship" && shipFails) {
        shipFails = false;
        return fails("ship")(effect);
      }
      if (effect.type === "run_command" && effect.node === "b-test" && bFails) {
        bFails = false;
        return fails("b-test", "second pass red")(effect);
      }
      return answer(effect);
    });
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.hold("plan");
    h.release("merge");
    h.hold("merge");
    // ship failed: back to plan; the second instance starts when plan completes, b fails this time
    expect(h.state.active.map((v) => v.node)).toEqual(["plan"]);
    bFails = true;
    h.release("plan");
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2"]);
    expect(h.state.forks?.f2?.arrived.b).toMatchObject({ label: "failed" });
    must(h.send(complete("merge", 2, RESTART_FAILED)));
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ label: "passed" });
    expect(h.state.forks?.f2?.joined).toBe(2);
    expect(h.state.status).toBe("running");
  });

  test("t40_restart_failed_at_route_without_failed_branch_fails_run_with_reason", () => {
    let holdCheck = false;
    const h = host(fork, (effect) => {
      if (effect.type === "run_command" && effect.node === "b-test") return fails("b-test")(effect);
      if (effect.type === "run_check" && effect.node === "merge" && holdCheck) return undefined;
      return answer(effect);
    });
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    holdCheck = true;
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    // between the completion and the checks the arrivals were changed under the run: the route
    // cannot refuse anything any more, it ends the run with a reason
    const f1 = h.state.forks?.f1;
    if (f1) f1.arrived.b = { node: "b-test", label: "passed" };
    must(
      h.send({
        type: "check_finished",
        node: "merge",
        attempt: 1,
        index: 0,
        passed: true,
        reason: "",
      }),
    );
    expect(h.state.status).toBe("failed");
    expect(h.journal.at(-1)?.reason).toContain(
      'finished with "restart_failed" but no branch of its fork had failed',
    );
  });

  test("t40_restart_failed_journaled", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test" && effect.attempt === 1
        ? fails("b-test")(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.hold("b");
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    const from = h.journal.findIndex((r) => r.event === "agent_completed" && r.node === "merge");
    expect(
      h.journal.slice(from).map((r) => [r.event, r.node, r.outcome ?? r.branch ?? null]),
    ).toEqual([
      ["agent_completed", "merge", RESTART_FAILED],
      ["check_finished", "merge", null],
      ["node_finished", "merge", RESTART_FAILED],
      ["node_entered", "b", "b"],
    ]);
    expect(h.journal.at(-1)).toMatchObject({
      event: "node_entered",
      node: "b",
      attempt: 2,
      fork: "f1",
      branch: "b",
    });
  });

  test("t40_restart_failed_attempt_limit_at_join", () => {
    const twice = parsePipeline(
      FORK.replace(
        "    join: all\n",
        "    join: all\n    max_attempts: 2\n    max_consecutive_failures: 2\n",
      ),
    );
    const h = host(twice, (effect) =>
      effect.type === "run_command" && effect.node === "b-test"
        ? fails("b-test")(effect)
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.nodes.merge?.attempt).toBe(2);
    must(h.send(complete("merge", 2, RESTART_FAILED)));
    // the third entry of the join is one too many: the run pauses there
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "total",
        node: "merge",
        blocked: expect.objectContaining({ to: "merge", join: "f1" }),
      }),
    ]);
    expect(h.state.status).toBe("paused");
    h.send({ type: "resume" });
    expect(h.state.nodes.merge?.attempt).toBe(3);
    expect(h.state.nodes.merge?.lastFailures).toHaveLength(1);
  });
});

// ── pauses and status ───────────────────────────────────────────────────────

describe("t40 pauses", () => {
  const consecutiveA = () => {
    const h = host(fork, fails("a-test"));
    h.hold("b");
    h.send(START);
    h.send(complete("plan", 1));
    return h;
  };

  test("t40_pause_one_branch_others_go_on", () => {
    const h = consecutiveA();
    expect(h.state.pauses).toHaveLength(1);
    expect(h.state.status).toBe("running");
    h.release("b");
    expect(h.state.forks?.f1?.arrived.b).toBeDefined();
    expect(h.state.status).toBe("paused");
  });

  test("t40_paused_only_when_nothing_can_move", () => {
    const h = consecutiveA();
    expect(h.state.status).toBe("running");
    h.hold("b-test");
    must(h.send(complete("b", 1)));
    // b-test runs (engine work): still movable
    expect(h.state.status).toBe("running");
  });

  test("t40_open_gate_counts_as_movable", () => {
    const strict = parsePipeline(
      GATED.replace(
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: b, kind: agent, prompt: b, max_attempts: 1, max_consecutive_failures: 1 }",
      ),
    );
    const h = host(strict);
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(reject("a-gate", "no"));
    h.send(reject("a-gate", "no"));
    // a's rejections stay inside a's branch; nothing paused
    expect(h.state.pauses).toEqual([]);
    // a's rejection would need a second attempt of a: that branch pauses, b's gate stays open
    const strictB = parsePipeline(
      GATED.replace(
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: a, kind: agent, prompt: a, max_attempts: 1, max_consecutive_failures: 1 }",
      ),
    );
    const h2 = host(strictB);
    h2.hold("merge");
    h2.send(START);
    h2.send(complete("plan", 1));
    h2.send(reject("a-gate", "no"));
    expect(h2.state.pauses).toEqual([
      expect.objectContaining({ reason: "total", node: "a", fork: { id: "f1", branch: "a" } }),
    ]);
    expect(h2.state.active.map((v) => v.node)).toEqual(["b-gate"]);
    expect(h2.state.status).toBe("running");
  });

  test("t40_stale_unsuspended_visit_counts_as_movable", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test"
        ? undefined
        : fails("a-test")(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses).toHaveLength(1);
    expect(h.state.active.map((v) => v.node)).toEqual(["b-test"]);
    h.advance(100_000);
    expect(h.state.status).toBe("running");
    h.send({ type: "tick" });
    expect(h.journal.filter((r) => r.event === "node_restarted")).toHaveLength(1);
    expect(h.state.status).toBe("running");
  });

  test("t40_suspended_branch_not_movable", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test"
        ? undefined
        : fails("a-test")(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    for (let i = 0; i < 4; i++) {
      h.advance(31_000);
      h.send({ type: "tick" });
    }
    expect(h.state.active[0]).toMatchObject({ node: "b-test", suspended: true });
    expect(h.state.pauses.map((p) => [p.reason, p.node])).toEqual([
      ["consecutive", "a-test"],
      ["restarts", "b-test"],
    ]);
    expect(h.state.status).toBe("paused");
  });

  test("t40_gate_decidable_while_other_branch_paused", () => {
    const strictA = parsePipeline(
      GATED.replace(
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: a, kind: agent, prompt: a, max_attempts: 1, max_consecutive_failures: 1 }",
      ),
    );
    const h = host(strictA);
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(reject("a-gate", "no"));
    expect(h.state.pauses).toHaveLength(1);
    must(h.send(approve("b-gate")));
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ label: "approved" });
    expect(h.state.status).toBe("paused");
    const step = nextStep(strictA, h.state, 0);
    expect(step).toMatchObject({ waiting: { reason: "paused", node_slug: "a" } });
  });

  test("t40_resume_branch_pause_while_run_running", () => {
    const h = consecutiveA();
    expect(h.state.status).toBe("running");
    h.hold("a");
    const result = must(h.send({ type: "resume" }));
    expect(result.noop).toBeUndefined();
    expect(h.state.pauses).toEqual([]);
    expect(h.state.nodes["a-test"]?.consecutiveFailures).toBe(0);
    expect(h.state.active.map((v) => v.node).sort()).toEqual(["a", "b"]);
  });

  test("t40_resume_refused_with_several_pauses_names_nodes", () => {
    const both: PipelineSpec = {
      ...fork,
      edges: fork.edges.map((e) =>
        e.from === "b-test" && e.when === "failed" ? { ...e, to: "b" } : e,
      ),
    };
    const h2 = host(both, (effect) =>
      effect.type === "run_command" ? fails(effect.node)(effect) : answer(effect),
    );
    h2.send(START);
    h2.send(complete("plan", 1));
    expect(h2.state.pauses.map((p) => p.node).sort()).toEqual(["a-test", "b-test"]);
    expect(h2.state.status).toBe("paused");
    const error = refusal(h2.send({ type: "resume" }));
    expect(error.code).toBe("INVALID_ARGUMENTS");
    expect(error.message).toContain('"a-test"');
    expect(error.message).toContain('"b-test"');
    expect(refusal(h2.send({ type: "resume", node: "merge" })).message).toContain(
      'not paused at "merge"',
    );
  });

  test("t40_resume_with_node_picks_one", () => {
    const both: PipelineSpec = {
      ...fork,
      edges: fork.edges.map((e) =>
        e.from === "b-test" && e.when === "failed" ? { ...e, to: "b" } : e,
      ),
    };
    const h = host(both, (effect) =>
      effect.type === "run_command" ? fails(effect.node)(effect) : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    let fixed = false;
    const h2 = host(both, (effect) =>
      effect.type === "run_command" && !fixed ? fails(effect.node)(effect) : answer(effect),
    );
    h2.send(START);
    h2.send(complete("plan", 1));
    fixed = true;
    must(h2.send({ type: "resume", node: "b-test" }));
    expect(h2.state.pauses.map((p) => p.node)).toEqual(["a-test"]);
    expect(h2.journal.at(-1)?.event).not.toBe("run_finished");
    expect(h2.journal.find((r) => r.event === "run_resumed")).toMatchObject({
      node: "b-test",
      fork: "f1",
      branch: "b",
    });
    expect(h2.state.forks?.f1?.arrived.b).toMatchObject({ label: "passed" });
    expect(h2.state.status).toBe("paused");
    expect(h.state.status).toBe("paused");
  });

  test("t40_resume_budget_only_for_own_branch", () => {
    const tight = parsePipeline(
      FORK.replace(
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: b, kind: agent, prompt: b, max_attempts: 1, max_consecutive_failures: 1 }",
      ).replace(
        "  - { slug: a-test, kind: command, command: a-test }",
        "  - { slug: a-test, kind: command, command: a-test, max_attempts: 1, max_consecutive_failures: 1 }",
      ),
    );
    // a-test fails its one attempt: branch a pauses at a-test; b passed with its one attempt
    const h = host(tight, fails("a-test"));
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "consecutive",
        node: "a-test",
        fork: { id: "f1", branch: "a" },
      }),
    ]);
    expect(h.state.nodes.b?.attempt).toBe(1);
    h.send({ type: "resume" });
    // a-test got more attempts; b, exhausted too but in the other branch, did not
    expect(h.state.nodes["a-test"]?.extraAttempts).toBe(1);
    expect(h.state.nodes.b?.extraAttempts).toBe(0);
  });

  test("t40_restart_limit_one_branch", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node === "b-test" ? undefined : answer(effect),
    );
    h.hold("a");
    h.send(START);
    h.send(complete("plan", 1));
    for (let i = 0; i < 4; i++) {
      h.advance(31_000);
      h.send({ type: "tick" });
    }
    expect(h.state.pauses).toEqual([
      { reason: "restarts", node: "b-test", fork: { id: "f1", branch: "b" } },
    ]);
    expect(h.state.active.find((v) => v.node === "b-test")?.suspended).toBe(true);
    expect(h.state.active.find((v) => v.node === "a")).toBeDefined();
    expect(h.state.status).toBe("running");
    h.send({ type: "resume", node: "b-test" });
    expect(h.state.active.find((v) => v.node === "b-test")?.suspended).toBe(false);
    expect(h.effects.at(-1)).toMatchObject({ type: "run_command", node: "b-test", restart: true });
  });

  test("t40_tick_restarts_only_stale_branch", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node !== "ship" ? undefined : answer(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node).sort()).toEqual(["a-test", "b-test"]);
    h.advance(20_000);
    h.send({ type: "heartbeat", node: "a-test", attempt: 1 });
    h.advance(15_000);
    h.send({ type: "tick" });
    expect(h.journal.filter((r) => r.event === "node_restarted").map((r) => r.node)).toEqual([
      "b-test",
    ]);
  });

  test("t40_takeover_per_branch", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node !== "ship" ? undefined : answer(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    h.send({ type: "heartbeat", node: "a-test", attempt: 1, owner: "p1" });
    h.send({ type: "heartbeat", node: "b-test", attempt: 1, owner: "p2" });
    h.send({ type: "tick", deadOwners: ["p1"] });
    const a = h.state.active.find((v) => v.node === "a-test");
    const b = h.state.active.find((v) => v.node === "b-test");
    expect(a).toMatchObject({ takeovers: 1 });
    expect(a?.owner).toBeUndefined();
    expect(b).toMatchObject({ owner: "p2" });
    expect(b?.takeovers).toBeUndefined();
  });

  test("t40_heartbeat_updates_only_own_visit", () => {
    const h = host(fork, (effect) =>
      effect.type === "run_command" && effect.node !== "ship" ? undefined : answer(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    h.advance(10_000);
    h.send({ type: "heartbeat", node: "a-test", attempt: 1, owner: "p1" });
    expect(h.state.active.find((v) => v.node === "a-test")?.heartbeatAt).toBe(10_000);
    expect(h.state.active.find((v) => v.node === "b-test")?.heartbeatAt).toBe(0);
    expect(h.state.active.find((v) => v.node === "b-test")?.owner).toBeUndefined();
  });

  test("t40_unpause_and_accept_act_on_right_pause", () => {
    // two pauses; a change of the pipeline that gives b-test's branch a way on clears that pause only
    const both: PipelineSpec = {
      ...fork,
      edges: fork.edges.map((e) =>
        e.from === "b-test" && e.when === "failed" ? { ...e, to: "b" } : e,
      ),
    };
    const h = host(both, (effect) =>
      effect.type === "run_command" ? fails(effect.node)(effect) : answer(effect),
    );
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses.map((p) => p.node).sort()).toEqual(["a-test", "b-test"]);
    const after: PipelineSpec = {
      ...both,
      edges: both.edges.map((e) =>
        e.from === "b-test" && e.when === "failed" ? { ...e, to: "merge" } : e,
      ),
    };
    const result = decide(
      after,
      h.state,
      { type: "pipeline_accepted", from: "h", to: "h2", source: "file", before: both },
      0,
    );
    const state = must(result).state;
    expect(state.pauses.map((p) => p.node)).toEqual(["a-test"]);
    expect(state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    expect(state.status).toBe("paused");
  });

  test("t40_repair_reaches_failed_arrived_branch", () => {
    // no loop back from ship: without the fork, b-test would be a finished step the run never
    // comes back to
    const text = FORK.replace(
      "  - { slug: ship, kind: command, command: ship }",
      "  - { slug: ship, kind: agent, prompt: ship }",
    ).replace("  - { from: ship, to: plan, when: failed }\n", "");
    const before = parsePipeline(text);
    const after = parsePipeline(text.replace("command: b-test", "command: b-test-fixed"));
    const h = host(before, fails("b-test", "b is red"));
    h.hold("merge", "ship");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    // the fork is open at its join: b-test may be repaired before restart_failed runs it again
    const open = diffPipelines(before, after, h.state);
    expect(open.refused).toBeUndefined();
    expect(open.nodes).toEqual([{ slug: "b-test", changes: ["work"] }]);
    // once the join has passed, the branch is history like any finished step
    h.release("merge");
    expect(h.state.active.map((v) => v.node)).toEqual(["ship"]);
    const closed = diffPipelines(before, after, h.state);
    expect(closed.refused).toContain('node "b-test" has already finished');
  });

  test("t40_state_fields_roundtrip", () => {
    const h = consecutiveA();
    const text = JSON.stringify(h.state);
    expect(JSON.parse(text)).toEqual(h.state);
    expect(h.state.v).toBe(RECORD_VERSION);
    expect(h.state.pauses[0]?.fork).toEqual({ id: "f1", branch: "a" });
    expect(h.state.forks?.f1?.branches).toEqual(["a", "b"]);
    expect(h.state).not.toHaveProperty("pause");
  });

  test("t40_state_is_written_as_v2", () => {
    const h = host(fork);
    h.send(START);
    expect(h.state.v).toBe(2);
    expect(h.journal.every((r) => r.v === 2)).toBe(true);
  });
});

// ── journal and canonical form ──────────────────────────────────────────────

describe("t40 journal", () => {
  test("t40_event_fork_started_shape", () => {
    const h = openFork();
    const record = h.journal.find((r) => r.event === "fork_started");
    expect(record).toEqual({
      v: 2,
      seq: expect.any(Number),
      ts: 0,
      event: "fork_started",
      fork: "f1",
      node: "plan",
      label: "passed",
      branches: ["a", "b"],
      join: "merge",
    });
    expect(
      h.journal.filter((r) => r.event === "node_entered" && r.fork === "f1").map((r) => r.branch),
    ).toEqual(["a", "b"]);
  });

  test("t40_branch_settled_shape", () => {
    const h = host(fork, fails("b-test", "b is red"));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    const settled = h.journal
      .filter((r) => r.event === "branch_settled")
      .sort((x, y) => String(x.branch).localeCompare(String(y.branch)));
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      v: 2,
      fork: "f1",
      branch: "a",
      node: "a-test",
      label: "passed",
      failed: false,
    });
    expect(settled[1]).toMatchObject({
      fork: "f1",
      branch: "b",
      node: "b-test",
      label: "failed",
      failed: true,
      source: "command",
      reason: "b is red",
    });
    expect(settled[0]).not.toHaveProperty("reason");
    expect(settled[0]).not.toHaveProperty("dead");
  });

  test("t40_join_reached_shape", () => {
    const h = openFork();
    h.release("a");
    h.release("b");
    expect(h.journal.find((r) => r.event === "join_reached")).toEqual({
      v: 2,
      seq: expect.any(Number),
      ts: 0,
      event: "join_reached",
      fork: "f1",
      join: "merge",
      failed: [],
    });
  });

  test("t40_journal_shows_overlap", () => {
    const h = openFork();
    h.advance(1_000);
    h.release("a");
    h.advance(1_000);
    h.release("b");
    const heads = (event: string) =>
      h.journal.filter(
        (r) => r.event === event && r.fork === "f1" && (r.node === "a" || r.node === "b"),
      );
    // both heads were entered before either finished: the timestamps show the overlap, and the
    // records say which branch each belongs to
    expect(Math.max(...heads("node_entered").map((r) => r.ts))).toBeLessThan(
      Math.min(...heads("node_finished").map((r) => r.ts)),
    );
    expect(heads("node_finished").map((r) => r.branch)).toEqual(["a", "b"]);
  });

  test("t40_join_is_in_routing_form", () => {
    const merge = fork.nodes.find((n) => n.slug === "merge") as PipelineSpec["nodes"][number];
    const plain = parsePipeline(
      FORK.replace("    join: all\n", "")
        .replace("  - { from: plan, to: b }\n", "")
        .replace(
          "  - { from: b, to: b-test }\n  - { from: b-test, to: merge }\n  - { from: b-test, to: merge, when: failed }\n",
          "  - { from: ship, to: b }\n  - { from: b, to: b-test }\n  - { from: b-test, to: plan }\n  - { from: b-test, to: plan, when: failed }\n",
        ),
    );
    const plainMerge = plain.nodes.find((n) => n.slug === "merge") as PipelineSpec["nodes"][number];
    expect(canonicalNode(fork, merge).routing).toContain('"join":"all"');
    expect(canonicalNode(plain, plainMerge).routing).not.toContain("join");
  });

  test("t40_join_is_not_a_work_change", () => {
    const merge = fork.nodes.find((n) => n.slug === "merge") as PipelineSpec["nodes"][number];
    const without: PipelineSpec["nodes"][number] = { ...merge };
    delete without.join;
    expect(canonicalNode(fork, merge).work).toBe(canonicalNode(fork, without).work);
    expect(canonicalNode(fork, merge).checks).toBe(canonicalNode(fork, without).checks);
    expect(canonicalNode(fork, merge).routing).not.toBe(canonicalNode(fork, without).routing);
  });

  test("t40_canonical_sort_is_tuple_stable_for_equal_when", () => {
    const swapped = parsePipeline(
      FORK.replace(
        "  - { from: plan, to: a }\n  - { from: plan, to: b }\n",
        "  - { from: plan, to: b }\n  - { from: plan, to: a }\n",
      ),
    );
    const plan = fork.nodes.find((n) => n.slug === "plan") as PipelineSpec["nodes"][number];
    const plan2 = swapped.nodes.find((n) => n.slug === "plan") as PipelineSpec["nodes"][number];
    expect(canonicalNode(fork, plan).routing).toBe(canonicalNode(swapped, plan2).routing);
    // and labels that run into each other when joined as text are told apart as a pair
    const spec: PipelineSpec = {
      ...fork,
      edges: [
        { from: "x", to: "bc", when: "a" },
        { from: "x", to: "c", when: "ab" },
      ],
    };
    const node = { ...plan, slug: "x" };
    const flipped: PipelineSpec = { ...spec, edges: [...spec.edges].reverse() };
    expect(canonicalNode(spec, node).routing).toBe(canonicalNode(flipped, node).routing);
    expect(canonicalNode(spec, node).routing).toContain(
      '[{"to":"bc","when":"a"},{"to":"c","when":"ab"}]',
    );
  });

  test("t40_join_in_canonical_pipeline_too", () => {
    const plainText = FORK.replace("    join: all\n", "");
    expect(canonicalPipeline(fork)).toContain('"join":"all"');
    expect(validatePipeline(plainText).ok).toBe(false);
    const swapped = parsePipeline(
      FORK.replace(
        "  - { from: plan, to: a }\n  - { from: plan, to: b }\n",
        "  - { from: plan, to: b }\n  - { from: plan, to: a }\n",
      ),
    );
    expect(canonicalPipeline(swapped)).toBe(canonicalPipeline(fork));
  });

  test("t40_snapshot_path_unchanged_by_fork_rules", () => {
    // a kept pipeline with a fork reads through the snapshot door the same as a user file
    expect(parseSnapshot(FORK)).toEqual(parsePipeline(FORK));
    expect(() => parseSnapshot(FORK.replace("    join: all\n", ""))).toThrow(
      "needs a `join: all` node",
    );
  });
});

// ── texts composed from event text ──────────────────────────────────────────

describe("t40 redaction: every composed text is built from event text", () => {
  // The host redacts every event before `decide` sees it, so what the core writes is clean as long as
  // it is composed from the event text and nothing else. Each test puts a marker into the event and
  // shows that the marker, and only text the host gave, reaches the field.
  const MARK = "[REDACTED:marker]";

  test("t40_redact_feedbacks", () => {
    const h = host(fork, fails("b-test", `red ${MARK}`));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.nodes.merge?.lastFailures?.[0]?.reason).toBe(`red ${MARK}`);
    expect(h.state.forks?.f1?.arrived.b?.failure?.reason).toBe(`red ${MARK}`);
  });

  test("t40_redact_branch_settled_reason", () => {
    const h = host(fork, fails("b-test", `red ${MARK}`));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.journal.find((r) => r.event === "branch_settled" && r.branch === "b")?.reason).toBe(
      `red ${MARK}`,
    );
  });

  test("t40_redact_join_reached", () => {
    const h = host(fork, fails("b-test", `red ${MARK}`));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    const record = h.journal.find((r) => r.event === "join_reached");
    expect(JSON.stringify(record)).toContain(MARK);
    expect(JSON.stringify(record).split("red ").length).toBe(2);
  });

  test("t40_redact_run_failed_reason", () => {
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const h = host(doomed, fails("b-test", `red ${MARK}`));
    h.send(START);
    expect(h.journal.at(-1)).toMatchObject({
      event: "run_finished",
      reason: `branch "b" failed at "b-test" (command): red ${MARK}`,
    });
  });

  test("t40_redact_pauses_reason", () => {
    const h = host(fork, fails("a-test", `red ${MARK}`));
    h.hold("b");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses[0]?.blocked?.feedback?.reason).toBe(`red ${MARK}`);
    expect(h.state.nodes["a-test"]?.lastFailure?.reason).toBe(`red ${MARK}`);
  });

  test("t40_redact_state_feedbacks", () => {
    const h = host(gated);
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(approve("a-gate"));
    h.send(reject("b-gate", `no ${MARK}`));
    const text = JSON.stringify(h.state);
    expect(text).toContain(MARK);
    // the reason lives in the arrival, the join's feedbacks and its first failure, and the gate's own
    // failure; nowhere else
    expect(text.split(`no ${MARK}`).length - 1).toBe(4);
  });
});

// ── random schedules ────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fork invariants over a state and its journal; throws with the seed when one does not hold. */
function forkInvariants(
  spec: PipelineSpec,
  state: RunState,
  journal: JournalRecord[],
  seed: number,
) {
  const where = `seed ${seed}`;
  // (a) one visit per node
  const visited = state.active.map((v) => v.node);
  expect(new Set(visited).size, `${where}: two visits of one node`).toBe(visited.length);
  for (const fork of Object.values(state.forks ?? {})) {
    // (b) the join enters once per time all branches arrived
    const reached = journal.filter((r) => r.event === "join_reached" && r.fork === fork.id).length;
    expect(reached, `${where}: join_reached of ${fork.id}`).toBe(fork.joined);
    const entered = journal.filter(
      (r) => r.event === "node_entered" && r.node === fork.join && !r.rework,
    ).length;
    expect(entered, `${where}: join entered`).toBeGreaterThanOrEqual(fork.joined);
    // the join never starts with a branch missing or dead
    if (fork.joined > 0 && Object.keys(fork.arrived).length === fork.branches.length) {
      expect(
        fork.branches.some((b) => fork.arrived[b]?.dead),
        `${where}: joined over a dead branch`,
      ).toBe(false);
    }
  }
  if (state.status === "completed") {
    // (c) every branch settled before the run ended
    for (const fork of Object.values(state.forks ?? {})) {
      expect(
        fork.branches.every((b) => fork.arrived[b] !== undefined),
        `${where}: unsettled branch at completion`,
      ).toBe(true);
      expect(
        fork.branches.some((b) => fork.arrived[b]?.dead),
        `${where}: completed with a dead branch`,
      ).toBe(false);
    }
  }
  if (state.status !== "running" && state.status !== "paused") {
    // (d) the run ends when no visit is left
    expect(state.active, `${where}: visits after the end`).toEqual([]);
  }
  if (state.status === "failed") {
    // (e) a failed run lists all reasons
    const reason = String(journal.at(-1)?.reason ?? "");
    for (const fork of Object.values(state.forks ?? {})) {
      for (const branch of fork.branches) {
        if (fork.arrived[branch]?.dead) expect(reason, where).toContain(`branch "${branch}"`);
      }
    }
  }
  // (f) the join gets all failed branches' feedbacks
  for (const record of journal.filter((r) => r.event === "join_reached")) {
    const fork = state.forks?.[String(record.fork)];
    if (!fork) continue;
    const failed = record.failed as string[];
    const feedbacks = (record.feedbacks as unknown[] | undefined) ?? [];
    expect(feedbacks.length, where).toBe(failed.length);
  }
  // the status says what can move
  if (state.status === "paused") {
    expect(
      state.active.some((v) => v.phase === "agent" || v.phase === "human" || !v.suspended),
      `${where}: paused with something movable`,
    ).toBe(false);
  }
  if (state.status === "running") {
    expect(
      state.active.length > 0 || state.pauses.length > 0,
      `${where}: running with nothing`,
    ).toBe(true);
  }
  expect(state.trail[0]).toBe(spec.entry);
}

function simulate(spec: PipelineSpec, seed: number, steps = 300, withRestart = false) {
  const random = mulberry32(seed);
  let state: RunState | undefined;
  let now = 0;
  const pending: Effect[] = [];
  const journal: JournalRecord[] = [];
  const seen = new Set<string>();
  let refusedFollowUps = 0;
  const send = (event: RunEvent) => {
    const before = state === undefined ? undefined : structuredClone(state);
    const result = decide(spec, state, event, now);
    if (!result.ok) {
      expect(state).toEqual(before);
      // A result for the attempt a visit is on, in the phase it is in, refused while the run goes
      // would stall its branch. A stale one (a restarted check of an attempt that moved on, a result
      // after the run ended) is refused as it always was.
      if (
        state?.status === "running" &&
        (event.type === "work_finished" || event.type === "check_finished")
      ) {
        const visit = state.active.find(
          (v) => v.node === event.node && v.attempt === event.attempt,
        );
        const phase = event.type === "work_finished" ? "engine" : "checks";
        if (
          visit?.phase === phase &&
          (event.type !== "check_finished" || visit.checkIndex === event.index)
        ) {
          refusedFollowUps += 1;
        }
      }
      return result;
    }
    state = result.state;
    seen.add(state.status);
    journal.push(...result.journal);
    pending.push(...result.effects);
    forkInvariants(spec, state, journal, seed);
    return result;
  };
  send(START);
  for (let i = 0; i < steps; i++) {
    const roll = random();
    if (pending.length > 0 && roll < 0.8) {
      const [effect] = pending.splice(Math.floor(random() * pending.length), 1);
      if (!effect) continue;
      if (effect.type === "need_agent") {
        const restart = withRestart && effect.node === "merge" && random() < 0.5;
        send(complete(effect.node, effect.attempt, restart ? RESTART_FAILED : undefined));
      } else if (effect.type === "run_command") {
        send({
          type: "work_finished",
          node: effect.node,
          attempt: effect.attempt,
          passed: random() < 0.7,
          reason: `x${seed}`,
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
      const pauses = state?.pauses ?? [];
      const pick = pauses[Math.floor(random() * pauses.length)];
      send({ type: "resume", ...(pauses.length > 1 && pick ? { node: pick.node } : {}) });
    } else if (roll < 0.962) {
      send({ type: "cancel" });
    }
  }
  return { state: state as RunState, journal, seen, refusedFollowUps };
}

describe("t40 random schedules", () => {
  const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

  test("t40_random_schedule_keeps_invariants", () => {
    const statuses = new Set<string>();
    let forked = 0;
    for (const seed of SEEDS) {
      const { state, seen, refusedFollowUps } = simulate(fork, seed);
      for (const s of seen) statuses.add(s);
      if (state.forks) forked += 1;
      // a result of work this run asked for is never refused while the run goes (a pending effect
      // answered after the run ended is the one case, and that is the end, not a stall)
      expect(refusedFollowUps, `seed ${seed}`).toBe(0);
    }
    expect(forked).toBeGreaterThan(SEEDS.length / 2);
    for (const wanted of ["running", "completed", "paused", "canceled"]) {
      expect(statuses.has(wanted), wanted).toBe(true);
    }
    // a valid pipeline never ends `failed` by a fork; one whose branch has no way on does
    const doomed: PipelineSpec = {
      ...fork,
      edges: fork.edges.filter((e) => !(e.from === "b-test" && e.when === "failed")),
    };
    const ends = new Set<string>();
    for (const seed of SEEDS.slice(0, 40)) ends.add(simulate(doomed, seed).state.status);
    expect(ends.has("failed")).toBe(true);
  });

  test("t40_random_schedule_with_pauses_and_restart_failed", () => {
    let restarted = 0;
    let resumedInFork = 0;
    for (const seed of SEEDS) {
      const { journal } = simulate(gated, seed, 300, true);
      const { journal: j2 } = simulate(fork, seed + 1000, 300, true);
      for (const j of [journal, j2]) {
        restarted += j.filter(
          (r) => r.event === "node_finished" && r.outcome === RESTART_FAILED,
        ).length;
        resumedInFork += j.filter((r) => r.event === "run_resumed" && r.fork !== undefined).length;
      }
    }
    expect(restarted).toBeGreaterThan(0);
    expect(resumedInFork).toBeGreaterThan(0);
  });

  test("t40_random_schedule_self_test_catches_an_injected_bug", () => {
    const h = openFork();
    const state = structuredClone(h.state);
    // a second visit of a node
    state.active.push({ ...(state.active[0] as RunState["active"][number]) });
    expect(() => forkInvariants(fork, state, h.journal, 0)).toThrow();
    // a completed run with an unsettled branch
    const done = structuredClone(h.state);
    done.status = "completed";
    done.active = [];
    expect(() => forkInvariants(fork, done, h.journal, 0)).toThrow();
    // a join_reached without the feedbacks of its failed branches
    const journal: JournalRecord[] = [
      ...h.journal,
      { v: 2, seq: 99, ts: 0, event: "join_reached", fork: "f1", join: "merge", failed: ["b"] },
    ];
    expect(() => forkInvariants(fork, h.state, journal, 0)).toThrow();
  });
});

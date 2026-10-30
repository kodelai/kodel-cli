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
  describeEffects,
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
  standingOf,
  summarizeRun,
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
  let current = spec;
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
      const result = decide(current, state, event, now, options);
      firstResult ??= result;
      if (!result.ok) {
        if (event === first) return result;
        throw new Error(`a follow-up was refused: ${result.error.code} ${result.error.message}`);
      }
      // As the host does: the state is written as JSON and read back before the next event.
      state = JSON.parse(JSON.stringify(result.state)) as RunState;
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
    /** The pipeline the run is on from now on (a person accepted another version). */
    use: (next: PipelineSpec) => {
      current = next;
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

  test("t40_validate_branch_cycle_without_exit_refused", () => {
    // every node of branch a has an edge for "passed", and still the branch can never arrive
    refused(
      yaml([
        "name: cycle",
        "nodes:",
        "  - { slug: start, kind: agent, prompt: s }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: c, kind: agent, prompt: c }",
        "  - { slug: j, kind: agent, prompt: j, join: all }",
        "edges:",
        "  - { from: start, to: a }",
        "  - { from: start, to: c }",
        "  - { from: a, to: b }",
        "  - { from: b, to: a }",
        "  - { from: c, to: j }",
      ]),
      'node "a" is in the branch "a" of the fork at "start" ("passed") and none of its ways on leads to the join "j"',
      'node "b" is in the branch "a"',
    );
  });

  test("t40_validate_branch_cycle_with_exit_accepted", () => {
    // a loop inside a branch is fine as long as one way out of it leads to the join
    expect(
      problems(
        yaml([
          "name: loop",
          "nodes:",
          "  - { slug: start, kind: agent, prompt: s }",
          "  - { slug: a, kind: agent, prompt: a }",
          "  - { slug: b, kind: command, command: b }",
          "  - { slug: c, kind: agent, prompt: c }",
          "  - { slug: j, kind: agent, prompt: j, join: all }",
          "edges:",
          "  - { from: start, to: a }",
          "  - { from: start, to: c }",
          "  - { from: a, to: b }",
          "  - { from: b, to: a, when: failed }",
          "  - { from: b, to: j }",
          "  - { from: c, to: j }",
        ]),
      ),
    ).toEqual([]);
  });

  test("t40_validate_failure_fork_zero_length_branch_refused", () => {
    // a fork on a failure label whose branch is the join itself would arrive failed at once, and
    // `restart_failed` would then run the join as a branch
    refused(
      yaml([
        "name: zero-failed",
        "nodes:",
        "  - { slug: start, kind: command, command: s }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: j, kind: agent, prompt: j, join: all }",
        "  - { slug: z, kind: agent, prompt: z }",
        "edges:",
        "  - { from: start, to: z }",
        "  - { from: start, to: a, when: failed }",
        "  - { from: start, to: j, when: failed }",
        "  - { from: a, to: j }",
        "  - { from: j, to: z }",
      ]),
      'edge from "start" to "j" when "failed" is a branch with no step of its own',
      "needs a step before the join",
    );
    // on a success label such a branch is allowed (`t40_zero_length_branch_arrives_at_fork`)
    expect(
      problems(
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
      ),
    ).toEqual([]);
  });

  test("t40_validate_restart_failed_edge_refused", () => {
    refused(
      FORK.replace(
        "  - { from: merge, to: ship }\n",
        `  - { from: merge, to: ship }\n  - { from: merge, to: plan, when: ${RESTART_FAILED} }\n`,
      ),
      `edge from "merge" when "${RESTART_FAILED}" is never taken`,
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
    expect(h.state.forks?.f1?.arrived).toEqual({
      a: { node: "a-test", label: "passed", seq: expect.any(Number) },
    });
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
    expect(h.state.forks?.f1?.arrived).toEqual({
      merge: { node: "plan", label: "passed", seq: expect.any(Number) },
    });
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

  test("t40_refused_follow_up_leaves_branch_open_for_a_valid_result", () => {
    // A result of a branch's work that the engine cannot take (made under another pipeline version,
    // or for an attempt that is not the open one) changes nothing: the branch stays open, as it was,
    // and the result the open work really gives settles it.
    const h = openFork();
    h.release("a");
    h.hold("b-test");
    must(h.send(complete("b", 1)));
    const bTest = h.state.active.find((v) => v.node === "b-test");
    expect(bTest?.phase).toBe("engine");
    const attempt = bTest?.attempt ?? 0;
    const before = JSON.stringify(h.state);
    // made under a pipeline version that is neither the run's nor the one the work was issued under
    const stale = h.send({
      type: "work_finished",
      node: "b-test",
      attempt,
      passed: false,
      reason: "red",
      specHash: "another-version",
    });
    expect(stale.ok && stale.noop).toBe(true);
    // for an attempt that is not open
    const wrong = refusal(
      h.send({
        type: "work_finished",
        node: "b-test",
        attempt: attempt + 1,
        passed: true,
        reason: "",
      }),
    );
    expect(wrong.code).toBe("ATTEMPT_MISMATCH");
    expect(JSON.stringify(h.state)).toBe(before);
    expect(h.state.active.find((v) => v.node === "b-test")?.phase).toBe("engine");
    // the real result of the open work settles the branch
    must(h.send({ type: "work_finished", node: "b-test", attempt, passed: false, reason: "red" }));
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
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
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
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
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

  test("t40_restart_failed_never_reenters_the_join", () => {
    // The validator refuses a fork on a failure label with a branch that is the join itself; a
    // state that has one all the same (a kept pipeline from before the rule) must not run the join
    // as a branch: only branches with a step of their own are restarted.
    const valid = parsePipeline(
      yaml([
        "name: zero-failed",
        "nodes:",
        "  - { slug: start, kind: command, command: s }",
        "  - { slug: a, kind: command, command: a }",
        "  - { slug: b, kind: command, command: b }",
        "  - { slug: j, kind: agent, prompt: j, join: all }",
        "  - { slug: z, kind: agent, prompt: z }",
        "edges:",
        "  - { from: start, to: z }",
        "  - { from: start, to: a, when: failed }",
        "  - { from: start, to: b, when: failed }",
        "  - { from: a, to: j }",
        "  - { from: a, to: j, when: failed }",
        "  - { from: b, to: j }",
        "  - { from: b, to: j, when: failed }",
        "  - { from: j, to: z }",
      ]),
    );
    const spec: PipelineSpec = {
      ...valid,
      nodes: valid.nodes.filter((n) => n.slug !== "b"),
      edges: valid.edges
        .filter((e) => e.from !== "b")
        .map((e) => (e.to === "b" ? { ...e, to: "j" } : e)),
    };
    const h = host(spec, (effect) =>
      effect.type === "run_command" && (effect.node === "start" || effect.node === "a")
        ? fails(effect.node, `${effect.node} broke`)(effect)
        : answer(effect),
    );
    h.hold("j");
    h.send(START);
    // the branch with no step arrived failed as the fork started; a failed on its own
    expect(h.state.forks?.f1?.arrived).toMatchObject({
      j: { node: "start", label: "failed" },
      a: { node: "a", label: "failed" },
    });
    expect(h.state.active.map((v) => v.node)).toEqual(["j"]);
    must(h.send(complete("j", 1, RESTART_FAILED)));
    expect(h.state.status).toBe("running");
    expect(h.state.active.map((v) => v.node)).toEqual(["j"]);
    expect(h.state.nodes.a?.attempt).toBe(2);
    expect(h.state.nodes.j?.attempt).toBe(2);
    expect(
      h.journal.filter((r) => r.event === "node_entered" && r.node === "j" && r.branch),
    ).toEqual([]);
    // with the join as the only failed "branch", there is nothing to run again
    const only: PipelineSpec = {
      ...spec,
      edges: spec.edges.filter((e) => !(e.from === "a" && e.when === "failed")),
    };
    const g = host(only, fails("start", "start broke"));
    g.hold("j");
    g.send(START);
    expect(g.state.active.map((v) => v.node)).toEqual(["j"]);
    const refusedCompletion = refusal(g.send(complete("j", 1, RESTART_FAILED)));
    expect(refusedCompletion.code).toBe("INVALID_ARGUMENTS");
    expect(g.state.status).toBe("running");
  });

  test("t40_join_reached_only_when_join_entered", () => {
    // The join may be entered once; the fork fires twice (ship fails and the run loops), and in the
    // second instance a branch fails. The second join is held back at the attempt limit: it was not
    // reached, so neither the journal nor the report says it was.
    const once = parsePipeline(
      FORK.replace(
        "    join: all\n",
        "    join: all\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
      ),
    );
    const h = host(once, (effect, state) =>
      effect.type === "run_command" && effect.node === "ship"
        ? fails("ship")(effect)
        : effect.type === "run_command" && effect.node === "b-test" && state.forks?.f2
          ? fails("b-test", "red")(effect)
          : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.forks?.f1?.joined).toBe(1);
    must(h.send(complete("merge", 1)));
    // ship failed, plan ran again and forked again; b-test failed, a arrived: the join is full
    must(h.send(complete("plan", 2)));
    expect(Object.keys(h.state.forks?.f2?.arrived ?? {}).sort()).toEqual(["a", "b"]);
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "total",
        node: "merge",
        blocked: expect.objectContaining({ to: "merge", join: "f2" }),
      }),
    ]);
    expect(h.state.status).toBe("paused");
    expect(h.state.forks?.f2?.joined).toBe(0);
    expect(h.events().filter((e) => e === "join_reached")).toHaveLength(1);
    expect(summarizeRun(h.state, h.journal).failed_branches).toBe(false);
    expect(summarizeRun(h.state, h.journal).forks.map((f) => f.joined)).toEqual([1, 0]);
    // resumed, the join is entered and counted, with the failed branch named
    h.send({ type: "resume" });
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.forks?.f2?.joined).toBe(1);
    const reached = h.journal.filter((r) => r.event === "join_reached");
    expect(reached).toHaveLength(2);
    expect(reached[1]).toMatchObject({ fork: "f2", join: "merge", failed: ["b"] });
    expect(h.state.nodes.merge?.lastFailures?.map((f) => f.from)).toEqual(["b-test"]);
    expect(summarizeRun(h.state, h.journal).failed_branches).toBe(true);
    // the journal says it in the usual order: the join is reached, then entered
    const events = h.events();
    expect(events[events.lastIndexOf("join_reached") + 1]).toBe("node_entered");
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
  // (a) one visit per node. The machine ends the run rather than open a second visit (`enter`), so
  // the state alone never shows one: what shows it is the reason the run ended with. A branch of a
  // valid pipeline never stops with no way on either; a change that moved a step of an open fork
  // would make it (a step moved past the join), and such a change is refused.
  const visited = state.active.map((v) => v.node);
  expect(new Set(visited).size, `${where}: two visits of one node`).toBe(visited.length);
  const told = JSON.stringify(journal);
  expect(told, `${where}: a node entered twice`).not.toContain(
    "was entered while an attempt of it was still going",
  );
  expect(told, `${where}: a branch with no way on`).not.toContain("has no way on");
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
    // (g) and never because an accepted change took a branch the run still stood in
    expect(reason, where).not.toContain("is no longer in the pipeline");
  }
  // (i) an instance something still stands in (a branch, or its join, which the latest instance
  // owns) names the branches the pipeline the run is on forks into: a change of the shape of an
  // open fork was refused, so `restart_failed` never enters a branch the pipeline lost
  const instances = Object.values(state.forks ?? {});
  for (const fork of instances) {
    const latest = instances.filter((f) => f.join === fork.join).at(-1) === fork;
    const standing =
      fork.branches.some((b) => fork.arrived[b] === undefined) ||
      state.active.some((v) => v.fork?.id === fork.id || (latest && v.node === fork.join)) ||
      state.pauses.some(
        (p) =>
          p.fork?.id === fork.id ||
          p.blocked?.join === fork.id ||
          (latest && (p.node === fork.join || p.blocked?.from === fork.join)),
      );
    if (standing) {
      const targets = spec.edges
        .filter((e) => e.from === fork.from && e.when === fork.label)
        .map((e) => e.to);
      expect(targets, `${where}: ${fork.id} stands in a fork of another shape`).toEqual(
        fork.branches,
      );
    }
  }
  // (h) what stands, stands in the pipeline the run is on: a change that took the node away was refused
  const slugs = new Set(spec.nodes.map((n) => n.slug));
  for (const visit of state.active)
    expect(slugs.has(visit.node), `${where}: ${visit.node}`).toBe(true);
  for (const pause of state.pauses) {
    expect(slugs.has(pause.node), `${where}: ${pause.node}`).toBe(true);
    for (const to of pause.blocked?.heads ?? [pause.blocked?.to ?? pause.node]) {
      expect(slugs.has(to), `${where}: ${to}`).toBe(true);
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
  if (state.status === "running" || state.status === "paused") {
    // (j) no visit and no pause means the run has ended: never `paused` with nothing to resume
    expect(
      state.active.length > 0 || state.pauses.length > 0,
      `${where}: ${state.status} with nothing active and no pause`,
    ).toBe(true);
    expect(state.finishedAt, `${where}: finishedAt of a run that goes on`).toBeUndefined();
  } else {
    expect(state.finishedAt, `${where}: an ended run without finishedAt`).toBeDefined();
  }
  // (k) a `restarts` pause has its suspended work behind it, which `resume` issues again
  for (const pause of state.pauses.filter((p) => p.reason === "restarts")) {
    expect(
      state.active.some((v) => v.suspended && v.node === pause.node),
      `${where}: restarts pause of ${pause.node} without suspended work`,
    ).toBe(true);
  }
  expect(state.trail[0]).toBe(spec.entry);
}

/** The targets of the fork edges of `spec` at `from`, in edge order (what a fork fires into). */
const forkTargetsOf = (spec: PipelineSpec, from: string) =>
  spec.edges.filter((e) => e.from === from && e.when === "passed").map((e) => e.to);

/**
 * A random schedule of a run of `spec`: the pending effects are answered in random order, with
 * ticks, resumes and a cancel thrown in and, with `variants`, the pipeline changed back and forth
 * between `spec` and one of them (a refused change is one more thing that must leave the state
 * alone). A variant that changes which branches the fork at `plan` has is a change of the shape of
 * the fork: it must be refused while an instance is open and taken once the instance is left, and
 * both are counted. The state goes through JSON between events, as the host writes it and reads it back.
 */
function simulate(
  spec: PipelineSpec,
  seed: number,
  steps = 300,
  withRestart = false,
  variants: PipelineSpec[] = [],
  options: EngineOptions = {},
) {
  const random = mulberry32(seed);
  let state: RunState | undefined;
  let now = 0;
  let current = spec;
  let changes = 0;
  let shapeRefused = 0;
  let shapeAccepted = 0;
  let moveRefused = 0;
  const accepted: PipelineSpec[] = [];
  const hashOf = (version: PipelineSpec) =>
    version === spec ? "h" : `h${variants.indexOf(version) + 2}`;
  const pending: Effect[] = [];
  const journal: JournalRecord[] = [];
  const seen = new Set<string>();
  const replayed = new Set<Effect>();
  let refusedFollowUps = 0;
  const send = (event: RunEvent) => {
    const before = state === undefined ? undefined : structuredClone(state);
    const result = decide(current, state, event, now, options);
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
    state = JSON.parse(JSON.stringify(result.state)) as RunState;
    seen.add(state.status);
    journal.push(...result.journal);
    pending.push(...result.effects);
    forkInvariants(current, state, journal, seed);
    return result;
  };
  send(START);
  for (let i = 0; i < steps; i++) {
    const roll = random();
    if (variants.length > 0 && roll >= 0.962 && roll < 0.975) {
      const was = current;
      current =
        was === spec ? (variants[Math.floor(random() * variants.length)] as PipelineSpec) : spec;
      const shape =
        JSON.stringify(forkTargetsOf(was, "plan")) !==
        JSON.stringify(forkTargetsOf(current, "plan"));
      const result = send({
        type: "pipeline_accepted",
        from: hashOf(was),
        to: hashOf(current),
        source: "file",
        before: was,
      });
      if (result.ok) {
        changes += 1;
        accepted.push(was === spec ? current : was);
        if (shape) shapeAccepted += 1;
      } else {
        if (shape && result.error.message.includes("is open")) shapeRefused += 1;
        if (result.error.message.includes("the place of a step of an open fork")) moveRefused += 1;
        current = was;
      }
    } else if (pending.length > 0 && roll < 0.8) {
      const [effect] = pending.splice(Math.floor(random() * pending.length), 1);
      if (!effect) continue;
      // Work that was restarted or suspended may still answer: its effect comes back later, once.
      if (
        (effect.type === "run_command" || effect.type === "run_check") &&
        !replayed.has(effect) &&
        random() < 0.15
      ) {
        replayed.add(effect);
        pending.push(effect);
      }
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
      const engine = (state?.active ?? []).filter(
        (v) => v.phase === "engine" || v.phase === "checks",
      );
      const alive = engine[Math.floor(random() * engine.length)];
      // a sign of life of one piece of work, so a tick restarts or suspends only some of it
      if (alive && random() < 0.5)
        send({ type: "heartbeat", node: alive.node, attempt: alive.attempt });
      send({ type: "tick" });
    } else if (roll < 0.96) {
      const pauses = state?.pauses ?? [];
      const pick = pauses[Math.floor(random() * pauses.length)];
      send({ type: "resume", ...(pauses.length > 1 && pick ? { node: pick.node } : {}) });
    } else if (roll < 0.962) {
      send({ type: "cancel" });
    }
  }
  return {
    state: state as RunState,
    journal,
    seen,
    refusedFollowUps,
    changes,
    shapeRefused,
    shapeAccepted,
    moveRefused,
    accepted,
  };
}

describe("t40 random schedules", () => {
  const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);
  /**
   * `FORK` with a join that pauses on its first red check: the join is then held back on its rework
   * route often enough for a change of the fork's shape to meet it (`isOpen`, pipeline-diff.ts).
   */
  const PAUSING = FORK.replace(
    "    join: all\n",
    "    join: all\n    max_consecutive_failures: 1\n",
  );
  const pausing = parsePipeline(PAUSING);
  /** Another version of each pipeline: the join's prompt and a's check; a's prompt. */
  const forkVariant = parsePipeline(
    PAUSING.replace("prompt: merge", "prompt: merge again").replace(
      "command: a-check",
      "command: a-check-2",
    ),
  );
  const gatedVariant = parsePipeline(GATED.replace("prompt: a }", "prompt: a again }"));
  /** Structural variants: a third branch `c`; the join's attempt limits. */
  const forkThreeBranches = parsePipeline(
    PAUSING.replace(
      "  - { slug: ship, kind: command, command: ship }\n",
      "  - { slug: ship, kind: command, command: ship }\n  - { slug: c, kind: command, command: c }\n",
    ).replace(
      "  - { from: merge, to: ship }\n",
      "  - { from: plan, to: c }\n  - { from: c, to: merge }\n  - { from: c, to: merge, when: failed }\n  - { from: merge, to: ship }\n",
    ),
  );
  const forkJoinLimit = parsePipeline(
    PAUSING.replace(
      "max_consecutive_failures: 1\n",
      "max_attempts: 3\n    max_consecutive_failures: 2\n",
    ),
  );
  /** `b-test` moved from branch `b` to the end of branch `a`. */
  const forkMoved = parsePipeline(
    PAUSING.replace(
      "  - { from: a-test, to: merge }\n",
      "  - { from: a-test, to: b-test }\n",
    ).replace("  - { from: b, to: b-test }\n", "  - { from: b, to: merge }\n"),
  );
  const forkVariants = [forkVariant, forkThreeBranches, forkJoinLimit];

  test("t40_random_schedule_keeps_invariants", () => {
    const statuses = new Set<string>();
    let forked = 0;
    let changed = 0;
    let shapeRefused = 0;
    let shapeAccepted = 0;
    expect(forkTargetsOf(forkThreeBranches, "plan")).toEqual(["a", "b", "c"]);
    for (const seed of SEEDS) {
      const run = simulate(pausing, seed, 300, false, forkVariants);
      for (const s of run.seen) statuses.add(s);
      if (run.state.forks) forked += 1;
      changed += run.changes;
      shapeRefused += run.shapeRefused;
      shapeAccepted += run.shapeAccepted;
      // a result of work this run asked for is never refused while the run goes (a pending effect
      // answered after the run ended is the one case, and that is the end, not a stall)
      expect(run.refusedFollowUps, `seed ${seed}`).toBe(0);
    }
    expect(forked).toBeGreaterThan(SEEDS.length / 2);
    expect(changed).toBeGreaterThan(SEEDS.length / 8);
    // the shape of the fork changed both ways: refused while an instance was open, taken after
    expect(shapeRefused).toBeGreaterThan(0);
    expect(shapeAccepted).toBeGreaterThan(0);
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
  }, 60_000);

  test("t40_random_schedule_moves_a_step_between_branches", () => {
    // A step of an open instance (standing, held by a pause, or in a branch that arrived failed and
    // may run again) cannot move to another branch or past the join; once the instance is left, or
    // while the step is not yet the run's, it can. Either way the run never ends by entering a node
    // twice or by a branch with no way on (`forkInvariants`).
    expect(forkMoved.edges).toContainEqual({ from: "a-test", to: "b-test", when: "passed" });
    let moveRefused = 0;
    let moveAccepted = 0;
    for (const seed of SEEDS) {
      for (const withRestart of [false, true]) {
        const run = simulate(pausing, seed + 3000, 300, withRestart, [forkMoved, forkVariant]);
        moveRefused += run.moveRefused;
        moveAccepted += run.accepted.filter((v) => v === forkMoved).length;
        expect(run.refusedFollowUps, `seed ${seed}`).toBe(0);
      }
    }
    expect(moveRefused).toBeGreaterThan(0);
    expect(moveAccepted).toBeGreaterThan(0);
  }, 60_000);

  test("t40_random_schedule_with_pauses_and_restart_failed", () => {
    let restarted = 0;
    let resumedInFork = 0;
    for (const seed of SEEDS) {
      const { journal } = simulate(gated, seed, 300, true, [gatedVariant]);
      const { journal: j2 } = simulate(pausing, seed + 1000, 300, true, forkVariants);
      for (const j of [journal, j2]) {
        restarted += j.filter(
          (r) => r.event === "node_finished" && r.outcome === RESTART_FAILED,
        ).length;
        resumedInFork += j.filter((r) => r.event === "run_resumed" && r.fork !== undefined).length;
      }
    }
    expect(restarted).toBeGreaterThan(0);
    expect(resumedInFork).toBeGreaterThan(0);
  }, 60_000);

  test("t40_random_schedule_with_suspended_work_and_late_results", () => {
    // Work goes stale fast and is suspended at its first restart, so a branch's work is often
    // suspended while its sibling goes on, and its late result comes back.
    let suspended = 0;
    let ended = 0;
    for (const seed of SEEDS) {
      const runs: [PipelineSpec, PipelineSpec[]][] = [
        [pausing, forkVariants],
        [gated, [gatedVariant]],
      ];
      for (const [spec, variants] of runs) {
        const run = simulate(spec, seed + 2000, 300, true, variants, {
          staleMs: 20_000,
          maxRestarts: 0,
        });
        suspended += run.journal.filter(
          (r) => r.event === "run_paused" && r.reason === "restarts",
        ).length;
        if (run.state.status !== "running" && run.state.status !== "paused") ended += 1;
        expect(run.refusedFollowUps, `seed ${seed}`).toBe(0);
      }
    }
    expect(suspended).toBeGreaterThan(SEEDS.length / 4);
    expect(ended).toBeGreaterThan(SEEDS.length / 4);
  }, 60_000);

  test("t40_random_schedule_self_test_catches_an_injected_bug", () => {
    const h = openFork();
    const state = structuredClone(h.state);
    // a second visit of a node
    state.active.push({ ...(state.active[0] as RunState["active"][number]) });
    expect(() => forkInvariants(fork, state, h.journal, 0)).toThrow();
    // a run paused with nothing active and no pause
    const stuck = structuredClone(h.state);
    stuck.status = "paused";
    stuck.active = [];
    stuck.pauses = [];
    expect(() => forkInvariants(fork, stuck, h.journal, 0)).toThrow();
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
    // a run that ended because a node was entered twice
    const twice = structuredClone(h.state);
    twice.status = "failed";
    twice.active = [];
    twice.pauses = [];
    twice.finishedAt = 1;
    const collided: JournalRecord[] = [
      ...h.journal,
      {
        v: 2,
        seq: 99,
        ts: 0,
        event: "run_finished",
        status: "failed",
        reason: 'node "a" was entered while an attempt of it was still going',
      },
    ];
    expect(() => forkInvariants(fork, twice, collided, 0)).toThrow("entered twice");
  });
});

// ── repair in a fork (X) ────────────────────────────────────────────────────

describe("t40 repair in a fork", () => {
  const accepted = (before: PipelineSpec, standing?: string): RunEvent => ({
    type: "pipeline_accepted",
    from: "h",
    to: "h2",
    source: "file",
    before,
    ...(standing === undefined ? {} : { standing }),
  });
  const failed = (effect: Effect, reason: string): RunEvent | undefined =>
    effect.type === "run_command"
      ? { type: "work_finished", node: effect.node, attempt: effect.attempt, passed: false, reason }
      : effect.type === "run_check"
        ? {
            type: "check_finished",
            node: effect.node,
            attempt: effect.attempt,
            index: effect.index,
            passed: false,
            reason,
          }
        : answer(effect);
  /** `node` fails (its command or its checks) while the run is still on the first version of the pipeline. */
  const failsUntilRepaired =
    (node: string) =>
    (effect: Effect, state: RunState): RunEvent | undefined =>
      "node" in effect && effect.node === node && state.specHash === "h"
        ? failed(effect, `${node} is red`)
        : answer(effect);
  const branchOf = (record: JournalRecord | undefined) => [record?.fork, record?.branch];

  /** `a` may be entered once; a-test fails, so branch a is held back at a `total` pause while b is open. */
  function totalA(reply: (effect: Effect, state: RunState) => RunEvent | undefined) {
    const text = FORK.replace(
      "  - slug: a\n",
      "  - slug: a\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
    );
    const before = parsePipeline(text);
    const h = host(before, reply);
    h.hold("b", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "total",
        node: "a",
        blocked: expect.objectContaining({ from: "a-test", to: "a" }),
        fork: { id: "f1", branch: "a" },
      }),
    ]);
    expect(h.state.status).toBe("running");
    return { text, before, h };
  }

  test("t40_effects_list_recheck_for_paused_branch", () => {
    const text = FORK.replace("  - slug: a\n", "  - slug: a\n    max_consecutive_failures: 1\n");
    const before = parsePipeline(text);
    const after = parsePipeline(text.replace("command: a-check", "command: a-check-fixed"));
    const h = host(before, failsUntilRepaired("a"));
    h.hold("b", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    h.send(complete("a", 1));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "consecutive",
        node: "a",
        fork: { id: "f1", branch: "a" },
      }),
    ]);
    expect(h.state.nodes.a?.lastFailure?.source).toBe("check:command");
    expect(h.state.status).toBe("running");

    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([{ kind: "recheck", node: "a" }]);
    h.use(after);
    const result = must(h.send(accepted(before)));
    expect(result.journal.find((r) => r.event === "pipeline_accepted")).toMatchObject({
      effects: [{ kind: "recheck", node: "a" }],
    });
    // the check ran again on the work that is there, in its own branch, and the branch went on
    expect(h.events().filter((e) => e === "checks_rerun")).toHaveLength(1);
    expect(h.state.nodes.a?.attempt).toBe(1);
    expect(h.state.pauses).toEqual([]);
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(h.state.forks?.f1?.arrived.b).toBeUndefined();
    expect(h.state.active.map((v) => v.node)).toEqual(["b"]);
  });

  test("t40_effects_reroute_inside_fork", () => {
    const { text, before, h } = totalA(failsUntilRepaired("a-test"));
    const after = parsePipeline(text.replace("max_attempts: 1", "max_attempts: 3"));
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.nodes).toEqual([{ slug: "a", changes: ["routing"] }]);
    expect(diff.effects).toEqual([{ kind: "reroute", node: "a-test", to: "a", branch: "a" }]);
    h.use(after);
    must(h.send(accepted(before)));
    // the way on was worked out again: `a` got its second attempt, inside its branch
    const entered = h.journal.filter((r) => r.event === "node_entered" && r.node === "a");
    expect(entered.map((r) => r.attempt)).toEqual([1, 2]);
    expect(branchOf(entered[1])).toEqual(["f1", "a"]);
    expect(h.state.pauses).toEqual([]);
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(h.state.active.map((v) => v.node)).toEqual(["b"]);
  });

  test("t40_reroute_of_join_pause_reenters_join_without_rearriving", () => {
    // The join is held back at its attempt limit (`t40_join_reached_only_when_join_entered`); the
    // person raises the limit. The way into the join is taken again: the last branch does not
    // arrive a second time, and its failure count is not touched.
    const text = FORK.replace(
      "    join: all\n",
      "    join: all\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
    );
    const before = parsePipeline(text);
    const h = host(before, (effect, state) =>
      effect.type === "run_command" && effect.node === "ship"
        ? failed(effect, "ship is red")
        : effect.type === "run_command" && effect.node === "b-test" && state.forks?.f2
          ? failed(effect, "b-test is red")
          : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1)));
    must(h.send(complete("plan", 2)));
    expect(h.state.pauses.map((p) => [p.reason, p.node])).toEqual([["total", "merge"]]);
    const settledBefore = h.events().filter((e) => e === "branch_settled").length;
    const failures = h.state.nodes["b-test"]?.consecutiveFailures;
    expect(failures).toBe(1);
    const after = parsePipeline(text.replace("    max_attempts: 1\n", "    max_attempts: 2\n"));
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    // a-test arrived last (a has a check to pass first): the effect names it, and it passed
    expect(diff.effects).toEqual([{ kind: "reroute", node: "a-test", to: "merge" }]);
    expect(h.state.nodes["a-test"]?.status).toBe("passed");
    h.use(after);
    must(h.send(accepted(before)));
    expect(h.state.pauses).toEqual([]);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge?.attempt).toBe(2);
    expect(h.state.forks?.f2?.joined).toBe(1);
    expect(h.state.forks?.f2?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(h.state.forks?.f2?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    expect(h.events().filter((e) => e === "branch_settled")).toHaveLength(settledBefore);
    expect(h.events().filter((e) => e === "join_reached")).toHaveLength(2);
    expect(h.state.nodes["b-test"]?.consecutiveFailures).toBe(failures);
    expect(h.state.nodes["a-test"]?.status).toBe("passed");
    expect(h.state.nodes.merge?.lastFailures?.map((f) => f.from)).toEqual(["b-test"]);
  });

  test("t40_resume_at_join_tops_up_join_and_nodes_outside_its_branches_only", () => {
    // The join is held back at its attempt limit after the loop (`ship` failed) brought the fork a
    // second time; `plan` (outside the fork) and `b-test` (inside branch b) have used up their
    // attempts too. The person's `resume` is the join's: it and the nodes outside the fork's branches
    // get a fresh budget, the branches that arrived at the join asked for nothing.
    const text = FORK.replace(
      "    join: all\n",
      "    join: all\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
    )
      .replace(
        "  - { slug: plan, kind: agent, prompt: plan }",
        "  - { slug: plan, kind: agent, prompt: plan, max_attempts: 2, max_consecutive_failures: 2 }",
      )
      .replace(
        "  - { slug: b-test, kind: command, command: b-test }",
        "  - { slug: b-test, kind: command, command: b-test, max_attempts: 2, max_consecutive_failures: 2 }",
      );
    const h = host(parsePipeline(text), (effect, state) =>
      effect.type === "run_command" && effect.node === "ship"
        ? failed(effect, "ship is red")
        : effect.type === "run_command" && effect.node === "b-test" && state.forks?.f2
          ? failed(effect, "b-test is red")
          : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1)));
    must(h.send(complete("plan", 2)));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({ reason: "total", node: "merge", blocked: expect.anything() }),
    ]);
    expect(h.state.pauses[0]?.fork).toBeUndefined();
    const exhausted = (slug: string, max: number) =>
      (h.state.nodes[slug]?.attempt ?? 0) >= max + (h.state.nodes[slug]?.extraAttempts ?? 0);
    expect(exhausted("plan", 2)).toBe(true);
    expect(exhausted("b-test", 2)).toBe(true);
    expect(exhausted("merge", 1)).toBe(true);
    must(h.send({ type: "resume" }));
    expect(h.state.pauses).toEqual([]);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge?.extraAttempts).toBe(1);
    expect(h.state.nodes.plan?.extraAttempts).toBe(2);
    expect(h.state.nodes["b-test"]?.extraAttempts).toBe(0);
    expect(h.state.nodes["a-test"]?.extraAttempts).toBe(0);
  });

  test("t40_repair_loop_works_in_open_fork", () => {
    // a-test fails three times in a row (the loop a-test -> a -> a-test), so branch a is held back
    const before = fork;
    const after = parsePipeline(FORK.replace("command: a-test", "command: a-test-fixed"));
    const h = host(before, failsUntilRepaired("a-test"));
    h.hold("b", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "consecutive",
        node: "a-test",
        blocked: expect.objectContaining({ from: "a-test", to: "a" }),
      }),
    ]);
    expect(h.state.nodes.a?.attempt).toBe(3);

    const diff = diffPipelines(before, after, h.state);
    expect(diff.effects).toEqual([{ kind: "reroute", node: "a-test", to: "a", branch: "a" }]);
    h.use(after);
    must(h.send(accepted(before)));
    // the repaired loop runs: a once more, a-test with the new command, and the branch arrives
    expect(h.state.nodes.a?.attempt).toBe(4);
    const commands = h.effects.filter((e) => e.type === "run_command" && e.node === "a-test");
    expect(commands.at(-1)).toMatchObject({ command: "a-test-fixed", attempt: 4 });
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(h.state.pauses).toEqual([]);
    // and the other branch still joins as usual
    h.release("b");
    expect(h.events()).toContain("join_reached");
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
  });

  test("t40_rejected_repair_leaves_run_unchanged", () => {
    const h = openFork();
    const without: PipelineSpec = {
      ...fork,
      nodes: fork.nodes.filter((n) => n.slug !== "b"),
      edges: fork.edges.filter((e) => e.from !== "b" && e.to !== "b"),
    };
    const before = JSON.stringify(h.state);
    const result = decide(without, h.state, accepted(fork), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PIPELINE_CHANGE_REFUSED");
      expect(result.error.message).toContain('node "b" is where the run stands');
    }
    expect(JSON.stringify(h.state)).toBe(before);
    expect(h.state.specHash).toBe("h");
  });

  test("t40_pipeline_change_multi_visit_diff", () => {
    const h = openFork();
    const after = parsePipeline(
      FORK.replace("    prompt: a\n", "    prompt: a!\n").replace(
        "{ slug: b, kind: agent, prompt: b }",
        "{ slug: b, kind: agent, prompt: b! }",
      ),
    );
    const diff = diffPipelines(fork, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([
      { kind: "restart", node: "a" },
      { kind: "restart", node: "b" },
    ]);
    h.use(after);
    const result = must(h.send(accepted(fork)));
    expect(result.journal.map((r) => r.event)).toEqual([
      "pipeline_accepted",
      "node_superseded",
      "node_entered",
      "node_superseded",
      "node_entered",
    ]);
    expect(h.state.active.map((v) => [v.node, v.attempt, v.fork])).toEqual([
      ["a", 2, { id: "f1", branch: "a" }],
      ["b", 2, { id: "f1", branch: "b" }],
    ]);
    for (const slug of ["a", "b"]) {
      expect(h.state.nodes[slug]).toMatchObject({ attempt: 2, extraAttempts: 1 });
      const entered = result.journal.find((r) => r.event === "node_entered" && r.node === slug);
      expect(branchOf(entered)).toEqual(["f1", slug]);
    }
  });

  test("t40_pipeline_change_one_paused_one_running", () => {
    const { text, before, h } = totalA(failsUntilRepaired("a-test"));
    const after = parsePipeline(
      text
        .replace("max_attempts: 1", "max_attempts: 3")
        .replace("{ slug: b, kind: agent, prompt: b }", "{ slug: b, kind: agent, prompt: b! }"),
    );
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    // the standing visits first, then the pauses
    expect(diff.effects).toEqual([
      { kind: "restart", node: "b" },
      { kind: "reroute", node: "a-test", to: "a", branch: "a" },
    ]);
    h.use(after);
    const result = must(h.send(accepted(before)));
    expect(result.journal.find((r) => r.event === "pipeline_accepted")).toMatchObject({
      effects: diff.effects,
    });
    expect(h.state.pauses).toEqual([]);
    expect(h.state.active.map((v) => [v.node, v.attempt])).toEqual([["b", 2]]);
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(h.state.status).toBe("running");
  });

  test("t40_pipeline_change_join_check_allowed_in_open_fork", () => {
    const h = openFork();
    const fixedCheck = parsePipeline(
      FORK.replace("command: merge-check", "command: merge-check-2"),
    );
    // the join has not started: its new check is simply the one that runs later
    const early = diffPipelines(fork, fixedCheck, h.state);
    expect(early.refused).toBeUndefined();
    expect(early.nodes).toEqual([{ slug: "merge", changes: ["checks"] }]);
    expect(early.effects).toEqual([]);
    // the join is being worked: a change of its checks waits for its completion, of its prompt restarts it
    h.release("a");
    h.release("b");
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    const late = diffPipelines(fork, fixedCheck, h.state);
    expect(late.refused).toBeUndefined();
    expect(late.effects).toEqual([]);
    const prompt = parsePipeline(FORK.replace("    prompt: merge\n", "    prompt: merge!\n"));
    expect(diffPipelines(fork, prompt, h.state)).toMatchObject({
      effects: [{ kind: "restart", node: "merge" }],
    });
    h.use(prompt);
    must(h.send(accepted(fork)));
    expect(h.state.active.map((v) => [v.node, v.attempt])).toEqual([["merge", 2]]);
    expect(h.state.forks?.f1?.joined).toBe(1);
  });

  test("t40_pipeline_change_removing_standing_node_refused", () => {
    const h = openFork();
    const without: PipelineSpec = {
      ...fork,
      nodes: fork.nodes.filter((n) => n.slug !== "a"),
      edges: fork.edges
        .filter((e) => e.from !== "a" && e.to !== "a")
        .concat([{ from: "plan", to: "a-test", when: "passed" }]),
    };
    const diff = diffPipelines(fork, without, h.state);
    expect(diff.refused).toContain('node "a" is where the run stands, so it cannot be removed');
    expect(diff.effects).toEqual([]);
  });

  test("t40_pipeline_change_blocked_node_refused", () => {
    const { before, h } = totalA(fails("a-test"));
    // `a` is the node the paused branch is about to enter
    const withoutA: PipelineSpec = {
      ...before,
      nodes: before.nodes.filter((n) => n.slug !== "a"),
      edges: before.edges
        .filter((e) => e.from !== "a" && e.to !== "a")
        .concat([{ from: "plan", to: "a-test", when: "passed" }]),
    };
    expect(diffPipelines(before, withoutA, h.state).refused).toContain(
      'node "a" is the one a paused step is about to enter, so it cannot be removed',
    );
    // a-test is the node the branch is held back at
    const withoutTest: PipelineSpec = {
      ...before,
      nodes: before.nodes.filter((n) => n.slug !== "a-test"),
      edges: before.edges
        .filter((e) => e.from !== "a-test" && e.to !== "a-test")
        .concat([{ from: "a", to: "merge", when: "passed" }]),
    };
    expect(diffPipelines(before, withoutTest, h.state).refused).toContain(
      'node "a-test" is where the run is held back, so it cannot be removed',
    );
  });

  test("t40_pipeline_change_fork_edges_or_join_field_refused", () => {
    const h = openFork();
    const third = parsePipeline(
      FORK.replace(
        "  - { slug: ship,",
        "  - { slug: c, kind: command, command: c }\n  - { slug: ship,",
      )
        .replace(
          "  - { from: plan, to: b }\n",
          "  - { from: plan, to: b }\n  - { from: plan, to: c }\n",
        )
        .replace(
          "  - { from: merge, to: ship }\n",
          "  - { from: c, to: merge }\n  - { from: c, to: merge, when: failed }\n  - { from: merge, to: ship }\n",
        ),
    );
    expect(diffPipelines(fork, third, h.state).refused).toContain(
      'the fork at "plan" is open (its branches have not all met at "merge" and gone on from there), so its edges cannot change now',
    );
    const noJoin: PipelineSpec = {
      ...fork,
      nodes: fork.nodes.map((n) => {
        if (n.slug !== "merge") return n;
        const { join: _join, ...rest } = n;
        return rest;
      }),
    };
    expect(diffPipelines(fork, noJoin, h.state).refused).toContain(
      'node "merge" is the join of an open fork, so its `join` cannot change now',
    );
    // once the branches have met and the join has passed, the fork is history and may change
    h.hold("ship");
    h.release("a");
    h.release("b");
    h.release("merge");
    expect(h.state.active.map((v) => v.node)).toEqual(["ship"]);
    const closed = diffPipelines(fork, third, h.state);
    expect(closed.refused).toBeUndefined();
    expect(closed.effects).toEqual([]);
  });

  test("t40_accept_refused_when_standing_visits_changed", () => {
    const h = openFork();
    const shown = standingOf(h.state);
    expect(shown).toBe(standingOf(structuredClone(h.state)));
    const after = parsePipeline(FORK.replace("    prompt: merge\n", "    prompt: merge!\n"));
    // the run moved on while the person read: branch a arrived
    h.release("a");
    expect(standingOf(h.state)).not.toBe(shown);
    h.use(after);
    const stale = h.send(accepted(fork, shown));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("PIPELINE_CHANGE_REFUSED");
      expect(stale.error.message).toContain("the run moved on since the change was shown");
      expect(stale.error.message).toContain("look at it again");
    }
    expect(h.state.specHash).toBe("h");
    // looked at again, the same change is taken
    must(h.send(accepted(fork, standingOf(h.state))));
    expect(h.state.specHash).toBe("h2");
    // a pause is part of where the run stands
    const { h: paused } = totalA((effect) =>
      effect.type === "run_command" && effect.node === "a-test" && effect.attempt === 1
        ? failed(effect, "red once")
        : answer(effect),
    );
    const withPause = standingOf(paused.state);
    expect(withPause).toContain("pause:a:total:a-test>a");
    paused.send({ type: "resume", node: "a" });
    expect(standingOf(paused.state)).not.toBe(withPause);
  });

  test("t40_failed_arrived_branch_reachable_for_repair", () => {
    // b-test fails and arrives failed; the join is being worked on
    const before = fork;
    const after = parsePipeline(FORK.replace("command: b-test", "command: b-test-fixed"));
    const h = host(before, failsUntilRepaired("b-test"));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.nodes).toEqual([{ slug: "b-test", changes: ["work"] }]);
    expect(diff.effects).toEqual([]);
    h.use(after);
    must(h.send(accepted(before)));
    // restart_failed runs the failed branch on the repaired definition
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    const commands = h.effects.filter((e) => e.type === "run_command" && e.node === "b-test");
    expect(commands.at(-1)).toMatchObject({ command: "b-test-fixed", attempt: 2 });
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "passed" });
  });

  test("t40_report_format_history_read_effects_list", () => {
    const { text, before, h } = totalA(failsUntilRepaired("a-test"));
    const after = parsePipeline(
      text
        .replace("max_attempts: 1", "max_attempts: 3")
        .replace("{ slug: b, kind: agent, prompt: b }", "{ slug: b, kind: agent, prompt: b! }"),
    );
    h.use(after);
    must(
      h.send({
        type: "pipeline_accepted",
        from: "h",
        to: "h2",
        source: "proposal",
        before,
        reason: "both branches",
      }),
    );
    const report = summarizeRun(h.state, h.journal);
    expect(report.pipeline_changes).toEqual([
      {
        at: 0,
        from: "h",
        to: "h2",
        source: "proposal",
        nodes: [
          { slug: "a", changes: ["routing"] },
          { slug: "b", changes: ["work"] },
        ],
        effects: [
          { kind: "restart", node: "b" },
          { kind: "reroute", node: "a-test" },
        ],
        reason: "both branches",
      },
    ]);
    // a record with no or a malformed list reads as nothing redone, never as a crash
    const odd = h.journal.map((r) =>
      r.event === "pipeline_accepted" ? { ...r, effects: [{ kind: "restart" }, 3, null] } : r,
    );
    expect(summarizeRun(h.state, odd).pipeline_changes[0]?.effects).toEqual([]);
  });

  test("t40_reroute_of_fork_edge_pause_enters_head_under_same_fork", () => {
    // `a` may be entered once. The loop (`ship` failed) brings the fork a second time: `a` is held
    // back at the fork's own edge while `b` is being worked. The person raises a's limit: the blocked
    // route is taken as it is, under the open instance; the fork does not fire again beside it.
    const text = FORK.replace(
      "  - slug: a\n",
      "  - slug: a\n    max_attempts: 1\n    max_consecutive_failures: 1\n",
    );
    const before = parsePipeline(text);
    const h = host(before, (effect, state) =>
      effect.type === "run_command" && effect.node === "ship" && state.forks?.f2 === undefined
        ? failed(effect, "ship is red")
        : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1)));
    h.hold("a", "b");
    must(h.send(complete("plan", 2)));
    expect(h.state.pauses).toEqual([
      {
        reason: "total",
        node: "a",
        blocked: {
          from: "plan",
          label: "passed",
          to: "a",
          rework: false,
          fork: { id: "f2", branch: "a" },
        },
        fork: { id: "f2", branch: "a" },
      },
    ]);
    expect(h.state.active.map((v) => [v.node, v.fork])).toEqual([["b", { id: "f2", branch: "b" }]]);
    const after = parsePipeline(text.replace("max_attempts: 1", "max_attempts: 3"));
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([{ kind: "reroute", node: "plan", to: "a", branch: "a" }]);
    h.use(after);
    must(h.send(accepted(before)));
    expect(h.state.status).toBe("running");
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2"]);
    expect(h.events().filter((e) => e === "fork_started")).toHaveLength(2);
    expect(h.state.pauses).toEqual([]);
    // `a` entered under f2 beside `b`, which was not touched
    expect(h.state.active.map((v) => [v.node, v.attempt, v.fork])).toEqual([
      ["b", 2, { id: "f2", branch: "b" }],
      ["a", 2, { id: "f2", branch: "a" }],
    ]);
    expect(h.state.forks?.f2?.arrived).toEqual({});
    // and the run goes on to its end
    h.release("a");
    h.release("b");
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.forks?.f2?.joined).toBe(1);
    must(h.send(complete("merge", 2)));
    expect(h.state.status).toBe("completed");
  });

  /** A command that fails forks into two agent fixes; the join leads back to the command. */
  const FIXERS = yaml([
    "name: fixers",
    "nodes:",
    "  - { slug: build, kind: command, command: build, max_consecutive_failures: 2 }",
    "  - { slug: fix-a, kind: agent, prompt: fix a }",
    "  - { slug: fix-b, kind: agent, prompt: fix b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: build, to: fix-a, when: failed }",
    "  - { from: build, to: fix-b, when: failed }",
    "  - { from: fix-a, to: merge }",
    "  - { from: fix-b, to: merge }",
    "  - { from: merge, to: build }",
  ]);

  /** `build` has failed twice in a row: the fork on its failure is held back, once, before any head. */
  function atForkLimit() {
    const before = parsePipeline(FIXERS);
    const h = host(before, (effect) =>
      effect.type === "run_command" && effect.node === "build"
        ? failed(effect, "build is red")
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    expect(h.state.active.map((v) => v.node).sort()).toEqual(["merge"]);
    must(h.send(complete("merge", 1)));
    expect(h.state.status).toBe("paused");
    expect(h.state.pauses).toEqual([
      {
        reason: "consecutive",
        node: "build",
        blocked: {
          from: "build",
          label: "failed",
          to: "fix-a",
          rework: false,
          feedback: { source: "command", reason: "build is red", from: "build" },
          heads: ["fix-a", "fix-b"],
        },
      },
    ]);
    expect(h.state.active).toEqual([]);
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1"]);
    expect(h.events().filter((e) => e === "run_paused")).toHaveLength(1);
    return { before, h };
  }

  const underF2 = (h: ReturnType<typeof host>) => {
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2"]);
    expect(h.state.pauses).toEqual([]);
    const entered = h.journal.filter((r) => r.event === "node_entered" && r.fork === "f2");
    expect(entered.map((r) => [r.node, r.branch])).toEqual([
      ["fix-a", "fix-a"],
      ["fix-b", "fix-b"],
    ]);
    // both heads were worked and met at the join of the same instance
    expect(h.state.forks?.f2?.arrived).toMatchObject({ "fix-a": {}, "fix-b": {} });
    expect(h.state.forks?.f2?.joined).toBe(1);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
  };

  test("t40_fork_on_failure_at_consecutive_limit_pauses_once", () => {
    const { h } = atForkLimit();
    // a resume without a node is not ambiguous: there is one pause
    must(h.send({ type: "resume" }));
    underF2(h);
  });

  test("t40_resume_of_fork_pause_enters_every_head_under_one_fork", () => {
    const { h } = atForkLimit();
    must(h.send({ type: "resume", node: "build" }));
    underF2(h);
    expect(h.state.nodes.build?.consecutiveFailures).toBe(0);
    must(h.send(complete("merge", 2)));
    // build fails a third time; with its count started over, the fork fires without a pause
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2", "f3"]);
  });

  test("t40_repair_effect_on_fork_pause_enters_every_head_under_one_fork", () => {
    const { before, h } = atForkLimit();
    const after = parsePipeline(FIXERS.replace("command: build", "command: build-fixed"));
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([{ kind: "reroute", node: "build", to: "fix-a" }]);
    h.use(after);
    must(h.send(accepted(before)));
    underF2(h);
  });

  test("t40_fork_pause_blocks_removing_any_head", () => {
    // Three heads (two would leave the join without a fork, which the validator refuses): the pause
    // stands for every head, so none of them can be removed, not only the first.
    const three = FIXERS.replace(
      "  - { slug: merge",
      "  - { slug: fix-c, kind: agent, prompt: fix c }\n  - { slug: merge",
    ).replace(
      "  - { from: fix-a, to: merge }\n",
      "  - { from: build, to: fix-c, when: failed }\n  - { from: fix-a, to: merge }\n  - { from: fix-c, to: merge }\n",
    );
    const before = parsePipeline(three);
    const h = host(before, (effect) =>
      effect.type === "run_command" && effect.node === "build"
        ? failed(effect, "build is red")
        : answer(effect),
    );
    h.hold("merge");
    h.send(START);
    must(h.send(complete("merge", 1)));
    expect(h.state.pauses.map((p) => p.blocked?.heads)).toEqual([["fix-a", "fix-b", "fix-c"]]);
    const refused = diffPipelines(before, parsePipeline(FIXERS), h.state).refused;
    expect(refused).toContain('"fix-c"');
    expect(refused).toContain("about to enter");
  });

  // ── the join held back at its attempt limit (fourth review) ───────────────

  /** Two command branches that fail, a join of one attempt that can send the run back to `plan`. */
  const LIMIT = (a: string, b: string) =>
    yaml([
      "name: limit",
      "nodes:",
      "  - { slug: plan, kind: agent, prompt: plan }",
      `  - { slug: "${a}", kind: command, command: "${a}" }`,
      `  - { slug: "${b}", kind: command, command: "${b}" }`,
      "  - slug: merge",
      "    kind: agent",
      "    prompt: merge",
      "    join: all",
      "    max_attempts: 1",
      "    max_consecutive_failures: 1",
      "    outcomes: [again]",
      "    checks: [{ kind: command, command: merge-check }]",
      "edges:",
      `  - { from: plan, to: "${a}" }`,
      `  - { from: plan, to: "${b}" }`,
      `  - { from: "${a}", to: merge }`,
      `  - { from: "${a}", to: merge, when: failed }`,
      `  - { from: "${b}", to: merge }`,
      `  - { from: "${b}", to: merge, when: failed }`,
      "  - { from: merge, to: plan, when: again }",
    ]);

  /**
   * The `limit` run after both branches failed, the join ran them again with `restart_failed` and
   * they failed again: every branch has arrived, and the join is held back at its attempt limit.
   */
  function joinAtLimit(a = "a", b = "b") {
    const text = LIMIT(a, b);
    const before = parsePipeline(text);
    const h = host(before, (effect) =>
      effect.type === "run_command" ? failed(effect, `${effect.node} is red`) : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.active).toEqual([]);
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "total",
        node: "merge",
        blocked: expect.objectContaining({ to: "merge", join: "f1" }),
      }),
    ]);
    expect(h.state.pauses[0]?.fork).toBeUndefined();
    expect(h.state.status).toBe("paused");
    expect(Object.keys(h.state.forks?.f1?.arrived ?? {}).sort()).toEqual([a, b].sort());
    return { text, before, h };
  }

  test("t40_fork_held_at_join_limit_is_open_so_its_edges_cannot_change", () => {
    const { text, before, h } = joinAtLimit();
    // branch a replaced by c: a is "removed" although the fork still names it
    const replaced = parsePipeline(LIMIT("c", "b"));
    expect(diffPipelines(before, replaced, h.state).refused).toContain(
      'the fork at "plan" is open',
    );
    expect(diffPipelines(before, replaced, h.state).refused).toContain('"merge"');
    // a branch added to the paused fork
    const added = parsePipeline(
      text
        .replace(
          "  - slug: merge\n",
          '  - { slug: "c", kind: command, command: "c" }\n  - slug: merge\n',
        )
        .replace(
          "  - { from: merge, to: plan, when: again }\n",
          '  - { from: plan, to: "c" }\n  - { from: "c", to: merge }\n  - { from: "c", to: merge, when: failed }\n  - { from: merge, to: plan, when: again }\n',
        ),
    );
    expect(diffPipelines(before, added, h.state).refused).toContain('the fork at "plan" is open');
    // a change outside the fork's shape is still taken
    const prompt = parsePipeline(text.replace("prompt: plan", "prompt: plan again"));
    expect(diffPipelines(before, prompt, h.state).refused).toBeUndefined();
    // and once the join went on and the run completed, the fork is history
    h.use(parsePipeline(text.replace("max_attempts: 1", "max_attempts: 2")));
    must(h.send({ type: "pipeline_accepted", from: "h", to: "h2", source: "file", before }));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    must(h.send(complete("merge", 2)));
    expect(h.state.status).toBe("completed");
  });

  /** `FORK` with its branch `b` (nodes `b`, `b-test`) replaced by a branch `c`. */
  const branchReplaced = (text: string) =>
    parsePipeline(
      text
        .replaceAll("b-test", "c-test")
        .replace("slug: b,", "slug: c,")
        .replace("to: b }", "to: c }")
        .replace("from: b,", "from: c,"),
    );

  /**
   * `FORK` with the join's own check failing its first attempt: `b` arrives failed, `merge` is
   * entered, the agent hands in (with `outcome`, when given), merge-check is red, and the join pauses
   * (`consecutive`) on its rework route merge -> merge: a pause with no `fork` and no `blocked.join`.
   */
  function joinPausedOnItsCheck(outcome?: string) {
    const text = FORK.replace(
      "    join: all\n",
      "    join: all\n    max_consecutive_failures: 1\n",
    );
    const before = parsePipeline(text);
    const h = host(before, (effect, state) =>
      effect.type === "run_command" && effect.node === "b-test"
        ? failed(effect, "b-test is red")
        : effect.type === "run_check" &&
            effect.node === "merge" &&
            effect.attempt === 1 &&
            state.specHash === "h"
          ? failed(effect, "merge-check is red")
          : answer(effect),
    );
    h.hold("merge", "ship");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ node: "b-test", label: "failed" });
    must(h.send(complete("merge", 1, outcome)));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "consecutive",
        node: "merge",
        blocked: expect.objectContaining({ from: "merge", to: "merge", rework: true }),
      }),
    ]);
    expect(h.state.pauses[0]?.fork).toBeUndefined();
    expect(h.state.pauses[0]?.blocked?.join).toBeUndefined();
    expect(h.state.active).toEqual([]);
    expect(h.state.status).toBe("paused");
    return { text, before, h };
  }

  test("t40_fork_whose_join_is_paused_on_its_own_check_is_open", () => {
    // The join's attempt is held back on its rework route (no `fork`, no `blocked.join` on the
    // pause): the instance is not left, a repair can judge the attempt anew and `restart_failed`
    // would enter the branches as the instance names them, so its branches cannot change now.
    const { text, before, h } = joinPausedOnItsCheck(RESTART_FAILED);
    const replaced = branchReplaced(text);
    const diff = diffPipelines(before, replaced, h.state);
    expect(diff.refused).toContain('the fork at "plan" is open');
    expect(diff.refused).toContain('"merge"');
    expect(diff.effects).toEqual([]);
    // a change that leaves the shape of the fork alone is still taken
    expect(
      diffPipelines(
        before,
        parsePipeline(text.replace("prompt: plan", "prompt: plan again")),
        h.state,
      ).refused,
    ).toBeUndefined();
    // the branch is run again and fails again; the join, entered once more, goes on to ship
    must(h.send({ type: "resume" }));
    expect(h.state.active.map((v) => [v.node, v.attempt])).toEqual([["merge", 2]]);
    must(h.send(complete("merge", 2, RESTART_FAILED)));
    expect(h.state.active.map((v) => [v.node, v.attempt])).toEqual([["merge", 3]]);
    expect(h.state.forks?.f1?.joined).toBe(2);
    must(h.send(complete("merge", 3)));
    expect(h.state.active.map((v) => v.node)).toEqual(["ship"]);
    // once the join was routed on, the instance is left and its shape is history
    const after = diffPipelines(before, replaced, h.state);
    expect(after.refused).toBeUndefined();
    expect(after.effects).toEqual([]);
    h.use(replaced);
    must(h.send(accepted(before)));
    h.release("ship");
    expect(h.state.status).toBe("completed");
  });

  test("t40_recheck_of_a_held_join_keeps_its_declared_outcome", () => {
    // The agent handed the join in with `restart_failed`, its check was red and the join paused.
    // A repair of the check is accepted (`recheck`): the same attempt is judged anew, so it ends
    // with the outcome declared for it, and the failed branch runs again; it is not "passed", and
    // the run does not go on past the join on a failed branch.
    const { text, before, h } = joinPausedOnItsCheck(RESTART_FAILED);
    expect(h.state.nodes.merge?.declared).toBe(RESTART_FAILED);
    const repaired = parsePipeline(text.replace("command: merge-check", "command: merge-check-2"));
    const diff = diffPipelines(before, repaired, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([{ kind: "recheck", node: "merge" }]);
    h.use(repaired);
    must(h.send(accepted(before)));
    const finished = h.journal.filter((r) => r.event === "node_finished" && r.node === "merge");
    expect(finished.map((r) => [r.attempt, r.outcome, r.status])).toEqual([
      [1, "failed", "failed"],
      [1, RESTART_FAILED, "passed"],
    ]);
    const entered = h.journal.filter((r) => r.event === "node_entered");
    expect(entered.filter((r) => r.node === "ship")).toEqual([]);
    expect(entered.filter((r) => r.node === "b").map((r) => [r.attempt, r.branch])).toEqual([
      [1, "b"],
      [2, "b"],
    ]);
    // b failed again and arrived; the join is entered a second time, fresh, with nothing declared
    expect(h.state.active.map((v) => [v.node, v.attempt, v.declared])).toEqual([
      ["merge", 2, undefined],
    ]);
    expect(h.state.nodes.merge?.declared).toBeUndefined();
    expect(h.state.forks?.f1?.joined).toBe(2);
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ label: "failed" });
    expect(h.state.forks?.f1?.arrived.a).toMatchObject({ label: "passed" });
  });

  test("t40_recheck_of_a_held_step_keeps_its_declared_label", () => {
    // The same for an ordinary `outcomes:` label of a step outside any fork.
    const text = yaml([
      "name: labels",
      "nodes:",
      "  - slug: plan",
      "    kind: agent",
      "    prompt: plan",
      "    outcomes: [again]",
      "    max_consecutive_failures: 1",
      "    checks: [{ kind: command, command: plan-check }]",
      "  - { slug: redo, kind: agent, prompt: redo }",
      "  - { slug: done, kind: command, command: done }",
      "edges:",
      "  - { from: plan, to: done }",
      "  - { from: plan, to: redo, when: again }",
      "  - { from: done, to: plan, when: failed }",
    ]);
    const before = parsePipeline(text);
    const h = host(before, (effect, state) =>
      effect.type === "run_check" && effect.node === "plan" && state.specHash === "h"
        ? failed(effect, "plan-check is red")
        : answer(effect),
    );
    h.hold("plan", "redo", "done");
    h.send(START);
    must(h.send(complete("plan", 1, "again")));
    expect(h.state.pauses.map((p) => [p.reason, p.node])).toEqual([["consecutive", "plan"]]);
    expect(h.state.nodes.plan?.declared).toBe("again");
    const repaired = parsePipeline(text.replace("command: plan-check", "command: plan-check-2"));
    expect(diffPipelines(before, repaired, h.state).effects).toEqual([
      { kind: "recheck", node: "plan" },
    ]);
    h.use(repaired);
    must(h.send(accepted(before)));
    expect(h.journal.filter((r) => r.event === "node_finished").at(-1)).toMatchObject({
      node: "plan",
      attempt: 1,
      outcome: "again",
      status: "passed",
    });
    expect(h.state.active.map((v) => v.node)).toEqual(["redo"]);
    expect(h.state.nodes.plan?.declared).toBeUndefined();
    // a new attempt of a step starts with nothing declared: the agent says how it ends
    const again = host(before, (effect, state) =>
      effect.type === "run_check" && effect.node === "plan" && state.specHash === "h"
        ? failed(effect, "plan-check is red")
        : answer(effect),
    );
    again.hold("plan", "redo", "done");
    again.send(START);
    must(again.send(complete("plan", 1, "again")));
    must(again.send({ type: "resume" }));
    expect(again.state.active.map((v) => [v.node, v.attempt, v.declared])).toEqual([
      ["plan", 2, undefined],
    ]);
    expect(again.state.nodes.plan?.declared).toBeUndefined();
  });

  test("t40_restart_failed_into_a_removed_branch_kills_the_branch_instead_of_throwing", () => {
    // The state still names branch a, the pipeline the run is on does not (a change accepted on a
    // state like this before the rule above). Nothing on a check path may throw: the branch dies
    // with the missing node named, and the run ends by the dead-branch rule.
    const { text, h } = joinAtLimit();
    const raised = parsePipeline(text.replace("max_attempts: 1", "max_attempts: 2"));
    h.use({
      ...raised,
      nodes: raised.nodes.filter((n) => n.slug !== "a"),
      edges: raised.edges.filter((e) => e.from !== "a" && e.to !== "a"),
    });
    must(h.send({ type: "resume" }));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    const result = h.send(complete("merge", 2, RESTART_FAILED));
    expect(result.ok).toBe(true);
    expect(h.state.status).toBe("failed");
    const settled = h.journal.filter((r) => r.event === "branch_settled" && r.branch === "a");
    expect(settled.at(-1)).toMatchObject({ dead: true, source: "pipeline" });
    expect(String(settled.at(-1)?.reason)).toContain('node "a" is no longer in the pipeline');
    const finished = h.journal.find((r) => r.event === "run_finished");
    expect(String(finished?.reason)).toContain('branch "a" failed at "merge" (pipeline)');
    expect(String(finished?.reason)).toContain('node "a" is no longer in the pipeline');
    // the branch that still exists ran once more before the run ended
    expect(h.state.nodes.b?.attempt).toBe(3);
    expect(text).toContain('slug: "a"');
  });

  test("t40_last_arrival_is_by_arrival_order_not_by_key_order", () => {
    // Integer-like keys come first in an object, also after the state went through JSON: the
    // branch that arrived last is found by the order of the arrivals, not of the record's keys.
    const { h } = joinAtLimit("zz", "1");
    const arrived = h.state.forks?.f1?.arrived ?? {};
    expect(Object.keys(arrived)).toEqual(["1", "zz"]);
    expect(h.state.pauses[0]?.blocked).toMatchObject({ from: "1", label: "failed", to: "merge" });
    expect(standingOf(h.state)).toContain("pause:merge:total:1>merge");
    // the feedbacks of the join stay in branch order
    expect(h.state.nodes.merge?.lastFailures?.map((f) => f.from)).toEqual(["zz", "1"]);
  });

  test("t40_change_that_leaves_the_join_at_its_limit_offers_no_reroute", () => {
    const { text, before, h } = joinAtLimit();
    const pausedBefore = h.events().filter((e) => e === "run_paused").length;
    // the join's prompt changes, its limit does not: taking the route again would pause at once
    const prompt = parsePipeline(text.replace("prompt: merge", "prompt: merge again"));
    const diff = diffPipelines(before, prompt, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.nodes).toEqual([{ slug: "merge", changes: ["work"] }]);
    expect(diff.effects).toEqual([]);
    h.use(prompt);
    must(h.send(accepted(before)));
    expect(h.state.pauses.map((p) => [p.reason, p.node])).toEqual([["total", "merge"]]);
    expect(h.state.status).toBe("paused");
    expect(h.events().filter((e) => e === "run_paused")).toHaveLength(pausedBefore);
    expect(h.state.active).toEqual([]);
    // the limit raised: the route into the join is taken, and the join is entered once
    const raised = parsePipeline(
      text
        .replace("prompt: merge", "prompt: merge again")
        .replace("max_attempts: 1", "max_attempts: 2"),
    );
    const lifted = diffPipelines(prompt, raised, h.state);
    expect(lifted.effects).toEqual([{ kind: "reroute", node: "b", to: "merge" }]);
    h.use(raised);
    must(
      h.send({ type: "pipeline_accepted", from: "h2", to: "h3", source: "file", before: prompt }),
    );
    expect(h.state.pauses).toEqual([]);
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(h.state.nodes.merge?.attempt).toBe(2);
    expect(h.events().filter((e) => e === "run_paused")).toHaveLength(pausedBefore);
  });

  test("t40_end_clears_pauses", () => {
    const { before, h } = joinAtLimit();
    expect(h.state.pauses).toHaveLength(1);
    must(h.send({ type: "cancel" }));
    expect(h.state.status).toBe("canceled");
    expect(h.state.pauses).toEqual([]);
    expect(h.state.active).toEqual([]);
    expect(nextStep(before, h.state, 0)).toEqual({ done: true, run_status: "canceled" });
    expect(refusal(h.send({ type: "resume" })).code).toBe("NODE_NOT_RUNNING");
    expect(refusal(h.send({ type: "resume", node: "merge" })).code).toBe("NODE_NOT_RUNNING");
  });
});

// ── sixth review ────────────────────────────────────────────────────────────

describe("t40 suspended work in a fork", () => {
  const SUSPEND = parsePipeline(
    yaml([
      "name: suspend",
      "nodes:",
      "  - { slug: plan, kind: agent, prompt: plan }",
      "  - { slug: a, kind: command, command: a }",
      "  - { slug: b, kind: command, command: b }",
      "  - { slug: m, kind: agent, prompt: m, join: all }",
      "edges:",
      "  - { from: plan, to: a }",
      "  - { from: plan, to: b }",
      "  - { from: a, to: m }",
      "  - { from: a, to: m, when: failed }",
      "  - { from: b, to: m }",
      "  - { from: b, to: m, when: failed }",
    ]),
  );
  const finished = (node: string, attempt = 1): RunEvent => ({
    type: "work_finished",
    node,
    attempt,
    passed: true,
    reason: "",
  });

  function suspendedA() {
    const h = host(SUSPEND, answer, { staleMs: 100, maxRestarts: 0 });
    h.hold("a", "b", "m");
    h.send(START);
    h.send(complete("plan", 1));
    h.advance(150);
    h.send({ type: "heartbeat", node: "b", attempt: 1 });
    h.send({ type: "tick" });
    expect(h.state.pauses.map((p) => [p.reason, p.node])).toEqual([["restarts", "a"]]);
    expect(h.state.active.find((v) => v.node === "a")?.suspended).toBe(true);
    expect(h.state.status).toBe("running");
    return h;
  }

  test("t40_late_result_of_suspended_visit_is_a_repeat", () => {
    const h = suspendedA();
    const late = must(h.send(finished("a")));
    expect(late.noop).toBe(true);
    expect(h.state.active.find((v) => v.node === "a")?.suspended).toBe(true);
    // a heartbeat of the work given up on is a repeat too: it must not look alive
    expect(must(h.send({ type: "heartbeat", node: "a", attempt: 1 })).noop).toBe(true);
    must(h.send(finished("b")));
    expect(h.state.forks?.f1?.arrived.b).toBeDefined();
    expect(h.state.forks?.f1?.arrived.a).toBeUndefined();
    expect(h.state.status).toBe("paused");
    // resume issues the work again, and the run goes on to its end
    h.send({ type: "resume" });
    expect(h.effects.at(-1)).toMatchObject({ type: "run_command", node: "a", restart: true });
    must(h.send(finished("a")));
    expect(h.state.active.map((v) => v.node)).toEqual(["m"]);
    must(h.send(complete("m", 1)));
    expect(h.state.status).toBe("completed");
    expect(h.state.finishedAt).toBeDefined();
  });

  test("t40_run_with_nothing_left_ends_instead_of_staying_paused", () => {
    // A state written by the engine before the fix: a's late result was taken, its `restarts` pause
    // stayed with no visit behind it, and the join finished. The next event ends the run.
    const h = suspendedA();
    must(h.send(finished("b")));
    const stranded = JSON.parse(JSON.stringify(h.state)) as RunState;
    stranded.active = [];
    stranded.status = "paused";
    stranded.nodes.a = { ...(stranded.nodes.a as RunState["nodes"][string]), status: "passed" };
    const forkState = stranded.forks?.f1;
    if (forkState) forkState.arrived.a = { node: "a", label: "passed" };
    const result = must(decide(SUSPEND, stranded, { type: "resume" }, 500));
    expect(result.state.status).toBe("completed");
    expect(result.state.pauses).toEqual([]);
    expect(result.state.finishedAt).toBe(500);
  });

  test("t40_run_with_an_unarrived_branch_and_nothing_left_ends_failed", () => {
    const h = suspendedA();
    const stranded = JSON.parse(JSON.stringify(h.state)) as RunState;
    stranded.active = [];
    stranded.pauses = [];
    const result = must(decide(SUSPEND, stranded, { type: "tick" }, 500));
    expect(result.state.status).toBe("failed");
    expect(result.journal.at(-1)?.reason).toContain('branch "a"');
  });
});

describe("t40 reroute names its pause", () => {
  const TWO = yaml([
    "name: two",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a, max_attempts: 1, max_consecutive_failures: 1 }",
    "  - { slug: b, kind: command, command: b, max_attempts: 1, max_consecutive_failures: 1 }",
    "  - { slug: m, kind: agent, prompt: m, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: m }",
    "  - { from: a, to: m, when: failed }",
    "  - { from: b, to: m }",
    "  - { from: b, to: m, when: failed }",
  ]);

  test("t40_reroute_lifts_the_pause_the_diff_judged", () => {
    const before = parsePipeline(TWO);
    const h = host(before, (effect, state) =>
      effect.type === "run_command" && (effect.node === "a" || effect.node === "b")
        ? state.nodes[effect.node]?.attempt === 1
          ? fails(effect.node)(effect)
          : answer(effect)
        : answer(effect),
    );
    h.hold("m");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("m", 1, RESTART_FAILED)));
    expect(h.state.pauses.map((p) => [p.node, p.reason, p.blocked?.from])).toEqual([
      ["a", "total", "m"],
      ["b", "total", "m"],
    ]);
    const pausedBefore = h.events().filter((e) => e === "run_paused").length;
    const after = parsePipeline(
      TWO.replace("command: b, max_attempts: 1", "command: b, max_attempts: 2"),
    );
    const diff = diffPipelines(before, after, h.state);
    expect(diff.refused).toBeUndefined();
    expect(diff.effects).toEqual([{ kind: "reroute", node: "m", to: "b", branch: "b" }]);
    expect(describeEffects(diff.effects)).toEqual([
      'branch "b" goes on from step "m", where it was held back on its way to step "b", under the new pipeline',
    ]);
    h.use(after);
    must(h.send({ type: "pipeline_accepted", from: "h", to: "h2", source: "file", before }));
    // b ran once more and arrived; a stays held back, and nothing paused again
    expect(h.state.nodes.b?.attempt).toBe(2);
    expect(h.state.nodes.a?.attempt).toBe(1);
    expect(h.state.pauses.map((p) => [p.node, p.reason])).toEqual([["a", "total"]]);
    expect(h.events().filter((e) => e === "run_paused")).toHaveLength(pausedBefore);
    expect(h.state.forks?.f1?.arrived.b).toMatchObject({ label: "passed" });
  });
});

describe("t40 a passed join is not an open fork", () => {
  const LOOP = yaml([
    "name: loop",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a, kind: command, command: a }",
    "  - { slug: b, kind: command, command: b }",
    "  - { slug: m, kind: agent, prompt: m, join: all }",
    "  - { slug: ship, kind: command, command: ship, max_attempts: 1, max_consecutive_failures: 1 }",
    "  - { slug: x, kind: command, command: x }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: m }",
    "  - { from: a, to: m, when: failed }",
    "  - { from: b, to: m }",
    "  - { from: b, to: m, when: failed }",
    "  - { from: m, to: ship }",
    "  - { from: ship, to: x }",
    "  - { from: ship, to: x, when: failed }",
    "  - { from: x, to: plan, when: failed }",
  ]);

  test("t40_join_that_passed_and_is_held_at_the_next_limit_does_not_hold_the_fork_open", () => {
    const before = parsePipeline(LOOP);
    const h = host(before, (effect) =>
      effect.type === "run_command" && effect.node === "x" ? fails("x")(effect) : answer(effect),
    );
    h.send(START);
    expect(h.state.pauses.map((p) => [p.reason, p.node, p.blocked?.from])).toEqual([
      ["total", "ship", "m"],
    ]);
    expect(h.state.nodes.m?.status).toBe("passed");
    expect(Object.keys(h.state.forks ?? {})).toEqual(["f1", "f2"]);
    const third = parsePipeline(
      LOOP.replace(
        "  - { slug: x, kind: command, command: x }\n",
        "  - { slug: x, kind: command, command: x }\n  - { slug: c, kind: command, command: c }\n",
      ).replace(
        "  - { from: m, to: ship }\n",
        "  - { from: plan, to: c }\n  - { from: c, to: m }\n  - { from: c, to: m, when: failed }\n  - { from: m, to: ship }\n",
      ),
    );
    // the join passed and the run is held back after it: the fork is left, its shape may change
    // (a join held back on its own failure route is `t40_fork_whose_join_is_paused_on_its_own_check_is_open`)
    const diff = diffPipelines(before, third, h.state);
    expect(diff.refused).toBeUndefined();
  });
});

describe("t40 a restarted join keeps its branches' failures", () => {
  test("t40_restart_of_join_keeps_the_failed_branches_list", () => {
    const h = host(fork, fails("b-test", "b is red"));
    h.hold("merge");
    h.send(START);
    h.send(complete("plan", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    const fresh = nextStep(fork, h.state, 0);
    expect("node" in fresh && fresh.node.reentry_feedback).toContain("Branches of the fork failed");
    const after = parsePipeline(FORK.replace("prompt: merge", "prompt: merge again"));
    const diff = diffPipelines(fork, after, h.state);
    expect(diff.effects).toEqual([{ kind: "restart", node: "merge" }]);
    h.use(after);
    must(h.send({ type: "pipeline_accepted", from: "h", to: "h2", source: "file", before: fork }));
    const restarted = nextStep(after, h.state, 0);
    if (!("node" in restarted)) throw new Error("expected the join's step");
    expect(restarted.node).toMatchObject({ slug: "merge", attempt: 2 });
    expect(restarted.node.reentry_feedback).toContain("The pipeline was changed under this run");
    expect(restarted.node.reentry_feedback).toContain("Branches of the fork failed");
    expect(restarted.node.reentry_feedback).toContain("b is red");
  });
});

// ── the place of a step in an open fork; where a run starts (seventh review) ──

describe("t40 seventh review", () => {
  /** a1 -> a2 in branch a1, b1 alone in branch b1, z after the join (and back to the fork). */
  const MOVE = (edges: string[]) =>
    yaml([
      "name: move",
      "nodes:",
      "  - { slug: f, kind: agent, prompt: f }",
      "  - { slug: a1, kind: agent, prompt: a1 }",
      "  - { slug: a2, kind: agent, prompt: a2 }",
      "  - { slug: b1, kind: agent, prompt: b1 }",
      "  - { slug: j, kind: agent, prompt: j, join: all }",
      "  - { slug: z, kind: agent, prompt: z, outcomes: [again] }",
      "edges:",
      "  - { from: f, to: a1 }",
      "  - { from: f, to: b1 }",
      "  - { from: z, to: f, when: again }",
      ...edges,
    ]);
  const moveBefore = parsePipeline(
    MOVE([
      "  - { from: a1, to: a2 }",
      "  - { from: a2, to: j }",
      "  - { from: b1, to: j }",
      "  - { from: j, to: z }",
    ]),
  );
  /** a2 moved from branch a1 to the end of branch b1. */
  const moveToB = parsePipeline(
    MOVE([
      "  - { from: a1, to: j }",
      "  - { from: b1, to: a2 }",
      "  - { from: a2, to: j }",
      "  - { from: j, to: z }",
    ]),
  );
  /** a2 moved past the join. */
  const movePast = parsePipeline(
    MOVE([
      "  - { from: a1, to: j }",
      "  - { from: b1, to: j }",
      "  - { from: j, to: a2 }",
      "  - { from: a2, to: z }",
    ]),
  );
  const accept = (before: PipelineSpec): RunEvent => ({
    type: "pipeline_accepted",
    from: "h",
    to: "h2",
    source: "file",
    before,
  });

  test("t40_change_cannot_move_a_standing_step_to_another_branch", () => {
    const h = host(moveBefore);
    h.hold("a1", "a2", "b1", "j", "z");
    h.send(START);
    h.send(complete("f", 1));
    h.send(complete("a1", 1));
    expect(h.state.active.map((v) => [v.node, v.fork?.branch])).toEqual([
      ["b1", "b1"],
      ["a2", "a1"],
    ]);
    for (const [after, place] of [
      [moveToB, 'put it in its branch "b1"'],
      [movePast, "put it outside its branches"],
    ] as const) {
      const refused = diffPipelines(moveBefore, after, h.state).refused;
      expect(refused).toContain('node "a2"');
      expect(refused).toContain('in its branch "a1"');
      expect(refused).toContain(place);
      h.use(after);
      expect(refusal(h.send(accept(moveBefore))).code).toBe("PIPELINE_CHANGE_REFUSED");
      h.use(moveBefore);
    }
    // the run goes on as it was, and once the fork is left the same change is taken
    h.send(complete("b1", 1));
    h.send(complete("a2", 1));
    h.send(complete("j", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["z"]);
    expect(diffPipelines(moveBefore, moveToB, h.state).refused).toBeUndefined();
    h.use(moveToB);
    must(h.send(accept(moveBefore)));
    must(h.send(complete("z", 1)));
    expect(h.state.status).toBe("completed");
  });

  test("t40_change_may_move_a_step_the_open_fork_has_not_reached", () => {
    const h = host(moveBefore);
    h.hold("a1", "a2", "b1", "j", "z");
    h.send(START);
    h.send(complete("f", 1));
    // a2 has not been entered: moving it is taken, and the branches run on the new shape
    h.use(moveToB);
    must(h.send(accept(moveBefore)));
    h.send(complete("a1", 1));
    h.send(complete("b1", 1));
    expect(h.state.active.map((v) => [v.node, v.fork?.branch])).toEqual([["a2", "b1"]]);
    h.send(complete("a2", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["j"]);
  });

  test("t40_change_cannot_move_a_step_of_a_branch_that_may_run_again", () => {
    // Both branches fail into the join; restart_failed may run them again, so their steps keep
    // their place while the join stands.
    const text = yaml([
      "name: again",
      "nodes:",
      "  - { slug: f, kind: agent, prompt: f }",
      "  - { slug: a1, kind: command, command: a1 }",
      "  - { slug: a2, kind: command, command: a2 }",
      "  - { slug: b1, kind: command, command: b1 }",
      "  - { slug: j, kind: agent, prompt: j, join: all }",
      "edges:",
      "  - { from: f, to: a1 }",
      "  - { from: f, to: b1 }",
      "  - { from: a1, to: a2 }",
      "  - { from: a1, to: j, when: failed }",
      "  - { from: a2, to: j }",
      "  - { from: a2, to: j, when: failed }",
      "  - { from: b1, to: j }",
      "  - { from: b1, to: j, when: failed }",
    ]);
    const before = parsePipeline(text);
    const h = host(before, (effect) =>
      effect.type === "run_command" && effect.node === "a2"
        ? {
            type: "work_finished",
            node: "a2",
            attempt: effect.attempt,
            passed: false,
            reason: "red",
          }
        : answer(effect),
    );
    h.hold("j");
    h.send(START);
    h.send(complete("f", 1));
    expect(h.state.active.map((v) => v.node)).toEqual(["j"]);
    const after = parsePipeline(
      text
        .replace("  - { from: a1, to: a2 }\n", "  - { from: a1, to: j }\n")
        .replace("  - { from: b1, to: j }\n", "  - { from: b1, to: a2 }\n"),
    );
    expect(diffPipelines(before, after, h.state).refused).toContain(
      'node "a2" belongs to the open fork at "f" in its branch "a1", and the change would put it in its branch "b1"',
    );
  });

  /** A join of one attempt; branch a has two steps, a2 arriving last; every command fails but a1. */
  const LIMIT2 = yaml([
    "name: limit2",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: a1, kind: command, command: a1 }",
    "  - { slug: a2, kind: command, command: a2 }",
    "  - { slug: b, kind: command, command: b }",
    "  - slug: merge",
    "    kind: agent",
    "    prompt: merge",
    "    join: all",
    "    max_attempts: 1",
    "    max_consecutive_failures: 1",
    "edges:",
    "  - { from: plan, to: a1 }",
    "  - { from: plan, to: b }",
    "  - { from: a1, to: a2 }",
    "  - { from: a1, to: merge, when: failed }",
    "  - { from: a2, to: merge }",
    "  - { from: a2, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
  ]);

  test("t40_join_held_at_its_limit_does_not_hold_the_last_branch_node", () => {
    const before = parsePipeline(LIMIT2);
    const h = host(before, (effect) =>
      effect.type === "run_command" && effect.node !== "a1"
        ? {
            type: "work_finished",
            node: effect.node,
            attempt: effect.attempt,
            passed: false,
            reason: "red",
          }
        : answer(effect),
    );
    h.hold("plan", "merge");
    h.send(START);
    h.send(complete("plan", 1));
    must(h.send(complete("merge", 1, RESTART_FAILED)));
    expect(h.state.pauses).toEqual([
      expect.objectContaining({
        reason: "total",
        node: "merge",
        blocked: expect.objectContaining({ from: "a2", to: "merge", join: "f1" }),
      }),
    ]);
    // a2 is removed (a1 now leads to the join): the route into the join is taken as it is
    const after = parsePipeline(
      LIMIT2.replace("  - { slug: a2, kind: command, command: a2 }\n", "")
        .replace("  - { from: a1, to: a2 }\n", "  - { from: a1, to: merge }\n")
        .replace("  - { from: a2, to: merge }\n  - { from: a2, to: merge, when: failed }\n", ""),
    );
    expect(diffPipelines(before, after, h.state).refused).toBeUndefined();
    h.use(after);
    must(h.send({ type: "pipeline_accepted", from: "h", to: "h2", source: "file", before }));
    expect(h.state.pauses.map((p) => p.node)).toEqual(["merge"]);
    must(h.send({ type: "resume" }));
    expect(h.state.active.map((v) => v.node)).toEqual(["merge"]);
    must(h.send(complete("merge", 2)));
    expect(h.state.status).toBe("completed");
  });

  test("t40_entry_inside_a_branch_or_at_the_join_is_refused", () => {
    const message = "is the first node of the pipeline";
    // the entry is a branch head, the fork run again from after the join
    refused(
      yaml([
        "name: p",
        "nodes:",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: f, kind: agent, prompt: f }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: j, kind: agent, prompt: j, join: all, outcomes: [again] }",
        "  - { slug: z, kind: agent, prompt: z }",
        "edges:",
        "  - { from: f, to: a }",
        "  - { from: f, to: b }",
        "  - { from: a, to: j }",
        "  - { from: b, to: j }",
        "  - { from: j, to: f, when: again }",
        "  - { from: j, to: z }",
      ]),
      message,
      'in the branch "a"',
    );
    // the entry is the join
    refused(
      yaml([
        "name: p",
        "nodes:",
        "  - { slug: j, kind: agent, prompt: j, join: all }",
        "  - { slug: f, kind: agent, prompt: f }",
        "  - { slug: a, kind: agent, prompt: a }",
        "  - { slug: b, kind: agent, prompt: b }",
        "edges:",
        "  - { from: j, to: f }",
        "  - { from: f, to: a }",
        "  - { from: f, to: b }",
        "  - { from: a, to: j }",
        "  - { from: b, to: j }",
      ]),
      message,
      "the join of",
    );
    // the entry is the second step of a branch
    refused(
      yaml([
        "name: p",
        "nodes:",
        "  - { slug: a2, kind: agent, prompt: a2 }",
        "  - { slug: f, kind: agent, prompt: f }",
        "  - { slug: a1, kind: agent, prompt: a1 }",
        "  - { slug: b, kind: agent, prompt: b }",
        "  - { slug: j, kind: agent, prompt: j, join: all, outcomes: [again] }",
        "edges:",
        "  - { from: f, to: a1 }",
        "  - { from: f, to: b }",
        "  - { from: a1, to: a2 }",
        "  - { from: a2, to: j }",
        "  - { from: b, to: j }",
        "  - { from: j, to: f, when: again }",
      ]),
      message,
      'in the branch "a1"',
    );
    // the fork node first, or a step before it: valid
    const body = [
      "  - { slug: a, kind: agent, prompt: a }",
      "  - { slug: b, kind: agent, prompt: b }",
      "  - { slug: j, kind: agent, prompt: j, join: all }",
      "edges:",
      "  - { from: f, to: a }",
      "  - { from: f, to: b }",
      "  - { from: a, to: j }",
      "  - { from: b, to: j }",
    ];
    expect(
      problems(yaml(["name: p", "nodes:", "  - { slug: f, kind: agent, prompt: f }", ...body])),
    ).toEqual([]);
    expect(
      problems(
        yaml([
          "name: p",
          "nodes:",
          "  - { slug: p, kind: agent, prompt: p }",
          "  - { slug: f, kind: agent, prompt: f }",
          ...body,
          "  - { from: p, to: f }",
        ]),
      ),
    ).toEqual([]);
  });
});

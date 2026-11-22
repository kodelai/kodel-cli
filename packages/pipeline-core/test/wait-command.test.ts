/**
 * The command that watches a run, as an answer names it (T-45): `kodel wait <run>` unless the host
 * gives its own (a background agent in a terminal is told the very command its launcher built). Every
 * text that names the command takes the given one: the waiting answers, the note beside a waiting
 * decision, the two fork instructions and the server's instructions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_WAIT_COMMAND,
  decide,
  type Effect,
  type NextStepOptions,
  nextStep,
  type PipelineSpec,
  parsePipeline,
  type RunEvent,
  type RunState,
  spellWaitCommand,
} from "../src";
import { serverInstructions } from "../src/mcp";

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const feature = parsePipeline(
  readFileSync(new URL("../../../examples/pipelines/feature.yaml", import.meta.url), "utf8"),
);

/** A fork with a gate on one branch and agent steps on two: a `node` answer beside a waiting decision. */
const MIXED = parsePipeline(
  yaml([
    "name: mixed",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: gate, kind: human, prompt: ok? }",
    "  - { slug: a, kind: agent, prompt: do a }",
    "  - { slug: b, kind: agent, prompt: do b }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: gate }",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: gate, to: merge, when: approved }",
    "  - { from: gate, to: merge, when: rejected }",
    "  - { from: a, to: merge }",
    "  - { from: b, to: merge }",
  ]),
);

/** A fork with a gate and a command: engine work beside a waiting decision. */
const BUSY = parsePipeline(
  yaml([
    "name: busy",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    "  - { slug: gate, kind: human, prompt: ok? }",
    "  - { slug: build, kind: command, command: make }",
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: gate }",
    "  - { from: plan, to: build }",
    "  - { from: gate, to: merge, when: approved }",
    "  - { from: gate, to: merge, when: rejected }",
    "  - { from: build, to: merge }",
    "  - { from: build, to: merge, when: failed }",
  ]),
);

const RUN = "r_0mw53d7fj_o2lc";
const START: RunEvent = { type: "start", runId: RUN, task: "t", specHash: "h" };

function play(spec: PipelineSpec, events: RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const [i, event] of events.entries()) {
    const result = decide(spec, state, event, i * 1000);
    if (!result.ok) throw result.error;
    state = result.state;
  }
  return state as RunState;
}

/** Drive `spec` with `answer`; an effect it returns nothing for stays pending. */
function drive(
  spec: PipelineSpec,
  answer: (effect: Effect) => RunEvent | undefined,
  more: RunEvent[] = [],
): RunState {
  let state: RunState | undefined;
  const send = (first: RunEvent) => {
    const queue = [first];
    while (queue.length > 0) {
      const result = decide(spec, state, queue.shift() as RunEvent, 5_000);
      if (!result.ok) throw result.error;
      state = result.state;
      for (const effect of result.effects) {
        const next = answer(effect);
        if (next) queue.push(next);
      }
    }
  };
  send(START);
  for (const event of more) send(event);
  return state as RunState;
}

/** Every agent step and check passes; the command `build` fails, which pauses the run. */
const auto = (effect: Effect): RunEvent | undefined => {
  if (effect.type === "need_agent")
    return { type: "agent_completed", node: effect.node, attempt: effect.attempt };
  if (effect.type === "run_command") {
    const failed = effect.node === "build";
    return {
      type: "work_finished",
      node: effect.node,
      attempt: effect.attempt,
      passed: !failed,
      reason: failed ? "exit code 1" : "",
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

const planned: RunEvent[] = [START, { type: "agent_completed", node: "plan", attempt: 1 }];

const change = {
  changes: [{ slug: "plan", changes: ["work"] }],
  redo: [],
  apply: `kodel pipeline changes apply ${RUN}`,
  blocking: true,
} as unknown as NonNullable<NextStepOptions["pending"]>;

const atGate = drive(feature, auto);
const paused = drive(feature, auto, [
  { type: "human_decided", node: "plan-approval", decision: "approved" },
]);

/** Every kind of answer whose text names the command, with the options that make it. */
const ANSWERS: [string, PipelineSpec, RunState, NextStepOptions][] = [
  ["a gate", feature, atGate, {}],
  ["a pause", feature, paused, {}],
  ["a change of the pipeline behind a gate", feature, atGate, { pending: change }],
  ["steps beside a gate, one by one", MIXED, play(MIXED, planned), {}],
  [
    "steps beside a gate, in parallel",
    MIXED,
    play(MIXED, planned),
    { agents: { mode: "parallel", maxParallel: 8 } },
  ],
  ["a fork worker's step", MIXED, play(MIXED, planned), { worker: true, nodeSlug: "a" }],
  ["a fork worker at a gate", feature, atGate, { worker: true }],
  ["engine work beside a gate", BUSY, play(BUSY, planned), {}],
];

// Nothing in it reads `kodel wait`, so a bare one left in an answer is seen.
const TEMPLATE =
  "env 'KODEL_STATE_DIR=/home/u/my state' /usr/bin/node /opt/k/dist/kodel.js --root '/work/my proj' wait {run} --timeout 604800";
const COMMAND = TEMPLATE.replace("{run}", RUN);

const answer = (
  [, spec, state, options]: (typeof ANSWERS)[number],
  more: NextStepOptions = {},
): string => JSON.stringify(nextStep(spec, state, 5_000, undefined, { ...options, ...more }));

describe("t45 the wait command in the answers", () => {
  test("t45_no_answer_of_a_worker_spells_a_bare_wait", () => {
    let named = 0;
    for (const row of ANSWERS) {
      const label = row[0];
      const usual = answer(row);
      const given = answer(row, { waitCommand: TEMPLATE });
      // Word for word the usual answer, with the given command wherever the usual one names its own.
      const expected = usual
        .replaceAll(`\`kodel wait ${RUN}\``, `\`${COMMAND}\``)
        .replaceAll("`kodel wait`", `\`${COMMAND}\``);
      expect(given, label).toBe(expected);
      expect(given, label).not.toContain("kodel wait");
      if (usual.includes("kodel wait")) {
        named++;
        expect(given, label).toContain(COMMAND);
      }
      // Offered whatever the project's hint says: an agent that stays alive has no other way to go on.
      expect(answer(row, { waitHint: false, waitCommand: TEMPLATE }), label).toBe(given);
    }
    expect(named).toBeGreaterThanOrEqual(6);
    for (const [state, reason] of [
      [atGate, "gate"],
      [paused, "paused"],
    ] as const) {
      expect(nextStep(feature, state, 5_000)).toMatchObject({ waiting: { reason } });
    }
    // The table reaches every text that names the command: the waiting answer, the note beside a
    // waiting decision, and the two fork instructions.
    const sites = ANSWERS.map((row) => answer(row, { waitCommand: "W {run}" })).join("\n");
    for (const phrase of [
      `start \`W ${RUN}\` that way and end your turn`,
      `start \`W ${RUN}\` in the background and end your turn`,
      `do not start \`W ${RUN}\``,
      `never starts \`W ${RUN}\``,
    ]) {
      expect(sites).toContain(phrase);
    }
  });

  test("t45_instructions_spell_the_given_wait_command", () => {
    const usual = serverInstructions();
    const given = serverInstructions({ waitCommand: TEMPLATE });
    const spelled = TEMPLATE.replace("{run}", "<run_id>");
    expect(given).toBe(
      usual
        .replaceAll("`kodel wait <run_id>`", `\`${spelled}\``)
        .replaceAll("`kodel wait`", `\`${spelled}\``),
    );
    expect(given).not.toContain("kodel wait");
    expect(given.split(spelled).length - 1).toBe(2);
    expect(serverInstructions({ waitCommand: TEMPLATE, waitHint: false })).toBe(given);
    // without one, the two settings are as they were
    expect(usual).toContain("`kodel wait <run_id>`");
    expect(serverInstructions({ waitHint: false })).not.toContain("kodel wait");
  });

  test("t45_default_wait_command_is_kodel_wait", () => {
    expect(DEFAULT_WAIT_COMMAND).toBe("kodel wait {run}");
    expect(spellWaitCommand(DEFAULT_WAIT_COMMAND, RUN)).toBe(`kodel wait ${RUN}`);
    // every place of the run, and nothing read as a pattern
    expect(spellWaitCommand("a {run} b {run} $& $1", "r_1")).toBe("a r_1 b r_1 $& $1");
    const gate = nextStep(feature, atGate, 5_000);
    if (!("waiting" in gate)) throw new Error("expected a waiting answer");
    expect(gate.waiting.tell_the_person).toContain(`\`kodel wait ${RUN}\``);
  });
});

/**
 * The scripted runs of `t42_existing_runs_decide_the_same` (T-42). They use only what the engine had
 * before engine steps (`decide`, `parsePipeline`), so the same file runs against the build before the
 * change, which wrote `fixtures/golden/existing-runs/`, and against this one. Fixed clock and ids.
 *
 * The core is passed in (not imported), so the file can be copied into a checkout of the older commit.
 */

// The few functions of the core the scenarios call, typed loosely so the file compiles against any build.
export interface GoldenCore {
  decide: (...args: never[]) => unknown;
  parsePipeline: (text: string) => unknown;
}

type Step = { spec: string; event: Record<string, unknown>; now: number; v1?: true };

const START = { type: "start", runId: "r_golden", task: "fix it", specHash: "h1" };

const AGENT_CMD = [
  "name: p",
  "nodes:",
  "  - { slug: a, kind: agent, prompt: x }",
  "  - { slug: b, kind: command, command: 'false', on_fail: failed, max_consecutive_failures: 1 }",
  "  - { slug: c, kind: agent, prompt: y }",
  "edges:",
  "  - { from: a, to: b }",
  "  - { from: b, to: c }",
  "  - { from: b, to: c, when: failed }",
  "",
].join("\n");

const REWORK = [
  "name: r",
  "nodes:",
  "  - slug: a",
  "    kind: agent",
  "    prompt: x",
  "    max_consecutive_failures: 1",
  "    checks:",
  "      - { kind: command, command: 'false' }",
  "",
].join("\n");

const REWORK_FIXED = REWORK.replace("command: 'false'", "command: 'true'");

const FORKED = [
  "name: r",
  "nodes:",
  "  - { slug: a, kind: agent, prompt: x }",
  "  - { slug: b, kind: agent, prompt: x }",
  "  - { slug: c, kind: agent, prompt: x }",
  "  - { slug: j, kind: agent, prompt: x, join: all }",
  "edges:",
  "  - { from: a, to: b }",
  "  - { from: a, to: c }",
  "  - { from: b, to: j }",
  "  - { from: c, to: j }",
  "",
].join("\n");

const GATED = [
  "name: g",
  "nodes:",
  "  - { slug: a, kind: agent, prompt: x }",
  "  - { slug: b, kind: command, command: 'true' }",
  "  - { slug: h, kind: human, prompt: approve }",
  "edges:",
  "  - { from: a, to: b }",
  "  - { from: b, to: h }",
  "  - { from: b, to: a, when: failed }",
  "  - { from: h, to: a, when: rejected }",
  "",
].join("\n");

export const SCENARIOS: Record<string, Step[]> = {
  // a command fails into a consecutive pause, a person resumes, the run ends
  "consecutive-pause-resume": [
    { spec: AGENT_CMD, event: START, now: 1 },
    { spec: AGENT_CMD, event: { type: "agent_completed", node: "a", attempt: 1 }, now: 2 },
    {
      spec: AGENT_CMD,
      event: { type: "work_finished", node: "b", attempt: 1, passed: false, reason: "red" },
      now: 3,
    },
    { spec: AGENT_CMD, event: { type: "resume" }, now: 4 },
    { spec: AGENT_CMD, event: { type: "agent_completed", node: "c", attempt: 1 }, now: 5 },
  ],
  // an agent step's check fails into a consecutive pause; a person accepts a fixed check on it
  "accept-on-consecutive-pause": [
    { spec: REWORK, event: START, now: 1 },
    { spec: REWORK, event: { type: "agent_completed", node: "a", attempt: 1 }, now: 2 },
    {
      spec: REWORK,
      event: {
        type: "check_finished",
        node: "a",
        attempt: 1,
        index: 0,
        passed: false,
        reason: "no",
      },
      now: 3,
    },
    {
      spec: REWORK_FIXED,
      event: {
        type: "pipeline_accepted",
        from: "h1",
        to: "h2",
        source: "file",
        before: "@REWORK",
      },
      now: 4,
    },
  ],
  // a run of format 1 refuses a pipeline with a fork and a join, before anything is written
  "v1-refuses-a-join": [
    { spec: REWORK, event: START, now: 1, v1: true },
    {
      spec: FORKED,
      event: {
        type: "pipeline_accepted",
        from: "h1",
        to: "h3",
        source: "proposal",
        before: "@REWORK",
      },
      now: 2,
      v1: true,
    },
  ],
  // engine work goes stale, its owner dies, it is taken over and restarted; ticks with nothing to do
  ticks: [
    { spec: AGENT_CMD, event: START, now: 1 },
    { spec: AGENT_CMD, event: { type: "agent_completed", node: "a", attempt: 1 }, now: 2 },
    { spec: AGENT_CMD, event: { type: "tick" }, now: 3 },
    { spec: AGENT_CMD, event: { type: "heartbeat", node: "b", attempt: 1, owner: "o1" }, now: 4 },
    { spec: AGENT_CMD, event: { type: "tick", deadOwners: ["o1"] }, now: 5 },
    { spec: AGENT_CMD, event: { type: "tick" }, now: 100_000 },
    {
      spec: AGENT_CMD,
      event: { type: "work_finished", node: "b", attempt: 1, passed: true, reason: "" },
      now: 100_001,
    },
  ],
  // a plain run to its end: agent, command, a gate rejected once, then approved
  "plain-finish": [
    { spec: GATED, event: START, now: 1 },
    {
      spec: GATED,
      event: { type: "agent_completed", node: "a", attempt: 1, summary: "s" },
      now: 2,
    },
    {
      spec: GATED,
      event: { type: "work_finished", node: "b", attempt: 1, passed: true, reason: "" },
      now: 3,
    },
    {
      spec: GATED,
      event: { type: "human_decided", node: "h", decision: "rejected", reason: "again" },
      now: 4,
    },
    { spec: GATED, event: { type: "agent_completed", node: "a", attempt: 2 }, now: 5 },
    {
      spec: GATED,
      event: { type: "work_finished", node: "b", attempt: 2, passed: true, reason: "" },
      now: 6,
    },
    { spec: GATED, event: { type: "human_decided", node: "h", decision: "approved" }, now: 7 },
  ],
};

const TEXTS: Record<string, string> = { "@REWORK": REWORK };

/**
 * Every scenario as lines of JSON, one per decision: what the store would write (`encoded`) and the
 * effects, or the refusal. `options` are the engine options of the build under test.
 */
export function runScenarios(core: GoldenCore, options: object = {}): Record<string, string> {
  const decide = core.decide as unknown as (
    spec: unknown,
    state: unknown,
    event: unknown,
    now: number,
    options: object,
  ) => {
    ok: boolean;
    noop?: boolean;
    state?: Record<string, unknown>;
    encoded?: unknown;
    effects?: unknown;
    error?: { code: string; message: string };
  };
  const out: Record<string, string> = {};
  for (const [name, steps] of Object.entries(SCENARIOS)) {
    let state: Record<string, unknown> | undefined;
    const lines: string[] = [];
    for (const step of steps) {
      const event = { ...step.event };
      if (typeof event.before === "string")
        event.before = core.parsePipeline(TEXTS[event.before] ?? "");
      const input = step.v1 && state !== undefined ? { ...state, v: 1 } : state;
      const d = decide(core.parsePipeline(step.spec), input, event, step.now, options);
      lines.push(
        JSON.stringify(
          d.ok
            ? { ok: true, noop: d.noop === true, encoded: d.encoded ?? null, effects: d.effects }
            : { ok: false, code: d.error?.code, message: d.error?.message },
        ),
      );
      if (d.ok && d.noop !== true && d.state !== undefined) {
        state = step.v1 ? { ...d.state, v: 1 } : d.state;
      }
    }
    out[name] = `${lines.join("\n")}\n`;
  }
  return out;
}

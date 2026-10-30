/**
 * The commands a person uses on a run with a fork (T-40): several gates and pauses at once, `status`
 * showing every visit and pause, `wait` ending on any decision, and a decision waiting only for the
 * work of the node it was about.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalHost, LocalPipelineHost, type LocalRun } from "@kodel-ai/local";
import { runCli } from "../src/cli";
import { SHARED_TREE_TEXT } from "../src/decide-text";

let dir: string;

/** Two agent branches, each ending at a gate, meeting at a join. */
const GATES = [
  "name: gates",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: b-gate, kind: human, prompt: b looks fine? }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: b-gate }",
  "  - { from: b-gate, to: merge, when: approved }",
  "  - { from: b-gate, to: b, when: rejected }",
  "",
].join("\n");

/** A gate in one branch; a command that takes a while in the other. */
const GATE_AND_SLOW = [
  "name: slow",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  `  - { slug: b, kind: command, command: "node -e \\"setTimeout(() => {}, 3000)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
  "",
].join("\n");

/** A gate in one branch; in the other a command that runs until the test writes `release.flag` (a minute at most). */
const GATE_AND_LATCHED = [
  "name: latched",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  `  - { slug: b, kind: command, command: "node -e \\"setInterval(() => { if (require('fs').existsSync('release.flag')) process.exit(0) }, 20); setTimeout(() => process.exit(1), 60000)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
  "",
].join("\n");

/** A gate in one branch; in the other an agent step that leads into a command that runs until `release.flag`. */
const GATE_AND_MOVING = [
  "name: moving",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  "  - { slug: b, kind: agent, prompt: b }",
  `  - { slug: b-slow, kind: command, command: "node -e \\"setInterval(() => { if (require('fs').existsSync('release.flag')) process.exit(0) }, 20); setTimeout(() => process.exit(1), 60000)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: b-slow }",
  "  - { from: b-slow, to: merge }",
  "  - { from: b-slow, to: merge, when: failed }",
  "",
].join("\n");

/** A gate in one branch that leads into two commands in a row; in the other a command that runs until `release.flag`. */
const GATE_CHAIN_AND_SLOW = [
  "name: chain-slow",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  `  - { slug: a-build, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  `  - { slug: a-test, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  `  - { slug: b, kind: command, command: "node -e \\"setInterval(() => { if (require('fs').existsSync('release.flag')) process.exit(0) }, 20); setTimeout(() => process.exit(1), 60000)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: a-build, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: a-build, to: a-test }",
  "  - { from: a-build, to: merge, when: failed }",
  "  - { from: a-test, to: merge }",
  "  - { from: a-test, to: merge, when: failed }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
  "",
].join("\n");

/** No fork: a gate whose approval leads into two commands in a row. */
const LINEAR = [
  "name: linear",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  "  - { slug: approve, kind: human, prompt: fine? }",
  `  - { slug: build, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  `  - { slug: test, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: build, when: approved }",
  "  - { from: approve, to: write, when: rejected }",
  "  - { from: build, to: test }",
  "  - { from: build, to: write, when: failed }",
  "  - { from: test, to: write, when: failed }",
  "",
].join("\n");

/** No fork: a command that fails pauses the run; the resume leads into two commands in a row. */
const RESUME_CHAIN = [
  "name: resume-chain",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  `  - { slug: check, kind: command, command: "node -e \\"process.exit(1)\\"", max_consecutive_failures: 1 }`,
  `  - { slug: fix, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  `  - { slug: test, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  "edges:",
  "  - { from: write, to: check }",
  "  - { from: check, to: fix, when: failed }",
  "  - { from: fix, to: test }",
  "  - { from: fix, to: write, when: failed }",
  "  - { from: test, to: write, when: failed }",
  "",
].join("\n");

/** No fork: a step whose check fails pauses the run; the accepted repair leads into two commands in a row. */
const APPLY_CHAIN = [
  "name: apply-chain",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "    max_consecutive_failures: 1",
  `    checks: [{ kind: command, command: "node -e \\"process.exit(1)\\"" }]`,
  `  - { slug: build, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  `  - { slug: test, kind: command, command: "node -e \\"setTimeout(() => {}, 600)\\"" }`,
  "edges:",
  "  - { from: write, to: build }",
  "  - { from: build, to: test }",
  "  - { from: build, to: write, when: failed }",
  "  - { from: test, to: write, when: failed }",
  "",
].join("\n");

/** Two command branches that fail at once and pause their branches; an agent branch beside them. */
const PAUSES = [
  "name: pauses",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  `  - { slug: b, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
  `  - { slug: b-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  `  - { slug: c, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
  `  - { slug: c-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: plan, to: c }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: b-fix, when: failed }",
  "  - { from: b-fix, to: merge }",
  "  - { from: b-fix, to: b, when: failed }",
  "  - { from: c, to: merge }",
  "  - { from: c, to: c-fix, when: failed }",
  "  - { from: c-fix, to: merge }",
  "  - { from: c-fix, to: c, when: failed }",
  "",
].join("\n");

/** Two command branches, one failing, meeting at an agent join: a run that completes on a failure. */
const FAILED_BRANCH = [
  "name: failed-branch",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  `  - { slug: a, kind: command, command: "node -e \\"process.exit(0)\\"" }`,
  `  - { slug: b, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: merge }",
  "  - { from: a, to: merge, when: failed }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
  "",
].join("\n");

/** Two agent branches meeting at a join; the test makes branch b dead (a valid pipeline cannot). */
const DOOMED = [
  "name: doomed",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
  "",
].join("\n");

/** Two steps: the person's approval ends the run. */
const ENDS = [
  "name: ends",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  "  - { slug: approve, kind: human, prompt: fine? }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

/** A command that fails pauses the run at once; the resume takes the way on, and that ends the run. */
const RESUME_ENDS = [
  "name: resume-ends",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  `  - { slug: check, kind: command, command: "node -e \\"process.exit(1)\\"", max_consecutive_failures: 1 }`,
  `  - { slug: done, kind: command, command: "node -e \\"process.exit(0)\\"" }`,
  "edges:",
  "  - { from: write, to: check }",
  "  - { from: check, to: done, when: failed }",
  "  - { from: done, to: write, when: failed }",
  "",
].join("\n");

/** A step whose check fails pauses the run at once; a repair of the check, accepted, ends the run. */
const APPLY_ENDS = [
  "name: apply-ends",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "    max_consecutive_failures: 1",
  `    checks: [{ kind: command, command: "node -e \\"process.exit(1)\\"" }]`,
  "edges: []",
  "",
].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-fork-cli-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  for (const [name, text] of [
    ["gates", GATES],
    ["slow", GATE_AND_SLOW],
    ["latched", GATE_AND_LATCHED],
    ["moving", GATE_AND_MOVING],
    ["chain-slow", GATE_CHAIN_AND_SLOW],
    ["linear", LINEAR],
    ["resume-chain", RESUME_CHAIN],
    ["apply-chain", APPLY_CHAIN],
    ["pauses", PAUSES],
    ["failed-branch", FAILED_BRANCH],
    ["doomed", DOOMED],
    ["ends", ENDS],
    ["resume-ends", RESUME_ENDS],
    ["apply-ends", APPLY_ENDS],
  ]) {
    await writeFile(join(dir, ".kodel", "pipelines", `${name}.yaml`), text as string);
  }
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Person {
  interactive?: boolean;
  answer?: boolean;
  pollMs?: number;
  onWatching?: () => void;
  /** What happens elsewhere while the person reads a question. */
  onAsk?: (question: string) => Promise<void>;
}

/** Run a command as a person at a terminal who says yes, unless told otherwise. */
async function cliAs(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const code = await runCli(args, {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? true,
    environment: {},
    ...(person.pollMs === undefined ? {} : { pollMs: person.pollMs }),
    ...(person.onWatching === undefined ? {} : { onWatching: person.onWatching }),
    select: async () => [],
    confirm: async (question) => {
      asked.push(question);
      await person.onAsk?.(question);
      return person.answer ?? true;
    },
  });
  return { code, out, err, asked };
}
const cli = (...args: string[]) => cliAs({}, ...args);

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });

/** The `gates` pipeline at both gates, made the way an agent would. */
async function atBothGates() {
  const h = host();
  const run = (await h.start({ pipeline: "gates", task: "t", restart: false })).run as LocalRun;
  await run.completeStep("plan", 1);
  await run.completeStep("a", 1);
  await run.completeStep("b", 1);
  await run.waitForRest(5_000);
  expect((await run.state()).active.map((v) => [v.node, v.phase])).toEqual([
    ["a-gate", "human"],
    ["b-gate", "human"],
  ]);
  return { h, run };
}

/** The `pauses` pipeline with two branches paused and the agent's step open. */
async function atTwoPauses() {
  const h = host();
  const run = (await h.start({ pipeline: "pauses", task: "t", restart: false })).run as LocalRun;
  await run.completeStep("plan", 1);
  await run.waitForRest(10_000);
  const state = await run.state();
  expect(state.status).toBe("running");
  expect(state.pauses.map((p) => p.node).sort()).toEqual(["b", "c"]);
  expect(state.active.map((v) => v.node)).toEqual(["a"]);
  return { h, run };
}

describe("t40 several gates at once", () => {
  test("t40_gate_without_node_refused_when_several_wait", async () => {
    const { run } = await atBothGates();
    const refused = await cli("gate", "approve", run.runId);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("waits for a decision at 2 steps");
    expect(refused.err).toContain('"a-gate"');
    expect(refused.err).toContain('"b-gate"');
    expect(refused.err).toContain("--node <slug>");
    expect(refused.asked).toEqual([]);
    // nothing was decided
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a-gate", "b-gate"]);
    // with --node one gate is decided and the other still waits
    const decided = await cli("gate", "approve", run.runId, "--node", "b-gate");
    expect(decided.code).toBe(0);
    expect(decided.asked[0]).toContain('Approve "b-gate"');
    expect((await run.state()).active.map((v) => v.node)).toEqual(["a-gate"]);
    expect(decided.out).toContain("running at a-gate#1");
    // and a node that is not waiting is refused as before
    const wrong = await cli("gate", "approve", run.runId, "--node", "merge");
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain('not waiting for a decision at "merge"');
  });

  test("t40_how_to_decide_carries_node_when_several", async () => {
    const { run } = await atBothGates();
    const step = await run.inspect();
    if (!("waiting" in step)) throw new Error("expected a waiting answer");
    expect(step.waiting.how_to_decide.cli).toContain(`--node a-gate`);
    expect(step.waiting.also_waiting?.map((w) => w.how_to_decide.cli)).toEqual([
      expect.stringContaining("--node b-gate"),
    ]);
    expect(step.waiting.tell_the_person).toContain('gate "b-gate"');
  });

  test("t40_status_prints_every_visit_and_pause", async () => {
    const { run } = await atTwoPauses();
    const one = await cli("status", run.runId);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(
      /status: {4}running at a#1 \[a\] \(paused: consecutive at [bc]; consecutive at [bc]\)\n/,
    );
    expect(one.out).toContain("active:    a#1 [a]\n");
    expect(one.out).toContain("paused:    consecutive at b\n");
    expect(one.out).toContain("paused:    consecutive at c\n");
    // every decision a person has to make is named, with the step's own answer being the agent's
    expect(one.out).toContain("waiting:   b (paused)\n");
    expect(one.out).toContain("waiting:   c (paused)\n");
    // the list says the same in one line
    const list = await cli("status");
    expect(list.out).toMatch(
      /running at a#1 \[a\] \(paused: consecutive at [bc]; consecutive at [bc]\)/,
    );
    // and the gates of a fork show as its visits
    const gated = await atBothGates();
    const gates = await cli("status", gated.run.runId);
    expect(gates.out).toContain("status:    running at a-gate#1 [a], b-gate#1 [b]\n");
    expect(gates.out).toContain("active:    a-gate#1 [a]\n");
    expect(gates.out).toContain("active:    b-gate#1 [b]\n");
    expect(gates.out).toContain("waiting:   a-gate (gate)\n");
    expect(gates.out).toContain("waiting:   b-gate (gate)\n");
  });

  test("t40_status_shape_with_pauses_in_mcp", async () => {
    // `status --json` lists every visit and every pause of each run, with the branch of each
    const { run } = await atTwoPauses();
    const parsed = JSON.parse((await cli("status", "--json")).out) as {
      runId: string;
      status: string;
      active: { node: string; attempt: number; phase: string; branch?: string }[];
      pauses: { reason: string; node: string; branch?: string }[];
      failed_branches?: boolean;
    }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      runId: run.runId,
      status: "running",
      active: [{ node: "a", attempt: 1, phase: "agent", branch: "a" }],
    });
    expect(parsed[0]?.pauses.sort((x, y) => x.node.localeCompare(y.node))).toEqual([
      { reason: "consecutive", node: "b", branch: "b" },
      { reason: "consecutive", node: "c", branch: "c" },
    ]);
    expect(parsed[0]).not.toHaveProperty("failed_branches");
  });

  test("t40_status_flags_completed_with_failed_branches", async () => {
    const h = host();
    const run = (await h.start({ pipeline: "failed-branch", task: "t", restart: false }))
      .run as LocalRun;
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    await run.completeStep("merge", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("completed");
    const one = await cli("status", run.runId);
    expect(one.out).toContain("status:    completed with failed branches\n");
    expect(one.out).toContain(
      "branches:  a join was entered after branches of a fork had failed\n",
    );
    const list = await cli("status");
    expect(list.out).toContain("completed with failed branches");
    const json = JSON.parse((await cli("status", "--json")).out) as { failed_branches?: boolean }[];
    expect(json[0]?.failed_branches).toBe(true);
    const report = await cli("report", run.runId);
    expect(report.out).toContain("completed with failed branches");
    expect(report.out).toContain("fork f1 at plan (a, b) -> merge; failed: b");
    expect(report.out).toContain("critical path: branch");
    const parsed = JSON.parse((await cli("report", run.runId, "--json")).out) as {
      failed_branches: boolean;
      busy_wall_s: number;
      critical_path: { fork: string }[];
    };
    expect(parsed.failed_branches).toBe(true);
    expect(parsed.critical_path).toEqual([expect.objectContaining({ fork: "f1" })]);
    expect(typeof parsed.busy_wall_s).toBe("number");
  });

  test("t40_status_prints_the_note_of_a_doomed_fork", async () => {
    const h = host();
    const run = (await h.start({ pipeline: "doomed", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("plan", 1);
    await run.completeStep("b", 1);
    await run.waitForRest(10_000);
    // A branch dies only on a pipeline the validator refuses (or one changed under the run), so the
    // state is written the way the engine writes a dead arrival, and trusted the way the engine does.
    const state = await run.state();
    const fork = state.forks?.f1;
    const arrival = fork?.arrived.b;
    if (!fork || !arrival) throw new Error("expected b to have arrived");
    fork.arrived.b = {
      ...arrival,
      label: "failed",
      failure: { source: "pipeline", reason: "red", from: "b" },
      dead: true,
    };
    const inner = (run as unknown as { host: LocalHost }).host;
    const hash = await inner.store.writeState(run.runId, state, (next) =>
      inner.integrity.stage(run.runId, next),
    );
    await inner.integrity.set(run.runId, hash);
    expect((await run.state()).status).toBe("running");
    const one = await cli("status", run.runId);
    expect(one.code).toBe(0);
    expect(one.out).toContain('note:      A branch of the fork is dead (branch "b" failed at "b"');
    expect(one.out).toContain("the run ends failed when the others have settled");
    expect(one.out).toContain("waits for: a\n");
  });

  test("t40_resume_works_from_cli_with_running_sibling", async () => {
    const { run } = await atTwoPauses();
    // without --node, two pauses: refused naming them
    const refused = await cli("resume", run.runId);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("paused at 2 steps");
    expect(refused.err).toContain('"b"');
    expect(refused.err).toContain('"c"');
    expect(refused.err).toContain("--node <slug>");
    expect(refused.asked).toEqual([]);
    // with --node, that branch goes on while the agent's step stays open and the other pause stays;
    // the command waits for the branch's chain (b-fix fails, b runs once more and fails again), so
    // when it returns the branch stands paused again
    const resumed = await cli("resume", run.runId, "--node", "b");
    expect(resumed.code).toBe(0);
    expect(resumed.asked[0]).toContain("Resume run");
    expect(resumed.asked[0]).toContain('"b"');
    const state = await run.state();
    expect(state.status).toBe("running");
    expect(state.active.map((v) => v.node)).toEqual(["a"]);
    expect(state.pauses.map((p) => p.node)).toEqual(["c", "b"]);
    expect([state.nodes["b-fix"]?.attempt, state.nodes.b?.attempt]).toEqual([1, 2]);
    expect(resumed.out).toContain("paused:");
    // a node that is not paused is refused
    const wrong = await cli("resume", run.runId, "--node", "a");
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain('not paused at "a"');
  });

  test("t40_changes_apply_names_node_when_several_pauses_stay", async () => {
    // a change of the agent's prompt restarts its step; the two paused branches stay paused, and
    // the hint to carry on says which ones, with --node, as `kodel resume` without it is refused
    const { run } = await atTwoPauses();
    await writeFile(
      join(dir, ".kodel", "pipelines", "pauses.yaml"),
      PAUSES.replace("prompt: a }", "prompt: a again }"),
    );
    const applied = await cli("pipeline", "changes", "apply", run.runId);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(`kodel resume ${run.runId} --node <slug>`);
    expect(applied.out).toContain('"b"');
    expect(applied.out).toContain('"c"');
    expect(applied.out).not.toContain(`kodel resume ${run.runId}\n`);
    const state = await run.state();
    expect(state.pauses.map((p) => p.node).sort()).toEqual(["b", "c"]);
    expect(state.nodes.a?.attempt).toBe(2);
  });

  test("t40_after_decision_waits_only_for_own_node", async () => {
    const h = host();
    const run = (await h.start({ pipeline: "latched", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("plan", 1);
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    expect((await run.state()).active.map((v) => [v.node, v.phase]).sort()).toEqual([
      ["a-gate", "human"],
      ["b", "engine"],
    ]);
    // b runs until the test releases it; approving a-gate returns while b still runs
    const decided = await cli("gate", "approve", run.runId, "--node", "a-gate");
    expect(decided.code).toBe(0);
    expect(decided.out).toContain("running at b#1 [b]");
    const after = JSON.parse(JSON.stringify(await run.state())) as Awaited<
      ReturnType<typeof run.state>
    >;
    expect(after.active.map((v) => v.node)).toEqual(["b"]);
    await writeFile(join(dir, "release.flag"), "");
    await run.waitForRest(10_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });

  test("t40_gate_command_shows_the_shared_tree_note", async () => {
    // b runs while a's gate waits and a file changes: the person is told some of it may be b's
    const h = host();
    const run = (await h.start({ pipeline: "latched", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("plan", 1);
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    await writeFile(join(dir, "shared.txt"), "written while the gate waits\n");
    const decided = await cli("gate", "approve", run.runId, "--node", "a-gate");
    expect(decided.code).toBe(0);
    expect(decided.asked[0]).toContain("shared.txt");
    expect(decided.asked[0]).toContain(SHARED_TREE_TEXT);
    await writeFile(join(dir, "release.flag"), "");
    await run.waitForRest(10_000);
  });

  test("t40_gate_command_without_note_when_alone", async () => {
    const h = host();
    const run = (await h.start({ pipeline: "ends", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    await writeFile(join(dir, "mine.txt"), "the agent's own write\n");
    const decided = await cli("gate", "approve", run.runId);
    expect(decided.code).toBe(0);
    expect(decided.asked[0]).toContain("mine.txt");
    expect(decided.asked[0]).not.toContain(SHARED_TREE_TEXT);
  });

  test("t40_after_decision_ignores_a_sibling_that_moved_on_while_the_person_read", async () => {
    // While the person reads the question, the other branch hands its step in and enters a command
    // that runs until the test releases it. That node was not entered by the decision, so the
    // decision does not wait for it (if it did, the command would not return before the test's
    // timeout): the standing the decision is judged against is read right before it is made.
    const h = host();
    const run = (await h.start({ pipeline: "moving", task: "t", restart: false })).run as LocalRun;
    await run.completeStep("plan", 1);
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    expect((await run.state()).active.map((v) => [v.node, v.phase]).sort()).toEqual([
      ["a-gate", "human"],
      ["b", "agent"],
    ]);
    const decided = await cliAs(
      {
        onAsk: async () => {
          await run.completeStep("b", 1);
          expect((await run.state()).active.map((v) => v.node).sort()).toEqual([
            "a-gate",
            "b-slow",
          ]);
        },
      },
      "gate",
      "approve",
      run.runId,
      "--node",
      "a-gate",
    );
    expect(decided.code).toBe(0);
    expect(decided.asked).toHaveLength(1);
    expect(decided.out).toContain("running at b-slow#1 [b]");
    const after = JSON.parse(JSON.stringify(await run.state())) as Awaited<
      ReturnType<typeof run.state>
    >;
    expect(after.active.map((v) => [v.node, v.phase])).toEqual([["b-slow", "engine"]]);
    expect(after.nodes["a-gate"]?.status).toBe("passed");
    await writeFile(join(dir, "release.flag"), "");
    await run.waitForRest(10_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });
});

describe("t40 a decision waits for the chain it leads into", () => {
  /** The journal of a run, as records. */
  const journalOf = async (runId: string) =>
    (await readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; node?: string });
  /** The commands that finished, in order; and that none was started again by a tick. */
  const commandsFinished = async (runId: string) => {
    const journal = await journalOf(runId);
    expect(journal.filter((r) => r.event === "node_restarted")).toEqual([]);
    return journal.filter((r) => r.event === "command_finished").map((r) => r.node);
  };

  // The command exits as soon as it returns, and work it leaves running in this process is lost:
  // its result is never applied and the next tick runs it again. So it waits for the work the
  // decision led into, the whole chain of it, not only the first node the decision entered.
  test("t40_gate_waits_for_the_chain_its_decision_leads_into", async () => {
    const run = (await host().start({ pipeline: "linear", task: "t", restart: false }))
      .run as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["approve"]);
    const decided = await cli("gate", "approve", run.runId);
    expect(decided.code).toBe(0);
    expect(decided.out).toContain(`${run.runId}: completed`);
    // both commands ran and their results were applied before the command returned
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect(state.active).toEqual([]);
    expect([state.nodes.build?.status, state.nodes.test?.status]).toEqual(["passed", "passed"]);
    expect(await commandsFinished(run.runId)).toEqual(["build", "test"]);
  });

  test("t40_resume_waits_for_the_chain_it_leads_into", async () => {
    const run = (await host().start({ pipeline: "resume-chain", task: "t", restart: false }))
      .run as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    expect((await run.state()).pauses.map((p) => [p.reason, p.node])).toEqual([
      ["consecutive", "check"],
    ]);
    const resumed = await cli("resume", run.runId);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`${run.runId}: completed`);
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect([state.nodes.fix?.status, state.nodes.test?.status]).toEqual(["passed", "passed"]);
    expect(await commandsFinished(run.runId)).toEqual(["check", "fix", "test"]);
  });

  test("t40_changes_apply_waits_for_the_chain_its_effect_leads_into", async () => {
    const run = (await host().start({ pipeline: "apply-chain", task: "t", restart: false }))
      .run as LocalRun;
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    expect((await run.state()).pauses.map((p) => [p.reason, p.node])).toEqual([
      ["consecutive", "write"],
    ]);
    await writeFile(
      join(dir, ".kodel", "pipelines", "apply-chain.yaml"),
      APPLY_CHAIN.replace("process.exit(1)", "process.exit(0)"),
    );
    const applied = await cli("pipeline", "changes", "apply", run.runId);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(`${run.runId}: completed`);
    const state = await run.state();
    expect(state.status).toBe("completed");
    expect([state.nodes.build?.status, state.nodes.test?.status]).toEqual(["passed", "passed"]);
    expect(await commandsFinished(run.runId)).toEqual(["build", "test"]);
  });

  test("t40_after_decision_follows_its_own_branch_chain_not_the_sibling", async () => {
    const run = (await host().start({ pipeline: "chain-slow", task: "t", restart: false }))
      .run as LocalRun;
    await run.completeStep("plan", 1);
    await run.completeStep("a", 1);
    await run.waitForRest(5_000, "a");
    expect((await run.state()).active.map((v) => [v.node, v.phase]).sort()).toEqual([
      ["a-gate", "human"],
      ["b", "engine"],
    ]);
    // a-build and a-test are waited for (both finished when the command returns); b runs until the
    // test releases it, so a decision that waited for it would not return before the timeout
    const decided = await cli("gate", "approve", run.runId, "--node", "a-gate");
    expect(decided.code).toBe(0);
    expect(decided.out).toContain("running at b#1 [b]");
    const state = await run.state();
    expect(state.forks?.f1?.arrived.a).toMatchObject({ node: "a-test", label: "passed" });
    expect(state.active.map((v) => [v.node, v.phase])).toEqual([["b", "engine"]]);
    expect(await commandsFinished(run.runId)).toEqual(["a-build", "a-test"]);
    await writeFile(join(dir, "release.flag"), "");
    await run.waitForRest(10_000);
    expect((await run.state()).active.map((v) => v.node)).toEqual(["merge"]);
  });
});

describe("t40 a decision that ends the run", () => {
  /** Whether the patch of the whole run and its journal note are there, right now. */
  async function recorded(runId: string) {
    const of = join(dir, ".kodel", "runs", runId);
    return {
      patch: existsSync(join(of, "changes", "run.patch")),
      journal: (await readFile(join(of, "journal.jsonl"), "utf8")).includes(
        '"event":"changes_recorded"',
      ),
    };
  }

  /** A run of `pipeline` after the agent wrote a file and handed its step in. */
  async function afterWrite(pipeline: string) {
    const run = (await host().start({ pipeline, task: "t", restart: false })).run as LocalRun;
    await writeFile(join(dir, "made.txt"), "by the agent\n");
    await run.completeStep("write", 1);
    await run.waitForRest(10_000);
    return run;
  }

  // The command returns only when the patch of the run is recorded: a `kodel gate` that ends the run
  // exits right after, and the job must not be lost with the process.
  test("t40_gate_that_ends_the_run_waits_for_its_patch", async () => {
    const run = await afterWrite("ends");
    expect((await run.state()).active.map((v) => v.node)).toEqual(["approve"]);
    const decided = await cli("gate", "approve", run.runId);
    expect(decided.code).toBe(0);
    expect(decided.out).toContain("completed");
    expect(await recorded(run.runId)).toEqual({ patch: true, journal: true });
  });

  test("t40_resume_that_ends_the_run_waits_for_its_patch", async () => {
    const run = await afterWrite("resume-ends");
    expect((await run.state()).pauses.map((p) => [p.reason, p.node])).toEqual([
      ["consecutive", "check"],
    ]);
    const resumed = await cli("resume", run.runId);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("completed");
    expect(await recorded(run.runId)).toEqual({ patch: true, journal: true });
  });

  test("t40_changes_apply_that_ends_the_run_waits_for_its_patch", async () => {
    const run = await afterWrite("apply-ends");
    expect((await run.state()).pauses.map((p) => [p.reason, p.node])).toEqual([
      ["consecutive", "write"],
    ]);
    await writeFile(
      join(dir, ".kodel", "pipelines", "apply-ends.yaml"),
      APPLY_ENDS.replace("process.exit(1)", "process.exit(0)"),
    );
    const applied = await cli("pipeline", "changes", "apply", run.runId);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("completed");
    expect(await recorded(run.runId)).toEqual({ patch: true, journal: true });
  });
});

describe("t40 wait on a run with a fork", () => {
  test("t40_wait_ends_on_any_decision", async () => {
    const { run } = await atBothGates();
    const decide = () => run.decideHuman("b-gate", "approved");
    const result = await cliAs(
      {
        pollMs: 20,
        onWatching: () => {
          void decide();
        },
      },
      "wait",
      run.runId,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('approved at "b-gate"');
    expect(result.out).toContain("Call pipeline_next_step");
  });

  test("t40_wait_second_gate_decided_ends_wait", async () => {
    // the answer is about a-gate; a decision at b-gate (named in also_waiting) ends the wait too
    const { run } = await atBothGates();
    const step = await run.inspect();
    expect("waiting" in step && step.waiting.node_slug).toBe("a-gate");
    const result = await cliAs(
      {
        pollMs: 20,
        onWatching: () => {
          void run.decideHuman("b-gate", "rejected", "not yet");
        },
      },
      "wait",
      run.runId,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('rejected at "b-gate"');
    // the rejected branch is the agent's step again, and the other gate still waits beside it
    const after = await run.inspect();
    expect("node" in after && after.node.slug).toBe("b");
    expect("node" in after && after.node.also_waiting?.map((w) => w.node_slug)).toEqual(["a-gate"]);
    expect(result.out).toContain("Call pipeline_next_step");
  });

  test("t40_wait_treats_also_waiting_as_waiting", async () => {
    // the run's answer is the agent's step; the pauses of the other branches are what a person
    // decides, so `wait` watches, and a resume of one of them ends it
    const { run } = await atTwoPauses();
    const step = await run.inspect();
    expect("node" in step).toBe(true);
    const result = await cliAs(
      {
        pollMs: 20,
        onWatching: () => {
          void run.resume("c");
        },
      },
      "wait",
      run.runId,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("resumed");
    // with nothing waiting it says so and returns at once
    const h = host();
    const plain = await h.start({ pipeline: "gates", task: "another", restart: false });
    const none = await cliAs({ pollMs: 20 }, "wait", plain.run.runId);
    expect(none.out).toContain("not waiting for a person");
    // and a timeout names the first decision it watched
    const again = await atBothGates();
    const gaveUp = await cliAs({ pollMs: 20 }, "wait", again.run.runId, "--timeout", "1");
    expect(gaveUp.code).toBe(2);
    expect(gaveUp.out).toContain('still waiting at "a-gate" (gate)');
  });
});

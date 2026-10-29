/**
 * The dialog on a run with a fork (T-40): it opens only on an answer that waits for the person (a
 * `node` answer that names a sibling's gate in `also_waiting` is the agent's to pass on), it is never
 * held for a worker, it keeps the caller's arguments, it resumes the branch it asked about, and while a
 * sibling branch is active a changed tree is not a reason to drop the person's decision.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/mcp-server";

let dir: string;

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

/** Two agent branches, each ending at a gate. */
const FORK_GATES = yaml([
  "name: forkgates",
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
]);

/** Two agent branches. */
const FORK_STEPS = yaml([
  "name: forksteps",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: do a }",
  "  - { slug: b, kind: agent, prompt: do b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: merge }",
  "  - { from: b, to: merge }",
]);

/** A gate in one branch, a command that takes a while in the other. */
const SLOW = yaml([
  "name: slow",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  `  - { slug: b, kind: command, command: "node -e \\"setTimeout(() => {}, 2500)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: merge, when: failed }",
]);

/** Two command branches that fail at once and pause: nothing can move, the run is paused. */
const PAUSES = yaml([
  "name: pauses",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  `  - { slug: b, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
  `  - { slug: b-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  `  - { slug: c, kind: command, command: "node -e \\"process.exit(1)\\"", max_attempts: 1, max_consecutive_failures: 1 }`,
  `  - { slug: c-fix, kind: command, command: "node -e \\"process.exit(1)\\"" }`,
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: b }",
  "  - { from: plan, to: c }",
  "  - { from: b, to: merge }",
  "  - { from: b, to: b-fix, when: failed }",
  "  - { from: b-fix, to: merge }",
  "  - { from: b-fix, to: b, when: failed }",
  "  - { from: c, to: merge }",
  "  - { from: c, to: c-fix, when: failed }",
  "  - { from: c-fix, to: merge }",
  "  - { from: c-fix, to: c, when: failed }",
]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-elicit-fork-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  for (const [name, text] of [
    ["forkgates", FORK_GATES],
    ["forksteps", FORK_STEPS],
    ["slow", SLOW],
    ["pauses", PAUSES],
  ]) {
    await writeFile(join(dir, ".kodel", "pipelines", `${name}.yaml`), text as string);
  }
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Form = { message: string; requestedSchema: { properties: Record<string, unknown> } };
type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** `reply` is what the person does in the dialog; undefined means the client cannot show one. */
async function connect(
  reply?: (form: Form, n: number) => Reply | Promise<Reply>,
  options: { gate?: boolean } = {},
) {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
  const server = createServer(host, "0.0.0", undefined, undefined, {
    humans: host,
    dialog: true,
    ...(options.gate ? { agentDecisions: { gate: true } } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "agent", version: "0.0.0" },
    { capabilities: reply ? { elicitation: {} } : {} },
  );
  const forms: Form[] = [];
  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const form = request.params as unknown as Form;
      forms.push(form);
      return reply(form, forms.length);
    });
  }
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as { text: string }[])[0] as { text: string }).text;
    let body: ReturnType<typeof JSON.parse>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${name} answered something that is not JSON: ${text}`);
    }
    return { body, isError: result.isError === true };
  };
  return { host, client, call, forms, close: () => Promise.all([client.close(), server.close()]) };
}

type Session = Awaited<ReturnType<typeof connect>>;

const approve: Reply = { action: "accept", content: { decision: "approve" } };
const complete = (s: Session, runId: string, node: string, extra: Record<string, unknown> = {}) =>
  s.call("pipeline_complete_step", { run_id: runId, node_slug: node, attempt: 1, ...extra });

async function start(s: Session, pipeline: string): Promise<string> {
  const started = await s.call("pipeline_start", { task: "split the work", pipeline });
  return started.body.run_id as string;
}

const journalOf = (runId: string) =>
  readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");

describe("t40 the dialog on a run with a fork", () => {
  test("t40_gate_dialog_only_on_waiting_answers", async () => {
    const s = await connect(() => approve);
    const runId = await start(s, "forkgates");
    await complete(s, runId, "plan");
    // a's gate is reached while b is still open: the completion answers a summary, the next step is
    // b's with the gate in `also_waiting`; neither is a `waiting` answer, so no dialog opens
    const handed = await complete(s, runId, "a");
    expect(handed.body.next.running?.open_steps ?? handed.body.next.node).toBeDefined();
    expect(handed.body.dialog).toBeUndefined();
    const next = await s.call("pipeline_next_step", { run_id: runId });
    expect(next.body.node.slug).toBe("b");
    expect(next.body.node.also_waiting).toEqual([
      expect.objectContaining({ reason: "gate", node_slug: "a-gate" }),
    ]);
    expect(next.body.dialog).toBeUndefined();
    expect(s.forms).toHaveLength(0);
    // once nothing is left for the agent, the answer waits and the dialog opens for its gate; the
    // other gate, the next thing that waits, is asked in the same call (the chain of questions)
    const done = await complete(s, runId, "b");
    expect(s.forms).toHaveLength(2);
    expect(s.forms[0]?.message).toContain('"a-gate"');
    expect(s.forms[1]?.message).toContain('"b-gate"');
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    expect(done.body.next.node.slug).toBe("merge");
    await s.close();
  });

  test("t40_dialog_never_holds_a_worker", async () => {
    const s = await connect(() => approve);
    const runId = await start(s, "forkgates");
    await complete(s, runId, "plan");
    // two workers take and complete the branches with their tokens: no dialog is held for either
    const tokens: Record<string, string> = {};
    for (const node of ["a", "b"]) {
      const took = await s.call("pipeline_take_step", { run_id: runId, node_slug: node });
      expect(took.body.status).toBe("claimed");
      tokens[node] = took.body.claim_token;
    }
    for (const node of ["a", "b"]) {
      const done = await complete(s, runId, node, { claim_token: tokens[node] });
      expect(done.body.dialog).toBeUndefined();
      // the answer sends the worker back to the agent that started it, never to the person
      expect(JSON.stringify(done.body.next)).toMatch(/[Rr]eport (this answer|back)/);
      expect(JSON.stringify(done.body.next)).not.toContain("Write to the person");
    }
    expect(s.forms).toHaveLength(0);
    // the agent that started them meets the dialog: one gate, then the other in the same call
    const next = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(2);
    expect(next.body.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });

  test("t40_change_dialog_on_node_answers_still_works", async () => {
    const s = await connect(() => ({ action: "accept", content: { decision: "apply" } }));
    const runId = await start(s, "forksteps");
    await complete(s, runId, "plan");
    const proposed = await s.call("pipeline_propose_change", {
      run_id: runId,
      pipeline: FORK_STEPS.replace("prompt: merge,", "prompt: merge with care,"),
      summary: "merge with care",
    });
    expect(proposed.body.ok).toBe(true);
    // the step answer carries the change: the dialog opens on it and the person accepts
    const next = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(next.body.dialog).toMatchObject({ answer: "decided" });
    expect(await journalOf(runId)).toContain('"event":"pipeline_accepted"');
    await s.close();
  });

  test("t40_dialog_keeps_node_slug", async () => {
    const s = await connect(() => ({ action: "accept", content: { decision: "apply" } }));
    const runId = await start(s, "forksteps");
    await complete(s, runId, "plan");
    await s.call("pipeline_propose_change", {
      run_id: runId,
      pipeline: FORK_STEPS.replace("prompt: merge,", "prompt: merge with care,"),
      summary: "merge with care",
    });
    // asked about b, the answer after the dialog is still about b, with the declaration kept
    const next = await s.call("pipeline_next_step", {
      run_id: runId,
      node_slug: "b",
      subagents: { can: true },
    });
    expect(s.forms).toHaveLength(1);
    expect(next.body.dialog).toMatchObject({ answer: "decided" });
    expect(next.body.node.slug).toBe("b");
    expect(next.body.node.pipeline_change).toBeUndefined();
    await s.close();
  });

  test("t40_dialog_skips_changed_files_refusal_when_other_branches_active", async () => {
    // while the dialog is open a sibling branch writes to the tree; the decision stands all the same
    const s = await connect(async () => {
      await writeFile(join(dir, "sibling.txt"), "written by the other branch\n");
      return approve;
    });
    const runId = await start(s, "slow");
    await complete(s, runId, "plan");
    // the completion of a leaves this caller nothing but a's gate: the dialog opens on it
    const next = await complete(s, runId, "a");
    expect(s.forms).toHaveLength(1);
    expect(next.body.dialog).toMatchObject({ answer: "decided" });
    expect(await journalOf(runId)).toContain('"event":"gate_decided","node":"a-gate"');
    expect(next.body.dialog.what).toContain("a-gate");
    // the command of the other branch was still going when the person answered
    expect(
      (await s.host.open(runId).then((r) => r?.state()))?.active.some((v) => v.node === "b"),
    ).toBe(true);
    await (await s.host.open(runId))?.waitForRest(10_000);
    await s.close();
  });

  test("t40_paused_dialog_resumes_chosen_node", async () => {
    const s = await connect((form) => {
      // the question is about one branch and says so, naming the other
      expect(form.message).toContain("paused (consecutive at ");
      expect(form.message).toContain("branch");
      expect(form.message).toContain("It is also paused at");
      return { action: "accept", content: { confirm: true } };
    });
    const runId = await start(s, "pauses");
    await complete(s, runId, "plan");
    const run = await s.host.open(runId);
    await run?.waitForRest(10_000);
    expect((await run?.state())?.status).toBe("paused");
    const paused = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(paused.body.dialog).toMatchObject({ answer: "decided", what: "resumed the run" });
    // one branch was resumed (the one the question named), the other is still paused
    const asked = /paused \(consecutive at ([bc])\)/.exec(s.forms[0]?.message ?? "")?.[1];
    expect(asked).toBeDefined();
    const state = await run?.state();
    expect(state?.pauses.map((p) => p.node)).toEqual([asked === "b" ? "c" : "b"]);
    expect(await journalOf(runId)).toContain('"event":"run_resumed"');
    await run?.waitForRest(10_000);
    await s.close();
  });

  test("t40_decide_gate_answers_dialog_open_for_sibling", async () => {
    // the person has the dialog of a-gate open; the agent's decision about b-gate is answered
    // `dialog_open` and decides nothing
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = await connect(
      async () => {
        await held;
        return approve;
      },
      { gate: true },
    );
    const runId = await start(s, "forkgates");
    await complete(s, runId, "plan");
    await complete(s, runId, "a");
    // completing b leaves both gates: the answer waits, and the dialog of a-gate is held open
    const opened = complete(s, runId, "b");
    while (s.forms.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const refused = await s.call("pipeline_decide_gate", {
      run_id: runId,
      node_slug: "b-gate",
      attempt: 1,
      decision: "approved",
      instruction: "approve b",
    });
    expect(refused.body.waiting).toMatchObject({ reason: "dialog_open" });
    expect(await journalOf(runId)).not.toContain('"event":"gate_decided"');
    release?.();
    const answered = await opened;
    expect(answered.body.dialog).toMatchObject({ answer: "decided" });
    expect(await journalOf(runId)).toContain('"event":"gate_decided","node":"a-gate"');
    await s.close();
  });

  test("t40_mcp_answer_with_steps_validates", async () => {
    const s = await connect();
    const runId = await start(s, "forksteps");
    await complete(s, runId, "plan");
    // the answer over MCP carries every open step, and the mode follows the declaration
    const sequential = await s.call("pipeline_next_step", { run_id: runId });
    expect(sequential.body.node.steps.map((step: { slug: string }) => step.slug)).toEqual([
      "a",
      "b",
    ]);
    expect(sequential.body.node.execution.mode).toBe("sequential");
    const parallel = await s.call("pipeline_next_step", {
      run_id: runId,
      subagents: { can: true, max_depth: 1 },
    });
    expect(parallel.body.node.execution.mode).toBe("parallel");
    for (const step of parallel.body.node.steps as Record<string, unknown>[]) {
      expect(typeof step.slug).toBe("string");
      expect(typeof step.attempt).toBe("number");
      expect(typeof step.prompt).toBe("string");
    }
    // with every step taken the answer is `running` with the open steps and their marks
    for (const node of ["a", "b"]) {
      await s.call("pipeline_take_step", { run_id: runId, node_slug: node });
    }
    const taken = await s.call("pipeline_next_step", { run_id: runId });
    expect(taken.body.running.open_steps.map((o: { node_slug: string }) => o.node_slug)).toEqual([
      "a",
      "b",
    ]);
    expect(taken.body.running.open_steps.every((o: { taken_by?: string }) => o.taken_by)).toBe(
      true,
    );
    await s.close();
  });
});

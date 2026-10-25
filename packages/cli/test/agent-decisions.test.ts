import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { summarizeRun } from "@kodel-ai/pipeline-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HumanHost } from "../src/elicit";
import { createServer } from "../src/mcp-server";

let dir: string;

const DEMO = (prompt: string) =>
  [
    "name: demo",
    "description: A small pipeline for the tests.",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    `    prompt: ${prompt} for {{task}}`,
    "    checks:",
    '      - { kind: diff, paths: ["out.txt"] }',
    "  - slug: approve",
    "    kind: human",
    "    prompt: Looks fine?",
    "  - slug: build",
    "    kind: command",
    `    command: node -e "console.log('built')"`,
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: build }",
    "  - { from: approve, to: write, when: rejected }",
    "  - { from: build, to: write, when: failed }",
    "",
  ].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-decisions-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("write a file"));
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Options {
  dialog?: boolean;
  gate?: boolean;
  pipelineChange?: boolean;
  /** Makes the host's view of the files "unavailable", as when git fails. */
  unverified?: boolean;
  reply?: () => Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }>;
  /** Passed instead of the options above when a test wants no host that can decide. */
  withoutHumans?: boolean;
}

async function connect(options: Options = {}) {
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    agentDecisions: {
      gate: options.gate ?? false,
      pipelineChange: options.pipelineChange ?? false,
    },
  });
  const humans: HumanHost = options.unverified
    ? {
        open: async (runId) => {
          const run = await host.open(runId);
          if (!run) return undefined;
          return Object.assign(Object.create(run), {
            changesSinceGate: async () => ({ kind: "unavailable", reason: "git failed" }),
          });
        },
      }
    : host;
  const server = createServer(host, "0.0.0", undefined, undefined, {
    ...(options.withoutHumans ? {} : { humans }),
    dialog: options.dialog ?? false,
    agentDecisions: {
      gate: options.gate ?? false,
      pipelineChange: options.pipelineChange ?? false,
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "agent", version: "0.0.0" },
    { capabilities: options.reply ? { elicitation: {} } : {} },
  );
  let forms = 0;
  if (options.reply) {
    const reply = options.reply;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      forms++;
      return reply();
    });
  }
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return {
    host,
    client,
    call,
    tools,
    forms: () => forms,
    instructions: () => client.getInstructions() ?? "",
    close: () => Promise.all([client.close(), server.close()]),
  };
}
type Session = Awaited<ReturnType<typeof connect>>;

const journalOf = (runId: string) =>
  readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");

async function toGate(s: Session) {
  const started = await s.call("pipeline_start", { task: "add a file" });
  const runId = started.run_id as string;
  await writeFile(join(dir, "out.txt"), "hello\n");
  const done = await s.call("pipeline_complete_step", {
    run_id: runId,
    node_slug: "write",
    attempt: 1,
  });
  return { runId, done };
}

const decide = (runId: string, extra: Record<string, unknown> = {}) => ({
  run_id: runId,
  node_slug: "approve",
  attempt: 1,
  decision: "approved",
  instruction: "yes, approve it",
  ...extra,
});

describe("t_decisions: what the agent may decide follows the config", () => {
  test("t_decisions_tools_exist_only_when_their_flag_is_on", async () => {
    const names = async (options: Options) => {
      const s = await connect(options);
      const list = await s.tools();
      await s.close();
      return list.filter((n) => n === "pipeline_decide_gate" || n === "pipeline_accept_change");
    };
    expect(await names({})).toEqual([]);
    expect(await names({ gate: true })).toEqual(["pipeline_decide_gate"]);
    expect(await names({ pipelineChange: true })).toEqual(["pipeline_accept_change"]);
    expect(await names({ gate: true, pipelineChange: true })).toEqual([
      "pipeline_decide_gate",
      "pipeline_accept_change",
    ]);
    // A server whose host cannot decide serves no such tool, whatever the flags are.
    expect(await names({ gate: true, pipelineChange: true, withoutHumans: true })).toEqual([]);
  });

  test("t_decisions_no_flag_can_give_the_agent_ack_resume_or_seal", async () => {
    const s = await connect({ gate: true, pipelineChange: true, dialog: true });
    const list = await s.tools();
    for (const word of ["ack", "resume", "seal"]) {
      expect(list.filter((n) => n.split("_").includes(word))).toEqual([]);
    }
    await s.close();
  });

  test("t_decisions_instructions_follow_the_config", async () => {
    const off = await connect();
    expect(off.instructions()).toContain("You cannot approve, reject or resume anything yourself");
    expect(off.instructions()).not.toContain("pipeline_decide_gate");
    expect(off.instructions()).not.toContain("pipeline_accept_change");
    await off.close();

    const on = await connect({ gate: true });
    const text = on.instructions();
    expect(text).toContain("pipeline_decide_gate");
    expect(text).not.toContain("pipeline_accept_change");
    expect(text).toContain("only when the person tells you to in this chat");
    expect(text).toContain("Unless rule 10 applies");
    await on.close();

    // The dialog rule is number 10 when it is there, so this one is 11.
    const both = await connect({ gate: true, pipelineChange: true, dialog: true });
    expect(both.instructions()).toContain("11. This project lets you decide");
    expect(both.instructions()).toContain("pipeline_accept_change");
    await both.close();
  });

  test("t_decisions_waiting_text_mentions_the_tool_only_when_its_flag_is_on", async () => {
    const off = await connect();
    const a = await toGate(off);
    expect(JSON.stringify(a.done)).not.toContain("pipeline_decide_gate");
    await off.close();
    await rm(join(dir, ".kodel", "runs"), { recursive: true, force: true });
    await rm(join(dir, "out.txt"), { force: true });

    const on = await connect({ gate: true });
    const b = await toGate(on);
    expect(b.done.next.waiting.tell_the_person).toContain("pipeline_decide_gate");
    expect(b.done.next.waiting.tell_the_person).toContain("Never on your own");
    expect(b.done.next.waiting.how_to_decide.cli).toContain("kodel gate");
    await on.close();
  });
});

describe("t_decisions: the agent decides a gate on the person's instruction", () => {
  test("t_decisions_agent_gate_approves_and_the_journal_says_the_agent_did", async () => {
    const s = await connect({ gate: true });
    const { runId } = await toGate(s);
    const done = await s.call("pipeline_decide_gate", decide(runId));

    expect(done).toMatchObject({ ok: true, decided_by: "agent", decision: "approved" });
    expect(await journalOf(runId)).toContain('"decided_by":"agent"');
    expect(await journalOf(runId)).toContain("yes, approve it");
    const state = await (await s.host.open(runId))?.state();
    expect(state?.nodes["approve"]?.status).toBe("passed");
    await s.close();
  });

  test("t_decisions_a_person_decision_has_no_decided_by_mark", async () => {
    const s = await connect({ gate: true });
    const { runId } = await toGate(s);
    await (await s.host.open(runId))?.decideHuman("approve", "approved");
    const journal = await journalOf(runId);
    expect(journal).toContain("gate_decided");
    expect(journal).not.toContain("decided_by");
    await s.close();
  });

  test("t_decisions_agent_rejection_needs_a_reason", async () => {
    const s = await connect({ gate: true });
    const { runId } = await toGate(s);
    const refused = await s.call("pipeline_decide_gate", decide(runId, { decision: "rejected" }));
    expect(refused).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    const done = await s.call(
      "pipeline_decide_gate",
      decide(runId, { decision: "rejected", reason: "not what I asked" }),
    );
    expect(done).toMatchObject({ ok: true, decision: "rejected" });
    expect(await journalOf(runId)).toContain("not what I asked");
    await s.close();
  });

  test("t_decisions_agent_gate_refuses_a_wrong_node_a_wrong_attempt_and_a_missing_instruction", async () => {
    const s = await connect({ gate: true });
    const { runId } = await toGate(s);
    expect(
      await s.call("pipeline_decide_gate", decide(runId, { node_slug: "write" })),
    ).toMatchObject({ ok: false, code: "NODE_NOT_RUNNING" });
    expect(await s.call("pipeline_decide_gate", decide(runId, { attempt: 7 }))).toMatchObject({
      ok: false,
      code: "ATTEMPT_MISMATCH",
    });
    // The schema refuses an empty instruction before the tool runs.
    const empty = await s.client.callTool({
      name: "pipeline_decide_gate",
      arguments: decide(runId, { instruction: "" }),
    });
    expect(empty.isError).toBe(true);
    const state = await (await s.host.open(runId))?.state();
    expect(state?.active.some((v) => v.node === "approve" && v.phase === "human")).toBe(true);
    await s.close();
  });

  test("t_decisions_agent_approval_needs_the_box_when_the_files_could_not_be_checked", async () => {
    const s = await connect({ gate: true, unverified: true });
    const { runId } = await toGate(s);
    const refused = await s.call("pipeline_decide_gate", decide(runId));
    expect(refused).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(refused.message).toContain("confirm_unverified");
    const done = await s.call("pipeline_decide_gate", decide(runId, { confirm_unverified: true }));
    expect(done).toMatchObject({ ok: true, decided_by: "agent" });
    await s.close();
  });

  test("t_decisions_agent_gate_waits_while_a_dialog_is_open", async () => {
    let answer: (() => void) | undefined;
    const open = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const s = await connect({
      gate: true,
      dialog: true,
      reply: async () => {
        await open;
        return { action: "decline" };
      },
    });
    const started = await s.call("pipeline_start", { task: "add a file" });
    const runId = started.run_id as string;
    await writeFile(join(dir, "out.txt"), "hello\n");
    // The call that meets the gate stays open until the person answers the form.
    const pending = s.call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
    });
    const until = Date.now() + 5000;
    while (s.forms() === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(s.forms()).toBe(1);

    const meanwhile = await s.call("pipeline_decide_gate", decide(runId));
    expect(meanwhile.waiting.reason).toBe("dialog_open");
    expect(await journalOf(runId)).not.toContain("gate_decided");

    answer?.();
    await pending;
    await s.close();
  });
});

describe("t_decisions: the agent accepts a change of the pipeline on the person's instruction", () => {
  async function toChange(s: Session) {
    const started = await s.call("pipeline_start", { task: "add a file" });
    const runId = started.run_id as string;
    await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("write a different file"));
    const step = await s.call("pipeline_next_step", { run_id: runId });
    return { runId, change: step.node.pipeline_change as { hash: string } };
  }

  test("t_decisions_agent_accept_change_needs_the_hash_of_the_change_that_waits", async () => {
    const s = await connect({ pipelineChange: true });
    const { runId, change } = await toChange(s);
    expect(change.hash).toMatch(/\S/);

    const wrong = await s.call("pipeline_accept_change", {
      run_id: runId,
      change_hash: "not-the-hash",
      instruction: "yes, take it",
    });
    expect(wrong).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(await journalOf(runId)).not.toContain("pipeline_accepted");

    const done = await s.call("pipeline_accept_change", {
      run_id: runId,
      change_hash: change.hash,
      instruction: "yes, take it",
    });
    expect(done).toMatchObject({ ok: true, decided_by: "agent", accepted: change.hash });
    const journal = await journalOf(runId);
    expect(journal).toContain("pipeline_accepted");
    expect(journal).toContain('"decided_by":"agent"');
    await s.close();
  });

  test("t_decisions_agent_accept_change_refuses_when_nothing_waits", async () => {
    const s = await connect({ pipelineChange: true });
    const started = await s.call("pipeline_start", { task: "add a file" });
    const refused = await s.call("pipeline_accept_change", {
      run_id: started.run_id,
      change_hash: "anything",
      instruction: "yes",
    });
    expect(refused).toMatchObject({ ok: false, code: "PIPELINE_CHANGE_REFUSED" });
    await s.close();
  });

  test("t_decisions_the_waiting_text_for_a_change_names_the_tool_only_with_its_flag", async () => {
    const off = await connect({ gate: true });
    const { runId } = await toChange(off);
    await writeFile(join(dir, "out.txt"), "hello\n");
    const waiting = await off.call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
    });
    expect(waiting.next?.waiting?.reason ?? waiting.waiting?.reason).toBe("pipeline_changed");
    expect(JSON.stringify(waiting)).not.toContain("pipeline_accept_change");
    await off.close();
  });
});

describe("t_decisions: what the agent says it was told is redacted and shown", () => {
  test("t_decisions_a_secret_in_the_instruction_never_reaches_the_journal", async () => {
    const s = await connect({ gate: true });
    const { runId } = await toGate(s);
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
    const done = await s.call(
      "pipeline_decide_gate",
      decide(runId, { instruction: `approve it, my key is ${secret}` }),
    );
    expect(done.ok).toBe(true);
    const journal = await journalOf(runId);
    expect(journal).not.toContain(secret);
    expect(journal).toContain("[REDACTED:api-key]");
    expect(journal).toContain('"decided_by":"agent"');
    await s.close();
  });

  test("t_decisions_the_report_marks_a_change_the_agent_accepted", async () => {
    const s = await connect({ pipelineChange: true });
    const started = await s.call("pipeline_start", { task: "add a file" });
    const runId = started.run_id as string;
    await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("write another file"));
    const step = await s.call("pipeline_next_step", { run_id: runId });
    await s.call("pipeline_accept_change", {
      run_id: runId,
      change_hash: step.node.pipeline_change.hash,
      instruction: "yes",
    });
    const run = await s.host.open(runId);
    const report = summarizeRun(await run!.state(), await run!.journal());
    expect(report.pipeline_changes.map((c) => c.by)).toEqual(["agent"]);
    await s.close();
  });

  test("t_decisions_a_person_accepting_a_change_leaves_no_agent_mark", async () => {
    const s = await connect({ pipelineChange: true });
    const started = await s.call("pipeline_start", { task: "add a file" });
    const runId = started.run_id as string;
    await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("write another file"));
    const run = await s.host.open(runId);
    const found = await run?.pendingChange();
    await run?.acceptChange({ source: found?.info.source ?? "file", text: found?.text ?? "" });
    const report = summarizeRun(await run!.state(), await run!.journal());
    expect(report.pipeline_changes).toHaveLength(1);
    expect(report.pipeline_changes[0]?.by).toBeUndefined();
    expect(await journalOf(runId)).not.toContain("decided_by");
    await s.close();
  });
});

describe("t_decisions: the dialog is off unless the config turns it on", () => {
  test("t_decisions_dialog_off_means_no_form_is_sent_and_the_answer_waits", async () => {
    const s = await connect({
      reply: async () => ({ action: "accept", content: { decision: "approve" } }),
    });
    const { runId, done } = await toGate(s);
    expect(s.forms()).toBe(0);
    expect(done.next.waiting.reason).toBe("gate");
    expect(s.instructions()).not.toContain("dialog");
    const state = await (await s.host.open(runId))?.state();
    expect(state?.active.some((v) => v.node === "approve" && v.phase === "human")).toBe(true);
    await s.close();
  });

  test("t_decisions_dialog_on_sends_the_form", async () => {
    const s = await connect({
      dialog: true,
      reply: async () => ({ action: "accept", content: { decision: "approve" } }),
    });
    const { done } = await toGate(s);
    expect(s.forms()).toBe(1);
    expect(done.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });
});

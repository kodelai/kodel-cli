/**
 * Run attachments where a person decides (T-45): `kodel gate`, the dialog and `pipeline_decide_gate`
 * list them, and an approval is refused when a version was written after the look.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, type LocalRun } from "@kodel-ai/local";
import { ATTACHMENT_LIMITS, type AttachmentInfo, NOT_SCANNED } from "@kodel-ai/pipeline-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ATTACHMENTS_MOVED,
  attachmentLine,
  formatBytes,
  gateAttachmentsText,
} from "../src/decide-text";
import { commitGateDecision, DecisionRefused, prepareGateDecision } from "../src/gate-decision";
import { createServer } from "../src/mcp-server";

let tmp: string;
let dir: string;

const yaml = (lines: string[]) => `${lines.join("\n")}\n`;

const SINGLE = yaml([
  "name: single",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write }",
  "  - { slug: approve, kind: human, prompt: fine? }",
  "  - { slug: build, kind: agent, prompt: build }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: build, when: approved }",
  "  - { from: approve, to: write, when: rejected }",
]);

/** A gate in one branch while the agent step of the other is still open. */
const FORK = yaml([
  "name: fork",
  "nodes:",
  "  - { slug: plan, kind: agent, prompt: plan }",
  "  - { slug: a, kind: agent, prompt: a }",
  "  - { slug: a-gate, kind: human, prompt: a looks fine? }",
  "  - { slug: b, kind: agent, prompt: b }",
  "  - { slug: merge, kind: agent, prompt: merge, join: all }",
  "edges:",
  "  - { from: plan, to: a }",
  "  - { from: plan, to: b }",
  "  - { from: a, to: a-gate }",
  "  - { from: a-gate, to: merge, when: approved }",
  "  - { from: a-gate, to: a, when: rejected }",
  "  - { from: b, to: merge }",
]);

async function project(git: boolean): Promise<void> {
  if (git) {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
    run("commit", "-q", "--allow-empty", "-m", "initial");
  }
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "single.yaml"), SINGLE);
  await writeFile(join(dir, ".kodel", "pipelines", "fork.yaml"), FORK);
  await writeFile(
    join(dir, ".kodel", "config.yaml"),
    `worktree:\n  mode: off\n${git ? "" : "history:\n  changes:\n    enabled: false\n"}`,
  );
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-attachment-gate-")));
  dir = join(tmp, "repo");
  await mkdir(dir);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const newHost = () =>
  new LocalPipelineHost({ root: dir, heartbeatMs: 0, integrityDir: join(tmp, "integrity") });

async function startRun(host: LocalPipelineHost, pipeline: string): Promise<LocalRun> {
  const { run } = await host.start({ pipeline, task: "t", restart: false });
  return (await host.open(run.runId)) as LocalRun;
}

const text = (run: LocalRun, node: string, name: string, content: string) =>
  run.writeAttachment({ node, attempt: 1, name, content });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** The fork with `a` handed in: `a-gate` waits while the step `b` is still open. */
async function forkAtGate(git = true): Promise<{ host: LocalPipelineHost; run: LocalRun }> {
  await project(git);
  const host = newHost();
  const run = await startRun(host, "fork");
  await run.completeStep("plan", 1);
  await run.settle();
  await text(run, "a", "plan.md", "the plan of a\n");
  await run.completeStep("a", 1);
  await run.settle();
  return { host, run };
}

async function refused(work: Promise<unknown>): Promise<DecisionRefused> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DecisionRefused) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const approve = (run: LocalRun) =>
  prepareGateDecision(run, { decision: "approve", node: "a-gate" });

/** Whether a text holds a control character or the character that reverses the reading order. */
const hasControl = (value: string) =>
  [...value].some((char) => (char.codePointAt(0) ?? 0) < 0x20 || char === "\u202e");

describe("t45 what a person is shown", () => {
  test("t45_gate_text_lists_attachments", async () => {
    await project(true);
    const host = newHost();
    const run = await startRun(host, "single");
    await text(run, "write", "plan.md", "one\ntwo\n");
    await writeFile(join(dir, "shot.png"), PNG);
    await run.writeAttachment({ node: "write", attempt: 1, name: "shot.png", path: "shot.png" });
    await rm(join(dir, "shot.png"));
    await run.completeStep("write", 1);
    await run.settle();
    const prepared = await prepareGateDecision(run, { decision: "approve" });
    const [question] = prepared.questions;
    expect(question).toContain("2 attachment(s) kept with the run (not project files):");
    expect(question).toContain("  plan.md  text, 2 line(s), 8 B, v1, by write");
    expect(question).toContain(`  shot.png  png, ${PNG.length} B, v1, by write, ${NOT_SCANNED}`);
    expect(question).toContain(`kodel attachment show ${run.runId} <name>`);
    // written before the run stopped here: nothing is new
    expect(question).not.toContain("new since");
    expect(prepared.attachments?.fingerprint).toBe(await run.attachmentsFingerprint());
    // the question about the decision is still the last line
    expect(question?.split("\n").at(-1)).toBe(`Approve "approve" of run ${run.runId}?`);
    await host.stop();
  });

  test("t45_gate_and_dialog_text_are_plain", async () => {
    // What is listed came from an agent (or from a journal line it wrote): every part goes through
    // `plain`, so a name or a step cannot move the cursor or fake a line.
    const info: AttachmentInfo = {
      name: "plan\u001b[2K\n.md",
      version: 3,
      type: "text",
      bytes: 2048,
      lines: 4,
      sha256: "a".repeat(64),
      node: "wri\u202ete",
      attempt: 1,
      at: 0,
      seq: 9,
      scanned: true,
      state: "changed",
    };
    const line = attachmentLine(info, true);
    expect(hasControl(line)).toBe(false);
    expect(line).toContain("THE STORED FILE WAS CHANGED OUTSIDE KODEL");
    expect(line).toContain("new since the run stopped here");
    expect(line).toContain("2.0 KB");
    const block = gateAttachmentsText(
      { list: [info], fingerprint: "x", newSince: [] },
      "r_\u001bx",
    );
    expect(block?.split("\n")).toHaveLength(3);
    expect(hasControl((block ?? "").replaceAll("\n", ""))).toBe(false);
    expect(gateAttachmentsText({ list: [], fingerprint: undefined, newSince: [] })).toBeUndefined();
    expect(gateAttachmentsText(undefined)).toBeUndefined();
    expect(formatBytes(ATTACHMENT_LIMITS.imageBytes)).toBe("2.0 MB");

    // the dialog shows the same group
    await project(true);
    const host = newHost();
    const server = createServer(host, "0.0.0", undefined, undefined, {
      humans: host,
      dialog: true,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "agent", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    const forms: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      forms.push((request.params as { message: string }).message);
      return { action: "decline" };
    });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    };
    const started = await call("pipeline_start", { task: "t", pipeline: "single" });
    await call("pipeline_attachment_write", {
      run_id: started.run_id,
      node_slug: "write",
      attempt: 1,
      name: "plan.md",
      content: "one\n",
    });
    await call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "write",
      attempt: 1,
    });
    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain("1 attachment(s) kept with the run (not project files):");
    expect(forms[0]).toContain("plan.md  text, 1 line(s), 4 B, v1, by write");
    await Promise.all([client.close(), server.close()]);
    await host.stop();
  });
});

describe("t45 a version written after the look", () => {
  test("t45_write_after_the_look_refuses_approval", async () => {
    const { host, run } = await forkAtGate();
    const prepared = await approve(run);
    expect(prepared.questions[0]).toContain("plan.md");
    // the sibling branch writes while the person reads
    await text(run, "b", "notes.md", "from b\n");
    const error = await refused(commitGateDecision(run, prepared, undefined));
    expect(error.message).toBe(ATTACHMENTS_MOVED);
    expect((await run.state()).active.some((v) => v.node === "a-gate")).toBe(true);
    // looked at again, the new one is marked, and the approval goes through
    const again = await approve(run);
    expect(again.questions[0]).toContain("notes.md");
    expect(again.questions[0]).toMatch(/notes\.md .*new since the run stopped here/);
    expect(again.questions[0]).not.toMatch(/plan\.md .*new since/);
    expect((await commitGateDecision(run, again, undefined)).ok).toBe(true);
    // a rejection needs no second look: it sends the work back whatever was written
    await host.stop();
  });

  test("t45_a_rejection_is_not_held_back_by_a_new_version", async () => {
    const { host, run } = await forkAtGate();
    const prepared = await prepareGateDecision(run, {
      decision: "reject",
      node: "a-gate",
      reason: "again",
    });
    await text(run, "b", "notes.md", "from b\n");
    expect((await commitGateDecision(run, prepared, "again")).ok).toBe(true);
    await host.stop();
  });

  test("t45_look_again_in_a_shared_tree", async () => {
    const { host, run } = await forkAtGate();
    const prepared = await approve(run);
    // The sibling writes a file too. The tree is one, so a changed file is no reason to refuse while
    // another branch runs (T-40); an attachment has a writer and a number, so it is.
    await writeFile(join(dir, "b.txt"), "b wrote this\n");
    expect((await run.changesSinceGate("a-gate")).kind).toBe("changes");
    await text(run, "b", "plan.md", "the plan of b\n");
    const error = await refused(commitGateDecision(run, prepared, undefined, { recheck: true }));
    expect(error.message).toBe(ATTACHMENTS_MOVED);
    // with only the file changed, the same decision is kept
    const again = await approve(run);
    await writeFile(join(dir, "b.txt"), "b wrote more\n");
    expect((await commitGateDecision(run, again, undefined, { recheck: true })).ok).toBe(true);
    await host.stop();
  });

  test("t45_look_again_without_git", async () => {
    const { host, run } = await forkAtGate(false);
    expect((await run.changesSinceGate("a-gate")).kind).toBe("no_repo");
    const prepared = await approve(run);
    expect(prepared.questions[0]).toContain("1 attachment(s)");
    await text(run, "b", "notes.md", "from b\n");
    expect((await refused(commitGateDecision(run, prepared, undefined))).message).toBe(
      ATTACHMENTS_MOVED,
    );
    await host.stop();
  });

  test("t45_look_again_on_a_same_size_rewrite", async () => {
    const { host, run } = await forkAtGate();
    const prepared = await approve(run);
    // the same name, the same number of bytes and lines: only the version differs
    await text(run, "b", "plan.md", "the plan of b\n");
    const before = prepared.attachments?.list[0];
    const now = (await run.gateAttachments("a-gate")).list[0];
    expect([now?.bytes, now?.lines]).toEqual([before?.bytes, before?.lines]);
    expect((await refused(commitGateDecision(run, prepared, undefined))).message).toBe(
      ATTACHMENTS_MOVED,
    );
    await host.stop();
  });

  test("t45_fork_branch_that_keeps_writing", async () => {
    const { host, run } = await forkAtGate();
    // each new version asks for a new look
    for (let i = 0; i < 3; i++) {
      const prepared = await approve(run);
      await text(run, "b", "notes.md", `round ${i}\n`);
      expect((await refused(commitGateDecision(run, prepared, undefined))).message).toBe(
        ATTACHMENTS_MOVED,
      );
    }
    // a write that is a no-op does not
    const prepared = await approve(run);
    expect((await text(run, "b", "notes.md", "round 2\n")).unchanged).toBe(true);
    // and the loop has an end: the bound of versions is never reset, so the branch runs out of them
    const left = ATTACHMENT_LIMITS.versions - (await run.attachmentRecords()).length;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(ATTACHMENT_LIMITS.versions);
    expect((await commitGateDecision(run, prepared, undefined)).ok).toBe(true);
    await host.stop();
  });
});

describe("t45 the agent deciding for the person", () => {
  async function connect(host: LocalPipelineHost) {
    const server = createServer(host, "0.0.0", undefined, undefined, {
      humans: host,
      agentDecisions: { gate: true },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    };
    return { call, close: () => Promise.all([client.close(), server.close()]) };
  }

  test("t45_agent_decision_needs_the_fresh_look", async () => {
    const { host, run } = await forkAtGate();
    const { call, close } = await connect(host);
    const decide = (extra: Record<string, unknown> = {}) =>
      call("pipeline_decide_gate", {
        run_id: run.runId,
        node_slug: "a-gate",
        attempt: 1,
        decision: "approved",
        instruction: "approve it",
        ...extra,
      });
    // without the fingerprint: refused, with the attachments as they are now
    const missing = await decide();
    expect(missing).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(missing.message).toContain("attachments_fingerprint");
    expect(missing.details.attachments).toMatchObject([{ name: "plan.md", version: 1 }]);
    const seen = missing.details.attachments_fingerprint as string;
    expect(seen).toBe((await run.attachmentsFingerprint()) as string);
    expect(missing.details.next).toBeDefined();
    // a version written since: the fingerprint the person decided on is stale
    await text(run, "b", "notes.md", "from b\n");
    const stale = await decide({ attachments_fingerprint: seen });
    expect(stale).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(stale.message).toContain("written since");
    expect(stale.details.attachments).toMatchObject([
      { name: "notes.md", new: true },
      { name: "plan.md" },
    ]);
    expect((await run.state()).active.some((v) => v.node === "a-gate")).toBe(true);
    // a rejection is not held back; nor is an approval with the fingerprint of now
    const fresh = await decide({ attachments_fingerprint: stale.details.attachments_fingerprint });
    expect(fresh).toMatchObject({ ok: true, decided_by: "agent", decision: "approved" });
    await close();
    await host.stop();
  });

  test("t45_agent_decision_without_attachments_is_as_before", async () => {
    await project(true);
    const host = newHost();
    const run = await startRun(host, "single");
    await run.completeStep("write", 1);
    await run.settle();
    const { call, close } = await connect(host);
    // the waiting answer has no fingerprint, and none is asked for
    const next = await call("pipeline_next_step", { run_id: run.runId });
    expect(next.waiting.attachments_fingerprint).toBeUndefined();
    expect(
      await call("pipeline_decide_gate", {
        run_id: run.runId,
        node_slug: "approve",
        attempt: 1,
        decision: "approved",
        instruction: "approve it",
      }),
    ).toMatchObject({ ok: true, decided_by: "agent" });
    await close();
    await host.stop();
  });

  test("t45_the_waiting_answer_carries_the_fingerprint_to_send_back", async () => {
    await project(true);
    const host = newHost();
    const run = await startRun(host, "single");
    await text(run, "write", "plan.md", "one\n");
    await run.completeStep("write", 1);
    await run.settle();
    const { call, close } = await connect(host);
    const next = await call("pipeline_next_step", { run_id: run.runId });
    expect(next.waiting.attachments).toMatchObject([{ name: "plan.md", version: 1 }]);
    expect(
      await call("pipeline_decide_gate", {
        run_id: run.runId,
        node_slug: "approve",
        attempt: 1,
        decision: "approved",
        instruction: "approve it",
        attachments_fingerprint: next.waiting.attachments_fingerprint,
      }),
    ).toMatchObject({ ok: true, decided_by: "agent" });
    await close();
    await host.stop();
  });
});

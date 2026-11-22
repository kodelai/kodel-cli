/**
 * The attachment tools on the real server (T-45): the local host serves them, a host that keeps no
 * attachments does not, and a background worker is allowed the same names the server registers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { KodelError, toolsFingerprint } from "@kodel-ai/pipeline-core";
import { HISTORY_TOOLS, serverInstructions, toolsFor } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, noProjectHost, type StoppableHost } from "../src/mcp-server";
import { workerToolNames } from "../src/worker-factory";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ATTACHMENT_NAMES = [
  "pipeline_attachment_write",
  "pipeline_attachment_read",
  "pipeline_attachment_list",
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cli-attachment-mcp-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(
    join(dir, ".kodel", "pipelines", "one.yaml"),
    "name: one\nnodes:\n  - slug: a\n    kind: agent\n    prompt: do a\nedges: []\n",
  );
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}-integrity`, { recursive: true, force: true });
});

async function connect(host: StoppableHost) {
  const server = createServer(host, "1.2.3");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  return { server, client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("t45 the tools on the server", () => {
  test("t45_worker_gets_the_attachment_tools", async () => {
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: `${dir}-integrity`,
      environment: {},
    });
    const { client, call, close } = await connect(host);
    const served = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ATTACHMENT_NAMES) expect(served).toContain(name);
    expect(client.getInstructions()).toContain("pipeline_attachment_write");

    // a background worker may call exactly what the server registers
    const worker = await workerToolNames(join(dir, ".kodel"));
    expect([...worker].sort()).toEqual([...served].sort());

    // and the run records the surface it was served: the hash of the same lists
    const started = await call("pipeline_start", { task: "attach", pipeline: "one" });
    const journal = (await (await host.open(started.run_id))?.journal()) ?? [];
    const engine = journal.find((r) => r.event === "run_started")?.engine as Record<string, string>;
    expect(engine.tools_hash).toBe(
      sha256(toolsFingerprint([...toolsFor({ attachments: true }), ...HISTORY_TOOLS])),
    );
    expect(engine.instructions_hash).toBe(sha256(serverInstructions({ attachments: true })));

    // the tools work over the wire
    const written = await call("pipeline_attachment_write", {
      run_id: started.run_id,
      node_slug: "a",
      attempt: 1,
      name: "plan.md",
      content: "a plan\n",
    });
    expect(written).toMatchObject({ ok: true, version: 1, name: "plan.md" });
    expect(await call("pipeline_attachment_list", { run_id: started.run_id })).toMatchObject({
      ok: true,
      attachments: [{ name: "plan.md", version: 1, lines: 1 }],
    });
    await close();
    await host.stop();
  });

  test("t45_a_host_without_attachments_serves_no_attachment_tool", async () => {
    const host = noProjectHost(new KodelError("CONFIG_INVALID", "no project here"));
    const { client, close } = await connect(host);
    const served = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ATTACHMENT_NAMES) expect(served).not.toContain(name);
    expect(client.getInstructions()).not.toContain("pipeline_attachment");
    await close();
  });
});

describe("t45 a plan kept with the run, end to end", () => {
  test("t45_e2e_plan_written_checked_and_read", async () => {
    // A scripted agent works a pipeline through the tools alone: the step that asks for a plan is not
    // done until the plan is kept, the person sees it at the gate, and the next step reads it.
    await writeFile(
      join(dir, ".kodel", "pipelines", "planned.yaml"),
      [
        "name: planned",
        "nodes:",
        "  - slug: plan",
        "    kind: agent",
        "    prompt: Write the plan.",
        "    checks:",
        "      - { kind: attachment, name: plan.md, min_lines: 2 }",
        "  - { slug: approval, kind: human, prompt: Is the plan right? }",
        "  - { slug: impl, kind: agent, prompt: Do what the plan says. }",
        "edges:",
        "  - { from: plan, to: approval }",
        "  - { from: approval, to: impl, when: approved }",
        "  - { from: approval, to: plan, when: rejected }",
        "",
      ].join("\n"),
    );
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: `${dir}-integrity`,
      environment: {},
    });
    const { call, close } = await connect(host);
    // the reference the agent reads before it writes a pipeline lists the kind
    expect((await call("pipeline_docs", { topic: "checks" })).text).toContain(
      "Check kind `attachment`",
    );
    const started = await call("pipeline_start", { task: "plan it", pipeline: "planned" });
    const run_id = started.run_id as string;
    // the step says what to keep and how
    expect(started.next.node.prompt).toContain("pipeline_attachment_write");
    expect(started.next.node.prompt).toContain('"plan.md"');

    // handed in without the plan: the engine's check says no, whatever the agent says
    const early = await call("pipeline_complete_step", { run_id, node_slug: "plan", attempt: 1 });
    expect(early).toMatchObject({ ok: true, advanced: false });
    expect(early.failed_check).toMatchObject({ kind: "attachment" });
    expect(early.failed_check.reason).toContain('kept no attachment "plan.md"');
    expect(early.next.node).toMatchObject({ slug: "plan", attempt: 2 });

    const plan = "# Plan\n\n1. Read the code.\n2. Change it.\n";
    expect(
      await call("pipeline_attachment_write", {
        run_id,
        node_slug: "plan",
        attempt: 2,
        name: "plan.md",
        content: plan,
      }),
    ).toMatchObject({ ok: true, version: 1, lines: 4 });
    const done = await call("pipeline_complete_step", { run_id, node_slug: "plan", attempt: 2 });
    expect(done).toMatchObject({ ok: true, advanced: true });
    // the gate shows the plan to the person, apart from the project files
    expect(done.next.waiting).toMatchObject({ reason: "gate", node_slug: "approval" });
    expect(done.next.waiting.attachments).toMatchObject([
      { name: "plan.md", version: 1, written_by: { node_slug: "plan", attempt: 2 } },
    ]);
    expect(Object.keys(done.next.waiting.changes ?? {})).toEqual([]);

    // the person approves; the next step reads what the gate showed
    const run = await host.open(run_id);
    expect((await run?.decideHuman("approval", "approved"))?.ok).toBe(true);
    await run?.settle();
    const next = await call("pipeline_next_step", { run_id });
    expect(next.node).toMatchObject({ slug: "impl", attempt: 1 });
    const read = await call("pipeline_attachment_read", { run_id, name: "plan.md" });
    expect(read).toMatchObject({
      ok: true,
      content: plan,
      version: 1,
      sha256: done.next.waiting.attachments[0].sha256,
    });
    expect(
      await call("pipeline_complete_step", { run_id, node_slug: "impl", attempt: 1 }),
    ).toMatchObject({
      ok: true,
      next: { done: true, run_status: "completed" },
    });
    // nothing of it is in the project's files
    const status = execFileSync("git", ["status", "--porcelain", "--", ":!.kodel"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(status.trim()).toBe("");
    await close();
    await host.stop();
  });
});

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost } from "../src";

// git is slow to start on some systems, and these tests start it many times
setDefaultTimeout(60_000);

// Tests of TASK-36TW and Principle 6: patches add no tool and no argument for the agent, and nothing
// of a patch reaches an answer.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-chg-mcp-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "core.autocrlf", "false"); // a Windows runner would check files out with CRLF
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(
    join(dir, ".kodel", "pipelines", "p.yaml"),
    [
      "name: p",
      "nodes:",
      "  - slug: a",
      "    kind: agent",
      "    prompt: do it",
      "  - slug: b",
      "    kind: agent",
      "    prompt: do it too",
      "edges:",
      "  - { from: a, to: b }",
      "",
    ].join("\n"),
  );
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("t36tw_no_new_agent_tool_or_argument_and_agent_answers_do_not_leak_patch_data", async () => {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  registerPipelineTools(server, new PipelineService(host, { waitBudgetMs: 10_000 }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    // The tools: the same as before patches, with the arguments the agent could already give.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "pipeline_complete_step",
      "pipeline_docs",
      "pipeline_feedback",
      "pipeline_list",
      "pipeline_next_step",
      "pipeline_plan",
      "pipeline_propose_change",
      "pipeline_report_result",
      "pipeline_resolve",
      "pipeline_start",
    ]);
    const complete = tools.find((t) => t.name === "pipeline_complete_step");
    expect(Object.keys((complete?.inputSchema.properties ?? {}) as object).sort()).toEqual([
      "attempt",
      "node_slug",
      "outcome",
      "run_id",
      "summary",
    ]);

    const text: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const raw = ((result.content as { text: string }[])[0] as { text: string }).text;
      text.push(raw);
      return JSON.parse(raw);
    };
    const started = await call("pipeline_start", { task: "write", pipeline: "p", cwd: dir });
    await writeFile(join(dir, "x.txt"), "x\n");
    await call("pipeline_complete_step", { run_id: started.run_id, node_slug: "a", attempt: 1 });
    await writeFile(join(dir, "y.txt"), "y\n");
    await call("pipeline_complete_step", { run_id: started.run_id, node_slug: "b", attempt: 1 });
    await call("pipeline_next_step", { run_id: started.run_id });

    const journal = await readFile(
      join(dir, ".kodel", "runs", started.run_id, "journal.jsonl"),
      "utf8",
    );
    const trees = [...journal.matchAll(/"tree":"([0-9a-f]{40,64})"/g)].map((m) => m[1] as string);
    expect(trees.length).toBeGreaterThan(0); // the control: there is something that could leak
    const answers = text.join("\n");
    for (const tree of trees) expect(answers).not.toContain(tree);
    expect(answers).not.toContain("changes/");
    expect(answers).not.toContain(".patch");
    expect(answers).not.toContain("kodel-patch");
  } finally {
    await host.settle(30_000); // the end of the run is recorded in the background
    await Promise.all([client.close(), server.close()]);
  }
});

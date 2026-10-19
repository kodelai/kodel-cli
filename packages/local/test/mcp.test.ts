import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-mcp-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("write a file"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

const hostOptions = () => ({ root: dir, heartbeatMs: 0 });

async function connect(host = new LocalPipelineHost(hostOptions())) {
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  registerPipelineTools(server, new PipelineService(host, { waitBudgetMs: 10_000 }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    return { body, isError: result.isError === true };
  };
  return { host, client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("an agent driving a run through MCP, with the real adapters", () => {
  test("from the first step to done, with a failed check and a human gate in between", async () => {
    const { host, call, close } = await connect();

    const listed = await call("pipeline_list");
    expect(listed.body.pipelines).toEqual([
      { name: "demo", format: 1, description: "A small pipeline for the tests." },
    ]);

    const started = await call("pipeline_start", { task: "add a file" });
    expect(started.body).toMatchObject({ ok: true, reused: false, terminal: false });
    expect(started.body.next.node).toMatchObject({ slug: "write", attempt: 1 });
    expect(started.body.next.node.prompt).toContain("write a file for add a file");
    const runId = started.body.run_id as string;

    // The agent says it is done without having changed anything: the engine disagrees.
    const lied = await call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
    });
    expect(lied.body).toMatchObject({ ok: true, advanced: false, outcome: "failed" });
    expect(lied.body.failed_check.kind).toBe("diff");
    expect(lied.body.next.node).toMatchObject({ slug: "write", attempt: 2 });

    await writeFile(join(dir, "out.txt"), "hello\n");
    const done = await call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 2,
    });
    expect(done.body).toMatchObject({ ok: true, advanced: true, outcome: "passed" });
    expect(done.body.next.waiting).toMatchObject({ node_slug: "approve" });

    // Only a person can pass the gate, and the agent has no tool for it.
    const run = await host.open(runId);
    await run?.decideHuman("approve", "approved");
    await run?.waitForRest(10_000);
    const end = await call("pipeline_next_step", { run_id: runId });
    expect(end.body).toMatchObject({ ok: true, done: true });
    await close();
  });

  test("starting the same task again says it is terminal; restart begins a new run", async () => {
    const { host, call, close } = await connect();
    const first = await call("pipeline_start", { task: "t" });
    await writeFile(join(dir, "out.txt"), "x\n");
    await call("pipeline_complete_step", {
      run_id: first.body.run_id,
      node_slug: "write",
      attempt: 1,
    });
    const run = await host.open(first.body.run_id);
    await run?.decideHuman("approve", "approved");
    await run?.waitForRest(10_000);

    const again = await call("pipeline_start", { task: "t" });
    expect(again.body).toMatchObject({ terminal: true, reused: false, run_id: first.body.run_id });
    const restarted = await call("pipeline_start", { task: "t", restart: true });
    expect(restarted.body.run_id).not.toBe(first.body.run_id);
    expect(restarted.body.terminal).toBe(false);
    await close();
  });

  test("a new process carries on from the files alone", async () => {
    const one = await connect();
    const started = await one.call("pipeline_start", { task: "t" });
    await one.close();

    const two = await connect(new LocalPipelineHost(hostOptions()));
    const next = await two.call("pipeline_next_step", { run_id: started.body.run_id });
    expect(next.body).toMatchObject({ ok: true, node: { slug: "write", attempt: 1 } });
    const same = await two.call("pipeline_start", { task: "t" });
    expect(same.body).toMatchObject({ reused: true, run_id: started.body.run_id });
    await two.close();
  });

  test("editing the pipeline file does not change a run already started", async () => {
    const one = await connect();
    const started = await one.call("pipeline_start", { task: "t" });
    await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO("do something else"));

    const two = await connect(new LocalPipelineHost(hostOptions()));
    const next = await two.call("pipeline_next_step", { run_id: started.body.run_id });
    expect(next.body.node.prompt).toContain("write a file for t");
    const fresh = await two.call("pipeline_start", { task: "other" });
    expect(fresh.body.next.node.prompt).toContain("do something else for other");
    await one.close();
    await two.close();
  });

  test("a state file edited by hand is refused, with the code the agent can report", async () => {
    const { call, close } = await connect();
    const started = await call("pipeline_start", { task: "t" });
    const path = join(dir, ".kodel", "runs", started.body.run_id, "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.nodes.write.attempts = 0;
    await writeFile(path, JSON.stringify(state));

    const next = await call("pipeline_next_step", { run_id: started.body.run_id });
    expect(next.isError).toBe(true);
    expect(next.body).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
    await close();
  });

  test("a broken pipeline file is listed as a problem and does not hide the good ones", async () => {
    await writeFile(join(dir, ".kodel", "pipelines", "broken.yaml"), "name: broken\nnodes: []\n");
    const { call, close } = await connect();
    const listed = await call("pipeline_list");
    expect(listed.body.pipelines.map((p: { name: string }) => p.name)).toEqual(["demo"]);
    expect(listed.body.problems).toHaveLength(1);
    expect(listed.body.problems[0].file).toBe("broken.yaml");
    await close();
  });

  test("a pipeline can be found by its file name, and an unknown run id is refused", async () => {
    const { call, close } = await connect();
    expect((await call("pipeline_resolve", { pipeline: "demo" })).body.spec.name).toBe("demo");
    expect((await call("pipeline_next_step", { run_id: "run_nope" })).body).toMatchObject({
      code: "UNKNOWN_RUN",
    });
    await close();
  });
});

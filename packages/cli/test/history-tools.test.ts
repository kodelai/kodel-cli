/**
 * The history tools on a real MCP server (`createServer`) over a real local host: they are listed with the strict
 * schemas and rule 9c, they read a run that is going, and reading it while it advances breaks nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp-server";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

let dir: string;

const PIPELINE = [
  "name: demo",
  "description: A small pipeline for the tests.",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write it }",
  `  - { slug: build, kind: command, command: "node -e \\"console.log('built')\\"" }`,
  "edges:",
  "  - { from: write, to: build }",
  "  - { from: build, to: write, when: failed }",
  "",
].join("\n");

const GATED = [
  "name: gated",
  "description: A pipeline that stops at a gate.",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write it }",
  "  - { slug: approve, kind: human, prompt: Looks fine? }",
  `  - { slug: build, kind: command, command: "node -e \\"console.log('built')\\"" }`,
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: build }",
  "  - { from: approve, to: write, when: rejected }",
  "  - { from: build, to: write, when: failed }",
  "",
].join("\n");

/** Every file under `dir` with its bytes and modification time: what "nothing was written" means. */
async function snapshot(path: string, base = path): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(found, await snapshot(full, base));
    else {
      const info = await stat(full);
      found[full.slice(base.length)] =
        `${info.mtimeMs}:${(await readFile(full)).toString("base64")}`;
    }
  }
  return found;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-history-mcp-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), PIPELINE);
  await writeFile(join(dir, ".kodel", "pipelines", "gated.yaml"), GATED);
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  git("add", "-A");
  git("commit", "-q", "-m", "pipeline");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect() {
  const host = new LocalPipelineHost({
    root: dir,
    heartbeatMs: 0,
    integrityDir: join(dir, ".integrity"),
  });
  const server = createServer(host, "0.0.0");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Loose> => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("the history tools on an MCP server", () => {
  test("history_tools_are_served_with_strict_schemas_and_rule_9c", async () => {
    const s = await connect();
    try {
      const { tools } = await s.client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "history_runs",
          "history_run_details",
          "history_agent_log",
          "history_stats",
        ]),
      );
      for (const tool of tools.filter((t) => t.name.startsWith("history_"))) {
        expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      }
      expect(s.client.getInstructions()).toContain("9c.");
      const refused = await s.client.callTool({ name: "history_runs", arguments: { limt: 5 } });
      expect(refused.isError).toBe(true);
    } finally {
      await s.close();
    }
  });

  test("history_tools_read_a_run_that_is_going_and_one_that_advances", async () => {
    const s = await connect();
    try {
      expect(await s.call("history_runs")).toMatchObject({
        ok: true,
        runs: [],
        page: { total: 0 },
      });
      const started = await s.call("pipeline_start", {
        pipeline: "demo",
        task: "write it",
        title: "write-it",
      });
      const runId = started.run_id as string;

      const list = await s.call("history_runs");
      expect(list.runs).toHaveLength(1);
      expect(list.runs[0]).toMatchObject({
        run_id: runId,
        pipeline: "demo",
        slug: "write-it",
        status: "running",
        active: [{ node: "write", attempt: 1 }],
      });
      const open = await s.call("history_run_details", { run_id: runId });
      expect(open).toMatchObject({ ok: true, level: "run", run: { status: "running" } });
      expect(open.integrity.seal).toBe("open");

      // the run advances in the same process while the history is read
      const reads = Array.from({ length: 25 }, () =>
        s.call("history_run_details", { run_id: runId, node: "write" }),
      );
      const [done, ...answers] = await Promise.all([
        s.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 }),
        ...reads,
      ]);
      expect(done.ok).toBe(true);
      for (const answer of answers) expect(answer).toMatchObject({ ok: true, level: "node" });

      const next = await s.call("pipeline_next_step", { run_id: runId, wait_s: 20 });
      expect(next.ok).toBe(true);
      const finished = await s.call("history_run_details", { run_id: runId, limit: 10 });
      expect(finished.run.status).toBe("completed");
      expect(finished.nodes.map((n: Loose) => n.node)).toEqual(["write", "build"]);
      expect((await s.call("history_runs", { status: "completed" })).page.total).toBe(1);
      // the figures over the runs of the pipeline, counted on the server
      const stats = await s.call("history_stats", { pipeline: "demo" });
      expect(stats).toMatchObject({
        ok: true,
        level: "stats",
        runs: { pipeline: "demo", read: 1 },
      });
      expect(stats.nodes.map((n: Loose) => n.node)).toEqual(["write", "build"]);
      expect((await s.client.callTool({ name: "history_stats", arguments: {} })).isError).toBe(
        true,
      );
    } finally {
      await s.close();
    }
  });

  test("history_tools_do_not_write_on_a_running_run_or_one_at_a_gate", async () => {
    const s = await connect();
    try {
      const started = await s.call("pipeline_start", {
        pipeline: "gated",
        task: "gate it",
        title: "gate-it",
      });
      const runId = started.run_id as string;
      const readAll = async () => {
        await s.call("history_runs");
        await s.call("history_run_details", { run_id: runId });
        await s.call("history_run_details", { run_id: runId, node: "write" });
        await s.call("history_run_details", { run_id: runId, node: "write", attempt: 1 });
        await s.call("history_agent_log", { run_id: runId, node: "write", attempt: 1 });
      };
      const runs = join(dir, ".kodel", "runs");
      // the step of the agent is open
      let before = await snapshot(runs);
      await readAll();
      expect(await snapshot(runs)).toEqual(before);
      // the run waits for a person at its gate
      await s.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
      const waiting = await s.call("pipeline_next_step", { run_id: runId, wait_s: 20 });
      expect(waiting.waiting?.reason).toBe("gate");
      before = await snapshot(runs);
      await readAll();
      expect(await snapshot(runs)).toEqual(before);
      const listed = await s.call("history_runs");
      expect(listed.runs[0].pauses.length + listed.runs[0].active.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });
});

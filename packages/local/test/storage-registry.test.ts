import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools, SERVER_INSTRUCTIONS, TOOLS } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homePlace, LocalPipelineHost, resolveStoragePlace, type StoragePlace } from "../src";

const ID = "demo-aaaa1111";

let dir: string;
let base: string;
let hashes: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-registry-"));
  base = await mkdtemp(join(tmpdir(), "kodel-registry-base-"));
  hashes = await mkdtemp(join(tmpdir(), "kodel-registry-hashes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(
    join(dir, ".kodel", "config.yaml"),
    `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
  );
});
afterEach(async () => {
  for (const path of [dir, base, hashes]) await rm(path, { recursive: true, force: true });
});

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * What each tool of the registry does when the config names another place than the one the server
 * started with. A tool that is not in this table fails the first test, so a new tool has to say
 * whether it reaches the store.
 */
const ROWS: Record<string, { touches: boolean; args: (runId: string) => Record<string, unknown> }> =
  {
    pipeline_list: { touches: false, args: () => ({}) },
    pipeline_docs: { touches: false, args: () => ({}) },
    pipeline_resolve: { touches: false, args: () => ({ pipeline: "demo" }) },
    pipeline_plan: { touches: false, args: () => ({ pipeline: "demo", task: "t" }) },
    pipeline_start: { touches: true, args: () => ({ pipeline: "demo", task: "another" }) },
    pipeline_next_step: { touches: true, args: (run_id) => ({ run_id }) },
    pipeline_take_step: { touches: true, args: (run_id) => ({ run_id, node_slug: "write" }) },
    pipeline_report_result: {
      touches: true,
      args: (run_id) => ({
        run_id,
        node_slug: "write",
        attempt: 1,
        completeness: "complete",
        rows: [],
      }),
    },
    pipeline_complete_step: {
      touches: true,
      args: (run_id) => ({ run_id, node_slug: "write", attempt: 1 }),
    },
    pipeline_feedback: {
      touches: true,
      args: (run_id) => ({ run_id, category: "other", message: "a remark" }),
    },
    pipeline_propose_change: {
      touches: true,
      args: () => ({ pipeline: DEMO.replace("name: demo", "name: other"), summary: "s" }),
    },
  };

async function connect(host: LocalPipelineHost) {
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  registerPipelineTools(server, new PipelineService(host, { waitBudgetMs: 5_000 }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as { text: string }[])[0] as { text: string }).text;
    return { text, body: JSON.parse(text) as Record<string, unknown>, isError: result.isError };
  };
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("every tool of the registry and a config that names another place", () => {
  test("storage_refusal_table_covers_registry", () => {
    expect(Object.keys(ROWS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  test("storage_changed_under_running_server_refuses_all: each tool that reaches the store refuses", async () => {
    const start = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    });
    let current: StoragePlace = start;
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: start,
      watchStorage: async () => current,
    });
    const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
    const { call, close } = await connect(host);
    try {
      // Nothing changed: every tool answers.
      for (const [name, row] of Object.entries(ROWS)) {
        if (name === "pipeline_start") continue; // it would make a second run; asked below
        const answer = await call(name, row.args(run.runId));
        expect(answer.text, name).not.toContain("restart the server");
      }
      // The config now names another place: the tools that reach the store stop, the others answer.
      current = homePlace({ root: dir, projectId: "demo-bbbb2222", base });
      for (const [name, row] of Object.entries(ROWS)) {
        const answer = await call(name, row.args(run.runId));
        if (row.touches) {
          expect(answer.text, name).toContain("restart the server");
          expect(answer.body["ok"], name).not.toBe(true);
        } else {
          expect(answer.text, name).not.toContain("restart the server");
        }
      }
      // And nothing was written in the place it named.
      expect(await exists(join(base, "projects", "demo-bbbb2222"))).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("a failure of the disk, as the agent reads it", () => {
  test("storage_errors_scrub_home_path: a tool answer has a code and no home folder", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: place,
    });
    const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
    const folder = join(place.runsRoot, run.runId);
    const { call, close } = await connect(host);
    try {
      await chmod(folder, 0o500);
      const answer = await call("pipeline_complete_step", {
        run_id: run.runId,
        node_slug: "write",
        attempt: 1,
      });
      expect(answer.body["ok"]).toBe(false);
      expect(answer.body["code"]).toBe("CONFIG_INVALID");
      expect(answer.text).toContain("<home>");
      expect(answer.text).not.toContain(base);
    } finally {
      await chmod(folder, 0o700);
      await close();
    }
  });
});

describe("what the agent is told", () => {
  test("storage_agent_text_generic: instruction 5 names no folder of the home tree", () => {
    const rule = SERVER_INSTRUCTIONS.split("\n").find((line) => line.startsWith("5. ")) ?? "";
    expect(rule).toContain("run files of the project (by default in .kodel/runs)");
    expect(rule).not.toContain("~");
    expect(rule).not.toContain("projects/");
    expect(SERVER_INSTRUCTIONS).not.toContain("storage");
    expect(SERVER_INSTRUCTIONS).not.toContain("project_id");
  });

  test("storage_not_agent_settable: no tool takes the keys, and no proposal can write the config", async () => {
    for (const tool of TOOLS) {
      const keys = Object.keys(tool.shape);
      expect(keys, tool.name).not.toContain("storage");
      expect(keys, tool.name).not.toContain("project_id");
    }
    const place = await resolveStoragePlace({
      root: dir,
      dataDir: join(dir, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    });
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      integrityDir: hashes,
      storage: place,
    });
    const before = await Bun.file(join(dir, ".kodel", "config.yaml")).text();
    // A name that is a path is refused, with or without a body to propose.
    for (const name of ["../config", "config.yaml", "..", "/etc/passwd"]) {
      const outcome = await host.proposePipeline({ yaml: "", summary: "s", name });
      expect(outcome.ok, name).toBe(false);
    }
    // A pipeline named `config` is a proposal like any other: a file under the proposals, not the config.
    const named = await host.proposePipeline({
      yaml: DEMO.replace("name: demo", "name: config"),
      summary: "s",
    });
    expect(named.ok).toBe(true);
    expect(await exists(join(place.proposalsRoot, "config.json"))).toBe(true);
    // Whatever was proposed, the config is the person's and is untouched.
    expect(await Bun.file(join(dir, ".kodel", "config.yaml")).text()).toBe(before);
  });
});

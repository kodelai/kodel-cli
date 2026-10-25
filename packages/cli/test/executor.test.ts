import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { toolsFingerprint } from "@kodel-ai/pipeline-core";
import { CONTRACT_VERSION, serverInstructions, toolsFor } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp-server";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cli-executor-"));
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
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the real server stamps who calls it", () => {
  test("t5btp_the_server_passes_the_handshake_client_and_what_it_served_to_the_run", async () => {
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      build: { version: "7.8.9", commit: "feedface0000" },
      environment: {},
    });
    const server = createServer(host, "7.8.9");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const result = await client.callTool({
      name: "pipeline_start",
      arguments: { task: "stamp", pipeline: "one" },
    });
    const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    const journal = (await (await host.open(body.run_id))?.journal()) ?? [];
    const started = journal.find((r) => r.event === "run_started") as unknown as {
      executor: unknown;
      engine: unknown;
    };

    expect(started.executor).toEqual({
      client: { value: { name: "claude-code", version: "2.1.0" }, source: "observed" },
    });
    expect(started.engine).toEqual({
      version: "7.8.9",
      commit: "feedface0000",
      record_version: 1,
      meta_version: 2,
      contract_version: CONTRACT_VERSION,
      instructions_hash: sha256(serverInstructions()),
      tools_hash: sha256(toolsFingerprint(toolsFor())),
    });
    await Promise.all([client.close(), server.close()]);
  });
});

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
afterEach(() => rm(dir, { recursive: true, force: true }));

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
      integrityDir: join(dir, ".integrity"),
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

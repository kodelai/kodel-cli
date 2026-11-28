import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JournalRecord, PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost } from "../src";

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-origin-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(
    join(dir, ".kodel", "pipelines", "demo.yaml"),
    "name: demo\nnodes:\n  - { slug: write, kind: agent, prompt: 'do {{task}}' }\n",
  );
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });

const journalOf = async (runId: string): Promise<JournalRecord[]> =>
  (await readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JournalRecord);

const startedOf = async (runId: string) =>
  (await journalOf(runId)).find((r) => r.event === "run_started") as JournalRecord;

describe("mstart the origin of a run reaches the journal as the path of the call set it", () => {
  test("mstart_origin_is_set_by_the_path", async () => {
    const h = host();
    const viaTui = await h.start({
      pipeline: "demo",
      task: "from the tui",
      restart: false,
      origin: { by: "person", via: "tui" },
    });
    expect((await startedOf(viaTui.run.runId)).origin).toEqual({ by: "person", via: "tui" });
    const viaManager = await h.start({
      pipeline: "demo",
      task: "from a manager",
      restart: false,
      origin: {
        by: "agent",
        via: "manager",
        agent_instruction: "the person said so",
        forced: ["blocked"],
      },
    });
    expect((await startedOf(viaManager.run.runId)).origin).toEqual({
      by: "agent",
      via: "manager",
      agent_instruction: "the person said so",
      forced: ["blocked"],
    });
    // no path, no field: `pipeline_start` through the service and a start with none
    const plain = await h.start({ pipeline: "demo", task: "plain", restart: false });
    expect("origin" in (await startedOf(plain.run.runId))).toBe(false);
  });

  test("mstart_pipeline_start_takes_no_origin", async () => {
    const h = host();
    const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
    registerPipelineTools(server, new PipelineService(h, { waitBudgetMs: 10_000 }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "pipeline_start", arguments: args });
      const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
      return { body, isError: result.isError === true };
    };
    // The tool's schema is not strict (an unknown argument is ignored, as for every tool): whatever the
    // agent sends as `origin`, the run's record has none.
    const forged = await call({
      task: "forge it",
      origin: { by: "person", via: "tui", forced: ["full"] },
    });
    expect(forged.body.ok).toBe(true);
    expect("origin" in (await startedOf(forged.body.run_id as string))).toBe(false);
    // a start without the field never carries one
    const ok = await call({ task: "honest" });
    expect(ok.body.ok).toBe(true);
    expect("origin" in (await startedOf(ok.body.run_id as string))).toBe(false);
    await Promise.all([client.close(), server.close()]);
  });

  test("mstart_instruction_is_redacted", async () => {
    const started = await host().start({
      pipeline: "demo",
      task: "with a secret",
      restart: false,
      origin: { by: "agent", via: "manager", agent_instruction: `use ${secret} to start` },
    });
    const record = await startedOf(started.run.runId);
    const text = JSON.stringify(record);
    expect(text).not.toContain(secret);
    expect((record.origin as { agent_instruction: string }).agent_instruction).toContain(
      "[REDACTED",
    );
  });

  test("mstart_origin_that_is_not_known_leaves_no_run", async () => {
    const h = host();
    await expect(
      h.start({
        pipeline: "demo",
        task: "bad origin",
        restart: false,
        origin: { by: "robot", via: "tui" } as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(await h.runSummaries()).toHaveLength(0);
  });
});

describe("mstart an agent's stop of the run's agent is journaled by the host", () => {
  test("mstart_stop_event_in_journal", async () => {
    const started = await host().start({ pipeline: "demo", task: "stop it", restart: false });
    const run = await host().open(started.run.runId);
    if (!run) throw new Error("the run does not open");
    expect(await run.noteAgentStopped({ instruction: "the person asked" })).toEqual({
      written: true,
    });
    const record = (await journalOf(run.runId)).find((r) => r.event === "agent_stopped");
    expect(record).toMatchObject({
      by: "agent",
      via: "manager",
      agent_instruction: "the person asked",
    });
  });

  test("mstart_stop_instruction_is_redacted", async () => {
    const started = await host().start({ pipeline: "demo", task: "stop it", restart: false });
    const run = await host().open(started.run.runId);
    if (!run) throw new Error("the run does not open");
    await run.noteAgentStopped({ instruction: `${secret} ${"z".repeat(900)}` });
    const record = (await journalOf(run.runId)).find((r) => r.event === "agent_stopped");
    const words = record?.agent_instruction as string;
    expect(words).not.toContain(secret);
    expect(words.length).toBeLessThanOrEqual(500);
  });

  test("mstart_stop_event_is_not_written_for_a_run_that_ended", async () => {
    const started = await host().start({ pipeline: "demo", task: "end it", restart: false });
    const run = await host().open(started.run.runId);
    if (!run) throw new Error("the run does not open");
    const done = await run.completeStep("write", 1, "done", undefined, {
      name: "agent",
      version: "1",
    });
    expect(done.ok).toBe(true);
    expect((await run.state()).status).toBe("completed");
    expect(await run.noteAgentStopped({ instruction: "too late" })).toEqual({ written: false });
    expect((await journalOf(run.runId)).some((r) => r.event === "agent_stopped")).toBe(false);
  });
});

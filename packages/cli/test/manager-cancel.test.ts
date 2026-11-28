/**
 * `manager_cancel_run` (NE3N): a manager cancels a run on the person's instruction, and the journal
 * says the agent did it, through a manager.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cancelRun } from "../src/cancel-run";
import { createServer } from "../src/mcp-server";

let dir: string;

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write a file for {{task}}",
  "  - slug: approve",
  "    kind: human",
  "    prompt: Looks fine?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-manager-cancel-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function connect(options: { cancelRun: boolean; role?: "manager" }) {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
  const finished: string[] = [];
  const server = createServer(host, "0.0.0", undefined, undefined, {
    ...(options.role === undefined ? {} : { role: options.role }),
    humans: host,
    agentDecisions: { cancelRun: options.cancelRun },
    cancel: (input) =>
      cancelRun(
        {
          open: (runId) => host.open(runId),
          withWorkerStartLock: (fn) => host.withWorkerStartLock(fn),
          finishWorkers: async (runId) => {
            finished.push(runId);
          },
        },
        input,
      ),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "manager", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  const tools = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return {
    host,
    call,
    tools,
    finished,
    instructions: () => client.getInstructions() ?? "",
    close: () => Promise.all([client.close(), server.close()]),
  };
}

async function runAtGate(host: LocalPipelineHost): Promise<string> {
  const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
  await run.completeStep("write", 1);
  await run.waitForRest(5_000);
  return run.runId;
}

const journalOf = async (runId: string) =>
  (await readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("tne3n manager_cancel_run", () => {
  test("tne3n_manager_cancels_on_the_persons_instruction", async () => {
    const s = await connect({ cancelRun: true, role: "manager" });
    expect(await s.tools()).toContain("manager_cancel_run");
    expect(s.instructions()).toContain("manager_cancel_run");
    const runId = await runAtGate(s.host);
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
    const answer = await s.call("manager_cancel_run", {
      run_id: runId,
      reason: `a duplicate; key ${secret}`,
      instruction: "cancel that run",
    });
    expect(answer).toMatchObject({ ok: true, decided_by: "agent", status: "canceled" });
    expect(answer.remove_commands).toEqual([]);
    expect(JSON.stringify(answer)).toContain("do not run them yourself");
    expect(s.finished).toEqual([runId]);
    const end = (await journalOf(runId)).find((r) => r.event === "run_finished");
    expect(end).toMatchObject({
      status: "canceled",
      decided_by: "agent",
      decided_via: "manager",
      instruction: "cancel that run",
    });
    // the reason is redacted on its way to the history
    expect(JSON.stringify(end)).not.toContain(secret);
    expect(String(end?.reason)).toContain("[REDACTED:api-key]");
    // the report lists it with the agent's other decisions
    expect((await (await s.host.open(runId))?.report())?.agent_decisions).toMatchObject([
      { what: "cancel", instruction: "cancel that run" },
    ]);
    // a second call writes nothing
    const again = await s.call("manager_cancel_run", {
      run_id: runId,
      reason: "again",
      instruction: "cancel that run",
    });
    expect(again).toMatchObject({ ok: true, noop: true });
    expect((await journalOf(runId)).filter((r) => r.event === "run_finished")).toHaveLength(1);
    await s.close();
  });

  test("tne3n_manager_tool_absent_without_the_key_or_the_role", async () => {
    const off = await connect({ cancelRun: false, role: "manager" });
    expect(await off.tools()).not.toContain("manager_cancel_run");
    expect(off.instructions()).not.toContain("manager_cancel_run");
    await off.close();
    // a server with no role may be the very agent that works the run: never given it
    const noRole = await connect({ cancelRun: true });
    expect(await noRole.tools()).not.toContain("manager_cancel_run");
    await noRole.close();
  });

  test("tne3n_manager_cancel_repeat_is_noop_and_unknown_run_refused", async () => {
    const s = await connect({ cancelRun: true, role: "manager" });
    const runId = await runAtGate(s.host);
    await (await s.host.open(runId))?.cancel({ reason: "by the person" });
    // one the person already canceled is a no-op for the manager too
    const answer = await s.call("manager_cancel_run", {
      run_id: runId,
      reason: "x",
      instruction: "cancel it",
    });
    expect(answer).toMatchObject({ ok: true, noop: true });
    const unknown = await s.call("manager_cancel_run", {
      run_id: "r_0mwzzzzzz_zzzz",
      reason: "x",
      instruction: "cancel it",
    });
    expect(unknown).toMatchObject({ ok: false, code: "UNKNOWN_RUN" });
    await s.close();
  });
});

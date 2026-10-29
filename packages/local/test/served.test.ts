import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, PipelineService } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost } from "../src";
import { fitServed, promptHashOf, SERVED_MAX_BYTES, type ServedFile } from "../src/served";

const secretOne = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const secretTwo = ["AKIA", "ZZZZZZZZZZZZZZZZ"].join("");

const PIPELINE = [
  "name: two",
  "nodes:",
  "  - slug: a",
  "    kind: agent",
  "    prompt: do a for {{task}}",
  "    checks:",
  '      - { kind: diff, paths: ["out.txt"] }',
  "  - slug: b",
  "    kind: agent",
  "    prompt: do b",
  "edges:",
  "  - { from: a, to: b }",
  "",
].join("\n");

// A command that takes a while, so that `next_step` meets a `running` answer, then an agent step.
const SLOW = [
  "name: slow",
  "nodes:",
  "  - slug: build",
  "    kind: command",
  `    command: node -e "setTimeout(() => {}, 1500)"`,
  "  - slug: after",
  "    kind: agent",
  "    prompt: after the build",
  "edges:",
  "  - { from: build, to: after }",
  "  - { from: build, to: after, when: failed }",
  "",
].join("\n");

// An agent step and then a gate, so that `next_step` meets a `waiting` answer.
const GATE = [
  "name: gate",
  "nodes:",
  "  - slug: work",
  "    kind: agent",
  "    prompt: work",
  "  - slug: ask",
  "    kind: human",
  "    prompt: fine?",
  "edges:",
  "  - { from: work, to: ask }",
  "  - { from: ask, to: work, when: rejected }",
  "",
].join("\n");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-served-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  for (const [name, text] of [
    ["two", PIPELINE],
    ["slow", SLOW],
    ["gate", GATE],
  ] as const) {
    await writeFile(join(dir, ".kodel", "pipelines", `${name}.yaml`), text);
  }
  await setConfig();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The runs of these tests work in the root: the worktree is tested in worktree.test.ts.
const setConfig = (history = "") =>
  writeFile(join(dir, ".kodel", "config.yaml"), `worktree:\n  mode: off\n${history}`);

const newHost = (environment: NodeJS.ProcessEnv = {}) =>
  new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment });

async function connect(host: LocalPipelineHost, client = { name: "agent", version: "1.0.0" }) {
  const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
  const service = new PipelineService(host, {
    waitBudgetMs: 10_000,
    caller: () => {
      const seen = server.server.getClientVersion();
      return seen === undefined ? undefined : { name: seen.name, version: seen.version };
    },
  });
  registerPipelineTools(server, service);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client(client);
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
  };
  return { call, close: () => Promise.all([mcp.close(), server.close()]) };
}

type Call = Awaited<ReturnType<typeof connect>>["call"];

const start = async (call: Call, task = "t", pipeline = "two") =>
  (await call("pipeline_start", { task, pipeline })) as { run_id: string; next: Step };

interface Step {
  node?: { slug: string; attempt: number; prompt: string; reentry_feedback?: string };
  waiting?: unknown;
  running?: unknown;
}

interface Served {
  v: number;
  node: string;
  attempt: number;
  n: number;
  prompt_hash: string;
  truncated?: true;
  answer: { slug: string; prompt: string; reentry_feedback?: string };
}

const journal = async (host: LocalPipelineHost, runId: string) =>
  (await (await host.open(runId))?.journal()) ?? [];

const events = async (host: LocalPipelineHost, runId: string, name = "step_served") =>
  (await journal(host, runId)).filter((r) => r.event === name);

const servedDir = (runId: string) => join(dir, ".kodel", "runs", runId, "served");

const files = async (runId: string): Promise<string[]> =>
  (await readdir(servedDir(runId)).catch(() => [])).sort();

const readFileOf = async (runId: string, name: string) =>
  JSON.parse(await readFile(join(servedDir(runId), name), "utf8")) as Served;

const caller = (name: string, version = "1.0.0"): Caller => ({ name, version });

describe("what the agent was shown", () => {
  test("v75e_first_serve_writes_file_and_event", async () => {
    const host = newHost({});
    const { call, close } = await connect(host);
    const started = await start(call, "write the thing");
    const [event] = await events(host, started.run_id);
    expect(event).toMatchObject({ node: "a", attempt: 1, n: 1, ref: "served/a-1-1.json" });
    expect(event?.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.executor).toMatchObject({ client: { value: { name: "agent" } } });
    expect(await files(started.run_id)).toEqual(["a-1-1.json"]);
    const file = await readFileOf(started.run_id, "a-1-1.json");
    expect(file).toMatchObject({ v: 1, node: "a", attempt: 1, n: 1 });
    expect(file.prompt_hash).toBe(event?.prompt_hash as string);
    expect(file.answer.prompt).toBe(started.next.node?.prompt as string);
    expect(file.answer.prompt).toContain("do a for write the thing");
    await close();
  });

  test("v75e_every_service_path_serves", async () => {
    // one client per tool, so that each path has to make its own file or the count is short
    const host = newHost();
    const one = await connect(host, { name: "start-client", version: "1.0.0" });
    const started = await start(one.call);
    const two = await connect(host, { name: "next-client", version: "1.0.0" });
    await two.call("pipeline_next_step", { run_id: started.run_id });
    const three = await connect(host, { name: "complete-client", version: "1.0.0" });
    await three.call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "a",
      attempt: 1,
    });
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json", "a-2-1.json"]);
    const named = (await events(host, started.run_id)).map(
      (r) => (r.executor as { client: { value: { name: string } } }).client.value.name,
    );
    expect(named).toEqual(["start-client", "next-client", "complete-client"]);
    for (const c of [one, two, three]) await c.close();
  });

  test("v75e_repeat_serve_same_client_is_stored_once", async () => {
    const host = newHost({ CLAUDE_CODE_SESSION_ID: "s-1" });
    const { call, close } = await connect(host);
    const started = await start(call);
    for (let i = 0; i < 5; i++) await call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json"]);
    expect(await events(host, started.run_id)).toHaveLength(1);
    await close();
  });

  test("v75e_other_client_gets_its_own_file", async () => {
    const host = newHost();
    const one = await connect(host, { name: "claude-code", version: "2.0.0" });
    const started = await start(one.call);
    const two = await connect(host, { name: "codex", version: "0.5.0" });
    await two.call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json"]);
    expect((await events(host, started.run_id)).map((r) => r.n)).toEqual([1, 2]);
    await one.close();
    await two.close();
  });

  test("v75e_client_version_change_gets_its_own_file", async () => {
    const host = newHost();
    const one = await connect(host, { name: "claude-code", version: "2.0.0" });
    const started = await start(one.call);
    const two = await connect(host, { name: "claude-code", version: "2.0.1" });
    await two.call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json"]);
    await one.close();
    await two.close();
  });

  test("v75e_other_session_gets_its_own_file", async () => {
    const first = newHost({ CLAUDE_CODE_SESSION_ID: "s-1" });
    const one = await connect(first);
    const started = await start(one.call);
    await one.close();
    const second = newHost({ CLAUDE_CODE_SESSION_ID: "s-2" });
    const two = await connect(second);
    await two.call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json"]);
    await two.close();
  });

  test("v75e_hook_session_does_not_flip_the_key", async () => {
    const line = (id: string, ts: string) =>
      `${JSON.stringify({ session_id: id, agent: "claude-code", cwd: dir, ts })}\n`;
    await writeFile(join(dir, ".kodel", "sessions.jsonl"), line("h1", "2026-01-01T00:00:00.000Z"));
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    // another window of the same project starts later: the index now names it
    await writeFile(
      join(dir, ".kodel", "sessions.jsonl"),
      line("h1", "2026-01-01T00:00:00.000Z") + line("h2", "2026-01-02T00:00:00.000Z"),
    );
    await call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json"]);
    const [event] = await events(host, started.run_id);
    expect(event?.executor).toMatchObject({ session: { value: "h1", source: "observed-hook" } });
    await close();
  });

  test("v75e_executor_off_key_is_prompt_hash_only", async () => {
    await setConfig("history:\n  executor:\n    enabled: false\n");
    const host = newHost();
    const one = await connect(host, { name: "claude-code", version: "2.0.0" });
    const started = await start(one.call);
    const two = await connect(host, { name: "codex", version: "0.5.0" });
    await two.call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["a-1-1.json"]);
    const [event] = await events(host, started.run_id);
    expect(event).not.toHaveProperty("executor");
    await one.close();
    await two.close();
  });

  test("v75e_rework_gets_new_attempt_file", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    // done without having changed anything: the diff check fails and the step comes back
    const lied = await call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "a",
      attempt: 1,
    });
    expect(lied.failed_check.kind).toBe("diff");
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-2-1.json"]);
    const second = await readFileOf(started.run_id, "a-2-1.json");
    expect(second.attempt).toBe(2);
    expect(second.answer.reentry_feedback).toContain(lied.failed_check.reason);
    expect(second.answer.reentry_feedback).toBe(lied.next.node.reentry_feedback);
    await close();
  });

  test("v75e_pipeline_change_changes_prompt_hash", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    // the file is edited under the run: the agent is told so, and what it is shown is not what it was
    await writeFile(
      join(dir, ".kodel", "pipelines", "two.yaml"),
      PIPELINE.replace("do a for", "do A differently for"),
    );
    const next = await call("pipeline_next_step", { run_id: started.run_id });
    expect(next.node.pipeline_change).toBeDefined();
    const [first, second] = await events(host, started.run_id);
    expect(second).toMatchObject({ node: "a", attempt: 1, n: 2 });
    expect(second?.prompt_hash).not.toBe(first?.prompt_hash);
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json"]);
    await close();
  });

  test("v75e_switch_off_stores_nothing", async () => {
    await setConfig("history:\n  prompts:\n    enabled: false\n");
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    await call("pipeline_next_step", { run_id: started.run_id });
    await call("pipeline_complete_step", { run_id: started.run_id, node_slug: "a", attempt: 1 });
    expect(await files(started.run_id)).toEqual([]);
    expect(await events(host, started.run_id)).toEqual([]);
    const run = await host.open(started.run_id);
    expect((await run?.state())?.served).toBeUndefined();
    expect((await run?.report())?.prompts).toEqual({ not_collected: true });
    await close();
  });

  test("v75e_answer_identical_with_and_without_recording", async () => {
    const on = await connect(newHost());
    const withRecord = await start(on.call, "same task");
    await on.close();
    await setConfig("history:\n  prompts:\n    enabled: false\n");
    const off = await connect(newHost());
    const without = await start(off.call, "same task again");
    await off.close();
    const strip = (s: Step) => ({ ...s.node, prompt: s.node?.prompt.replace(/ again$/, "") });
    expect(strip(without.next)).toEqual(strip(withRecord.next));
  });

  test("v75e_served_file_is_redacted", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call, `use the key ${secretOne}`);
    const text = await readFile(join(servedDir(started.run_id), "a-1-1.json"), "utf8");
    expect(text).not.toContain(secretOne);
    expect(text).toContain("[REDACTED:aws-key]");
    const lied = await call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "a",
      attempt: 1,
    });
    expect(lied.ok).toBe(true);
    // a secret in the feedback goes the same way
    const second = await readFile(join(servedDir(started.run_id), "a-2-1.json"), "utf8");
    expect(second).not.toContain(secretOne);
    await close();
  });

  test("v75e_hash_is_of_redacted_text", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const one = await start(call, `key ${secretOne}`);
    const two = await start(call, `key ${secretTwo}`);
    const hash = async (runId: string) => (await events(host, runId))[0]?.prompt_hash;
    expect(await hash(one.run_id)).toBeDefined();
    expect(await hash(one.run_id)).toBe(await hash(two.run_id));
    for (const runId of [one.run_id, two.run_id]) {
      const text = await readFile(join(servedDir(runId), "a-1-1.json"), "utf8");
      expect(text).not.toContain(secretOne);
      expect(text).not.toContain(secretTwo);
    }
    await close();
  });

  test("v75e_waiting_answer_stores_nothing", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call, "t", "gate");
    const done = await call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "work",
      attempt: 1,
    });
    expect(done.next.waiting).toBeDefined();
    const before = await files(started.run_id);
    for (let i = 0; i < 3; i++) {
      expect((await call("pipeline_next_step", { run_id: started.run_id })).waiting).toBeDefined();
    }
    expect(await files(started.run_id)).toEqual(before);
    expect(await events(host, started.run_id)).toHaveLength(1);
    await close();
  });

  test("v75e_running_answer_stores_nothing", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call, "t", "slow");
    expect(started.next.running).toBeDefined();
    expect((await call("pipeline_next_step", { run_id: started.run_id })).running).toBeDefined();
    expect(await files(started.run_id)).toEqual([]);
    expect(await events(host, started.run_id)).toEqual([]);
    await (await host.open(started.run_id))?.waitForRest(10_000);
    await close();
  });

  test("v75e_long_poll_stores_node_answer_once", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call, "t", "slow");
    const polled = await call("pipeline_next_step", { run_id: started.run_id, wait_s: 10 });
    expect(polled.node).toMatchObject({ slug: "after", attempt: 1 });
    expect(await files(started.run_id)).toEqual(["after-1-1.json"]);
    await call("pipeline_next_step", { run_id: started.run_id });
    expect(await files(started.run_id)).toEqual(["after-1-1.json"]);
    await close();
  });

  test("v75e_ended_run_stores_nothing", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    const run = await host.open(started.run_id);
    await run?.apply({ type: "cancel" });
    const after = await call("pipeline_next_step", { run_id: started.run_id });
    expect(after.node).toBeUndefined();
    expect(await events(host, started.run_id)).toHaveLength(1);
    await close();
  });

  test("v75e_internal_next_step_stores_nothing", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    const run = await host.open(started.run_id);
    // the host looking at the run for itself: no `serve`, so nothing is recorded
    await run?.nextStep();
    await run?.nextStep({ atCompletion: true });
    expect(await events(host, started.run_id)).toHaveLength(1);
    await close();
  });

  test("v75e_file_cap_per_attempt_still_returns_answer", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    const run = await host.open(started.run_id);
    for (let i = 0; i < 25; i++) {
      const step = await run?.nextStep({ serve: { caller: caller(`client-${i}`) } });
      expect(step).toMatchObject({ node: { slug: "a", attempt: 1 } });
    }
    expect(await files(started.run_id)).toHaveLength(20);
    expect(await events(host, started.run_id)).toHaveLength(20);
    await close();
  });

  test("v75e_concurrent_serves_get_distinct_numbers", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    const run = await host.open(started.run_id);
    await Promise.all([
      run?.nextStep({ serve: { caller: caller("one") } }),
      run?.nextStep({ serve: { caller: caller("two") } }),
    ]);
    const numbers = (await events(host, started.run_id)).map((r) => r.n).sort();
    expect(numbers).toEqual([1, 2, 3]);
    expect(await files(started.run_id)).toEqual(["a-1-1.json", "a-1-2.json", "a-1-3.json"]);
    await close();
  });

  test("v75e_huge_prompt_is_cut_and_valid", async () => {
    const host = newHost();
    const { run } = await host.start({
      pipeline: "two",
      task: "x ".repeat(200_000),
      restart: false,
    });
    await run.nextStep({ serve: { caller: caller("a") } });
    const [name] = await files(run.runId);
    expect(name).toBe("a-1-1.json");
    const text = await readFile(join(servedDir(run.runId), name as string), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SERVED_MAX_BYTES);
    const file = JSON.parse(text) as Served;
    expect(file.truncated).toBe(true);
    expect(file.answer.prompt).toContain("[cut:");
    const [event] = await events(host, run.runId);
    expect(file.prompt_hash).toBe(event?.prompt_hash as string);
  });

  test("v75e_write_error_does_not_fail_the_answer", async () => {
    const host = newHost();
    const { call, close } = await connect(host);
    const started = await start(call);
    // a regular file where the folder should be: the file cannot be written, on every platform
    await rm(servedDir(started.run_id), { recursive: true, force: true });
    await writeFile(servedDir(started.run_id), "not a folder");
    const run = await host.open(started.run_id);
    const step = await run?.nextStep({ serve: { caller: caller("other") } });
    expect(step).toMatchObject({ node: { slug: "a", attempt: 1 } });
    const failed = await events(host, started.run_id, "served_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ node: "a", attempt: 1, n: 2 });
    expect(JSON.stringify(failed[0])).not.toContain(dir);
    // the event is there, the file is not: a reader finds nothing, which is "not stored"
    await expect(readFile(join(servedDir(started.run_id), "a-1-2.json"), "utf8")).rejects.toThrow();
    await close();
  });

  test("v75e_report_new_run_says_zero_and_counts_serves", async () => {
    const host = newHost();
    const { run } = await host.start({
      pipeline: "two",
      task: "nothing served yet",
      restart: false,
    });
    const local = await host.open(run.runId);
    expect((await local?.report())?.prompts).toEqual({ served: 0 });
    await run.nextStep({ serve: { caller: caller("one") } });
    await run.nextStep({ serve: { caller: caller("two") } });
    expect((await local?.report())?.prompts).toEqual({ served: 2 });
  });
});

describe("the cut of a served file", () => {
  const file = (answer: Record<string, unknown>): ServedFile => ({
    v: 1,
    node: "a",
    attempt: 1,
    n: 1,
    prompt_hash: promptHashOf(answer),
    answer,
  });

  test("v75e_prompt_hash_is_stable_and_follows_every_field", () => {
    const base = { slug: "a", attempt: 1, prompt: "p", result_spec: { x: 1 }, outcomes: ["o"] };
    expect(promptHashOf({ ...base })).toBe(promptHashOf({ ...base, prompt: "p" }));
    for (const change of [
      { reentry_feedback: "it failed" },
      { prompt: "q" },
      { result_spec: { x: 2 } },
      { outcomes: ["p"] },
      { pipeline_change: { hash: "h" } },
    ]) {
      expect(promptHashOf({ ...base, ...change })).not.toBe(promptHashOf(base));
    }
  });

  test("a small file is left as it is", () => {
    const small = file({ slug: "a", attempt: 1, prompt: "p" });
    expect(fitServed(small)).toBe(small);
  });

  test("v75e_huge_result_spec_is_replaced_by_a_marker", () => {
    const huge = file({
      slug: "a",
      attempt: 1,
      prompt: "p",
      result_spec: { rows: "x".repeat(SERVED_MAX_BYTES * 2) },
    });
    const cut = fitServed(huge);
    expect(cut.truncated).toBe(true);
    expect(cut.answer.result_spec).toEqual({ omitted: true });
    expect(cut.answer.prompt).toBe("p");
    expect(Buffer.byteLength(JSON.stringify(cut, null, 2))).toBeLessThanOrEqual(SERVED_MAX_BYTES);
  });

  test("prompts that differ only after the cut hash differently", () => {
    const a = "x".repeat(SERVED_MAX_BYTES * 2);
    const one = file({ slug: "a", attempt: 1, prompt: `${a}1` });
    const two = file({ slug: "a", attempt: 1, prompt: `${a}2` });
    expect(one.prompt_hash).not.toBe(two.prompt_hash);
    expect(fitServed(one).answer.prompt).toBe(fitServed(two).answer.prompt);
  });

  test("the feedback is cut after the prompt, and an instruction after both", () => {
    const big = "y".repeat(SERVED_MAX_BYTES);
    const cut = fitServed(
      file({
        slug: "a",
        attempt: 1,
        prompt: "p".repeat(10),
        reentry_feedback: big,
        execution: { instruction: big },
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(cut, null, 2))).toBeLessThanOrEqual(SERVED_MAX_BYTES);
    expect(cut.answer.prompt).toBe("p".repeat(10));
  });
});

describe("t40 the cut of a served file with several steps", () => {
  test("t40_fit_served_cuts_steps", () => {
    const steps = Array.from({ length: 4 }, (_, i) => ({
      slug: `s${i}`,
      kind: "agent",
      attempt: 1,
      prompt: "x".repeat(SERVED_MAX_BYTES / 2),
    }));
    const file: ServedFile = {
      v: 1,
      node: "s0",
      attempt: 1,
      n: 1,
      prompt_hash: promptHashOf({}),
      answer: { slug: "s0", attempt: 1, prompt: "short", steps },
    };
    const cut = fitServed(file);
    expect(cut.truncated).toBe(true);
    expect(cut.answer.steps).toEqual({ omitted: true });
    expect(cut.answer.prompt).toBe("short");
    expect(Buffer.byteLength(JSON.stringify(cut, null, 2))).toBeLessThanOrEqual(SERVED_MAX_BYTES);
  });
});

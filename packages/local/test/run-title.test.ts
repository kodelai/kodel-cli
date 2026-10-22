import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineService, type RunState } from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalPipelineHost } from "../src";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-title-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  // Most of these tests are about the run record, not its worktree.
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DEMO = [
  "name: demo",
  "description: A pipeline whose prompt names the run.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write docs/plans/{{run.start_date}}-{{run.slug}}.md for {{task}}",
  "    checks:",
  '      - { kind: diff, paths: ["docs/plans/{{run.start_date}}-{{run.slug}}.md"] }',
  "",
].join("\n");

const DAY = Date.UTC(2026, 9, 20, 23, 30);

async function connect(options: Partial<ConstructorParameters<typeof LocalPipelineHost>[0]> = {}) {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0, clock: () => DAY, ...options });
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
  return { host, call, close: () => Promise.all([client.close(), server.close()]) };
}

const stateOf = async (runId: string) =>
  JSON.parse(await readFile(join(dir, ".kodel", "runs", runId, "state.json"), "utf8")) as RunState;

describe("a run title from the agent", () => {
  test("the slug is stored in the state, the record of the run and the journal, and fills the step", async () => {
    const { host, call, close } = await connect();
    const started = await call("pipeline_start", {
      task: "add a title to runs",
      title: "run-title-field",
    });
    expect(started.body.ok).toBe(true);
    expect(started.body.next.node.prompt).toBe(
      "write docs/plans/2026-10-20-run-title-field.md for add a title to runs",
    );
    const runId = started.body.run_id as string;

    expect((await stateOf(runId)).slug).toBe("run-title-field");
    const meta = JSON.parse(
      await readFile(join(dir, ".kodel", "runs", runId, "meta.json"), "utf8"),
    );
    expect(meta.slug).toBe("run-title-field");
    const journal = await readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
    expect(journal).toContain('"slug":"run-title-field"');
    expect((await host.runSummaries())[0]?.meta.slug).toBe("run-title-field");
    await close();
  });

  test("without a title the slug is made from the task text", async () => {
    const { call, close } = await connect();
    const started = await call("pipeline_start", { task: "Fix login #42!" });
    expect(started.body.next.node.prompt).toContain("docs/plans/2026-10-20-fix-login-42.md");
    expect((await stateOf(started.body.run_id)).slug).toBe("fix-login-42");
    await close();
  });

  test("a title the engine refuses says why, naming the field, and no run is made", async () => {
    const { call, close } = await connect();
    for (const title of ["Not Kebab", "", "a..b", "x".repeat(41), "-a"]) {
      const refused = await call("pipeline_start", { task: "t", title });
      expect(refused.body).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
      expect(refused.body.message).toStartWith("title ");
      expect(refused.body.issues).toEqual([{ path: ["title"], message: expect.any(String) }]);
    }
    expect(await readdir(join(dir, ".kodel", "runs")).catch(() => [])).toEqual([]);
    await close();
  });

  test("a refused title leaves no worktree and no branch behind", async () => {
    await rm(join(dir, ".kodel", "config.yaml"));
    git("add", "-A");
    git("commit", "-q", "-m", "worktrees on");
    const branches = git("branch", "--list").trim();
    const { call, close } = await connect();

    const refused = await call("pipeline_start", { task: "t", title: "Bad Title" });
    expect(refused.body.code).toBe("INVALID_ARGUMENTS");
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(git("branch", "--list").trim()).toBe(branches);
    await expect(access(join(dir, ".kodel", "worktrees"))).rejects.toThrow();

    // The same start with a good title does make them: the check above is not an empty one.
    const ok = await call("pipeline_start", { task: "t", title: "good-title" });
    expect(ok.body.ok).toBe(true);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(2);
    await close();
  });

  test("a title that redaction would change is refused", async () => {
    const { call, close } = await connect({
      rules: [{ name: "internal", pattern: /secret-[a-z]+/g }],
    });
    const refused = await call("pipeline_start", { task: "t", title: "secret-project" });
    expect(refused.body).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(refused.body.message).toContain("secret");
    expect(await readdir(join(dir, ".kodel", "runs")).catch(() => [])).toEqual([]);
    await close();
  });

  test("picking up the active run keeps its title, and a new valid title is ignored", async () => {
    const { call, close } = await connect();
    const first = await call("pipeline_start", { task: "same task", title: "first-name" });
    const again = await call("pipeline_start", { task: "same task", title: "second-name" });
    expect(again.body).toMatchObject({ reused: true, run_id: first.body.run_id });
    expect(again.body.next.node.prompt).toContain("2026-10-20-first-name.md");
    expect((await stateOf(first.body.run_id)).slug).toBe("first-name");
    // It is not looked at when ignored, but a bad one is still a bad call: the answer does not depend on the run.
    const bad = await call("pipeline_start", { task: "same task", title: "Second Name" });
    expect(bad.body.code).toBe("INVALID_ARGUMENTS");
    await close();
  });

  test("restart after the run ended is a new run with the new title", async () => {
    const { host, call, close } = await connect();
    const first = await call("pipeline_start", { task: "same task", title: "first-name" });
    await mkdir(join(dir, "docs", "plans"), { recursive: true });
    await writeFile(join(dir, "docs", "plans", "2026-10-20-first-name.md"), "plan\n");
    const done = await call("pipeline_complete_step", {
      run_id: first.body.run_id,
      node_slug: "write",
      attempt: 1,
    });
    expect(done.body).toMatchObject({ ok: true, advanced: true });
    await (await host.open(first.body.run_id))?.waitForRest(10_000);

    const again = await call("pipeline_start", { task: "same task", title: "other-name" });
    expect(again.body).toMatchObject({ terminal: true, run_id: first.body.run_id });
    const restarted = await call("pipeline_start", {
      task: "same task",
      title: "other-name",
      restart: true,
    });
    expect(restarted.body.run_id).not.toBe(first.body.run_id);
    expect(restarted.body.next.node.prompt).toContain("2026-10-20-other-name.md");
    expect((await stateOf(restarted.body.run_id)).slug).toBe("other-name");
    expect((await stateOf(first.body.run_id)).slug).toBe("first-name");
    await close();
  });

  test("the slug is not unique: runs with one title are two runs, told apart by their ids", async () => {
    const { host, call, close } = await connect();
    const one = await call("pipeline_start", { task: "task one", title: "shared-name" });
    const two = await call("pipeline_start", { task: "task two", title: "shared-name" });
    expect(two.body.ok).toBe(true);
    expect(two.body.run_id).not.toBe(one.body.run_id);
    expect(two.body.reused).toBe(false);

    const summaries = await host.runSummaries();
    expect(summaries.map((s) => s.meta.slug)).toEqual(["shared-name", "shared-name"]);
    expect(new Set(summaries.map((s) => s.meta.runId)).size).toBe(2);
    // Neither is held up by the other.
    expect((await stateOf(one.body.run_id)).status).toBe("running");
    expect((await stateOf(two.body.run_id)).status).toBe("running");
    await close();
  });
});

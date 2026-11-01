import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_LOG,
  DEFAULT_HISTORY,
  DEFAULT_USAGE,
  KodelError,
  PipelineService,
  parsePipeline,
} from "@kodel-ai/pipeline-core";
import { registerPipelineTools } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalHost, LocalPipelineHost, type LocalRun } from "../src";

const PIPELINE = [
  "name: plain",
  "nodes:",
  "  - slug: first",
  "    kind: command",
  `    command: node -e "console.log('one')"`,
  "  - slug: second",
  "    kind: command",
  `    command: node -e "console.log('two')"`,
  "edges:",
  "  - { from: first, to: second }",
  "  - { from: first, to: second, when: failed }",
  "  - { from: second, to: first, when: failed }",
  "",
].join("\n");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-history-"));
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "plain.yaml"), PIPELINE);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const initGit = () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
};

// The runs of these tests work in the root: the worktree is tested in worktree.test.ts.
const config = (history = "") =>
  writeFile(join(dir, ".kodel", "config.yaml"), `worktree:\n  mode: off\n${history}`);
const newHost = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
const start = (host: LocalPipelineHost, task = "t") =>
  host.start({ pipeline: "plain", task, restart: false });

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(KodelError);
  return error as KodelError;
};

const startedRecord = async (host: LocalPipelineHost, runId: string) => {
  const journal = await (await host.open(runId))?.journal();
  return journal?.find((r) => r.event === "run_started");
};

describe("starting a run needs git when history.changes is on", () => {
  test("history_start_in_a_non_git_directory_fails_with_the_code_and_names_the_setting", async () => {
    await config();
    const error = await failure(start(newHost()));
    expect(error.code).toBe("GIT_REQUIRED");
    expect(error.message).toContain("history.changes.enabled");
    expect(error.message).toContain("false");
    expect(error.message).toContain("config.yaml");
  });

  test("history_start_in_a_non_git_directory_works_when_changes_is_off", async () => {
    await config("history:\n  changes: { enabled: false }\n");
    const host = newHost();
    const { run, status } = await start(host);
    expect(status).toBe("started");
    expect((await startedRecord(host, run.runId))?.history).toMatchObject({
      changes: { enabled: false },
    });
  });

  test("history_a_refused_start_leaves_no_run_behind", async () => {
    await config();
    const host = newHost();
    await failure(start(host));
    expect(await host.runSummaries()).toEqual([]);
  });

  test("history_start_in_a_git_repository_works_with_the_defaults", async () => {
    initGit();
    await config();
    const host = newHost();
    const { run } = await start(host);
    expect((await startedRecord(host, run.runId))?.history).toEqual({
      ...DEFAULT_HISTORY,
      agent_log: DEFAULT_AGENT_LOG,
      usage: DEFAULT_USAGE,
    });
  });

  test("history_start_in_a_subdirectory_of_a_repository_works", async () => {
    initGit();
    await mkdir(join(dir, "sub", ".kodel", "pipelines"), { recursive: true });
    await writeFile(join(dir, "sub", ".kodel", "pipelines", "plain.yaml"), PIPELINE);
    await writeFile(join(dir, "sub", ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
    const host = new LocalPipelineHost({ root: join(dir, "sub"), heartbeatMs: 0 });
    expect((await start(host)).status).toBe("started");
  });

  test("history_a_bare_repository_is_not_a_work_tree", async () => {
    execFileSync("git", ["init", "-q", "--bare"], { cwd: dir, stdio: "ignore" });
    await config();
    expect((await failure(start(newHost()))).code).toBe("GIT_REQUIRED");
  });

  test("history_a_missing_git_binary_gives_the_same_code", async () => {
    await config();
    const path = process.env.PATH;
    process.env.PATH = join(dir, "no-such-bin");
    try {
      const error = await failure(start(newHost()));
      expect(error.code).toBe("GIT_REQUIRED");
      expect(error.message).toContain("git is not installed");
    } finally {
      process.env.PATH = path;
    }
  });

  test("history_a_diff_check_outside_git_keeps_its_text_and_gets_the_code", async () => {
    await writeFile(
      join(dir, ".kodel", "pipelines", "plain.yaml"),
      [
        "name: plain",
        "nodes:",
        "  - slug: a",
        "    kind: agent",
        "    prompt: x",
        "    checks:",
        '      - { kind: diff, paths: ["x"] }',
        "",
      ].join("\n"),
    );
    await config("history:\n  changes: { enabled: false }\n");
    const error = await failure(start(newHost()));
    expect(error.code).toBe("GIT_REQUIRED");
    expect(error.message).toContain("this pipeline has a diff check");
  });
});

describe("a run that exists is picked up without git", () => {
  test("history_an_active_or_finished_run_is_reused_in_a_directory_without_git", async () => {
    await config("history:\n  changes: { enabled: false }\n");
    const host = newHost();
    const first = await start(host, "same task");
    await (first.run as LocalRun).settle();
    // The config is edited afterwards: patches are on and there is still no git.
    await config();
    const again = await start(newHost(), "same task");
    expect(again.status).toBe("terminal");
    expect(again.run.runId).toBe(first.run.runId);
    // A new task is a new run, and that one needs git.
    expect((await failure(start(newHost(), "another task"))).code).toBe("GIT_REQUIRED");
  });

  test("history_a_refused_start_with_worktrees_on_leaves_no_directory_behind", async () => {
    await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: auto\n");
    expect((await failure(start(newHost()))).code).toBe("GIT_REQUIRED");
    await expect(access(join(dir, ".kodel", "worktrees"))).rejects.toThrow();
    await expect(access(join(dir, ".kodel", "runs"))).rejects.toThrow();
  });
});

describe("a run started before the section existed", () => {
  test("history_run_started_without_history_is_read_as_before", async () => {
    initGit();
    const spec = parsePipeline(PIPELINE);
    const host = new LocalHost(spec, { root: dir, heartbeatMs: 0 });
    const { run } = await host.start("old style");
    await run.settle();
    const journal = await run.journal();
    expect(journal.find((r) => r.event === "run_started")).not.toHaveProperty("history");
    const reopened = await new LocalHost(spec, { root: dir, heartbeatMs: 0 }).open(run.runId);
    expect((await reopened?.state())?.status).toBe("completed");
  });
});

describe("run_started.history", () => {
  test("history_run_started_has_the_effective_values", async () => {
    initGit();
    await config(
      [
        "history:",
        "  changes: { exclude: ['secrets/**'], max_kb: 16 }",
        "  output: { enabled: false }",
        "  tool_log: { enabled: false }",
        "",
      ].join("\n"),
    );
    const host = newHost();
    const { run } = await start(host);
    expect((await startedRecord(host, run.runId))?.history).toEqual({
      changes: { enabled: true, exclude: ["secrets/**"], max_kb: 16 },
      output: { enabled: false, max_kb: 64 },
      prompts: { enabled: true },
      executor: { enabled: true },
      tool_log: { enabled: false },
      agent_log: DEFAULT_AGENT_LOG,
      usage: DEFAULT_USAGE,
    });
  });

  test("history_changing_the_config_mid_run_does_not_change_the_run", async () => {
    initGit();
    await config("history:\n  prompts: { enabled: false }\n");
    const host = newHost();
    const { run } = await start(host, "first");
    await config("history:\n  prompts: { enabled: true }\n  executor: { enabled: false }\n");
    const reopened = await newHost().open(run.runId);
    const record = (await reopened?.journal())?.find((r) => r.event === "run_started");
    expect(record?.history).toMatchObject({
      prompts: { enabled: false },
      executor: { enabled: true },
    });
    // A run started after the edit has the new values.
    const second = await start(host, "second");
    expect((await startedRecord(host, second.run.runId))?.history).toMatchObject({
      prompts: { enabled: true },
      executor: { enabled: false },
    });
  });

  test("history_a_config_that_cannot_be_read_stops_the_start_by_name", async () => {
    await config("history:\n  chnages: { enabled: false }\n");
    const error = await failure(start(newHost()));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("chnages");
  });
});

describe("the error reaches the agent", () => {
  test("history_pipeline_start_over_mcp_returns_the_code_and_the_setting", async () => {
    await config();
    const server = new McpServer({ name: "kodel-test", version: "0.0.0" });
    registerPipelineTools(server, new PipelineService(newHost(), { waitBudgetMs: 10_000 }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const result = await client.callTool({
      name: "pipeline_start",
      arguments: { pipeline: "plain", task: "t", cwd: dir, title: "try-it" },
    });
    const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({ ok: false, code: "GIT_REQUIRED" });
    expect(body.message).toContain("history.changes.enabled");
    await Promise.all([client.close(), server.close()]);
  });
});

/**
 * The manager's reads that live in the CLI (decision 5M9D): the daemon's record and the background
 * agents, through the manager tools. On Windows, where neither runs, they say why instead of failing,
 * and the inbox answers with the rest.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagerReads, LocalPipelineHost } from "@kodel-ai/local";
import type { ManagerHost } from "@kodel-ai/pipeline-core";
import { invokeManagerTool } from "@kodel-ai/pipeline-core/mcp";
import { managerPorts } from "../src/manager-ports";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PIPELINE = [
  "name: demo",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write it }",
  "  - { slug: approve, kind: human, prompt: Looks fine? }",
  "  - { slug: ship, kind: agent, prompt: ship it }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: ship }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

function project() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kodel-manager-ports-")));
  made.push(tmp);
  const root = join(tmp, "project");
  mkdirSync(join(root, ".kodel", "pipelines"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(root, ".kodel", "pipelines", "demo.yaml"), PIPELINE);
  writeFileSync(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  writeFileSync(join(root, ".gitignore"), ".kodel/runs\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  const host = new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
  });
  const manager = (platform: string): ManagerHost => ({
    ...createManagerReads({ host }),
    ...managerPorts({
      root,
      environment: { KODEL_STATE_DIR: join(tmp, "state"), PATH: process.env.PATH ?? "" },
      launcher: { exec: process.execPath, args: [join(import.meta.dir, "../src/main.ts")] },
      platform,
    }),
  });
  return { root, host, manager };
}

const call = (host: ManagerHost, name: string, args: Record<string, unknown> = {}) =>
  invokeManagerTool(host, name, args) as Promise<Record<string, Loose>>;

describe("5m9d the manager's reads of the CLI", () => {
  test("5m9d_manager_ports_on_windows_say_why", async () => {
    const { host, manager } = project();
    const started = await host.start({ pipeline: "demo", task: "a gate", restart: false });
    await started.run.completeStep("write", 1, "done");
    const windows = manager("win32");

    expect(await call(windows, "manager_serve_status")).toMatchObject({
      ok: true,
      serve: { state: "off", reason: expect.stringContaining("Windows") },
    });
    expect(await call(windows, "manager_agents")).toMatchObject({
      ok: true,
      agents: [],
      reason: expect.stringContaining("Windows"),
    });
    expect(await call(windows, "manager_agent_log", { id: "a_1" })).toMatchObject({
      ok: true,
      lines: [],
    });
    // The inbox answers with the rest: the gate is there.
    const inbox = await call(windows, "manager_inbox");
    expect(inbox.ok).toBe(true);
    expect(inbox.waiting).toEqual([
      expect.objectContaining({
        kind: "gate",
        run_id: started.run.runId,
        node_slug: "approve",
        attempt: 1,
      }),
    ]);
  }, 30_000);

  test("5m9d_manager_ports_read_the_daemon_and_the_agents", async () => {
    const { manager } = project();
    const here = manager(process.platform === "win32" ? "linux" : process.platform);
    // No daemon was started for this checkout, and no agent: the reads say so and write nothing.
    expect(await call(here, "manager_serve_status")).toMatchObject({
      ok: true,
      serve: { state: "off", reason: "no kodel serve runs for this project" },
    });
    const agents = await call(here, "manager_agents");
    expect(agents).toMatchObject({ ok: true, agents: [] });
    expect(agents.reason).toBeUndefined();
    expect(await call(here, "manager_agent_log", { id: "nobody" })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
  }, 30_000);
});

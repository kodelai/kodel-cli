/**
 * `cancelRun` over a real `LocalPipelineHost` (NE3N): a run this kodel cannot continue is refused
 * with what it is, and nothing is written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, META_VERSION } from "@kodel-ai/local";
import { type CancelPorts, cancelRun } from "../src/cancel-run";

const PIPELINE = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write it",
  "  - slug: approve",
  "    kind: human",
  "    prompt: ok?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-cancel-host-")));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), PIPELINE);
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  await writeFile(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const host = () => new LocalPipelineHost({ root: dir, heartbeatMs: 0 });

/** The ports the commands give `cancelRun`, over a real host; the agents are a record of calls. */
function ports(calls: string[]): CancelPorts {
  const h = host();
  return {
    open: (runId) => h.open(runId),
    withWorkerStartLock: (fn) => fn(),
    async finishWorkers(runId) {
      calls.push(`finish ${runId}`);
    },
  };
}

/** Every file of the run with its text, to show that nothing was written. */
async function filesOf(runId: string): Promise<Record<string, string>> {
  const root = join(dir, ".kodel", "runs", runId);
  const names = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const out: Record<string, string> = {};
  for (const name of names.sort()) out[name] = await readFile(name, "utf8");
  return out;
}

async function runWithMeta(v: number, task: string): Promise<string> {
  const { run } = await host().start({ pipeline: "demo", task, restart: false });
  await (await host().open(run.runId))?.settle();
  const path = join(dir, ".kodel", "runs", run.runId, "meta.json");
  const meta = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  meta.v = v;
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`);
  return run.runId;
}

describe("tne3n cancelRun over a real host", () => {
  test("tne3n_pre_versions_and_newer_runs_are_refused_apart_and_nothing_is_written", async () => {
    const old = await runWithMeta(1, "old");
    const newer = await runWithMeta(META_VERSION + 1, "newer");
    const calls: string[] = [];
    const before = { old: await filesOf(old), newer: await filesOf(newer) };

    const pre = await cancelRun(ports(calls), { runId: old, reason: "stale" });
    expect(pre.ok).toBe(false);
    if (!pre.ok) {
      expect(pre.error.code).toBe("UNSUPPORTED_FORMAT");
      expect(pre.error.message).toContain("cannot be canceled");
      expect(pre.error.message).not.toContain("upgrade kodel");
    }

    const up = await cancelRun(ports(calls), { runId: newer, reason: "stale" });
    expect(up.ok).toBe(false);
    if (!up.ok) {
      expect(up.error.code).toBe("UNSUPPORTED_FORMAT");
      expect(up.error.message).toContain("upgrade kodel");
      expect(up.error.message).not.toContain("cannot be canceled");
    }

    expect(calls).toEqual([]);
    expect(await filesOf(old)).toEqual(before.old);
    expect(await filesOf(newer)).toEqual(before.newer);
  });

  test("tne3n_a_supported_run_is_canceled_through_the_same_ports", async () => {
    const { run } = await host().start({ pipeline: "demo", task: "t", restart: false });
    const calls: string[] = [];
    const answer = await cancelRun(ports(calls), { runId: run.runId, reason: "not needed" });
    expect(answer).toMatchObject({ ok: true, status: "canceled", noop: false });
    expect(calls).toEqual([`finish ${run.runId}`]);
  });
});

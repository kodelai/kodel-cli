import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost, resolveStoragePlace } from "@kodel-ai/local";
import type { PipelineService } from "@kodel-ai/pipeline-core";
import { createAgentDecider } from "../src/agent-decisions";
import { newDialogState } from "../src/elicit";

setDefaultTimeout(30_000);

const ID = "demo-aaaa1111";
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

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-agent-foreign-")));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function clone(name: string): Promise<string> {
  const root = join(tmp, name);
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(
    join(root, ".kodel", "config.yaml"),
    `worktree:\n  mode: "off"\nstorage: home\nproject_id: ${ID}\n`,
  );
  return root;
}

const hostFor = async (root: string) =>
  new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: join(tmp, "hashes"),
    storage: await resolveStoragePlace({
      root,
      dataDir: join(root, ".kodel"),
      env: { KODEL_STATE_DIR: join(tmp, "base") },
    }),
  });

describe("an agent deciding for a person", () => {
  test("storage_agent_decisions_refuse_a_foreign_run", async () => {
    const a = await clone("clone-a");
    const b = await clone("clone-b");
    const hostA = await hostFor(a);
    const { run } = await hostA.start({ pipeline: "demo", task: "t", restart: false });
    await run.completeStep("write", 1);
    await run.waitForRest(5_000);
    const decider = createAgentDecider(await hostFor(b), newDialogState());
    // The service is only asked after a decision was taken; a refusal does not reach it.
    const service = undefined as unknown as PipelineService;
    const gate = await decider.decideGate(service, {
      run_id: run.runId,
      node_slug: "approve",
      attempt: 1,
      decision: "approved",
      instruction: "approve it",
    });
    expect(gate).toMatchObject({ ok: false, code: "WORKDIR_INVALID" });
    const change = await decider.acceptChange(service, {
      run_id: run.runId,
      change_hash: "0".repeat(16),
      instruction: "accept it",
    });
    expect(change).toMatchObject({ ok: false, code: "WORKDIR_INVALID" });
    // And nothing was decided: the run still waits at the gate.
    expect((await run.state()).active.some((v) => v.phase === "human")).toBe(true);
  });
});

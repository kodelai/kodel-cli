/**
 * Forks on the real host (T-40): what reaches the disk goes through redaction, and the records a run
 * writes carry run-state format 2 while the other records keep their own versions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline, RECORD_VERSION } from "@kodel-ai/pipeline-core";
import { LocalHost, META_VERSION } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-fork-host-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Reference secret, assembled at run time so this file does not trip secret scanners.
const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

/** Two command branches; `b` prints a secret and fails, and its failure arrives at the join. */
const FORK = parsePipeline(
  [
    "name: fork",
    "nodes:",
    "  - { slug: plan, kind: agent, prompt: plan }",
    `  - { slug: a, kind: command, command: "node -e \\"console.log('a ok')\\"" }`,
    `  - { slug: b, kind: command, command: "node -e \\"console.log('token ${SECRET} leaked'); process.exit(1)\\"" }`,
    "  - { slug: merge, kind: agent, prompt: merge, join: all }",
    "edges:",
    "  - { from: plan, to: a }",
    "  - { from: plan, to: b }",
    "  - { from: a, to: merge }",
    "  - { from: a, to: merge, when: failed }",
    "  - { from: b, to: merge }",
    "  - { from: b, to: merge, when: failed }",
    "",
  ].join("\n"),
);

const host = () => new LocalHost(FORK, { root: dir, heartbeatMs: 0 });
const runDir = (id: string) => join(dir, ".kodel", "runs", id);

describe("t40 forks on the host", () => {
  test("t40_host_fork_records_are_redacted_and_carry_format_2", async () => {
    const h = host();
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    const state = await run.state();
    expect(state.active.map((v) => v.node)).toEqual(["merge"]);
    expect(state.forks?.f1?.arrived.b).toMatchObject({ node: "b", label: "failed" });
    const journal = await h.store.readJournal(run.runId);
    expect(journal.map((r) => r.event)).toContain("fork_started");
    expect(journal.map((r) => r.event)).toContain("join_reached");

    // the secret the command printed is in no record on disk: not in the branch's settlement, not
    // in what the join is told, not in the state
    const files = (await readdir(runDir(run.runId), { recursive: true })).filter((f) =>
      /\.(json|jsonl)$/.test(f),
    );
    for (const file of files) {
      const text = await readFile(join(runDir(run.runId), file), "utf8");
      expect(text, file).not.toContain(SECRET);
    }
    const settled = journal.find((r) => r.event === "branch_settled" && r.branch === "b");
    expect(String(settled?.reason)).toContain("[REDACTED");
    const reached = journal.find((r) => r.event === "join_reached");
    expect(JSON.stringify(reached?.feedbacks)).toContain("[REDACTED");
    expect(state.nodes.merge?.lastFailures?.[0]?.reason).toContain("[REDACTED");
    expect(state.forks?.f1?.arrived.b?.failure?.reason).toContain("[REDACTED");

    // the state and every journal record carry run-state format 2; meta keeps its own version
    expect(state.v).toBe(RECORD_VERSION);
    expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
    const meta = JSON.parse(await readFile(join(runDir(run.runId), "meta.json"), "utf8"));
    expect(meta.v).toBe(META_VERSION);
    expect(RECORD_VERSION).toBe(2);
  });

  test("t40_journal_and_state_carry_v2_other_records_keep_theirs", async () => {
    const h = host();
    const { run } = await h.start("split the work");
    await run.completeStep("plan", 1);
    await run.waitForRest(10_000);
    await run.completeStep("merge", 1);
    await run.waitForRest(10_000);
    expect((await run.state()).status).toBe("completed");
    const state = JSON.parse(await readFile(join(runDir(run.runId), "state.json"), "utf8"));
    expect(state.v).toBe(2);
    const journal = (await readFile(join(runDir(run.runId), "journal.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            v: number;
            event: string;
            engine?: { record_version: number; meta_version: number };
          },
      );
    expect(journal.every((r) => r.v === 2)).toBe(true);
    // the seal and the meta file are their own formats, unchanged by the break
    const seal = JSON.parse(await readFile(join(runDir(run.runId), "seal.json"), "utf8"));
    expect(seal.v).toBe(1);
    const meta = JSON.parse(await readFile(join(runDir(run.runId), "meta.json"), "utf8"));
    expect(meta.v).toBe(2);
    expect(META_VERSION).toBe(2);
    // and the engine record names the run-state format it writes
    const started = journal.find((r) => r.event === "run_started");
    if (started?.engine) {
      expect(started.engine.record_version).toBe(2);
      expect(started.engine.meta_version).toBe(2);
    }
  });
});

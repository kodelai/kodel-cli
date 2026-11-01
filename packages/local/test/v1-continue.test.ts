/**
 * A run of run-state format 1 goes on in format 1 (TASK-5ZCN, decision T-41): the real engine of
 * `12f8578` made the fixtures in `fixtures/formats/v1-open/`; here the current engine continues them.
 * The copy of a fixture gets a real working directory (the fixture holds a placeholder, which does
 * not exist) and a fresh integrity directory; nothing else is changed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, join as pathJoin, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost } from "../src";

const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);
const GATE = "r_0mvxulus6_0m28";
const PAUSED = "r_0mvxulvel_5xgk";
const DUP_EDGE = "r_0mvxulxyp_gmed";

let tmp: string;
let root: string;

const runDir = (id: string) => join(root, ".kodel", "runs", id);
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const journalLines = async (id: string) =>
  (await readFile(join(runDir(id), "journal.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { v: number; event: string; seq: number });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel v1-continue-"));
  root = join(tmp, "repo");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A fixture run copied into the store, its workdir (a placeholder in the fixture) made real. */
async function copyFixture(id: string): Promise<void> {
  await cp(join(FORMATS, "v1-open", id), runDir(id), { recursive: true });
  const statePath = join(runDir(id), "state.json");
  const state = await readJson(statePath);
  await writeFile(statePath, `${JSON.stringify({ ...state, workdir: root }, null, 2)}\n`);
  const metaPath = join(runDir(id), "meta.json");
  const meta = await readJson(metaPath);
  if (typeof meta.workdir === "string") {
    await writeFile(metaPath, `${JSON.stringify({ ...meta, workdir: root }, null, 2)}\n`);
  }
}

const hostFor = () =>
  new LocalPipelineHost({ root, heartbeatMs: 0, integrityDir: join(tmp, "integrity") });

describe("a run of format 1 goes on in format 1", () => {
  test("t41_d8_v1_first_step_is_not_refused: a gate decision enters the next step", async () => {
    await copyFixture(GATE);
    const before = (await journalLines(GATE)).length;
    const run = await hostFor().open(GATE);
    expect(run).toBeDefined();
    const decision = await run?.decideHuman("approve", "approved");
    expect(decision?.ok).toBe(true);
    // still format 1: the state and every line of the journal, old and new
    const state = await readJson(join(runDir(GATE), "state.json"));
    expect(state.v).toBe(1);
    expect("pauses" in state).toBe(false);
    const lines = await journalLines(GATE);
    expect(lines.length).toBeGreaterThan(before);
    expect(lines.every((line) => line.v === 1)).toBe(true);
    // nothing from a later format was written into the state
    for (const visit of (state.active as Record<string, unknown>[]) ?? []) {
      expect("spec" in visit).toBe(false);
      expect("fork" in visit).toBe(false);
    }
    expect(await readdir(runDir(GATE))).toContain("journal.jsonl");
  });

  const FORKED = [
    "version: 1",
    "name: forked",
    "nodes:",
    "  - { slug: a, kind: agent, prompt: a }",
    "  - { slug: x, kind: agent, prompt: x }",
    "  - { slug: y, kind: agent, prompt: y }",
    "  - { slug: m, kind: agent, prompt: m, join: all }",
    "edges:",
    "  - { from: a, to: x }",
    "  - { from: a, to: y }",
    "  - { from: x, to: m }",
    "  - { from: y, to: m }",
    "",
  ].join("\n");

  /** The path and the hash of every file under a directory, to see that nothing was written. */
  async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = pathJoin(entry.parentPath, entry.name);
      out[relative(dir, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
    return out;
  }

  test("t41_d2_v1_refuses_a_join_before_anything_is_written", async () => {
    await copyFixture(PAUSED);
    const run = await hostFor().open(PAUSED);
    expect(run).toBeDefined();
    const before = await snapshot(runDir(PAUSED));
    // proposed by the agent: refused at the proposal, with the way up named in the text
    const proposed = await run?.proposeChange({ yaml: FORKED, summary: "fork it" });
    expect(proposed?.ok).toBe(false);
    if (proposed && !proposed.ok) {
      expect(proposed.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
      expect(proposed.message).toContain("run-state format 1");
      expect(proposed.message).toContain("upgrade");
    }
    // accepted by a person (a file edit): refused before the new version is kept with the run
    const accepted = await run?.acceptChange({ source: "file", text: FORKED });
    expect(accepted?.ok).toBe(false);
    if (accepted && !accepted.ok) expect(accepted.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
    // not one byte of the run changed, and no copy of the refused pipeline was kept
    expect(await snapshot(runDir(PAUSED))).toEqual(before);
  });

  test("t41_v1_paused_run_resumes_and_stays_format_1", async () => {
    await copyFixture(PAUSED);
    const run = await hostFor().open(PAUSED);
    const decision = await run?.resume();
    expect(decision?.ok).toBe(true);
    await run?.waitForRest(10_000);
    const state = await readJson(join(runDir(PAUSED), "state.json"));
    expect(state.v).toBe(1);
    expect("pauses" in state).toBe(false);
    const lines = await journalLines(PAUSED);
    expect(lines.some((line) => line.event === "run_resumed")).toBe(true);
    expect(lines.every((line) => line.v === 1)).toBe(true);
    // whatever the run did after, the file is one the format can hold: it opens again
    expect(await hostFor().open(PAUSED)).toBeDefined();
  });

  test("t41_v1_run_takes_the_first_edge_of_two_equal_ones", async () => {
    // the fixture was made by the old engine, which entered `first`: its kept pipeline is read the
    // old way, and the run opens and reports on it
    await copyFixture(DUP_EDGE);
    const run = await hostFor().open(DUP_EDGE);
    const spec = await run?.currentSpec();
    expect(spec?.firstDuplicateEdgeWins).toBe(true);
    const state = await run?.state();
    expect(state?.active.map((v) => v.node)).toEqual(["first"]);
  });
});

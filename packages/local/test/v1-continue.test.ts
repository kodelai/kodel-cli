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
import { dirname, join, join as pathJoin, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost } from "../src";
import { FileStore } from "../src/store";

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
    // and it is what the old engine recorded for the same run
    const recording = JSON.parse(
      await readFile(join(FORMATS, "v1-open", "routing-result.json"), "utf8"),
    ) as { target_entered: string; target_attempt: number };
    const entered = state?.active.find((v) => v.node === recording.target_entered);
    expect(entered?.attempt).toBe(recording.target_attempt);
  });

  test("t41_snapshot_unchecked_journal_cannot_read", async () => {
    // an upgraded run whose upgrade mark is gone, beside journal lines that claim format 1: the
    // lines are not believed, so an edited `v` cannot switch the old reading rule on
    const run = await trustedGateRun();
    await run.migrate();
    const path = join(runDir(GATE), "journal.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    await writeFile(path, `${lines.filter((l) => !l.includes('"run_migrated"')).join("\n")}\n`);
    const error = await hostFor()
      .open(GATE)
      .then(
        (r) =>
          r?.currentSpec().then(
            () => undefined,
            (e: unknown) => e as { code?: string },
          ),
        (e: unknown) => e as { code?: string },
      );
    expect(error?.code).toBe("UNSUPPORTED_FORMAT");
  });

  test("t41_d3_meta_format_1_run_is_read_not_continued", async () => {
    await copyFixture(DUP_EDGE);
    const metaPath = join(runDir(DUP_EDGE), "meta.json");
    const meta = await readFile(metaPath, "utf8");
    await writeFile(metaPath, meta.replace('"v": 2', '"v": 1'));
    const store = new FileStore({ root: join(root, ".kodel") });
    // a lookup of the latest run passes it over; it never reaches a start or a report
    expect(await store.findLatest("dup-edge", "add a small helper")).toBeUndefined();
    // when it is still open it blocks a new run, and says why
    const peek = await store.peekState(DUP_EDGE);
    if (peek?.status === "running" || peek?.status === "paused") {
      await expect(store.findActive("dup-edge", "add a small helper")).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    } else {
      expect(await store.findActive("dup-edge", "add a small helper")).toBeUndefined();
    }
  });

  /** The files of a run other than its state and its journal: the ones an upgrade must not touch. */
  const others = async (id: string) => {
    const all = await snapshot(runDir(id));
    delete all["state.json"];
    delete all["journal.jsonl"];
    return all;
  };

  /** A gate run that this machine has written, so its state is one it vouches for. */
  async function trustedGateRun() {
    await copyFixture(GATE);
    const run = await hostFor().open(GATE);
    if (!run) throw new Error("the fixture does not open");
    // sent back: the run is open again at its first step, and this machine has written its state
    expect((await run.decideHuman("approve", "rejected", "needs work")).ok).toBe(true);
    return run;
  }

  test("t41_d2_migrate_takes_an_open_v1_run_to_the_current_format", async () => {
    const run = await trustedGateRun();
    const journalBefore = await readFile(join(runDir(GATE), "journal.jsonl"), "utf8");
    const othersBefore = await others(GATE);

    const result = await run.migrate();
    expect(result).toEqual({ status: "migrated", from: 1, to: 2 });

    const state = await readJson(join(runDir(GATE), "state.json"));
    expect(state.v).toBe(2);
    expect(Array.isArray(state.pauses)).toBe(true);
    // the earlier lines are byte for byte as they were; one line is added, of the newest format
    const journalAfter = await readFile(join(runDir(GATE), "journal.jsonl"), "utf8");
    expect(journalAfter.startsWith(journalBefore)).toBe(true);
    const added = journalAfter.slice(journalBefore.length).trim().split("\n");
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0] ?? "")).toMatchObject({
      v: 2,
      event: "run_migrated",
      from: 1,
      to: 2,
    });
    // nothing else of the run was touched
    expect(await others(GATE)).toEqual(othersBefore);

    // the run reads as one: a journal of two formats, a state of the newest
    const reopened = await hostFor().open(GATE);
    expect((await reopened?.state())?.v).toBe(2);
    const lines = await journalLines(GATE);
    expect(new Set(lines.map((line) => line.v))).toEqual(new Set([1, 2]));
    expect((await reopened?.report())?.runId).toBe(GATE);
    // what the older format could not hold is no longer refused for its format
    const proposed = await reopened?.proposeChange({ yaml: FORKED, summary: "fork it" });
    if (proposed && !proposed.ok) expect(proposed.code).not.toBe("UNSUPPORTED_FORMAT_FEATURE");
  });

  test("t41_migrate_is_idempotent_and_writes_a_missing_mark", async () => {
    const run = await trustedGateRun();
    expect((await run.migrate()).status).toBe("migrated");
    const after = await snapshot(runDir(GATE));
    expect((await run.migrate()).status).toBe("already_current");
    expect(await snapshot(runDir(GATE))).toEqual(after);
    // a crash between the two writes: the state is of the newest format and the line is lost
    const path = join(runDir(GATE), "journal.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    await writeFile(path, `${lines.slice(0, -1).join("\n")}\n`);
    expect((await run.migrate()).status).toBe("marked");
    const last = (await journalLines(GATE)).at(-1);
    expect(last).toMatchObject({ v: 2, event: "run_migrated" });
    expect((await run.migrate()).status).toBe("already_current");
  });

  test("t41_migrate_refuses_what_it_should_and_changes_nothing", async () => {
    // a state this machine never recorded: it cannot tell whether it was changed
    await copyFixture(GATE);
    const fresh = await hostFor().open(GATE);
    let before = await snapshot(runDir(GATE));
    await expect(fresh?.migrate()).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(await snapshot(runDir(GATE))).toEqual(before);

    // a finished run is read as it is
    await rm(runDir(GATE), { recursive: true });
    await cp(join(FORMATS, "v1", "r_0mviewgvl_i1ig"), runDir("r_0mviewgvl_i1ig"), {
      recursive: true,
    });
    const finished = await hostFor().open("r_0mviewgvl_i1ig");
    await expect(finished?.migrate()).rejects.toMatchObject({ code: "NODE_NOT_RUNNING" });

    // a state changed after kodel wrote it
    await rm(runDir("r_0mviewgvl_i1ig"), { recursive: true });
    const run = await trustedGateRun();
    const statePath = join(runDir(GATE), "state.json");
    const original = await readFile(statePath, "utf8");
    await writeFile(
      statePath,
      `${JSON.stringify({ ...(JSON.parse(original) as object), trail: ["x"] }, null, 2)}\n`,
    );
    await expect(run.migrate()).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
    await writeFile(statePath, original);

    // a run with no kept pipeline (a meta of the format before pipelines were kept)
    const metaPath = join(runDir(GATE), "meta.json");
    const meta = await readFile(metaPath, "utf8");
    await writeFile(metaPath, meta.replace('"v": 2', '"v": 1'));
    await expect(run.migrate()).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await writeFile(metaPath, meta);

    // a change of the pipeline that waits for the person
    const state = await readJson(statePath);
    const kept = await readFile(
      join(runDir(GATE), "specs", `${String(state.specHash)}.yaml`),
      "utf8",
    );
    const pipelineFile = join(root, String(state.pipelineFile));
    await mkdir(dirname(pipelineFile), { recursive: true });
    // a change in what the pipeline means (a prompt), not in a comment or its description
    await writeFile(pipelineFile, kept.replace("Make the change.", "Make the change, carefully."));
    expect(await run.pendingChange()).toBeDefined();
    await expect(run.migrate()).rejects.toMatchObject({ code: "PIPELINE_CHANGE_REFUSED" });
    before = await snapshot(runDir(GATE));
    expect(Object.keys(before).length).toBeGreaterThan(0);
  });

  test("t41_a_state_older_than_its_journal_cannot_be_read", async () => {
    // an older process wrote its state back from memory after the run was upgraded
    const run = await trustedGateRun();
    const statePath = join(runDir(GATE), "state.json");
    const old = await readFile(statePath, "utf8");
    await run.migrate();
    await writeFile(statePath, old);
    const error = await hostFor()
      .open(GATE)
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(error?.code).toBe("UNSUPPORTED_FORMAT");
    expect(error?.message).toContain("journal records a newer format");
    expect(error?.message).not.toContain("modified");
  });
});

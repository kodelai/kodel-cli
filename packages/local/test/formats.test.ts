import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePipeline, RECORD_VERSION } from "@kodel-ai/pipeline-core";
import { listOpenRuns } from "../../../scripts/list-v1-runs.mjs";
import { FileStore, LocalHost, LocalPipelineHost, META_VERSION, readStoredAgentLog } from "../src";

/** A host of one pipeline over the store, as the MCP server would build it for a run. */
const plainHost = (root: string, tmp: string) =>
  new LocalHost(parsePipeline("name: dev\nnodes:\n  - { slug: a, kind: agent, prompt: a }\n"), {
    root,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
  });

/** The golden runs: one directory per stored format, `fixtures/formats/v<N>/<run id>/`. */
const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);

/**
 * The two format-1 runs. Written by the engine before forks (run-state format 1), which this kodel
 * refuses to read: the fixtures prove the refusal, and that nothing on disk is touched by it.
 */
const V1_RUNS = ["r_0mviewgvl_i1ig", "r_0mvimyn54_tc9o"];

/**
 * The two format-2 runs of the `dev` pipeline, written by this engine through the real local host
 * (`scripts/take-v2-fixtures.mjs`): `r_0mvu1vxry_4ggv` (the agent's proposal accepted mid-run and the
 * critique step restarted on it, a note from the agent, three gate decisions, the whole path to
 * `publish`) and `r_0mvu1w1ng_dk6c` (a change made in the pipeline file accepted with nothing redone,
 * a note, `nothing_to_change` with its gate rejected once).
 */
const DEV_RUNS = ["r_0mvu1vxry_4ggv", "r_0mvu1w1ng_dk6c"];
/** The format-2 fork run: `verify` and `test` at once, `test` failing once, the join `fix` restarting it. */
const FORK_RUN = "r_0mvu1w2tp_ssyf";
/** The format-2 fork run whose `test` branch paused while `verify` went on, resumed by a person. */
const PAUSED_FORK_RUN = "r_0mvu1w4w6_w0iy";
const V2_RUNS = [...DEV_RUNS, FORK_RUN, PAUSED_FORK_RUN];
/** The format-2 run that stands in for "a finished run of this engine" in the tests of how a run that is read behaves. */
const V2_RUN = DEV_RUNS[1] as string;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Every file under `dir`, as `a/b` paths (the same on every system) with the hash of its bytes. */
async function hashTree(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(found, await hashTree(path, base));
    else found[relative(base, path).split("\\").join("/")] = sha256(await readFile(path));
  }
  return found;
}

/** The files of a format directory that differ from its `hashes.json`, missing or extra ones too. */
async function changedFixtureFiles(formatDir: string): Promise<string[]> {
  const expected = JSON.parse(await readFile(join(formatDir, "hashes.json"), "utf8")) as Record<
    string,
    string
  >;
  const actual = await hashTree(formatDir);
  delete actual["hashes.json"];
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((name) => expected[name] !== actual[name]).sort();
}

/** A person's path in a file: Unix or Windows, the latter also as it is written inside JSON. */
const PERSONAL_PATH = /\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users/;

/** Fails with the rule when a fixture file differs from `hashes.json`. */
async function expectFixturesUntouched(formatDir: string): Promise<void> {
  const changed = await changedFixtureFiles(formatDir);
  if (changed.length > 0) {
    throw new Error(
      `fixture changed: add v2 instead of editing v1 (${changed.join(", ")}); see fixtures/formats/README.md`,
    );
  }
}

async function formatDirs(root = FORMATS): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** The run directories of a format; other directories (`history/`, golden events) are not runs. */
async function runIds(format: string, root = FORMATS): Promise<string[]> {
  return (await readdir(join(root, format), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
    .map((e) => e.name)
    .sort();
}

let tmp: string;
/** The repository root of a store made from the fixtures; the name has a space on purpose. */
let root: string;
const runsDir = () => join(root, ".kodel", "runs");

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel formats-"));
  root = join(tmp, "a repo");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function copyRuns(format: string, only?: string, from = FORMATS): Promise<void> {
  for (const id of await runIds(format, from)) {
    if (only && id !== only) continue;
    await cp(join(from, format, id), join(runsDir(), id), { recursive: true });
  }
}

const hostFor = () =>
  new LocalPipelineHost({ root, heartbeatMs: 0, integrityDir: join(tmp, "integrity") });
const storeFor = () => new FileStore({ root: join(root, ".kodel") });

const statePath = (id: string) => join(runsDir(), id, "state.json");
const readState = async (id: string) =>
  JSON.parse(await readFile(statePath(id), "utf8")) as Record<string, unknown>;
const writeState = (id: string, state: Record<string, unknown>) =>
  writeFile(statePath(id), `${JSON.stringify(state, null, 2)}\n`);

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string; name?: string },
  );

/** The refusal of a run of format 1: its code, its format, never "modified" and never a crash. */
function expectRefusedClearly(
  error: { code?: string; message?: string; name?: string } | undefined,
) {
  expect(error).toBeDefined();
  expect(error?.name).not.toBe("TypeError");
  expect(error?.code).toBe("UNSUPPORTED_FORMAT");
  const message = error?.message ?? "";
  expect(message).toContain("run-state format 1");
  expect(message).toContain("older kodel");
  expect(message).toContain("finish or cancel it with the kodel that started it");
  expect(message).not.toContain("modified");
  expect(message).not.toContain("changed outside");
}

describe("the golden runs of the stored formats", () => {
  test("formats_fixtures_have_a_known_set_of_formats_and_runs", async () => {
    expect(await formatDirs()).toEqual(["v1", "v2"]);
    expect(await runIds("v1")).toEqual([...V1_RUNS].sort());
    expect(await runIds("v2")).toEqual([...V2_RUNS].sort());
  });

  test("formats_a_fixture_file_that_was_edited_fails_the_hash_list", async () => {
    for (const format of await formatDirs()) {
      await expectFixturesUntouched(join(FORMATS, format));
    }
    // The check itself: a copy with one file edited, one removed and one added is reported.
    const copy = join(tmp, "copy");
    await cp(join(FORMATS, "v1"), copy, { recursive: true });
    const id = V1_RUNS[0] as string;
    await writeFile(join(copy, id, "state.json"), "{}");
    await rm(join(copy, id, "snapshots.json"));
    await writeFile(join(copy, id, "extra.txt"), "x");
    await expect(expectFixturesUntouched(copy)).rejects.toThrow(
      "fixture changed: add v2 instead of editing v1",
    );
    expect(await changedFixtureFiles(copy)).toEqual([
      `${id}/extra.txt`,
      `${id}/snapshots.json`,
      `${id}/state.json`,
    ]);
  });

  test("formats_no_fixture_holds_a_path_of_a_person_or_a_seal", async () => {
    for (const format of await formatDirs()) {
      for (const name of Object.keys(await hashTree(join(FORMATS, format)))) {
        expect(name.endsWith("seal.json")).toBe(false);
        const text = await readFile(join(FORMATS, format, name), "utf8");
        expect(text).not.toMatch(PERSONAL_PATH);
        // a run taken on a person's machine must not carry their agent session either: the runs are
        // made with no `CLAUDE_CODE_SESSION_ID` in the environment, and nothing is observed from it
        expect(text, name).not.toContain("observed-env");
        expect(text, name).not.toMatch(/"session"\s*:\s*\{\s*"value"/);
      }
    }
  });

  test("formats_v1_keeps_every_report_file_of_the_runs", async () => {
    // 3 and 2: the task text said 4 and 2, but the source run directories hold these.
    const count = async (id: string) => (await readdir(join(FORMATS, "v1", id, "reports"))).length;
    expect([await count("r_0mvimyn54_tc9o"), await count("r_0mviewgvl_i1ig")]).toEqual([3, 2]);
  });
});

/**
 * Every format directory, against the current engine: a run of a format before this one is refused
 * (clearly, and without a byte changing); a run of this format or later opens with `status` and
 * `report`. Returns how many of each were seen.
 */
async function checkFormats(from: string): Promise<{ refused: number; opened: number }> {
  let refused = 0;
  let opened = 0;
  for (const format of await formatDirs(from)) {
    const n = Number(format.slice(1));
    await rm(join(root, ".kodel"), { recursive: true, force: true });
    await copyRuns(format, undefined, from);
    await mkdir(runsDir(), { recursive: true });
    const before = await hashTree(runsDir());
    const host = hostFor();
    const store = storeFor();
    const listed = (await store.listRuns()).map((m) => m.runId).sort();
    expect(listed).toEqual(await runIds(format, from));
    for (const id of listed) {
      if (n < RECORD_VERSION) {
        expectRefusedClearly(await refusal(host.open(id)));
        const summary = (await host.runSummaries()).find((r) => r.meta.runId === id);
        expect(summary?.state).toBeUndefined();
        expect(summary?.unreadable).toMatchObject({ code: "UNSUPPORTED_FORMAT", format: n });
        refused += 1;
        continue;
      }
      const run = await host.open(id);
      expect(run).toBeDefined();
      expect((await run?.state())?.status).toBe("completed");
      expect((await store.readJournal(id)).length).toBeGreaterThan(0);
      expect((await run?.report())?.runId).toBe(id);
      expect(await run?.integrityStatus()).toBe("unknown");
      opened += 1;
    }
    expect(await hashTree(runsDir())).toEqual(before);
  }
  return { refused, opened };
}

describe("every stored format against the current engine", () => {
  test("t40_formats_loop_refuses_v1_runs_and_opens_every_later_one", async () => {
    const { refused, opened } = await checkFormats(FORMATS);
    expect(refused).toBe(V1_RUNS.length);
    expect(opened).toBe((await formatDirs()).includes("v2") ? (await runIds("v2")).length : 0);
  });

  test("t40_formats_loop_passes_with_empty_v2_dir", async () => {
    // the loop is not fooled by a format directory with no run in it (the state before the first
    // run of a new format is kept there)
    const copy = join(tmp, "formats");
    await cp(FORMATS, copy, { recursive: true });
    await rm(join(copy, "v2"), { recursive: true, force: true });
    await mkdir(join(copy, "v2"), { recursive: true });
    expect(await checkFormats(copy)).toEqual({ refused: V1_RUNS.length, opened: 0 });
  });

  test("t40_v2_fixtures_open", async () => {
    await copyRuns("v2");
    const before = await hashTree(runsDir());
    const host = hostFor();
    const store = storeFor();
    for (const id of DEV_RUNS) {
      const run = await host.open(id);
      expect(run).toBeDefined();
      if (!run) continue;
      const state = await run.state();
      expect(state.v).toBe(RECORD_VERSION);
      expect(state.status).toBe("completed");
      expect(state.pauses).toEqual([]);
      expect(state.active).toEqual([]);
      const report = await run.report();
      expect(report.runId).toBe(id);
      expect(report.status).toBe("completed");
      expect(report.pipeline_changes).toHaveLength(1);
      expect(report.feedback).toBe(1);
      const journal = await store.readJournal(id);
      expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
      expect(journal.filter((r) => r.event === "gate_decided").length).toBeGreaterThanOrEqual(2);
      expect(journal.filter((r) => r.event === "feedback_reported")).toHaveLength(1);
      expect(Array.isArray(journal.find((r) => r.event === "pipeline_accepted")?.effects)).toBe(
        true,
      );
    }
    // the proposal accepted while the critique step was being worked restarted that step
    const proposal = (await host.open(DEV_RUNS[0] as string)) as NonNullable<
      Awaited<ReturnType<typeof host.open>>
    >;
    const { versions } = await proposal.history();
    expect(versions.map((v) => [v.how, v.effects])).toEqual([
      ["started", []],
      ["proposal", [{ kind: "restart", node: "plan-critique" }]],
    ]);
    expect((await proposal.report()).pipeline_changes[0]).toMatchObject({
      source: "proposal",
      nodes: [{ slug: "plan-critique", changes: ["work"] }],
      effects: [{ kind: "restart", node: "plan-critique" }],
    });
    // the change made in the file touched a step the run had not reached: nothing was redone
    const file = (await host.open(V2_RUN)) as NonNullable<Awaited<ReturnType<typeof host.open>>>;
    expect((await file.report()).pipeline_changes[0]).toMatchObject({
      source: "file",
      nodes: [{ slug: "review", changes: ["work"] }],
      effects: [],
    });
    expect((await store.readJournal(V2_RUN)).map((r) => r.event)).toContain("gate_decided");
    // reading changed nothing on disk
    expect(await hashTree(runsDir())).toEqual(before);
  });

  test("t40_v2_fixtures_are_real_runs", async () => {
    // the runs were made through the real host, not a stand-in: every agent step that was completed
    // had been handed out (a `step_served` record and a served file each), the engine stamped its
    // version, the commands wrote their output, and the agent's commits in the worktree made the
    // hand-ins' `head` and `tree` move and the run's `commits` non-empty
    await copyRuns("v2");
    const store = storeFor();
    for (const id of V2_RUNS) {
      const state = await (await hostFor().open(id))?.state();
      expect(state?.engineVersion, id).toBe("0.1.0");
      const journal = await store.readJournal(id);
      const started = journal.find((r) => r.event === "run_started");
      expect(started?.engine, id).toMatchObject({ version: "0.1.0", commit: "fixture" });
      expect(started?.executor, id).toEqual({
        client: { value: { name: "take-v2-fixtures", version: "0.1.0" }, source: "observed" },
      });
      const served = journal.filter((r) => r.event === "step_served");
      expect(served.length, id).toBeGreaterThan(0);
      const handIns = journal.filter((r) => r.event === "agent_completed");
      for (const handIn of handIns) {
        expect(
          served.some((r) => r.node === handIn.node && r.attempt === handIn.attempt),
          `${id}: ${handIn.node} #${handIn.attempt} was served`,
        ).toBe(true);
        expect(typeof handIn.head, id).toBe("string");
        expect(typeof handIn.tree, id).toBe("string");
      }
      expect(Object.keys(state?.served ?? {}).length, id).toBe(served.length);
      const servedFiles = await readdir(join(runsDir(), id, "served"));
      expect(servedFiles.length, id).toBe(served.length);
      const finished = journal.find((r) => r.event === "run_finished");
      const commits = (finished?.commits ?? []) as string[];
      expect(commits.length, id).toBeGreaterThan(0);
      expect(finished?.head, id).toBe(commits[0]);
    }
    // the dev run to `publish`: the commands really ran, and the agent committed between hand-ins
    const dev = DEV_RUNS[0] as string;
    const devJournal = await store.readJournal(dev);
    const heads = new Set(
      devJournal.filter((r) => r.event === "agent_completed").map((r) => r.head as string),
    );
    const trees = new Set(
      devJournal.filter((r) => r.event === "agent_completed").map((r) => r.tree as string),
    );
    expect(heads.size).toBeGreaterThan(3);
    expect(trees.size).toBe(heads.size);
    expect(devJournal.find((r) => r.event === "run_finished")?.commits).toHaveLength(5);
    const commands = devJournal.filter((r) => r.event === "command_finished");
    expect(commands.map((r) => [r.node, r.passed])).toEqual([
      ["verify", true],
      ["test", true],
      ["build", true],
      ["sync", true],
    ]);
    for (const record of commands) {
      expect((record.output as { ref: string }).ref).toMatch(/^artifacts\//);
    }
    expect(
      await readFile(join(runsDir(), dev, "artifacts", "sync-1-command.txt"), "utf8"),
    ).toContain("no conflicts with origin/main");
    // the publish checks that need GitHub were left out of the scratch copy of the pipeline: four ran
    expect(
      devJournal.filter((r) => r.event === "check_finished" && r.node === "publish"),
    ).toHaveLength(4);
  });

  test("t40_fork_run_fixture_in_v2_shows_forks", async () => {
    // a real fork run of this engine: the state carries the fork instance, every branch visit was
    // attributed to its branch, the journal shows the overlap and the join entered after a failure,
    // and the run (no pause left, none ever taken) reads with `status`, `report` and the fork summary
    await copyRuns("v2", FORK_RUN);
    const before = await hashTree(runsDir());
    const host = hostFor();
    const run = await host.open(FORK_RUN);
    expect(run).toBeDefined();
    if (!run) return;
    const state = await run.state();
    expect(state.v).toBe(RECORD_VERSION);
    expect(state.status).toBe("completed");
    expect(state.pauses).toEqual([]);
    expect(state.active).toEqual([]);
    expect(state.trail).toEqual(["impl", "verify", "test", "fix", "test", "fix"]);
    expect(state.forks?.f1).toMatchObject({
      from: "impl",
      label: "passed",
      join: "fix",
      branches: ["verify", "test"],
      joined: 2,
    });
    expect(Object.keys(state.forks?.f1?.arrived ?? {}).sort()).toEqual(["test", "verify"]);
    const journal = await storeFor().readJournal(FORK_RUN);
    expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
    const entered = journal.filter((r) => r.event === "node_entered");
    expect(entered.map((r) => [r.node, r.branch])).toEqual([
      ["impl", undefined],
      ["verify", "verify"],
      ["test", "test"],
      ["fix", undefined],
      ["test", "test"],
      ["fix", undefined],
    ]);
    // the two branches ran at the same time: `test` settled before `verify` finished
    const events = journal.map((r) => r.event);
    const settledTest = journal.findIndex(
      (r) => r.event === "branch_settled" && r.branch === "test",
    );
    const finishedVerify = journal.findIndex(
      (r) => r.event === "node_finished" && r.node === "verify",
    );
    expect(settledTest).toBeGreaterThan(0);
    expect(settledTest).toBeLessThan(finishedVerify);
    expect(events.filter((e) => e === "join_reached")).toHaveLength(2);
    expect(journal.find((r) => r.event === "join_reached")?.failed).toEqual(["test"]);
    expect(journal.filter((r) => r.event === "run_paused")).toHaveLength(0);
    expect(journal.find((r) => r.event === "agent_completed" && r.node === "fix")?.outcome).toBe(
      "restart_failed",
    );
    const report = await run.report();
    expect(report.status).toBe("completed");
    // the failed branch was run again by `restart_failed` and passed: the run does not stand on it
    expect(report.failed_branches).toBe(false);
    expect(report.forks).toHaveLength(1);
    expect(report.forks[0]).toMatchObject({
      fork: "f1",
      branches: ["verify", "test"],
      arrived: ["verify", "test"],
      failed: [],
      unfinished: [],
      joined: 2,
    });
    expect(report.forks[0]?.overlaps).toEqual([
      { branches: ["verify", "test"], seconds: expect.any(Number) },
    ]);
    expect(report.critical_path).toHaveLength(1);
    expect(report.critical_path[0]?.fork).toBe("f1");
    expect(report.busy_wall_s).toBeGreaterThan(0);
    expect(report.busy_wall_s).toBeLessThanOrEqual(report.work_s);
    expect(report.pauses).toBe(0);
    expect(await run.integrityStatus()).toBe("unknown");
    expect(await hashTree(runsDir())).toEqual(before);
  });

  test("t40_paused_fork_run_fixture_pins_pauses", async () => {
    // a real fork run whose `test` branch ran out of its one attempt while `verify` went on: the
    // branch paused with its fork attribution, a person resumed that node, the branch's fix step ran
    // and `test` passed. `end()` clears `pauses` on the final state, so what the fixture pins is the
    // journal's `run_paused` (with `fork` and `branch`) and `run_resumed` (with the node), the
    // report's count of pauses, and the `forks` of the state; the run opens with `status` and `report`
    await copyRuns("v2", PAUSED_FORK_RUN);
    const before = await hashTree(runsDir());
    const host = hostFor();
    const run = await host.open(PAUSED_FORK_RUN);
    expect(run).toBeDefined();
    if (!run) return;
    const state = await run.state();
    expect(state.v).toBe(RECORD_VERSION);
    expect(state.status).toBe("completed");
    expect(state.pauses).toEqual([]);
    expect(state.active).toEqual([]);
    expect(state.trail).toEqual(["impl", "verify", "test", "fix-test", "test", "fix"]);
    expect(state.forks).toEqual({
      f1: {
        id: "f1",
        from: "impl",
        label: "passed",
        join: "fix",
        branches: ["verify", "test"],
        arrived: {
          verify: { node: "verify", label: "passed", seq: expect.any(Number) },
          test: { node: "test", label: "passed", seq: expect.any(Number) },
        },
        joined: 1,
      },
    });
    const journal = await storeFor().readJournal(PAUSED_FORK_RUN);
    expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
    const paused = journal.filter((r) => r.event === "run_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      reason: "consecutive",
      node: "test",
      fork: "f1",
      branch: "test",
    });
    const resumed = journal.filter((r) => r.event === "run_resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      reason: "consecutive",
      node: "test",
      fork: "f1",
      branch: "test",
    });
    // the sibling went on and arrived while the branch was paused; the join was entered once, after
    // the resumed branch passed
    const seqOf = (match: (r: (typeof journal)[number]) => boolean) =>
      journal.find(match)?.seq as number;
    const verifyArrived = seqOf((r) => r.event === "branch_settled" && r.branch === "verify");
    expect(seqOf((r) => r.event === "run_paused")).toBeLessThan(verifyArrived);
    expect(verifyArrived).toBeLessThan(seqOf((r) => r.event === "run_resumed"));
    expect(journal.filter((r) => r.event === "join_reached")).toEqual([
      expect.objectContaining({ fork: "f1", join: "fix", failed: [] }),
    ]);
    expect(
      journal.filter((r) => r.event === "node_entered").map((r) => [r.node, r.attempt, r.branch]),
    ).toEqual([
      ["impl", 1, undefined],
      ["verify", 1, "verify"],
      ["test", 1, "test"],
      ["fix-test", 1, "test"],
      ["test", 2, "test"],
      ["fix", 1, undefined],
    ]);
    const report = await run.report();
    expect(report.status).toBe("completed");
    expect(report.pauses).toBe(1);
    expect(report.failed_branches).toBe(false);
    expect(report.forks).toHaveLength(1);
    expect(report.forks[0]).toMatchObject({
      fork: "f1",
      branches: ["verify", "test"],
      failed: [],
      unfinished: [],
      joined: 1,
    });
    expect(report.nodes.find((n) => n.node === "test")?.attempts).toHaveLength(2);
    expect(await run.integrityStatus()).toBe("unknown");
    expect(await hashTree(runsDir())).toEqual(before);
  });

  test("t40_v1_history_fixtures_skipped_by_refusal_loop", async () => {
    expect(await readdir(join(FORMATS, "v1"))).toContain("history");
    expect(await runIds("v1")).not.toContain("history");
  });

  test("t40_v1_run_refused_clearly", async () => {
    await copyRuns("v1");
    const pipelineHost = hostFor();
    for (const id of V1_RUNS) {
      // status, report, next_step and every decision go through the host's open, or through the
      // store's one read of the state: each says the format, none says "modified" or crashes
      expectRefusedClearly(await refusal(pipelineHost.open(id)));
      expectRefusedClearly(await refusal(storeFor().readState(id)));
      const run = plainHost(root, tmp).open(id);
      expectRefusedClearly(await refusal(run.state()));
      expectRefusedClearly(await refusal(run.report()));
      expectRefusedClearly(await refusal(run.nextStep()));
      expectRefusedClearly(await refusal(run.inspect()));
      for (const decision of [
        await run.resume(),
        await run.decideHuman("a", "approved"),
        await run.acknowledge(),
        await run.cancel(),
      ]) {
        expect(decision.ok).toBe(false);
        if (!decision.ok) expectRefusedClearly(decision.error);
      }
    }
  });

  test("t40_v1_refusal_names_the_agents_block_the_older_kodel_refuses", async () => {
    // the person is sent back to the kodel that started the run; that one refuses a project config
    // with an `agents:` block, so the refusal says so when the config has one, and only then
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    await writeFile(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
    const plain = await refusal(storeFor().readState(id));
    expectRefusedClearly(plain);
    expect(plain?.message).not.toContain("agents");
    await writeFile(
      join(root, ".kodel", "config.yaml"),
      "worktree:\n  mode: off\nagents:\n  max_parallel: 2\n",
    );
    const noted = await refusal(storeFor().readState(id));
    expectRefusedClearly(noted);
    expect(noted?.message).toContain("`agents:` block");
    expect(noted?.message).toContain("config.yaml");
    // the same through the host, where the commands read it
    expectRefusedClearly(await refusal(hostFor().open(id)));
    expect((await refusal(hostFor().open(id)))?.message).toContain("`agents:` block");
  });

  test("t40_v1_state_with_matching_hash_is_not_modified", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    const run = plainHost(root, tmp).open(id);
    // the format is judged before the hash: the state is untrusted and unknown, and still the
    // answer is its format, not "modified"
    expectRefusedClearly(await refusal(run.integrityStatus()));
    expect(await storeFor().checkSeal(id)).toBe("unsealed");
  });

  test("t40_v1_run_refused_by_ack_seal_wait_cancel_changes", async () => {
    await copyRuns("v1");
    const host = hostFor();
    const id = V1_RUNS[1] as string;
    expectRefusedClearly(await refusal(host.seal(id)));
    expectRefusedClearly(await refusal(host.open(id).then((run) => run?.acknowledge())));
    expectRefusedClearly(await refusal(host.open(id).then((run) => run?.pendingChange())));
    expectRefusedClearly(await refusal(host.open(id).then((run) => run?.history())));
  });

  test("t40_cancel_of_v1_run_gives_clear_message", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    const before = await hashTree(runsDir());
    const run = plainHost(root, tmp).open(id);
    const decision = await run.cancel();
    expect(decision.ok).toBe(false);
    if (!decision.ok) expectRefusedClearly(decision.error);
    expect(await hashTree(runsDir())).toEqual(before);
  });

  test("t40_find_active_and_latest_skip_v1_runs", async () => {
    await copyRuns("v1");
    const store = storeFor();
    const meta = await store.readMeta(V1_RUNS[0] as string);
    expect(meta).toBeDefined();
    const { pipeline, task } = meta as { pipeline: string; task: string };
    // a finished run of format 1 is passed over by both: no report on it, no "already done"
    expect(await store.findLatest(pipeline, task)).toBeUndefined();
    expect(await store.findActive(pipeline, task)).toBeUndefined();
  });

  test("t40_start_refuses_when_open_v1_run_for_same_pipeline_and_task", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    const store = storeFor();
    const { pipeline, task } = (await store.readMeta(id)) as { pipeline: string; task: string };
    // the same run, still open in the older format: the state's `v` stays 1
    await writeState(id, { ...(await readState(id)), status: "running" });
    const error = await refusal(store.findActive(pipeline, task));
    expectRefusedClearly(error);
    expect(error?.message ?? "").toContain("no new run for this task starts while it is open");
    // and `findLatest` still passes it over: it is not a run this kodel can report on
    expect(await store.findLatest(pipeline, task)).toBeUndefined();
  });

  test("t40_pipeline_start_works_with_v1_runs_on_disk", async () => {
    await copyRuns("v1");
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "initial");
    const host = plainHost(root, tmp);
    const meta = (await storeFor().readMeta(V1_RUNS[0] as string)) as { task: string };
    // the finished run of format 1 for the same pipeline and task is neither picked up nor reported
    // as "done before": a new run starts
    const started = await host.start(meta.task);
    expect(started.reused).toBe(false);
    expect(started.terminal).toBe(false);
    expect(V1_RUNS).not.toContain(started.run.runId);
    expect((await started.run.state()).v).toBe(RECORD_VERSION);
    const listed = (await hostFor().runSummaries()).map((r) => [
      r.meta.runId,
      r.state?.status ?? `format ${r.unreadable?.format}`,
    ]);
    expect(listed).toContainEqual([started.run.runId, "running"]);
    for (const id of V1_RUNS) expect(listed).toContainEqual([id, "format 1"]);
  });

  test("t40_status_list_marks_v1_runs", async () => {
    await copyRuns("v1");
    const summaries = await hostFor().runSummaries();
    expect(summaries.map((r) => r.meta.runId).sort()).toEqual([...V1_RUNS].sort());
    for (const summary of summaries) {
      expect(summary.state).toBeUndefined();
      expect(summary.unreadable).toMatchObject({ code: "UNSUPPORTED_FORMAT", format: 1 });
      expect(summary.unreadable?.message).toContain("run-state format 1");
    }
  });

  test("t40_report_without_run_picks_latest_readable", async () => {
    await copyRuns("v1");
    await copyRuns("v2", V2_RUN);
    const summaries = await hostFor().runSummaries();
    const readable = summaries.filter((r) => r.state !== undefined).map((r) => r.meta.runId);
    expect(readable).toEqual([V2_RUN]);
    expect(
      summaries
        .filter((r) => r.state === undefined)
        .map((r) => r.meta.runId)
        .sort(),
    ).toEqual([...V1_RUNS].sort());
  });

  test("t40_meta_version_unchanged_and_messages_distinct", async () => {
    expect(META_VERSION).toBe(2);
    expect(RECORD_VERSION).toBe(2);
    await copyRuns("v1");
    await copyRuns("v2", V2_RUN);
    const id = V2_RUN;
    // a state of the current format with a meta of an old one: the message names the meta format
    const metaPath = join(runsDir(), id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, v: 1 }));
    const error = await refusal(hostFor().open(id));
    expect(error?.code).toBe("UNSUPPORTED_FORMAT");
    expect(error?.message ?? "").toContain("meta format 1");
    expect(error?.message ?? "").not.toContain("run-state format");
    // and the other way round the message names the run-state format, not the meta format
    const other = V1_RUNS[1] as string;
    const stateError = await refusal(hostFor().open(other));
    expect(stateError?.message ?? "").toContain("run-state format 1");
    expect(stateError?.message ?? "").not.toContain("meta format");
  });

  test("t40_v1_agent_log_fixture_is_refused_and_its_streams_still_read", async () => {
    // a real run of this engine with the agent's log kept, taken once before forks; it lives outside
    // the hashed formats directory (the format of `agent_log/` is frozen with the others at the
    // first release). Its state is of format 1, so the run is refused; the stored streams are
    // display data and read without the state.
    const fixtures = resolve(FORMATS, "..", "agent-log");
    const [id] = (await readdir(fixtures)).filter((name) => name.startsWith("r_"));
    expect(id).toBeDefined();
    await cp(join(fixtures, id as string), join(runsDir(), id as string), { recursive: true });
    expectRefusedClearly(await refusal(hostFor().open(id as string)));
    const raw = JSON.parse(await readFile(statePath(id as string), "utf8")) as {
      v: number;
      agentLog?: { sessions: Record<string, { length: number; entries: number }> };
    };
    expect(raw.v).toBe(1);
    const store = storeFor();
    const streams = Object.entries(raw.agentLog?.sessions ?? {});
    expect(streams).toHaveLength(2);
    for (const [session, kept] of streams) {
      const read = await readStoredAgentLog(store, id as string, session, kept.length);
      expect(read.ok).toBe(true);
      expect(read.events.length).toBe(kept.entries);
    }
    // no path of the machine that took it
    for (const file of await readdir(join(fixtures, id as string), { recursive: true })) {
      const path = join(fixtures, id as string, file);
      if (!/\.(json|jsonl|yaml)$/.test(path)) continue;
      expect(await readFile(path, "utf8")).not.toMatch(
        /\/Users\/|\/home\/|\/var\/folders|[A-Za-z]:\\{1,2}Users/,
      );
    }
  });

  test("hp9r_v1_journals_have_no_check_id_and_params_hash", async () => {
    // the journal of a format-1 run is read as records (the store refuses only the state); the
    // fields that came later are absent, not made up
    await copyRuns("v1");
    const store = storeFor();
    let seen = 0;
    for (const id of V1_RUNS) {
      const finished = (await store.readJournal(id)).filter((r) => r.event === "check_finished");
      for (const record of finished) {
        expect(record.check_id).toBeUndefined();
        expect(record.params_hash).toBeUndefined();
      }
      seen += finished.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("formats_a_fixture_reads_as_unsealed_never_as_modified", async () => {
    await copyRuns("v1");
    const store = storeFor();
    for (const id of V1_RUNS) expect(await store.checkSeal(id)).toBe("unsealed");
  });

  test("formats_a_finished_run_opens_with_no_git_repository_and_no_workdir", async () => {
    await copyRuns("v2", V2_RUN);
    const id = V2_RUN;
    // The root is not a repository, the snapshots name git objects that exist nowhere, and the
    // workdir in the state is a placeholder path that does not exist.
    expect((await readdir(root)).includes(".git")).toBe(false);
    const run = await hostFor().open(id);
    const workdir = (await run?.report())?.workdir as string;
    expect(workdir).toStartWith("/kodel-fixture/");
    expect(await readdir(workdir).catch(() => undefined)).toBeUndefined();
    expect((await run?.state())?.status).toBe("completed");
    expect(await run?.sealStatus()).toBe("unsealed");
  });

  test("formats_a_field_the_engine_does_not_know_is_kept_not_an_error", async () => {
    await copyRuns("v2", V2_RUN);
    const id = V2_RUN;
    const journalPath = join(runsDir(), id, "journal.jsonl");
    await writeState(id, { ...(await readState(id)), from_the_future: { n: 1 } });
    const lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0] as string), from_the_future: true });
    await writeFile(journalPath, `${lines.join("\n")}\n`);
    const before = await hashTree(runsDir());

    const run = await hostFor().open(id);
    expect((await run?.report())?.status).toBe("completed");
    expect(await hashTree(runsDir())).toEqual(before);
    expect(await readFile(statePath(id), "utf8")).toContain("from_the_future");
  });

  test("formats_a_run_in_a_format_the_engine_does_not_know_is_unsupported_not_modified", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    await writeState(id, { ...(await readState(id)), v: 99 });
    const error = await refusal(hostFor().open(id));
    expect(error?.code).toBe("UNSUPPORTED_FORMAT");
    expect(error?.message ?? "").toContain("run-state format 99");
    expect(error?.message ?? "").toContain("upgrade");
    expect(error?.message ?? "").not.toContain("modified");
  });

  test("formats_a_state_that_is_not_json_is_modified_not_unsupported", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    await writeFile(statePath(id), "{ not json");
    const error = await refusal(hostFor().open(id));
    expect(error?.code).toBe("STATE_MODIFIED_EXTERNALLY");
  });

  test("formats_a_state_without_a_format_version_is_modified_not_unsupported", async () => {
    await copyRuns("v1");
    const id = V1_RUNS[0] as string;
    const { v: _v, ...rest } = await readState(id);
    await writeState(id, rest);
    const error = await refusal(hostFor().open(id));
    expect(error?.code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(error?.message ?? "").toContain("no run-state format version");
  });

  test("t40_scripts_list_v1_runs_finds_them", async () => {
    await copyRuns("v1");
    // both finished: nothing to list
    expect(await listOpenRuns(root)).toEqual([]);
    // one running and one paused in format 1, one running in the current format
    const [running, paused] = V1_RUNS as [string, string];
    await writeState(running, { ...(await readState(running)), status: "running" });
    await writeState(paused, { ...(await readState(paused)), status: "paused" });
    const current = V2_RUN;
    await copyRuns("v2", current);
    await writeState(current, { ...(await readState(current)), status: "running" });
    const found = await listOpenRuns(root);
    expect(found.map((r) => [r.runId, r.status, r.pipeline])).toEqual([
      [running, "running", "dev"],
      [paused, "paused", "dev"],
    ]);
    expect(found[0]?.task).toContain("pipeline_docs");
    expect(await listOpenRuns(root, RECORD_VERSION)).toMatchObject([
      { runId: current, status: "running" },
    ]);
    // a project without runs
    expect(await listOpenRuns(tmp)).toEqual([]);
    // and the command itself, on this store
    const { execFileSync } = await import("node:child_process");
    const script = resolve(FORMATS, "..", "..", "scripts", "list-v1-runs.mjs");
    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", [script, root], { encoding: "utf8" });
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      code = failed.status;
      out = failed.stdout;
    }
    expect(code).toBe(1);
    expect(out).toContain(`${running}  running  dev`);
    expect(out).toContain(`${paused}  paused  dev`);
    expect(out).not.toContain(current);
  });
});

/**
 * The golden runs of the stored formats, as the core sees them: a fixture of an older run-state
 * format carries that format's number, and the engine writes the current one. Reading a run is the
 * store's business (`packages/local/test/formats.test.ts`): the core never guesses from the shape.
 */
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decide,
  type JournalRecord,
  parsePipeline,
  RECORD_VERSION,
  type RunState,
  summarizeRun,
} from "../src";

const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);

const formatDirs = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();

/** The run directories of a format; other directories (`history/`, golden events) are not runs. */
const runIds = (root: string, format: string) =>
  readdirSync(join(root, format), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
    .map((e) => e.name)
    .sort();

const load = (root: string, format: string, id: string) => ({
  state: JSON.parse(readFileSync(join(root, format, id, "state.json"), "utf8")) as RunState,
  journal: readFileSync(join(root, format, id, "journal.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalRecord),
});

/**
 * Every format directory is looked at: a run of a format before the current one is expected to be
 * refused by the store, so here it only has to carry its number; a run of the current format must
 * be readable by `decide` as it is.
 */
function checkFormats(root: string): { refused: number; opened: number } {
  let refused = 0;
  let opened = 0;
  for (const format of formatDirs(root)) {
    const n = Number(format.slice(1));
    for (const id of runIds(root, format)) {
      const { state, journal } = load(root, format, id);
      expect(state.v as number, `${format}/${id}`).toBe(n);
      for (const record of journal) expect(record.v as number, `${format}/${id}`).toBe(n);
      if (n < RECORD_VERSION) {
        refused += 1;
        continue;
      }
      // a run of the current format is a state `decide` can take an event on
      const spec = parsePipeline(
        readFileSync(join(root, format, id, "specs", `${state.specHash}.yaml`), "utf8"),
      );
      expect(decide(spec, state, { type: "tick" }, Date.now()).ok).toBe(true);
      opened += 1;
    }
  }
  return { refused, opened };
}

test("t40_v1_fixtures_carry_format_1_and_the_engine_writes_format_2", () => {
  expect(RECORD_VERSION).toBe(2);
  const ids = runIds(FORMATS, "v1");
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const { state, journal } = load(FORMATS, "v1", id);
    expect(state.v as number).toBe(1);
    expect(journal.every((r) => (r.v as number) === 1)).toBe(true);
    // the field that replaced `pause` does not exist in format 1, and the one it replaced may
    expect(state).not.toHaveProperty("pauses");
  }
  const spec = parsePipeline("name: p\nnodes:\n  - { slug: a, kind: agent, prompt: a }\n");
  const started = decide(
    spec,
    undefined,
    { type: "start", runId: "r", task: "t", specHash: "h" },
    0,
  );
  if (!started.ok) throw started.error;
  expect(started.state.v).toBe(2);
  expect(started.state.pauses).toEqual([]);
  expect(started.journal.every((r) => r.v === 2)).toBe(true);
});

test("t40_formats_loop_refuses_v1_and_opens_later_formats", () => {
  const { refused, opened } = checkFormats(FORMATS);
  expect(refused).toBe(runIds(FORMATS, "v1").length);
  expect(opened).toBe(runIds(FORMATS, "v2").length);
  expect(opened).toBeGreaterThan(0);
});

test("t40_v2_fixtures_open", () => {
  // real runs of the `dev` pipeline written by this engine: the state and every record carry
  // format 2, the summary reads them, and the accepted change carries its `effects` list
  const ids = runIds(FORMATS, "v2");
  expect(ids).toEqual(["r_0mvtewczh_4i2w", "r_0mvtewgdn_zfhl", "r_0mvthh4vp_9gqe"]);
  const effects: unknown[] = [];
  // the two runs of the `dev` pipeline; the fork run is looked at by its own test below
  for (const id of ids.slice(0, 2)) {
    const { state, journal } = load(FORMATS, "v2", id);
    expect(state.v).toBe(RECORD_VERSION);
    expect(state.status).toBe("completed");
    expect(state.pauses).toEqual([]);
    expect(state).not.toHaveProperty("pause");
    expect(journal.every((r) => r.v === RECORD_VERSION)).toBe(true);
    const report = summarizeRun(state, journal);
    expect(report.status).toBe("completed");
    expect(report.feedback).toBe(1);
    expect(report.pipeline_changes).toHaveLength(1);
    effects.push(report.pipeline_changes[0]?.effects);
    expect(journal.filter((r) => r.event === "gate_decided").length).toBeGreaterThanOrEqual(2);
    const accepted = journal.find((r) => r.event === "pipeline_accepted");
    expect(accepted).toBeDefined();
    expect(accepted).not.toHaveProperty("effect");
    expect(Array.isArray(accepted?.effects)).toBe(true);
  }
  expect(effects).toEqual([[{ kind: "restart", node: "plan-critique" }], []]);
});

test("t40_fork_run_fixture_in_v2_shows_forks_and_pauses", () => {
  // the real fork run: the summary reads the fork instance, the overlap, the critical path and the
  // flag that the join was entered after a failed branch, from the state and journal alone
  const { state, journal } = load(FORMATS, "v2", "r_0mvthh4vp_9gqe");
  expect(state.v).toBe(RECORD_VERSION);
  expect(state.status).toBe("completed");
  expect(state.pauses).toEqual([]);
  expect(Object.keys(state.forks ?? {})).toEqual(["f1"]);
  expect(state.forks?.f1?.branches).toEqual(["verify", "test"]);
  expect(journal.filter((r) => r.event === "fork_started")).toHaveLength(1);
  expect(journal.filter((r) => r.event === "branch_settled")).toHaveLength(3);
  const report = summarizeRun(state, journal);
  // the first join saw a failed branch; it was redone and passed, so the run does not stand on it
  expect(journal.find((r) => r.event === "join_reached")?.failed).toEqual(["test"]);
  expect(report.failed_branches).toBe(false);
  expect(report.forks.map((f) => [f.fork, f.join, f.joined])).toEqual([["f1", "fix", 2]]);
  expect(report.forks[0]?.overlaps.map((o) => o.branches)).toEqual([["verify", "test"]]);
  expect(report.critical_path).toEqual([
    {
      fork: "f1",
      branch: expect.any(String),
      seconds: expect.any(Number),
      attempts: expect.any(Array),
    },
  ]);
  // `verify` ran for about 1.5 s while `test` failed at once and ran again after `restart_failed`
  // (two short attempts, both in its branch): the longest chain is the one attempt of `verify`
  expect(report.critical_path[0]).toMatchObject({
    branch: "verify",
    attempts: [{ node: "verify", attempt: 1 }],
  });
  expect(report.critical_path[0]?.seconds).toBeGreaterThan(1);
  const spans = journal.filter((r) => r.event === "node_entered" && r.branch === "test");
  expect(spans.map((r) => r.attempt)).toEqual([1, 2]);
  expect(report.busy_wall_s).toBeLessThanOrEqual(report.work_s);
  expect(report.nodes.find((n) => n.node === "test")?.attempts).toHaveLength(2);
});

test("t40_formats_loop_passes_with_empty_v2_dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kodel-formats-"));
  try {
    cpSync(FORMATS, tmp, { recursive: true });
    rmSync(join(tmp, "v2"), { recursive: true, force: true });
    mkdirSync(join(tmp, "v2"), { recursive: true });
    expect(formatDirs(tmp)).toContain("v2");
    expect(runIds(tmp, "v2")).toEqual([]);
    expect(checkFormats(tmp)).toEqual({ refused: runIds(FORMATS, "v1").length, opened: 0 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("t40_v1_history_fixtures_skipped_by_refusal_loop", () => {
  // `v1/history/` holds golden event streams of the agent's log, not runs: the loop never opens it
  expect(readdirSync(join(FORMATS, "v1"))).toContain("history");
  expect(runIds(FORMATS, "v1")).not.toContain("history");
  expect(runIds(FORMATS, "v1").every((id) => id.startsWith("r_"))).toBe(true);
});

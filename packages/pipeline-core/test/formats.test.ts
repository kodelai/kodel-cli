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
import { decide, type JournalRecord, parsePipeline, RECORD_VERSION, type RunState } from "../src";

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
  // no run of the current format is kept yet; the loop opens them once `v2/` holds real runs
  expect(opened).toBe(formatDirs(FORMATS).includes("v2") ? runIds(FORMATS, "v2").length : 0);
});

test("t40_formats_loop_passes_with_empty_v2_dir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kodel-formats-"));
  try {
    cpSync(FORMATS, tmp, { recursive: true });
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

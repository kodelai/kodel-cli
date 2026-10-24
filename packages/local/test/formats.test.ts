import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore, LocalPipelineHost } from "../src";

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

/** What the two format-1 runs contain, written down by hand so a change of the engine shows. */
const V1_RUNS: Record<
  string,
  { gates: number; extraAttempts: number; feedback: number; nodes: Record<string, number> }
> = {
  r_0mvimyn54_tc9o: {
    gates: 3,
    extraAttempts: 7,
    feedback: 0,
    nodes: {
      plan: 2,
      "plan-approval": 2,
      impl: 2,
      verify: 2,
      test: 2,
      build: 2,
      review: 2,
      "final-approval": 1,
    },
  },
  r_0mviewgvl_i1ig: {
    gates: 3,
    extraAttempts: 9,
    feedback: 1,
    nodes: {
      plan: 1,
      "plan-approval": 1,
      impl: 3,
      verify: 3,
      test: 3,
      build: 2,
      review: 2,
      "final-approval": 2,
    },
  },
};

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

async function formatDirs(): Promise<string[]> {
  return (await readdir(FORMATS, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Directories of a format that are not runs: the golden files of other readers. */
const NOT_RUNS = new Set(["history"]);

async function runIds(format: string): Promise<string[]> {
  return (await readdir(join(FORMATS, format), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !NOT_RUNS.has(e.name))
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

async function copyRuns(format: string, only?: string): Promise<void> {
  for (const id of await runIds(format)) {
    if (only && id !== only) continue;
    await cp(join(FORMATS, format, id), join(runsDir(), id), { recursive: true });
  }
}

const hostFor = () =>
  new LocalPipelineHost({ root, heartbeatMs: 0, integrityDir: join(tmp, "integrity") });

describe("the golden runs of the stored formats", () => {
  test("formats_fixtures_have_a_known_set_of_formats_and_runs", async () => {
    expect(await formatDirs()).toContain("v1");
    expect(await runIds("v1")).toEqual(Object.keys(V1_RUNS).sort());
  });

  test("formats_a_fixture_file_that_was_edited_fails_the_hash_list", async () => {
    for (const format of await formatDirs()) {
      await expectFixturesUntouched(join(FORMATS, format));
    }
    // The check itself: a copy with one file edited, one removed and one added is reported.
    const copy = join(tmp, "copy");
    await cp(join(FORMATS, "v1"), copy, { recursive: true });
    const id = Object.keys(V1_RUNS)[0] as string;
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
      }
    }
  });
});

describe("every stored format is opened by the current engine", () => {
  test("formats_every_fixture_run_is_read_and_nothing_on_disk_changes", async () => {
    for (const format of await formatDirs()) {
      await rm(join(root, ".kodel"), { recursive: true, force: true });
      await copyRuns(format);
      const before = await hashTree(runsDir());
      const host = hostFor();
      const store = new FileStore({ root: join(root, ".kodel") });

      const listed = (await store.listRuns()).map((m) => m.runId).sort();
      expect(listed).toEqual(await runIds(format));
      for (const id of listed) {
        const run = await host.open(id);
        expect(run).toBeDefined();
        expect((await run?.state())?.status).toBe("completed");
        expect((await store.readJournal(id)).length).toBeGreaterThan(0);
        expect((await run?.report())?.runId).toBe(id);
        expect(await run?.integrityStatus()).toBe("unknown");
      }
      expect(await hashTree(runsDir())).toEqual(before);
    }
  });

  test("formats_v1_reports_count_what_the_runs_did", async () => {
    await copyRuns("v1");
    const host = hostFor();
    for (const [id, want] of Object.entries(V1_RUNS)) {
      const report = await (await host.open(id))?.report();
      expect(report?.status).toBe("completed");
      const gateAttempts = (report?.nodes ?? [])
        .filter((n) => n.gate)
        .reduce((sum, n) => sum + n.attempts.length, 0);
      expect(gateAttempts).toBe(want.gates);
      expect(report?.extra_attempts).toBe(want.extraAttempts);
      expect(report?.feedback).toBe(want.feedback);
      expect(report?.restarts).toBe(0);
      expect(
        Object.fromEntries(report?.nodes.map((n) => [n.node, n.attempts.length]) ?? []),
      ).toEqual(want.nodes);
      expect(report?.workdir).toBe(`/kodel-fixture/workdir/${id}`);
    }
  });

  test("formats_a_fixture_reads_as_unsealed_never_as_modified", async () => {
    await copyRuns("v1");
    const host = hostFor();
    const store = new FileStore({ root: join(root, ".kodel") });
    for (const id of Object.keys(V1_RUNS)) {
      expect(await store.checkSeal(id)).toBe("unsealed");
      expect(await (await host.open(id))?.sealStatus()).toBe("unsealed");
    }
  });

  test("formats_a_finished_run_opens_with_no_git_repository_and_no_workdir", async () => {
    await copyRuns("v1");
    const id = Object.keys(V1_RUNS)[0] as string;
    // The root is not a repository, the snapshots name git objects that exist nowhere, and the
    // workdir in the state is a placeholder path that does not exist.
    expect((await readdir(root)).includes(".git")).toBe(false);
    const run = await hostFor().open(id);
    const workdir = (await run?.report())?.workdir as string;
    expect(workdir).toStartWith("/kodel-fixture/");
    expect(await readdir(workdir).catch(() => undefined)).toBeUndefined();
    expect((await run?.state())?.status).toBe("completed");
  });

  test("formats_v1_keeps_every_report_file_of_the_runs", async () => {
    // 3 and 2: the task text said 4 and 2, but the source run directories hold these.
    const count = async (id: string) => (await readdir(join(FORMATS, "v1", id, "reports"))).length;
    expect([await count("r_0mvimyn54_tc9o"), await count("r_0mviewgvl_i1ig")]).toEqual([3, 2]);
  });

  test("formats_a_field_the_engine_does_not_know_is_kept_not_an_error", async () => {
    await copyRuns("v1");
    const id = Object.keys(V1_RUNS)[0] as string;
    const statePath = join(runsDir(), id, "state.json");
    const journalPath = join(runsDir(), id, "journal.jsonl");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, from_the_future: { n: 1 } }));
    const lines = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0] as string), from_the_future: true });
    await writeFile(journalPath, `${lines.join("\n")}\n`);
    const before = await hashTree(runsDir());

    const run = await hostFor().open(id);
    expect((await run?.report())?.status).toBe("completed");
    expect(await hashTree(runsDir())).toEqual(before);
    expect(await readFile(statePath, "utf8")).toContain("from_the_future");
  });

  test("formats_a_run_in_a_format_the_engine_does_not_know_is_unsupported_not_modified", async () => {
    await copyRuns("v1");
    const id = Object.keys(V1_RUNS)[0] as string;
    const statePath = join(runsDir(), id, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, v: 99 }));
    const error = await hostFor()
      .open(id)
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; message: string },
      );
    expect(error?.code).toBe("UNSUPPORTED_FORMAT");
    expect(error?.message).toContain("format 99");
    expect(error?.message).toContain("upgrade");
  });

  test("formats_a_state_that_is_not_json_is_modified_not_unsupported", async () => {
    await copyRuns("v1");
    const id = Object.keys(V1_RUNS)[0] as string;
    await writeFile(join(runsDir(), id, "state.json"), "{ not json");
    const error = await hostFor()
      .open(id)
      .then(
        () => undefined,
        (e: unknown) => e as { code: string },
      );
    expect(error?.code).toBe("STATE_MODIFIED_EXTERNALLY");
  });
});

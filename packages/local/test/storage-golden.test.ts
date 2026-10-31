import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPipelineHost, resolveStoragePlace } from "../src";

/** The golden runs: `fixtures/formats/v<N>/<run id>/`, copied here into a home tree. */
const FORMATS = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "formats",
);
const ID = "golden-aaaa1111";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel-golden-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function hashTree(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(found, await hashTree(path, base));
    else {
      found[relative(base, path).split("\\").join("/")] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  return found;
}

describe("the golden runs in a home tree", () => {
  test("storage_golden_fixture_opens_from_home", async () => {
    const project = join(tmp, "a repo");
    const base = join(tmp, "base");
    await mkdir(join(project, ".kodel"), { recursive: true });
    await writeFile(join(project, ".kodel", "config.yaml"), `storage: home\nproject_id: ${ID}\n`);
    const runs = join(base, "projects", ID, "runs");
    await mkdir(runs, { recursive: true });
    // Format 2 is what this engine reads; the format-1 runs are refused by format (T-40), from a home
    // tree as from `.kodel/runs`, and never called modified.
    const runIds = async (format: string) =>
      (await readdir(join(FORMATS, format), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
        .map((e) => e.name)
        .sort();
    const ids = await runIds("v2");
    const old = await runIds("v1");
    expect(ids.length).toBeGreaterThan(0);
    expect(old.length).toBeGreaterThan(0);
    for (const id of ids) await cp(join(FORMATS, "v2", id), join(runs, id), { recursive: true });
    for (const id of old) await cp(join(FORMATS, "v1", id), join(runs, id), { recursive: true });
    const before = await hashTree(runs);

    const storage = await resolveStoragePlace({
      root: project,
      dataDir: join(project, ".kodel"),
      env: { KODEL_STATE_DIR: base },
    });
    const host = new LocalPipelineHost({
      root: project,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
      storage,
    });
    const summaries = await host.runSummaries();
    expect(summaries.map((s) => s.meta.runId).sort()).toEqual([...ids, ...old].sort());
    for (const summary of summaries.filter((s) => old.includes(s.meta.runId))) {
      expect(summary.state).toBeUndefined();
      expect(summary.unreadable).toMatchObject({ code: "UNSUPPORTED_FORMAT", format: 1 });
    }
    for (const id of old) {
      await expect(host.open(id)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    }
    for (const id of ids) {
      const run = await host.open(id);
      expect(run).toBeDefined();
      expect((await run?.state())?.status).toBe("completed");
      expect((await run?.report())?.runId).toBe(id);
      // No hash was ever recorded for the copy: unknown, never an error.
      expect(await run?.integrityStatus()).toBe("unknown");
      // An old run has no `root`: it is ours, never foreign.
      expect(await run?.foreignRoot()).toBeUndefined();
    }
    // Reading changed nothing.
    expect(await hashTree(runs)).toEqual(before);
  });
});

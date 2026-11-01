import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensOf } from "@kodel-ai/pipeline-core";
import { FileStore, LocalPipelineHost } from "../src";

/** The golden run with usage; see its README for what it is and when it moves under the frozen formats. */
const FIXTURE = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "usage-run",
);

let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel usage-run-"));
  root = join(tmp, "a repo");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function hashed(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(found, await hashed(path, base));
    else found[relative(base, path)] = (await readFile(path)).toString("base64");
  }
  return found;
}

describe("t9jrs the golden run with usage", () => {
  test("t9jrs_golden_run_with_usage_is_read_by_status_and_report", async () => {
    const ids = (await readdir(FIXTURE, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
      .map((e) => e.name);
    expect(ids).toHaveLength(1);
    const id = ids[0] as string;
    const runs = join(root, ".kodel", "runs");
    await cp(join(FIXTURE, id), join(runs, id), { recursive: true });
    const before = await hashed(runs);
    const host = new LocalPipelineHost({
      root,
      heartbeatMs: 0,
      integrityDir: join(tmp, "integrity"),
    });
    const store = new FileStore({ root: join(root, ".kodel") });

    // status: the run is listed and finished
    expect((await store.listRuns()).map((m) => m.runId)).toEqual([id]);
    const run = await host.open(id);
    expect((await run?.state())?.status).toBe("completed");

    // report: the numbers of the usage pass, as the journal and the state of that build hold them
    const usage = (await run?.report())?.usage;
    expect(usage).toMatchObject({ estimate: true, lower_bound: true });
    const state = await run?.state();
    expect(Object.keys(state?.usage?.attempts ?? {}).sort()).toEqual(["a:1", "b:1"]);
    const a = state?.usage?.attempts["a:1"];
    if (a === undefined) throw new Error("no attempt a:1");
    expect(tokensOf(a).input).toBe(300);
    expect((await store.readJournal(id)).filter((r) => r.event === "usage_recorded")).toHaveLength(
      2,
    );

    // opening it changes nothing on disk
    expect(await hashed(runs)).toEqual(before);
  });
});

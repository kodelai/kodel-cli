import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore, LocalPipelineHost } from "../src";

/** The golden run with tool calls; see its README for what it is and when it moves under the frozen formats. */
const FIXTURE = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "tool-calls-run",
);

let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel tool-calls-run-"));
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

describe("zkrh the golden run with tool calls", () => {
  test("zkrh_golden_run_status_and_report", async () => {
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
    const state = await run?.state();
    expect(state?.status).toBe("completed");
    expect(state?.v).toBe(2);
    expect(state?.toolCalls?.events).toBe(2);

    // report: the calls of the two steps, the hand-in call of `a` put with `a` although the pass of `b` read it
    const report = (await run?.report())?.tool_calls;
    if (report === undefined || !("attempts" in report)) throw new Error(JSON.stringify(report));
    expect(report.unverified).toBe(true);
    const a = report.attempts.find((x) => x.node === "a");
    const b = report.attempts.find((x) => x.node === "b");
    expect(a?.lines.map((l) => l.tool)).toEqual([
      "pipeline_start",
      "Bash",
      "pipeline_complete_step",
    ]);
    expect(a?.lines.every((l) => l.ok === true)).toBe(true);
    expect(b?.lines.map((l) => [l.tool, l.ok])).toEqual([
      ["Edit", true],
      ["Write", false],
    ]);
    expect(b?.lines.find((l) => l.tool === "Write")?.err).toBe("hook_blocked");
    expect(b?.failed).toBe(1);

    // opening it and reporting change nothing on disk
    expect(await hashed(runs)).toEqual(before);
  });
});

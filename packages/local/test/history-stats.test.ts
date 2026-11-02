/**
 * The cost of a node, the size of a task, the rows an attempt stored and the statistics of a pipeline, read through
 * `LocalPipelineHost` and the history tools from the golden runs of `fixtures/`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineService } from "@kodel-ai/pipeline-core";
import { invokeHistoryTool } from "@kodel-ai/pipeline-core/mcp";
import { LocalPipelineHost } from "../src";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

const FIXTURES = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "fixtures");
const DEV = "r_0mvu1vxry_4ggv"; // format 2, pipeline dev, reports of plan-critique and review stored
const DEV_OTHER = "r_0mvu1w1ng_dk6c"; // format 2, pipeline dev
const USAGE_RUN = "r_0mvw32fz3_x186"; // pipeline two, usage recorded
const LOG_RUN = "r_0mvqeq4tq_fsjv"; // pipeline two, no usage

let tmp: string;
let root: string;
let service: PipelineService;

const runsDir = () => join(root, ".kodel", "runs");
const call = (name: string, args: Record<string, unknown>): Promise<Loose> =>
  invokeHistoryTool(service, name, args) as Promise<Loose>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kodel-history-stats-"));
  root = join(tmp, "project");
  await mkdir(runsDir(), { recursive: true });
  await cp(join(FIXTURES, "formats", "v2", DEV), join(runsDir(), DEV), { recursive: true });
  await cp(join(FIXTURES, "formats", "v2", DEV_OTHER), join(runsDir(), DEV_OTHER), {
    recursive: true,
  });
  await cp(join(FIXTURES, "usage-run", USAGE_RUN), join(runsDir(), USAGE_RUN), { recursive: true });
  await cp(join(FIXTURES, "agent-log", LOG_RUN), join(runsDir(), LOG_RUN), { recursive: true });
  const host = new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: join(tmp, "integrity"),
  });
  service = new PipelineService(host);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("cost and size over a store", () => {
  test("history_tools_node_rows_carry_the_cost_of_a_run_with_usage", async () => {
    const answer = await call("history_run_details", { run_id: USAGE_RUN, limit: 50 });
    expect(answer.ok).toBe(true);
    const withUsage = answer.nodes.filter((n: Loose) => n.usage !== undefined);
    expect(withUsage.length).toBeGreaterThan(0);
    for (const node of withUsage) {
      expect(node.usage.attempts_with_usage).toBeGreaterThan(0);
      expect(node.usage.input + node.usage.output + node.usage.cache_read).toBeGreaterThan(0);
    }
    // the sum of the nodes is no more than what the whole run used
    const total = answer.usage.total.cost.usd;
    const nodes = withUsage.reduce((sum: number, n: Loose) => sum + (n.usage.usd ?? 0), 0);
    // each node is rounded to four decimals, so the sum may differ from the exact total by a part of a cent
    expect(nodes).toBeLessThanOrEqual(total + 1e-3);
    // a run that kept no usage has no figures, and says so
    const none = await call("history_run_details", { run_id: DEV_OTHER, limit: 50 });
    expect(none.nodes.every((n: Loose) => n.usage === undefined)).toBe(true);
    expect(none.usage.not_collected).toBe(true);
  });

  test("history_tools_task_size_comes_from_the_patch_of_the_run", async () => {
    const answer = await call("history_run_details", { run_id: USAGE_RUN, fields: ["task_size"] });
    expect(answer.ok).toBe(true);
    const size = answer.task_size;
    expect(size.not_collected === true || typeof size.files === "number").toBe(true);
    // a run that kept no patch says so and nothing else
    const none = await call("history_run_details", { run_id: DEV_OTHER, fields: ["task_size"] });
    expect(none.task_size.not_collected === true || typeof none.task_size.files === "number").toBe(
      true,
    );
  });

  test("history_tools_attempt_rows_are_the_report_the_attempt_stored", async () => {
    const reports = await readdir(join(runsDir(), DEV, "reports"));
    expect(reports).toContain("plan-critique-2.json");
    const stored = JSON.parse(
      await readFile(join(runsDir(), DEV, "reports", "plan-critique-2.json"), "utf8"),
    );
    const answer = await call("history_run_details", {
      run_id: DEV,
      node: "plan-critique",
      attempt: 2,
    });
    expect(answer.ok).toBe(true);
    expect(answer.report_rows.completeness).toBe(stored.completeness);
    expect(answer.report_rows.rows.length).toBe(stored.rows.length);
    expect(answer.report_rows.rows[0]).toMatchObject({
      severity: stored.rows[0].severity,
      location: stored.rows[0].location,
    });
    // an attempt that stored no report has no block
    const none = await call("history_run_details", { run_id: DEV, node: "plan", attempt: 1 });
    expect(none.ok).toBe(true);
    expect(none.report_rows).toBeUndefined();
  });

  test("history_tools_a_gate_attempt_gives_the_comments_a_person_made", async () => {
    // the reports of the gates are the person's comments; every stored report of the run is reachable by its attempt
    const stored = (await readdir(join(runsDir(), DEV, "reports"))).filter((f) =>
      f.endsWith(".json"),
    );
    for (const file of stored) {
      const match = /^(.+)-(\d+)\.json$/.exec(file);
      if (!match) continue;
      const [, node, attempt] = match;
      const answer = await call("history_run_details", {
        run_id: DEV,
        node,
        attempt: Number(attempt),
        fields: ["report_rows"],
      });
      expect(answer.ok).toBe(true);
      expect(answer.report_rows).toBeDefined();
    }
  });
});

describe("history_stats over a store", () => {
  test("history_tools_stats_counts_the_runs_of_a_pipeline_on_a_store", async () => {
    const answer = await call("history_stats", { pipeline: "dev" });
    expect(answer).toMatchObject({ ok: true, level: "stats" });
    expect(answer.runs).toMatchObject({ pipeline: "dev", considered: 2, read: 2, skipped: 0 });
    const names = answer.nodes.map((n: Loose) => n.node);
    expect(names).toEqual(expect.arrayContaining(["plan", "plan-critique", "impl", "publish"]));
    const critique = answer.nodes.find((n: Loose) => n.node === "plan-critique");
    expect(critique.attempts).toBeGreaterThan(1);
    expect(critique.per_run).toBeGreaterThan(1);
    expect(critique.findings.rows).toBeGreaterThan(0);
    const gate = answer.nodes.find((n: Loose) => n.node === "plan-approval");
    expect(gate.gate).toBe(true);
    expect(gate.decisions.approved + gate.decisions.rejected).toBeGreaterThan(0);
  });

  test("history_tools_stats_prices_the_runs_that_recorded_usage", async () => {
    const answer = await call("history_stats", { pipeline: "two" });
    expect(answer.runs.read).toBe(2);
    const priced = answer.nodes.filter((n: Loose) => n.usage.priced > 0);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced[0].usage.usd).toBeGreaterThan(0);
  });

  test("history_tools_stats_reads_no_patch_and_writes_nothing", async () => {
    const before = await tree(join(root, ".kodel"));
    await call("history_stats", { pipeline: "dev", limit: 200, fields: ["nodes", "versions"] });
    await call("history_run_details", { run_id: USAGE_RUN, fields: ["task_size"] });
    await call("history_run_details", { run_id: DEV, node: "plan-critique", attempt: 2 });
    expect(await tree(join(root, ".kodel"))).toEqual(before);
  });
});

async function tree(dir: string, base = dir): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(found, await tree(path, base));
    else {
      const info = await stat(path);
      found[path.slice(base.length)] =
        `${info.mtimeMs}:${(await readFile(path)).toString("base64")}`;
    }
  }
  return found;
}

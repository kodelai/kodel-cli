/**
 * What the history tools say of cost, the size of a task and the rows a report stored, and the statistics over the
 * runs of a pipeline (`history_stats`), on a fake host. The reads of a real store are tested in
 * `packages/local/test/history-tools.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  type HistoryHost,
  type HistoryRunData,
  type HistoryRunRow,
  type PipelineHost,
  PipelineService,
  type RunReport,
} from "../src";
import { invokeHistoryTool } from "../src/mcp";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

// Assembled at run time so this file does not trip secret scanners.
const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const ID = "r_000000001_abcd";

const service = (history: HistoryHost) =>
  new PipelineService({ ...history } as unknown as PipelineHost);
const call = (svc: PipelineService, name: string, args: Record<string, unknown>): Promise<Loose> =>
  invokeHistoryTool(svc, name, args) as Promise<Loose>;

const row = (i: number, extra: Partial<HistoryRunRow> = {}): HistoryRunRow => ({
  run_id: `r_${String(i).padStart(9, "0")}_abcd`,
  pipeline: "dev",
  slug: `run-${i}`,
  status: "completed",
  started_at: 1_700_000_000_000 + i * 1000,
  active: [],
  pauses: [],
  ...extra,
});

const usage = (usd: number | null, calls = 2) => ({
  input: 10,
  output: 20,
  cache_read: 30,
  cache_write: 40,
  calls,
  usd,
});

/** A finished run of three nodes: `plan` took two attempts, `impl` one, `ship` is a gate. */
function report(): RunReport {
  const attempt = (n: number, extra: object = {}) => ({
    attempt: n,
    outcome: n === 1 ? "failed" : "passed",
    seconds: 10 * n,
    ...extra,
  });
  return {
    runId: ID,
    task: "do the thing",
    slug: "do-the-thing",
    status: "completed",
    total_s: 100,
    work_s: 90,
    busy_wall_s: 90,
    waiting_s: 10,
    nodes: [
      { node: "plan", gate: false, seconds: 30, attempts: [attempt(1), attempt(2)] },
      { node: "impl", gate: false, seconds: 50, attempts: [attempt(1, { outcome: "passed" })] },
      { node: "ship", gate: true, seconds: 10, attempts: [attempt(1, { outcome: "approved" })] },
    ],
    forks: [],
    critical_path: [],
    failed_branches: false,
    restarts: 0,
    pauses: 0,
    feedback: 0,
    refused: 0,
    refusals: [],
    extra_attempts: 1,
    pipeline_changes: [],
    agent_decisions: [],
    checks: [],
    prompts: { not_collected: true },
    agent_log: { not_collected: true, reason: "not_captured" },
    usage: { not_collected: true, reason: "not_captured" },
  } as unknown as RunReport;
}

const data = (mutate: (r: RunReport) => void = () => {}): HistoryRunData => {
  const r = report();
  mutate(r);
  return {
    pipeline: "dev",
    report: r,
    format: 2,
    integrity: "ok",
    seal: "sealed",
    pipeline_copy: "ok",
  };
};

const withUsage = (r: RunReport) => {
  const plan = r.nodes[0];
  if (plan) {
    plan.attempts[0] = { ...(plan.attempts[0] as object), usage: usage(1.25) } as never;
    plan.attempts[1] = { ...(plan.attempts[1] as object), usage: usage(0.5) } as never;
  }
  const impl = r.nodes[1];
  if (impl) impl.attempts[0] = { ...(impl.attempts[0] as object), usage: usage(null) } as never;
};

const detailsOf = (mutate: (r: RunReport) => void, extra: Partial<HistoryHost> = {}) =>
  service({ historyRun: async () => data(mutate), ...extra });

describe("the cost of a node, the size of a task and the rows of a report", () => {
  test("history_tools_node_rows_carry_what_the_node_cost", async () => {
    const answer = await call(detailsOf(withUsage), "history_run_details", {
      run_id: ID,
      limit: 10,
    });
    const [plan, impl, ship] = answer.nodes;
    expect(plan.usage).toEqual({
      attempts_with_usage: 2,
      input: 20,
      output: 40,
      cache_read: 60,
      cache_write: 80,
      calls: 4,
      usd: 1.75,
    });
    // an attempt with no price counts in the tokens, and its dollars are unknown, not zero
    expect(impl.usage.usd).toBeNull();
    expect(impl.usage.calls).toBe(2);
    expect(ship.usage).toBeUndefined();
  });

  test("history_tools_usage_names_what_no_step_used", async () => {
    const line = { tokens: { input: 1 }, cost: { usd: 0.4 } };
    const svc = detailsOf((r) => {
      r.usage = {
        estimate: true,
        revisions: ["r1"],
        total: { tokens: { input: 5 }, cost: { usd: 2 } },
        lower_bound: true,
        complete: true,
        unattributed: line,
        attempts: [],
        failed: [],
      } as unknown as RunReport["usage"];
    });
    const answer = await call(svc, "history_run_details", { run_id: ID, fields: ["usage"] });
    expect(answer.usage.unattributed).toEqual(line);
    expect(answer.usage.total.cost.usd).toBe(2);
  });

  test("history_tools_task_size_is_a_block_of_the_run", async () => {
    const sized = detailsOf((r) => {
      r.task_size = {
        files: 12,
        added: 100,
        removed: 7,
        binary_files: 1,
        top_dirs: Array.from({ length: 25 }, (_, i) => ({ dir: `d${i}`, files: 25 - i })),
        languages: [{ ext: "ts", files: 10 }],
      };
    });
    const answer = await call(sized, "history_run_details", { run_id: ID, fields: ["task_size"] });
    expect(answer.task_size).toMatchObject({ files: 12, added: 100, removed: 7, binary_files: 1 });
    expect(answer.task_size.top_dirs.length).toBe(10);
    expect(answer.task_size.top_dirs_omitted).toBe(15);
    const none = await call(
      detailsOf(() => {}),
      "history_run_details",
      {
        run_id: ID,
        fields: ["task_size"],
      },
    );
    expect(none.task_size).toEqual({ not_collected: true });
    const off = await call(
      detailsOf((r) => {
        r.task_size = { not_collected: true };
      }),
      "history_run_details",
      { run_id: ID },
    );
    expect(off.task_size).toEqual({ not_collected: true });
    const bad = await call(
      detailsOf(() => {}),
      "history_run_details",
      { run_id: ID, fields: ["nope"] },
    );
    expect(bad.details.allowed).toContain("task_size");
  });

  test("history_tools_attempt_level_carries_the_rows_of_a_report", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      severity: i === 0 ? "major" : "minor",
      location: `file-${i}.ts:${i}`,
      description: i === 0 ? `a secret ${SECRET} in a finding ${"y".repeat(700)}` : `finding ${i}`,
    }));
    const stored = detailsOf(() => {}, {
      historyAttemptReport: async (_run, node, attempt) =>
        node === "plan" && attempt === 1 ? { completeness: "complete", rows } : undefined,
    });
    const answer = await call(stored, "history_run_details", {
      run_id: ID,
      node: "plan",
      attempt: 1,
    });
    expect(answer.report_rows.completeness).toBe("complete");
    expect(answer.report_rows.rows.length).toBe(50);
    expect(answer.report_rows.omitted).toBe(30);
    expect(answer.report_rows.rows[0]).toMatchObject({
      severity: "major",
      location: "file-0.ts:0",
    });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.report_rows.rows[0].description.length).toBeLessThanOrEqual(500);
    // an attempt that stored no report has no such block
    const none = await call(stored, "history_run_details", {
      run_id: ID,
      node: "plan",
      attempt: 2,
    });
    expect(none.report_rows).toBeUndefined();
    // and fields can ask for it alone
    const only = await call(stored, "history_run_details", {
      run_id: ID,
      node: "plan",
      attempt: 1,
      fields: ["report_rows"],
    });
    expect(Object.keys(only.report_rows).sort()).toEqual(["completeness", "omitted", "rows"]);
  });
});

describe("history_stats", () => {
  const statsHost = (count: number, mutate: (r: RunReport, i: number) => void = () => {}) => {
    const rows = Array.from({ length: count }, (_, i) => row(i + 1));
    const host = {
      historyRuns: async () => [...rows, row(900, { pipeline: "other" })],
      historyRun: async (runId: string) => {
        const i = rows.findIndex((r) => r.run_id === runId);
        return data((r) => mutate(r, i));
      },
    } satisfies HistoryHost;
    return { rows, host };
  };

  test("history_tools_stats_counts_the_runs_of_a_pipeline_for_the_agent", async () => {
    const { host } = statsHost(4, (r, i) => {
      withUsage(r);
      const attempt = r.nodes[0]?.attempts[0];
      if (attempt && i % 2 === 0) attempt.failure = { source: "check", reason: "tests failed" };
    });
    const answer = await call(service(host), "history_stats", { pipeline: "dev" });
    expect(answer).toMatchObject({ ok: true, level: "stats", scope: "all" });
    expect(answer.runs).toMatchObject({ pipeline: "dev", considered: 4, read: 4, skipped: 0 });
    const plan = answer.nodes.find((n: Loose) => n.node === "plan");
    expect(plan).toMatchObject({ runs: 4, attempts: 8 });
    expect(plan.per_run).toBe(2);
    expect(plan.failures[0]).toMatchObject({ source: "check", reason: "tests failed" });
    expect(plan.usage.usd).toBeCloseTo(7, 5);
    expect(answer.versions).toBeUndefined();
    expect(answer.seconds.total.n).toBeGreaterThan(0);
  });

  test("history_tools_stats_takes_the_newest_runs_and_counts_what_it_could_not_read", async () => {
    const { rows, host } = statsHost(6);
    const broken = rows[5]?.run_id;
    const svc = service({
      ...host,
      historyRun: async (runId: string, options?: { patch?: boolean }) => {
        // a count over many runs asks for no patch to be read
        expect(options).toEqual({ patch: false });
        if (runId === broken) throw new Error("cannot read");
        return data();
      },
    });
    const answer = await call(svc, "history_stats", { pipeline: "dev", limit: 3 });
    expect(answer.runs).toMatchObject({ considered: 3, read: 2, skipped: 1, total_of_pipeline: 6 });
    expect(answer.runs.newest > answer.runs.oldest).toBe(true);
    const none = await call(service(host), "history_stats", { pipeline: "nothing" });
    expect(none.runs).toMatchObject({ considered: 0, read: 0 });
    expect(none.nodes).toEqual([]);
  });

  test("history_tools_stats_fields_limit_and_versions_are_checked", async () => {
    const { host } = statsHost(2);
    const svc = service(host);
    expect((await call(svc, "history_stats", {})).code).toBe("INVALID_ARGUMENTS");
    for (const limit of [0, 201]) {
      expect((await call(svc, "history_stats", { pipeline: "dev", limit })).code).toBe(
        "INVALID_ARGUMENTS",
      );
    }
    const bad = await call(svc, "history_stats", { pipeline: "dev", fields: ["nodes", "nope"] });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(bad.details.allowed).toContain("versions");
    const only = await call(svc, "history_stats", { pipeline: "dev", fields: ["seconds"] });
    expect(Object.keys(only).sort()).toEqual(["level", "ok", "scope", "seconds"]);
    const versions = await call(svc, "history_stats", { pipeline: "dev", fields: ["versions"] });
    expect(Array.isArray(versions.versions)).toBe(true);
  });

  test("history_tools_stats_is_capped_and_says_what_it_left_out", async () => {
    const { host } = statsHost(3, (r) => {
      r.nodes = Array.from({ length: 300 }, (_, i) => ({
        node: `node-${i}-${"n".repeat(60)}`,
        gate: false,
        seconds: 5,
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            seconds: 5,
            failure: { source: "check", reason: `reason ${i} ${"r".repeat(400)}` },
            usage: usage(0.01, 1),
          },
        ],
      })) as never;
    });
    const answer = await call(service(host), "history_stats", { pipeline: "dev" });
    expect(new TextEncoder().encode(JSON.stringify(answer, null, 2)).length).toBeLessThan(
      64 * 1024,
    );
    expect(answer.nodes.length).toBeLessThan(100);
    expect(answer.nodes_omitted).toBe(300 - answer.nodes.length);
  });

  test("history_tools_stats_output_is_redacted", async () => {
    const { host } = statsHost(1, (r) => {
      const attempt = r.nodes[0]?.attempts[0];
      if (attempt) attempt.failure = { source: "check", reason: `token ${SECRET} leaked` };
    });
    const answer = await call(service(host), "history_stats", { pipeline: "dev" });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });
});

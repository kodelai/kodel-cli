/**
 * The history tools on a fake host: what the agent is sent, how it pages, what it can ask for and what it is
 * never sent. The reads of a real store are tested in `packages/local/test/history-tools.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  type HistoryAgentLogData,
  type HistoryEvent,
  type HistoryHost,
  type HistoryRunData,
  type HistoryRunRow,
  type PipelineHost,
  PipelineService,
  type RunReport,
  redactText,
} from "../src";
import {
  CONTRACT_VERSION,
  HISTORY_TOOLS,
  invokeHistoryTool,
  SERVER_INSTRUCTIONS,
} from "../src/mcp";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

// Assembled at run time so this file does not trip secret scanners.
const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const PROJECT_SECRET = "corp-token-8f3a9c1d";

const service = (history: HistoryHost) =>
  new PipelineService({ ...history } as unknown as PipelineHost);
const call = (svc: PipelineService, name: string, args: Record<string, unknown>) =>
  invokeHistoryTool(svc, name, args) as Promise<Record<string, Loose>>;

const row = (i: number, extra: Partial<HistoryRunRow> = {}): HistoryRunRow => ({
  run_id: `r_${String(i).padStart(9, "0")}_abcd`,
  pipeline: i % 2 === 0 ? "dev" : "other",
  slug: `run-${i}`,
  status: i % 3 === 0 ? "completed" : "running",
  started_at: 1_700_000_000_000 + i * 1000,
  active: [],
  pauses: [],
  ...extra,
});

function fakeReport(): RunReport {
  const attempt = (n: number, extra: object = {}) => ({
    attempt: n,
    outcome: n === 1 ? "failed" : "passed",
    seconds: 10 * n,
    ...(n === 1 ? { failure: { source: "check", reason: "tests failed" } } : {}),
    summary: `attempt ${n}`,
    checks: [{ index: 0, kind: "command", passed: n !== 1, exit: n === 1 ? 1 : 0, ms: 100 }],
    ...extra,
  });
  const lines = Array.from({ length: 120 }, (_, i) => ({
    id: `call-${String(i).padStart(3, "0")}`,
    tool: i % 2 === 0 ? "Bash" : "Edit",
    started: "2026-11-01T10:00:00.000Z",
    ms: i,
    ok: true,
  }));
  return {
    runId: "r_000000001_abcd",
    task: `fix ${SECRET} in the build`,
    slug: "fix-build",
    status: "completed",
    total_s: 100,
    work_s: 90,
    busy_wall_s: 90,
    waiting_s: 10,
    nodes: [
      { node: "plan", gate: false, seconds: 30, attempts: [attempt(1), attempt(2)] },
      { node: "impl", gate: false, seconds: 50, attempts: [attempt(1)] },
      { node: "ship", gate: true, seconds: 10, attempts: [attempt(1)] },
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
    checks: [
      {
        check_id: "plan:0",
        kind: "command",
        node: "plan",
        runs: 2,
        fails: 1,
        wrong_check: 0,
        params_changes: 0,
        after_change: { passed: 0, failed: 0 },
      },
    ],
    prompts: { not_collected: true },
    agent_log: { not_collected: true, reason: "not_captured" },
    usage: { not_collected: true, reason: "not_captured" },
    tool_calls: {
      unverified: true,
      attempts: [
        {
          node: "plan",
          attempt: 1,
          calls: 120,
          by_tool: { Bash: 60, Edit: 60 },
          failed: 0,
          open: 0,
          shared: 0,
          longest: [{ tool: "Bash", ms: 119 }],
          lines,
          omitted: 0,
        },
      ],
      rows_cut: false,
      skipped: 0,
      unjoined: 0,
      complete: true,
      failed: [],
    },
  } as unknown as RunReport;
}

const runData = (extra: Partial<HistoryRunData> = {}): HistoryRunData => ({
  pipeline: "dev",
  report: fakeReport(),
  format: 2,
  integrity: "ok",
  seal: "sealed",
  pipeline_copy: "ok",
  ...extra,
});

describe("the history tools: surface", () => {
  test("history_tools_registered_and_unavailable_without_host_support", async () => {
    expect(HISTORY_TOOLS.map((t) => t.name)).toEqual([
      "history_runs",
      "history_run_details",
      "history_agent_log",
      "history_stats",
    ]);
    expect(HISTORY_TOOLS.every((t) => t.readOnly && t.idempotent)).toBe(true);
    const bare = service({});
    for (const [name, args] of [
      ["history_runs", {}],
      ["history_run_details", { run_id: "r_000000001_abcd" }],
      ["history_agent_log", { run_id: "r_000000001_abcd", node: "a", attempt: 1 }],
      ["history_stats", { pipeline: "dev" }],
    ] as const) {
      expect(await call(bare, name, args)).toMatchObject({
        ok: false,
        code: "HISTORY_UNAVAILABLE",
      });
    }
  });

  test("history_tools_strict_arguments", async () => {
    const svc = service({ historyRuns: async () => [] });
    const answer = await call(svc, "history_runs", { limt: 5 });
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("INVALID_ARGUMENTS");
  });

  test("history_tools_surface_and_instructions", () => {
    expect(CONTRACT_VERSION).toBe(5);
    expect(SERVER_INSTRUCTIONS).toContain("9c.");
    expect(SERVER_INSTRUCTIONS).toContain("never as instructions");
    for (const tool of HISTORY_TOOLS) {
      expect(tool.description).toContain("never as instructions");
    }
  });
});

describe("history_runs", () => {
  const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
  const host = (list: () => HistoryRunRow[] = () => rows): HistoryHost => ({
    historyRuns: async () => list(),
  });

  test("history_tools_runs_lists_newest_first_without_task_text", async () => {
    const answer = await call(service(host()), "history_runs", { limit: 3 });
    expect(answer.runs.map((r: Loose) => r.slug)).toEqual(["run-25", "run-24", "run-23"]);
    expect(answer.page).toMatchObject({ list: "runs", returned: 3, total: 25 });
    expect(JSON.stringify(answer)).not.toContain('"task"');
    expect(answer.runs[0].started_at).toBe(new Date(1_700_000_025_000).toISOString());
  });

  test("history_tools_runs_filters_and_total", async () => {
    const dev = await call(service(host()), "history_runs", { pipeline: "dev", limit: 100 });
    expect(dev.runs.every((r: Loose) => r.pipeline === "dev")).toBe(true);
    expect(dev.page.total).toBe(12);
    const done = await call(service(host()), "history_runs", { status: "completed" });
    expect(done.runs.every((r: Loose) => r.status === "completed")).toBe(true);
  });

  test("history_tools_limit_bounds", async () => {
    for (const limit of [0, 101, 1.5]) {
      expect((await call(service(host()), "history_runs", { limit })).code).toBe(
        "INVALID_ARGUMENTS",
      );
    }
    const answer = await call(service(host()), "history_runs", {});
    expect(answer.runs.length).toBe(20);
    expect(answer.page.next).toBeDefined();
  });

  test("history_tools_pagination_walks_every_item_once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await call(service(host()), "history_runs", {
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...answer.runs.map((r: Loose) => r.run_id));
      cursor = answer.page.next;
    } while (cursor);
    expect(seen.length).toBe(25);
    expect(new Set(seen).size).toBe(25);
  });

  test("history_tools_runs_cursor_survives_a_new_run", async () => {
    const list = [...rows];
    const svc = service(host(() => list));
    const first = await call(svc, "history_runs", { limit: 10 });
    list.push(row(99)); // a run started between two calls goes to the top of the list
    const second = await call(svc, "history_runs", { limit: 10, cursor: first.page.next });
    const ids = [...first.runs, ...second.runs].map((r: Loose) => r.run_id);
    expect(new Set(ids).size).toBe(20);
    expect(ids).not.toContain(row(99).run_id);
  });

  test("history_tools_cursor_is_bound", async () => {
    const svc = service(host());
    const first = await call(svc, "history_runs", { limit: 5 });
    const other = await call(svc, "history_runs", {
      limit: 5,
      pipeline: "dev",
      cursor: first.page.next,
    });
    expect(other).toMatchObject({ ok: false, code: "INVALID_CURSOR" });
    // limit and fields may change between pages
    const changed = await call(svc, "history_runs", {
      limit: 2,
      fields: ["status"],
      cursor: first.page.next,
    });
    expect(changed.ok).toBe(true);
    const details = await call(
      service({ ...host(), historyRun: async () => runData() }),
      "history_run_details",
      { run_id: "r_000000001_abcd", cursor: first.page.next },
    );
    expect(details).toMatchObject({ ok: false, code: "INVALID_CURSOR" });
  });

  test("history_tools_forged_cursor_is_refused", async () => {
    const svc = service(host());
    for (const cursor of [
      "not a cursor",
      "e30",
      btoa("{}"),
      btoa(JSON.stringify({ b: "x", k: "y" })),
    ]) {
      expect(await call(svc, "history_runs", { cursor })).toMatchObject({
        ok: false,
        code: "INVALID_CURSOR",
      });
    }
    const first = await call(svc, "history_runs", { limit: 5 });
    const past = JSON.parse(atob(first.page.next.replaceAll("-", "+").replaceAll("_", "/")));
    const forged = btoa(JSON.stringify({ ...past, k: "r_nope" }));
    expect((await call(svc, "history_runs", { limit: 5, cursor: forged })).code).toBe(
      "INVALID_CURSOR",
    );
  });

  test("history_tools_fields_filter_and_validation", async () => {
    const svc = service(host());
    const answer = await call(svc, "history_runs", { fields: ["status"], limit: 2 });
    expect(Object.keys(answer.runs[0]).sort()).toEqual(["pipeline", "run_id", "status"]);
    const bad = await call(svc, "history_runs", { fields: ["status", "nope"] });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(bad.details.allowed).toContain("started_at");
  });

  test("history_tools_answer_is_capped_in_bytes", async () => {
    const heavy = Array.from({ length: 100 }, (_, i) =>
      row(i + 1, {
        workdir: "w".repeat(2000),
        active: Array.from({ length: 12 }, (_, j) => ({
          node: `node-${j}`,
          attempt: j,
          phase: "agent",
        })),
      }),
    );
    const svc = service(host(() => heavy));
    const first = await call(svc, "history_runs", { limit: 100 });
    expect(new TextEncoder().encode(JSON.stringify(first, null, 2)).length).toBeLessThan(64 * 1024);
    expect(first.runs.length).toBeLessThan(100);
    expect(first.page.next).toBeDefined();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const answer = await call(svc, "history_runs", { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const r of answer.runs) seen.add(r.run_id);
      cursor = answer.page.next;
    } while (cursor);
    expect(seen.size).toBe(100);
  });

  test("history_tools_oversize_item_makes_progress", async () => {
    const huge = row(9, {
      active: Array.from({ length: 4000 }, (_, j) => ({
        node: `n-${j}`,
        attempt: j,
        phase: "agent",
      })),
    });
    const answer = await call(service(host(() => [huge, row(2)])), "history_runs", { limit: 1 });
    expect(answer.runs.length).toBe(1);
    expect(answer.runs[0].truncated).toBe(true);
    expect(answer.page.next).toBeDefined();
  });

  test("history_tools_output_is_redacted_and_capped", async () => {
    const svc = service({
      ...host(() => [
        row(1, {
          slug: `x-${SECRET}`,
          task_key: `T-${SECRET}`,
          workdir: `/w/${PROJECT_SECRET}/${"y".repeat(800)}`,
        }),
      ]),
      historyRedact: (text) =>
        redactText(text, [{ name: "corp", pattern: /corp-token-[0-9a-f]+/g }]),
    });
    const answer = await call(svc, "history_runs", {});
    const text = JSON.stringify(answer);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROJECT_SECRET);
    expect(answer.runs[0].workdir.length).toBeLessThanOrEqual(500);
    // a failure repeats what the caller sent: it is redacted too
    const refused = await call(svc, "history_runs", { fields: [`bad-${SECRET}`] });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });
});

describe("history_run_details", () => {
  const host = (data: HistoryRunData | null = runData()): HistoryHost => ({
    historyRun: async () => data ?? undefined,
  });
  const id = "r_000000001_abcd";

  test("history_tools_details_level_run", async () => {
    const answer = await call(service(host()), "history_run_details", { run_id: id, limit: 2 });
    expect(answer.level).toBe("run");
    expect(answer.run).toMatchObject({ slug: "fix-build", status: "completed", format: 2 });
    expect(answer.run.task).not.toContain(SECRET);
    expect(answer.integrity).toEqual({ files: "ok", seal: "sealed", pipeline_copy: "ok" });
    expect(answer.nodes[0]).toMatchObject({
      node: "plan",
      attempts: 2,
      checks_run: 2,
      checks_failed: 1,
    });
    expect(answer.page).toMatchObject({ list: "nodes", returned: 2, total: 3 });
    expect(answer.tool_calls).toMatchObject({ unverified: true, calls: 120 });
    expect(answer.usage).toMatchObject({ not_collected: true });
  });

  test("history_tools_details_later_pages_hold_only_the_list", async () => {
    const svc = service(host());
    const first = await call(svc, "history_run_details", { run_id: id, limit: 2 });
    const second = await call(svc, "history_run_details", {
      run_id: id,
      limit: 2,
      cursor: first.page.next,
    });
    expect(Object.keys(second).sort()).toEqual(["level", "nodes", "ok", "page"]);
    expect(second.nodes.map((n: Loose) => n.node)).toEqual(["ship"]);
    expect(second.page.next).toBeUndefined();
  });

  test("history_tools_details_level_node", async () => {
    const svc = service(host());
    const answer = await call(svc, "history_run_details", { run_id: id, node: "plan", limit: 1 });
    expect(answer.level).toBe("node");
    expect(answer.node).toMatchObject({ node: "plan", attempts: 2 });
    expect(answer.checks.entries[0]).toMatchObject({ check_id: "plan:0", fails: 1 });
    expect(answer.attempts.length).toBe(1);
    expect(answer.attempts[0]).toMatchObject({ attempt: 1, outcome: "failed" });
    expect(answer.attempts[0].tool_calls).toMatchObject({ calls: 120 });
    expect(answer.page).toMatchObject({ list: "attempts", total: 2 });
    const second = await call(svc, "history_run_details", {
      run_id: id,
      node: "plan",
      limit: 1,
      cursor: answer.page.next,
    });
    expect(second.attempts[0].attempt).toBe(2);
    expect(second.node).toBeUndefined();
  });

  test("history_tools_details_level_attempt", async () => {
    const svc = service(host());
    const answer = await call(svc, "history_run_details", {
      run_id: id,
      node: "plan",
      attempt: 1,
      limit: 50,
    });
    expect(answer.level).toBe("attempt");
    expect(answer.attempt).toMatchObject({ attempt: 1, outcome: "failed" });
    expect(answer.tool_calls.unverified).toBe(true);
    expect(answer.tool_calls.lines.length).toBe(50);
    expect(answer.page).toMatchObject({ list: "tool_calls.lines", total: 120 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const next = await call(svc, "history_run_details", {
        run_id: id,
        node: "plan",
        attempt: 1,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...next.tool_calls.lines.map((l: Loose) => l.id));
      cursor = next.page.next;
    } while (cursor);
    expect(new Set(seen).size).toBe(120);
  });

  test("history_tools_cursor_ends_when_the_run_changes_format", async () => {
    // `kodel migrate` takes a run to a newer format between two pages: the walk starts again
    let format = 2;
    const svc = service({ historyRun: async () => runData({ format }) });
    const first = await call(svc, "history_run_details", { run_id: id, limit: 1 });
    format = 3;
    const second = await call(svc, "history_run_details", {
      run_id: id,
      limit: 1,
      cursor: first.page.next,
    });
    expect(second).toMatchObject({ ok: false, code: "INVALID_CURSOR" });
  });

  test("history_tools_details_attempt_in_progress", async () => {
    const data = runData();
    const plan = data.report.nodes[0];
    if (plan) plan.attempts[1] = { attempt: 2, seconds: 3 };
    const answer = await call(service(host(data)), "history_run_details", {
      run_id: id,
      node: "plan",
      attempt: 2,
    });
    expect(answer.ok).toBe(true);
    expect(answer.attempt.outcome).toBeUndefined();
    expect(answer.tool_calls.lines).toEqual([]);
  });

  test("history_tools_unknown_run_node_and_attempt", async () => {
    const svc = service(host());
    expect((await call(service(host(null)), "history_run_details", { run_id: id })).code).toBe(
      "UNKNOWN_RUN",
    );
    const noNode = await call(svc, "history_run_details", { run_id: id, attempt: 1 });
    expect(noNode).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    const node = await call(svc, "history_run_details", { run_id: id, node: "nope" });
    expect(node).toMatchObject({ ok: false, code: "UNKNOWN_NODE" });
    expect(node.details.nodes).toEqual(["plan", "impl", "ship"]);
    const attempt = await call(svc, "history_run_details", {
      run_id: id,
      node: "plan",
      attempt: 9,
    });
    expect(attempt).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
      details: { attempts: 2 },
    });
  });

  test("history_tools_fields_keep_unverified_inside_the_block", async () => {
    const svc = service(host());
    const answer = await call(svc, "history_run_details", {
      run_id: id,
      fields: ["tool_calls"],
    });
    expect(answer.tool_calls.unverified).toBe(true);
    expect(answer.run).toBeUndefined();
    expect(answer.nodes).toBeUndefined();
    expect(answer.page).toBeUndefined();
    const bad = await call(svc, "history_run_details", {
      run_id: id,
      node: "plan",
      fields: ["run"],
    });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(bad.details.allowed).toEqual(["node", "checks", "attempts"]);
  });

  test("history_tools_not_collected_blocks_are_explained", async () => {
    const data = runData();
    data.report = { ...data.report, tool_calls: { not_collected: true, reason: "disabled" } };
    const answer = await call(service(host(data)), "history_run_details", { run_id: id });
    expect(answer.tool_calls).toEqual({ not_collected: true, reason: "disabled" });
    expect(answer.agent_log).toMatchObject({ not_collected: true });
    const level3 = await call(service(host(data)), "history_run_details", {
      run_id: id,
      node: "plan",
      attempt: 1,
    });
    expect(level3.tool_calls).toEqual({ not_collected: true, reason: "disabled" });
  });

  test("history_tools_blocks_are_bounded", async () => {
    const data = runData();
    data.report = {
      ...data.report,
      pipeline_changes: Array.from({ length: 50 }, (_, i) => ({
        at: 1_700_000_000_000 + i,
        from: "a",
        to: "b",
        source: "agent",
        nodes: [],
        effects: [],
      })),
    };
    const answer = await call(service(host(data)), "history_run_details", { run_id: id });
    expect(answer.pipeline_changes.entries.length).toBe(20);
    expect(answer.pipeline_changes.omitted).toBe(30);
  });

  test("history_tools_details_output_is_redacted", async () => {
    const answer = await call(
      service({ ...host(), historyRedact: (t) => redactText(t) }),
      "history_run_details",
      { run_id: id, node: `n-${SECRET}` },
    );
    expect(answer.ok).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });
});

describe("history_agent_log", () => {
  const event = (seq: number, kind: HistoryEvent["kind"], session = "s1", extra: object = {}) =>
    ({
      v: 1,
      agent: "claude-code",
      agent_version: "1",
      session_id: session,
      seq,
      ts: "2026-11-01T10:00:00.000Z",
      kind,
      ...extra,
    }) as unknown as HistoryEvent;
  const data = (): HistoryAgentLogData => ({
    format: 2,
    attribution: "time",
    sessions: [
      {
        session: "s1",
        events: [
          event(1, "message", "s1", { role: "user", text_preview: "hello" }),
          event(2, "tool_call", "s1", { id: "t1", name: "Bash", started: "x" }),
          event(3, "tool_result", "s1", { id: "t1", ok: true, ended: "x" }),
          event(4, "tool_call", "s1", { id: "t2", name: "Edit", started: "x" }),
          event(5, "tool_result", "s1", { id: "t2", ok: false, ended: "x" }),
        ],
      },
      {
        session: "s2",
        parent: "s1",
        events: [event(1, "message", "s2", { role: "user", text_preview: "sub" })],
      },
    ],
  });
  const host = (value: HistoryAgentLogData | null = data()): HistoryHost => ({
    historyAgentLog: async () => value ?? undefined,
  });
  const args = { run_id: "r_000000001_abcd", node: "plan", attempt: 1 };

  test("history_tools_agent_log_messages_behind_flag", async () => {
    const svc = service(host());
    const plain = await call(svc, "history_agent_log", args);
    expect(plain.unverified).toBe(true);
    expect(plain.events.map((e: Loose) => e.kind)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
    expect(plain.skipped).toEqual({ message: 2 });
    expect(JSON.stringify(plain)).not.toContain("hello");
    const withMessages = await call(svc, "history_agent_log", { ...args, include_messages: true });
    expect(withMessages.events.length).toBe(6);
    expect(withMessages.skipped).toBeUndefined();
    const refused = await call(svc, "history_agent_log", { ...args, kind: ["message"] });
    expect(refused).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(refused.message).toContain("include_messages");
  });

  test("history_tools_agent_log_filters", async () => {
    const svc = service(host());
    const bash = await call(svc, "history_agent_log", { ...args, tool: "Bash" });
    expect(bash.events.map((e: Loose) => e.seq)).toEqual([2, 3]);
    const results = await call(svc, "history_agent_log", { ...args, kind: ["tool_result"] });
    expect(results.events.length).toBe(2);
    const both = await call(svc, "history_agent_log", {
      ...args,
      kind: ["tool_result"],
      tool: "Edit",
    });
    expect(both.events.map((e: Loose) => e.id)).toEqual(["t2"]);
    expect((await call(svc, "history_agent_log", { ...args, kind: ["nope"] })).code).toBe(
      "INVALID_ARGUMENTS",
    );
  });

  test("history_tools_agent_log_pages_by_seq", async () => {
    const svc = service(host());
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await call(svc, "history_agent_log", {
        ...args,
        include_messages: true,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...answer.events.map((e: Loose) => `${e.session_id}:${e.seq}`));
      cursor = answer.page.next;
    } while (cursor);
    expect(seen).toEqual(["s1:1", "s1:2", "s1:3", "s1:4", "s1:5", "s2:1"]);
    // the flag is part of what the cursor is bound to
    const first = await call(svc, "history_agent_log", {
      ...args,
      include_messages: true,
      limit: 2,
    });
    const wrong = await call(svc, "history_agent_log", {
      ...args,
      limit: 2,
      cursor: first.page.next,
    });
    expect(wrong.code).toBe("INVALID_CURSOR");
    const forged = await call(svc, "history_agent_log", {
      ...args,
      include_messages: true,
      cursor: btoa(JSON.stringify({ b: "x", k: "s9:1" })),
    });
    expect(forged.code).toBe("INVALID_CURSOR");
  });

  test("history_tools_agent_log_fields", async () => {
    const answer = await call(service(host()), "history_agent_log", { ...args, fields: ["name"] });
    expect(Object.keys(answer.events[0]).sort()).toEqual(["kind", "name", "seq", "session_id"]);
    expect(
      (await call(service(host()), "history_agent_log", { ...args, fields: ["zzz"] })).details
        .allowed,
    ).toContain("ts");
  });

  test("history_tools_agent_log_reports_problems", async () => {
    const broken: HistoryAgentLogData = {
      format: 2,
      attribution: "time",
      sessions: [
        {
          session: "s1",
          events: [event(2, "tool_call", "s1", { id: "t1", name: "Bash", started: "x" })],
          problem: { kind: "damaged", detail: "line 3 is not JSON" },
        },
      ],
    };
    const svc = service(host(broken));
    const answer = await call(svc, "history_agent_log", args);
    expect(answer.partial).toBe(true);
    expect(answer.problems).toEqual([
      { session: "s1", kind: "damaged", detail: "line 3 is not JSON" },
    ]);
    expect(answer.events.length).toBe(1);
    const none = await call(
      service(host({ not_collected: true, reason: "disabled" })),
      "history_agent_log",
      args,
    );
    expect(none).toMatchObject({
      ok: true,
      not_collected: true,
      reason: "disabled",
      unverified: true,
    });
  });

  test("history_tools_agent_log_output_is_redacted_and_capped", async () => {
    const leaky: HistoryAgentLogData = {
      format: 2,
      attribution: "time",
      sessions: [
        {
          session: "s1",
          events: [
            event(1, "tool_result", "s1", {
              id: "t",
              ok: true,
              ended: "x",
              output_preview: `${SECRET} ${"z".repeat(900)}`,
            }),
          ],
        },
      ],
    };
    const answer = await call(service(host(leaky)), "history_agent_log", args);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.events[0].output_preview.length).toBeLessThanOrEqual(500);
  });

  test("history_tools_agent_log_unknown_run", async () => {
    expect((await call(service(host(null)), "history_agent_log", args)).code).toBe("UNKNOWN_RUN");
  });
});

describe("the review of the history tools", () => {
  const id = "r_000000001_abcd";
  const detailsOf = (mutate: (report: RunReport) => void, extra: Partial<HistoryRunData> = {}) => {
    const data = runData(extra);
    mutate(data.report);
    return service({ historyRun: async () => data });
  };

  test("history_tools_keys_of_the_answer_are_redacted_and_cut", async () => {
    const svc = detailsOf((report) => {
      const calls = report.tool_calls;
      if (calls && "attempts" in calls && calls.attempts[0]) {
        calls.attempts[0].by_tool = { [`Bash-${SECRET}`]: 1, ["k".repeat(900)]: 1 };
      }
    });
    const answer = await call(svc, "history_run_details", { run_id: id, node: "plan" });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(SECRET);
    for (const key of Object.keys(answer.attempts[0].tool_calls.by_tool)) {
      expect(key.length).toBeLessThanOrEqual(500);
    }
  });

  test("history_tools_findings_are_bounded", async () => {
    const svc = detailsOf((report) => {
      const attempt = report.nodes[0]?.attempts[0];
      if (attempt) {
        attempt.findings = Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [`sev-${i}`, i]),
        );
      }
    });
    const answer = await call(svc, "history_run_details", { run_id: id, node: "plan" });
    expect(Object.keys(answer.attempts[0].findings).length).toBe(50);
    expect(answer.attempts[0].findings_omitted).toBe(30);
  });

  test("history_tools_the_head_of_an_answer_is_bounded", async () => {
    const svc = detailsOf((report) => {
      report.agent_log = {
        sessions: 3,
        entries: 10,
        bytes: 10,
        mode: "full",
        passes: { tick: 1, step: 1 },
        cut: 0,
        failed: Array.from({ length: 500 }, (_, i) => `reason-${i}-${"z".repeat(400)}`),
        unverified: true,
        visits: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`n${i}:1`, i])),
      } as unknown as RunReport["agent_log"];
      report.pipeline_changes = Array.from({ length: 200 }, (_, i) => ({
        at: i,
        from: "a",
        to: "b",
        source: "agent",
        nodes: Array.from({ length: 40 }, (_, j) => ({
          slug: `n${j}`,
          changes: ["x".repeat(300)],
        })),
        effects: [],
      }));
    });
    const answer = await call(svc, "history_run_details", { run_id: id });
    expect(new TextEncoder().encode(JSON.stringify(answer, null, 2)).length).toBeLessThan(
      64 * 1024,
    );
    expect(answer.agent_log.visits).toBeUndefined();
    expect(answer.agent_log.failed.length).toBeLessThanOrEqual(20);
    expect(answer.page).toBeDefined();
  });

  test("history_tools_unknown_status_is_refused_with_the_known_ones", async () => {
    const svc = service({ historyRuns: async () => [row(1)] });
    const bad = await call(svc, "history_runs", { status: "finished" });
    expect(bad).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(bad.details.allowed).toContain("completed");
    for (const status of [
      "running",
      "paused",
      "completed",
      "failed",
      "canceled",
      "unreadable",
      "format 3",
    ]) {
      expect((await call(svc, "history_runs", { status })).ok).toBe(true);
    }
  });

  test("history_tools_cursor_does_not_carry_the_key", async () => {
    const secretSlugRows = Array.from({ length: 3 }, (_, i) => row(i + 1));
    const svc = service({
      historyRuns: async () => secretSlugRows,
      historyRun: async () =>
        runData({
          report: {
            ...fakeReport(),
            nodes: [
              { node: `n-${SECRET}`, gate: false, seconds: 1, attempts: [] },
              { node: "other", gate: false, seconds: 1, attempts: [] },
            ],
          },
        }),
    });
    const answer = await call(svc, "history_run_details", { run_id: id, limit: 1 });
    const cursor = String(answer.page.next);
    const decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    expect(decoded).not.toContain(SECRET);
    const next = await call(svc, "history_run_details", { run_id: id, limit: 1, cursor });
    expect(next.nodes.map((n: Loose) => n.node)).toEqual(["other"]);
  });

  test("history_tools_text_cut_at_500_and_across_a_surrogate_pair", async () => {
    const exactly = "a".repeat(500);
    const cases = [
      { slug: exactly, expected: 500 },
      { slug: `${exactly}b`, expected: 500 },
      // the 500th unit is the first half of a pair: the cut leaves no lone half
      { slug: `${"a".repeat(499)}\u{1F600}tail`, expected: 499 },
    ];
    for (const { slug, expected } of cases) {
      const svc = service({ historyRuns: async () => [row(1, { slug })] });
      const answer = await call(svc, "history_runs", {});
      expect(answer.runs[0].slug.length).toBe(expected);
    }
  });

  test("history_tools_a_secret_split_by_the_cut_does_not_come_out", async () => {
    // the secret starts before the cut and ends after it: redacted whole first, then cut
    const slug = `${"a".repeat(489)} ${SECRET} ${"b".repeat(50)}`;
    const svc = service({ historyRuns: async () => [row(1, { slug })] });
    const text = JSON.stringify(await call(svc, "history_runs", {}));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET.slice(0, 12));
  });

  test("history_tools_runs_with_no_start_time_sort_last", async () => {
    const svc = service({
      historyRuns: async () => [row(1, { started_at: Number.NaN }), row(2), row(3)],
    });
    const answer = await call(svc, "history_runs", {});
    expect(answer.runs.map((r: Loose) => r.slug)).toEqual(["run-3", "run-2", "run-1"]);
  });

  test("history_tools_integrity_names_the_pipeline_copy", async () => {
    const answer = await call(
      service({ historyRun: async () => runData({ pipeline_copy: "modified" }) }),
      "history_run_details",
      { run_id: id },
    );
    expect(answer.integrity).toEqual({ files: "ok", seal: "sealed", pipeline_copy: "modified" });
  });

  test("history_tools_agent_log_cursor_is_bound_to_the_format", async () => {
    let format = 2;
    const events = Array.from({ length: 4 }, (_, i) => ({
      v: 1,
      agent: "claude-code",
      agent_version: "1",
      session_id: "s1",
      seq: i + 1,
      ts: "2026-11-01T10:00:00.000Z",
      kind: "system",
      subtype: "x",
    })) as unknown as HistoryEvent[];
    const svc = service({
      historyAgentLog: async () => ({
        format,
        attribution: "time" as const,
        sessions: [{ session: "s1", events }],
      }),
    });
    const args = { run_id: id, node: "plan", attempt: 1, limit: 2 };
    const first = await call(svc, "history_agent_log", args);
    format = 3;
    const second = await call(svc, "history_agent_log", { ...args, cursor: first.page.next });
    expect(second).toMatchObject({ ok: false, code: "INVALID_CURSOR" });
  });
});

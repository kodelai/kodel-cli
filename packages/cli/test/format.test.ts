import { describe, expect, test } from "bun:test";
import type { RunReport, UsageLine } from "@kodel-ai/pipeline-core";
import { agentLogLine, formatDuration, formatReport, usageLines } from "../src/format";

describe("formatDuration", () => {
  test("is short enough for a table", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45.4)).toBe("45 s");
    expect(formatDuration(59.6)).toBe("1m 00s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3_780)).toBe("1h 03m");
  });
});

const report: RunReport = {
  runId: "r_000000001_aaaa",
  task: "add a limit",
  slug: "add-a-limit",
  status: "completed",
  total_s: 125,
  work_s: 50,
  busy_wall_s: 50,
  waiting_s: 75,
  forks: [],
  critical_path: [],
  failed_branches: false,
  restarts: 1,
  pauses: 0,
  feedback: 2,
  extra_attempts: 1,
  refused: 0,
  refusals: [],
  pipeline_changes: [],
  agent_decisions: [],
  checks: [],
  prompts: { served: 3 },
  agent_log: { not_collected: true, reason: "not_captured" },
  usage: { not_collected: true, reason: "not_captured" },
  nodes: [
    {
      node: "impl",
      gate: false,
      seconds: 50,
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          seconds: 20,
          failure: { source: "check:command", reason: "exit code 1" },
        },
        { attempt: 2, outcome: "passed", seconds: 30 },
      ],
    },
    {
      node: "approve",
      gate: true,
      seconds: 75,
      attempts: [{ attempt: 1, outcome: "approved", seconds: 75 }],
    },
  ],
};

describe("formatReport", () => {
  const text = formatReport(report, (t) => t);

  test("opens with the run, then the time split in two", () => {
    const [first, second] = text.split("\n");
    expect(first).toBe("run r_000000001_aaaa  completed  add-a-limit  add a limit");
    expect(second).toBe("total 2m 05s: work 50 s, waiting for a person 1m 15s");
  });

  test("a table of nodes marks the ones a person decides", () => {
    expect(text).toContain("impl     2         50 s");
    expect(text).toContain("approve  1         1m 15s  (a person decides)");
  });

  test("a pipeline changed during the run is listed, and a change of checks is called out", () => {
    expect(text).not.toContain("the pipeline was changed");
    const changed = formatReport(
      {
        ...report,
        pipeline_changes: [
          {
            at: 0,
            from: "aaaa",
            to: "bbbb",
            source: "proposal",
            nodes: [{ slug: "impl", changes: ["checks"] }],
            effects: [{ kind: "recheck", node: "impl" }],
            reason: "tests count too",
          },
        ],
        nodes: [
          {
            node: "impl",
            gate: false,
            seconds: 2,
            attempts: [
              { attempt: 1, seconds: 1, definition: { work: "w", checks: "c1", routing: "r" } },
              {
                attempt: 2,
                seconds: 1,
                definition: { work: "w", checks: "c2", routing: "r" },
                definition_changed: ["checks"],
              },
            ],
          },
        ],
      },
      (t) => t,
    );
    expect(changed).toContain("the pipeline was changed while the run went:");
    expect(changed).toContain(
      "the agent's proposal  impl (checks)  then: recheck impl  (tests count too)",
    );
    expect(changed).toContain("NOTE: the checks of impl were changed during this run");
    expect(changed).toContain("impl #2: checks");
  });

  test("t40_report_format_history_read_effects_list", () => {
    const change = {
      at: 0,
      from: "aaaa",
      to: "bbbb",
      source: "file",
      nodes: [
        { slug: "a", changes: ["routing"] },
        { slug: "b", changes: ["work"] },
      ],
    };
    // one entry per step the run stood at, in the order the engine applied them
    const several = formatReport(
      {
        ...report,
        pipeline_changes: [
          {
            ...change,
            effects: [
              { kind: "restart", node: "b" },
              { kind: "reroute", node: "a-test" },
            ],
          },
        ],
      },
      (t) => t,
    );
    expect(several).toContain("a (routing), b (work)  then: restart b, reroute a-test");
    // and nothing redone is said so
    const none = formatReport(
      { ...report, pipeline_changes: [{ ...change, effects: [] }] },
      (t) => t,
    );
    expect(none).toContain("a (routing), b (work)  then: nothing");
  });

  test("what did not pass is listed with the reason, and only when something did not pass", () => {
    expect(text).toContain("impl #1 failed: exit code 1");
    const clean = formatReport({ ...report, nodes: [report.nodes[1] as never] }, (t) => t);
    expect(clean).not.toContain("what did not pass");
  });

  test("everything that came from outside goes through the filter", () => {
    const loud = formatReport(
      {
        ...report,
        task: "x\u001b[2J",
        slug: "s\u001b[2J",
        nodes: [{ ...report.nodes[0], node: "n\u0007" } as never],
      },
      (t) => [...t].map((c) => (c.charCodeAt(0) < 32 ? "?" : c)).join(""),
    );
    expect(loud).not.toContain("\u001b");
    expect(loud).not.toContain("\u0007");
  });
});

describe("jspb_format_report_checks_and_size", () => {
  test("without check rows and without a size nothing about them is printed", () => {
    const text = formatReport(report, (t) => t);
    expect(text).not.toContain("checks:");
    expect(text).not.toContain("task size");
  });

  test("check rows are a table; escapes in an id go through plain", () => {
    const text = formatReport(
      {
        ...report,
        checks: [
          {
            check_id: "tests\u001b[2J",
            kind: "command",
            runs: 3,
            fails: 2,
            wrong_check: 1,
            params_changes: 1,
            after_change: { passed: 1, failed: 0 },
          },
        ],
      },
      (t) => t.split("\u001b").join("?"),
    );
    expect(text).toContain("checks:");
    expect(text).toContain("tests?[2J     3      2      1        1  1 passed, 0 failed");
    expect(text).not.toContain("\u001b");
  });

  test("the size is a line, or not_collected", () => {
    expect(formatReport({ ...report, task_size: { not_collected: true } }, (t) => t)).toContain(
      "task size: not_collected",
    );
    const text = formatReport(
      {
        ...report,
        task_size: {
          files: 2,
          added: 10,
          removed: 3,
          binary_files: 0,
          top_dirs: [{ dir: "src", files: 2 }],
          languages: [{ ext: "ts", files: 2 }],
        },
      },
      (t) => t,
    );
    expect(text).toContain("task size: 2 file(s), +10 -3 lines");
    expect(text).toContain("directories: src 2");
    expect(text).toContain("languages: ts 2");
  });
});

describe("t3bk2 the line about the agent's log", () => {
  test("t3bk2_report_line", () => {
    const copied: Exclude<RunReport["agent_log"], { not_collected: true }> = {
      sessions: 2,
      entries: 1234,
      bytes: 56 * 1024,
      mode: "full",
      passes: { tick: 80, step: 12 },
      cut: 0,
      final_pass: true,
      failed: [],
      unverified: true,
    };
    expect(agentLogLine(copied)).toBe(
      "agent log: 2 session(s), 1234 entries, 56 KB, mode full, copied 12 time(s) at the end of a step and 80 on the timer (unverified)",
    );
    expect(agentLogLine({ ...copied, cut: 3, final_pass: false, failed: ["tick_cap"] })).toBe(
      "agent log: 2 session(s), 1234 entries, 56 KB, mode full, copied 12 time(s) at the end of a step and 80 on the timer, 3 event(s) left out for want of room, ended in the middle of a step, not copied: tick_cap (unverified)",
    );
    // a run that is going has no word on its end yet
    const { final_pass: _gone, ...going } = copied;
    expect(agentLogLine(going)).not.toContain("middle of a step");
  });

  test("t3bk2_report_reasons_exact", () => {
    expect(agentLogLine({ not_collected: true, reason: "not_captured" })).toBe(
      "agent log: not_collected (not_captured)",
    );
    expect(agentLogLine({ not_collected: true, reason: "disabled" })).toBe(
      "agent log: not_collected (disabled)",
    );
    const none = {
      sessions: 0,
      entries: 0,
      bytes: 0,
      mode: "full",
      passes: { tick: 0, step: 0 },
      cut: 0,
      unverified: true as const,
    };
    expect(agentLogLine({ ...none, failed: ["session_unknown", "log_missing"] })).toBe(
      "agent log: not_collected (session_unknown, log_missing)",
    );
    expect(agentLogLine({ ...none, failed: [] })).toBe("agent log: nothing copied yet");
    // a stored stream that changed or a log that did: said by what happened, never as "modified"
    for (const reason of [
      "log_changed",
      "stored_copy_changed",
      "refused",
      "unreadable",
      "tick_cap",
    ] as const) {
      const line = agentLogLine({ ...none, failed: [reason] });
      expect(line).toContain(reason);
      expect(line).not.toMatch(/modified/i);
    }
  });

  test("t3bk2_report_line_is_in_the_report", () => {
    const text = formatReport(
      { ...report, agent_log: { not_collected: true, reason: "disabled" } },
      (t) => t,
    );
    expect(text).toContain("agent log: not_collected (disabled)");
  });
});

describe("usage in the report", () => {
  const line = (over: Partial<UsageLine> = {}): UsageLine => ({
    tokens: {
      input: 300,
      output: 30,
      cache_read: 1000,
      cache_write: 300,
      cache_write_1h: 100,
      api_calls: 2,
    },
    cost: { usd: 0.0123, basis: "computed", partial: false, config: false, long_context: false },
    models: {
      "claude-sonnet-5-5": {
        input: 300,
        output: 30,
        cache_read: 1000,
        cache_write: 300,
        cache_write_1h: 100,
        api_calls: 2,
        usd: 0.0123,
        partial: false,
      },
    },
    last_open: false,
    incomplete: false,
    subagent: false,
    dedupe_overflow: false,
    ...over,
  });
  const full = (over: Partial<UsageLine> = {}): RunReport["usage"] => ({
    estimate: true,
    revisions: ["2026-10-01"],
    total: line(over),
    lower_bound: true,
    complete: true,
    attempts: [{ node: "impl", attempt: 1, ...line(over) }],
    failed: [],
  });

  test("t9jrs_report_labels_estimate_and_revisions", () => {
    const lines = usageLines(full(), (t) => t);
    expect(lines[0]).toContain("estimate");
    expect(lines[0]).toContain("2026-10-01");
    expect(lines.join("\n")).toContain("at least this much");
    expect(lines.join("\n")).toContain("impl #1");
  });

  test("t9jrs_report_text_has_a_line_per_flag", () => {
    const flagged = line({
      last_open: true,
      incomplete: true,
      subagent: true,
      dedupe_overflow: true,
      cost: { usd: 0.5, basis: "computed", partial: true, config: true, long_context: true },
    });
    const text = usageLines(full(flagged), (t) => t).join("\n");
    for (const part of [
      "partial",
      "priced from the config",
      "long context",
      "last response counted as it stood",
      "incomplete",
      "includes subagents",
      "repeats may be counted twice",
    ]) {
      expect(text).toContain(part);
    }
  });

  test("t9jrs_report_partial_total_never_shows_zero_dollars", () => {
    const unknown = line({
      cost: { usd: null, basis: "unknown", partial: true, config: false, long_context: false },
    });
    const lines = usageLines(full(unknown), (t) => t);
    expect(lines[0]).toContain("cost unknown");
    // the total and the attempt say unknown, and show no dollar amount at all
    expect(lines[0]).not.toContain("$");
    expect(lines.find((l) => l.includes("impl #1"))).not.toContain("$");
  });

  test("t9jrs_report_small_known_cost_never_reads_as_zero_dollars", () => {
    const cheap = (usd: number) =>
      usageLines(
        full(
          line({
            cost: { usd, basis: "computed", partial: false, config: false, long_context: false },
          }),
        ),
        (t) => t,
      );
    // one cheap Haiku call is a known cost below $0.00005: it must not print as `$0.0000`
    expect(cheap(0.00003)[0]).toContain("< $0.0001");
    expect(cheap(0.00003)[0]).not.toContain("$0.0000");
    expect(cheap(0.0002)[0]).toContain("$0.0002");
    expect(cheap(1.5)[0]).toContain("$1.50");
    // a real zero (a free request) stays a zero
    expect(cheap(0)[0]).toContain("$0.0000");
  });

  test("t9jrs_report_each_not_collected_reason_is_named", () => {
    for (const reason of [
      "not_captured",
      "disabled",
      "session_unknown",
      "log_missing",
      "refused",
      "unreadable",
      "busy",
      "agent_unsupported",
    ] as const) {
      expect(usageLines({ not_collected: true, reason }, (t) => t)).toEqual([
        `usage: not_collected (${reason})`,
      ]);
    }
  });

  test("t9jrs_unknown_usage_format_is_cannot_read_not_modified", () => {
    const [text] = usageLines({ cannot_read: true, format: "2" }, (t) => t);
    expect(text).toContain("cannot read");
    expect(text).toContain("format 2");
    expect(text).not.toMatch(/modified/i);
  });

  test("t9jrs_report_never_shows_cost_state", () => {
    const text = formatReport({ ...report, usage: full() }, (t) => t);
    expect(text).not.toContain("cost-state");
    expect(text).toContain("usage (estimate");
  });

  test("t9jrs_report_json_has_usage", () => {
    const json = JSON.parse(JSON.stringify({ ...report, usage: full() })) as RunReport;
    expect("estimate" in json.usage).toBe(true);
  });
});

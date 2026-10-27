import { describe, expect, test } from "bun:test";
import type { RunReport } from "@kodel-ai/pipeline-core";
import { agentLogLine, formatDuration, formatReport } from "../src/format";

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
  waiting_s: 75,
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
            effect: "recheck",
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
      "the agent's proposal  impl (checks)  then: recheck  (tests count too)",
    );
    expect(changed).toContain("NOTE: the checks of impl were changed during this run");
    expect(changed).toContain("impl #2: checks");
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
      "agent log: 2 session(s), 1234 entries, 56 KB, mode full, copied 12 time(s) at the end of a step and 80 on the timer, 3 event(s) left out for want of room, ended without a final copy, not copied: tick_cap (unverified)",
    );
    // a run that is going has no word on its end yet
    const { final_pass: _gone, ...going } = copied;
    expect(agentLogLine(going)).not.toContain("final copy");
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

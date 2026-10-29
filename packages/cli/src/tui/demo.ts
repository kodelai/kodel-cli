/** Sample sessions for `kodel tui --demo`. Nothing here is read from a project. */
import type { Loaded } from "./load";
import type {
  Attempt,
  Comment,
  DiffState,
  GateDetail,
  LogEntry,
  Session,
  StepLine,
  Visit,
} from "./session";

const MIN = 60_000;
const HOUR = 60 * MIN;

const CODE_STEPS: StepLine[] = [
  { name: "plan", state: "done" },
  { name: "implement", state: "done" },
  { name: "checks", state: "done" },
  { name: "review", state: "waiting" },
  { name: "commit", state: "pending" },
];

const allDone = CODE_STEPS.map((s) => ({ ...s, state: "done" as const }));

export function demoSessions(now: number): Loaded {
  const sessions: Session[] = [
    {
      id: "r_0mvo6g4mi",
      title: "capture-usage-cost",
      pipeline: "dev",
      status: "waiting",
      need: "approve",
      step: "approve",
      since: now - 21 * MIN,
      workdir: "worktrees/capture-usage-cost",
      headline: "Step «review» waits for your decision",
      prompt:
        "Review the change. Old runs must read as cost unknown, never as zero. Check the fixtures under fixtures/formats/v1.",
      command: "kodel gate approve|reject r_0mvo6g4mi",
      steps: CODE_STEPS,
      log: [
        "14:42:10 node_finished      implement",
        "14:42:11 node_entered       review",
        "14:42:11 gate_waiting       review",
      ],
    },
    {
      id: "r_1kd93xa07",
      title: "pipeline-format-version",
      pipeline: "dev",
      status: "waiting",
      need: "pipeline_edit",
      step: "pipeline edit",
      since: now - 40 * MIN,
      workdir: "worktrees/pipeline-format-version",
      headline: "The agent proposes to change this run's pipeline",
      prompt:
        "The pipeline of this run was changed: lint now covers packages/ and tests/ only. Nothing runs again.",
      after: "approve «review»",
      command: "kodel pipeline changes apply r_1kd93xa07",
      steps: [
        { name: "plan", state: "done" },
        { name: "implement", state: "done" },
        { name: "review", state: "waiting" },
      ],
      log: [
        "14:20:03 check_finished     lint failed",
        "14:22:40 pipeline_change_proposed",
        "14:22:41 gate_waiting       review",
      ],
    },
    {
      id: "r_0vb88k4fn",
      title: "decisions-docs",
      pipeline: "docs",
      status: "waiting",
      need: "paused",
      step: "paused",
      since: now - 2 * HOUR - 5 * MIN,
      workdir: "worktrees/decisions-docs",
      headline: "Paused at «draft»: a step used up all its attempts",
      prompt: "The step failed 3 times. Resume gives it more attempts.",
      command: "kodel resume r_0vb88k4fn",
      steps: [
        { name: "draft", state: "failed", note: "attempt 3" },
        { name: "review", state: "pending" },
      ],
      log: ["12:30:00 check_finished     test failed", "12:31:12 run_paused         draft"],
    },
    {
      id: "r_0t55c8k21",
      title: "task-link-fix",
      pipeline: "dev",
      status: "waiting",
      need: "hand_edit",
      step: "hand edit",
      since: now - 3 * 24 * HOUR,
      headline: "Files of this run were changed outside kodel",
      prompt: "Look at what changed, then accept the run as it is now.",
      command: "kodel ack r_0t55c8k21",
      steps: allDone,
      log: ["09:12:00 manual_edit"],
    },
    {
      id: "r_1kd9q22vb",
      title: "fix-wait-timeout",
      pipeline: "dev",
      status: "running",
      activity: "working",
      step: "checks",
      since: now - 9 * MIN,
      workdir: "worktrees/fix-wait-timeout",
      steps: [
        { name: "plan", state: "done" },
        { name: "implement", state: "done" },
        { name: "checks", state: "running" },
      ],
      log: ["14:06:03 agent_completed     implement", "14:06:09 check_finished     typecheck"],
    },
    {
      id: "r_1kd9w31xc",
      title: "mcp-server-names",
      pipeline: "dev",
      status: "running",
      activity: "agent",
      step: "implement",
      since: now - 4 * MIN,
      steps: [
        { name: "plan", state: "done" },
        { name: "implement", state: "running" },
      ],
      log: ["14:11:20 node_entered       implement"],
    },
    {
      id: "r_1kd8aa019",
      title: "report-html-export",
      pipeline: "dev",
      status: "running",
      activity: "quiet",
      quietMs: 12 * MIN,
      step: "quiet 12m",
      since: now - 50 * MIN,
      steps: [
        { name: "plan", state: "done" },
        { name: "implement", state: "running" },
      ],
      log: ["13:20:00 node_entered       implement"],
    },
    {
      id: "r_0zz41pe8c",
      title: "report-pdf-export",
      pipeline: "dev",
      status: "failed",
      step: "implement",
      since: now - 26 * HOUR,
      reason: 'node "implement" failed with "no-fix" and nothing handles that',
      steps: [
        { name: "plan", state: "done" },
        { name: "implement", state: "failed", note: "attempt 2" },
      ],
      log: ["10:15:00 node_finished      implement no-fix", "10:15:00 run_finished"],
    },
    {
      id: "r_0xq77h2ta",
      title: "task-key-format",
      pipeline: "dev",
      status: "done",
      step: "done",
      since: now - 27 * HOUR,
      steps: allDone,
      log: ["16:20:00 run_finished"],
    },
    {
      id: "r_0wm10c9ds",
      title: "old-experiment",
      pipeline: "dev",
      status: "canceled",
      step: "canceled",
      since: now - 5 * 24 * HOUR,
      steps: [{ name: "plan", state: "done" }],
      log: ["11:00:00 run_finished"],
    },
    {
      id: "r_0mvh62i9e",
      title: "run-title-from-the-agent",
      pipeline: "dev",
      status: "unreadable",
      step: "unreadable",
      since: now - 6 * 24 * HOUR,
      headline: "This run cannot be opened",
      prompt:
        "It was written before pipelines were kept in versions (format 1, this kodel reads 2); finish it with the kodel that started it, or remove it.",
      steps: [],
      log: [],
    },
  ];
  return { sessions, proposals: 1 };
}

const attempt = (n: number, over: Partial<Attempt> = {}): Attempt => ({
  n,
  outcome: "passed",
  ok: true,
  checks: [],
  log: [],
  ...over,
});

const visit = (
  slug: string,
  kind: string,
  state: Visit["state"],
  a: Attempt,
  rework = false,
): Visit => ({ slug, kind, human: kind === "human", state, rework, attempt: a });

const REPORT = `## Done: \`kodel status\` prints one short line per run

I changed three files:

- \`packages/cli/src/format.ts\`: a new \`shortLine(run, max)\` that cuts the task text at its first line and adds "…"
- \`packages/cli/src/cli.ts\`: \`status\` uses it; \`--full\` keeps the old output
- \`packages/cli/test/\`: 9 new tests, all pass

**Not done:** the plan asked for a test for a run whose state cannot be read. The code handles it, but I did not add the test.

To try it: \`bun packages/cli/src/main.ts status\`, then \`status --full\`.

Approve to finish, or reject with what is wrong.`;

const SAMPLE_DIFF = `diff --git a/packages/cli/src/format.ts b/packages/cli/src/format.ts
--- a/packages/cli/src/format.ts
+++ b/packages/cli/src/format.ts
@@ -1,6 +1,18 @@
 import { formatTable } from "./table";

+/** One line for a run: its task cut at the first line, with "…" where it was cut. */
+export function shortLine(task: string, max: number): string {
+  const line = (task.split("\\n")[0] ?? "").trim();
+  return line.length <= max ? line : \`\${line.slice(0, max - 1)}…\`;
+}
+
 export function formatRuns(runs: Run[]): string {
-  return formatTable(runs.map((r) => [r.id, r.task]));
+  return formatTable(runs.map((r) => [r.id, shortLine(r.task, 60)]));
 }`;

/** The comments made on the sample gate; they live as long as the process does. */
const made = new Map<string, Comment[]>();

export async function demoAddComment(runId: string, comment: Comment): Promise<void> {
  made.set(runId, [...(made.get(runId) ?? []), comment]);
}

export async function demoDeleteComment(runId: string, index: number): Promise<void> {
  made.set(
    runId,
    (made.get(runId) ?? []).filter((_, i) => i !== index),
  );
}

export async function demoDiff(path: string): Promise<DiffState> {
  return path.endsWith("format.ts")
    ? { kind: "text", text: SAMPLE_DIFF, truncated: false }
    : {
        kind: "text",
        text: `diff --git a/${path} b/${path}\n@@ -1,3 +1,4 @@\n unchanged\n+added in the sample\n`,
        truncated: false,
      };
}

/** What the card of the sample run waiting for approval shows, shaped like a real run's. */
export function demoGateDetail(runId: string, now: number = Date.now()): GateDetail | undefined {
  if (runId !== "r_0mvo6g4mi") return undefined;
  const check = (node: string, label: string, ms: number, passed = true) => ({
    node,
    label,
    passed,
    ms,
  });
  const visits: Visit[] = [
    visit(
      "plan",
      "agent",
      "done",
      attempt(1, {
        ms: 46_000,
        checks: [check("plan", "plan diff", 153)],
        log: ["09:12:01 node_entered       plan", "09:12:47 check_finished     plan diff"],
      }),
    ),
    visit(
      "plan-approval",
      "human",
      "done",
      attempt(1, {
        outcome: "approved",
        ms: 9 * 60_000,
        decision: { decision: "approved" },
        log: ["09:12:47 gate_waiting       plan-approval", "09:22:00 gate_decided       approved"],
      }),
    ),
    visit(
      "impl",
      "agent",
      "failed",
      attempt(1, {
        outcome: "failed",
        ok: false,
        ms: 4 * 60_000,
        reason: "The diff check: 1438 lines changed, the limit is 800.",
        checks: [check("impl", "impl diff", 158, false)],
        log: ["09:22:01 node_entered       impl", "09:26:10 check_finished     impl diff failed"],
      }),
    ),
    visit(
      "impl",
      "agent",
      "done",
      attempt(2, {
        ms: 3 * 60_000,
        summary: "Split the change: the table printer stays as it was.",
        checks: [check("impl", "impl diff", 160)],
        log: ["09:26:11 node_entered       impl", "09:29:20 check_finished     impl diff"],
      }),
      true,
    ),
    visit(
      "verify",
      "command",
      "done",
      attempt(1, {
        ms: 1631,
        exit: 0,
        checks: [check("verify", "verify", 1631)],
        log: ["09:29:21 command_finished   verify exit 0"],
      }),
    ),
    visit(
      "test",
      "command",
      "failed",
      attempt(1, {
        outcome: "failed",
        ok: false,
        ms: 70_000,
        exit: 1,
        reason: "1 test failed: t40_wait_timeout_reports",
        checks: [check("test", "test", 70_000, false)],
        log: ["09:30:31 command_finished   test exit 1"],
      }),
    ),
    visit(
      "test",
      "command",
      "done",
      attempt(2, {
        ms: 85_684,
        exit: 0,
        checks: [check("test", "test", 85_684)],
        log: ["09:31:58 command_finished   test exit 0"],
      }),
      true,
    ),
    visit(
      "build",
      "command",
      "done",
      attempt(1, {
        ms: 282,
        exit: 0,
        checks: [check("build", "build", 282)],
        log: ["09:32:00 command_finished   build exit 0"],
      }),
    ),
    visit(
      "review",
      "agent",
      "done",
      attempt(1, {
        ms: 20_000,
        checks: [check("review", "review result", 61)],
        log: ["09:32:21 report_accepted    review 3 rows"],
        review: {
          completeness: "complete",
          findings: [
            {
              severity: "minor",
              location: "packages/cli/test/cli.test.ts:296",
              description:
                "The plan lists a test for a run whose state cannot be read, and none was added. The code handles it, so this is a coverage gap only.",
            },
            {
              severity: "minor",
              location: "packages/cli/src/format.ts:9",
              description:
                "line.slice(0, max) counts UTF-16 units and can split a surrogate pair at the cut.",
            },
            {
              severity: "info",
              location: "packages/cli/src/cli.ts:168",
              description:
                "The --full description differs slightly from the plan's wording. Harmless.",
            },
          ],
        },
      }),
    ),
    visit("final-approval", "human", "waiting", {
      n: 1,
      checks: [],
      ms: 21 * 60_000,
      log: ["09:32:22 gate_waiting       final-approval"],
    }),
  ];
  // When each visit began and ended, in minutes before now; the agent's log is laid on the same clock.
  const windows: [number, number | null][] = [
    [92, 91],
    [91, 82],
    [82, 78],
    [78, 75],
    [75, 74.9],
    [74.9, 73.7],
    [73.7, 72.3],
    [72.3, 72.2],
    [72, 71.6],
    [21, null],
  ];
  const at = (minutes: number) => now - Math.round(minutes * 60_000);
  for (const [i, v] of visits.entries()) {
    const w = windows[i];
    if (!w) continue;
    v.attempt.from = at(w[0]);
    if (w[1] !== null) v.attempt.to = at(w[1]);
  }
  const call = (
    minutes: number,
    tool: string,
    text: string,
    ok = true,
    said?: string,
  ): LogEntry => ({
    ts: at(minutes),
    kind: "call",
    tool,
    text,
    result: { ok, ms: 40, size: 2048, ...(said ? { text: said } : {}) },
  });
  const agentLog: LogEntry[] = [
    {
      ts: at(91.9),
      kind: "you",
      text: "Make `kodel status` readable: one short line per run instead of the full task text.",
    },
    {
      ts: at(91.6),
      kind: "text",
      text: "I'll read AGENTS.md and the status command first, then write the plan.",
    },
    call(91.4, "Read", "AGENTS.md"),
    call(91.2, "Grep", "formatRuns packages/cli/src"),
    { ts: at(91.05), kind: "text", text: "The plan is in docs/plans/make-status-readable.md." },
    {
      ts: at(77.5),
      kind: "text",
      text: "The first change was too big for the check. I am splitting it: the table printer stays as it was.",
    },
    call(76.5, "Edit", "packages/cli/src/format.ts"),
    call(
      75.5,
      "Bash",
      "bun run typecheck",
      false,
      "format.ts(9,3): error TS2322: Type 'string | undefined' is not assignable",
    ),
    call(75.3, "Edit", "packages/cli/src/format.ts"),
    call(71.9, "kodel:pipeline_report_result", "review: 3 rows"),
    { ts: at(71.7), kind: "text", text: "The review is in: 3 findings, none blocking." },
    { ts: at(20), kind: "text", text: "Done: `kodel status` prints one short line per run." },
  ];
  const journal = visits.flatMap((v) => v.attempt.log);
  return {
    node: "final-approval",
    attempt: 1,
    position: "gate 2 of 2",
    prompt: "Look at the diff and try the change. Approve to finish, or reject with what is wrong.",
    report: { text: REPORT, ts: now - 20 * 60_000, from: "log" },
    visits,
    checks: [
      check("plan", "plan diff", 153),
      check("impl", "impl diff", 160),
      check("verify", "verify", 1631),
      check("test", "test", 85_684),
      check("build", "build", 282),
      check("review", "review result", 61),
    ],
    changes: {
      kind: "files",
      files: [
        ["packages/cli/test/cli.test.ts", 142],
        ["packages/cli/src/cli.ts", 96],
        ["packages/cli/src/format.ts", 61],
        ["docs/plans/make-status-readable.md", 58],
        ["packages/cli/src/table.ts", 22],
      ],
      totalFiles: 5,
      totalLines: 379,
    },
    changedAfterChecks: [],
    comments: made.get(runId) ?? [],
    agentLog,
    metrics: {
      workMs: 92 * 60_000,
      waitMs: 30 * 60_000,
      stepsDone: 8,
      stepsTotal: 9,
      retries: 2,
      checksPassed: 6,
      checksTotal: 6,
      tokens: { total: 412_000, approx: false },
    },
    journal,
  };
}

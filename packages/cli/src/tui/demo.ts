/** Sample sessions for `kodel tui --demo`. Nothing here is read from a project. */
import type { Loaded } from "./load";
import type { Session, StepLine } from "./session";

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

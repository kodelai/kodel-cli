/** Sample data for the layout prototype. Nothing here is read from a project. */

export type SessionStatus = "waiting" | "running" | "failed" | "done";
export type WaitKind = "GATE" | "CHANGE" | "PROPOSAL" | "ACK";
export type StepState = "done" | "running" | "waiting" | "pending" | "failed";

export interface DemoStep {
  name: string;
  state: StepState;
  took?: string;
}

export interface DemoSession {
  id: string;
  title: string;
  pipeline: string;
  agent: string;
  status: SessionStatus;
  wait?: WaitKind;
  step: string;
  age: string;
  cost: string;
  workdir: string;
  summary?: string;
  files?: string[];
  steps: DemoStep[];
  log: string[];
}

const CODE_STEPS: DemoStep[] = [
  { name: "plan", state: "done", took: "4m" },
  { name: "implement", state: "done", took: "1h 21m" },
  { name: "checks", state: "done", took: "6m" },
  { name: "review", state: "waiting", took: "21m" },
  { name: "commit", state: "pending" },
];

export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "r_0mvo6g4mi",
    title: "capture-usage-cost",
    pipeline: "dev",
    agent: "claude-code",
    status: "waiting",
    wait: "GATE",
    step: "review",
    age: "21m",
    cost: "$3.41",
    workdir: "worktrees/capture-usage-cost",
    summary:
      "Added usage and cost to the step record. Old runs are read as cost unknown, never as zero. Tests t52_* pass.",
    files: [
      "packages/pipeline-core/src/run-state.ts  +88 -12",
      "packages/pipeline-core/src/usage.ts  +141 new",
      "fixtures/formats/v1/run-with-usage/  +57 new",
      "… 11 more files",
    ],
    steps: CODE_STEPS,
    log: [
      "14:02 step.start    implement",
      "14:41 check         typecheck ok 8s",
      "14:41 check         lint ok 2s",
      "14:42 check         bun test ok 412 passed",
      "14:42 step.done     implement",
      "14:43 step.start    review (human)",
      "14:43 waiting       GATE review",
    ],
  },
  {
    id: "r_1kd93xa07",
    title: "pipeline-format-version",
    pipeline: "dev",
    agent: "claude-code",
    status: "waiting",
    wait: "CHANGE",
    step: "change #2",
    age: "40m",
    cost: "$1.12",
    workdir: "worktrees/pipeline-format-version",
    summary:
      "The lint check failed on generated fixtures. Proposed: lint only packages/ and tests/.",
    files: [".kodel/pipelines/dev.yaml  paths: [packages/**, tests/**]"],
    steps: [
      { name: "plan", state: "done", took: "3m" },
      { name: "implement", state: "waiting", took: "35m" },
      { name: "review", state: "pending" },
      { name: "commit", state: "pending" },
    ],
    log: [
      "13:52 step.start    implement",
      "14:20 check         lint failed 41 problems in fixtures/",
      "14:22 propose       pipeline change #2",
      "14:22 waiting       CHANGE accept or discard",
    ],
  },
  {
    id: "—",
    title: "release.yaml (new pipeline)",
    pipeline: "release",
    agent: "claude-code",
    status: "waiting",
    wait: "PROPOSAL",
    step: "proposal",
    age: "1h",
    cost: "—",
    workdir: "—",
    summary: "A new pipeline for releases: build, check artifact, tag, publish notes.",
    files: [".kodel/proposals/release.yaml"],
    steps: [],
    log: ["13:30 propose       release.yaml", "13:30 waiting       PROPOSAL accept or discard"],
  },
  {
    id: "r_0vb88k4fn",
    title: "decisions-docs",
    pipeline: "docs",
    agent: "codex",
    status: "waiting",
    wait: "ACK",
    step: "state changed",
    age: "3d",
    cost: "$0.90",
    workdir: "worktrees/decisions-docs",
    summary: "The run state was changed outside kodel. Accept the state to continue.",
    steps: [
      { name: "draft", state: "done", took: "9m" },
      { name: "review", state: "waiting" },
    ],
    log: ["11:04 notice        state changed outside kodel", "11:04 waiting       ACK"],
  },
  {
    id: "r_1kd9q22vb",
    title: "fix-wait-timeout",
    pipeline: "dev",
    agent: "claude-code",
    status: "running",
    step: "implement",
    age: "9m",
    cost: "$0.47",
    workdir: "worktrees/fix-wait-timeout",
    steps: [
      { name: "plan", state: "done", took: "3m" },
      { name: "implement", state: "running", took: "9m" },
      { name: "review", state: "pending" },
      { name: "commit", state: "pending" },
    ],
    log: [
      "14:02 step.start    implement (attempt 1)",
      "14:06 check         test failed t40_wait_timeout_reports",
      "14:06 step.retry    implement, the agent got the reason",
      "14:08 agent         ran bun test wait",
    ],
  },
  {
    id: "r_0zz41pe8c",
    title: "report-pdf-export",
    pipeline: "dev",
    agent: "claude-code",
    status: "failed",
    step: "checks 3/3",
    age: "1d",
    cost: "$5.80",
    workdir: "worktrees/report-pdf-export",
    steps: [
      { name: "plan", state: "done", took: "5m" },
      { name: "implement", state: "failed", took: "2h 10m" },
    ],
    log: ["10:15 check         test failed (3rd attempt)", "10:15 run.stop      checks exhausted"],
  },
  {
    id: "r_0xq77h2ta",
    title: "task-key-format",
    pipeline: "dev",
    agent: "claude-code",
    status: "done",
    step: "done",
    age: "1d",
    cost: "$2.05",
    workdir: "worktrees/task-key-format",
    steps: CODE_STEPS.map((s) => ({ ...s, state: "done" as const })),
    log: ["16:20 step.done     commit", "16:20 run.done"],
  },
  {
    id: "r_0wm10c9ds",
    title: "mcp-instructions",
    pipeline: "dev",
    agent: "claude-code",
    status: "done",
    step: "done",
    age: "2d",
    cost: "$1.73",
    workdir: "worktrees/mcp-instructions",
    steps: CODE_STEPS.map((s) => ({ ...s, state: "done" as const })),
    log: ["09:12 step.done     commit", "09:12 run.done"],
  },
];

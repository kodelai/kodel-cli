/**
 * Pieces of the `kodel-design` scenario (`claude-code-design-skill.test.ts`): the repositories it
 * runs on, a sandbox made from a pinned clone, the checks that need no model, and the judge.
 * What needs no agent is tested without one, in `design.test.ts`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS } from "../../packages/cli/src/init/skills";
import type { PipelineSpec } from "../../packages/pipeline-core/src";
import { agentEnv, MODEL, type Sandbox } from "./harness";

export interface DesignFixture {
  name: string;
  url: string;
  /** The full commit the scenario runs on; the repository may move on, the test does not. */
  sha: string;
  /** Run in the fresh copy before the agent starts, so that the project's commands can work. */
  prepare: string[][];
  /** Commands that prove a change is good here: each must appear in the pipeline, and must pass. */
  commands: { label: string; pattern: RegExp; run: string }[];
  /** What the judge checks that a pattern cannot: each is a yes/no question about the pipeline. */
  checklist: string[];
  /** A small task that this repository does not have yet, for the run of stage 3. */
  task: string;
  /** The files the finished task must have changed. */
  touches: RegExp;
  /** Files the task says not to change; none of them may show up as changed. */
  keeps: RegExp;
}

export const FIXTURES: DesignFixture[] = [
  {
    name: "p-limit",
    url: "https://github.com/sindresorhus/p-limit",
    sha: "a8a6fbec4e0e866d6d779b10889bb4f5567e70eb",
    // no lock file in this repository, so the dependencies are not pinned, only the code is
    prepare: [["npm", "install", "--no-audit", "--no-fund"]],
    commands: [{ label: "npm test", pattern: /npm (run )?test|\bava\b/, run: "npm test" }],
    checklist: [
      "The pipeline's command steps use the commands the project defines (the `test` script of package.json), not commands it does not have.",
      "A profile (`lean`, `standard` or `strict`) is named in the summary, with a reason for it. `standard` is the documented default and needs no more reason than that.",
      "At least one prompt points the agent to the project's conventions or says what the step must not touch.",
      "The summary lists the assumptions: the commands found, the profile, and any step left out with a reason.",
    ],
    task:
      "Add one more test to test.js for a behavior of p-limit that no existing test covers. " +
      "Do not change index.js.",
    touches: /^test\.js$/m,
    keeps: /^(index\.js|index\.d\.ts)$/m,
  },
  {
    name: "itsdangerous",
    url: "https://github.com/pallets/itsdangerous",
    sha: "672971d66a2ef9f85151e53283113f33d642dabd",
    prepare: [["uv", "sync", "--locked", "--quiet"]],
    commands: [{ label: "pytest", pattern: /pytest|tox/, run: "uv run --locked pytest -q" }],
    checklist: [
      "The pipeline's command steps use the commands the project really runs (pytest, via uv or tox, as its CI does), not an npm or make command it does not have.",
      "A profile (`lean`, `standard` or `strict`) is named in the summary, with a reason for it. `standard` is the documented default and needs no more reason than that.",
      "The project's linting or typing (ruff, mypy, pre-commit) is either a step or left out with a stated reason.",
      "The summary lists the assumptions: the commands found, the profile, and any step left out with a reason.",
    ],
    task:
      "Add one more test under tests/ for a behavior of itsdangerous that no existing test " +
      "covers. Do not change anything under src/.",
    touches: /^tests\//m,
    keeps: /^src\//m,
  },
];

/** A hung install or test would block the synchronous call, and with it the whole test process. */
export const COMMAND_TIMEOUT_MS = 10 * 60_000;

const cacheRoot = () => process.env.KODEL_AGENT_CACHE ?? join(tmpdir(), "kodel-agent-cache");

/**
 * The pinned clone, fetched once and kept between runs. It is built under another name and moved
 * into place when it is whole, so a fetch that fails never leaves a cache entry that looks done.
 */
function pinnedClone(fixture: DesignFixture): string {
  const dir = join(cacheRoot(), `${fixture.name}-${fixture.sha}`);
  if (existsSync(join(dir, ".git"))) return dir;
  const building = `${dir}.building-${process.pid}`;
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true });
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: building, stdio: "pipe" });
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", fixture.url, fixture.sha);
    git("checkout", "-q", "FETCH_HEAD");
    rmSync(dir, { recursive: true, force: true });
    renameSync(building, dir);
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * A fresh copy of the pinned repository with the project config, the shipped `kodel-design` skill and
 * its dependencies, and no pipeline: this is a project on its first run.
 */
export function makeDesignSandbox(fixture: DesignFixture): Sandbox {
  const source = pinnedClone(fixture);
  const dir = mkdtempSync(join(tmpdir(), "kodel-design-"));
  const stateDir = mkdtempSync(join(tmpdir(), "kodel-design-state-"));
  try {
    prepareSandbox(fixture, source, dir, stateDir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    stateDir,
    cleanup() {
      if (process.env.KODEL_AGENT_KEEP === "1") {
        console.log(`kept for inspection: ${dir} (state: ${stateDir})`);
        return;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function prepareSandbox(fixture: DesignFixture, source: string, dir: string, stateDir: string) {
  execFileSync("git", ["clone", "-q", "--local", source, dir], { stdio: "ignore" });
  execFileSync("git", ["checkout", "-q", fixture.sha], { cwd: dir, stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  const skill = SKILLS.find((s) => s.name === "kodel-design");
  if (!skill) throw new Error("the kodel-design skill is not shipped");
  mkdirSync(join(dir, ".claude", "skills", "kodel-design"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "kodel-design", "SKILL.md"), skill.text);
  // Keep the harness's own files out of the project's diff, so `diff` checks see only the work.
  writeFileSync(
    join(dir, ".git", "info", "exclude"),
    ".kodel/\n.claude/\nnode_modules/\n.venv/\n",
    { flag: "a" },
  );
  for (const [cmd, ...args] of fixture.prepare) {
    execFileSync(cmd as string, args, {
      cwd: dir,
      stdio: "pipe",
      env: agentEnv(stateDir),
      timeout: COMMAND_TIMEOUT_MS,
    });
  }
}

/** Every shell command the pipeline runs on its own: command steps and command checks. */
export function pipelineCommands(spec: PipelineSpec): string[] {
  const out: string[] = [];
  for (const node of spec.nodes) {
    if (node.kind === "command") out.push(String(node.params.command));
    for (const check of node.checks) {
      if (check.kind === "command") out.push(String(check.params.command));
    }
  }
  return out;
}

/**
 * The program a shell command starts with, or undefined when that cannot be told without a shell
 * (a variable, a substitution). Leading `NAME=value` assignments are skipped.
 */
export function programOf(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const first = words[0];
  if (first === undefined || first === "" || /[$`(){}<>|&;'"\\]/.test(first)) return undefined;
  return first;
}

/**
 * The shell commands of an agent's turn that are a person's to run: accepting a proposal or a change,
 * deciding a gate. The server refuses them without a terminal, but the skill must not even try.
 */
export function peopleOnlyCommands(calls: { name: string; input: Record<string, unknown> }[]) {
  const forbidden =
    /\b(pipeline\s+(proposals|changes)\s+(apply|discard|restore)|gate|ack|seal|resume)\b/;
  return calls
    .filter((c) => c.name === "Bash")
    .map((c) => String(c.input.command ?? ""))
    .filter((command) => /\bkodel\b|main\.ts/.test(command) && forbidden.test(command));
}

/** What the proposal's summary must say, checked without a model: the profile and every command. */
export function summaryGaps(summary: string, fixture: DesignFixture): string[] {
  const gaps: string[] = [];
  if (!/\b(lean|standard|strict)\b/i.test(summary))
    gaps.push("the profile (lean, standard or strict)");
  for (const c of fixture.commands) {
    if (!c.pattern.test(summary)) gaps.push(`the command ${c.label}`);
  }
  return gaps;
}

/**
 * Steps of a run that do not follow an edge of the pipeline: the first must be the entry, and each
 * next one must be reachable from the one before it.
 */
export function trailBreaks(spec: PipelineSpec, trail: string[]): string[] {
  const breaks: string[] = [];
  if (trail[0] !== spec.entry) breaks.push(`starts at ${trail[0] ?? "nothing"}, not ${spec.entry}`);
  for (let i = 1; i < trail.length; i++) {
    const from = trail[i - 1] as string;
    const to = trail[i] as string;
    if (!spec.edges.some((e) => e.from === from && e.to === to)) breaks.push(`${from} > ${to}`);
  }
  return breaks;
}

/** One line of a run's journal. */
export interface JournalRecord {
  event: string;
  node?: string;
  kind?: string;
  passed?: boolean;
}

export function readJournal(sandbox: Sandbox, runId: string): JournalRecord[] {
  const text = readFileSync(join(sandbox.dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRecord);
}

/**
 * The steps that carry a command check or are a command step but whose command never ran and
 * passed: a check is only counted when the journal has its `check_finished`, a command step when
 * the run visited it.
 */
export function commandsNotRun(
  spec: PipelineSpec,
  trail: string[],
  journal: JournalRecord[],
): string[] {
  const out: string[] = [];
  for (const node of spec.nodes) {
    if (node.kind === "command" && !trail.includes(node.slug)) out.push(`${node.slug} (step)`);
    if (
      node.checks.some((c) => c.kind === "command") &&
      !journal.some(
        (r) =>
          r.event === "check_finished" && r.node === node.slug && r.kind === "command" && r.passed,
      )
    ) {
      out.push(`${node.slug} (check)`);
    }
  }
  return out;
}

/** The checklist commands that no command of the pipeline matches. */
export function missingCommands(spec: PipelineSpec, fixture: DesignFixture): string[] {
  const commands = pipelineCommands(spec);
  return fixture.commands
    .filter((c) => !commands.some((command) => c.pattern.test(command)))
    .map((c) => c.label);
}

export interface Verdict {
  item: string;
  met: boolean;
  evidence: string;
}

/** The judge's answer: a JSON array, one entry per checklist item. Anything else fails closed. */
export function parseVerdicts(text: string, checklist: string[]): Verdict[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start)
    throw new Error(`the judge did not answer with a JSON array: ${text}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length !== checklist.length) {
    throw new Error(`the judge must answer once per checklist item (${checklist.length}): ${text}`);
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<Verdict> | null;
    if (!e || typeof e.met !== "boolean") {
      throw new Error(`entry ${i} of the judge's answer has no boolean "met": ${text}`);
    }
    const evidence = String(e.evidence ?? "").trim();
    if (e.met && evidence === "") {
      throw new Error(`entry ${i} of the judge's answer says met with no evidence: ${text}`);
    }
    return { item: checklist[i] as string, met: e.met, evidence };
  });
}

export function judgePrompt(yaml: string, summary: string, checklist: string[]): string {
  return [
    "You review a Kodel pipeline that an agent wrote for a software project. You see only the",
    "pipeline and the summary the agent gave with it, nothing else, and you have no tools.",
    "For each checklist item, answer whether the pipeline meets it, from the text below only.",
    "",
    "Answer with a JSON array and nothing else, one object per item in the same order:",
    '[{"met": true|false, "evidence": "one sentence quoting the pipeline or the summary"}]',
    "",
    "Checklist:",
    ...checklist.map((item, i) => `${i + 1}. ${item}`),
    "",
    "Summary of the agent:",
    summary,
    "",
    "Pipeline:",
    yaml,
  ].join("\n");
}

/** A separate model call with fresh context and no tools; the agent's transcript is never shown. */
export function runJudge(yaml: string, summary: string, checklist: string[]): Verdict[] {
  const model = process.env.KODEL_AGENT_JUDGE_MODEL ?? MODEL;
  const cwd = mkdtempSync(join(tmpdir(), "kodel-judge-"));
  try {
    const done = spawnSync(
      "claude",
      [
        "-p",
        judgePrompt(yaml, summary, checklist),
        "--output-format",
        "json",
        "--model",
        model,
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
        "--strict-mcp-config",
        "--max-budget-usd",
        process.env.KODEL_AGENT_JUDGE_BUDGET_USD ?? "0.50",
      ],
      { cwd, encoding: "utf8", timeout: 180_000, env: agentEnv(cwd) as NodeJS.ProcessEnv },
    );
    if (done.error || done.status !== 0) {
      throw new Error(
        `the judge call failed (${done.error?.message ?? `exit ${done.status}`}): ${done.stderr}`,
      );
    }
    const answer = JSON.parse(done.stdout) as { result?: string };
    return parseVerdicts(String(answer.result ?? ""), checklist);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

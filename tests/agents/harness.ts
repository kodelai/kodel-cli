/**
 * Driving a real coding agent (Claude Code, headless) against a real kodel MCP server in a
 * throwaway repository. The scenarios assert on the run's state and journal on disk, and on which
 * tools the agent called, never on what it said.
 *
 * These tests spend money and are not deterministic, so they only run when KODEL_AGENT_TESTS=1.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { LocalPipelineHost } from "../../packages/local/src";
import { claudeConfigDir, findSessionLog, subagentLogs } from "../../packages/local/src/history";
import type { Fixture } from "./pipelines";

export const ENABLED = process.env.KODEL_AGENT_TESTS === "1";
export const MODEL = process.env.KODEL_AGENT_MODEL ?? "sonnet";
export const BUDGET_USD = process.env.KODEL_AGENT_BUDGET_USD ?? "1.50";
/** One agent turn can run many tool calls; this is the ceiling for one `claude -p` call. */
export const TURN_TIMEOUT_MS = 240_000;

export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const MAIN_TS = join(REPO_ROOT, "packages/cli/src/main.ts");

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** What the tool answered, as text. */
  output: string;
  isError: boolean;
  /** The id of this `tool_use` block, so the calls a subagent made can be grouped under its Agent call. */
  id?: string;
  /**
   * The Agent (or Task) call this one was made under, from the stream's `parent_tool_use_id`; absent for
   * the calls of the agent the test started.
   */
  parent?: string;
}

/** What the agent says it used in a turn, per model, as the `result` event of `claude -p` has it. */
export interface AgentUsage {
  /** Tokens over all models. */
  total: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Tokens and dollars per model (`modelUsage`): the only per-model figures the agent gives. */
  models: Record<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number }
  >;
}

/** The four counts of one response (or of a sum of responses), as the agent's own stream gives them. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The part of a sum of the stream's counts that is a measurement: input, cache read and cache write. The stream's
 * `output` is a streamed placeholder (see `responsesOf`), so it is left out of every comparison.
 */
export const comparableSum = (counts: TokenCounts): number =>
  counts.input + counts.cacheRead + counts.cacheWrite;

/**
 * One response of the agent as the `assistant` events of the stream show it: the last `usage` of its message id
 * (the stream writes one event per content block and the usage grows while it streams) and the tools it called.
 */
export interface AgentResponse {
  id: string;
  usage: TokenCounts;
  tools: string[];
}

export interface AgentTurn {
  sessionId: string;
  calls: ToolCall[];
  /** The responses of the turn in the order they began, from the stream (not from the transcript file). */
  responses: AgentResponse[];
  /** The tools of the kodel server, as the agent saw them at the start. */
  kodelTools: string[];
  costUsd: number;
  /** The agent's own count of its use in this turn; absent when the result event has none. */
  agentUsage?: AgentUsage;
  finalText: string;
  isError: boolean;
  /** The raw stream, kept for the failure message. */
  transcript: string;
}

export interface Sandbox {
  dir: string;
  stateDir: string;
  cleanup(): void;
}

/** The driver text we ship in AGENTS.md, so the test uses what a real user's agent would read. */
export function shippedDriverSection(): string {
  const text = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const start = text.indexOf("## Running a pipeline on this repository");
  const end = text.indexOf("## Language");
  if (start < 0 || end < start) throw new Error("the driver section is missing from AGENTS.md");
  return text.slice(start, end);
}

export const MINI_PIPELINE = [
  "name: mini",
  "description: Create hello.txt, ask a person, then verify it.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: |",
  "      Task: {{task}}",
  "      Create the file hello.txt in the repository root containing exactly the word hello.",
  "      Change nothing else.",
  "    checks:",
  '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
  "  - slug: approve",
  "    kind: human",
  "    prompt: Is hello.txt right?",
  "  - slug: verify",
  "    kind: command",
  "    command: grep -qx hello hello.txt",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: verify }",
  "  - { from: approve, to: write, when: rejected }",
  "  - { from: verify, to: write, when: failed }",
  "",
].join("\n");

/** A git repository with a pipeline, the driver text, and (optionally) our real deny rules. */
export function makeSandbox(
  options: {
    withProjectSettings?: boolean;
    withDriverText?: boolean;
    /** The pipeline (and files) to run on; the `mini` pipeline when left out. */
    fixture?: Fixture;
    /**
     * Whether each run gets its own git worktree, as it does by default. Off unless asked: the
     * other scenarios are about the pipeline, and look for the agent's files in the repository.
     */
    worktree?: boolean;
    /** Text appended to the project config (`TASKS_ON`, say). */
    config?: string;
  } = {},
): Sandbox {
  const fixture = options.fixture ?? { pipeline: MINI_PIPELINE };
  const pipelineName = /^name:\s*(\S+)/m.exec(fixture.pipeline)?.[1] ?? "pipeline";
  const dir = mkdtempSync(join(tmpdir(), "kodel-agent-"));
  const stateDir = mkdtempSync(join(tmpdir(), "kodel-agent-state-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", `${pipelineName}.yaml`), fixture.pipeline);
  for (const [path, content] of Object.entries(fixture.files ?? {})) {
    writeFileSync(join(dir, path), content);
  }
  // By default the project says nothing about pipelines: the rules come from the server itself.
  const driver = options.withDriverText === true ? shippedDriverSection() : "";
  writeFileSync(join(dir, "CLAUDE.md"), `# Test repository\n\n${driver}`);
  writeFileSync(join(dir, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
  const config = `${options.worktree === true ? "" : "worktree:\n  mode: off\n"}${options.config ?? ""}`;
  // The config file is the marker of a project, so it is there even when it says nothing.
  writeFileSync(join(dir, ".kodel", "config.yaml"), config);
  if (options.withProjectSettings) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    cpSync(join(REPO_ROOT, ".claude/settings.json"), join(dir, ".claude/settings.json"));
  }
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  writeKodelShim(stateDir, dir);
  return {
    dir,
    stateDir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** A folder that is no project: no git, no marker, nothing in it. */
export function makeBareSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "kodel-agent-bare-"));
  const stateDir = mkdtempSync(join(tmpdir(), "kodel-agent-state-"));
  return {
    dir,
    stateDir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Where the `kodel` shim of a sandbox lives: first on the `PATH` of the agent under test. */
export const shimDir = (stateDir: string) => join(stateDir, "bin");

/** Where the `kodel` shim of a sandbox logs each call: one line per call, `<epoch seconds>\t<args>`. */
export function kodelCallLog(stateDir: string): string {
  return join(stateDir, "kodel-calls.log");
}

/**
 * The texts the server gives an agent name `kodel`, and a sandbox has no installed binary, so the
 * agent's shell gets one that runs this checkout on the sandbox. `KODEL_TEST_WAIT_TIMEOUT` makes
 * `kodel wait` give up sooner, so a scenario about the timeout does not take hours.
 */
function writeKodelShim(stateDir: string, root: string): void {
  mkdirSync(shimDir(stateDir), { recursive: true });
  const run = `bun "${MAIN_TS}" --root "${root}"`;
  const file = join(shimDir(stateDir), "kodel");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      // Every call is logged, whoever made it (the agent or one of its subagents), so a scenario can
      // tell what was run and when without relying on what the stream shows of subagents.
      `printf '%s\\t%s\\n' "$(date +%s)" "$*" >> "${kodelCallLog(stateDir)}"`,
      'if [ "$1" = "wait" ] && [ -n "$KODEL_TEST_WAIT_TIMEOUT" ]; then',
      "  shift",
      `  exec ${run} wait "$@" --timeout "$KODEL_TEST_WAIT_TIMEOUT"`,
      "fi",
      `exec ${run} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

/**
 * A clone of this repository as committed (its own pipeline, driver text and deny rules), with the
 * dependencies installed, so the repository's own pipeline can run on it. Kept for inspection when
 * KODEL_AGENT_KEEP=1.
 */
export function makeCloneSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "kodel-agent-clone-"));
  const stateDir = mkdtempSync(join(tmpdir(), "kodel-agent-state-"));
  execFileSync("git", ["clone", "-q", "--local", REPO_ROOT, dir], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: dir, stdio: "ignore" });
  // A fresh worktree has no node_modules, so the repository's own pipeline runs in the checkout.
  writeFileSync(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
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

/** The parts of Claude Code's `stream-json` output that the scenarios read. */
interface StreamBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  tools?: string[];
  message?: { id?: string; usage?: Record<string, unknown>; content?: StreamBlock[] | string };
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  result?: string;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * The agent's own count of its use, from the `result` event of a turn: `usage` for the total and `modelUsage` for
 * each model. `undefined` when the event has neither.
 */
export function agentUsageOf(
  event: Pick<StreamEvent, "usage" | "modelUsage">,
): AgentUsage | undefined {
  const { usage, modelUsage } = event;
  if (usage === undefined && modelUsage === undefined) return undefined;
  const models: AgentUsage["models"] = {};
  for (const [model, given] of Object.entries(modelUsage ?? {})) {
    models[model] = {
      input: num(given["inputTokens"]),
      output: num(given["outputTokens"]),
      cacheRead: num(given["cacheReadInputTokens"]),
      cacheWrite: num(given["cacheCreationInputTokens"]),
      usd: num(given["costUSD"]),
    };
  }
  return {
    total: {
      input: num(usage?.["input_tokens"]),
      output: num(usage?.["output_tokens"]),
      cacheRead: num(usage?.["cache_read_input_tokens"]),
      cacheWrite: num(usage?.["cache_creation_input_tokens"]),
    },
    models,
  };
}

/**
 * The responses of a turn, from the `assistant` events of its `stream-json` output: one per message id, in the order
 * they began, with the last `usage` seen for the id and the names of the tools it called. This is the agent's own
 * account, a different source from the transcript file that the usage pass reads. **Its `output` is not a
 * measurement:** the stream's per-message `output_tokens` is a streamed placeholder (a real run: 66 in the stream
 * against 513 in the transcript, which holds the final value), so only input, cache read and cache write are an
 * independent reference.
 */
export function responsesOf(stdout: string): AgentResponse[] {
  const byId = new Map<string, AgentResponse>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    const id = event.message?.id;
    if (event.type !== "assistant" || typeof id !== "string" || id === "") continue;
    let response = byId.get(id);
    if (response === undefined) {
      response = { id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [] };
      byId.set(id, response);
    }
    const usage = event.message?.usage;
    if (usage !== undefined) {
      response.usage = {
        input: num(usage["input_tokens"]),
        output: num(usage["output_tokens"]),
        cacheRead: num(usage["cache_read_input_tokens"]),
        cacheWrite: num(usage["cache_creation_input_tokens"]),
      };
    }
    const blocks = Array.isArray(event.message?.content) ? (event.message?.content ?? []) : [];
    for (const block of blocks) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        response.tools.push(block.name);
      }
    }
  }
  return [...byId.values()];
}

/**
 * The sum of the responses from the first that called a tool ending in `from` to the last that called one ending in
 * `to`, both included: the same window the usage pass credits to a run. It starts at the response that issued
 * `pipeline_start` (the pass reads from the log line of that call, and a response is one usage) and ends at the one
 * that issued the last `pipeline_complete_step` (the step-end pass counts that response as it stands, still open).
 * Everything before (the preamble, such as a tool search) and after (the final answer, a background watch) is the
 * agent's own use of the turn, but not the run's. The window starts at the FIRST response that called `from`; the
 * pass starts at the call that carries the run's id, so a first failed `pipeline_start` (a wrong pipeline name)
 * would make this window wider than the pass's. Fine for the one-run scenario here. The `output` of the sum is the
 * stream's placeholder (see `responsesOf`). `undefined` when the stream has no such window.
 */
export function windowUsage(
  responses: readonly AgentResponse[],
  from: string,
  to: string,
): TokenCounts | undefined {
  const calls = (response: AgentResponse, suffix: string) =>
    response.tools.some((name) => name.endsWith(suffix));
  const start = responses.findIndex((r) => calls(r, from));
  const end = responses.findLastIndex((r) => calls(r, to));
  if (start === -1 || end === -1 || end < start) return undefined;
  const total: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const response of responses.slice(start, end + 1)) {
    total.input += response.usage.input;
    total.output += response.usage.output;
    total.cacheRead += response.usage.cacheRead;
    total.cacheWrite += response.usage.cacheWrite;
  }
  return total;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  }
  return "";
}

/**
 * The environment of the agent under test. The KODEL_AGENT_* switches are removed: the engine runs
 * the repository's own `bun test` inside the sandbox, and a child that still saw
 * KODEL_AGENT_TESTS=1 would run these same scenarios again, each starting another agent.
 */
export function agentEnv(
  stateDir: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, KODEL_STATE_DIR: stateDir };
  for (const key of Object.keys(env)) {
    if (key.startsWith("KODEL_AGENT_")) delete env[key];
  }
  return env;
}

export interface TurnOptions {
  sandbox: Sandbox;
  prompt: string;
  /** How long the turn may run before it is killed; `TURN_TIMEOUT_MS` when left out. */
  timeoutMs?: number;
  /** Continue the conversation of an earlier turn. */
  resume?: string;
  /** Tools the agent may use without asking; anything else is refused (headless cannot ask). */
  allowedTools: string[];
  /** What this turn may spend, in USD; `BUDGET_USD` when left out. */
  budgetUsd?: string;
  /** The directory the agent is started in; the sandbox when left out. */
  cwd?: string;
  /**
   * Start the server without `--root`, as a project's own `.mcp.json` does: it finds the project
   * from the directory the agent is started in.
   */
  rootFromCwd?: boolean;
  /** More environment for the agent and the commands it runs (`KODEL_TEST_WAIT_TIMEOUT`, say). */
  env?: Record<string, string>;
}

/** One `claude -p` call: the agent works until it ends its turn. */
export async function runAgentTurn(options: TurnOptions): Promise<AgentTurn> {
  const { sandbox } = options;
  const mcpConfig = JSON.stringify({
    mcpServers: {
      kodel: {
        command: "bun",
        args: options.rootFromCwd ? [MAIN_TS, "mcp"] : [MAIN_TS, "--root", sandbox.dir, "mcp"],
        env: { KODEL_STATE_DIR: sandbox.stateDir },
      },
    },
  });
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    options.allowedTools.join(","),
    "--model",
    MODEL,
    "--max-budget-usd",
    options.budgetUsd ?? BUDGET_USD,
    ...(options.resume ? ["--resume", options.resume] : []),
  ];
  const env = { ...agentEnv(sandbox.stateDir), ...options.env };
  env.PATH = [shimDir(sandbox.stateDir), env.PATH].filter(Boolean).join(delimiter);
  const child: ChildProcess = spawn("claude", args, {
    cwd: options.cwd ?? sandbox.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? TURN_TIMEOUT_MS);
  await new Promise<void>((resolveExit) => child.on("close", () => resolveExit()));
  clearTimeout(timer);

  const calls: ToolCall[] = [];
  const pending = new Map<string, ToolCall>();
  let sessionId = "";
  let kodelTools: string[] = [];
  let costUsd = 0;
  let agentUsage: AgentUsage | undefined;
  let finalText = "";
  let isError = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      sessionId = String(event.session_id ?? sessionId);
      kodelTools = (event.tools ?? []).filter((t) => t.startsWith("mcp__kodel__"));
    }
    const blocks = Array.isArray(event.message?.content) ? (event.message?.content ?? []) : [];
    if (event.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use" && block.id && block.name) {
          const call: ToolCall = {
            name: block.name,
            input: block.input ?? {},
            output: "",
            isError: false,
            id: block.id,
            ...(typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id !== ""
              ? { parent: event.parent_tool_use_id }
              : {}),
          };
          calls.push(call);
          pending.set(block.id, call);
        }
      }
    }
    if (event.type === "user") {
      for (const block of blocks) {
        const call =
          block.type === "tool_result" ? pending.get(block.tool_use_id ?? "") : undefined;
        if (call) {
          call.output = textOf(block.content);
          call.isError = block.is_error === true;
        }
      }
    }
    if (event.type === "result") {
      sessionId = String(event.session_id ?? sessionId);
      costUsd = Number(event.total_cost_usd ?? 0);
      agentUsage = agentUsageOf(event);
      finalText = String(event.result ?? "");
      isError = event.is_error === true;
    }
  }
  const turn: AgentTurn = {
    sessionId,
    calls,
    responses: responsesOf(stdout),
    kodelTools,
    costUsd,
    ...(agentUsage === undefined ? {} : { agentUsage }),
    finalText,
    isError,
    transcript: `${stdout}\n--- stderr ---\n${stderr}`,
  };
  if (process.env.KODEL_AGENT_VERBOSE === "1") {
    console.log(
      `--- agent turn (${MODEL}, $${costUsd.toFixed(3)}, ${kodelTools.length} kodel tools) ---\n` +
        `${describeCalls(turn)}\n> ${finalText.slice(0, 400)}`,
    );
  }
  return turn;
}

/** Short, readable account of what the agent did, for assertion messages. */
export function describeCalls(turn: AgentTurn): string {
  return turn.calls
    .map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 160)}${c.isError ? "  [error]" : ""}`)
    .join("\n");
}

export const KODEL_TOOL = (name: string) => `mcp__kodel__${name}`;

/** The person's side: a host on the same repository and the same trusted-hash directory as the agent's server. */
export function humanHost(sandbox: Sandbox): LocalPipelineHost {
  return new LocalPipelineHost({
    root: sandbox.dir,
    integrityDir: sandbox.stateDir,
    heartbeatMs: 0,
  });
}

/** The names of the journal records of a run, in order. */
export function journalEvents(sandbox: Sandbox, runId: string): string[] {
  const text = readFileSync(join(sandbox.dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

/** The records of a run's journal, whole and in order (`journalEvents` gives only their names). */
export function journalRecords(sandbox: Sandbox, runId: string): Record<string, unknown>[] {
  const text = readFileSync(join(sandbox.dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The names of the files in the run's `served/` folder, sorted; none when the folder is not there. */
export function servedFiles(sandbox: Sandbox, runId: string): string[] {
  try {
    return readdirSync(join(sandbox.dir, ".kodel", "runs", runId, "served")).sort();
  } catch {
    return [];
  }
}

/** The agent's calls to one kodel tool, in order. */
export const callsTo = (turn: AgentTurn, tool: string): ToolCall[] =>
  turn.calls.filter((c) => c.name === KODEL_TOOL(tool));

// ── forks and subagents ───────────────────────────────────────────────────────

/**
 * What a scenario about forks lets the agent use: the kodel tools, the file tools, Bash (for the steps'
 * own commands and `kodel wait`; what only a person may run is checked from the shim's log) and the
 * subagent tool under both of the names Claude Code has given it.
 */
export const FORK_TOOLS = [
  "mcp__kodel",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "Agent",
  "Task",
];

/** Whether a call starts a subagent. */
export const isAgentCall = (call: ToolCall): boolean =>
  call.name === "Agent" || call.name === "Task";

/** The calls of the agent the test started, without those its subagents made. */
export const orchestratorCalls = (turn: AgentTurn): ToolCall[] =>
  turn.calls.filter((c) => c.parent === undefined);

/** One subagent the orchestrator started, with the calls the stream shows it made. */
export interface WorkerCalls {
  /** The orchestrator's Agent (or Task) call that started it. */
  agent: ToolCall;
  /** The type of subagent asked for, when the call names one. */
  subagentType?: string;
  calls: ToolCall[];
}

/** The subagents the orchestrator started, each with its own calls (as the stream attributes them). */
export function workerCalls(turn: AgentTurn): WorkerCalls[] {
  return orchestratorCalls(turn)
    .filter(isAgentCall)
    .map((agent) => {
      const type = agent.input.subagent_type;
      return {
        agent,
        ...(typeof type === "string" ? { subagentType: type } : {}),
        calls: turn.calls.filter((c) => agent.id !== undefined && c.parent === agent.id),
      };
    });
}

/** Subagents started by a subagent: the topology is meant to be flat. */
export const nestedAgentCalls = (turn: AgentTurn): ToolCall[] =>
  turn.calls.filter((c) => c.parent !== undefined && isAgentCall(c));

/**
 * What the agent wrote, from the text blocks of its own messages (never tool output, which carries the
 * same commands). `topLevel` (the default) keeps only the orchestrator's text, not its subagents'.
 */
export function assistantText(turn: AgentTurn, options: { topLevel?: boolean } = {}): string {
  const topLevel = options.topLevel !== false;
  const stdout = turn.transcript.split("\n--- stderr ---\n")[0] ?? "";
  const texts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type !== "assistant") continue;
    const parent = event.parent_tool_use_id;
    if (topLevel && typeof parent === "string" && parent !== "") continue;
    const blocks = Array.isArray(event.message?.content) ? (event.message?.content ?? []) : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("\n");
}

/** One call of the `kodel` shim, by anyone in the sandbox. */
export interface KodelCall {
  /** When it was made, in epoch milliseconds (the shim logs whole seconds). */
  at: number;
  args: string;
}

/** The lines of a shim call log, parsed. */
export function parseKodelCallLog(text: string): KodelCall[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { at: Number(line.slice(0, tab)) * 1000, args: line.slice(tab + 1) };
    });
}

/** Every call of the `kodel` shim in a sandbox, in order. */
export function kodelCalls(sandbox: Sandbox): KodelCall[] {
  try {
    return parseKodelCallLog(readFileSync(kodelCallLog(sandbox.stateDir), "utf8"));
  } catch {
    return [];
  }
}

export type JournalRecord = Record<string, unknown>;

const tsOf = (record: JournalRecord): number => (typeof record.ts === "number" ? record.ts : 0);

/** The records of one event, in order. */
export const recordsOf = (records: readonly JournalRecord[], event: string): JournalRecord[] =>
  records.filter((r) => r.event === event);

/** How many times a node was entered. */
export const entriesOf = (records: readonly JournalRecord[], node: string): number =>
  records.filter((r) => r.event === "node_entered" && r.node === node).length;

/** The time one holder held one step: from its take to the hand-in, the lapse, or another's take. */
export interface ClaimWindow {
  node: string;
  attempt: number;
  /** The mark of the hold (`by`), the same across renewals. */
  by: string;
  start: number;
  /** `Infinity` while the journal shows the hold live with no lapse known. */
  end: number;
  /** Whether the window ended with the step handed in (not lapsed or taken over). */
  completed: boolean;
}

/**
 * The claim windows of a run, from its journal. A renewal by the same holder extends its window (also
 * after a restart gave the step a new attempt); the window closes at the step's `agent_completed`, at the
 * lapse (`ttl_s` after the last take or renewal), or when another holder takes the step.
 */
export function claimWindows(records: readonly JournalRecord[]): ClaimWindow[] {
  const windows: ClaimWindow[] = [];
  const open = new Map<string, { window: ClaimWindow; lapse: number }>();
  const lapseUntil = (now: number) => {
    for (const [node, held] of open) {
      if (held.lapse <= now) {
        held.window.end = held.lapse;
        open.delete(node);
      }
    }
  };
  for (const record of records) {
    const ts = tsOf(record);
    lapseUntil(ts);
    const node = String(record.node ?? "");
    const attempt = typeof record.attempt === "number" ? record.attempt : 0;
    if (record.event === "step_claimed") {
      const by = String(record.by ?? "");
      const ttl = typeof record.ttl_s === "number" ? record.ttl_s * 1000 : Number.POSITIVE_INFINITY;
      const held = open.get(node);
      if (held !== undefined && held.window.by === by) {
        held.window.attempt = attempt;
        held.lapse = ts + ttl;
        continue;
      }
      if (held !== undefined) held.window.end = ts;
      const window: ClaimWindow = {
        node,
        attempt,
        by,
        start: ts,
        end: Number.POSITIVE_INFINITY,
        completed: false,
      };
      windows.push(window);
      open.set(node, { window, lapse: ts + ttl });
    } else if (record.event === "agent_completed") {
      const held = open.get(node);
      if (held !== undefined && held.window.attempt === attempt) {
        held.window.end = ts;
        held.window.completed = true;
        open.delete(node);
      }
    }
  }
  for (const held of open.values()) held.window.end = held.lapse;
  return windows;
}

/** Whether two windows share some time (touching ends do not count). */
export const overlapping = (a: ClaimWindow, b: ClaimWindow): boolean =>
  a.start < b.end && b.start < a.end;

/** The most windows open at one moment. */
export function maxConcurrentClaims(windows: readonly ClaimWindow[]): number {
  // An end sorts before a start at the same time: a hand-in and the next take may share a millisecond.
  const points = windows.flatMap((w) => [
    { at: w.start, delta: 1 },
    { at: w.end, delta: -1 },
  ]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let now = 0;
  let max = 0;
  for (const point of points) {
    now += point.delta;
    max = Math.max(max, now);
  }
  return max;
}

/** How many times each attempt of each step was handed in, keyed `node#attempt`. */
export function completionsPerAttempt(records: readonly JournalRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of recordsOf(records, "agent_completed")) {
    const key = `${String(record.node)}#${String(record.attempt)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** How a branch of a fork arrived at its join (or died). */
export interface BranchSettled {
  fork: string;
  branch: string;
  node: string;
  label: string;
  failed: boolean;
  dead: boolean;
}

/** Every `branch_settled` record, in order. */
export function branchSettled(records: readonly JournalRecord[]): BranchSettled[] {
  return recordsOf(records, "branch_settled").map((r) => ({
    fork: String(r.fork ?? ""),
    branch: String(r.branch ?? ""),
    node: String(r.node ?? ""),
    label: String(r.label ?? ""),
    failed: r.failed === true,
    dead: r.dead === true,
  }));
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The id of the only run of a sandbox. */
export async function onlyRunId(sandbox: Sandbox): Promise<string> {
  const runs = await humanHost(sandbox).runSummaries();
  const first = runs[0];
  if (runs.length !== 1 || first === undefined) {
    throw new Error(`expected one run, found ${runs.length}`);
  }
  return first.meta.runId;
}

/** Waits until a run has an active visit of every node named, in the phase given; its id. */
async function waitForVisits(
  sandbox: Sandbox,
  slugs: readonly string[],
  phase: "human" | "agent",
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await humanHost(sandbox).runSummaries();
    const at = runs.find((r) =>
      slugs.every((slug) => r.state?.active.some((v) => v.node === slug && v.phase === phase)),
    );
    if (at) return at.meta.runId;
    await pause(500);
  }
  throw new Error(`the run never had ${phase} steps open at ${slugs.join(", ")}`);
}

/** The id of the run once every gate named waits for a person at the same time. */
export const waitForGates = (sandbox: Sandbox, slugs: readonly string[], timeoutMs: number) =>
  waitForVisits(sandbox, slugs, "human", timeoutMs);

/** The id of the run once every agent step named is open at the same time. */
export const waitForOpenSteps = (sandbox: Sandbox, slugs: readonly string[], timeoutMs: number) =>
  waitForVisits(sandbox, slugs, "agent", timeoutMs);

/** The person decides one gate of several, as `kodel gate --node` does; true when it was taken. */
export async function decideGate(
  sandbox: Sandbox,
  runId: string,
  node: string,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<boolean> {
  const run = await humanHost(sandbox).open(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  const result = await run.decideHuman(node, decision, reason);
  await run.waitForRest(60_000);
  return result.ok;
}

/**
 * A worker that takes a step and never comes back: the test holds the claim, and only its lapse
 * (`agents.claim_ttl_s`) frees the step. Returns the token.
 */
export async function ghostTake(sandbox: Sandbox, runId: string, node: string): Promise<string> {
  const run = await humanHost(sandbox).open(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  const taken = await run.takeStep({ node });
  if (taken.status !== "claimed") throw new Error(`could not take ${node}: ${taken.status}`);
  return taken.claim_token;
}

/** The tool calls in a Claude Code transcript file (JSONL), with their answers. */
export function toolCallsOfTranscript(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const pending = new Map<string, ToolCall>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: StreamEvent;
    try {
      entry = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    const blocks = Array.isArray(entry.message?.content) ? (entry.message?.content ?? []) : [];
    for (const block of blocks) {
      if (entry.type === "assistant" && block.type === "tool_use" && block.id && block.name) {
        const call: ToolCall = {
          name: block.name,
          input: block.input ?? {},
          output: "",
          isError: false,
          id: block.id,
        };
        calls.push(call);
        pending.set(block.id, call);
      }
      if (entry.type === "user" && block.type === "tool_result") {
        const call = pending.get(block.tool_use_id ?? "");
        if (call) {
          call.output = textOf(block.content);
          call.isError = block.is_error === true;
        }
      }
    }
  }
  return calls;
}

/**
 * The fallback when the stream does not show what subagents did: their calls, from the transcript
 * files Claude Code keeps next to the session's own (`<session>/subagents/agent-*.jsonl`), one entry
 * per subagent. Empty when the session's log is not found.
 */
export async function subagentToolCalls(
  cwd: string,
  sessionId: string,
): Promise<{ log: string; calls: ToolCall[] }[]> {
  const store = join(claudeConfigDir(), "projects");
  const session = await findSessionLog(store, [cwd], sessionId);
  if (session === undefined) return [];
  const logs = await subagentLogs(session, sessionId);
  return logs.map((log) => ({ log, calls: toolCallsOfTranscript(readFileSync(log, "utf8")) }));
}

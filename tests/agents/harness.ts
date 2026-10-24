/**
 * Driving a real coding agent (Claude Code, headless) against a real kodel MCP server in a
 * throwaway repository. The scenarios assert on the run's state and journal on disk, and on which
 * tools the agent called, never on what it said.
 *
 * These tests spend money and are not deterministic, so they only run when KODEL_AGENT_TESTS=1.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalPipelineHost } from "../../packages/local/src";
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
}

export interface AgentTurn {
  sessionId: string;
  calls: ToolCall[];
  /** The tools of the kodel server, as the agent saw them at the start. */
  kodelTools: string[];
  costUsd: number;
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
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  tools?: string[];
  message?: { content?: StreamBlock[] | string };
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
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
  /** The directory the agent is started in; the sandbox when left out. */
  cwd?: string;
  /**
   * Start the server without `--root`, as a project's own `.mcp.json` does: it finds the project
   * from the directory the agent is started in.
   */
  rootFromCwd?: boolean;
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
    BUDGET_USD,
    ...(options.resume ? ["--resume", options.resume] : []),
  ];
  const child: ChildProcess = spawn("claude", args, {
    cwd: options.cwd ?? sandbox.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: agentEnv(sandbox.stateDir),
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
      finalText = String(event.result ?? "");
      isError = event.is_error === true;
    }
  }
  const turn: AgentTurn = {
    sessionId,
    calls,
    kodelTools,
    costUsd,
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

/** The agent's calls to one kodel tool, in order. */
export const callsTo = (turn: AgentTurn, tool: string): ToolCall[] =>
  turn.calls.filter((c) => c.name === KODEL_TOOL(tool));

/**
 * Claude-specific: how a worker is a `claude -p` process (TASK-9PNS). The argv and its flags
 * (`--session-id` for the first session, `--resume` for the one after a decision), the shape of the
 * `--mcp-config` that points it at its own `kodel mcp --no-decisions --no-wait-hint`, the two tool
 * lists Claude Code enforces, the auth probe, the two prompts and the environment markers. To put
 * another agent behind the TUI, replace this file and `claude-stream.ts`; `WorkerLauncher`, the TUI
 * and `kodel mcp`'s two flags do not know which agent runs.
 */
import { sep } from "node:path";
import { projectPlace, sessionEnv } from "@kodel-ai/local";
import { type RedactRule, redactText, validateSpec } from "@kodel-ai/pipeline-core";
import { AGENT_HUMAN_COMMANDS } from "./agent-commands";
import { sessionIdOf as tailSessionId } from "./claude-stream";
import { plain } from "./plain";
import type { WorkerDecision } from "./worker-launcher";

/** The tools the worker may use besides its kodel server. `Bash` whole: `dev.yaml` needs tests, git and gh. */
export const WORKER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"] as const;

/** The two decision tools: never served to the worker, and refused on the client's side as well. */
export const WORKER_DENIED = [
  "mcp__kodel__pipeline_decide_gate",
  "mcp__kodel__pipeline_accept_change",
] as const;

/** The human-only commands, as `Bash` patterns refuse them: a verb after any spelling of the binary. */
export const WORKER_DENIED_COMMANDS: readonly string[] = [
  "gate*",
  "ack*",
  "seal*",
  "resume*",
  "migrate*",
  // A run id is `r_…`: `* wait*` alone would refuse `cd …/.kodel/worktrees/r_x && bun test; wait`.
  "wait r_*",
  "pipeline changes apply*",
  "pipeline changes discard*",
  "pipeline changes restore*",
  "pipeline proposals apply*",
  "pipeline proposals discard*",
  ...AGENT_HUMAN_COMMANDS.map((command) => `${command}*`),
];

/** How the binary is spelled in a command: the package's `kodel`, the source, the built file. */
export const WORKER_BINARY_SPELLINGS = ["*kodel*", "*main.ts*", "*kodel.js*"] as const;

/** The project's data folder, as a pattern relative to the worker's working directory spells it. */
const DATA_DIR = ".kodel";

/** A worktree-relative pattern: the glob is written with `/` on every platform. */
const pattern = (path: string, glob: string) => `${path.split(sep).join("/")}/${glob}`;

/**
 * Files the worker must not write by hand, relative to its working directory and to the project root.
 * The folders of the runs and of the proposals are not spelled here: the storage resolver owns their
 * names (with `storage: home` they live under the state base, which the deny list names whole).
 */
export const WORKER_DENIED_PATHS: readonly string[] = (() => {
  const place = projectPlace(DATA_DIR);
  return [
    pattern(place.runsRoot, "**"),
    `${DATA_DIR}/pipelines/**`,
    `${DATA_DIR}/tasks/**`,
    `${DATA_DIR}/config.yaml`,
    pattern(place.proposalsRoot, "**"),
    ".mcp.json",
    ".claude/settings*.json",
  ];
})();

/** The variables that make `claude` think it runs inside another Claude Code session: an unsaved session cannot be resumed. */
export const CLAUDE_MARKERS = ["CLAUDECODE", /^CLAUDE_CODE_/] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CHARS = 200;

/** Every `mcp__kodel__<tool>` the worker's server serves, then the plain tools. */
export function workerAllowlist(served: readonly string[]): string[] {
  const denied = new Set<string>(WORKER_DENIED);
  const kodel = served.map((name) => `mcp__kodel__${name}`).filter((name) => !denied.has(name));
  return [...kodel, ...WORKER_TOOLS];
}

/** Claude Code's absolute path form: `//` then the path. */
const absolute = (path: string) => `//${path.replace(/^\/+/, "")}`;

/** Whether `inner` is `outer` or inside it, by path text (both absolute). */
function under(inner: string, outer: string): boolean {
  const base = outer.replace(/\/+$/, "");
  return inner === base || inner.startsWith(`${base}/`);
}

/**
 * The deny list: the decision tools, the human-only commands in every spelling, and the files the
 * engine owns (worktree-relative and absolute to the root; the state base when it is not under the root).
 */
export function workerDenylist(root: string, stateBase: string): string[] {
  const out: string[] = [...WORKER_DENIED];
  for (const spelling of WORKER_BINARY_SPELLINGS) {
    for (const verb of WORKER_DENIED_COMMANDS) out.push(`Bash(${spelling} ${verb})`);
  }
  for (const path of WORKER_DENIED_PATHS) {
    for (const tool of ["Edit", "Write"]) {
      out.push(`${tool}(${path})`);
      out.push(`${tool}(${absolute(`${root}/${path}`)})`);
    }
  }
  if (!under(stateBase, root)) {
    for (const tool of ["Edit", "Write"]) out.push(`${tool}(${absolute(`${stateBase}/**`)})`);
  }
  return out;
}

export interface McpConfigInput {
  /** This process: `process.execPath` and `process.argv[1]`, so the worker's server is this very build. */
  exec: string;
  args: readonly string[];
  root: string;
  /** `KODEL_STATE_DIR` of the TUI's environment, when set: the worker's server keeps the history where the TUI reads it. */
  stateDir?: string;
}

/** The `--mcp-config` JSON: one server, this binary, `--no-decisions --no-wait-hint`. No task text. */
export function workerMcpConfig(input: McpConfigInput): string {
  return JSON.stringify({
    mcpServers: {
      kodel: {
        command: input.exec,
        args: [...input.args, "--root", input.root, "mcp", "--no-decisions", "--no-wait-hint"],
        ...(input.stateDir === undefined ? {} : { env: { KODEL_STATE_DIR: input.stateDir } }),
      },
    },
  });
}

export interface ArgvInput {
  prompt: string;
  mcpConfig: string;
  allowed: readonly string[];
  denied: readonly string[];
  /** The first session: the uuid the launcher chose for it. */
  sessionId?: string;
  /** A resumed session: the uuid of the conversation to continue. */
  resume?: string;
}

/** The argv of one session. No `--model` (the account's default) and no budget cap (settled). */
export function workerArgv(input: ArgvInput): string[] {
  return [
    "claude",
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    ...(input.resume !== undefined
      ? ["--resume", input.resume]
      : input.sessionId !== undefined
        ? ["--session-id", input.sessionId]
        : []),
    "--mcp-config",
    input.mcpConfig,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    input.allowed.join(","),
    "--disallowedTools",
    input.denied.join(","),
  ];
}

/** The first prompt: the run, the title and where to work. The run holds the task text, so the body is never argv. */
export function workerPrompt(runId: string, title: string, workdir: string): string {
  const name = plain(redactText(title)).replace(/\s+/g, " ").trim();
  return (
    `Kodel run ${runId} exists for the task "${name}" and is yours to drive. ` +
    `Call pipeline_next_step with run_id ${runId} and do what each answer says; ` +
    `never call pipeline_start (it would make a second run). Work in ${workdir}.`
  );
}

const KIND_WORDS: Record<WorkerDecision["kind"], string> = {
  gate: "gate",
  pause: "pause",
  pipeline_change: "pipeline change",
};

/** The reason of a decision as the question and the prompt show it: redacted, plain, cut. */
export function decisionReason(
  decision: WorkerDecision,
  rules: readonly RedactRule[] = [],
): string {
  if (decision.reason === undefined) return "";
  const text = plain(redactText(decision.reason, [...rules]))
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > REASON_CHARS ? `${chars.slice(0, REASON_CHARS).join("")}…` : text;
}

/** The prompt of the resumed session: what the person decided, and the run to go on with. */
export function resumePrompt(
  runId: string,
  decision: WorkerDecision,
  rules: readonly RedactRule[] = [],
): string {
  const reason = decisionReason(decision, rules);
  const node = plain(decision.node).replace(/\s+/g, " ").trim();
  return (
    `The person decided: ${KIND_WORDS[decision.kind]} "${node}" ${decision.outcome}` +
    `${reason === "" ? "" : ` — ${reason}`}. ` +
    `Continue Kodel run ${runId}: call pipeline_next_step with run_id ${runId} and go on from its answer; ` +
    "never call pipeline_start."
  );
}

const isMarker = (key: string) =>
  CLAUDE_MARKERS.some((marker) => (typeof marker === "string" ? key === marker : marker.test(key)));

/**
 * The worker's environment: the TUI's own, as a session child gets it (no `KODEL_*`, no window
 * variables), minus `KODEL_ENGINE` (the adapter forces it), minus the markers of a Claude Code
 * session (`claude` 2.1.319 stops saving a session started "from inside another Claude Code session",
 * and an unsaved session cannot be resumed), minus any key that is not an identifier. The result passes
 * `validateSpec`, and `KODEL_STATE_DIR` reaches only the worker's server, through the `--mcp-config`.
 */
export function workerEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sessionEnv(undefined, true, base))) {
    if (key === "KODEL_ENGINE" || key.startsWith("KODEL_")) continue;
    if (isMarker(key) || !ENV_NAME.test(key)) continue;
    out[key] = value;
  }
  // A spec with this environment is what the adapter is asked to start; it must never be refused for it.
  const problem = validateSpec({ argv: ["claude"], cwd: "/", env: out });
  if (problem !== undefined) throw new Error(`the worker's environment is not valid: ${problem}`);
  return out;
}

/** A record as `kodel agent ls --json` lists it: the name and the redacted argv joined. */
export interface WorkerRecord {
  name: string;
  command?: string;
  /** The decision the record resumed after; absent for the first session. */
  decisionSeq?: number;
}

/** The uuid after the last `<flag> <value>` of a command; a value that is not a uuid is no id. */
function lastFlag(command: string | undefined, flag: string): string | undefined {
  if (command === undefined) return undefined;
  const parts = command.split(/\s+/);
  const at = parts.lastIndexOf(flag);
  if (at < 0) return undefined;
  const value = parts[at + 1];
  return value !== undefined && UUID.test(value) ? value : undefined;
}

/**
 * The session id of a run's worker. From the records' argv: the last `--session-id` of the first
 * record (the prompt, with the title, precedes the flags, so a title holding `--session-id <other>`
 * does not win), else the last `--resume` of the newest `-d` record that has one. The tail's own
 * `result` or `init` id wins when both exist and differ: it is what `claude` used, and a redaction rule
 * may have mangled the argv. Neither: none.
 */
export function sessionIdOf(records: readonly WorkerRecord[], tail?: string): string | undefined {
  const first = records.find((r) => r.decisionSeq === undefined);
  let fromArgv = lastFlag(first?.command, "--session-id");
  if (fromArgv === undefined) {
    const resumes = records
      .filter((r) => r.decisionSeq !== undefined)
      .sort((a, b) => (b.decisionSeq ?? 0) - (a.decisionSeq ?? 0));
    for (const record of resumes) {
      fromArgv = lastFlag(record.command, "--resume");
      if (fromArgv !== undefined) break;
    }
  }
  const fromTail = tail === undefined ? undefined : tailSessionId(tail);
  return fromTail ?? fromArgv;
}

/** Runs one command and gives back what it wrote; the launcher gives the real one, tests a fake. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export type AuthProbe = { known: true; loggedIn: boolean } | { known: false };

/**
 * `claude auth status --json`. Only a clear `loggedIn: false` is a refusal: a probe that fails, is late
 * or prints no JSON lets the start go on (the worker's own exit and `kodel agent logs` then say why).
 */
export async function authProbe(
  exec: Exec,
  clock: () => number,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS,
): Promise<AuthProbe> {
  const started = clock();
  let stdout: string;
  try {
    const result = await exec("claude", ["auth", "status", "--json"], { timeoutMs });
    stdout = result.stdout;
  } catch {
    return { known: false };
  }
  if (clock() - started >= timeoutMs) return { known: false };
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (line === undefined) return { known: false };
  try {
    const parsed: unknown = JSON.parse(line.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { known: false };
    }
    const loggedIn = (parsed as Record<string, unknown>).loggedIn;
    return typeof loggedIn === "boolean" ? { known: true, loggedIn } : { known: false };
  } catch {
    return { known: false };
  }
}

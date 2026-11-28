/**
 * Claude-specific: how a worker is a `claude -p` process (TASK-9PNS). The argv and its flags
 * (`--session-id` for the first session, `--resume` for the one after a decision), the shape of the
 * `--mcp-config` that points it at its own `kodel mcp --role worker --no-decisions --no-wait-hint` (or,
 * for a worker that stays alive at a wait, `--wait-command <the command it watches its run with>`), the two tool
 * lists Claude Code enforces, the auth probe, the two prompts and the environment markers. In a terminal
 * of its own (T-47) the same program runs without `-p`, its prompt last. All of it is reached through
 * `claudeProfile`, the `claude` entry of `agent-profiles.ts`; another agent is another entry there, and
 * `WorkerLauncher`, the TUI and `kodel mcp`'s flags do not know which agent runs.
 */
import { sep } from "node:path";
import {
  parseTerminalCommand,
  projectPlace,
  sessionEnv,
  WORKER_ENGINES,
  type WorkerMechanism,
} from "@kodel-ai/local";
import { type RedactRule, redactText, validateSpec } from "@kodel-ai/pipeline-core";
import { AGENT_HUMAN_COMMANDS } from "./agent-commands";
import type { AgentProfile, ProfileSessionArgv, ProfileWorkerArgv } from "./agent-profiles";
import { digest } from "./claude-stream";
import { plain } from "./plain";
import { WORKER_TERMINAL_TIMEOUT_MS, type WorkerDecision } from "./worker-launcher";

/** The tools the worker may use besides its kodel server. `Bash` whole: `dev.yaml` needs tests, git and gh. */
export const WORKER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"] as const;

/** The decision tools: never served to the worker, and refused on the client's side as well. */
export const WORKER_DENIED = [
  "mcp__kodel__pipeline_decide_gate",
  "mcp__kodel__pipeline_accept_change",
  "mcp__kodel__manager_cancel_run",
] as const;

/**
 * `kodel wait <run>`, as a `Bash` pattern. A run id is `r_…`: `* wait*` alone would refuse
 * `cd …/.kodel/worktrees/r_x && bun test; wait`.
 */
const WAIT_COMMAND_PATTERN = "wait r_*";

/** The human-only commands, as `Bash` patterns refuse them: a verb after any spelling of the binary. */
export const WORKER_DENIED_COMMANDS: readonly string[] = [
  "gate*",
  "ack*",
  "seal*",
  "resume*",
  "migrate*",
  "run cancel*",
  // Not a person's command: a `-p` worker's turn ends at a wait, so it has nothing to watch.
  WAIT_COMMAND_PATTERN,
  "pipeline changes apply*",
  "pipeline changes discard*",
  "pipeline changes restore*",
  "pipeline proposals apply*",
  "pipeline proposals discard*",
  "task approve*",
  "web pair*",
  "web revoke*",
  "web token add*",
  "web token revoke*",
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
 * `terminal`: a worker in a terminal of its own stays alive at a wait and watches its run with
 * `kodel wait`, so that one command is not refused to it. Its paths are denied with `Edit(<path>)` alone:
 * that rule covers every file-editing tool of Claude Code, which prints a warning on the worker's screen
 * for each `Write(<path>)` rule ("never matches"). The print list keeps both, as it was.
 */
export function workerDenylist(
  root: string,
  stateBase: string,
  options: { terminal?: boolean } = {},
): string[] {
  const out: string[] = [...WORKER_DENIED];
  const verbs = options.terminal
    ? WORKER_DENIED_COMMANDS.filter((verb) => verb !== WAIT_COMMAND_PATTERN)
    : WORKER_DENIED_COMMANDS;
  for (const spelling of WORKER_BINARY_SPELLINGS) {
    for (const verb of verbs) out.push(`Bash(${spelling} ${verb})`);
  }
  const tools = options.terminal ? ["Edit"] : ["Edit", "Write"];
  for (const path of WORKER_DENIED_PATHS) {
    for (const tool of tools) {
      out.push(`${tool}(${path})`);
      out.push(`${tool}(${absolute(`${root}/${path}`)})`);
    }
  }
  if (!under(stateBase, root)) {
    for (const tool of tools) out.push(`${tool}(${absolute(`${stateBase}/**`)})`);
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
  /**
   * The command the server's answers offer (`workerWaitCommand`), for a worker that stays alive at a wait.
   * Without it the server offers none: a `-p` worker's turn ends there.
   */
  waitCommand?: string;
}

/**
 * The `--mcp-config` JSON: one server, this binary, `--role worker --no-decisions` and either
 * `--no-wait-hint` or the worker's own wait command. No task text.
 */
export function workerMcpConfig(input: McpConfigInput): string {
  const wait =
    input.waitCommand === undefined ? ["--no-wait-hint"] : ["--wait-command", input.waitCommand];
  return JSON.stringify({
    mcpServers: {
      kodel: {
        command: input.exec,
        args: [
          ...input.args,
          "--root",
          input.root,
          "mcp",
          "--role",
          "worker",
          "--no-decisions",
          ...wait,
        ],
        ...(input.stateDir === undefined ? {} : { env: { KODEL_STATE_DIR: input.stateDir } }),
      },
    },
  });
}

/** One word of a command line for a POSIX shell: as it is when it needs no quoting, else in single quotes. */
export function shellQuote(part: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part)) return part;
  return `'${part.split("'").join("'\\''")}'`;
}

/** Where the run id goes in a wait command; a run id needs no quoting. */
const RUN_PLACE = "{run}";

/**
 * The command a worker in a terminal starts in the background to be woken by the person's decision:
 * this very build, the project by its root, and the state base the starter has (the worker's shell has no
 * `KODEL_*` of its own, so `KODEL_STATE_DIR` is spelled out). A template: `{run}` is the run id. It gives
 * up when the session does. Every part is quoted by `shellQuote`.
 */
export function workerWaitCommand(input: Omit<McpConfigInput, "waitCommand">): string {
  const state =
    input.stateDir === undefined ? [] : ["env", shellQuote(`KODEL_STATE_DIR=${input.stateDir}`)];
  return [
    ...state,
    ...[input.exec, ...input.args, "--root", input.root, "wait"].map(shellQuote),
    RUN_PLACE,
    "--timeout",
    String(WORKER_TERMINAL_TIMEOUT_MS / 1000),
  ].join(" ");
}

/** Whether a `Bash(<glob>)` pattern covers a command: `*` is any text, the rest is literal. */
function bashPatternMatches(pattern: string, command: string): boolean {
  const glob = /^Bash\((.*)\)$/s.exec(pattern)?.[1];
  if (glob === undefined) return false;
  const literal = glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join(".*")}$`, "s").test(command);
}

/**
 * Why a wait command cannot be given to a worker, or nothing. A path that holds `{run}` would be cut by
 * the run id; one whose spelling a deny pattern of the worker covers (a root named `…/kodel resume/…`)
 * would be refused to the worker, which would then never learn of a decision.
 */
export function waitCommandProblem(
  input: Omit<McpConfigInput, "waitCommand">,
  denied: readonly string[],
): string | undefined {
  const parts = [input.exec, ...input.args, input.root, input.stateDir ?? ""];
  if (parts.some((part) => part.includes(RUN_PLACE))) {
    return `a path of this start holds "${RUN_PLACE}": the command that watches a run cannot be spelled`;
  }
  const command = workerWaitCommand(input).split(RUN_PLACE).join("r_0000000000_0000");
  const pattern = denied.find((entry) => bashPatternMatches(entry, command));
  return pattern === undefined
    ? undefined
    : `the command that watches a run (${command}) is refused by the agent's own deny rule ${pattern}: a path of this start reads as a command that is the person's`;
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

const CLAUDE = "claude";
const TERMINAL_FLAGS: readonly string[] = WORKER_ENGINES[CLAUDE]?.terminalFlags ?? [];

/**
 * A prompt as an interactive `claude` takes it: with a newline at its end. A one-word prompt that names a
 * subcommand (`doctor`, `mcp`) is otherwise run as that subcommand, also after `--` (claude 2.1.330).
 */
const promptArgument = (prompt: string) => (prompt.endsWith("\n") ? prompt : `${prompt}\n`);

/** A `terminal.command` as it was written (the program, the person's flags); throws on one the profile does not take. */
function terminalCommand(command: readonly string[] | undefined): string[] {
  if (command === undefined) return [CLAUDE];
  const parsed = parseTerminalCommand(command, TERMINAL_FLAGS);
  if (!parsed.ok) throw new Error(`terminal.command: ${parsed.problem}`);
  return [...command];
}

const conversation = (input: { sessionId?: string; resume?: string }): string[] =>
  input.resume !== undefined
    ? ["--resume", input.resume]
    : input.sessionId !== undefined
      ? ["--session-id", input.sessionId]
      : [];

/**
 * The argv of a worker in a terminal of its own: interactive (no `-p`), the same server and lists as the
 * print worker, the person's flags, and the prompt last, after `--`.
 */
export function terminalWorkerArgv(input: Omit<ProfileWorkerArgv, "mechanism">): string[] {
  const [program = CLAUDE, ...flags] = terminalCommand(input.command);
  return [
    program,
    ...conversation(input),
    "--mcp-config",
    input.mcpConfig,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    input.allowed.join(","),
    "--disallowedTools",
    input.denied.join(","),
    ...flags,
    "--",
    promptArgument(input.prompt),
  ];
}

/** The argv of a session a person starts for themselves: the program, the conversation, the prompt. */
export function sessionArgv(input: ProfileSessionArgv): string[] {
  return [
    ...terminalCommand(input.command),
    ...conversation(input),
    ...(input.prompt === undefined ? [] : ["--", promptArgument(input.prompt)]),
  ];
}

/** kodel's own elements of a worker argv: how many values follow, the one value allowed, and whose it is. */
const FIXED: Readonly<
  Record<string, { values: 0 | 1; only?: string | RegExp; mechanism?: WorkerMechanism }>
> = {
  "-p": { values: 1, mechanism: "print" },
  "--output-format": { values: 1, only: "stream-json", mechanism: "print" },
  "--verbose": { values: 0, mechanism: "print" },
  "--session-id": { values: 1, only: UUID },
  "--resume": { values: 1, only: UUID },
  "--mcp-config": { values: 1 },
  "--strict-mcp-config": { values: 0 },
  "--permission-mode": { values: 1, only: "dontAsk" },
  "--allowedTools": { values: 1 },
  "--disallowedTools": { values: 1 },
};

/** What every worker argv holds, whatever else it has: without one of these the lists do not hold. */
const REQUIRED = ["--mcp-config", "--strict-mcp-config", "--permission-mode", "--disallowedTools"];

/**
 * Reads a built worker argv back, before the start: why it must not be started, or nothing. Every
 * element is the program, one of kodel's own fixed elements with its value, or (in a terminal) a flag
 * `terminal.command` may add with its value, and the prompt alone after `--`.
 */
export function workerArgvProblem(
  argv: readonly string[],
  expected: { mechanism: WorkerMechanism; program: string },
): string | undefined {
  const at = (i: number) => `element ${i} ("${argv[i] ?? ""}")`;
  if (argv[0] !== expected.program) return `${at(0)} is not the program ${expected.program}`;
  const seen = new Set<string>();
  let prompt = false;
  let i = 1;
  while (i < argv.length) {
    const element = argv[i] ?? "";
    if (element === "--") {
      if (expected.mechanism !== "terminal") return `${at(i)} belongs to a terminal worker`;
      const last = argv[i + 1];
      if (last === undefined || i + 2 !== argv.length) {
        return "exactly one element, the prompt, follows --";
      }
      if (!last.endsWith("\n")) return "the prompt does not end with a newline";
      prompt = true;
      break;
    }
    const fixed = Object.hasOwn(FIXED, element) ? FIXED[element] : undefined;
    if (fixed !== undefined) {
      if (fixed.mechanism !== undefined && fixed.mechanism !== expected.mechanism) {
        return `${at(i)} belongs to a ${fixed.mechanism} worker`;
      }
      if (seen.has(element)) return `${at(i)} is there twice`;
      seen.add(element);
      if (fixed.values === 1) {
        const value = argv[i + 1];
        if (value === undefined) return `${at(i)} has no value`;
        const fits =
          fixed.only === undefined ||
          (typeof fixed.only === "string" ? value === fixed.only : fixed.only.test(value));
        if (!fits) return `${at(i + 1)} is not a value kodel gives ${element}`;
        if (element === "-p") prompt = true;
      }
      i += 1 + fixed.values;
      continue;
    }
    if (expected.mechanism === "terminal") {
      // One pair at a time, by the grammar of the config: the rule that let it in reads it back.
      const eq = element.startsWith("--") ? element.indexOf("=") : -1;
      const pair = eq < 0 ? argv.slice(i, i + 2) : [element];
      if (parseTerminalCommand([expected.program, ...pair], TERMINAL_FLAGS).ok) {
        i += pair.length;
        continue;
      }
    }
    return `${at(i)} is not the program, an element of kodel's own, or an allowed flag with its value`;
  }
  if (!prompt) return "the prompt is missing";
  if (seen.has("--session-id") && seen.has("--resume")) {
    return "both --session-id and --resume are there";
  }
  const missing = REQUIRED.find((flag) => !seen.has(flag));
  return missing === undefined ? undefined : `${missing} is missing`;
}
/** A worker whose server did not start has Bash and Edit and no kodel tool: it must not go on without them. */
const NO_TOOLS =
  "If you have no pipeline_next_step tool (the kodel tools are missing), stop at once: change nothing and say so.";

/** The first prompt: the run, the title and where to work. The run holds the task text, so the body is never argv. */
export function workerPrompt(runId: string, title: string, workdir: string): string {
  const name = plain(redactText(title)).replace(/\s+/g, " ").trim();
  return (
    `Kodel run ${runId} exists for the task "${name}" and is yours to drive. ` +
    `Call pipeline_next_step with run_id ${runId} and do what each answer says; ` +
    `never call pipeline_start (it would make a second run). Work in ${workdir}. ${NO_TOOLS}`
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
    `never call pipeline_start. The kodel tools you have may have changed since this session began: use the ones you have now. ${NO_TOOLS}`
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
 * The session id of a run's worker whose records have no `agent` record (written before T-47), from their
 * argv: the last `--session-id` of the first record (the prompt, with the title, precedes the flags, so a
 * title holding `--session-id <other>` does not win), else the last `--resume` of the newest `-d` record
 * that has one. Nothing the agent printed is read for it. Neither: none.
 */
export function sessionIdOf(records: readonly WorkerRecord[]): string | undefined {
  const first = records.find((r) => r.decisionSeq === undefined);
  const chosen = lastFlag(first?.command, "--session-id");
  if (chosen !== undefined) return chosen;
  const resumes = records
    .filter((r) => r.decisionSeq !== undefined)
    .sort((a, b) => (b.decisionSeq ?? 0) - (a.decisionSeq ?? 0));
  for (const record of resumes) {
    const resumed = lastFlag(record.command, "--resume");
    if (resumed !== undefined) return resumed;
  }
  return undefined;
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

export type TrustAnswer = "trusted" | "will_ask" | "unknown";

/**
 * Whether an interactive `claude` started in `dir` would first ask to trust the folder. It reads claude's
 * own file (`.claude.json` in `CLAUDE_CONFIG_DIR`, else in the home folder), which is another product's:
 * a file that is missing, does not parse or has another shape is `unknown`, never a refusal. Trust is
 * inherited from a folder above (spike criterion 1), so every folder from `dir` up is looked at. Nothing
 * is written: accepting trust is the person's act.
 */
export async function trustProbe(
  dir: string,
  environment: Record<string, string | undefined>,
  readText: (path: string) => Promise<string | undefined>,
): Promise<TrustAnswer> {
  const base = environment.CLAUDE_CONFIG_DIR ?? environment.HOME;
  if (base === undefined || base === "") return "unknown";
  const text = await readText(`${base.replace(/\/+$/, "")}/.claude.json`).catch(() => undefined);
  if (text === undefined) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unknown";
  const projects = (parsed as Record<string, unknown>).projects;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
    return "unknown";
  }
  let at = dir.replace(/\/+$/, "") || "/";
  for (;;) {
    const entry = Object.hasOwn(projects, at)
      ? (projects as Record<string, unknown>)[at]
      : undefined;
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).hasTrustDialogAccepted === true
    ) {
      return "trusted";
    }
    if (at === "/" || !at.includes("/")) return "will_ask";
    at = at.slice(0, at.lastIndexOf("/")) || "/";
  }
}

/** The `claude` entry of the profile table (`agent-profiles.ts`), written against claude 2.1.330. */
export const claudeProfile: AgentProfile = {
  name: CLAUDE,
  program: CLAUDE,
  terminalFlags: TERMINAL_FLAGS,
  // An idle session, and one stopped at a dialog of its own, write nothing (spike criterion 7).
  idleWrites: false,
  // `--resume` continues a print conversation in a terminal and the reverse (spike criterion 9).
  resumeAcrossModes: true,
  wait: "background",
  workerArgv: ({ mechanism, ...input }) =>
    mechanism === "terminal" ? terminalWorkerArgv(input) : workerArgv(input),
  sessionArgv,
  workerArgvProblem,
  mcpConfig: workerMcpConfig,
  waitCommand: workerWaitCommand,
  waitCommandProblem,
  allowlist: workerAllowlist,
  denylist: workerDenylist,
  env: workerEnv,
  startPrompt: workerPrompt,
  resumePrompt,
  sessionIdOf,
  authProbe,
  trustProbe,
  digest,
};

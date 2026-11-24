/**
 * The agents kodel can start as a program of their own (T-47): a table of profiles by name. A profile is
 * everything that is one agent's: its argv in a terminal and as a print process, how its conversation is
 * named and resumed, how it is pointed at its kodel server, its tool lists, and what the spike showed of
 * it. The launcher and the commands reach an agent through `agentProfile(name)` only, so another agent is
 * another entry and no branch. One entry today: `claude` (`claude-worker.ts`).
 */
import type { WorkerMechanism, WorkerSettings } from "@kodel-ai/local";
import type { RedactRule } from "@kodel-ai/pipeline-core";
import type { DigestOptions } from "./claude-stream";
import {
  type AuthProbe,
  claudeProfile,
  type Exec,
  type McpConfigInput,
  type TrustAnswer,
  type WorkerRecord,
} from "./claude-worker";
import type { WorkerDecision } from "./worker-launcher";

/**
 * What an absent `worker:` key means: a worker in a terminal of its own, which a person can open and
 * which stays alive at a wait. Where no terminal can run the start is refused, with the line that keeps
 * print workers (`WORKER_PRINT_MIGRATION_LINE`); nothing falls back. It could become the default only
 * once the serve rule knew such a worker (it holds no `max_workers` place at a gate, is not called
 * stalled there, and is not a death when its session ends at a wait).
 */
export const DEFAULT_WORKER_MECHANISM: WorkerMechanism = "terminal";

/**
 * The line a project commits to keep its workers as print processes, where no terminal can run. The
 * refusal of a terminal start and `docs/changes.md` spell this same text.
 */
export const WORKER_PRINT_MIGRATION_LINE = "engines: { claude: { worker: print } }";

/** Why a terminal worker cannot be started here, with the one line that starts a print worker instead. */
export const terminalRefusal = (reason: string): string =>
  `${reason}; to start agents without a terminal, commit ${WORKER_PRINT_MIGRATION_LINE} in .kodel/config.yaml`;

export interface ProfileWorkerArgv {
  mechanism: WorkerMechanism;
  prompt: string;
  mcpConfig: string;
  allowed: readonly string[];
  denied: readonly string[];
  /** The first session: the id the launcher chose for the conversation. */
  sessionId?: string;
  /** A resumed session: the id of the conversation to continue. */
  resume?: string;
  /** `terminal.command` of the profile's config, for a terminal worker: the program and the flags the person added. */
  command?: readonly string[];
}

export interface ProfileSessionArgv {
  /** Absent for a resumed conversation, which takes none. */
  prompt?: string;
  sessionId?: string;
  resume?: string;
  command?: readonly string[];
}

export interface AgentProfile {
  readonly name: string;
  /** The program, when the config's `terminal.command` names no other. Never a step `command`. */
  readonly program: string;
  /** The flags `terminal.command` may add; everything else there is refused. */
  readonly terminalFlags: readonly string[];
  /**
   * Whether a session that is idle, or stopped at a prompt of its own, keeps writing to its terminal.
   * `false`: a worker is stalled when it printed nothing and called nothing; `true`: by calls alone.
   */
  readonly idleWrites: boolean;
  /** Whether a conversation made by one mechanism is continued by the other. */
  readonly resumeAcrossModes: boolean;
  /** How it waits for the person: it starts the wait command in the background and ends its turn. */
  readonly wait: "background";

  /** The argv of a worker of a run. Throws when `command` is not a `terminal.command` this profile takes. */
  workerArgv(input: ProfileWorkerArgv): string[];
  /** The argv of a person's own session: no kodel server of ours, no permission flag. */
  sessionArgv(input: ProfileSessionArgv): string[];
  /**
   * Reads a built worker argv back: why it must not be started, or nothing. Every element is the
   * program, one of kodel's own fixed elements, or an allowed flag with its value.
   */
  workerArgvProblem(
    argv: readonly string[],
    expected: { mechanism: WorkerMechanism; program: string },
  ): string | undefined;

  mcpConfig(input: McpConfigInput): string;
  waitCommand(input: Omit<McpConfigInput, "waitCommand">): string;
  waitCommandProblem(
    input: Omit<McpConfigInput, "waitCommand">,
    denied: readonly string[],
  ): string | undefined;
  allowlist(served: readonly string[]): string[];
  denylist(root: string, stateBase: string, options?: { terminal?: boolean }): string[];
  env(base: Record<string, string | undefined>): Record<string, string>;
  startPrompt(runId: string, title: string, workdir: string): string;
  resumePrompt(runId: string, decision: WorkerDecision, rules?: readonly RedactRule[]): string;
  /** The id of a conversation from the argv of older records (those with no `agent` record). */
  sessionIdOf(records: readonly WorkerRecord[]): string | undefined;
  authProbe(exec: Exec, clock: () => number, timeoutMs?: number): Promise<AuthProbe>;
  /**
   * Whether the agent, started in a terminal in `dir`, would first ask to trust the folder. It only reads
   * (the agent's own files, through `readText`) and answers `unknown` for anything it does not know.
   */
  trustProbe(
    dir: string,
    environment: Record<string, string | undefined>,
    readText: (path: string) => Promise<string | undefined>,
  ): Promise<TrustAnswer>;
  /** A few lines of what a print worker did, from the tail of its output. */
  digest(tail: string, options?: DigestOptions): string[];
}

export const AGENT_PROFILES: Readonly<Record<string, AgentProfile>> = { claude: claudeProfile };

/** The profile of an agent by name; nothing for a name that has no entry. */
export function agentProfile(name: string): AgentProfile | undefined {
  return Object.hasOwn(AGENT_PROFILES, name) ? AGENT_PROFILES[name] : undefined;
}

/** How the workers of this project are started: the profile's `worker:` key, else the default. */
export function workerMechanismOf(settings: WorkerSettings | undefined): WorkerMechanism {
  return settings?.worker ?? DEFAULT_WORKER_MECHANISM;
}

/**
 * The program of a worker: `terminal.command[0]` for a terminal worker that has one, else the profile's
 * own. A step `command` on the same profile name is the program of engine steps and is never read here.
 */
export function workerProgramOf(
  profile: AgentProfile,
  settings: WorkerSettings | undefined,
  mechanism: WorkerMechanism,
): string {
  const given = mechanism === "terminal" ? settings?.terminal?.command?.[0] : undefined;
  return given ?? profile.program;
}

/**
 * The launcher that starts real sessions (TASK-9PNS, T-45): a worker is the agent of a profile
 * (`agent-profiles.ts`), started the way the profile's `worker:` key says (in a terminal of its own, or
 * as a print process), held by a kodel session record named `kw-<run>` (`kw-<run>-d<seq>` after a
 * decision). Nothing switches between the two by itself: where the chosen one cannot run the start is
 * refused. The records are read
 * through this binary as a child (`kodel agent ls --json`, `kodel agent logs`), because the adapter's
 * `list()` is synchronous and asks the process table; starting and stopping go through the adapter.
 * Everything with a side effect is injected, so the tests run it with fakes.
 */
import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { UnattendedEngines, WorkerMechanism, WorkerSettings } from "@kodel-ai/local";
import type { SessionAdapter, SessionListEntry, SessionState } from "@kodel-ai/pipeline-core";
import { agentProblem, type RedactRule, redactText, SessionError } from "@kodel-ai/pipeline-core";
import { stateLabel } from "./agent-commands";
import {
  type AgentProfile,
  agentProfile,
  terminalRefusal,
  workerMechanismOf,
  workerProgramOf,
} from "./agent-profiles";
import { DIGEST_LINES, DIGEST_TAIL_BYTES } from "./claude-stream";
import type { Exec, WorkerRecord } from "./claude-worker";
import { plain } from "./plain";
import { type PtyProbe, probePty } from "./pty-loader";
import {
  type PreflightInput,
  type PreflightResult,
  type ResumeInput,
  type StartInput,
  WORKER_TERMINAL_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  type WorkerLauncher,
  type WorkerProgress,
  type WorkerStatus,
  workerNameOf,
  workerRunOf,
} from "./worker-launcher";

/** How long a read of the records (a child of this process) may take. */
export const WORKER_READ_TIMEOUT_MS = 10_000;

/** The real `Exec`: one child, its output as text, killed at the timeout. Never throws for an exit code. */
export const execChild: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0 });
        } else if (error.killed) {
          // The timeout: the child was killed before it answered.
          resolve({ stdout, stderr, code: null });
        } else if (typeof error.code === "number") {
          resolve({ stdout, stderr, code: error.code });
        } else {
          // Not an exit code (`ENOENT`, say): the program could not be run at all.
          reject(error);
        }
      },
    );
  });

/** The first `name` on `PATH` that can be run, or nothing. */
export async function findOnPath(
  name: string,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  const dirs = (environment.PATH ?? "").split(delimiter).filter((d) => d !== "");
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The first size of a worker's terminal when the starter has none of its own (the daemon). */
export const WORKER_TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

/** The name of the one profile a worker is started from in this version. */
export const WORKER_PROFILE = "claude";

export interface SessionLauncherDeps {
  adapter: SessionAdapter;
  /** This process, so the children and the worker's server are this very build. */
  self: { exec: string; args: readonly string[] };
  root: string;
  /** The state base the records live under (`resolveBase`), for the deny list. */
  stateBase: string;
  /** The TUI's own environment: the worker's is made from it, and the children get it. */
  environment: Record<string, string | undefined>;
  /** The project's redaction rules: given to the adapter for the record, and to the digest. */
  rules: RedactRule[];
  /** The names of the kodel tools the worker's server serves (without `mcp__kodel__`). */
  servedTools: readonly string[];
  /** Finds a program on PATH. */
  which: (name: string) => Promise<string | undefined>;
  exec: Exec;
  platform: string;
  clock: () => number;
  uuid: () => string;
  probeTimeoutMs?: number;
  readTimeoutMs?: number;
  /** The agent's profile; the `claude` entry of the table unless a test gives another. */
  profile?: AgentProfile;
  /**
   * The `engines` block as a start nobody watches may use it (only as committed). Read once for each
   * start and each resume, by a caller that holds the start lock. Without it no profile is configured.
   */
  engines?: () => Promise<UnattendedEngines>;
  /** Whether a terminal session can be started here; the check of the PTY module by default. */
  ptyProbe?: () => PtyProbe;
  /** The starter's own terminal size, for the first size of a worker's terminal. */
  terminalSize?: () => { cols: number; rows: number } | undefined;
  /** Reads a text file, or nothing when it cannot be read: the agent's own files, for the trust probe. */
  readText?: (path: string) => Promise<string | undefined>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STATES: readonly SessionState[] = ["starting", "running", "exited", "killed", "lost"];

/** The `agent` of an entry, if it is one the starter could have written; else nothing. */
function parseAgent(raw: unknown): SessionListEntry["agent"] {
  if (!isObject(raw)) return undefined;
  const { source, ...agent } = raw;
  if (agentProblem(agent) !== undefined) return undefined;
  if (source !== undefined && source !== "chosen" && source !== "observed") return undefined;
  return {
    engine: agent.engine as string,
    ...(typeof agent.session === "string" ? { session: agent.session } : {}),
    ...(source === undefined ? {} : { source }),
    ...(typeof agent.resumes === "string" ? { resumes: agent.resumes } : {}),
  };
}

/** One entry of `kodel agent ls --json`, if it has the shape; the output of a child is not trusted. */
export function parseEntry(raw: unknown): SessionListEntry | undefined {
  if (!isObject(raw) || typeof raw.id !== "string" || !isObject(raw.status)) return undefined;
  const state = raw.status.state;
  if (typeof state !== "string" || !(STATES as readonly string[]).includes(state)) return undefined;
  const status: SessionListEntry["status"] = { state: state as SessionState };
  if (typeof raw.status.exitCode === "number") status.exitCode = raw.status.exitCode;
  if (typeof raw.status.signal === "string") status.signal = raw.status.signal;
  if (typeof raw.status.reason === "string") {
    status.reason = raw.status.reason as SessionListEntry["status"]["reason"];
  }
  if (raw.status.childAlive === true) status.childAlive = true;
  if (typeof raw.status.since === "number") status.since = raw.status.since;
  if (typeof raw.status.lastOutputAt === "number") status.lastOutputAt = raw.status.lastOutputAt;
  if (raw.status.group === "unread" || raw.status.group === "stranger") {
    status.group = raw.status.group;
  }
  const entry: SessionListEntry = { id: raw.id, status };
  if (typeof raw.name === "string") entry.name = raw.name;
  if (typeof raw.command === "string") entry.command = raw.command;
  if (raw.mode === "pipes" || raw.mode === "pty") entry.mode = raw.mode;
  const agent = parseAgent(raw.agent);
  if (agent !== undefined) entry.agent = agent;
  if (
    raw.problem === "CANNOT_READ" ||
    raw.problem === "NEWER_FORMAT" ||
    raw.problem === "FOREIGN"
  ) {
    entry.problem = raw.problem;
  }
  return entry;
}

/** A local session id is `a_<start in base 36>_<random>`: the start is read out of it. */
export function startedOf(id: string): number {
  const time = Number.parseInt(id.slice(2, 11), 36);
  return Number.isFinite(time) ? time : 0;
}

const defaultProfile = (): AgentProfile => {
  const profile = agentProfile(WORKER_PROFILE);
  if (profile === undefined) throw new Error(`there is no agent profile ${WORKER_PROFILE}`);
  return profile;
};

interface NamedRecord {
  entry: SessionListEntry;
  name: { runId: string; decisionSeq?: number };
}

/**
 * The id of the conversation of a run's worker. It is the one the launcher chose and the starter wrote
 * into the `agent` record: the newest record that has one names it. The argv of such a record is never
 * read (in a terminal the prompt comes last and may hold anything). Only records from before the `agent`
 * record existed are read by their argv, which the launcher wrote. Nothing an agent printed is an id.
 */
function conversationOf(
  records: readonly NamedRecord[],
  profile: AgentProfile,
): string | undefined {
  const newestFirst = [...records].sort(
    (a, b) => (b.name.decisionSeq ?? -1) - (a.name.decisionSeq ?? -1),
  );
  for (const { entry } of newestFirst) {
    if (entry.agent?.engine === profile.name && entry.agent.session !== undefined) {
      return entry.agent.session;
    }
  }
  return profile.sessionIdOf(
    records
      .filter((r) => r.entry.agent === undefined)
      .map(
        (r): WorkerRecord => ({
          name: r.entry.name ?? "",
          ...(r.entry.command === undefined ? {} : { command: r.entry.command }),
          ...(r.name.decisionSeq === undefined ? {} : { decisionSeq: r.name.decisionSeq }),
        }),
      ),
  );
}

/** The records of one run grouped into what the screen knows of its worker. */
export function workerStatusOf(
  entries: readonly SessionListEntry[],
  profile: AgentProfile = defaultProfile(),
): WorkerStatus | undefined {
  const records = entries
    .map((entry) => ({
      entry,
      name: entry.name === undefined ? undefined : workerRunOf(entry.name),
    }))
    .filter((r): r is NamedRecord => r.name !== undefined);
  if (records.length === 0) return undefined;
  const resumed = records
    .map((r) => r.name.decisionSeq)
    .filter((seq): seq is number => seq !== undefined)
    .sort((a, b) => a - b);
  const latest = records.reduce((best, r) =>
    (r.name.decisionSeq ?? -1) > (best.name.decisionSeq ?? -1) ? r : best,
  );
  const sessionId = conversationOf(records, profile);
  const { entry } = latest;
  const unknown = entry.problem !== undefined;
  const terminal = !unknown && entry.mode === "pty";
  return {
    id: entry.id,
    name: entry.name ?? "",
    state: unknown ? "unknown" : entry.status.state,
    label: stateLabel(entry),
    ...(entry.status.exitCode === undefined ? {} : { exitCode: entry.status.exitCode }),
    started: startedOf(entry.id),
    ...(entry.status.since === undefined ? {} : { since: entry.status.since }),
    ...(sessionId === undefined ? {} : { sessionId }),
    resumed,
    resumes: resumed.length,
    ...(latest.name.decisionSeq === undefined ? {} : { decisionSeq: latest.name.decisionSeq }),
    ...(unknown || entry.status.lastOutputAt === undefined
      ? {}
      : { lastOutputAt: entry.status.lastOutputAt }),
    ...(!unknown && entry.status.reason === "stopped" ? { stopped: true as const } : {}),
    ...(!unknown && entry.status.childAlive === true ? { childAlive: true as const } : {}),
    ...(terminal ? { terminal: true as const } : {}),
    ...(unknown || entry.status.reason === undefined ? {} : { endedBy: entry.status.reason }),
    ...(terminal && profile.idleWrites ? { idleWrites: true as const } : {}),
    ...(!unknown && entry.status.group === "unread" ? { groupUnread: true as const } : {}),
  };
}

/** The TUI's environment as a child gets it: every string value, `KODEL_STATE_DIR` among them. */
function childEnv(environment: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) out[key] = value;
  return out;
}

const readTextFile = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

const isLive = (status: WorkerStatus): boolean =>
  status.state === "starting" || status.state === "running";

export function createSessionWorkerLauncher(deps: SessionLauncherDeps): WorkerLauncher {
  const readTimeoutMs = deps.readTimeoutMs ?? WORKER_READ_TIMEOUT_MS;
  const profile = deps.profile ?? defaultProfile();
  const ptyProbe = deps.ptyProbe ?? probePty;
  const stateDir = deps.environment.KODEL_STATE_DIR;
  const server = {
    exec: deps.self.exec,
    args: deps.self.args,
    root: deps.root,
    ...(stateDir === undefined || stateDir === "" ? {} : { stateDir }),
  };
  const allowed = profile.allowlist(deps.servedTools);
  /** What is one mechanism's: the server's arguments and the deny list (a terminal worker may watch its run). */
  const partsOf = (mechanism: WorkerMechanism) =>
    mechanism === "terminal"
      ? {
          mcpConfig: profile.mcpConfig({ ...server, waitCommand: profile.waitCommand(server) }),
          denied: profile.denylist(deps.root, deps.stateBase, { terminal: true }),
        }
      : {
          mcpConfig: profile.mcpConfig(server),
          denied: profile.denylist(deps.root, deps.stateBase),
        };
  /** The latest read of the records, so `progress`, `logs` and `stop` know the latest record of a run. */
  let known = new Map<string, WorkerStatus>();

  const kodel = (args: readonly string[]) =>
    deps.exec(deps.self.exec, [...deps.self.args, "--root", deps.root, ...args], {
      timeoutMs: readTimeoutMs,
      env: childEnv(deps.environment),
    });

  const listAll = async (): Promise<SessionListEntry[]> => {
    const result = await kodel(["agent", "ls", "--json"]);
    if (result.code !== 0) {
      throw new Error(
        `kodel agent ls failed (${result.code ?? "killed"}): ${result.stderr.trim()}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("kodel agent ls printed no JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("kodel agent ls printed no list");
    return parsed.map(parseEntry).filter((e): e is SessionListEntry => e !== undefined);
  };

  const statuses = async (runIds: readonly string[]): Promise<Map<string, WorkerStatus>> => {
    const wanted = new Set(runIds);
    const byRun = new Map<string, SessionListEntry[]>();
    for (const entry of await listAll()) {
      const run = entry.name === undefined ? undefined : workerRunOf(entry.name)?.runId;
      if (run === undefined || !wanted.has(run)) continue;
      byRun.set(run, [...(byRun.get(run) ?? []), entry]);
    }
    const out = new Map<string, WorkerStatus>();
    for (const [run, entries] of byRun) {
      const status = workerStatusOf(entries, profile);
      if (status) out.set(run, status);
    }
    known = out;
    return out;
  };

  const latestOf = async (runId: string): Promise<WorkerStatus> => {
    const found = known.get(runId) ?? (await statuses([runId])).get(runId);
    if (!found) throw new Error(`run ${runId} has no agent of the TUI`);
    return found;
  };

  /** The profile's settings as a start nobody watches may use them, or why it may not. */
  const settingsNow = async (): Promise<
    | { ok: true; settings: WorkerSettings | undefined; note?: string }
    | { ok: false; reason: string }
  > => {
    if (deps.engines === undefined) return { ok: true, settings: undefined };
    let found: UnattendedEngines;
    try {
      found = await deps.engines();
    } catch (error) {
      return {
        ok: false,
        reason: `the engines block cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!found.ok) return found;
    const settings = Object.hasOwn(found.engines, profile.name)
      ? found.engines[profile.name]
      : undefined;
    return { ok: true, settings, ...(found.note === undefined ? {} : { note: found.note }) };
  };

  /** Why a worker of this mechanism cannot be started here, or nothing. Nothing is tried in the other one. */
  const cannotRun = (mechanism: WorkerMechanism): string | undefined => {
    if (mechanism !== "terminal") return undefined;
    const probe = ptyProbe();
    if (!probe.ok) return terminalRefusal(probe.reason);
    return profile.waitCommandProblem(server, partsOf("terminal").denied);
  };

  const launch = async (input: {
    name: string;
    workdir: string;
    prompt: string;
    mechanism: WorkerMechanism;
    settings: WorkerSettings | undefined;
    conversation: { sessionId: string } | { resume: string; resumes: string };
  }) => {
    const { mechanism, settings, conversation } = input;
    const refused = cannotRun(mechanism);
    if (refused !== undefined) throw new Error(refused);
    const terminal = mechanism === "terminal";
    const command = terminal ? settings?.terminal?.command : undefined;
    const { mcpConfig, denied } = partsOf(mechanism);
    const id = "resume" in conversation ? conversation.resume : conversation.sessionId;
    const argv = profile.workerArgv({
      mechanism,
      prompt: input.prompt,
      mcpConfig,
      allowed,
      denied,
      ...("resume" in conversation ? { resume: id } : { sessionId: id }),
      ...(command === undefined ? {} : { command }),
    });
    // The argv is read back before anything is started: the person's flags are beside kodel's own.
    const problem = profile.workerArgvProblem(argv, {
      mechanism,
      program: workerProgramOf(profile, settings, mechanism),
    });
    if (problem !== undefined) throw new Error(`the agent's command was not started: ${problem}`);
    await deps.adapter.start({
      argv,
      cwd: input.workdir,
      name: input.name,
      origin: "cli",
      timeoutMs: terminal ? WORKER_TERMINAL_TIMEOUT_MS : WORKER_TIMEOUT_MS,
      inheritEnv: false,
      // The environment of the moment: a PATH or an auth changed since the start is the resume's.
      env: profile.env(deps.environment),
      ...(terminal
        ? { mode: "pty" as const, size: deps.terminalSize?.() ?? { ...WORKER_TERMINAL_SIZE } }
        : {}),
      // The id is the launcher's choice and the starter writes it down: nothing the agent prints is read for it.
      agent: {
        engine: profile.name,
        session: id,
        ...("resumes" in conversation ? { resumes: conversation.resumes } : {}),
      },
    });
    return { name: input.name };
  };

  const start = async (input: StartInput) => {
    const found = await settingsNow();
    if (!found.ok) throw new Error(found.reason);
    return launch({
      name: workerNameOf(input.runId),
      workdir: input.workdir,
      prompt: profile.startPrompt(input.runId, input.title, input.workdir),
      mechanism: workerMechanismOf(found.settings),
      settings: found.settings,
      conversation: { sessionId: deps.uuid() },
    });
  };

  const resume = async (input: ResumeInput) => {
    const found = await settingsNow();
    if (!found.ok) throw new Error(found.reason);
    // The records are read again here, by a caller that holds the start lock: one live agent a run,
    // whatever mechanism started it, and the conversation the records name and no other.
    const latest = (await statuses([input.runId])).get(input.runId);
    if (latest === undefined) throw new Error("the record of the run's agent is gone");
    if (latest.state === "unknown") throw new Error("the record of the run's agent cannot be read");
    if (latest.childAlive === true) {
      throw new Error(
        `${latest.name}: its process still runs without a holder; stop it: kodel agent stop ${latest.id}`,
      );
    }
    if (isLive(latest)) {
      throw new SessionError("NAME_TAKEN", `the agent ${latest.name} of the run is alive`);
    }
    if (latest.sessionId === undefined || latest.sessionId !== input.sessionId) {
      throw new Error("the id of the agent's conversation is not known");
    }
    // A conversation is continued by the mechanism that wrote it, unless the profile says it crosses.
    const mechanism = profile.resumeAcrossModes
      ? workerMechanismOf(found.settings)
      : latest.terminal === true
        ? "terminal"
        : "print";
    return launch({
      name: workerNameOf(input.runId, input.decision.seq),
      workdir: input.workdir,
      prompt: profile.resumePrompt(input.runId, input.decision, deps.rules),
      mechanism,
      settings: found.settings,
      conversation: { resume: latest.sessionId, resumes: latest.id },
    });
  };

  const preflight = async (input: PreflightInput): Promise<PreflightResult> => {
    const refuse = (reason: string): PreflightResult => ({ ok: false, reason });
    if (deps.platform === "win32") return refuse("agents are not supported on Windows yet");
    if (input.dialog) {
      return refuse(
        "the project asks decisions in a dialog (decisions.dialog); a background agent cannot answer one. Turn it off, or wait for TASK-8EP9",
      );
    }
    const found = await settingsNow();
    if (!found.ok) return refuse(found.reason);
    const mechanism = workerMechanismOf(found.settings);
    const refused = cannotRun(mechanism);
    if (refused !== undefined) return refuse(refused);
    const program = workerProgramOf(profile, found.settings, mechanism);
    // A program given by its path is the person's committed choice; a bare name is looked up.
    if (!program.includes("/") && (await deps.which(program)) === undefined) {
      return refuse(`${program} was not found on PATH`);
    }
    const auth = await profile.authProbe(deps.exec, deps.clock, deps.probeTimeoutMs);
    if (auth.known && !auth.loggedIn) {
      return refuse("claude is not signed in (claude auth status): run claude auth login");
    }
    if (!input.taskLink && input.noTask !== true) {
      return refuse("tasks.on_run.mode is disabled, or the tracker cannot attach runs");
    }
    if (deps.rules.some((rule) => rule.replace !== undefined)) {
      return refuse("a project redaction rule cannot be given to a background agent");
    }
    if (input.pipelines === 0) return refuse("no pipeline loads");
    const notes = found.note === undefined ? [] : [found.note];
    // Only a session in a terminal asks whether the folder is trusted, and nobody is there to answer.
    if (mechanism === "terminal" && input.worktreesDir !== undefined) {
      const trust = await profile.trustProbe(
        input.worktreesDir,
        deps.environment,
        deps.readText ?? readTextFile,
      );
      const where = `${profile.name} in ${input.worktreesDir}`;
      if (trust === "will_ask") {
        const ask = `${where} will first ask whether the folder is trusted`;
        if (input.unattended === true) {
          return refuse(
            `${ask}, and nobody is there to answer: start ${profile.program} in the project root once and accept, or start the task yourself`,
          );
        }
        notes.push(`${ask}: open the agent and answer it`);
      } else if (trust === "unknown" && input.unattended === true) {
        notes.push(
          `whether ${where} asks to trust the folder is not known; if it does, the agent waits at that question`,
        );
      }
    }
    return notes.length === 0 ? { ok: true } : { ok: true, note: notes.join("; ") };
  };

  const progress = async (runId: string): Promise<WorkerProgress> => {
    const latest = await latestOf(runId);
    if (latest.terminal === true) {
      // A terminal has no event stream: its last lines, redacted and stripped again for the card.
      const tail = await deps.adapter.tail(latest.id, DIGEST_TAIL_BYTES, "both");
      const lines = tail.text
        .split("\n")
        .map((line) => plain(redactText(line, [...deps.rules])).trimEnd())
        .filter((line) => line.trim() !== "");
      return { lines: lines.slice(-DIGEST_LINES) };
    }
    const result = await kodel([
      "agent",
      "logs",
      latest.id,
      "--stdout",
      "--bytes",
      String(DIGEST_TAIL_BYTES),
    ]);
    if (result.code !== 0) {
      throw new Error(
        `kodel agent logs failed (${result.code ?? "killed"}): ${result.stderr.trim()}`,
      );
    }
    // The command's own closing line is not the agent's.
    const tail = result.stdout.replace(/\n?\[earlier output omitted\]\n?$/, "");
    const resumed =
      latest.decisionSeq === undefined
        ? undefined
        : {
            session: latest.resumes + 1,
            ...(latest.sessionId === undefined ? {} : { sessionId: latest.sessionId }),
          };
    return {
      lines: profile.digest(tail, {
        rules: deps.rules,
        ...(resumed === undefined ? {} : { resumed }),
      }),
    };
  };

  const stopRecord = async (id: string) => {
    try {
      await deps.adapter.stop(id);
    } catch (error) {
      const gone =
        error instanceof SessionError &&
        (error.code === "NOT_RUNNING" || error.code === "NOT_FOUND");
      if (!gone) throw error;
    }
  };

  return {
    preflight,
    start,
    resume,
    statuses,
    progress,
    async logs(runId, bytes) {
      const latest = await latestOf(runId);
      return (await deps.adapter.tail(latest.id, bytes, "both")).text;
    },
    async stop(runId) {
      await stopRecord((await latestOf(runId)).id);
    },
    async finish(runId) {
      // Read again: the caller holds the start lock, and only a record that is live now is stopped.
      const latest = (await statuses([runId])).get(runId);
      if (latest === undefined || !isLive(latest)) return;
      await stopRecord(latest.id);
    },
    async attachable(runId) {
      const latest = (await statuses([runId])).get(runId);
      if (latest === undefined) return { ok: false, reason: `run ${runId} has no agent of kodel` };
      if (latest.terminal !== true) {
        return {
          ok: false,
          reason: `${latest.name} runs without a terminal (worker: print): kodel agent logs ${latest.name}`,
        };
      }
      if (deps.adapter.attachable === undefined) {
        return { ok: false, reason: "this build cannot connect a terminal to an agent" };
      }
      const answer = await deps.adapter.attachable(latest.id);
      return answer.ok ? { ok: true, id: latest.id } : answer;
    },
  };
}

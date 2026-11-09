/**
 * The launcher that starts real sessions (TASK-9PNS): a worker is a `claude -p` process held by a
 * kodel session record named `kw-<run>` (`kw-<run>-d<seq>` after a decision). The records are read
 * through this binary as a child (`kodel agent ls --json`, `kodel agent logs`), because the adapter's
 * `list()` is synchronous and asks the process table; starting and stopping go through the adapter.
 * Everything with a side effect is injected, so the tests run it with fakes.
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { SessionAdapter, SessionListEntry, SessionState } from "@kodel-ai/pipeline-core";
import { type RedactRule, SessionError } from "@kodel-ai/pipeline-core";
import { stateLabel } from "./agent-commands";
import { DIGEST_TAIL_BYTES, digest } from "./claude-stream";
import {
  authProbe,
  type Exec,
  resumePrompt,
  sessionIdOf,
  type WorkerRecord,
  workerAllowlist,
  workerArgv,
  workerDenylist,
  workerEnv,
  workerMcpConfig,
  workerPrompt,
} from "./claude-worker";
import {
  type PreflightInput,
  type PreflightResult,
  type ResumeInput,
  type StartInput,
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
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const STATES: readonly SessionState[] = ["starting", "running", "exited", "killed", "lost"];

/** One entry of `kodel agent ls --json`, if it has the shape; the output of a child is not trusted. */
function parseEntry(raw: unknown): SessionListEntry | undefined {
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
  const entry: SessionListEntry = { id: raw.id, status };
  if (typeof raw.name === "string") entry.name = raw.name;
  if (typeof raw.command === "string") entry.command = raw.command;
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

/** The records of one run grouped into what the screen knows of its worker. */
export function workerStatusOf(entries: readonly SessionListEntry[]): WorkerStatus | undefined {
  const records = entries
    .map((entry) => ({
      entry,
      name: entry.name === undefined ? undefined : workerRunOf(entry.name),
    }))
    .filter(
      (r): r is { entry: SessionListEntry; name: { runId: string; decisionSeq?: number } } =>
        r.name !== undefined,
    );
  if (records.length === 0) return undefined;
  const resumed = records
    .map((r) => r.name.decisionSeq)
    .filter((seq): seq is number => seq !== undefined)
    .sort((a, b) => a - b);
  const latest = records.reduce((best, r) =>
    (r.name.decisionSeq ?? -1) > (best.name.decisionSeq ?? -1) ? r : best,
  );
  const sessionId = sessionIdOf(
    records.map(
      (r): WorkerRecord => ({
        name: r.entry.name ?? "",
        ...(r.entry.command === undefined ? {} : { command: r.entry.command }),
        ...(r.name.decisionSeq === undefined ? {} : { decisionSeq: r.name.decisionSeq }),
      }),
    ),
  );
  const { entry } = latest;
  const unknown = entry.problem !== undefined;
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
  };
}

/** The TUI's environment as a child gets it: every string value, `KODEL_STATE_DIR` among them. */
function childEnv(environment: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) out[key] = value;
  return out;
}

export function createSessionWorkerLauncher(deps: SessionLauncherDeps): WorkerLauncher {
  const readTimeoutMs = deps.readTimeoutMs ?? WORKER_READ_TIMEOUT_MS;
  const stateDir = deps.environment.KODEL_STATE_DIR;
  const mcpConfig = workerMcpConfig({
    exec: deps.self.exec,
    args: deps.self.args,
    root: deps.root,
    ...(stateDir === undefined || stateDir === "" ? {} : { stateDir }),
  });
  const allowed = workerAllowlist(deps.servedTools);
  const denied = workerDenylist(deps.root, deps.stateBase);
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
      const status = workerStatusOf(entries);
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

  const start = async (input: StartInput) => {
    const sessionId = deps.uuid();
    const name = workerNameOf(input.runId);
    await deps.adapter.start({
      argv: workerArgv({
        prompt: workerPrompt(input.runId, input.title, input.workdir),
        mcpConfig,
        allowed,
        denied,
        sessionId,
      }),
      cwd: input.workdir,
      name,
      origin: "cli",
      timeoutMs: WORKER_TIMEOUT_MS,
      inheritEnv: false,
      env: workerEnv(deps.environment),
    });
    return { name };
  };

  const resume = async (input: ResumeInput) => {
    const name = workerNameOf(input.runId, input.decision.seq);
    await deps.adapter.start({
      argv: workerArgv({
        prompt: resumePrompt(input.runId, input.decision, deps.rules),
        mcpConfig,
        allowed,
        denied,
        resume: input.sessionId,
      }),
      cwd: input.workdir,
      name,
      origin: "cli",
      timeoutMs: WORKER_TIMEOUT_MS,
      inheritEnv: false,
      // The environment of the moment: a PATH or an auth changed since the start is the resume's.
      env: workerEnv(deps.environment),
    });
    return { name };
  };

  const preflight = async (input: PreflightInput): Promise<PreflightResult> => {
    const refuse = (reason: string): PreflightResult => ({ ok: false, reason });
    if (deps.platform === "win32") return refuse("agents are not supported on Windows yet");
    if (input.dialog) {
      return refuse(
        "the project asks decisions in a dialog (decisions.dialog); a background agent cannot answer one. Turn it off, or wait for TASK-8EP9",
      );
    }
    if ((await deps.which("claude")) === undefined) return refuse("claude was not found on PATH");
    const auth = await authProbe(deps.exec, deps.clock, deps.probeTimeoutMs);
    if (auth.known && !auth.loggedIn) {
      return refuse("claude is not signed in (claude auth status): run claude auth login");
    }
    if (!input.taskLink) {
      return refuse("tasks.on_run.mode is disabled, or the tracker cannot attach runs");
    }
    if (deps.rules.some((rule) => rule.replace !== undefined)) {
      return refuse("a project redaction rule cannot be given to a background agent");
    }
    if (input.pipelines === 0) return refuse("no pipeline loads");
    return { ok: true };
  };

  const progress = async (runId: string): Promise<WorkerProgress> => {
    const latest = await latestOf(runId);
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
      lines: digest(tail, { rules: deps.rules, ...(resumed === undefined ? {} : { resumed }) }),
      ...(sessionIdOf([], tail) === undefined ? {} : { sessionId: sessionIdOf([], tail) }),
    };
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
      const latest = await latestOf(runId);
      try {
        await deps.adapter.stop(latest.id);
      } catch (error) {
        if (!(error instanceof SessionError && error.code === "NOT_RUNNING")) throw error;
      }
    },
  };
}

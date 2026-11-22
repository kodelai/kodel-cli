import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EnginesAgainstHead,
  forgetName,
  PipesSessionAdapter,
  readMarker,
  resolveBase,
  type StartOptions,
  sessionDirOf,
  type UnattendedEngines,
} from "@kodel-ai/local";
import {
  type Caller,
  foldSessionName,
  isSessionName,
  isTerminalState,
  type RedactRule,
  type RunState,
  type SessionAdapter,
  SessionError,
  type SessionListEntry,
  type SessionSpec,
  type StartResult,
  type TerminalSize,
} from "@kodel-ai/pipeline-core";
import type { Command } from "commander";
import {
  type AttachResult,
  type AttachTerminal,
  attachLine,
  processTerminal,
  runAttachClient,
  terminalSizeOf,
} from "./attach-client";
import type { Exec } from "./claude-worker";
import { plain } from "./plain";
import { type PtyProbe, probePty } from "./pty-loader";
import { formatTable } from "./table";
import type { WorkerLauncher } from "./worker-launcher";

/** Commands that refuse under `KODEL_ENGINE` (and need a terminal): the set a test walks. */
export const AGENT_HUMAN_COMMANDS = [
  "agent stop",
  "agent rm",
  "agent exec",
  "agent forget-name",
  "agent attach",
  "agent start",
  "agent prune",
] as const;
/** Commands an agent may run: they only read. */
export const AGENT_READ_COMMANDS = ["agent ls", "agent logs", "agent doctor"] as const;

/** The local adapter as the commands use it: a start may take the place of a finished session. */
export type AgentSessions = SessionAdapter & {
  start(spec: SessionSpec, options?: StartOptions): Promise<StartResult>;
};

/** What `agent start`, `prune` and `doctor` read of the project config. */
export interface AgentProjectConfig {
  /** `decisions.dialog`. */
  dialog: boolean;
  /** The keys of `decisions.agent` that are on. */
  agentDecides: string[];
  /** The folder the worktrees of the runs are made in. */
  worktreesDir: string;
}

/** The part of the pipeline host those commands use; `LocalPipelineHost` fits it. */
export interface AgentHost {
  list(): Promise<{ pipelines: { name: string }[] }>;
  start(input: {
    pipeline: string;
    task: string;
    restart: boolean;
    task_key?: string;
    caller: Caller;
  }): Promise<{
    status: "started" | "reused" | "terminal";
    run: { runId: string };
    workdir?: { path: string };
  }>;
  runSummaries(): Promise<
    { meta: { runId: string }; state: RunState | undefined; unreadable?: unknown }[]
  >;
  withWorkerStartLock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** The project as `agent start`, `prune` and `doctor` need it; the CLI builds it, a test may. */
export interface AgentProject {
  root: string;
  version: string;
  /** Throws, with the reason, when the config cannot be read. */
  config(): Promise<AgentProjectConfig>;
  /** The `engines` block of the working copy against the committed one. */
  engines(): Promise<EnginesAgainstHead>;
  /** The one launcher of workers; `engines` replaces the committed block with one a person accepted. */
  launcher(engines?: () => Promise<UnattendedEngines>): Promise<WorkerLauncher>;
  host(): Promise<AgentHost>;
}

export interface AgentContext {
  cwd: string;
  out(text: string): void;
  environment: Record<string, string | undefined>;
  /** The project root and a way to fail with a message and no stack trace. */
  root(): Promise<string>;
  fail(message: string): never;
  requireHuman(): void;
  mustConfirm(question: string): Promise<void>;
  /** How to start the holder processes; the CLI's own entry by default. */
  launcher?: { exec: string; args: string[] };
  /** Whether a terminal session can be started here; the check of the PTY module by default. */
  ptyProbe?: () => PtyProbe;
  /** The terminal `attach` connects; this process's own by default. */
  attachTerminal?: () => AttachTerminal;
  /** The size a terminal session starts with: that of the terminal this process writes to, by default. */
  terminalSize?: () => TerminalSize | undefined;
  /** `process.platform` unless a test says another. */
  platform?: string;
  /** The project behind `agent start`, `prune` and `doctor`. */
  project?: () => Promise<AgentProject>;
  /** The session adapter, in place of the local one (tests). */
  sessions?: () => Promise<AgentSessions>;
  /** Runs the attach client; the real one by default. */
  attach?: typeof runAttachClient;
  /** For the probes of `start` and `doctor`: a child process, a program on PATH, a file, an id, the time. */
  exec?: Exec;
  which?: (name: string) => Promise<string | undefined>;
  readText?: (path: string) => Promise<string | undefined>;
  uuid?: () => string;
  now?: () => number;
  /** Whether this process runs under Bun (`doctor` says so); the real answer by default. */
  bun?: boolean;
}

/** How a reason the adapter records reads to a person; a reason this build does not know is shown as it is, spaced. */
const REASON_WORDS: Record<string, string> = {
  timeout: "timeout",
  start_late: "started too late",
  rules_unknown: "a redaction rule cannot be used",
  holder_error: "could not start",
  holder_gone: "holder gone",
  no_status: "no answer",
};
const reasonWords = (reason: string): string => REASON_WORDS[reason] ?? reason.replace(/_/g, " ");

/**
 * What a person reads as the state, with the detail in brackets: how it ended, or why it is not known. A session
 * that `stop` ended is "stopped", not "killed". A process that is still alive after the session is over is said so
 * in whatever state it is, because the person (or a step) must not take that session for finished.
 */
export const stateLabel = (entry: SessionListEntry): string => {
  if (entry.problem === "FOREIGN") return "unknown (another machine)";
  if (entry.problem === "NEWER_FORMAT") return "unknown (newer kodel)";
  if (entry.problem) return "unknown (cannot be read)";
  const s = entry.status;
  const detail: string[] = [];
  let word: string = s.state;
  switch (s.state) {
    case "exited":
      if (s.exitCode !== undefined) detail.push(String(s.exitCode));
      break;
    case "killed":
      if (s.reason === "stopped") {
        word = "stopped";
      } else if (
        s.reason === "holder_error" ||
        s.reason === "rules_unknown" ||
        s.reason === "start_late"
      ) {
        word = "failed";
        detail.push(reasonWords(s.reason));
      } else if (s.reason !== undefined || s.signal !== undefined) {
        detail.push(reasonWords(s.reason ?? (s.signal as string)));
      }
      break;
    case "lost":
      if (s.reason !== undefined) detail.push(reasonWords(s.reason));
      break;
    default:
      break;
  }
  if (s.childAlive && s.state !== "running" && s.state !== "starting")
    detail.push("child still runs");
  return detail.length > 0 ? `${word} (${detail.join(", ")})` : word;
};

/** The `AGENT` column: the engine and the id of its conversation, as the `agent` record names them. */
export const agentLabel = (entry: SessionListEntry): string =>
  entry.agent === undefined
    ? "-"
    : entry.agent.session === undefined
      ? entry.agent.engine
      : `${entry.agent.engine} ${entry.agent.session}`;

/** Why a `stop` signalled nothing of a process group it could not call the session's, or nothing to say. */
export const groupNote = (group: SessionListEntry["status"]["group"]): string | undefined =>
  group === "unread"
    ? "the process table could not be read: a process this agent left behind a wrapper that died would not be seen, and none was signalled"
    : group === "stranger"
      ? "the number of its process group belongs to another process now: nothing of this agent is left, and nothing was signalled"
      : undefined;

/** The flags of `kodel agent start`. */
export interface StartFlags {
  pipeline?: string;
  name?: string;
  resume?: string;
  bg?: boolean;
}

const WORKER_NAME = /^kw-r_[0-9a-z]+_[0-9a-z]+(?:-d[1-9][0-9]*)?$/;
const ENGINE_STEP_NAME = /^ke-/;

/** The engines whose conversation `kodel agent start --resume` can continue. */
export const RESUMABLE_ENGINES: readonly string[] = ["claude"];

/**
 * Why `kodel agent start --resume` does not continue the conversation of this session, or nothing. One
 * rule for the command and for the hint of `agent ls`.
 */
export function resumeProblem(entry: SessionListEntry): string | undefined {
  const ref = entry.name ?? entry.id;
  if (entry.problem !== undefined) return `the records of agent ${ref} cannot be read`;
  if (entry.name !== undefined && WORKER_NAME.test(entry.name)) {
    return `${ref} is the agent of a run: the TUI (s) or kodel serve resumes it after your decision`;
  }
  if (entry.name !== undefined && ENGINE_STEP_NAME.test(entry.name)) {
    return `${ref} is the session of an engine step: the engine starts those`;
  }
  const { state, childAlive } = entry.status;
  if (state === "starting" || state === "running") {
    return `agent ${ref} still runs: kodel agent attach ${ref}`;
  }
  if (childAlive === true) {
    return `${ref}: its process still runs without a holder; stop it: kodel agent stop ${entry.id}`;
  }
  if (entry.mode !== "pty") {
    return `agent ${ref} ran without a terminal: it has no conversation to continue in one`;
  }
  if (entry.agent === undefined || entry.agent.session === undefined) {
    return `the id of the conversation of agent ${ref} is not known`;
  }
  if (!RESUMABLE_ENGINES.includes(entry.agent.engine)) {
    return `agent ${ref} is ${entry.agent.engine}: only ${RESUMABLE_ENGINES.join(", ")} can be resumed in this version`;
  }
  return undefined;
}

/**
 * The lines under the table of `agent ls`: for each finished agent whose conversation can be continued,
 * the command that does it. The newest record of a name only, and never one that was resumed already.
 */
export function resumeHints(rows: readonly SessionListEntry[]): string[] {
  const resumed = new Set(rows.map((row) => row.agent?.resumes).filter((id) => id !== undefined));
  const newest = new Map<string, SessionListEntry>();
  for (const row of rows) {
    const key = row.name ?? row.id;
    const best = newest.get(key);
    if (best === undefined || row.id > best.id) newest.set(key, row);
  }
  return [...newest.values()]
    .filter((row) => !resumed.has(row.id) && resumeProblem(row) === undefined)
    .map((row) => {
      const ref = row.name ?? row.id;
      return `${ref} can be continued: kodel agent start --resume ${ref}`;
    });
}

/** A command cut to a width for the table; the full text is in `--json`. */
const shorten = (text: string, width = 48): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : flat;
};

/**
 * The local session adapter as the CLI builds it: the holder is this program (`session-holder`), and the
 * base is the state base of the environment. One place, for `kodel agent` and for engine steps.
 */
export function pipesAdapter(options: {
  root: string;
  environment?: Record<string, string | undefined>;
  launcher: { exec: string; args: string[] };
  rules?: RedactRule[];
  bootTimeoutMs?: number;
  ptyProbe?: () => PtyProbe;
}): PipesSessionAdapter {
  const { launcher } = options;
  return new PipesSessionAdapter({
    base: resolveBase(options.environment),
    root: options.root,
    ...(options.environment === undefined ? {} : { baseEnv: options.environment }),
    holder: { exec: launcher.exec, args: [...launcher.args, "session-holder", "holder"] },
    intermediate: { exec: launcher.exec, args: [...launcher.args, "session-holder"] },
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: options.bootTimeoutMs }),
    // The starter's side of "can a terminal session run here"; the holder checks again when it loads the module.
    ptyProbe: options.ptyProbe ?? probePty,
  });
}

/**
 * The session a person means by an id or by a name. A name may have been used by several sessions over time:
 * the one that runs is meant, then the newest.
 */
export async function resolveSession(
  adapter: SessionAdapter,
  ref: string,
): Promise<{ id: string; name?: string }> {
  const all = await adapter.list();
  const rows = all.filter((row) => row.problem === undefined);
  const byId = rows.find((row) => row.id === ref);
  const wanted = isSessionName(ref) ? foldSessionName(ref) : undefined;
  const named = rows
    .filter((row) => wanted !== undefined && row.name === wanted)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const found = byId ?? named.find((row) => row.status.state === "running") ?? named[0];
  if (!found) {
    // A session that is there but cannot be judged is not "not found": the reason is the answer.
    const unread = all.find(
      (row) =>
        row.problem !== undefined &&
        (row.id === ref || (wanted !== undefined && row.name === wanted)),
    );
    if (unread?.problem === "NEWER_FORMAT") {
      throw new SessionError(
        "NEWER_FORMAT",
        `agent ${JSON.stringify(ref)} was written by a newer kodel; upgrade kodel`,
      );
    }
    if (unread?.problem !== undefined) {
      throw new SessionError(
        "CANNOT_READ",
        unread.problem === "FOREIGN"
          ? `agent ${JSON.stringify(ref)} belongs to another machine`
          : `the records of agent ${JSON.stringify(ref)} cannot be read`,
      );
    }
    throw new SessionError("NOT_FOUND", `no agent ${JSON.stringify(ref)}`);
  }
  return { id: found.id, ...(found.name !== undefined ? { name: found.name } : {}) };
}

/**
 * Connects a terminal to the session a person named and stays until they detach or it ends. The one way a
 * command attaches: `agent attach`, `agent exec --pty --attach` and `agent start` all come through here.
 */
export async function attachSession(
  ctx: Pick<AgentContext, "attach" | "attachTerminal">,
  sessions: SessionAdapter,
  ref: string,
): Promise<AttachResult> {
  const found = await resolveSession(sessions, ref);
  if (sessions.attach === undefined) {
    throw new SessionError("NOT_ATTACHABLE", "this build cannot connect a terminal to an agent");
  }
  const stream = await sessions.attach(found.id);
  return (ctx.attach ?? runAttachClient)({
    stream,
    terminal: (ctx.attachTerminal ?? processTerminal)(),
    name: found.name ?? found.id,
  });
}

export function registerAgentCommands(
  program: Command,
  withPlural: (c: Command) => Command,
  ctx: AgentContext,
): void {
  const launcher = ctx.launcher ?? { exec: process.execPath, args: [process.argv[1] ?? "kodel"] };
  const adapter = async (): Promise<PipesSessionAdapter> =>
    pipesAdapter({
      root: await ctx.root(),
      environment: ctx.environment,
      launcher,
      ...(ctx.ptyProbe ? { ptyProbe: ctx.ptyProbe } : {}),
    });

  const sessions = async (): Promise<AgentSessions> => (ctx.sessions ? ctx.sessions() : adapter());
  const project = async (): Promise<AgentProject> => {
    if (ctx.project === undefined) ctx.fail("this command needs a project");
    return ctx.project();
  };

  // Before anything else, also before the check for a person: the answer on Windows is the same for everyone.
  const platform = (): void => {
    if ((ctx.platform ?? process.platform) === "win32")
      ctx.fail("PLATFORM_UNSUPPORTED: agents are not supported on Windows yet");
  };

  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SessionError) ctx.fail(`${error.code}: ${plain(error.message)}`);
      throw error;
    }
  };

  /**
   * Connects to a session this command has just started. One that ended before the terminal could be
   * connected is no failure: the line a person would have read at its end is printed.
   */
  const attachStarted = async (all: SessionAdapter, started: StartResult): Promise<void> => {
    let result: AttachResult;
    try {
      result = await attachSession(ctx, all, started.id);
    } catch (error) {
      if (!(error instanceof SessionError) || error.code !== "NOT_ATTACHABLE") throw error;
      const status = await all.status(started.id).catch(() => undefined);
      if (status === undefined || !isTerminalState(status.state)) {
        ctx.fail(`${error.code}: ${plain(error.message)}`);
      }
      const end =
        status.state === "exited"
          ? {
              how: "ended" as const,
              ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
            }
          : { how: "killed" as const };
      ctx.out(`${attachLine(started.name ?? started.id, end)}\n`);
      return;
    }
    if (result.problem !== undefined) ctx.fail(result.problem);
  };

  const agent = withPlural(program.command("agent")).description(
    "Agents the project runs in the background (long-running processes)",
  );

  agent
    .command("ls")
    .description("List the agents of this project")
    .option("--json", "print the list as JSON")
    .option("--no-headers", "do not print the header row")
    .action(async (opts: { json?: boolean; headers?: boolean }) => {
      platform();
      const rows = await guard(async () => (await sessions()).list());
      if (opts.json) {
        ctx.out(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      if (rows.length === 0) {
        ctx.out("no agents\n");
        return;
      }
      const table = rows.map((r) => [
        plain(r.id),
        plain(r.name ?? "-"),
        plain(stateLabel(r)),
        plain(r.mode ?? "-"),
        plain(agentLabel(r)),
        plain(shorten(r.command ?? "")),
      ]);
      for (const line of formatTable(
        ["ID", "NAME", "STATE", "MODE", "AGENT", "COMMAND"],
        table,
        opts.headers !== false,
      )) {
        ctx.out(`${line}\n`);
      }
      for (const line of resumeHints(rows)) ctx.out(`${plain(line)}\n`);
    });

  agent
    .command("stop <id>")
    .description("Stop an agent and the processes it started")
    .action(async (id: string) => {
      platform();
      ctx.requireHuman();
      await ctx.mustConfirm(`Stop agent ${plain(id)}?`);
      const status = await guard(async () => (await sessions()).stop(id));
      const label =
        status.state === "killed" && status.reason === "stopped"
          ? "stopped"
          : `${status.state}${status.reason ? ` (${status.reason})` : ""}`;
      ctx.out(`${plain(id)}: ${label}\n`);
      const note = groupNote(status.group);
      if (note !== undefined) ctx.out(`${plain(id)}: ${note}\n`);
    });

  agent
    .command("logs <id>")
    .description("Print the end of what an agent wrote (secrets are redacted)")
    .option("--stdout", "only standard output")
    .option("--stderr", "only standard error")
    .option("--bytes <n>", "how many bytes at most (default 65536)", (v) => Number.parseInt(v, 10))
    .action(async (id: string, opts: { stdout?: boolean; stderr?: boolean; bytes?: number }) => {
      platform();
      if (opts.stdout && opts.stderr) ctx.fail("give --stdout or --stderr, not both");
      if (opts.bytes !== undefined && !(Number.isInteger(opts.bytes) && opts.bytes > 0)) {
        ctx.fail("--bytes is a positive whole number");
      }
      const stream = opts.stdout ? "stdout" : opts.stderr ? "stderr" : "both";
      const tail = await guard(async () => (await sessions()).tail(id, opts.bytes, stream));
      // line by line: what an agent printed must not move the cursor or fake a line in the person's terminal
      ctx.out(
        `${tail.text.replace(/\r/g, "").split("\n").map(plain).join("\n")}${tail.text.endsWith("\n") ? "" : "\n"}`,
      );
      if (!tail.complete) ctx.out("[earlier output omitted]\n");
    });

  agent
    .command("rm <id>")
    .description("Remove a finished agent")
    .action(async (id: string) => {
      platform();
      ctx.requireHuman();
      await ctx.mustConfirm(`Remove agent ${plain(id)}?`);
      await guard(async () => (await sessions()).remove(id));
      ctx.out(`${plain(id)}: removed\n`);
    });

  agent
    .command("exec <command...>", { hidden: true })
    .description("Run a command as an agent (for trying the sessions by hand)")
    .option("--name <name>", "a name to find it again by")
    .option("--pty", "run it in a terminal of its own (kodel agent attach connects to it)")
    .option(
      "--attach",
      "with --pty: connect this terminal to it at once (Ctrl+\\ detaches); -a before the command is the same",
    )
    .allowUnknownOption()
    .action(async (words: string[], opts: { name?: string; pty?: boolean; attach?: boolean }) => {
      platform();
      ctx.requireHuman();
      if (opts.name !== undefined && !isSessionName(opts.name)) ctx.fail("the name is not valid");
      // `-a` is `--attach` only before the command; after its first word it is the command's own (`ls -a`).
      const short = words[0] === "-a";
      // The parser leaves the `--` that followed a word it does not know.
      const command = short ? words.slice(words[1] === "--" ? 2 : 1) : words;
      if (short) opts.attach = true;
      if (opts.attach && !opts.pty) {
        ctx.fail("--attach needs --pty: only an agent in a terminal of its own can be attached to");
      }
      if (command.length === 0) ctx.fail("exec needs a command");
      const size = opts.pty
        ? (ctx.terminalSize ?? (() => terminalSizeOf(process.stdout)))()
        : undefined;
      const all = await sessions();
      const started = await guard(() =>
        all.start({
          argv: command,
          cwd: ctx.cwd,
          origin: "cli" as const,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.pty ? { mode: "pty" as const, ...(size ? { size } : {}) } : {}),
        }),
      );
      ctx.out(`started ${plain(started.id)}${started.name ? ` (${plain(started.name)})` : ""}\n`);
      if (opts.attach) {
        await attachStarted(all, started);
      } else if (opts.pty) {
        ctx.out(`attach with: kodel agent attach ${plain(started.name ?? started.id)}\n`);
      }
    });

  agent
    .command("attach <name>")
    .description(
      "Connect this terminal to an agent that runs in a terminal of its own, by name or id (Ctrl+\\ detaches)",
    )
    .action(async (ref: string) => {
      platform();
      ctx.requireHuman();
      const all = await sessions();
      const result = await guard(() => attachSession(ctx, all, ref));
      if (result.problem !== undefined) ctx.fail(result.problem);
    });

  agent
    .command("start [prompt...]")
    .description(
      "Start the coding agent in a terminal of its own and connect to it (Ctrl+\\ detaches); with --pipeline, as the agent of a new run",
    )
    .option("--pipeline <name>", "make a run of this pipeline with the prompt as its task")
    .option("--name <name>", "a name to find the agent again by")
    .option("--resume <agent>", "continue the conversation of a finished agent, under its name")
    .option("--bg", "do not connect this terminal to it")
    .action(async (words: string[], opts: StartFlags) => {
      platform();
      ctx.requireHuman();
      const { runAgentStart } = await import("./agent-start");
      await guard(async () =>
        runAgentStart(
          {
            ctx,
            sessions: await sessions(),
            project: await project(),
            attachStarted,
          },
          opts,
          words,
        ),
      );
    });

  agent
    .command("prune")
    .description("Remove the finished agents (never one that runs, nor the agent of an open run)")
    .option("--older-than <days>", "only those that ended at least this many days ago")
    .option("--dry-run", "say what would be removed and remove nothing")
    .action(async (opts: { olderThan?: string; dryRun?: boolean }) => {
      platform();
      ctx.requireHuman();
      const { runAgentPrune } = await import("./agent-prune");
      await guard(async () =>
        runAgentPrune({ ctx, sessions: await sessions(), project: await project() }, opts),
      );
    });

  agent
    .command("doctor")
    .description("Say whether a background agent can start here, and why not (it only reads)")
    .action(async () => {
      const { runAgentDoctor } = await import("./agent-doctor");
      const ok = await runAgentDoctor({ ctx, project: await project() });
      if (!ok) ctx.fail("a worker cannot start here (see above)");
    });

  agent
    .command("forget-name <name>", { hidden: true })
    .description("Free a name that a finished agent still holds (a retry may run again)")
    .action(async (name: string) => {
      platform();
      ctx.requireHuman();
      if (!isSessionName(name)) ctx.fail("the name is not valid");
      await ctx.mustConfirm(
        `Free the name ${plain(name)}? A step that is retried under it may run its command again.`,
      );
      const place = (await adapter()).place;
      const marker = readMarker(join(place.namesDir, `${foldSessionName(name)}.json`));
      if (marker === "newer") ctx.fail("the marker was written by a newer kodel; upgrade kodel");
      if (typeof marker !== "string" && existsSync(sessionDirOf(place, marker.id))) {
        ctx.fail(`the session ${plain(marker.id)} still exists; remove it first (kodel agent rm)`);
      }
      const freed = forgetName(place.namesDir, foldSessionName(name));
      ctx.out(freed ? `${plain(name)}: freed\n` : `${plain(name)}: was not used\n`);
    });
}

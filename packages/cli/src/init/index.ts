/**
 * `kodel init`: set a project up for the coding agents that will run its pipelines. It only adds
 * and updates; it never removes anything, and every file it touches is edited in place, so the
 * person's own lines stay. `--dry-run` lists what would change without writing.
 */
import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { generateProjectId, linesToAdd, loadConfig } from "@kodel-ai/local";
import { defaultHookRegistry, hookCommand } from "@kodel-ai/local/hooks";
import {
  AGENT_IDS,
  AGENTS,
  type AgentAdapter,
  detectAgents,
  onPath,
  type ServerCommand,
} from "./agents";
import { type Change, type Context, editFile, readIfExists } from "./files";
import { registerHooks } from "./hooks";
import { installSkills } from "./skills";

/** A problem to report to the person without a stack trace. */
export class InitError extends Error {}

export interface Choice {
  value: string;
  label: string;
  checked: boolean;
}

export interface InitIO {
  out(text: string): void;
  /** Whether a person is at a terminal. */
  interactive: boolean;
  /** Ask for any number of the choices; the answer is the values picked. */
  select(question: string, choices: Choice[]): Promise<string[]>;
  /** Ask a yes/no question; the default answer is no unless `defaultYes`. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  environment: Record<string, string | undefined>;
}

export interface InitOptions {
  root: string;
  /** Agent ids, or `all`. Without it the agents are asked for, or detected. */
  agents?: string[];
  /** Do not ask anything: take the flags and the detected agents. */
  yes: boolean;
  /** Turn the task tracker on. Without it the person is asked, or it stays off. */
  tasks?: boolean;
  /**
   * `home` keeps the history under `~/.kodel/projects/<id>` (the keys are written into a new
   * config only). Absent or `project`: under `.kodel`, and no key is written.
   */
  storage?: "project" | "home";
  /** The command the agent starts the server with. */
  serverCommand: string;
  /** Register the hooks. Without it the person is asked (default yes), or they are registered. */
  hooks?: boolean;
  force: boolean;
  dryRun: boolean;
}

const KODEL_DIR = ".kodel";

function configText(tasks: boolean, storageLines: string[]): string {
  return [
    "# The Kodel project config. Every key is optional.",
    "version: 1",
    ...storageLines,
    "tasks:",
    `  enabled: ${tasks}`,
    "",
  ].join("\n");
}

function parseAgents(requested: string[]): AgentAdapter[] {
  if (requested.includes("all")) return [...AGENTS];
  const picked: AgentAdapter[] = [];
  for (const id of requested) {
    const agent = AGENTS.find((a) => a.id === id);
    if (!agent) {
      throw new InitError(`unknown agent "${id}"; use ${[...AGENT_IDS, "all"].join(", ")}`);
    }
    if (!picked.includes(agent)) picked.push(agent);
  }
  return picked;
}

async function chooseAgents(opts: InitOptions, io: InitIO, canAsk: boolean) {
  if (opts.agents && opts.agents.length > 0) return parseAgents(opts.agents);
  const detected = await detectAgents(opts.root, io.environment);
  if (!canAsk) {
    if (detected.length === 0) {
      throw new InitError(
        `no coding agent found here; name one with --agent (${AGENT_IDS.join(", ")}, all)`,
      );
    }
    return detected;
  }
  const picked = await io.select(
    "Which coding agents should be set up?",
    AGENTS.map((agent) => ({
      value: agent.id,
      label: `${agent.label}${detected.includes(agent) ? " (found)" : ""}`,
      checked: detected.includes(agent),
    })),
  );
  if (picked.length === 0) throw new InitError("no agent chosen, nothing was changed");
  return parseAgents(picked);
}

async function chooseTasks(opts: InitOptions, io: InitIO, canAsk: boolean): Promise<boolean> {
  if (opts.tasks !== undefined) return opts.tasks;
  if (!canAsk) return false;
  return io.confirm(
    "Turn on the local task tracker? It lets the agent or the CLI create tasks in the project so that nothing important is lost.",
  );
}

async function setUpConfig(ctx: Context, tasks: boolean, storage: "project" | "home") {
  const existed = (await readIfExists(join(ctx.root, KODEL_DIR, "config.yaml"))) !== undefined;
  // `--storage home` writes the two keys that put the history under `~/.kodel/projects/<id>`: the
  // id is made here, once, and committed with the config, so a moved project keeps its history.
  const projectId = generateProjectId(basename(resolve(ctx.root)));
  const storageLines = storage === "home" ? linesToAdd(projectId).split("\n") : [];
  // The file is the person's and may carry comments: an existing one is not rewritten.
  await editFile(ctx, `${KODEL_DIR}/config.yaml`, (previous) => ({
    text: previous ?? configText(tasks, storageLines),
  }));
  if (storage === "home") {
    ctx.hints.push(
      "every kodel that reads this config must be upgraded before it is committed: an older build refuses the keys storage and project_id on every command",
    );
    // A note, not a second entry for the file: it is listed once, as unchanged, above.
    if (existed) {
      ctx.hints.push(
        `.kodel/config.yaml is not rewritten; add these lines yourself: ${storageLines.join(" / ")}`,
      );
    }
  }
  if (!tasks || !existed) return;
  const config = await loadConfig(join(ctx.root, KODEL_DIR)).catch(() => undefined);
  if (config && !config.tasks.enabled) {
    ctx.changes.push({
      path: `${KODEL_DIR}/config.yaml`,
      status: "skipped",
      note: "tasks are off in the existing file; set `tasks: { enabled: true }` yourself",
    });
  }
}

async function chooseHooks(opts: InitOptions, io: InitIO, canAsk: boolean): Promise<boolean> {
  if (opts.hooks !== undefined) return opts.hooks;
  if (!canAsk) return true;
  return io.confirm(
    "Register the Kodel hooks? They are what lets Kodel see your agent sessions.",
    true,
  );
}

/** Register the hooks; the answer is what the person has to know afterwards. */
async function setUpHooks(
  ctx: Context,
  agents: AgentAdapter[],
  serverCommand: string,
  environment: Record<string, string | undefined>,
): Promise<string[]> {
  const notes: string[] = [];
  const registry = defaultHookRegistry();
  for (const agent of agents) {
    await registerHooks(ctx, agent.id, serverCommand, registry.events(agent.id));
  }
  const program = hookCommand(serverCommand, "claude-code").split(/\s+/)[0] ?? "";
  if (program !== "" && !/[\\/]/.test(program) && !(await onPath(program, environment.PATH))) {
    notes.push(
      `\`${program}\` is not on the PATH: the agents will not find it to run the hook; install it or give --server-command`,
    );
  }
  if (agents.some((agent) => agent.id === "codex")) {
    notes.push(
      "Codex does not run project hooks until you trust them once: start Codex in this project, open /hooks and trust the Kodel hook (kodel init cannot do that for you)",
      "Codex runs hooks inside its sandbox: in a read-only session the hook cannot write .kodel/sessions.jsonl (or its place under ~/.kodel with storage: home), so that session is not recorded",
    );
  }
  return notes;
}

export async function runInit(opts: InitOptions, io: InitIO): Promise<Change[]> {
  const rootStat = await stat(opts.root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new InitError(`${opts.root} is not a directory`);
  const [command, ...args] = opts.serverCommand.trim().split(/\s+/);
  if (!command) throw new InitError("--server-command is empty");
  const server: ServerCommand = { command, args };

  const canAsk = io.interactive && !opts.yes;
  const agents = await chooseAgents(opts, io, canAsk);
  const tasks = await chooseTasks(opts, io, canAsk);
  const hooks = await chooseHooks(opts, io, canAsk);

  const ctx: Context = {
    root: opts.root,
    dryRun: opts.dryRun,
    force: opts.force,
    changes: [],
    hints: [],
  };

  await setUpConfig(ctx, tasks, opts.storage ?? "project");

  for (const agent of agents) {
    await agent.connect(ctx, server);
    await installSkills(ctx, agent);
  }
  const notes = hooks ? await setUpHooks(ctx, agents, opts.serverCommand, io.environment) : [];

  report(ctx, agents, io, hooks, notes);
  return ctx.changes;
}

const RANK: Record<Change["status"], number> = { created: 3, updated: 2, skipped: 1, unchanged: 0 };

/** One line per file: a file edited by two steps is reported once, with the stronger status. */
function merged(changes: Change[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const change of changes) {
    const seen = byPath.get(change.path);
    if (!seen) byPath.set(change.path, { ...change });
    else {
      if (RANK[change.status] > RANK[seen.status]) seen.status = change.status;
      seen.note = seen.note ?? change.note;
    }
  }
  return [...byPath.values()];
}

function report(ctx: Context, agents: AgentAdapter[], io: InitIO, hooks: boolean, notes: string[]) {
  const verb = (status: Change["status"]) =>
    ctx.dryRun && (status === "created" || status === "updated") ? `would be ${status}` : status;
  const lines = merged(ctx.changes);
  const width = Math.max(...lines.map((c) => verb(c.status).length));
  io.out(
    `${ctx.dryRun ? "kodel init (dry run, nothing is written)" : "kodel init"}: ${ctx.root}\n`,
  );
  for (const change of lines) {
    const note = change.note ? `  (${change.note})` : "";
    io.out(`  ${verb(change.status).padEnd(width)}  ${change.path}${note}\n`);
  }
  const unverified = agents.filter((agent) => !agent.verified).map((agent) => agent.label);
  if (unverified.length > 0) {
    io.out(`note: the setup for ${unverified.join(", ")} is not checked on the real agent yet\n`);
  }
  const hooksUnverified = hooks
    ? agents.filter((agent) => !agent.hooksVerified).map((agent) => agent.label)
    : [];
  if (hooksUnverified.length > 0) {
    io.out(
      `note: the hooks for ${hooksUnverified.join(", ")} are not checked on the real agent yet\n`,
    );
  }
  for (const note of [...ctx.hints, ...notes]) io.out(`note: ${note}\n`);
  if (!ctx.dryRun) {
    io.out(
      agents.some((agent) => agent.id === "claude-code")
        ? "next: approve the kodel server in the agent, then restart it so that it connects\n"
        : "next: restart the agent so that it connects the kodel server\n",
    );
  }
}

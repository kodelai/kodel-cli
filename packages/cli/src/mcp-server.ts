import { KILL_GRACE_MS } from "@kodel-ai/local";
import {
  type KodelError,
  type ManagerHost,
  type PipelineHost,
  PipelineService,
  type ResolvedToolSet,
  type RoleOverrides,
  type RunTaskLink,
  resolveToolSet,
  type ServerRole,
  servedUnderKeys,
  type TaskService,
  toolsFingerprint,
} from "@kodel-ai/pipeline-core";
import {
  type AgentDecisionFlags,
  buildTaskTools,
  CONTRACT_VERSION,
  decisionTools,
  HISTORY_TOOLS,
  keepOnly,
  MANAGER_TOOLS,
  registerHistoryTools,
  registerManagerTools,
  registerPipelineTools,
  registerTaskTools,
  serverInstructions,
  taskInstructions,
  toolsFor,
} from "@kodel-ai/pipeline-core/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentDecider } from "./agent-decisions";
import type { CancelInput, CancelResult } from "./cancel-run";
import { createElicitor, type HumanHost, newDialogState } from "./elicit";

/** A host that can also stop the work it started (the local host does); it says how much it stopped. */
export type StoppableHost = PipelineHost & {
  stop?(): number;
  /** The engine sessions the stopped runs waited for; they run on and a person stops them. */
  sessionsNote?(): string | undefined;
  /** Wait for what the host still writes about its runs, but no longer than the given milliseconds. */
  settle?(ms: number): Promise<void>;
};

/** How long leaving the server waits for the changes of a run that has just ended to be recorded. */
export const SHUTDOWN_SETTLE_MS = 30_000;

/** A host for a server started outside a project: every tool answers with the same error. */
export function noProjectHost(error: KodelError): StoppableHost {
  const refuse = (): never => {
    throw error;
  };
  return { list: refuse, resolve: refuse, start: refuse, open: refuse };
}

/**
 * How long a dialog may stay open, from `KODEL_DIALOG_TIMEOUT_S` in the server's environment: for a
 * client that gives up on a call sooner than the default. Anything but a positive number of seconds
 * leaves the default.
 */
export function dialogTimeoutFrom(
  environment: Record<string, string | undefined> | undefined,
): number | undefined {
  const raw = environment?.["KODEL_DIALOG_TIMEOUT_S"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/** A manager host for a server started outside a project: every read answers with the same error. */
export function noProjectManager(error: KodelError): ManagerHost {
  const refuse = (): never => {
    throw error;
  };
  return {
    inbox: refuse,
    runReport: refuse,
    gateChanges: refuse,
    serveStatus: refuse,
    agents: refuse,
    agentLog: refuse,
    watch: refuse,
  };
}

/**
 * The tools a server serves (5M9D): what it can serve at all (the task tools only with a tracker, a
 * decision tool only when the config lets the agent decide), narrowed by the role, the `mcp.roles`
 * block and `--read-only`. Worked out before the server is built, from flags and config, never from a call.
 */
export function serverToolSet(input: {
  role?: ServerRole;
  overrides?: RoleOverrides;
  readOnly?: boolean;
  tasks?: TaskService;
  runLink?: RunTaskLink;
  agentDecisions?: AgentDecisionFlags;
  /** The host keeps attachments: only then can their tools be served. */
  attachments?: boolean;
}): ResolvedToolSet {
  const taskLink = input.tasks !== undefined && input.runLink !== undefined;
  return resolveToolSet({
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
    readOnly: input.readOnly === true,
    available: [
      ...toolsFor({ taskLink, attachments: input.attachments === true }),
      ...(input.agentDecisions?.gate === true
        ? [{ name: "pipeline_decide_gate", readOnly: false }]
        : []),
      ...(input.agentDecisions?.pipelineChange === true
        ? [{ name: "pipeline_accept_change", readOnly: false }]
        : []),
      // NE3N: a manager's only; a server with no role serves both roles and must not get it.
      ...(input.agentDecisions?.cancelRun === true && input.role === "manager"
        ? [{ name: "manager_cancel_run", readOnly: false }]
        : []),
      // The manager's acting tools exist only under their own key, as the decision tools do.
      ...MANAGER_TOOLS.filter((tool) => servedUnderKeys(tool.name, input.agentDecisions)),
      ...HISTORY_TOOLS,
      ...(input.tasks === undefined ? [] : buildTaskTools(input.tasks.capabilities)),
    ],
  });
}

export interface ServerOptions {
  /** The role the server was started with (`--role`); absent for a server with none. */
  role?: ServerRole;
  /** `--read-only`: only tools marked read-only are served, and nothing is asked in a dialog. */
  readOnly?: boolean;
  /**
   * The names the server serves, from `serverToolSet`. A tool outside it is not registered and not in
   * the list its dispatcher searches. Absent: every tool the server can serve.
   */
  only?: readonly string[];
  /** The reads behind the `manager_*` tools; without it they answer `HISTORY_UNAVAILABLE`. */
  manager?: ManagerHost;
  /** Whether the answers offer the agent `kodel wait` (the project config can turn it off). */
  waitHint?: boolean;
  /**
   * The command that watches a run, as this server's agent is to start it (`{run}` is the run id): every
   * answer and the instructions spell it in place of `kodel wait <run>`, whatever `waitHint` says. The
   * server of a background agent that stays alive at a wait gets it from its launcher.
   */
  waitCommand?: string;
  /**
   * A host that can decide for a person (the local one). With `dialog`, a client that can show a
   * form is asked there at a gate, a pause, a change of the pipeline and a state changed outside
   * kodel; a client that cannot is answered as before. Without `dialog` the person decides with the
   * commands, and the agent decides only what `agentDecisions` lets it.
   */
  humans?: HumanHost;
  /** Whether `humans` is asked through the client (`decisions.dialog`); off unless the config says so. */
  dialog?: boolean;
  /** What the config lets the agent decide on the person's instruction; needs `humans`. */
  agentDecisions?: AgentDecisionFlags;
  /** Cancels a run (NE3N) for `manager_cancel_run`; without it the tool is not served. */
  cancel?: (input: CancelInput) => Promise<CancelResult>;
  /** How long a dialog may stay open, in milliseconds; the default is long enough to read the changes. */
  dialogTimeoutMs?: number;
}

/**
 * Build the MCP server for a host; the transport is the caller's. The task tools and their part of
 * the instructions are there only when `tasks` is given (the config turned them on): with tasks
 * off the agent is told nothing about them. `runLink` (the config asks for runs to be tied to tasks)
 * adds `task_key` to pipeline_start and the rule about it to the instructions.
 */
export function createServer(
  host: PipelineHost,
  version: string,
  tasks?: TaskService,
  runLink?: RunTaskLink,
  options: ServerOptions = {},
): McpServer {
  const { humans, role, only } = options;
  const readOnly = options.readOnly === true;
  // An answer in a dialog is a decision, so a read-only server never asks there.
  const dialog = humans !== undefined && options.dialog === true && !readOnly;
  // Without a host that can decide there is nothing for the agent's tools to do, so none is served.
  const agentDecisions = humans === undefined ? {} : (options.agentDecisions ?? {});
  // The attachment tools, and the rule about them, only on a host whose runs keep attachments.
  const attachments = host.attachments === true;
  const taskLink = tasks !== undefined && runLink !== undefined;
  const state = newDialogState();
  // A manager works no step: its decisions answer with the run as it is, and nothing is served to it.
  const lookWith = role === "manager" ? "manager_inbox" : "pipeline_next_step";
  const decisions = humans
    ? decisionTools(
        agentDecisions,
        createAgentDecider(humans, state, {
          lookWith,
          ...(options.cancel === undefined ? {} : { cancel: options.cancel }),
        }),
        { lookWith },
      )
    : [];
  const pipelineTools = keepOnly(
    [
      ...toolsFor({
        taskLink,
        attachments,
        ...(role === undefined ? {} : { role }),
        ...(only === undefined ? {} : { served: only }),
      }),
      ...decisions,
    ],
    only,
  );
  const taskTools = tasks ? keepOnly(buildTaskTools(tasks.capabilities, only), only) : [];
  const all = [
    ...pipelineTools,
    ...keepOnly(HISTORY_TOOLS, only),
    ...keepOnly(MANAGER_TOOLS, only),
    ...taskTools,
  ];
  // The final set: the texts, the fingerprint and every registration below follow it.
  const served = all.map((tool) => tool.name);
  const base = serverInstructions({
    ...(options.waitHint === undefined ? {} : { waitHint: options.waitHint }),
    ...(options.waitCommand === undefined ? {} : { waitCommand: options.waitCommand }),
    dialog,
    decisions: agentDecisions,
    attachments,
    ...(role === undefined ? {} : { role }),
    served,
  });
  const instructions =
    taskTools.length > 0
      ? `${base}\n\n${taskInstructions(runLink?.mode ?? "disabled", runLink !== undefined, served)}`
      : base;
  const server = new McpServer({ name: "kodel", version }, { instructions });
  const service = new PipelineService(host, {
    engineVersion: version,
    // Asked at each call: the client's name comes with the handshake, after the server is built.
    caller: () => {
      const client = server.server.getClientVersion();
      return client === undefined ? undefined : { name: client.name, version: client.version };
    },
    surface: {
      instructions,
      tools: toolsFingerprint(all, { role: role ?? "all", readOnly }),
      contract_version: CONTRACT_VERSION,
      role: role ?? "all",
    },
    ...(options.waitCommand === undefined ? {} : { waitCommand: options.waitCommand }),
  });
  registerPipelineTools(server, service, {
    taskLink,
    ...(role === undefined ? {} : { role }),
    only: served,
    attachments,
    ...(humans && dialog
      ? {
          afterTool: createElicitor(server.server, humans, service, {
            state,
            ...(options.dialogTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.dialogTimeoutMs }),
          }),
        }
      : {}),
    extraTools: decisions,
  });
  registerHistoryTools(server, service, { only: served });
  registerManagerTools(server, options.manager ?? {}, { only: served });
  if (tasks) registerTaskTools(server, tasks, { only: served });
  return server;
}

/**
 * Stop the commands the server is running and give them the moment they need to be gone: one that
 * ignores the polite request is killed after `KILL_GRACE_MS`, by a timer this process has to stay
 * alive for. Exiting at once would leave that command running with nobody to report to.
 */
export async function stopAndWait(
  host: StoppableHost,
  settleMs = SHUTDOWN_SETTLE_MS,
): Promise<void> {
  const stopped = host.stop?.() ?? 0;
  // stderr: stdout is the protocol. The sessions run on; the note says how a person ends one.
  const note = host.sessionsNote?.();
  if (note !== undefined) process.stderr.write(`kodel: ${note}\n`);
  if (stopped > 0) await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 300));
  // The patch of a run that just ended is written in the background; leaving now would cut it off.
  // Bounded twice: the host stops waiting at the deadline, and a host that does not is not waited for.
  if (host.settle) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, settleMs + 1_000);
    });
    try {
      await Promise.race([host.settle(settleMs).catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Serve over stdio until the agent closes it. Nothing else may write to stdout meanwhile. However
 * the server ends (the agent closes the pipe, or the process is told to stop), the commands it was
 * running are stopped with it; the next session starts them again.
 */
export async function serveStdio(
  host: StoppableHost,
  version: string,
  tasks?: TaskService,
  runLink?: RunTaskLink,
  options: ServerOptions = {},
): Promise<void> {
  const server = createServer(host, version, tasks, runLink, options);
  await server.connect(new StdioServerTransport());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopAndWait(host).then(() => process.exit(0));
    });
  }
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    // The SDK does not count the agent's end of the pipe closing as the server closing, so a server
    // whose agent was killed outright would otherwise run for ever.
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await stopAndWait(host);
}

/** The instructions of a server that serves no tools inside an engine step's session (T-42). */
export const noToolsInstructions = (reason: string): string =>
  `Kodel serves no tools here: this agent runs inside an engine step's session (${reason}), and the step's own work is reported by the engine, not through a second Kodel client.`;

/**
 * Serve over stdio with no tools at all: an agent started by an engine step must not become a second
 * Kodel client of the person, but its MCP client still gets a server that answers and then says why.
 */
export async function serveNoTools(version: string, reason: string): Promise<void> {
  const server = new McpServer(
    { name: "kodel", version },
    { instructions: noToolsInstructions(reason) },
  );
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}

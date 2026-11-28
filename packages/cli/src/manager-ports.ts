/**
 * The manager's reads that live in the CLI (decision 5M9D): what `kodel serve` is doing, from its
 * record, and the background agents with their output, from the session adapter behind `kodel agent ls`
 * and `kodel agent logs`. They only read. On Windows, where no daemon and no agents run, they answer
 * "off" or an empty list with the reason instead of failing.
 */
import { readServeStatus, resolveBase, servePlace } from "@kodel-ai/local";
import type {
  Caller,
  ManagerHost,
  StartTaskData,
  StopAgentData,
  TaskService,
} from "@kodel-ai/pipeline-core";
import { pipesAdapter, stateLabel } from "./agent-commands";
import {
  type ManualServe,
  type ManualStartHost,
  type ManualTask,
  startManual,
} from "./manual-start";
import { type ManualStopHost, stopRunAgent } from "./manual-stop";
import { type CardSlot, loadTask } from "./tui/tasks-load";
import { manualTaskOf } from "./tui/worker-start";
import { type WorkerLauncher, workerRunOf } from "./worker-launcher";

export interface ManagerPortsInput {
  root: string;
  environment: Record<string, string | undefined>;
  /** How this program is started: the adapter needs it to be built, and starts nothing for a read. */
  launcher: { exec: string; args: string[] };
  platform: string;
  now?: () => number;
  /** What the manager's acting tools stand on; without it they answer `not_ready`. */
  acting?: ActingPorts;
}

/** The parts of the project that `manager_start_task` and `manager_stop_agent` act through. */
export interface ActingPorts {
  /** `LocalPipelineHost` fits both. */
  host: ManualStartHost & ManualStopHost;
  /** Opened at the first call: a manager that never acts opens nothing. */
  launcher(): Promise<Pick<WorkerLauncher, "preflight" | "start" | "statuses" | "stop">>;
  /** The tracker; absent when tasks are off. */
  tasks?: TaskService;
  /** The `serve` block as it is now. */
  serve(): Promise<ManualServe>;
  dialog(): Promise<boolean>;
  root: string;
  worktreesDir?(): Promise<string | undefined>;
  version: string;
}

const WINDOWS = "agents and kodel serve do not run on Windows yet";

/** How many bytes of an agent's output are read for the lines asked for. */
const LOG_BYTES_PER_LINE = 512;

const notReadyStart = (reason: string): StartTaskData => ({
  status: "refused",
  why: "not_ready",
  reason,
});

/** The task as a start stands on it, read from the tracker each time; a missing one is told apart. */
export async function readManualTask(tasks: TaskService, key: string): Promise<ManualTask> {
  let missing = false;
  const slot: CardSlot = await loadTask(
    {
      status: "on",
      source: {
        list: (i) => tasks.list(i),
        async get(i) {
          const answer = await tasks.get(i);
          if (!answer.ok && answer.code === "TASK_NOT_FOUND") missing = true;
          return answer;
        },
      },
    },
    key,
  );
  return missing ? { status: "missing" } : manualTaskOf(slot);
}

export function managerPorts(
  input: ManagerPortsInput,
): Pick<ManagerHost, "serveStatus" | "agents" | "agentLog" | "startTask" | "stopAgent"> {
  const windows = input.platform === "win32";
  const adapter = () =>
    pipesAdapter({ root: input.root, environment: input.environment, launcher: input.launcher });
  const caller: Caller = { name: "kodel-manager", version: input.acting?.version ?? "0" };
  return {
    async startTask(request) {
      const acting = input.acting;
      if (windows) return notReadyStart(WINDOWS);
      if (acting === undefined) return notReadyStart("this server cannot start a task here");
      const { tasks } = acting;
      if (tasks === undefined) return notReadyStart("tasks are off in this project");
      let launcher: Awaited<ReturnType<ActingPorts["launcher"]>>;
      let dialog: boolean;
      let worktreesDir: string | undefined;
      try {
        launcher = await acting.launcher();
        dialog = await acting.dialog();
        worktreesDir = await acting.worktreesDir?.();
      } catch (error) {
        return notReadyStart(error instanceof Error ? error.message : String(error));
      }
      // `by` and `via` are the path's: an agent through the manager, whatever the arguments say.
      const result = await startManual(
        {
          host: acting.host,
          launcher,
          readTask: (key) => readManualTask(tasks, key),
          serve: acting.serve,
          caller,
          dialog,
          root: acting.root,
          ...(worktreesDir === undefined ? {} : { worktreesDir }),
          ...(input.now === undefined ? {} : { now: input.now }),
        },
        {
          key: request.key,
          ...(request.pipeline === undefined ? {} : { pipeline: request.pipeline }),
          by: "agent",
          via: "manager",
          ...(request.instruction === undefined ? {} : { agentInstruction: request.instruction }),
          force: request.force,
        },
      );
      if (result.status === "started") {
        const { status: _s, ...rest } = result;
        return { status: "started", ...rest };
      }
      const { status: _s, ...rest } = result;
      return { status: "refused", ...rest };
    },

    async stopAgent(request): Promise<StopAgentData> {
      const acting = input.acting;
      const refused = (reason: string): StopAgentData => ({
        status: "refused",
        why: "not_ready",
        reason,
        run_id: request.run_id,
      });
      if (windows) return refused(WINDOWS);
      if (acting === undefined) return refused("this server cannot stop an agent here");
      let launcher: Awaited<ReturnType<ActingPorts["launcher"]>>;
      try {
        launcher = await acting.launcher();
      } catch (error) {
        return refused(error instanceof Error ? error.message : String(error));
      }
      const result = await stopRunAgent(
        { host: acting.host, launcher },
        {
          runId: request.run_id,
          by: "agent",
          ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
        },
      );
      if (result.status === "stopped") {
        const { status: _s, ...rest } = result;
        return { status: "stopped", ...rest };
      }
      const { status: _s, ...rest } = result;
      return { status: "refused", ...rest };
    },

    async serveStatus() {
      if (windows) return { state: "off", reason: WINDOWS };
      let place: ReturnType<typeof servePlace>;
      try {
        place = servePlace({ base: resolveBase(input.environment), root: input.root });
      } catch (error) {
        return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
      }
      const status = await readServeStatus(place, (input.now ?? Date.now)());
      if (status.kind === "off" || status.kind === "unknown") {
        return { state: status.kind, reason: status.why };
      }
      const { record } = status;
      return {
        state: status.kind,
        pid: record.pid,
        started: new Date(record.started).toISOString(),
        ...(record.cycle_at === undefined
          ? {}
          : { last_cycle: new Date(record.cycle_at).toISOString() }),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
    },

    async agents() {
      if (windows) return { agents: [], reason: WINDOWS };
      const rows = await adapter().list();
      return {
        agents: rows.map((row) => {
          const worker = row.name === undefined ? undefined : workerRunOf(row.name);
          return {
            id: row.id,
            ...(row.name === undefined ? {} : { name: row.name }),
            state: stateLabel(row),
            ...(worker === undefined ? {} : { run_id: worker.runId }),
            ...(row.command === undefined ? {} : { command: row.command }),
          };
        }),
      };
    },

    async agentLog(id, lines) {
      if (windows) return { id, lines: [] };
      const sessions = adapter();
      const known = (await sessions.list()).find((row) => row.id === id || row.name === id);
      if (known === undefined) return undefined;
      const tail = await sessions.tail(known.id, lines * LOG_BYTES_PER_LINE, "both");
      const all = tail.text.replace(/\r/g, "").split("\n");
      if (all.at(-1) === "") all.pop();
      return {
        id: known.id,
        lines: all.slice(-lines),
        ...(tail.complete && all.length <= lines ? {} : { truncated: true }),
      };
    },
  };
}

/**
 * The manager's reads that live in the CLI (decision 5M9D): what `kodel serve` is doing, from its
 * record, and the background agents with their output, from the session adapter behind `kodel agent ls`
 * and `kodel agent logs`. They only read. On Windows, where no daemon and no agents run, they answer
 * "off" or an empty list with the reason instead of failing.
 */
import { readServeStatus, resolveBase, servePlace } from "@kodel-ai/local";
import type { ManagerHost } from "@kodel-ai/pipeline-core";
import { pipesAdapter, stateLabel } from "./agent-commands";
import { workerRunOf } from "./worker-launcher";

export interface ManagerPortsInput {
  root: string;
  environment: Record<string, string | undefined>;
  /** How this program is started: the adapter needs it to be built, and starts nothing for a read. */
  launcher: { exec: string; args: string[] };
  platform: string;
  now?: () => number;
}

const WINDOWS = "agents and kodel serve do not run on Windows yet";

/** How many bytes of an agent's output are read for the lines asked for. */
const LOG_BYTES_PER_LINE = 512;

export function managerPorts(
  input: ManagerPortsInput,
): Pick<ManagerHost, "serveStatus" | "agents" | "agentLog"> {
  const windows = input.platform === "win32";
  const adapter = () =>
    pipesAdapter({ root: input.root, environment: input.environment, launcher: input.launcher });
  return {
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

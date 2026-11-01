export const FORK_PIPELINE: string;
export function commandsValidInCmd(pipeline?: string): boolean;
export interface ForkRunSeen {
  runId: string;
  events: string[];
  journal: Record<string, unknown>[];
  report: {
    failed_branches: boolean;
    busy_wall_s: number;
    work_s: number;
    critical_path: { fork: string; branch: string; seconds: number }[];
    forks: { failed: string[]; overlaps: unknown[] }[];
    nodes: { node: string; attempts: unknown[] }[];
  };
  status: string;
  /** The `reentry_feedback` the join was handed on its first entry, as the host answered it. */
  joinFeedback: string;
}
export function checkForkRun(
  artifact: string,
  /** The MCP SDK's `Client` and `StdioClientTransport` classes, as the caller resolved them. */
  deps: {
    Client: unknown;
    StdioClientTransport: unknown;
    fail: (message: string) => never;
    /** The executable that runs the artifact; the caller's own runtime by default. */
    runtime?: string;
  },
): Promise<ForkRunSeen>;

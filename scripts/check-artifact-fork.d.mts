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
}
export function checkForkRun(
  artifact: string,
  /** The MCP SDK's `Client` and `StdioClientTransport` classes, as the caller resolved them. */
  deps: { Client: unknown; StdioClientTransport: unknown; fail: (message: string) => never },
): Promise<ForkRunSeen>;

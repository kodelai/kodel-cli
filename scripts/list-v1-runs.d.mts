/** The open runs of run-state format `format` (1 by default) under `<root>/.kodel/runs`. */
export function listOpenRuns(
  root: string,
  format?: number,
): Promise<{ runId: string; status: string; pipeline: string; task: string }[]>;

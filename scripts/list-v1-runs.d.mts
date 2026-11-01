/** The open runs of run-state format `format` (1 by default) under `<root>/.kodel/runs`. */
export function listOpenRuns(
  root: string,
  format?: number,
): Promise<{ runId: string; status: string; pipeline: string; task: string }[]>;

/** The runs under `<root>/.kodel/runs` that `readRunState` cannot read, with the reason. */
export function unreadableRuns(
  root: string,
  readRunState: (text: string, runId: string) => unknown,
): Promise<{ runId: string; problem: string }[]>;

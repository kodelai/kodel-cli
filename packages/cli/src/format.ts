import type { RunReport } from "@kodel-ai/pipeline-core";

/** `45 s`, `2m 05s`, `1h 03m`: short enough for a table. */
export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The report as text for a person. `plain` strips control characters from what came from the agent
 * (a task, a failure reason) so it cannot move the cursor or pass as a line of its own.
 */
export function formatReport(
  report: RunReport,
  plain: (text: string) => string,
  trust?: { integrity: string; seal: string },
): string {
  const lines: string[] = [];
  lines.push(`run ${plain(report.runId)}  ${plain(report.status)}  ${plain(report.task)}`);
  if (trust) {
    const fine = trust.integrity !== "modified" && trust.seal !== "modified";
    lines.push(
      fine
        ? `files: integrity ${trust.integrity}, seal ${trust.seal}`
        : `WARNING: the files of this run were changed outside kodel (integrity ${trust.integrity}, seal ${trust.seal}); what follows may not be true`,
    );
  }
  lines.push(
    `total ${formatDuration(report.total_s)}: work ${formatDuration(report.work_s)}, ` +
      `waiting for a person ${formatDuration(report.waiting_s)}`,
  );
  lines.push(
    `redone: ${report.extra_attempts} extra attempt(s); ${report.restarts} restart(s), ` +
      `${report.pauses} pause(s), ${report.feedback} note(s) from the agent`,
  );
  lines.push("");
  const width = Math.max(4, ...report.nodes.map((n) => plain(n.node).length));
  lines.push(`${"node".padEnd(width)}  attempts  time`);
  for (const node of report.nodes) {
    const name = plain(node.node).padEnd(width);
    const gate = node.gate ? "  (a person decides)" : "";
    lines.push(
      `${name}  ${String(node.attempts.length).padEnd(8)}  ${formatDuration(node.seconds)}${gate}`,
    );
  }
  const failures = report.nodes.flatMap((node) =>
    node.attempts
      .filter((a) => a.failure)
      .map(
        (a) =>
          `  ${plain(node.node)} #${a.attempt} ${plain(a.outcome ?? "")}: ${plain(a.failure?.reason ?? "")}`,
      ),
  );
  if (failures.length > 0) {
    lines.push("", "what did not pass:", ...failures.map((f) => f.slice(0, 300)));
  }
  return `${lines.join("\n")}\n`;
}

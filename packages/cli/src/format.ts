import type { PipelineProposalView } from "@kodel-ai/local";
import type { NodeDiff, PipelineSpec, RunReport } from "@kodel-ai/pipeline-core";

const SHOWN_CHARS = 600;

/**
 * A change of a run's pipeline as text for the person who accepts it: what differs in each step, with
 * the changes to checks first, because a looser check is what the person most needs to see before
 * saying yes. Everything here may have been written by the agent, so it goes through `plain` and is cut.
 */
export function formatChange(
  before: PipelineSpec,
  after: PipelineSpec,
  nodes: NodeDiff[],
  redo: string[] | undefined,
  plain: (text: string) => string,
): string {
  const show = (value: unknown) => {
    const text = plain(JSON.stringify(value) ?? "none");
    return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}...` : text;
  };
  const oldNode = (slug: string) => before.nodes.find((n) => n.slug === slug);
  const newNode = (slug: string) => after.nodes.find((n) => n.slug === slug);
  const edges = (spec: PipelineSpec, slug: string) =>
    spec.edges.filter((e) => e.from === slug).map((e) => `${e.when} -> ${e.to}`);

  const checks: string[] = [];
  const other: string[] = [];
  for (const { slug, changes } of nodes) {
    const name = plain(slug);
    const was = oldNode(slug);
    const now = newNode(slug);
    if (changes.includes("added") && now) {
      other.push(`+ step "${name}" is added (${plain(now.kind)})`);
      continue;
    }
    if (changes.includes("removed")) {
      other.push(`- step "${name}" is removed; its attempts stay in the history`);
      continue;
    }
    if (!was || !now) continue;
    if (changes.includes("checks")) {
      checks.push(`step "${name}": checks`);
      const length = Math.max(was.checks.length, now.checks.length);
      for (let i = 0; i < length; i++) {
        const a = was.checks[i];
        const b = now.checks[i];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (a) checks.push(`  - ${show(a)}`);
        if (b) checks.push(`  + ${show(b)}`);
      }
    }
    if (changes.includes("work")) {
      other.push(`step "${name}": work`);
      other.push(`  - ${show({ kind: was.kind, params: was.params, timeout: was.timeout })}`);
      other.push(`  + ${show({ kind: now.kind, params: now.params, timeout: now.timeout })}`);
    }
    if (changes.includes("routing")) {
      other.push(`step "${name}": what happens next and how many attempts it gets`);
      other.push(
        `  - ${show({ edges: edges(before, slug), max_attempts: was.max_attempts, max_consecutive_failures: was.max_consecutive_failures })}`,
      );
      other.push(
        `  + ${show({ edges: edges(after, slug), max_attempts: now.max_attempts, max_consecutive_failures: now.max_consecutive_failures })}`,
      );
    }
  }
  const lines: string[] = [];
  if (checks.length > 0) lines.push("Checks changed:", ...checks.map((l) => `  ${l}`), "");
  if (other.length > 0) lines.push("Other changes:", ...other.map((l) => `  ${l}`), "");
  // A change of a pipeline outside a run has no run to redo anything in.
  if (redo !== undefined) {
    lines.push(
      redo.length > 0
        ? `What happens when you accept:\n${redo.map((l) => `  ${plain(l)}`).join("\n")}`
        : "What happens when you accept: nothing is redone; the new definition is used from now on.",
    );
  }
  return lines.join("\n").trimEnd();
}

/**
 * A pipeline the agent proposed outside a run, as text for the person who accepts it: why, what differs
 * from the file (for a change), every shell command it would run on this machine, and the whole text.
 * The commands are the part that can do harm, so they are listed apart from the text they are in.
 */
export function formatProposal(
  view: PipelineProposalView,
  plain: (text: string) => string,
): string {
  const name = plain(view.record.name);
  const lines = [
    view.record.kind === "new"
      ? `The agent proposed a new pipeline, "${name}".`
      : `The agent proposed another version of the pipeline "${name}".`,
    `Why: ${plain(view.record.summary)}`,
    "",
  ];
  if (view.spec && view.current && view.changes) {
    const diff = formatChange(view.current, view.spec, view.changes, undefined, plain);
    lines.push("What differs, per step:", ...diff.split("\n").map((l) => `  ${l}`), "");
  }
  lines.push(
    view.current
      ? "Commands this pipeline runs on your machine ([new]: not in the pipeline as it is now):"
      : "Commands this pipeline runs on your machine:",
  );
  if (view.commands.length === 0) lines.push("  (none)");
  for (const { where, command, isNew } of view.commands) {
    lines.push(`  ${view.current && isNew ? "[new] " : ""}${plain(where)}: ${plain(command)}`);
  }
  lines.push(
    "",
    "The whole pipeline:",
    ...view.record.yaml.split("\n").map((l) => `  | ${plain(l)}`),
  );
  return lines.join("\n");
}

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
  lines.push(
    `run ${plain(report.runId)}  ${plain(report.status)}  ${plain(report.slug)}  ${plain(report.task)}`,
  );
  if (trust) {
    const fine = trust.integrity !== "modified" && trust.seal !== "modified";
    lines.push(
      fine
        ? `files: integrity ${trust.integrity}, seal ${trust.seal}`
        : `WARNING: the files of this run were changed outside kodel (integrity ${trust.integrity}, seal ${trust.seal}); what follows may not be true`,
    );
  }
  if (report.workdir !== undefined) lines.push(`workdir: ${plain(report.workdir)}`);
  if (report.tracker_task !== undefined) {
    const again = report.tracker_task.restarted ? " (restarted: the task had been done)" : "";
    lines.push(`tracker task: ${plain(report.tracker_task.key)}${again}`);
  }
  lines.push(
    `total ${formatDuration(report.total_s)}: work ${formatDuration(report.work_s)}, ` +
      `waiting for a person ${formatDuration(report.waiting_s)}`,
  );
  lines.push(
    `redone: ${report.extra_attempts} extra attempt(s); ${report.restarts} restart(s), ` +
      `${report.pauses} pause(s), ${report.feedback} note(s) from the agent, ` +
      `${report.refused} call(s) refused`,
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
  const changed = report.nodes.flatMap((node) =>
    node.attempts
      .filter((a) => a.definition_changed)
      .map((a) => `  ${plain(node.node)} #${a.attempt}: ${a.definition_changed?.join(", ")}`),
  );
  if (report.pipeline_changes.length > 0) {
    const checked = new Set(
      report.pipeline_changes.flatMap((c) =>
        c.nodes.filter((n) => n.changes.includes("checks")).map((n) => plain(n.slug)),
      ),
    );
    lines.push("", "the pipeline was changed while the run went:");
    for (const change of report.pipeline_changes) {
      const when = new Date(change.at).toISOString().replace("T", " ").slice(0, 19);
      const steps = change.nodes.map(
        (n) => `${plain(n.slug)} (${n.changes.map(plain).join(", ")})`,
      );
      const how = change.source === "proposal" ? "the agent's proposal" : "a change in the file";
      lines.push(
        `  ${when}  ${how}  ${steps.join(", ") || "no step differs"}  then: ${plain(change.effect)}` +
          (change.by === "agent" ? "  (accepted by the agent on the person's instruction)" : "") +
          (change.reason ? `  (${plain(change.reason)})` : ""),
      );
    }
    if (checked.size > 0) {
      lines.push(
        `  NOTE: the checks of ${[...checked].join(", ")} were changed during this run; what passed may have passed a different check than the pipeline file has now`,
      );
    }
  }
  if (report.agent_decisions.length > 0) {
    lines.push(
      "",
      "decided by the agent, on what it says the person told it (the engine cannot check that):",
    );
    for (const decision of report.agent_decisions) {
      const when = new Date(decision.at).toISOString().replace("T", " ").slice(0, 19);
      const what =
        decision.what === "gate"
          ? `gate ${plain(decision.node ?? "?")}: ${plain(decision.decision ?? "?")}`
          : "accepted a change of the pipeline";
      lines.push(`  ${when}  ${what}  "${plain(decision.instruction).slice(0, 200)}"`);
    }
  }
  if (changed.length > 0) {
    lines.push("", "attempts that ran on another definition than the one before:", ...changed);
  }
  if (report.checks.length > 0) {
    lines.push("", "checks:");
    const idWidth = Math.max(5, ...report.checks.map((c) => plain(c.check_id).length));
    lines.push(
      `  ${"check".padEnd(idWidth)}  runs  fails  wrong  changed  after a change`,
      ...report.checks.map((c) => {
        const after =
          c.params_changes === 0
            ? "-"
            : `${c.after_change.passed} passed, ${c.after_change.failed} failed`;
        return `  ${plain(c.check_id).padEnd(idWidth)}  ${String(c.runs).padStart(4)}  ${String(c.fails).padStart(5)}  ${String(c.wrong_check).padStart(5)}  ${String(c.params_changes).padStart(7)}  ${after}`;
      }),
    );
  }
  if (report.task_size !== undefined) {
    const size = report.task_size;
    if ("not_collected" in size) {
      lines.push("", "task size: not_collected");
    } else {
      const top = (items: { files: number }[], name: (i: never) => string) =>
        items
          .slice(0, 5)
          .map((i) => `${plain(name(i as never))} ${i.files}`)
          .join(", ");
      lines.push(
        "",
        `task size: ${size.files} file(s), +${size.added} -${size.removed} lines` +
          (size.binary_files > 0 ? `, ${size.binary_files} binary` : ""),
      );
      if (size.files > 0) {
        lines.push(
          `  directories: ${top(size.top_dirs, (i: { dir: string }) => i.dir)}`,
          `  languages: ${top(size.languages, (i: { ext: string }) => i.ext)}`,
        );
      }
    }
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
  const said = report.nodes.flatMap((node) =>
    node.attempts
      .filter((a) => a.summary)
      .map((a) => `  ${plain(node.node)} #${a.attempt}: ${plain(a.summary ?? "")}`),
  );
  if (said.length > 0) {
    lines.push("", "what the agent said it did:", ...said.map((s) => s.slice(0, 300)));
  }
  if (report.refusals.length > 0) {
    const shown = report.refusals.slice(0, 10).map((r) => {
      const where = r.node ? ` ${plain(r.node)}` : "";
      return `  ${plain(r.about)}${where}: ${plain(r.code)}: ${plain(r.message)}`.slice(0, 300);
    });
    const more = report.refused - shown.length;
    lines.push(
      "",
      "calls the engine refused:",
      ...shown,
      ...(more > 0 ? [`  and ${more} more`] : []),
    );
  }
  return `${lines.join("\n")}\n`;
}

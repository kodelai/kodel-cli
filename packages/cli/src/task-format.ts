/**
 * How the `kodel task` commands print what the task service answers. Every text that came from the
 * agent or from a tracker goes through `plain` (the caller's), which takes out what could mislead a
 * person reading a terminal.
 */
import type {
  FieldInfo,
  SubtaskRef,
  Task,
  TaskAdapterCapabilities,
  TaskProblem,
  TaskSummary,
  ToolFailure,
} from "@kodel-ai/pipeline-core";
import { formatTable } from "./table";

type Plain = (text: string) => string;

const SHOWN_COMMENTS = 5;

export const TASK_HEADER = ["KEY", "STATUS", "PRIORITY", "TITLE", "SUBTASKS", "PARENT"];

/** One row of cells per task; the latest comment is not a cell, it goes under the row (`formatTaskTable`). */
function taskCells(t: TaskSummary, plain: Plain): string[] {
  return [
    plain(t.key),
    `${plain(t.status)}${t.state === t.status ? "" : ` (${t.state})`}`,
    t.priority === undefined ? "-" : plain(t.priority),
    plain(t.title),
    t.subtasks ? `${t.subtasks.done}/${t.subtasks.total}` : "-",
    t.parent === undefined ? "-" : plain(t.parent),
  ];
}

export function formatTaskTable(tasks: TaskSummary[], plain: Plain, withHeader: boolean): string[] {
  const lines = formatTable(
    TASK_HEADER,
    tasks.map((t) => taskCells(t, plain)),
    withHeader,
  );
  const offset = withHeader ? 1 : 0;
  const out: string[] = withHeader ? [lines[0] ?? ""] : [];
  tasks.forEach((t, i) => {
    out.push(lines[i + offset] ?? "");
    if (t.comment !== undefined) out.push(`    "${plain(t.comment)}"`);
  });
  return out;
}

export function formatProblems(problems: TaskProblem[], plain: Plain): string {
  return problems.map((p) => `problem: ${plain(p.message)}\n`).join("");
}

export function formatTask(task: Task, subtasks: SubtaskRef[], plain: Plain): string {
  const lines = [
    `${plain(task.key)}: ${plain(task.title)}`,
    `  status: ${plain(task.status)} (${task.state})`,
  ];
  if (task.priority !== undefined) lines.push(`  priority: ${plain(task.priority)}`);
  if (task.type !== undefined) lines.push(`  type: ${plain(task.type)}`);
  if (task.id !== undefined) lines.push(`  id: ${plain(task.id)}`);
  if (task.parent !== undefined) lines.push(`  parent: ${plain(task.parent)}`);
  if (task.url !== undefined) lines.push(`  url: ${plain(task.url)}`);
  lines.push(`  created: ${plain(task.created_at)}   updated: ${plain(task.updated_at)}`);
  if (task.runs.length > 0) lines.push(`  runs: ${task.runs.map(plain).join(", ")}`);
  for (const [name, value] of Object.entries(task.fields ?? {})) {
    lines.push(
      `  ${plain(name)}: ${plain(Array.isArray(value) ? value.join(", ") : String(value))}`,
    );
  }
  if (task.body !== undefined && task.body !== "") {
    lines.push(
      "",
      // `plain` turns a line break into a space, so each line is cleaned on its own.
      ...task.body.split(/\r?\n/).map((l) => `  ${plain(l)}`),
    );
  }
  const comments = task.comments ?? [];
  if (comments.length > 0) {
    lines.push("", "  comments:");
    const shown = comments.slice(-SHOWN_COMMENTS);
    if (comments.length > shown.length || task.comments_truncated) lines.push("    ...");
    for (const c of shown) lines.push(`    ${plain(c.at)}  ${plain(c.text)}`);
  }
  if (subtasks.length > 0) {
    lines.push("", "  subtasks:");
    for (const s of subtasks) lines.push(`    ${plain(s.key)}  ${plain(s.title)}`);
  }
  return `${lines.join("\n")}\n`;
}

interface SchemaAnswer {
  adapter: string;
  capabilities: TaskAdapterCapabilities;
  statuses: { name: string; state: string; description?: string }[];
  priorities?: { name: string; description?: string }[];
  types?: { name: string; description?: string }[];
  fields: FieldInfo[];
  transitions?: { to: string; via?: string; requires?: string[] }[];
  truncated?: boolean;
}

export function formatSchema(answer: SchemaAnswer, plain: Plain): string {
  const caps = answer.capabilities;
  const enabled = [
    caps.subtasks && "subtasks",
    caps.runs !== "none" && `runs (${plain(caps.runs)})`,
    caps.comment !== "none" && `comments (${plain(caps.comment)})`,
    caps.fields && "fields",
    caps.priority && "priority",
    caps.types && "types",
  ].filter((c): c is string => typeof c === "string");
  const lines = [
    `adapter: ${plain(answer.adapter)}`,
    ...(enabled.length > 0
      ? ["capabilities:", ...enabled.map((c) => `  ${c}`)]
      : ["capabilities: none"]),
    "",
    "statuses:",
  ];
  const described = (name: string, description?: string, extra = "") =>
    `  ${plain(name)}${extra}${description ? ` - ${plain(description)}` : ""}`;
  for (const s of answer.statuses) lines.push(described(s.name, s.description, ` (${s.state})`));
  if (answer.priorities?.length) {
    lines.push("", "priorities (most important first):");
    for (const p of answer.priorities) lines.push(described(p.name, p.description));
  }
  if (answer.types?.length) {
    lines.push("", "types:");
    for (const t of answer.types) lines.push(described(t.name, t.description));
  }
  if (answer.fields.length > 0) {
    lines.push("", "fields:");
    for (const f of answer.fields) {
      const flags = [f.kind, f.required ? "required" : "", f.readonly ? "read-only" : ""]
        .filter(Boolean)
        .join(", ");
      const allowed = f.allowed?.length ? ` [${f.allowed.map(plain).join(" | ")}]` : "";
      lines.push(described(f.name, f.description, ` (${flags})${allowed}`));
    }
  }
  if (answer.transitions) {
    lines.push("", "moves from this status:");
    for (const t of answer.transitions) {
      const via = t.via ? ` via ${plain(t.via)}` : "";
      const needs = t.requires?.length ? ` (needs ${t.requires.map(plain).join(", ")})` : "";
      lines.push(`  ${plain(t.to)}${via}${needs}`);
    }
  }
  if (answer.truncated)
    lines.push("", "(the lists were cut; ask for one type or task to see more)");
  return `${lines.join("\n")}\n`;
}

/** A refusal as one message, with what its `details` add (what is missing, how long to wait). */
export function formatFailure(failure: ToolFailure, plain: Plain): string {
  const out = [`${failure.code}: ${plain(failure.message)}`];
  const details = failure.details ?? {};
  const missing = details.missing;
  if (Array.isArray(missing)) {
    for (const m of missing as { name: string; kind?: string; allowed?: string[] }[]) {
      const allowed = m.allowed?.length ? ` (one of ${m.allowed.map(plain).join(", ")})` : "";
      out.push(
        `  needs ${plain(m.name)}${m.kind ? ` [${m.kind}]` : ""}${allowed}; give it with --field`,
      );
    }
  }
  if (typeof details.retry_after_s === "number") {
    out.push(`  try again in ${details.retry_after_s} s`);
  }
  if (Array.isArray(details.applied) && details.applied.length > 0) {
    out.push(
      `  already applied: ${(details.applied as string[]).map(plain).join(", ")}; check with: kodel task show`,
    );
  }
  return out.join("\n");
}

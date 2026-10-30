/** Why a try failed, as the engine words it, read into something a person can look at. */
import type { Finding } from "./session";

/** The first line of a reason, without the JSON the engine appends to it. */
export function headOf(reason: string): string {
  return (reason.split("\n")[0] ?? "").replace(/:\s*(\{|\[\{).*$/, "").trim();
}

/** Whole JSON objects in a text, in order, and what is left over (a last one that was cut short). */
function objectsIn(text: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = depth > 0;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) objects.push(text.slice(start, i + 1));
    }
  }
  return { objects, rest: depth > 0 && start >= 0 ? text.slice(start) : "" };
}

const finding = (row: unknown): Finding | undefined => {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (typeof r.severity !== "string" || typeof r.description !== "string") return undefined;
  return {
    severity: r.severity,
    location: typeof r.location === "string" ? r.location : "",
    description: r.description,
  };
};

/**
 * A result check that failed says `3 blocking findings: {…}; {…}`. The findings are in the text as
 * JSON; take them out. A last one the engine cut short is left out and counted in `cut`.
 */
export function parseBlocking(
  reason: string,
): { head: string; findings: Finding[]; cut: boolean } | undefined {
  const at = reason.search(/:\s*\{/);
  if (at < 0) return undefined;
  const { objects, rest } = objectsIn(reason.slice(at));
  const findings: Finding[] = [];
  let cut = rest !== "";
  for (const text of objects) {
    try {
      const f = finding(JSON.parse(text));
      if (f) findings.push(f);
      else cut = true;
    } catch {
      cut = true;
    }
  }
  return findings.length === 0 ? undefined : { head: reason.slice(0, at).trim(), findings, cut };
}

/** Rows of CSV, with quoted fields that hold commas, quotes and line breaks. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows.filter((r) => r.some((c) => c !== ""));
}

/**
 * A rejection carries the comments recorded at the step as CSV under `Comments (CSV):`. What the
 * person wrote comes first, the comments after it.
 */
export function parseCommentsCsv(reason: string): { text: string; rows: Finding[] } | undefined {
  const at = reason.indexOf("Comments (CSV):");
  if (at < 0) return undefined;
  const [header, ...body] = csvRows(reason.slice(at + "Comments (CSV):".length).trim());
  if (!header) return undefined;
  const col = (name: string, fallback: number) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const [s, l, d] = [col("severity", 0), col("location", 1), col("description", 2)];
  const rows = body.map((r) => ({
    severity: r[s] ?? "",
    location: r[l] ?? "",
    description: r[d] ?? "",
  }));
  return { text: reason.slice(0, at).trim(), rows };
}

/** At most `n` lines, and a line that says how many were left out. */
export function capLines(lines: string[], n: number, more: (left: number) => string): string[] {
  return lines.length <= n ? lines : [...lines.slice(0, n), more(lines.length - n)];
}

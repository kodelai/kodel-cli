/** The diff of one file, ready to read: parsed into rows, syntax colored, laid out in lines with a cursor. */
import bash from "@speed-highlight/core/languages/bash.js";
import css from "@speed-highlight/core/languages/css.js";
import go from "@speed-highlight/core/languages/go.js";
import html from "@speed-highlight/core/languages/html.js";
import js from "@speed-highlight/core/languages/js.js";
import jsdoc from "@speed-highlight/core/languages/jsdoc.js";
import json from "@speed-highlight/core/languages/json.js";
import md from "@speed-highlight/core/languages/md.js";
import py from "@speed-highlight/core/languages/py.js";
import regex from "@speed-highlight/core/languages/regex.js";
import rs from "@speed-highlight/core/languages/rs.js";
import sql from "@speed-highlight/core/languages/sql.js";
import todo from "@speed-highlight/core/languages/todo.js";
import toml from "@speed-highlight/core/languages/toml.js";
import ts from "@speed-highlight/core/languages/ts.js";
import xml from "@speed-highlight/core/languages/xml.js";
import yaml from "@speed-highlight/core/languages/yaml.js";
import { tokenizeWith } from "@speed-highlight/core/tokenize";
import {
  blue,
  bold,
  cyan,
  dim,
  green,
  inverse,
  magenta,
  red,
  stripAnsi,
  wrapText,
  yellow,
} from "./ansi";
import type { Comment } from "./session";

// ── syntax ──────────────────────────────────────────────────────────────────

type Language = Exclude<Parameters<typeof tokenizeWith>[1], string>;

const LANGUAGES: Record<string, Language> = {
  bash,
  css,
  go,
  html,
  js,
  json,
  md,
  py,
  rs,
  sql,
  toml,
  ts,
  xml,
  yaml,
};

/** Languages a grammar may name for a stretch inside it (a template string, a doc comment). */
const NESTED: Record<string, Language> = { ...LANGUAGES, jsdoc, regex, todo };

const EXTENSIONS: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "md",
  markdown: "md",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "py",
  rs: "rs",
  go: "go",
  css: "css",
  html: "html",
  htm: "html",
  sql: "sql",
  toml: "toml",
  xml: "xml",
  svg: "xml",
};

export function languageOf(path: string): string | undefined {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSIONS[name.slice(dot + 1).toLowerCase()];
}

export interface Seg {
  text: string;
  type?: string;
}

/** Longer lines are shown plain: a minified bundle is not worth a regex run. */
const HIGHLIGHT_MAX = 600;

export function highlight(line: string, language: string | undefined): Seg[] {
  const grammar = language === undefined ? undefined : LANGUAGES[language];
  if (grammar === undefined || line.length > HIGHLIGHT_MAX) return [{ text: line }];
  const out: Seg[] = [];
  try {
    tokenizeWith(
      line,
      grammar,
      (text, type) => {
        if (text !== "") out.push(type === undefined ? { text } : { text, type });
      },
      { languages: NESTED },
    );
  } catch {
    return [{ text: line }];
  }
  return out.length > 0 ? out : [{ text: line }];
}

/** The terminal's own 16 colors, so the code follows the person's theme. */
const PAINT: Record<string, (text: string) => string> = {
  kwd: magenta,
  str: green,
  num: yellow,
  bool: yellow,
  esc: yellow,
  cmnt: dim,
  func: blue,
  class: cyan,
  type: cyan,
  var: cyan,
  err: red,
  deleted: red,
  insert: green,
  section: bold,
};

const paint = (seg: Seg): string =>
  seg.type === undefined ? seg.text : (PAINT[seg.type]?.(seg.text) ?? seg.text);

// ── the diff ────────────────────────────────────────────────────────────────

export type RowKind = "hunk" | "ctx" | "add" | "del" | "note";

export interface DiffRow {
  kind: RowKind;
  /** The line in the file before and after; a context line has both. */
  old?: number;
  new?: number;
  text: string;
}

/** The rows of a unified diff of one file. The header lines are dropped, bar the facts they carry. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0;
  let now = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      now = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", old, new: now, text: hunk[3] ?? "" });
    } else if (!inHunk) {
      if (line.startsWith("new file mode")) rows.push({ kind: "note", text: "new file" });
      else if (line.startsWith("deleted file mode"))
        rows.push({ kind: "note", text: "deleted file" });
      else if (line.startsWith("Binary files")) rows.push({ kind: "note", text: "binary file" });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", new: now++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", old: old++, text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line.slice(1).trim() });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", old: old++, new: now++, text: line.slice(1) });
    }
  }
  return rows;
}

export interface Prepared {
  rows: DiffRow[];
  segs: Seg[][];
  /** Digits in the widest line number. */
  digits: number;
}

const prepared = new WeakMap<object, Prepared>();

/** Parse and color once per diff that was read; the diff object itself is the key. */
export function prepare(diff: object, text: string, path: string): Prepared {
  const known = prepared.get(diff);
  if (known) return known;
  const rows = parseDiff(text);
  const language = languageOf(path);
  const segs = rows.map((r) =>
    r.kind === "hunk" || r.kind === "note" ? [] : highlight(r.text, language),
  );
  const top = rows.reduce((n, r) => Math.max(n, r.old ?? 0, r.new ?? 0), 0);
  const made = { rows, segs, digits: Math.max(3, String(top).length) };
  prepared.set(diff, made);
  return made;
}

export const isCode = (r: DiffRow): boolean =>
  r.kind === "ctx" || r.kind === "add" || r.kind === "del";

/** The row the cursor starts on, and the one it moves to from `from` by `by` code rows. */
export function firstCode(p: Prepared): number {
  return Math.max(0, p.rows.findIndex(isCode));
}

export function moveCode(p: Prepared, from: number, by: number): number {
  const codes = p.rows.flatMap((r, i) => (isCode(r) ? [i] : []));
  if (codes.length === 0) return from;
  const at = codes.findIndex((i) => i >= from);
  const here = at < 0 ? codes.length - 1 : at;
  return codes[Math.min(codes.length - 1, Math.max(0, here + by))] ?? from;
}

/** The first code row of the hunk after (by 1) or before (by -1) the one `from` is in. */
export function moveHunk(p: Prepared, from: number, by: 1 | -1): number {
  const starts = p.rows.flatMap((r, i) => (r.kind === "hunk" ? [i + 1] : []));
  const target = by === 1 ? starts.find((s) => s > from) : starts.findLast((s) => s < from);
  const row = target ?? from;
  return isCode(p.rows[row] ?? { kind: "note", text: "" }) ? row : from;
}

/** What a comment about this row is about: the line in the file as it is now, or as it was for a removed one. */
export function placeOf(path: string, row: DiffRow): string {
  return row.kind === "del" ? `${path}:${row.old} (removed line)` : `${path}:${row.new}`;
}

// ── the picture ─────────────────────────────────────────────────────────────

export interface View {
  width: number;
  /** The row the cursor is on. */
  cursor: number;
  /** The card has the keys; the cursor then stands out. */
  focused: boolean;
  path: string;
  comments: Comment[];
}

export interface Viewed {
  lines: string[];
  /** The first line of the cursor's row. */
  anchor: number;
}

/** Most lines one row takes; a longer line is cut. */
const ROW_LINES = 6;

function wrapSegs(segs: Seg[], width: number): Seg[][] {
  const lines: Seg[][] = [[]];
  let used = 0;
  for (const seg of segs) {
    const chars = [...seg.text.replaceAll("\t", "  ")];
    let at = 0;
    while (at < chars.length) {
      if (used >= width) {
        lines.push([]);
        used = 0;
      }
      const take = chars.slice(at, at + (width - used)).join("");
      (lines.at(-1) as Seg[]).push(
        seg.type === undefined ? { text: take } : { text: take, type: seg.type },
      );
      used += [...take].length;
      at += [...take].length;
    }
  }
  return lines;
}

/** A line cut short: its end gives way to a mark that says so. */
function cutWith(segs: Seg[], room: number): Seg[] {
  const out: Seg[] = [];
  let left = Math.max(0, room - 1);
  for (const seg of segs) {
    const chars = [...seg.text];
    if (chars.length <= left) {
      out.push(seg);
      left -= chars.length;
    } else {
      if (left > 0) out.push({ ...seg, text: chars.slice(0, left).join("") });
      break;
    }
  }
  return [...out, { text: "…", type: "cmnt" }];
}

function rowLines(p: Prepared, i: number, o: View): string[] {
  const row = p.rows[i];
  if (!row) return [];
  const w = p.digits;
  if (row.kind === "hunk") {
    const where = `@@ line ${row.new} @@`;
    return [`${dim("─")} ${cyan(where)}${row.text ? dim(`  ${row.text}`) : ""}`];
  }
  if (row.kind === "note") return [dim(`  ${" ".repeat(w)}  ${row.text}`)];
  const shown = i === o.cursor;
  const number = String(row.kind === "del" ? row.old : row.new).padStart(w);
  const mark = row.kind === "add" ? green("+") : row.kind === "del" ? red("-") : " ";
  const room = Math.max(8, o.width - w - 5);
  const all = wrapSegs(p.segs[i] ?? [], room);
  const wrapped = all.slice(0, ROW_LINES);
  if (all.length > ROW_LINES) wrapped[ROW_LINES - 1] = cutWith(wrapped[ROW_LINES - 1] ?? [], room);
  const lines = wrapped.map((segs, k) => {
    const body = segs.map(paint).join("");
    const gutter =
      k === 0
        ? `${shown ? bold(cyan("▸")) : " "} ${row.kind === "del" ? red(number) : dim(number)} ${mark} `
        : `  ${" ".repeat(w)} ${dim("↪")} `;
    return `${gutter}${body}`;
  });
  const styled = shown ? lines.map((l) => (o.focused ? inverse(stripAnsi(l)) : bold(l))) : lines;
  const place = placeOf(o.path, row);
  for (const c of o.comments.filter((x) => x.location === place)) {
    for (const [k, text] of wrapText(c.description, Math.max(10, o.width - w - 12)).entries()) {
      styled.push(
        `  ${" ".repeat(w)} ${k === 0 ? yellow(`✎ ${c.severity}`) : " ".repeat(c.severity.length + 2)} ${dim(text)}`,
      );
    }
  }
  return styled;
}

const laid = new WeakMap<Prepared, { key: string; viewed: Viewed }>();

/** Lay the diff out in lines of `width`, with the cursor row marked and the comments under their lines. */
export function viewDiff(p: Prepared, o: View): Viewed {
  const key = JSON.stringify([o.width, o.cursor, o.focused, o.path, o.comments]);
  const known = laid.get(p);
  if (known?.key === key) return known.viewed;
  const lines: string[] = [];
  let anchor = 0;
  for (let i = 0; i < p.rows.length; i++) {
    if (i === o.cursor) anchor = lines.length;
    lines.push(...rowLines(p, i, o));
  }
  const viewed = { lines, anchor };
  laid.set(p, { key, viewed });
  return viewed;
}

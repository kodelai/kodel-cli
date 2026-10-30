/** The Pipeline screen: the pipelines of a project, how each one runs, and what waits for a person. */
import type { PipelineSpec } from "@kodel-ai/pipeline-core";
import { bold, cyan, dim, fit, green, red, stripAnsi, wrapText, yellow } from "./ansi";
import type { Session } from "./session";
import { strip } from "./tabs";

export interface PipeRoute {
  to: string;
  /** The outcome that takes this route; empty for the usual way on. */
  when: string;
  /** The route goes back to this step or an earlier one. */
  back: boolean;
}

export interface PipeStep {
  slug: string;
  kind: string;
  /** A person decides here. */
  gate: boolean;
  limits: string;
  routes: PipeRoute[];
  /** What the step is told or runs: the prompt, the command, the instructions. */
  params: { key: string; value: string }[];
  checks: { kind: string; detail: string }[];
}

/** Something the agent proposed that waits for a person. */
export interface Pending {
  id: string;
  /** `proposal`: outside a run. `run`: a change of the pipeline of a run that is going. */
  source: "proposal" | "run";
  /** A pipeline that does not exist yet, or a change of one that does. */
  kind: "new" | "change";
  title: string;
  /** What accepting does, in words. */
  note: string[];
  /** Why it cannot be accepted. */
  problem?: string;
  /** Unified diff against the pipeline as it is now. */
  diff: string[];
  /** Shell commands it would run on this machine; `isNew` marks the ones the pipeline has not had. */
  commands: { where: string; command: string; isNew: boolean }[];
  /** The commands that accept and drop it. */
  accept: string;
  discard: string;
  /** For a change of a run: the run. */
  runId?: string;
}

export interface PipeEntry {
  id: string;
  name: string;
  description?: string;
  steps: PipeStep[];
  /** Why the file cannot be read. */
  problem?: string;
  /** The pipeline is only proposed so far: there is no file yet. */
  fresh?: boolean;
  pending: Pending[];
}

export interface PipeState {
  selected: string;
  /** An index into `PIPE_TABS`. */
  tab: number;
  /** The step the Flow is on. */
  step: number;
  /** The step is opened and what it is told is read. */
  open: boolean;
  /** Which of the pending proposals the Proposed tab shows. */
  pend: number;
  scroll: number;
}

export const PIPE_TABS = ["Flow", "Proposed"] as const;
const FLOW = 0;
const PROPOSED = 1;

export function initialPipeState(entries: PipeEntry[]): PipeState {
  return { selected: entries[0]?.id ?? "", tab: FLOW, step: 0, open: false, pend: 0, scroll: 0 };
}

/** What waits for a person comes first. */
export function sortEntries(entries: PipeEntry[]): PipeEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.pending.length > 0) - Number(a.pending.length > 0) || a.name.localeCompare(b.name),
  );
}

/** How many proposals wait for a person. */
export function pendingCount(entries: PipeEntry[]): number {
  return entries.reduce((n, e) => n + e.pending.length, 0);
}

/** The new list keeps the selection when the entry is still there. */
export function withEntries(p: PipeState, entries: PipeEntry[]): PipeState {
  return entries.some((e) => e.id === p.selected) ? p : initialPipeState(entries);
}

// ── from a pipeline file to what is shown ───────────────────────────────────

const PARAM_ORDER = ["prompt", "instructions", "command"];

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function stepsOf(spec: PipelineSpec): PipeStep[] {
  const index = new Map(spec.nodes.map((n, i) => [n.slug, i]));
  return spec.nodes.map((node, at) => {
    const limits = [
      node.timeout === undefined ? "" : `${node.timeout}s per attempt`,
      `${node.max_consecutive_failures} failures in a row`,
      `${node.max_attempts} attempts`,
    ].filter((x) => x !== "");
    const keys = Object.keys(node.params).sort(
      (a, b) =>
        (PARAM_ORDER.indexOf(a) === -1 ? 99 : PARAM_ORDER.indexOf(a)) -
        (PARAM_ORDER.indexOf(b) === -1 ? 99 : PARAM_ORDER.indexOf(b)),
    );
    return {
      slug: node.slug,
      kind: node.kind,
      gate: node.kind === "human",
      limits: limits.join(" · "),
      routes: spec.edges
        .filter((e) => e.from === node.slug)
        .map((e) => ({
          to: e.to,
          when: e.when === "passed" ? "" : e.when,
          back: (index.get(e.to) ?? Number.POSITIVE_INFINITY) <= at,
        })),
      params: keys.flatMap((key) => {
        const value = node.params[key];
        const text =
          Array.isArray(value) && value.every((x) => typeof x === "string")
            ? value.join(", ")
            : typeof value === "string"
              ? value
              : "";
        return text.trim() === "" ? [] : [{ key, value: text.trim() }];
      }),
      checks: node.checks.map((c) => ({
        kind: c.kind,
        detail: oneLine(
          Object.entries(c.params)
            .map(([k, v]) => `${k}: ${scalar(v)}`)
            .join(" · "),
        ),
      })),
    };
  });
}

/** A line diff in the unified format with a few lines of context; a file this size is read in full. */
export function unifiedDiff(before: string, after: string, context = 3): string[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  // Longest common subsequence; the table is skipped for a pair of files too large to be a pipeline.
  const ops: { t: " " | "+" | "-"; line: string }[] = [];
  if (a.length * b.length > 4_000_000) {
    for (const line of a) ops.push({ t: "-", line });
    for (const line of b) ops.push({ t: "+", line });
  } else {
    const w = b.length + 1;
    const table = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * w + j] =
          a[i] === b[j]
            ? (table[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ t: " ", line: a[i] ?? "" });
        i++;
        j++;
      } else if (
        j < b.length &&
        (i === a.length || (table[i * w + j + 1] ?? 0) > (table[(i + 1) * w + j] ?? 0))
      ) {
        ops.push({ t: "+", line: b[j] ?? "" });
        j++;
      } else {
        ops.push({ t: "-", line: a[i] ?? "" });
        i++;
      }
    }
  }
  const changed = ops.flatMap((op, k) => (op.t === " " ? [] : [k]));
  if (changed.length === 0) return [];
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k] ?? 0;
    let last = first;
    // Changes close together share one hunk.
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= context * 2 + 1) {
      k++;
      last = changed[k] ?? last;
    }
    k++;
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const slice = ops.slice(from, to + 1);
    const oldStart = ops.slice(0, from).filter((o) => o.t !== "+").length + 1;
    const newStart = ops.slice(0, from).filter((o) => o.t !== "-").length + 1;
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const op of slice) out.push(`${op.t}${op.line}`);
  }
  return out;
}

// ── keys ────────────────────────────────────────────────────────────────────

export interface PipeView {
  entries: PipeEntry[];
  focus: "list" | "card";
  source: "demo" | "project";
  /** The width of the card and the lines it has room for below its head. */
  width: number;
  room: number;
}

export interface PipeResult {
  p: PipeState;
  focus?: "list" | "card";
  /** Show this session on the Sessions screen. */
  open?: string;
  notice?: string;
}

export function entryOf(entries: PipeEntry[], p: PipeState): PipeEntry | undefined {
  return entries.find((e) => e.id === p.selected) ?? entries[0];
}

/** The runs of the pipeline, for the counts in the list. */
export function runsOf(entry: PipeEntry, sessions: Session[]): Session[] {
  return entry.fresh ? [] : sessions.filter((s) => s.pipeline === entry.name);
}

export function tabsOf(entry: PipeEntry | undefined): number[] {
  return entry && entry.pending.length > 0 ? [FLOW, PROPOSED] : [FLOW];
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, max), Math.max(0, n));
}

export function pendingOf(entry: PipeEntry, p: PipeState): Pending | undefined {
  return entry.pending[clamp(p.pend, entry.pending.length - 1)];
}

export function pipeKey(p: PipeState, key: string, v: PipeView): PipeResult | undefined {
  const entry = entryOf(v.entries, p);
  const up = key === "up" || key === "k";
  const down = key === "down" || key === "j";
  if (v.focus === "list") {
    if (up || down) {
      const at = Math.max(
        0,
        v.entries.findIndex((e) => e.id === entry?.id),
      );
      const next = v.entries[clamp(at + (down ? 1 : -1), v.entries.length - 1)];
      return next ? { p: initialPipeState([next]) } : { p };
    }
    if ((key === "enter" || key === "right") && entry) return { p, focus: "card" };
    return undefined;
  }
  if (!entry) return { p, focus: "list" };
  const tabs = tabsOf(entry);
  const at = Math.max(0, tabs.indexOf(p.tab));
  const switchTo = (tab: number): PipeResult => ({ p: { ...p, tab, open: false, scroll: 0 } });
  const pending = pendingOf(entry, p);
  switch (key) {
    case "escape":
      return p.open ? { p: { ...p, open: false, scroll: 0 } } : { p, focus: "list" };
    case "left":
      if (p.open) return { p: { ...p, open: false, scroll: 0 } };
      return at === 0 ? { p, focus: "list" } : switchTo(tabs[at - 1] ?? FLOW);
    case "right":
      return p.open ? { p } : switchTo(tabs[Math.min(tabs.length - 1, at + 1)] ?? FLOW);
    case "s":
      if (p.tab !== PROPOSED) return undefined;
      return pending?.runId ? { p, open: pending.runId } : { p, notice: "No run to show." };
    case "a":
    case "r": {
      if (p.tab !== PROPOSED || !pending) return undefined;
      const command = key === "a" ? pending.accept : pending.discard;
      const what = key === "a" ? "accept" : "drop";
      if (v.source === "demo") return { p, notice: `Sample data: nothing to ${what}.` };
      return { p, notice: `To ${what} it, in a terminal: ${command}` };
    }
    default:
  }
  const lines = bodyOf(entry, p, v.width).lines.length;
  const page = Math.max(1, v.room - 1);
  const moveScroll = (by: number): PipeResult => ({
    p: { ...p, scroll: clamp(p.scroll + by, lines - v.room) },
  });
  const scrolling = p.tab === PROPOSED || p.open;
  if (key === "pagedown" || key === " ") return scrolling ? moveScroll(page) : undefined;
  if (key === "pageup" || key === "b") return scrolling ? moveScroll(-page) : undefined;
  if ((key === "n" || key === "p") && p.tab === FLOW && p.open) {
    const step = clamp(p.step + (key === "n" ? 1 : -1), entry.steps.length - 1);
    return { p: { ...p, step, scroll: 0 } };
  }
  if ((key === "n" || key === "p") && p.tab === PROPOSED) {
    const pend = clamp(p.pend + (key === "n" ? 1 : -1), entry.pending.length - 1);
    return { p: { ...p, pend, scroll: 0 } };
  }
  if (p.tab === FLOW && !p.open) {
    if (up || down) {
      return { p: { ...p, step: clamp(p.step + (down ? 1 : -1), entry.steps.length - 1) } };
    }
    if (key === "enter" && entry.steps.length > 0) return { p: { ...p, open: true, scroll: 0 } };
  }
  if (scrolling && (up || down)) return moveScroll(down ? 1 : -1);
  return undefined;
}

// ── drawing ─────────────────────────────────────────────────────────────────

function runCounts(entry: PipeEntry, sessions: Session[]): string {
  const runs = runsOf(entry, sessions);
  const count = (f: (s: Session) => boolean) => runs.filter(f).length;
  const waiting = count((s) => s.status === "waiting");
  const running = count((s) => s.status === "running");
  const over = count((s) => s.status !== "waiting" && s.status !== "running");
  return [
    waiting > 0 ? `${yellow("◆")}${waiting}` : "",
    running > 0 ? `${green("●")}${running}` : "",
    over > 0 ? dim(`✓${over}`) : "",
  ]
    .filter((x) => x !== "")
    .join(" ");
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function summaryOf(e: PipeEntry): string {
  if (e.problem !== undefined && e.steps.length === 0) return "cannot be read";
  const gates = e.steps.filter((s) => s.gate).length;
  return `${plural(e.steps.length, "step")} · ${plural(gates, "gate")}`;
}

/** What the list says at the right of a pipeline: that something waits, and how its runs are. */
function tagOf(e: PipeEntry, sessions: Session[]): string {
  const waiting = e.pending.length === 0 ? "" : yellow(e.fresh ? "new" : "proposed");
  return [waiting, runCounts(e, sessions)].filter((x) => x !== "").join(" ");
}

export function pipeList(
  entries: PipeEntry[],
  p: PipeState,
  sessions: Session[],
  width: number,
  height: number,
  focused: boolean,
): string[] {
  const lines: string[] = [];
  let selectedAt = 0;
  let waiting: boolean | undefined;
  const selected = entryOf(entries, p)?.id;
  for (const e of entries) {
    const isWaiting = e.pending.length > 0;
    if (isWaiting !== waiting) {
      if (waiting !== undefined) lines.push("");
      lines.push(dim(isWaiting ? "WAITING FOR YOU" : "PIPELINES"));
      waiting = isWaiting;
    }
    const on = e.id === selected;
    if (on) selectedAt = lines.length;
    const mark = on ? (focused ? cyan("▸") : bold("▸")) : " ";
    const right = tagOf(e, sessions);
    const head = `${mark} ${on ? bold(e.name) : e.name}`;
    const gap = Math.max(1, width - stripAnsi(head).length - stripAnsi(right).length - 1);
    lines.push(fit(`${head}${" ".repeat(gap)}${right}`, width));
    const note = e.problem !== undefined ? red(oneLine(e.problem, width)) : dim(summaryOf(e));
    lines.push(fit(`  ${note}`, width));
  }
  const start =
    lines.length <= height
      ? 0
      : Math.min(Math.max(0, selectedAt - Math.floor(height / 2)), lines.length - height);
  return lines.slice(start, start + height);
}

export function emptyPipes(): string[] {
  return [
    "",
    `  ${bold("No pipelines in this project.")}`,
    dim("  Ask the agent for one: /kodel-design. The proposal waits here until you accept it."),
  ];
}

/** The head of the card: what the pipeline is, what is wrong with it, and the tabs. */
export function pipeHead(
  entry: PipeEntry,
  p: PipeState,
  width: number,
  focused: boolean,
): string[] {
  const out: string[] = [];
  out.push(fit(bold(entry.name), width));
  if (entry.description) {
    const lines = wrapText(entry.description, Math.max(10, width - 1));
    for (const l of lines.slice(0, 3)) out.push(dim(l));
    if (lines.length > 3) out.push(dim("…"));
  }
  if (entry.problem !== undefined) {
    for (const l of wrapText(entry.problem, width - 2)) out.push(red(l));
  }
  if (entry.pending.length > 0 && p.tab !== PROPOSED) {
    out.push(
      fit(
        yellow(
          `◆ ${plural(entry.pending.length, "proposal")} ${entry.pending.length === 1 ? "waits" : "wait"} for you: the Proposed tab`,
        ),
        width,
      ),
    );
  }
  const tabs = tabsOf(entry);
  out.push(
    strip(
      tabs.map((t) => ({
        text: PIPE_TABS[t] ?? "",
        styled: t === PROPOSED ? yellow(PIPE_TABS[t]) : (PIPE_TABS[t] ?? ""),
      })),
      Math.max(0, tabs.indexOf(p.tab)),
      width,
      focused,
    ).line,
  );
  return out;
}

export interface PipeBody {
  lines: string[];
  /** The line to keep in sight. */
  anchor?: number;
}

export function bodyOf(entry: PipeEntry, p: PipeState, width: number): PipeBody {
  if (p.tab === PROPOSED) return proposedBody(entry, p, width);
  return p.open ? stepBody(entry, p, width) : flowBody(entry, p, width);
}

function flowBody(entry: PipeEntry, p: PipeState, width: number): PipeBody {
  const out: string[] = [];
  let anchor = 0;
  if (entry.steps.length === 0) out.push(dim("No steps."));
  const pad = String(entry.steps.length).length;
  for (const [i, step] of entry.steps.entries()) {
    const on = i === p.step;
    if (on) anchor = out.length;
    const mark = on ? cyan("❯") : " ";
    const glyph = step.gate ? yellow("◆") : dim("●");
    const kind = step.gate ? yellow(step.kind) : dim(step.kind);
    out.push(
      fit(
        `${mark} ${dim(String(i + 1).padStart(pad))} ${glyph} ${on ? bold(step.slug) : step.slug} ${kind}`,
        width,
      ),
    );
    for (const r of step.routes) {
      const arrow = r.back ? dim("↩") : dim("→");
      const when = r.when ? dim(`  ${r.when}`) : "";
      out.push(fit(`      ${arrow} ${r.back ? r.to : dim(r.to)}${when}`, width));
    }
    if (step.routes.length === 0) out.push(dim("      ■ the end"));
  }
  return { lines: out, anchor };
}

/** A list item or an indented line starts a line of its own. */
const OWN_LINE = /^\s*([-*]|\d+\.)\s|^\s{2,}\S/;

/**
 * The lines of a prompt in a YAML file are broken where the author's editor broke them; here a
 * paragraph is one run of text again, cut to the width of the card.
 */
export function reflow(text: string, width: number): string[] {
  const out: string[] = [];
  let paragraph = "";
  const flush = () => {
    if (paragraph !== "") out.push(...wrapText(paragraph, width));
    paragraph = "";
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    } else if (OWN_LINE.test(line)) {
      flush();
      paragraph = line.trimEnd();
    } else {
      paragraph = paragraph === "" ? line.trim() : `${paragraph} ${line.trim()}`;
    }
  }
  flush();
  return out;
}

/** One step opened: what it is told or runs, its checks, and where it goes on. */
function stepBody(entry: PipeEntry, p: PipeState, width: number): PipeBody {
  const step = entry.steps[clamp(p.step, entry.steps.length - 1)];
  if (!step) return { lines: [dim("No steps.")] };
  const out: string[] = [];
  const at = entry.steps.indexOf(step) + 1;
  out.push(`${bold(step.slug)} ${dim(`· ${step.kind} · step ${at} of ${entry.steps.length}`)}`);
  out.push(dim(step.limits));
  for (const param of step.params) {
    out.push("", dim(param.key.toUpperCase()));
    out.push(...reflow(param.value, width));
  }
  if (step.checks.length > 0) {
    out.push("", dim("CHECKS"));
    for (const c of step.checks) out.push(fit(`${bold(c.kind)} ${dim(c.detail)}`, width));
  }
  out.push("", dim("THEN"));
  for (const r of step.routes) {
    out.push(`${r.back ? "↩" : "→"} ${r.to}${r.when ? dim(`  ${r.when}`) : ""}`);
  }
  if (step.routes.length === 0) out.push(dim("■ the end"));
  return { lines: out };
}

function proposedBody(entry: PipeEntry, p: PipeState, width: number): PipeBody {
  const item = pendingOf(entry, p);
  if (!item) return { lines: [dim("Nothing waits.")] };
  const out: string[] = [];
  const at = entry.pending.indexOf(item) + 1;
  const count = entry.pending.length > 1 ? dim(` · ${at} of ${entry.pending.length}`) : "";
  out.push(`${bold(item.title)}${count}`);
  for (const n of item.note) out.push(...wrapText(n, width - 1));
  if (item.problem !== undefined) {
    out.push("", ...wrapText(`It cannot be accepted: ${item.problem}`, width - 1).map(red));
  }
  const news = item.commands.filter((c) => c.isNew);
  if (news.length > 0) {
    out.push("", yellow("NEW COMMANDS IT WOULD RUN ON THIS MACHINE"));
    for (const c of news) out.push(`${dim(c.where)} ${fit(c.command, Math.max(10, width - 2))}`);
  }
  out.push("", dim("WHAT CHANGES"));
  const diff = item.diff.map((l) => {
    if (l.startsWith("@@")) return cyan(l);
    if (l.startsWith("+")) return green(l);
    if (l.startsWith("-")) return red(l);
    return dim(l);
  });
  out.push(...(diff.length > 0 ? diff : [dim("Nothing differs.")]));
  return { lines: out };
}

/** The part of the body that is in view, keeping the anchor in the middle when there is one. */
export function pipeCard(
  entry: PipeEntry,
  p: PipeState,
  width: number,
  height: number,
  focused: boolean,
): string[] {
  const head = pipeHead(entry, p, width, focused);
  const room = Math.max(1, height - head.length);
  const body = bodyOf(entry, p, width);
  const scroll =
    body.anchor !== undefined
      ? clamp(body.anchor - Math.floor(room / 2), body.lines.length - room)
      : clamp(p.scroll, body.lines.length - room);
  return [...head, ...body.lines.slice(scroll, scroll + room)].map((l) => fit(l, width));
}

export function pipeHints(entry: PipeEntry | undefined, p: PipeState, card: boolean): string {
  if (!card) {
    return `${bold("↑↓")} select   ${bold("Enter")} open   ${bold("Tab")} menu   ${bold("q")} quit`;
  }
  const tail = `   ${bold("z")} zoom   ${bold("Esc")} ${p.open ? "back" : "list"}`;
  if (p.tab === PROPOSED) {
    const item = entry ? pendingOf(entry, p) : undefined;
    const several = entry && entry.pending.length > 1 ? `   ${bold("n/p")} next/prev` : "";
    const go = item?.runId ? `   ${bold("s")} go to the run` : "";
    return `${bold("←→")} tabs   ${bold("↑↓")} scroll${several}   ${bold("a")} accept   ${bold("r")} drop${go}${tail}`;
  }
  if (p.open) return `${bold("↑↓")} scroll   ${bold("n/p")} next/prev step${tail}`;
  return `${bold("←→")} tabs   ${bold("↑↓")} step   ${bold("Enter")} open the step${tail}`;
}

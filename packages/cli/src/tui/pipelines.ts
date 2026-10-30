/** The Pipeline screen: the pipelines of a project, what waits for a person, and how each one runs. */
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

/**
 * `proposal`: a pipeline the agent proposed outside a run. `change`: a change of the pipeline of a
 * run that is going. Both wait for a person. `pipeline`: a pipeline of the project.
 */
export type PipeGroup = "proposal" | "change" | "pipeline";

export interface PipeEntry {
  id: string;
  group: PipeGroup;
  name: string;
  description?: string;
  steps: PipeStep[];
  /** Unified diff against the pipeline as it is now; a proposal and a change have one. */
  diff?: string[];
  /** Why it cannot be accepted, or why the file cannot be read. */
  problem?: string;
  /** What accepting does, in words. */
  note?: string[];
  /** The commands that accept and drop it. */
  accept?: string;
  discard?: string;
  /** Shell commands it would run on this machine; `isNew` marks the ones the pipeline has not had. */
  commands?: { where: string; command: string; isNew: boolean }[];
  /** For a change of a run: the run. */
  runId?: string;
  /** For a proposal: whether it is a new pipeline or a change of one. */
  kind?: "new" | "change";
}

export interface PipeState {
  selected: string;
  /** An index into `PIPE_TABS`. */
  tab: number;
  /** The step the Flow and the Prompt are on. */
  step: number;
  /** The run the Runs tab is on. */
  run: number;
  scroll: number;
}

export const PIPE_TABS = ["Flow", "Prompt", "Runs", "Diff"] as const;
const FLOW = 0;
const PROMPT = 1;
const RUNS = 2;
const DIFF = 3;

export function initialPipeState(entries: PipeEntry[]): PipeState {
  return { selected: entries[0]?.id ?? "", tab: FLOW, step: 0, run: 0, scroll: 0 };
}

const GROUP_ORDER: Record<PipeGroup, number> = { change: 0, proposal: 1, pipeline: 2 };

export function sortEntries(entries: PipeEntry[]): PipeEntry[] {
  return [...entries].sort(
    (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.name.localeCompare(b.name),
  );
}

/** How many entries wait for a person. */
export function waitingEntries(entries: PipeEntry[]): number {
  return entries.filter((e) => e.group !== "pipeline").length;
}

/** The new list keeps the selection when the entry is still there. */
export function withEntries(p: PipeState, entries: PipeEntry[]): PipeState {
  return entries.some((e) => e.id === p.selected) ? p : { ...initialPipeState(entries), tab: FLOW };
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
  sessions: Session[];
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

export function runsOf(entry: PipeEntry | undefined, sessions: Session[]): Session[] {
  if (!entry) return [];
  if (entry.group === "change") return sessions.filter((s) => s.id === entry.runId);
  if (entry.group === "proposal") {
    return entry.kind === "change" ? sessions.filter((s) => s.pipeline === entry.name) : [];
  }
  return sessions.filter((s) => s.pipeline === entry.name);
}

export function tabsOf(entry: PipeEntry | undefined): number[] {
  return entry?.diff ? [FLOW, PROMPT, RUNS, DIFF] : [FLOW, PROMPT, RUNS];
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, max), Math.max(0, n));
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
      return next
        ? { p: { ...p, selected: next.id, tab: FLOW, step: 0, run: 0, scroll: 0 } }
        : { p };
    }
    if ((key === "enter" || key === "right") && entry) return { p, focus: "card" };
    return undefined;
  }
  if (!entry) return { p, focus: "list" };
  const tabs = tabsOf(entry);
  const at = Math.max(0, tabs.indexOf(p.tab));
  const switchTo = (tab: number): PipeResult => ({ p: { ...p, tab, scroll: 0 } });
  switch (key) {
    case "escape":
      return { p, focus: "list" };
    case "left":
      return at === 0 ? { p, focus: "list" } : switchTo(tabs[at - 1] ?? FLOW);
    case "right":
      return switchTo(tabs[Math.min(tabs.length - 1, at + 1)] ?? FLOW);
    case "s": {
      const run = runsOf(entry, v.sessions)[0];
      return run ? { p, open: run.id } : { p, notice: "No run to show." };
    }
    case "a":
    case "r": {
      if (entry.group === "pipeline") return undefined;
      const command = key === "a" ? entry.accept : entry.discard;
      const what = key === "a" ? "accept" : "drop";
      if (v.source === "demo") return { p, notice: `Sample data: nothing to ${what}.` };
      return { p, notice: `To ${what} it, in a terminal: ${command ?? "see the card"}` };
    }
    default:
  }
  const body = bodyOf(entry, p, v.sessions, v.width).lines.length;
  const scrolling = p.tab === PROMPT || p.tab === DIFF;
  const page = Math.max(1, v.room - 1);
  const moveScroll = (by: number): PipeResult => ({
    p: { ...p, scroll: clamp(p.scroll + by, body - v.room) },
  });
  if (key === "pagedown" || key === " ") return moveScroll(page);
  if (key === "pageup" || key === "b") return moveScroll(-page);
  if (p.tab === PROMPT && (key === "n" || key === "p")) {
    const step = clamp(p.step + (key === "n" ? 1 : -1), entry.steps.length - 1);
    return { p: { ...p, step, scroll: 0 } };
  }
  if (p.tab === FLOW) {
    if (up || down) {
      return { p: { ...p, step: clamp(p.step + (down ? 1 : -1), entry.steps.length - 1) } };
    }
    if (key === "enter" && entry.steps.length > 0) return switchTo(PROMPT);
  }
  if (p.tab === RUNS) {
    const runs = runsOf(entry, v.sessions);
    if (up || down) return { p: { ...p, run: clamp(p.run + (down ? 1 : -1), runs.length - 1) } };
    const run = runs[clamp(p.run, runs.length - 1)];
    if (key === "enter" && run) return { p, open: run.id };
  }
  if (scrolling && (up || down)) return moveScroll(down ? 1 : -1);
  return undefined;
}

// ── drawing ─────────────────────────────────────────────────────────────────

const SESSION_MARK: Record<Session["status"], string> = {
  waiting: yellow("◆"),
  running: green("●"),
  failed: red("✗"),
  done: dim("✓"),
  canceled: dim("–"),
  unreadable: red("?"),
};

const GROUP_TITLE: Record<PipeGroup, string> = {
  change: "WAITING FOR YOU · CHANGES OF A RUN",
  proposal: "WAITING FOR YOU · PROPOSED",
  pipeline: "PIPELINES",
};

function tagOf(e: PipeEntry): string {
  if (e.group === "change") return "run change";
  if (e.group === "proposal") return e.kind === "new" ? "new" : "change";
  return "";
}

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
  let group: PipeGroup | undefined;
  const selected = entryOf(entries, p)?.id;
  for (const e of entries) {
    if (e.group !== group) {
      if (group !== undefined) lines.push("");
      lines.push(dim(GROUP_TITLE[e.group]));
      group = e.group;
    }
    const on = e.id === selected;
    if (on) selectedAt = lines.length;
    const mark = on ? (focused ? cyan("▸") : bold("▸")) : " ";
    const tag = tagOf(e);
    const right = e.group === "pipeline" ? runCounts(e, sessions) : yellow(tag);
    const head = `${mark} ${on ? bold(e.name) : e.name}`;
    const gap = Math.max(1, width - stripAnsi(head).length - stripAnsi(right).length - 1);
    lines.push(fit(`${head}${" ".repeat(gap)}${right}`, width));
    const note = e.problem !== undefined ? red(oneLine(e.problem, width)) : dim(summaryOf(e));
    const about =
      e.group === "pipeline" && e.description ? dim(` · ${oneLine(e.description)}`) : "";
    lines.push(fit(`  ${e.problem !== undefined ? note : `${note}${about}`}`, width));
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

/** The head of the card: what the entry is, what is wrong with it, and the tabs. */
export function pipeHead(
  entry: PipeEntry,
  p: PipeState,
  width: number,
  focused: boolean,
): string[] {
  const out: string[] = [];
  const tag = tagOf(entry);
  out.push(fit(`${bold(entry.name)}${tag ? ` ${yellow(`· ${tag}`)}` : ""}`, width));
  if (entry.description) {
    const lines = wrapText(entry.description, Math.max(10, width - 1));
    for (const l of lines.slice(0, 3)) out.push(dim(l));
    if (lines.length > 3) out.push(dim("…"));
  }
  if (entry.problem !== undefined) {
    for (const l of wrapText(entry.problem, width - 2)) out.push(red(l));
  }
  const tabs = tabsOf(entry);
  out.push(
    strip(
      tabs.map((t) => ({ text: PIPE_TABS[t] ?? "", styled: PIPE_TABS[t] ?? "" })),
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

export function bodyOf(
  entry: PipeEntry,
  p: PipeState,
  sessions: Session[],
  width: number,
): PipeBody {
  if (p.tab === PROMPT) return promptBody(entry, p, width);
  if (p.tab === RUNS) return runsBody(entry, p, sessions, width);
  if (p.tab === DIFF) return diffBody(entry);
  return flowBody(entry, p, width);
}

function flowBody(entry: PipeEntry, p: PipeState, width: number): PipeBody {
  const out: string[] = [];
  let anchor = 0;
  if (entry.note && entry.note.length > 0) {
    for (const n of entry.note) for (const l of wrapText(n, width - 2)) out.push(l);
    out.push("");
  }
  const news = (entry.commands ?? []).filter((c) => c.isNew);
  if (news.length > 0) {
    out.push(yellow("NEW COMMANDS IT WOULD RUN ON THIS MACHINE"));
    for (const c of news) out.push(`${dim(c.where)} ${fit(c.command, Math.max(10, width - 2))}`);
    out.push("");
  }
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

function promptBody(entry: PipeEntry, p: PipeState, width: number): PipeBody {
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
    for (const c of step.checks) {
      out.push(fit(`${bold(c.kind)} ${dim(c.detail)}`, width));
    }
  }
  return { lines: out };
}

function runsBody(entry: PipeEntry, p: PipeState, sessions: Session[], width: number): PipeBody {
  const runs = runsOf(entry, sessions);
  if (runs.length === 0) {
    return {
      lines: [
        dim(entry.group === "proposal" ? "Nothing runs it until it is accepted." : "No runs yet."),
      ],
    };
  }
  const at = clamp(p.run, runs.length - 1);
  const lines = runs.map((s, i) => {
    const mark = i === at ? cyan("❯") : " ";
    const title = i === at ? bold(s.title) : s.title;
    return fit(`${mark} ${SESSION_MARK[s.status]} ${title}  ${dim(s.step)}`, width);
  });
  return { lines, anchor: at };
}

function diffBody(entry: PipeEntry): PipeBody {
  const lines = (entry.diff ?? []).map((l) => {
    if (l.startsWith("@@")) return cyan(l);
    if (l.startsWith("+")) return green(l);
    if (l.startsWith("-")) return red(l);
    return dim(l);
  });
  return { lines: lines.length > 0 ? lines : [dim("Nothing differs.")] };
}

/** The part of the body that is in view, keeping the anchor in the middle when there is one. */
export function pipeCard(
  entry: PipeEntry,
  p: PipeState,
  sessions: Session[],
  width: number,
  height: number,
  focused: boolean,
): string[] {
  const head = pipeHead(entry, p, width, focused);
  const room = Math.max(1, height - head.length);
  const body = bodyOf(entry, p, sessions, width);
  const scroll =
    body.anchor !== undefined
      ? clamp(body.anchor - Math.floor(room / 2), body.lines.length - room)
      : clamp(p.scroll, body.lines.length - room);
  return [...head, ...body.lines.slice(scroll, scroll + room)].map((l) => fit(l, width));
}

export function pipeHints(entry: PipeEntry | undefined, p: PipeState, card: boolean): string {
  const decide =
    entry && entry.group !== "pipeline" ? `   ${bold("a")} accept   ${bold("r")} drop` : "";
  const go = entry?.group === "change" ? `   ${bold("s")} go to the run` : "";
  if (!card) {
    return `${bold("↑↓")} select   ${bold("Enter")} open${decide}${go}   ${bold("Tab")} menu   ${bold("q")} quit`;
  }
  const keys: Record<number, string> = {
    [FLOW]: `${bold("↑↓")} step   ${bold("Enter")} its prompt`,
    [PROMPT]: `${bold("↑↓")} scroll   ${bold("n/p")} next/prev step`,
    [RUNS]: `${bold("↑↓")} select   ${bold("Enter")} open the run`,
    [DIFF]: `${bold("↑↓")} scroll`,
  };
  return `${bold("←→")} tabs   ${keys[p.tab] ?? ""}${decide}${go}   ${bold("z")} zoom   ${bold("Esc")} list`;
}

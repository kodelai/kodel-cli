/** The card of a run waiting at a human step: the band on top, the tabs, and what each tab shows, as lines of text. */
import { DIGEST_LINES } from "../claude-stream";
import {
  bold,
  cyan,
  dim,
  fit,
  green,
  inverse,
  magenta,
  red,
  stripAnsi,
  visibleLength,
  wrapText,
  yellow,
} from "./ansi";
import { firstCode, prepare, viewDiff } from "./diffview";
import { sessionLine } from "./label";
import { capLines, headOf, parseBlocking, parseCommentsCsv } from "./reasons";
import {
  type Attempt,
  type DiffState,
  type Finding,
  formatAge,
  type GateDetail,
  type LogEntry,
  type Session,
  type Visit,
} from "./session";

/** In the order a person reads a gate: the agent's words first, the way it went last. */
export const TABS = ["Report", "Code", "Steps", "Comments", "Log"] as const;
export const REPORT = 0;
export const CODE = 1;
export const STEPS = 2;
export const COMMENTS = 3;
export const LOG = 4;

/** What an opened step shows. */
export const SUBTABS = ["Result", "Changes", "Log"] as const;

/** Where in the tabs the person is: which tab, which line of its list, and whether that line is open. */
export interface TabState {
  tab: number;
  cursor: number;
  open: boolean;
  /** Which part of an opened step. */
  sub: number;
  /** The row of the diff the cursor is on; -1 until the diff has been read. */
  line: number;
}

/**
 * The tabs a card has, in the order they are shown. A run at a gate has the whole set; a run that is
 * going on has nothing to read as a report and nothing to comment on, so it has three.
 */
export function visibleTabs(d: GateDetail): number[] {
  return tabsOf(d.kind);
}

/** The same set, for a card that is not read yet: its kind is known from the list row. */
export function tabsOf(kind: GateDetail["kind"]): number[] {
  return kind === "running" ? [STEPS, CODE, LOG] : [REPORT, CODE, STEPS, COMMENTS, LOG];
}

/** The tabs that are a list of things to select. */
export function isListTab(tab: number): boolean {
  return tab === CODE || tab === STEPS || tab === COMMENTS;
}

export function itemCount(d: GateDetail, tab: number): number {
  if (tab === CODE) return d.changes.kind === "files" ? d.changes.files.length : 0;
  if (tab === STEPS) return d.visits.length;
  if (tab === COMMENTS) return d.comments.length;
  return 0;
}

export interface Context {
  now: number;
  width: number;
  /** The card has the keys; a selected line then stands out more. */
  focused: boolean;
  /** The diffs read so far, by `diffKey`. */
  diffs: Record<string, DiffState>;
  runId: string;
  /** The instructions written for the agent are shown. */
  instructions: boolean;
  /** The background agent of the run, when the TUI started one: its name and the digest of its stream. */
  worker?: WorkerLog;
  /** What the keys do at this gate, as the Report tab says it (`a Approve · r Reject`, or the command). */
  decide?: string;
}

/** The part of a run's background agent the tabs read (`worker-launcher.ts`): its record's name and the digest. */
export interface WorkerLog {
  name: string;
  resumes: number;
  lines: string[];
}

export interface Content {
  lines: string[];
  /** The line the person is on, so the view can keep it in sight. */
  anchor?: number;
}

export const diffKey = (runId: string, path: string): string => `${runId}:${path}`;

/** The file the cursor is on in the Code tab. */
export function fileAt(d: GateDetail, cursor: number): string | undefined {
  return d.changes.kind === "files" ? d.changes.files[cursor]?.[0] : undefined;
}

/** Where the cursor of a tab starts: at the latest step for a run that is going on, else at the top. */
export function startCursor(d: GateDetail, tab: number): number {
  if (d.kind !== "running" || tab !== STEPS) return 0;
  const entered = d.visits.findLastIndex((v) => v.attempt.n > 0);
  return Math.max(0, entered);
}

/** Where a comment made now is about: the file or the step the person is looking at, else the gate. */
export function commentPlace(d: GateDetail, st: TabState): string {
  if (st.tab === CODE) return fileAt(d, st.cursor) ?? d.node;
  if (st.tab === STEPS) return d.visits[st.cursor]?.slug ?? d.node;
  return d.node;
}

// ── small helpers ───────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  critical: 1,
  major: 2,
  minor: 3,
  info: 4,
};

function severityStyle(severity: string, text: string): string {
  const rank = SEVERITY_RANK[severity] ?? 4;
  return rank <= 2 ? red(text) : rank === 3 ? yellow(text) : dim(text);
}

/** The end of a path is the part that tells files apart. */
export function tailFit(text: string, width: number): string {
  if (text.length <= width) return text;
  return `…${text.slice(text.length - width + 1)}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // 59.96 s would print as 60.0 s; from here on it is told in minutes.
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds >= 3600) return formatAge(seconds * 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}`;
}

function thousands(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const MARK = {
  ok: green("✓"),
  bad: red("✗"),
  open: yellow("◐"),
  run: cyan("●"),
  pending: dim("○"),
};

function visitMark(v: Visit): string {
  if (v.state === "done") return MARK.ok;
  if (v.state === "failed") return MARK.bad;
  if (v.state === "waiting") return MARK.open;
  if (v.state === "running") return MARK.run;
  return MARK.pending;
}

/** Tokens laid out in lines no wider than `width`, joined by `glue`. */
function flow(tokens: { text: string; plain: number }[], glue: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const t of tokens) {
    if (used > 0 && used + glue.length + t.plain > width) {
      lines.push(line);
      line = t.text;
      used = t.plain;
    } else {
      line += used === 0 ? t.text : dim(glue) + t.text;
      used += used === 0 ? t.plain : glue.length + t.plain;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

const chip = (text: string, styled = text) => ({ text: styled, plain: visibleLength(text) });

function row(text: string, selected: boolean, focused: boolean, width: number): string {
  const plain = fit(text, width);
  if (!selected) return plain;
  return focused ? inverse(stripAnsi(plain)) : bold(plain);
}

/** Text as people write it: paragraphs and lists wrapped, headings bold, code left as it is. */
export function prose(text: string, width: number): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "").replaceAll("**", "");
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      out.push(dim(fit(line, width)));
    } else if (fenced) {
      out.push(dim(fit(line, width)));
    } else if (line === "") {
      out.push("");
    } else {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        for (const l of wrapText(heading[1] ?? "", width)) out.push(bold(l));
        continue;
      }
      const lead = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1] ?? /^(\s*)/.exec(line)?.[1] ?? "";
      const wrapped = wrapText(line.slice(lead.length), Math.max(10, width - lead.length));
      for (const [i, l] of wrapped.entries())
        out.push((i === 0 ? lead : " ".repeat(lead.length)) + l);
    }
  }
  return out.map((l) => fit(l, width));
}

// ── the band on top ─────────────────────────────────────────────────────────

/** The run's name and where it stands, in a frame of its own, with the numbers that sum it up. */
export function headerBand(
  s: Session,
  d: GateDetail,
  width: number,
  glyph: string,
  now: number,
  compact = false,
): string[] {
  const m = d.metrics;
  const bar = (done: number, total: number) => {
    const cells = 8;
    const filled = total === 0 ? 0 : Math.round((cells * done) / total);
    return "▮".repeat(filled) + "▯".repeat(cells - filled);
  };
  const chips = [
    chip(`⏱ ${formatAge(m.workMs)} work · ${formatAge(m.waitMs)} waiting`),
    chip(`${bar(m.stepsDone, m.stepsTotal)} ${m.stepsDone}/${m.stepsTotal} steps`),
    ...(m.retries > 0 ? [chip(`⟳ ${m.retries} ${m.retries === 1 ? "retry" : "retries"}`)] : []),
    m.checksPassed === m.checksTotal
      ? chip(
          `✓ ${m.checksPassed}/${m.checksTotal} checks`,
          `${green("✓")} ${m.checksPassed}/${m.checksTotal} checks`,
        )
      : chip(
          `✗ ${m.checksPassed}/${m.checksTotal} checks`,
          red(`✗ ${m.checksPassed}/${m.checksTotal} checks`),
        ),
    d.changes.kind === "files"
      ? chip(`± ${d.changes.totalFiles} files · ${d.changes.totalLines} lines`)
      : chip("± no changes", dim("± no changes")),
    m.tokens
      ? chip(
          `⛁ ${m.tokens.approx ? "~" : ""}${thousands(m.tokens.total)} tokens${m.tokens.cost === undefined ? "" : ` · $${m.tokens.cost.toFixed(2)}`}`,
        )
      : chip("⛁ —", dim("⛁ —")),
  ];
  const warnings = [
    ...(d.changedAfterChecks.length > 0
      ? [
          chip(
            `⚠ ${d.changedAfterChecks.length} files changed after the checks`,
            yellow(`⚠ ${d.changedAfterChecks.length} files changed after the checks`),
          ),
        ]
      : []),
    ...(d.changes.kind === "unavailable"
      ? [chip("⚠ changes unknown", yellow("⚠ changes unknown"))]
      : []),
  ];
  const where =
    d.kind === "running"
      ? whereRunning(s, d.node, d.position, now)
      : `${bold(yellow(`${d.position} · ${d.node}`))} ${dim(`· waiting ${formatAge(now - s.since)}`)}`;
  return band(s, width, glyph, where, [...chips, ...warnings], compact);
}

function whereRunning(s: Session, node: string, position: string, now: number): string {
  return `${bold(cyan(`running · ${node}`))} ${dim(`· ${position} · for ${formatAge(now - s.since)}`)}${
    s.activity === "quiet" ? yellow(`  quiet ${formatAge(s.quietMs ?? 0)}`) : ""
  }`;
}

/**
 * The band of a card that is not read yet, in the same lines as `headerBand`: what the list row knows
 * (name, id, pipeline, session, the step, how long), and a placeholder for every figure the card brings.
 * The placeholders are about as wide as the usual figures, so the numbers flow over the same lines and
 * the tabs below do not move when the card lands.
 */
export function skeletonBand(
  s: Session,
  kind: GateDetail["kind"],
  node: string | undefined,
  width: number,
  glyph: string,
  now: number,
  compact = false,
): string[] {
  const gap = dim("…");
  const at = node === undefined ? gap : node;
  const where =
    kind === "running"
      ? whereRunning(s, at, `step ${gap}`, now)
      : `${bold(yellow(`gate ${gap} · ${at}`))} ${dim(`· waiting ${formatAge(now - s.since)}`)}`;
  const faint = (text: string) => chip(text, dim(text));
  const chips = [
    faint("⏱ … work · … waiting"),
    faint(`${"▯".repeat(8)} … steps`),
    faint("…/… checks"),
    faint("± … files · … lines"),
    faint("⛁ … tokens"),
  ];
  return band(s, width, glyph, where, chips, compact);
}

/** The frame of the band: the name line, the session, where the run stands, and the numbers flowed below. */
function band(
  s: Session,
  width: number,
  glyph: string,
  where: string,
  chips: { text: string; plain: number }[],
  compact: boolean,
): string[] {
  const inner = Math.max(10, width - 4);
  const line = (content: string) => `${dim("│")} ${fit(content, inner)} ${dim("│")}`;
  const agent = s.agentSession;
  // Below 22 rows there is no room for a line of its own: the session stands where the id and pipeline did.
  const right = dim(
    compact && agent
      ? sessionLine(agent, Math.max(16, Math.floor(inner / 2)))
      : `${s.id} · ${s.pipeline}`,
  );
  const left = `${glyph} ${bold(fit(s.title, Math.max(8, inner - visibleLength(right) - 3)).trimEnd())}`;
  const gap = Math.max(1, inner - visibleLength(left) - visibleLength(right));
  if (compact) {
    // Little room: no frame, and the numbers on one line, cut where they stop fitting.
    const all = flow(chips, "  ", inner)[0] ?? "";
    return [fit(`${left}${" ".repeat(gap)}${right}`, width), fit(where, width), fit(all, width)];
  }
  return [
    dim(`╭${"─".repeat(width - 2)}╮`),
    line(`${left}${" ".repeat(gap)}${right}`),
    ...(agent ? [line(dim(sessionLine(agent, inner)))] : []),
    line(where),
    ...flow(chips, "  ", inner).map(line),
    dim(`╰${"─".repeat(width - 2)}╯`),
  ];
}

// ── the tabs ────────────────────────────────────────────────────────────────

function tabText(d: GateDetail, i: number): { text: string; styled: string } {
  const name = TABS[i] ?? "";
  const both = (text: string, styled = text) => ({ text, styled });
  if (i === CODE) {
    const n = d.changes.kind === "files" ? d.changes.totalFiles : 0;
    const warn = d.changedAfterChecks.length > 0 || d.changes.kind === "unavailable";
    return both(`${name} ${n}${warn ? " ⚠" : ""}`, `${name} ${n}${warn ? ` ${yellow("⚠")}` : ""}`);
  }
  if (i === STEPS) {
    const broken = d.visits.some(
      (v) => v.state === "failed" && v === d.visits.findLast((x) => x.slug === v.slug),
    );
    return both(
      `${name} ${d.visits.length}${broken ? " ✗" : ""}`,
      `${name} ${d.visits.length}${broken ? ` ${red("✗")}` : ""}`,
    );
  }
  if (i === COMMENTS) return both(`${name} ${d.comments.length}`);
  if (i === LOG) return both(`${name} ${d.agentLog?.length ?? d.journal.length}`);
  return both(name);
}

/** A row of names; the active one stands out. Spans are where each name is (columns from 0), for a click. */
export function strip(
  names: { text: string; styled: string }[],
  active: number,
  width: number,
  focused: boolean,
): { line: string; spans: [number, number][] } {
  let line = "";
  let at = 0;
  const spans: [number, number][] = [];
  for (const [i, { text, styled }] of names.entries()) {
    const cell = ` ${text} `;
    spans.push([at, at + cell.length]);
    at += cell.length;
    if (i === active)
      line += focused ? inverse(stripAnsi(cell)) : bold(`[${text}]`.padEnd(cell.length));
    else line += dim(" ") + styled + dim(" ");
  }
  return { line: fit(line, width), spans };
}

export function tabStrip(d: GateDetail, active: number, width: number, focused: boolean) {
  const tabs = visibleTabs(d);
  return strip(
    tabs.map((id) => tabText(d, id)),
    Math.max(0, tabs.indexOf(active)),
    width,
    focused,
  );
}

/** The tab row of a card that is not read yet: the names in their places, a placeholder for each count. */
export function skeletonStrip(
  kind: GateDetail["kind"],
  active: number,
  width: number,
  focused: boolean,
) {
  const tabs = tabsOf(kind);
  return strip(
    tabs.map((id) => {
      const name = TABS[id] ?? "";
      return id === REPORT
        ? { text: name, styled: name }
        : { text: `${name} …`, styled: `${name} ${dim("…")}` };
    }),
    Math.max(0, tabs.indexOf(active)),
    width,
    focused,
  );
}

function subStrip(active: number, width: number, focused: boolean) {
  return strip(
    SUBTABS.map((name) => ({ text: name, styled: name })),
    active,
    width,
    focused,
  );
}

// ── what each tab shows ─────────────────────────────────────────────────────

/** How much of the agent's answer the Report tab shows before it points at the log. */
const ANSWER_LINES = 60;
const ANSWER_CHARS = 6000;
/** How many changed files the Report tab lists before it points at the Code tab. */
const CHANGED_ROWS = 12;

/** The agent's last answer and where it comes from: its own log, a step's summary, or the digest of its stream. */
function answerOf(d: GateDetail, ctx: Context): { text: string; where: string } | undefined {
  if (d.report !== undefined) {
    const where =
      d.report.from === "log"
        ? `written ${formatAge(ctx.now - d.report.ts)} ago`
        : `from step «${d.report.step ?? "?"}»`;
    return { text: d.report.text, where };
  }
  // The digest keeps the agent's texts as `> …` lines; the last one is what it said before it exited.
  const said = ctx.worker?.lines.findLast((l) => l.startsWith("> "));
  if (said === undefined) return undefined;
  return { text: said.slice(2), where: `its last words · kodel agent logs ${ctx.worker?.name}` };
}

/**
 * What a person reads at a gate, in the order they decide: the agent's answer, what changed, then the
 * question and the keys. The agent's log (its tool calls) is not here: it is under Log, and above the
 * tabs only while the run is going on.
 */
function report(d: GateDetail, ctx: Context): Content {
  const { width } = ctx;
  const out: string[] = [];
  const answer = answerOf(d, ctx);
  if (answer !== undefined) {
    out.push(dim(`THE AGENT'S ANSWER · ${answer.where}`));
    const text =
      answer.text.length > ANSWER_CHARS ? `${answer.text.slice(0, ANSWER_CHARS)}…` : answer.text;
    out.push(
      ...capLines(prose(text, width), ANSWER_LINES, (left) =>
        dim(`… ${left} more line${left === 1 ? "" : "s"}: see Log`),
      ),
    );
    out.push("");
  }
  out.push(...changedFiles(d, width), "");
  out.push(dim("YOUR DECISION"));
  for (const [i, l] of wrapText(d.prompt, Math.max(10, width - 2)).entries()) {
    out.push(i === 0 ? `${cyan("❯")} ${bold(l)}` : `  ${bold(l)}`);
  }
  // What the pipeline's author wrote for the agent to turn into its message; the person needs it
  // only when they want to see what the agent was told.
  if (ctx.instructions && d.instructions) {
    out.push(dim("INSTRUCTIONS THE AGENT WAS GIVEN FOR ITS MESSAGE"));
    for (const l of wrapText(d.instructions, width)) out.push(dim(l));
    out.push("");
  }
  if (ctx.decide !== undefined) out.push(ctx.decide);
  return { lines: out.map((l) => fit(l, width)) };
}

/** The files the run changed, with their line counts, as the Code tab counts them; the first few here. */
function changedFiles(d: GateDetail, width: number): string[] {
  const c = d.changes;
  if (c.kind === "none") return [dim("CHANGED FILES"), "No files changed."];
  if (c.kind === "no_repo") return [dim("CHANGED FILES"), dim("This is not a git repository.")];
  if (c.kind === "unavailable") {
    return [
      dim("CHANGED FILES"),
      ...wrapText(`Cannot tell what changed: ${c.reason}`, width).map(yellow),
    ];
  }
  const out = [
    dim(
      `CHANGED FILES · ${c.totalFiles} file${c.totalFiles === 1 ? "" : "s"} · ${c.totalLines} lines`,
    ),
  ];
  for (const [file, lines] of c.files.slice(0, CHANGED_ROWS)) {
    out.push(`  ${fit(tailFit(file, width - 10), width - 10)}${String(lines).padStart(6)}`);
  }
  if (c.files.length > CHANGED_ROWS) {
    out.push(dim(`  … ${c.files.length - CHANGED_ROWS} more under Code`));
  }
  out.push(dim("  The Code tab opens each diff."));
  return out;
}

function commentCount(d: GateDetail, path: string): number {
  return d.comments.filter((c) => c.location === path || c.location.startsWith(`${path}:`)).length;
}

function code(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  const c = d.changes;
  if (c.kind === "none") return { lines: ["No files changed."] };
  if (c.kind === "no_repo") return { lines: [dim("This is not a git repository.")] };
  if (c.kind === "unavailable") {
    return { lines: wrapText(`Cannot tell what changed: ${c.reason}`, width).map(yellow) };
  }
  if (st.open) {
    const [file, lines] = c.files[st.cursor] ?? ["", 0];
    const out: string[] = [`${dim("Code ›")} ${bold(tailFit(file, width - 8))}`];
    const n = commentCount(d, file);
    out.push(
      dim(
        `${lines} lines changed since the run began${n > 0 ? ` · ${n} comment${n === 1 ? "" : "s"}` : ""}`,
      ),
    );
    out.push("");
    const diff = ctx.diffs[diffKey(ctx.runId, file)];
    if (diff === undefined) out.push(dim("Reading the diff…"));
    else if (diff.kind === "missing")
      out.push(dim("No diff to show: the files were not recorded when the run began."));
    else if (diff.kind === "error")
      out.push(...wrapText(`Cannot read the diff: ${diff.message}`, width).map(red));
    else {
      const p = prepare(diff, diff.text, file);
      const cursor = st.line >= 0 ? st.line : firstCode(p);
      const seen = viewDiff(p, {
        width,
        cursor,
        focused: ctx.focused,
        path: file,
        comments: d.comments,
      });
      const head = out.length;
      out.push(...seen.lines);
      if (diff.truncated)
        out.push(yellow("… the diff is cut here, it is longer than can be shown"));
      return { lines: out.map((l) => fit(l, width)), anchor: head + seen.anchor };
    }
    return { lines: out.map((l) => fit(l, width)) };
  }
  const out: string[] = [
    dim(
      `${c.totalFiles} file${c.totalFiles === 1 ? "" : "s"} · ${c.totalLines} lines · Enter opens a file`,
    ),
  ];
  if (d.changedAfterChecks.length > 0) {
    const n = d.changedAfterChecks.length;
    out.push(yellow(`⚠ ${n} file${n === 1 ? "" : "s"} changed after the checks passed:`));
    for (const f of d.changedAfterChecks.slice(0, 5))
      out.push(yellow(`  ${tailFit(f, width - 2)}`));
  }
  const first = out.length;
  for (const [i, [file, lines]] of c.files.entries()) {
    const notes = commentCount(d, file);
    const mark = notes > 0 ? ` ✎${notes}` : "";
    const text = `${i === st.cursor ? "▸" : " "} ${fit(tailFit(file, width - 14), width - 14)}${String(lines).padStart(5)}${mark.padEnd(5)}`;
    out.push(row(text, i === st.cursor, ctx.focused, width));
  }
  return { lines: out, anchor: first + st.cursor };
}

function visitNote(v: Visit): string {
  const a = v.attempt;
  const parts: string[] = [];
  if (a.ok === false) parts.push(a.reason ? headOf(a.reason) : (a.outcome ?? "failed"));
  if (a.decision) parts.push(a.decision.decision);
  if (a.review) {
    const n = a.review.findings.length;
    parts.push(`${n} ${v.human ? "comment" : "finding"}${n === 1 ? "" : "s"}`);
  }
  if (v.state === "waiting") parts.push("waiting for you");
  // A rejection is both the outcome of the step and the person's decision.
  return [...new Set(parts)].join(" · ");
}

function steps(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  if (st.open) return openVisit(d, st, ctx);
  const out: string[] = [dim(`${d.visits.length} entries into steps · Enter opens one`)];
  const first = out.length;
  for (const [i, v] of d.visits.entries()) {
    const time = v.attempt.ms !== undefined ? duration(v.attempt.ms) : "";
    const name = `${v.rework ? "↺ " : "  "}${v.slug}${v.attempt.n > 1 ? ` #${v.attempt.n}` : ""}`;
    const text = `${i === st.cursor ? "▸" : " "} ${visitMark(v)} ${fit(name, 20)} ${fit(v.kind, 7)} ${time.padStart(6)}  ${visitNote(v)}`;
    out.push(row(text, i === st.cursor, ctx.focused, width));
  }
  return { lines: out, anchor: first + st.cursor };
}

/** A finding: how serious, where, and what; the place wraps, since it can be a sentence. */
function findingLines(f: Finding, width: number): string[] {
  const place = wrapText(f.location, Math.max(10, width - 12));
  const out = place.map(
    (l, i) => `  ${i === 0 ? severityStyle(f.severity, fit(f.severity, 9)) : " ".repeat(9)}${l}`,
  );
  if (out.length === 0) out.push(`  ${severityStyle(f.severity, f.severity)}`);
  for (const line of wrapText(f.description, width - 4)) out.push(`    ${dim(line)}`);
  return out;
}

function findingsBlock(label: string, findings: Finding[], width: number): string[] {
  const rows = [...findings].sort(
    (x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9),
  );
  const counts = new Map<string, number>();
  for (const f of rows) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([sev, n]) => severityStyle(sev, `${n} ${sev}`))
    .join(dim(" · "));
  return [
    "",
    `${dim(label)} ${rows.length === 0 ? green("none") : summary}`,
    ...rows.flatMap((f) => findingLines(f, width)),
  ];
}

/** Why a try failed: the findings a result check found, laid out; anything else as it was written, cut if very long. */
function reasonLines(reason: string | undefined, width: number): string[] {
  if (!reason) return [];
  const blocking = parseBlocking(reason);
  if (blocking) {
    const cut = blocking.cut ? [`  ${dim("… and more, which the engine cut off")}`] : [];
    return [
      `  ${red(blocking.head)}`,
      ...[...blocking.findings]
        .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9))
        .flatMap((f) => findingLines(f, width)),
      ...cut,
    ];
  }
  // The lines of a command's output stay lines: only a line too long for the screen is wrapped.
  const lines = reason
    .split("\n")
    .flatMap((l) => (l.trim() === "" ? [""] : wrapText(l, width - 2)))
    .map((l) => `  ${red(l)}`);
  return capLines(lines, 12, (n) => dim(`  … ${n} more lines`));
}

/** What the person decided and wrote; the comments that went with it are told separately. */
function decisionLines(d: NonNullable<Attempt["decision"]>, said: string, width: number): string[] {
  const out = ["", `You: ${d.decision}`];
  if (said) out.push(...prose(said, width - 2).map((l) => `  ${l}`));
  return out;
}

const sameRows = (a: Finding[], b: Finding[]): boolean => {
  const key = (f: Finding) => `${f.severity}\u0000${f.location}\u0000${f.description}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
};

/**
 * The comments at a human step reach the screen from two places that say the same thing: the report
 * the step wrote, and the copy a rejection carries to the agent. One block when they agree, and
 * both, told apart, when they do not.
 */
function commentBlocks(a: Attempt, sent: Finding[], width: number): string[] {
  const recorded = a.review?.findings ?? [];
  if (sent.length > 0 && sameRows(sent, recorded)) {
    return findingsBlock("Comments you made:", sent, width);
  }
  return [
    ...(sent.length > 0
      ? findingsBlock("Comments sent back with the rejection:", sent, width)
      : []),
    ...(a.review
      ? findingsBlock(`Comments recorded at this step (${a.review.completeness}):`, recorded, width)
      : []),
  ];
}

function attemptResult(a: Attempt, width: number, human: boolean): string[] {
  const out: string[] = [];
  const mark = a.ok === true ? MARK.ok : a.ok === false ? MARK.bad : MARK.open;
  const bits = [a.outcome ?? "in progress"];
  if (a.ms !== undefined) bits.push(duration(a.ms));
  if (a.exit !== undefined) bits.push(`exit ${a.exit}`);
  out.push(`${mark} ${bits.join(" · ")}`);
  out.push(...reasonLines(a.reason, width));
  for (const c of a.checks) {
    out.push(
      `  ${c.passed ? MARK.ok : MARK.bad} ${c.label}${c.ms === undefined ? "" : dim(` ${duration(c.ms)}`)}`,
    );
  }
  if (a.summary) {
    out.push("", dim("The agent says (not verified):"));
    out.push(...prose(a.summary, width));
  }
  const csv = a.decision?.reason ? parseCommentsCsv(a.decision.reason) : undefined;
  if (a.decision) {
    const said = csv ? csv.text : (a.decision.reason ?? "");
    out.push(...decisionLines(a.decision, said, width));
  }
  if (human) {
    out.push(...commentBlocks(a, csv?.rows ?? [], width));
  } else if (a.review) {
    out.push(
      ...findingsBlock(
        `Findings (the agent's, ${a.review.completeness}):`,
        a.review.findings,
        width,
      ),
    );
  }
  return out;
}

function openVisit(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  const v = d.visits[st.cursor];
  if (!v) return { lines: [] };
  const name = `${v.slug}${v.attempt.n > 1 ? ` #${v.attempt.n}` : ""}`;
  const out: string[] = [
    `${dim("Steps ›")} ${bold(name)} ${dim(`· ${v.kind || "step"}${v.rework ? " · after a failure" : ""}`)}`,
  ];
  out.push(subStrip(st.sub, width, ctx.focused).line);
  out.push("");
  if (v.attempt.n === 0) {
    out.push(dim("This step has not started yet."));
  } else if (st.sub === 0) {
    out.push(...attemptResult(v.attempt, width, v.human));
  } else if (st.sub === 1) {
    out.push(
      ...wrapText(
        "What this step changed is not recorded for it yet. All the changes are under Code.",
        width,
      ).map((l) => dim(l)),
    );
  } else {
    out.push(...stepLog(d, v, ctx));
  }
  return { lines: out.map((l) => fit(l, width)) };
}

function comments(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  const out: string[] = [
    dim("They go back to the agent when you reject. c adds one, d deletes the selected."),
  ];
  if (d.comments.length === 0) {
    out.push("", dim("No comments yet."));
    return { lines: out.map((l) => fit(l, width)) };
  }
  let anchor = out.length;
  for (const [i, c] of d.comments.entries()) {
    if (i === st.cursor) anchor = out.length;
    const head = `${i === st.cursor ? "▸" : " "} ${fit(c.severity, 8)}${tailFit(c.location, width - 12)}`;
    out.push(row(head, i === st.cursor, ctx.focused, width));
    for (const line of wrapText(c.description, width - 4).slice(0, 3)) out.push(`    ${dim(line)}`);
  }
  return { lines: out.map((l) => fit(l, width)), anchor };
}

// ── the log: what the agent said and did ────────────────────────────────────

const clock = (ts: number): string => new Date(ts).toTimeString().slice(0, 8);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What each entry looks like. A message wraps under its time; a tool call is a line and its result another. */
function agentLines(entries: LogEntry[], width: number): string[] {
  const out: string[] = [];
  const indent = " ".repeat(15);
  for (const e of entries) {
    const at = dim(clock(e.ts));
    if (e.kind === "text" || e.kind === "you") {
      const who = e.kind === "text" ? bold(cyan("agent")) : bold(yellow("you  "));
      for (const [i, l] of prose(e.text, Math.max(10, width - 15)).entries()) {
        out.push(i === 0 ? `${at} ${who} ${l}` : `${indent}${l}`);
      }
    } else if (e.kind === "call") {
      out.push(
        fit(`${at} ${magenta("⚙")} ${bold(e.tool ?? "tool")}  ${dim(oneLine(e.text))}`, width),
      );
      const r = e.result;
      if (r) {
        const facts = [
          r.ms === undefined ? "" : duration(r.ms),
          r.size === undefined ? "" : bytes(r.size),
        ]
          .filter((x) => x !== "")
          .join(" · ");
        const said = r.text ? `  ${dim(oneLine(r.text))}` : "";
        out.push(
          fit(
            `${indent}${r.ok ? green("↳ ok") : red("↳ failed")}${facts ? dim(` ${facts}`) : ""}${said}`,
            width,
          ),
        );
      }
    } else {
      out.push(fit(`${at} ${dim("⤷ subagent")} ${oneLine(e.text)}`, width));
    }
  }
  return out;
}

const laidOut = new WeakMap<LogEntry[], Map<number, string[]>>();

function agentView(entries: LogEntry[], width: number): string[] {
  let byWidth = laidOut.get(entries);
  if (!byWidth) {
    byWidth = new Map();
    laidOut.set(entries, byWidth);
  }
  let lines = byWidth.get(width);
  if (!lines) {
    lines = agentLines(entries, width).map((l) => fit(l, width));
    byWidth.set(width, lines);
  }
  return lines;
}

const NO_AGENT_LOG =
  "The agent's own log can be read for Claude Code only. These are the pipeline's events.";

/**
 * What the agent said and did, as one list of lines: its own log when it can be read, else the digest of
 * the background agent's stream. The Log tab shows the whole of it; the block above the tabs of a run
 * that is going on shows its tail, so both read the same.
 */
export function activityLines(
  d: GateDetail | undefined,
  worker: WorkerLog | undefined,
  width: number,
): string[] | undefined {
  if (d?.agentLog) return agentView(d.agentLog, width);
  if (worker !== undefined && worker.lines.length > 0) {
    return worker.lines.map((l) => fit(`  ${l}`, width));
  }
  return undefined;
}

/** The tail of `activityLines` under the agent's name, with the command for the whole log. */
export function activityBlock(
  d: GateDetail | undefined,
  worker: WorkerLog,
  width: number,
): string[] {
  const session = worker.resumes > 0 ? ` (session ${worker.resumes + 1})` : "";
  return [
    dim(`AGENT · ${worker.name}${session}`),
    ...(activityLines(d, worker, width) ?? []).slice(-DIGEST_LINES),
    dim(`  $ kodel agent logs ${worker.name}`),
  ].map((l) => fit(l, width));
}

function logTab(d: GateDetail, ctx: Context): Content {
  const lines = activityLines(d, ctx.worker, ctx.width);
  if (d.agentLog && lines) return { lines };
  if (lines && ctx.worker) {
    return {
      lines: [
        fit(
          dim(`From the background agent's stream · kodel agent logs ${ctx.worker.name}`),
          ctx.width,
        ),
        ...lines,
        "",
        ...d.journal.map((l) => fit(dim(l), ctx.width)),
      ],
    };
  }
  return {
    lines: [
      ...wrapText(NO_AGENT_LOG, ctx.width).map((l) => fit(dim(l), ctx.width)),
      "",
      ...d.journal.map((l) => fit(dim(l), ctx.width)),
    ],
  };
}

/** The agent's words and calls while a step went on, or the pipeline's records of it when there is no agent log. */
function stepLog(d: GateDetail, v: Visit, ctx: Context): string[] {
  const from = v.attempt.from;
  if (d.agentLog && from !== undefined) {
    const to = v.attempt.to ?? Number.POSITIVE_INFINITY;
    const within = d.agentLog.filter((e) => e.ts >= from && e.ts <= to);
    return within.length === 0
      ? [dim("The agent did nothing in this step.")]
      : agentLines(within, ctx.width);
  }
  return v.attempt.log.length === 0 ? [dim("No records.")] : v.attempt.log.map((l) => dim(l));
}

export function tabContent(d: GateDetail, st: TabState, ctx: Context): Content {
  switch (st.tab) {
    case CODE:
      return code(d, st, ctx);
    case STEPS:
      return steps(d, st, ctx);
    case COMMENTS:
      return comments(d, st, ctx);
    case LOG:
      return logTab(d, ctx);
    default:
      return report(d, ctx);
  }
}

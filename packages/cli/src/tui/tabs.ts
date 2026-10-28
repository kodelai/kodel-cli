/** The tabs of the card of a run waiting at a human step: what each shows, as lines of text. */
import { bold, dim, fit, green, inverse, red, stripAnsi, wrapText, yellow } from "./ansi";
import { type Attempt, formatAge, type GateDetail, type Session, type StepDetail } from "./session";

export const TABS = ["Summary", "Changes", "Steps", "Journal"] as const;

/** Where in the tabs the person is: which tab, which line of its list, and whether a line is open. */
export interface TabState {
  tab: number;
  cursor: number;
  open: boolean;
}

export const SUMMARY = 0;
export const CHANGES = 1;
export const STEPS = 2;
export const JOURNAL = 3;

/** The tabs that are a list of things to open. */
export function isListTab(tab: number): boolean {
  return tab === CHANGES || tab === STEPS;
}

export function itemCount(d: GateDetail, tab: number): number {
  if (tab === CHANGES) return d.changes.kind === "files" ? d.changes.files.length : 0;
  if (tab === STEPS) return d.steps.length;
  return 0;
}

export interface Context {
  now: number;
  width: number;
  /** The action keys of the decision, as the card words them. */
  actions: string;
  /** The card has the keys; a selected line then stands out more. */
  focused: boolean;
}

export interface Content {
  lines: string[];
  /** The line the person is on, so the view can keep it in sight. */
  anchor?: number;
}

function tabText(d: GateDetail, i: number): { text: string; styled: string } {
  const name = TABS[i] ?? "";
  if (i === CHANGES) {
    const n = d.changes.kind === "files" ? d.changes.totalFiles : 0;
    const warn = d.changedAfterChecks.length > 0 || d.changes.kind === "unavailable";
    return {
      text: `${name} ${n}${warn ? " ⚠" : ""}`,
      styled: `${name} ${n}${warn ? ` ${yellow("⚠")}` : ""}`,
    };
  }
  if (i === STEPS) {
    const broken = d.steps.some((s) => s.state === "failed");
    return {
      text: `${name} ${d.steps.length}${broken ? " ✗" : ""}`,
      styled: `${name} ${d.steps.length}${broken ? ` ${red("✗")}` : ""}`,
    };
  }
  if (i === JOURNAL)
    return { text: `${name} ${d.journal.length}`, styled: `${name} ${d.journal.length}` };
  return { text: name, styled: name };
}

/** The row of tab names, and where each one is (columns, from 0) so a click can find it. */
export function tabStrip(
  d: GateDetail,
  active: number,
  width: number,
  focused: boolean,
): { line: string; spans: [number, number][] } {
  let line = "";
  let at = 0;
  const spans: [number, number][] = [];
  for (let i = 0; i < TABS.length; i++) {
    const { text, styled } = tabText(d, i);
    const cell = ` ${text} `;
    spans.push([at, at + cell.length]);
    at += cell.length;
    if (i === active)
      line += focused ? inverse(stripAnsi(cell)) : bold(`[${text}]`.padEnd(cell.length));
    else line += dim(" ") + styled + dim(" ");
  }
  return { line: fit(line, width), spans };
}

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
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`;
}

const MARK = { ok: green("✓"), bad: red("✗"), open: yellow("◐"), pending: dim("○") };

function stepMark(s: StepDetail): string {
  if (s.state === "done") return MARK.ok;
  if (s.state === "failed") return MARK.bad;
  if (s.state === "waiting" || s.state === "running") return MARK.open;
  return MARK.pending;
}

function row(text: string, selected: boolean, focused: boolean, width: number): string {
  const plain = fit(text, width);
  if (!selected) return plain;
  return focused ? inverse(stripAnsi(plain)) : bold(plain);
}

function summary(s: Session, d: GateDetail, ctx: Context): string[] {
  const { width } = ctx;
  const inner = Math.max(10, width - 4);
  const bar = yellow("│");
  const out: string[] = [];
  out.push(bold(yellow(`${d.position} · ${d.node} · waiting ${formatAge(ctx.now - s.since)}`)));
  out.push(d.steps.map((st) => stepMark(st)).join(" "));
  out.push("");
  out.push(yellow("┌ You are asked"));
  for (const line of wrapText(d.prompt, inner)) out.push(`${bar} ${line}`);
  for (const line of wrapText(d.instructions ?? "", inner)) out.push(`${bar} ${dim(line)}`);
  if (d.comments > 0) {
    out.push(
      `${bar} ${dim(`${d.comments} comment${d.comments === 1 ? "" : "s"} recorded at this step`)}`,
    );
  }
  out.push(`${yellow("└")} ${ctx.actions}`);
  out.push("");

  const failed = d.checks.filter((c) => !c.passed);
  if (d.checks.length === 0) out.push(dim("No checks ran before this step."));
  else if (failed.length === 0)
    out.push(`${green("✓")} Engine checks: all ${d.checks.length} passed`);
  else
    out.push(
      red(
        `✗ ${failed.length} of ${d.checks.length} checks failed: ${failed.map((c) => c.label).join(", ")}`,
      ),
    );
  if (d.changedAfterChecks.length > 0) {
    const n = d.changedAfterChecks.length;
    out.push(
      ...wrapText(`⚠ ${n} file${n === 1 ? "" : "s"} changed after the checks passed`, width).map(
        yellow,
      ),
    );
  }
  const c = d.changes;
  if (c.kind === "files") {
    out.push(
      `${dim("Changes")} ${c.totalFiles} file${c.totalFiles === 1 ? "" : "s"} · ${c.totalLines} lines`,
    );
  } else if (c.kind === "none") {
    out.push(`${dim("Changes")} none`);
  } else if (c.kind === "unavailable") {
    out.push(...wrapText(`⚠ Cannot tell what changed: ${c.reason}`, width).map(yellow));
  } else {
    out.push(`${dim("Changes")} ${dim("not a git repository")}`);
  }
  const redone = d.steps.filter((st) => st.attempts.length > 1);
  if (redone.length > 0) {
    out.push(
      `${dim("Steps")}   ${redone.map((st) => `${st.slug} ran ${st.attempts.length} times`).join(", ")}`,
    );
  }
  return out.map((l) => fit(l, width));
}

function changes(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  const c = d.changes;
  const out: string[] = [];
  if (c.kind === "none") return { lines: ["No files changed."] };
  if (c.kind === "no_repo") return { lines: [dim("This is not a git repository.")] };
  if (c.kind === "unavailable") {
    return { lines: wrapText(`Cannot tell what changed: ${c.reason}`, width).map(yellow) };
  }
  if (st.open) {
    const [file, lines] = c.files[st.cursor] ?? ["", 0];
    out.push(`${dim("Changes ›")} ${bold(tailFit(file, width - 10))}`);
    out.push("");
    out.push(`${lines} lines changed since the run started.`);
    out.push("");
    out.push(dim("The diff of this file opens here in the next step."));
    return { lines: out.map((l) => fit(l, width)) };
  }
  out.push(
    dim(
      `${c.totalFiles} file${c.totalFiles === 1 ? "" : "s"} · ${c.totalLines} lines · Enter opens a file`,
    ),
  );
  if (d.changedAfterChecks.length > 0) {
    const n = d.changedAfterChecks.length;
    out.push(yellow(`⚠ ${n} file${n === 1 ? "" : "s"} changed after the checks passed:`));
    for (const f of d.changedAfterChecks.slice(0, 5))
      out.push(yellow(`  ${tailFit(f, width - 2)}`));
  }
  const first = out.length;
  for (const [i, [file, lines]] of c.files.entries()) {
    out.push(
      row(
        `${i === st.cursor ? "▸" : " "} ${fit(tailFit(file, width - 9), width - 9)}${String(lines).padStart(5)}`,
        i === st.cursor,
        ctx.focused,
        width,
      ),
    );
  }
  return { lines: out, anchor: first + st.cursor };
}

function stepNote(s: StepDetail): string {
  const last = s.attempts.at(-1);
  const parts: string[] = [];
  if (s.attempts.length > 1) {
    const bad = s.attempts.filter((a) => a.ok === false).length;
    parts.push(`${s.attempts.length} tries${bad > 0 ? `, ${bad} failed` : ""}`);
  }
  if (last?.decision) parts.push(last.decision.decision);
  if (last?.review) parts.push(`${last.review.findings.length} findings`);
  if (s.state === "waiting") parts.push("waiting for you");
  return parts.join(" · ");
}

function steps(d: GateDetail, st: TabState, ctx: Context): Content {
  const { width } = ctx;
  if (st.open) {
    const step = d.steps[st.cursor];
    return { lines: step ? stepDetail(step, width) : [] };
  }
  const out: string[] = [dim(`${d.steps.length} steps · Enter opens one`)];
  const first = out.length;
  for (const [i, s] of d.steps.entries()) {
    const last = s.attempts.at(-1);
    const time = last?.ms !== undefined ? duration(last.ms) : "";
    const text = `${i === st.cursor ? "▸" : " "} ${stepMark(s)} ${fit(s.slug, 16)} ${fit(s.kind, 8)} ${time.padStart(6)}  ${stepNote(s)}`;
    out.push(row(text, i === st.cursor, ctx.focused, width));
  }
  return { lines: out, anchor: first + st.cursor };
}

function attemptLines(a: Attempt, width: number): string[] {
  const out: string[] = [];
  const mark = a.ok === true ? MARK.ok : a.ok === false ? MARK.bad : MARK.open;
  const bits = [a.outcome ?? "in progress"];
  if (a.ms !== undefined) bits.push(duration(a.ms));
  if (a.exit !== undefined) bits.push(`exit ${a.exit}`);
  out.push(`${mark} ${bold(`try ${a.n}`)}  ${bits.join(" · ")}`);
  for (const line of wrapText(a.reason ?? "", width - 4)) out.push(`  ${red(line)}`);
  for (const c of a.checks) {
    out.push(
      `  ${c.passed ? MARK.ok : MARK.bad} ${c.label}${c.ms === undefined ? "" : dim(` ${duration(c.ms)}`)}`,
    );
  }
  if (a.summary) {
    out.push(`  ${dim("Agent says (not verified):")}`);
    for (const line of wrapText(a.summary, width - 4)) out.push(`    ${line}`);
  }
  if (a.decision) {
    const why = a.decision.reason ? ` — “${a.decision.reason}”` : "";
    out.push(`  You: ${a.decision.decision}${why}`);
  }
  if (a.review) {
    const rows = [...a.review.findings].sort(
      (x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9),
    );
    const counts = new Map<string, number>();
    for (const f of rows) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    const summaryLine = [...counts.entries()]
      .map(([sev, n]) => severityStyle(sev, `${n} ${sev}`))
      .join(dim(" · "));
    out.push(
      `  ${dim(`Findings (the agent's, ${a.review.completeness}):`)} ${rows.length === 0 ? green("none") : summaryLine}`,
    );
    for (const f of rows) {
      out.push(
        `    ${severityStyle(f.severity, fit(f.severity, 8))}${tailFit(f.location, width - 14)}`,
      );
      for (const line of wrapText(f.description, width - 6)) out.push(`      ${dim(line)}`);
    }
  }
  return out;
}

function stepDetail(s: StepDetail, width: number): string[] {
  const out: string[] = [];
  out.push(`${dim("Steps ›")} ${bold(s.slug)}`);
  const tries = s.attempts.length;
  out.push(
    dim(
      `${s.kind || "step"} · ${tries === 0 ? "not started" : `${tries} ${tries === 1 ? "try" : "tries"}`}`,
    ),
  );
  out.push("");
  for (const a of [...s.attempts].reverse()) {
    out.push(...attemptLines(a, width));
    out.push("");
  }
  return out.map((l) => fit(l, width));
}

function journal(d: GateDetail, ctx: Context): Content {
  return { lines: d.journal.map((l) => fit(dim(l), ctx.width)) };
}

export function tabContent(s: Session, d: GateDetail, st: TabState, ctx: Context): Content {
  switch (st.tab) {
    case CHANGES:
      return changes(d, st, ctx);
    case STEPS:
      return steps(d, st, ctx);
    case JOURNAL:
      return journal(d, ctx);
    default:
      return { lines: summary(s, d, ctx) };
  }
}

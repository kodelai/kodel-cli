/** The Report screen: how a pipeline fares over its runs, step by step, and across the versions of a step. */
import type { NodeStats, NodeVersion, PipelineStats, Spread } from "@kodel-ai/pipeline-core";
import { bold, cyan, dim, fit, green, red, stripAnsi, wrapText, yellow } from "./ansi";
import { definitionKey } from "./definition-text";
import { type PipeEntry, unifiedDiff } from "./pipelines";
import type { StatsData } from "./stats-load";
import { duration } from "./tabs";

export type StatsSlot =
  | { status: "loading" }
  | { status: "ready"; data: StatsData }
  | { status: "failed"; error: string };

export interface RepState {
  /** The pipeline shown. */
  selected: string;
  /** The step the table is on. */
  row: number;
  /** The version of that step the cursor is on, or -1 when it is on the step. */
  ver: number;
  /** The step is opened and read in full. */
  open: boolean;
  /** The steps whose versions are shown under them in the table. */
  expanded: string[];
  /** `current`: the attempts on the definitions the pipeline has now. `all`: every attempt. */
  scope: "current" | "all";
  scroll: number;
}

/** Fewer attempts than this and a number says little. */
const FEW = 5;

export function initialRepState(names: string[]): RepState {
  return {
    selected: names[0] ?? "",
    row: 0,
    ver: -1,
    open: false,
    expanded: [],
    scope: "current",
    scroll: 0,
  };
}

/** The pipelines that have a file: one that is only proposed has no runs. */
export function repNames(entries: PipeEntry[]): string[] {
  return entries.filter((e) => !e.fresh && e.problem === undefined).map((e) => e.name);
}

export function withNames(rep: RepState, names: string[]): RepState {
  return names.includes(rep.selected) ? rep : { ...initialRepState(names), scope: rep.scope };
}

function clamp(n: number, max: number): number {
  return Math.min(Math.max(0, max), Math.max(0, n));
}

/** The numbers the screen shows: of the scope asked for, when the present definitions are known. */
export function statsOf(rep: RepState, data: StatsData): PipelineStats {
  return rep.scope === "current" && data.definitionsKnown ? data.current : data.all;
}

function versionsIn(stats: PipelineStats | undefined, name: string): NodeVersion[] {
  return stats?.versions.find((g) => g.node === name)?.versions ?? [];
}

/** Where the cursor really is: on a step, and on one of its versions when they are shown. */
function cursorOf(rep: RepState, stats: PipelineStats | undefined): { row: number; ver: number } {
  const row = clamp(rep.row, (stats?.nodes.length ?? 0) - 1);
  const node = stats?.nodes[row];
  const shown = node && rep.expanded.includes(node.node) ? versionsIn(stats, node.node) : [];
  return { row, ver: shown.length === 0 ? -1 : Math.min(rep.ver, shown.length - 1) };
}

// ── keys ────────────────────────────────────────────────────────────────────

export interface RepView {
  names: string[];
  slot: StatsSlot | undefined;
  focus: "list" | "card";
  /** The width of the card and the lines it has room for below its head. */
  width: number;
  room: number;
}

export interface RepResult {
  rep: RepState;
  focus?: "list" | "card";
  notice?: string;
}

const readyOf = (slot: StatsSlot | undefined): StatsData | undefined =>
  slot?.status === "ready" ? slot.data : undefined;

export function repKey(rep: RepState, key: string, v: RepView): RepResult | undefined {
  const up = key === "up" || key === "k";
  const down = key === "down" || key === "j";
  const data = readyOf(v.slot);
  if (key === "a") {
    if (data && !data.definitionsKnown) {
      return { rep, notice: "The pipeline file cannot be read, so every attempt is counted." };
    }
    return {
      rep: {
        ...rep,
        scope: rep.scope === "current" ? "all" : "current",
        row: 0,
        ver: -1,
        scroll: 0,
      },
      notice:
        rep.scope === "current" ? "Counting every attempt." : "Counting the present definitions.",
    };
  }
  if (v.focus === "list") {
    if (up || down) {
      const at = Math.max(0, v.names.indexOf(rep.selected));
      const next = v.names[clamp(at + (down ? 1 : -1), v.names.length - 1)];
      return next ? { rep: { ...initialRepState([next]), scope: rep.scope } } : { rep };
    }
    if ((key === "enter" || key === "right") && rep.selected !== "") return { rep, focus: "card" };
    return undefined;
  }
  const stats = data ? statsOf(rep, data) : undefined;
  const count = stats?.nodes.length ?? 0;
  const at = cursorOf(rep, stats);
  const node = stats?.nodes[at.row];
  const shownOf = (name: string) =>
    rep.expanded.includes(name) ? versionsIn(stats, name).length : 0;
  const close = (): RepResult => ({ rep: { ...rep, open: false, scroll: 0 } });
  switch (key) {
    case "escape":
      return rep.open ? close() : { rep, focus: "list" };
    case "left":
      if (rep.open) return close();
      if (node && rep.expanded.includes(node.node)) {
        // Closing the versions of a step puts the cursor on the step.
        return {
          rep: { ...rep, expanded: rep.expanded.filter((x) => x !== node.node), ver: -1 },
        };
      }
      return { rep, focus: "list" };
    case "right":
      if (rep.open || !node || at.ver >= 0 || rep.expanded.includes(node.node)) return { rep };
      if (versionsIn(stats, node.node).length === 0) {
        return { rep, notice: "This step has had one definition only." };
      }
      return { rep: { ...rep, expanded: [...rep.expanded, node.node] } };
    case "v": {
      if (rep.open) return undefined;
      const names = (stats?.versions ?? []).map((g) => g.node);
      const every = names.length > 0 && names.every((x) => rep.expanded.includes(x));
      return { rep: { ...rep, expanded: every ? [] : names, ver: every ? -1 : rep.ver } };
    }
    default:
  }
  const lines = data ? bodyOf(rep, data, v.width).lines.length : 0;
  const page = Math.max(1, v.room - 1);
  const moveScroll = (by: number): RepResult => ({
    rep: { ...rep, scroll: clamp(rep.scroll + by, lines - v.room) },
  });
  if (key === "pagedown" || key === " ") return rep.open ? moveScroll(page) : undefined;
  if (key === "pageup" || key === "b") return rep.open ? moveScroll(-page) : undefined;
  if (!rep.open) {
    if (down && node) {
      // Down goes through the versions that are shown, then on to the next step.
      if (at.ver + 1 < shownOf(node.node)) return { rep: { ...rep, row: at.row, ver: at.ver + 1 } };
      return { rep: { ...rep, row: clamp(at.row + 1, count - 1), ver: -1 } };
    }
    if (up && node) {
      if (at.ver >= 0) return { rep: { ...rep, row: at.row, ver: at.ver - 1 } };
      const before = stats?.nodes[at.row - 1];
      if (!before) return { rep };
      return { rep: { ...rep, row: at.row - 1, ver: shownOf(before.node) - 1 } };
    }
    if (key === "enter" && count > 0) return { rep: { ...rep, open: true, scroll: 0 } };
    return undefined;
  }
  if (key === "n" || key === "p") {
    const by = key === "n" ? 1 : -1;
    // On a version, the next and the previous are the versions of the same step.
    if (at.ver >= 0 && node) {
      const last = versionsIn(stats, node.node).length - 1;
      return { rep: { ...rep, ver: clamp(at.ver + by, last), scroll: 0 } };
    }
    return { rep: { ...rep, row: clamp(at.row + by, count - 1), ver: -1, scroll: 0 } };
  }
  if (up || down) return moveScroll(down ? 1 : -1);
  return undefined;
}

// ── drawing ─────────────────────────────────────────────────────────────────

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const secs = (s: number) => duration(Math.round(s * 1000));

const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;

function kilo(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const money = (usd: number) => (usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`);

export function repList(
  names: string[],
  rep: RepState,
  stats: Record<string, StatsSlot>,
  width: number,
  height: number,
  focused: boolean,
): string[] {
  const lines: string[] = [dim("PIPELINES")];
  for (const name of names) {
    const on = name === rep.selected;
    const mark = on ? (focused ? cyan("▸") : bold("▸")) : " ";
    const slot = stats[name];
    const note =
      slot?.status === "ready"
        ? dim(plural(slot.data.runs, "run"))
        : slot?.status === "loading"
          ? dim("reading…")
          : slot?.status === "failed"
            ? red("failed")
            : "";
    const head = `${mark} ${on ? bold(name) : name}`;
    const gap = Math.max(1, width - stripAnsi(head).length - stripAnsi(note).length - 1);
    lines.push(fit(`${head}${" ".repeat(gap)}${note}`, width));
  }
  return lines.slice(0, height);
}

export function emptyReport(): string[] {
  return [
    "",
    `  ${bold("No pipeline to report on.")}`,
    dim("  The report reads the runs of a pipeline; there is none yet."),
  ];
}

/** What a row of the table is made of: a step, or one version of a step. */
interface Metrics {
  runs: number;
  attempts: number;
  perRun: number;
  failed: number;
  seconds: Spread;
  findings: { attempts: number; rows: number };
  decisions?: { rejected: number; rejectedWithReason: number } | undefined;
  usage: { attempts: number; usd: number };
}

interface Column {
  key: string;
  title: string;
  width: number;
  cell: (m: Metrics) => { text: string; style?: (s: string) => string };
  /** For a version: lower is better, and how big a change has to be to count. */
  trend?: { value: (m: Metrics) => number; least: (before: number) => number };
}

const share = (m: Metrics) => (m.attempts === 0 ? 0 : m.failed / m.attempts);

const backStyle = (n: Metrics) => {
  const s = share(n);
  return s >= 0.4 ? red : s >= 0.15 ? yellow : (text: string) => text;
};

const COLUMNS: Column[] = [
  { key: "runs", title: "runs", width: 4, cell: (n) => ({ text: String(n.runs) }) },
  {
    key: "tries",
    title: "tries",
    width: 5,
    cell: (n) => ({ text: n.perRun.toFixed(1) }),
    trend: { value: (m) => m.perRun, least: (b) => 0.1 * b },
  },
  {
    key: "time",
    title: "time",
    width: 7,
    cell: (n) => ({ text: secs(n.seconds.median) }),
    trend: { value: (m) => m.seconds.median, least: (b) => 0.1 * b },
  },
  { key: "p90", title: "p90", width: 7, cell: (n) => ({ text: secs(n.seconds.p90) }) },
  {
    key: "back",
    title: "back",
    width: 5,
    cell: (n) => ({ text: percent(n.failed, n.attempts), style: backStyle(n) }),
    trend: { value: share, least: () => 0.05 },
  },
  {
    key: "finds",
    title: "finds",
    width: 5,
    cell: (n) => ({
      text:
        n.findings.attempts === 0 ? "–" : String(Math.round(n.findings.rows / n.findings.attempts)),
    }),
  },
  {
    key: "why",
    title: "why",
    width: 5,
    cell: (n) => ({
      text:
        n.decisions && n.decisions.rejected > 0
          ? `${n.decisions.rejectedWithReason}/${n.decisions.rejected}`
          : "–",
    }),
  },
  {
    key: "usd",
    title: "$/try",
    width: 6,
    cell: (n) => ({
      text: n.usage.attempts === 0 ? "–" : money(n.usage.usd / n.usage.attempts),
    }),
  },
];

/** What drops out first when the card is narrow. */
const DROP_ORDER = ["usd", "p90", "why", "finds", "runs"];

function columnsFor(nameWidth: number, width: number): Column[] {
  let kept = [...COLUMNS];
  const used = () => nameWidth + kept.reduce((n, c) => n + c.width + 1, 0);
  for (const key of DROP_ORDER) {
    if (used() <= width) break;
    kept = kept.filter((c) => c.key !== key);
  }
  return kept;
}

interface Body {
  lines: string[];
  anchor?: number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(5, 10);

/** The cells of a row; a version is painted by how it differs from the one before it. */
function cellsOf(
  columns: Column[],
  m: Metrics,
  before: Metrics | undefined,
  dimmed: boolean,
): string {
  return columns
    .map((c) => {
      const { text, style } = c.cell(m);
      const padded = text.padStart(c.width);
      if (dimmed) return ` ${dim(padded)}`;
      if (before && c.trend && before.attempts >= 3 && m.attempts >= 3) {
        const was = c.trend.value(before);
        const change = c.trend.value(m) - was;
        if (Math.abs(change) >= c.trend.least(was)) return ` ${(change < 0 ? green : red)(padded)}`;
      }
      return ` ${style ? style(padded) : padded}`;
    })
    .join("");
}

function stepsBody(stats: PipelineStats, rep: RepState, width: number): Body {
  const out: string[] = [];
  const versionsOf = (name: string): NodeVersion[] =>
    stats.versions.find((g) => g.node === name)?.versions ?? [];
  const versionLabel = (v: NodeVersion) =>
    `    v${v.index} ${day(v.firstSeen)} ${v.changed.length > 0 ? v.changed.join("+") : "first"}`;
  // The column is as wide as the longest name or version label, up to a limit.
  const nameWidth = Math.min(
    28,
    Math.max(
      ...stats.nodes.map((s) => 4 + s.node.length + (versionsOf(s.node).length > 0 ? 3 : 0)),
      ...stats.nodes.flatMap((s) => versionsOf(s.node).map((v) => versionLabel(v).length)),
      8,
    ),
  );
  const columns = columnsFor(nameWidth, width);
  out.push(
    dim(`${fit("", nameWidth)}${columns.map((c) => ` ${c.title.padStart(c.width)}`).join("")}`),
  );
  const cursor = cursorOf(rep, stats);
  let anchor = 0;
  for (const [i, n] of stats.nodes.entries()) {
    const on = i === cursor.row && cursor.ver === -1;
    if (on) anchor = out.length;
    const versions = versionsOf(n.node);
    const open = rep.expanded.includes(n.node);
    const glyph = n.gate ? yellow("◆") : dim("●");
    const fold = versions.length > 0 ? dim(` ${open ? "▾" : "▸"}${versions.length}`) : "";
    const label = `${on ? cyan("❯") : " "} ${glyph} ${on ? bold(n.node) : n.node}${fold}`;
    if (n.attempts === 0) {
      const where =
        n.elsewhere > 0
          ? `none on the present definition yet (${n.elsewhere} on older ones)`
          : "never ran";
      out.push(fit(`${fit(label, nameWidth)}${dim(` ${where}`)}`, width));
    } else {
      out.push(
        fit(`${fit(label, nameWidth)}${cellsOf(columns, n, undefined, n.attempts < FEW)}`, width),
      );
    }
    if (!open) continue;
    for (const [k, v] of versions.entries()) {
      const what = v.changed.length > 0 ? v.changed.join("+") : "first";
      // The mark of the present definition stands next to the cursor, so it is never cut off.
      const now = v.current ? green("◀") : " ";
      const here = i === cursor.row && cursor.ver === k;
      if (here) anchor = out.length;
      const name = `${here ? cyan("❯") : " "} ${now} ${bold(`v${v.index}`)} ${dim(`${day(v.firstSeen)} ${what}`)}`;
      out.push(
        fit(
          `${fit(name, nameWidth)}${cellsOf(columns, v, versions[k - 1], v.attempts < FEW)}`,
          width,
        ),
      );
    }
  }
  out.push("");
  const total = stats.attempts.total;
  const notes = [
    "◆ a person decides: its time is the wait. back: attempts that failed or were rejected. tries: attempts per run. finds: findings per attempt that reported. why: rejections that said why.",
    stats.versions.length > 0
      ? "▸3 the step has had 3 definitions: → shows them, ← hides them, v all. ◀ the present one. A version is green or red where it is better or worse than the one before."
      : "",
    stats.attempts.withUsage < total
      ? `The cost is known for ${stats.attempts.withUsage} of ${total} attempts.`
      : "",
    stats.nodes.some((n) => n.attempts > 0 && n.attempts < FEW)
      ? `Dim rows have fewer than ${FEW} attempts.`
      : "",
  ].filter((x) => x !== "");
  for (const note of notes) out.push(...wrapText(note, width - 1).map(dim));
  return { lines: out, anchor };
}

function bar(share: number, cells = 12): string {
  const filled = Math.round(share * cells);
  return `${"█".repeat(filled)}${dim("░".repeat(cells - filled))}`;
}

/** What a step, or one version of it, shows in detail. */
type Numbers = Omit<NodeStats, "node" | "elsewhere">;

/** The numbers of a step or of a version: time, how its attempts ended and why, findings, people, cost. */
function metricLines(n: Numbers, width: number): string[] {
  const out: string[] = [];
  out.push(
    dim(
      `${plural(n.runs, "run")} · ${plural(n.attempts, "attempt")} (${n.perRun.toFixed(1)} per run)` +
        (n.attempts < FEW ? " · few attempts: read it with care" : ""),
    ),
  );
  out.push("", dim(n.gate ? "WAITING FOR A PERSON" : "TIME OF AN ATTEMPT"));
  out.push(
    `median ${secs(n.seconds.median)} · p90 ${secs(n.seconds.p90)} · longest ${secs(n.seconds.max)} · mean ${secs(n.seconds.mean)}`,
  );
  out.push("", dim("HOW ATTEMPTS ENDED"));
  const label = Math.max(...Object.keys(n.outcomes).map((k) => k.length), 6);
  for (const [outcome, count] of Object.entries(n.outcomes).sort((a, b) => b[1] - a[1])) {
    out.push(
      `${outcome.padEnd(label)} ${String(count).padStart(4)}  ${bar(count / n.attempts)} ${percent(count, n.attempts)}`,
    );
  }
  // At a gate the reasons are the person's words, which the decisions below show.
  if (n.failures.length > 0 && !n.decisions) {
    out.push("", dim("WHY THEY FAILED"));
    for (const f of n.failures) {
      const lead = `${String(f.n).padStart(3)}× ${dim(f.source)} `;
      const room = Math.max(10, width - 6 - f.source.length);
      const [first = "", ...rest] = wrapText(f.reason, room);
      out.push(`${lead}${first}`);
      for (const l of rest.slice(0, 1)) out.push(`${" ".repeat(5 + f.source.length)}${l}`);
    }
  }
  if (n.findings.attempts > 0) {
    out.push("", dim("FINDINGS"));
    out.push(
      `${plural(n.findings.attempts, "attempt")} reported ${plural(n.findings.rows, "finding")}, ${(n.findings.rows / n.findings.attempts).toFixed(1)} each`,
    );
    const severities = Object.entries(n.findings.bySeverity).sort((a, b) => b[1] - a[1]);
    if (severities.length > 0) {
      out.push(dim(severities.map(([s, c]) => `${s} ${c}`).join(" · ")));
    }
  }
  if (n.decisions) {
    const d = n.decisions;
    out.push("", dim("WHAT PEOPLE DECIDED"));
    out.push(
      `approved ${d.approved} · rejected ${d.rejected}` +
        (d.rejected > 0 ? ` · ${d.rejectedWithReason} of the rejections said why` : ""),
    );
    if (d.reasons.length > 0) {
      out.push(dim("the latest reasons:"));
      for (const reason of d.reasons) {
        const [first = "", ...rest] = wrapText(reason, Math.max(10, width - 4));
        out.push(`${dim("•")} ${first}`);
        for (const l of rest.slice(0, 1)) out.push(`  ${l}`);
      }
    }
  }
  if (n.usage.attempts > 0) {
    const u = n.usage;
    out.push("", dim("COST"));
    out.push(
      `${u.attempts} of ${n.attempts} attempts recorded it: ${money(u.usd / u.attempts)} per attempt, ${money(u.usd)} in all`,
    );
    out.push(
      dim(
        `per attempt: output ${kilo(u.output / u.attempts)} · input ${kilo(u.input / u.attempts)} · cache read ${kilo(u.cache_read / u.attempts)} · cache write ${kilo(u.cache_write / u.attempts)}`,
      ),
    );
  }
  return out;
}

/** A line cut to the width, keeping its indent on the lines it continues on. */
function wrapKeeping(line: string, width: number): string[] {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const parts = wrapText(line.trim(), Math.max(10, width - indent.length - 1));
  return parts.length === 0 ? [""] : parts.map((part) => `${indent}${part}`);
}

/** A unified diff in colour; a long line is wrapped under its marker. */
function diffLines(diff: string[], width: number): string[] {
  const paint = (mark: string) =>
    mark === "+" ? green : mark === "-" ? red : mark === "@" ? cyan : dim;
  return diff.flatMap((line) => {
    if (line.startsWith("@@")) return [cyan(line)];
    const mark = line[0] ?? " ";
    const parts = wrapKeeping(line.slice(1), width - 2);
    return parts.map((part, i) => paint(mark)(`${i === 0 ? mark : " "} ${part}`));
  });
}

function nodeDetail(stats: PipelineStats, n: NodeStats, row: number, width: number): Body {
  const out: string[] = [];
  out.push(
    `${bold(n.node)} ${dim(`· ${n.gate ? "a person decides" : "step"} · ${row + 1} of ${stats.nodes.length}`)}`,
  );
  if (n.attempts === 0) {
    out.push(
      dim(
        n.elsewhere > 0
          ? `Nothing ran on the present definition yet. ${plural(n.elsewhere, "attempt")} ran on older ones: press a.`
          : "This step never ran.",
      ),
    );
    return { lines: out };
  }
  out.push(...metricLines(n, width));
  if (n.elsewhere > 0) {
    out.push(
      "",
      dim(
        `${plural(n.elsewhere, "more attempt")} ran on other definitions of this step (press a).`,
      ),
    );
  }
  return { lines: out };
}

/** One definition of a step: what it changed, the numbers of the attempts on it, and what it said. */
function versionDetail(
  n: NodeStats,
  versions: NodeVersion[],
  k: number,
  data: StatsData,
  width: number,
): Body {
  const v = versions[k];
  if (!v) return { lines: [dim("No such version.")] };
  const before = versions[k - 1];
  const out: string[] = [];
  out.push(
    `${bold(n.node)} ${dim(`· v${v.index} · ${day(v.firstSeen)} · ${k + 1} of ${versions.length} definitions`)}${v.current ? green(" ◀ the present one") : ""}`,
  );
  const text = data.definitions[definitionKey(n.node, v.definition)];
  const was = before ? data.definitions[definitionKey(n.node, before.definition)] : undefined;
  if (before) {
    out.push(dim(`changed from v${before.index}: ${v.changed.join(", ") || "nothing seen"}`));
    out.push("", dim(`WHAT CHANGED SINCE v${before.index}`));
    if (text && was) {
      const diff = unifiedDiff(was.join("\n"), text.join("\n"));
      out.push(...(diff.length > 0 ? diffLines(diff, width) : [dim("The text is the same.")]));
    } else {
      out.push(dim("The text of these definitions is not kept."));
    }
  } else {
    out.push(dim("the first definition seen"));
  }
  out.push("", ...metricLines(v, width));
  out.push("", dim("THE DEFINITION"));
  if (text) out.push(...text.flatMap((line) => wrapKeeping(line, width)));
  else out.push(dim("Its text is not kept: the runs that kept it are gone."));
  return { lines: out };
}

function detailBody(stats: PipelineStats, rep: RepState, data: StatsData, width: number): Body {
  const at = cursorOf(rep, stats);
  const n = stats.nodes[at.row];
  if (!n) return { lines: [dim("No steps.")] };
  if (at.ver >= 0) return versionDetail(n, versionsIn(stats, n.node), at.ver, data, width);
  return nodeDetail(stats, n, at.row, width);
}

function bodyOf(rep: RepState, data: StatsData, width: number): Body {
  const stats = statsOf(rep, data);
  return rep.open ? detailBody(stats, rep, data, width) : stepsBody(stats, rep, width);
}

function headOf(rep: RepState, slot: StatsSlot | undefined, width: number): string[] {
  const out: string[] = [fit(bold(rep.selected), width)];
  const data = readyOf(slot);
  if (data) {
    const stats = statsOf(rep, data);
    const by = data.all.runs.byStatus;
    const states = Object.entries(by)
      .map(([status, n]) => `${n} ${status}`)
      .join(" · ");
    out.push(dim(`${plural(data.runs, "run")}${states ? ` · ${states}` : ""}`));
    if (stats.seconds.total.n > 0) {
      out.push(
        dim(
          `finished run: ${secs(stats.seconds.total.median)} (work ${secs(stats.seconds.work.median)}, waiting ${secs(stats.seconds.waiting.median)})`,
        ),
      );
    }
    const counting = data.definitionsKnown
      ? rep.scope === "current"
        ? `present definitions: ${stats.attempts.inScope} of ${stats.attempts.total} attempts`
        : `every attempt: ${stats.attempts.total}`
      : `every attempt: ${stats.attempts.total} (the file cannot be read)`;
    out.push(fit(`${cyan(counting)} ${dim("· a switches")}`, width));
    if (data.unreadable > 0) {
      out.push(
        yellow(
          `${plural(data.unreadable, "run")} could not be read and ${data.unreadable === 1 ? "is" : "are"} left out`,
        ),
      );
    }
  }
  return out;
}

export function repCard(
  rep: RepState,
  slot: StatsSlot | undefined,
  width: number,
  height: number,
  focused: boolean,
): string[] {
  const head = headOf(rep, slot, width);
  const room = Math.max(1, height - head.length);
  let body: Body;
  const data = readyOf(slot);
  if (data) body = bodyOf(rep, data, width);
  else if (slot?.status === "failed") {
    body = { lines: wrapText(`Cannot read the runs: ${slot.error}`, width - 1).map(red) };
  } else body = { lines: [dim("Reading the runs…")] };
  const scroll =
    body.anchor !== undefined
      ? clamp(body.anchor - Math.floor(room / 2), body.lines.length - room)
      : clamp(rep.scroll, body.lines.length - room);
  return [...head, ...body.lines.slice(scroll, scroll + room)].map((l) => fit(l, width));
}

/** The lines the card has for its body, for the keys that scroll. */
export function headHeight(rep: RepState, slot: StatsSlot | undefined, width: number): number {
  return headOf(rep, slot, width).length;
}

export function repHints(rep: RepState, card: boolean): string {
  if (!card) {
    return `${bold("↑↓")} select   ${bold("Enter")} open   ${bold("a")} scope   ${bold("Tab")} menu   ${bold("q")} quit`;
  }
  const tail = `   ${bold("a")} scope   ${bold("z")} zoom   ${bold("Esc")} ${rep.open ? "back" : "list"}`;
  if (rep.open) {
    const what = rep.ver >= 0 ? "version" : "step";
    return `${bold("↑↓")} scroll   ${bold("n/p")} next/prev ${what}${tail}`;
  }
  return `${bold("↑↓")} step   ${bold("→")} versions   ${bold("←")} hide   ${bold("v")} all   ${bold("Enter")} read it${tail}`;
}

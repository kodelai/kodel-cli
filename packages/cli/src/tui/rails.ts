/**
 * The steps of a pipeline in a column, and the ways back drawn as rails at the right: a rail starts
 * at the step it returns to (with an arrow) and ends at the last step that returns there.
 */
import { bold, cyan, dim, fit, visibleLength, yellow } from "./ansi";
import type { PipeStep } from "./pipelines";

interface Row {
  step: number;
  head: boolean;
  text: string;
  /** The step this row is where a return comes in. */
  arrives?: number;
  /** A return that leaves from this row. */
  leaves?: { to: number; label: string };
}

interface Rail {
  to: number;
  start: number;
  end: number;
  column: number;
}

/** Fewer columns than this and the labels have no room: the caller draws something else. */
const MIN_LABEL = 8;

export function railLines(
  steps: PipeStep[],
  cursor: number,
  width: number,
): { lines: string[]; anchor: number } | undefined {
  if (steps.length === 0) return undefined;
  const index = new Map(steps.map((s, i) => [s.slug, i]));
  const pad = String(steps.length).length;
  const spine = " ".repeat(2 + pad + 1);

  /** Whether a route goes to an earlier step, which a rail shows. */
  const backTo = (i: number, to: string, back: boolean): number | undefined => {
    const j = index.get(to);
    return back && j !== undefined && j < i ? j : undefined;
  };

  const arrivals = new Set<number>();
  for (const [i, s] of steps.entries()) {
    for (const r of s.routes) {
      const j = backTo(i, r.to, r.back);
      if (j !== undefined) arrivals.add(j);
    }
  }

  const rows: Row[] = [];
  const headRow: number[] = [];
  for (const [i, s] of steps.entries()) {
    const on = i === cursor;
    const glyph = s.gate ? yellow("◆") : s.kind === "command" ? dim("▪") : dim("●");
    const head: Row = {
      step: i,
      head: true,
      text: `${on ? cyan("❯") : " "} ${dim(String(i + 1).padStart(pad))} ${glyph} ${on ? bold(s.slug) : s.slug}`,
      ...(arrivals.has(i) ? { arrives: i } : {}),
    };
    headRow[i] = rows.length;
    rows.push(head);
    // The row of the step itself can hold one line going out; a step that a return comes back to
    // has that line taken, and the others go below it.
    let free = !arrivals.has(i);
    const below: Row[] = [];
    for (const r of s.routes) {
      const j = backTo(i, r.to, r.back);
      if (j !== undefined) {
        if (free) {
          head.leaves = { to: j, label: r.when };
          free = false;
        } else {
          below.push({
            step: i,
            head: false,
            text: `${spine}${dim("│")}`,
            leaves: { to: j, label: r.when },
          });
        }
        continue;
      }
      const plain = r.when === "" && r.to === steps[i + 1]?.slug;
      if (plain) continue;
      // The number is enough: the steps are numbered, and the name would not fit.
      const when = r.when ? `${r.when} ` : "";
      const to = index.get(r.to);
      below.push({
        step: i,
        head: false,
        text: `${spine}${dim(`│ ↳ ${when}→ ${to === undefined ? r.to : to + 1}`)}`,
      });
    }
    rows.push(...below);
  }

  const rails = new Map<number, Rail>();
  for (const [at, row] of rows.entries()) {
    if (!row.leaves) continue;
    const to = row.leaves.to;
    const rail = rails.get(to);
    if (rail) rail.end = Math.max(rail.end, at);
    else rails.set(to, { to, start: headRow[to] ?? 0, end: at, column: 0 });
  }
  // Short rails sit nearest the steps; two rails share a column when a free row lies between them.
  const placed: Rail[] = [];
  for (const rail of [...rails.values()].sort((a, b) => a.end - a.start - (b.end - b.start))) {
    let column = 0;
    while (
      placed.some((o) => o.column === column && !(rail.end + 1 < o.start || o.end + 1 < rail.start))
    ) {
      column++;
    }
    rail.column = column;
    placed.push(rail);
  }
  const columns = placed.reduce((n, r) => Math.max(n, r.column + 1), 0);

  // The width is that of the steps; a line below a step that runs longer is cut to it.
  const stepWidth = rows
    .filter((r) => r.head || r.leaves)
    .reduce((n, r) => Math.max(n, visibleLength(r.text)), 0);
  // A little more than the steps need, so that the jumps below them mostly fit.
  const textWidth =
    Math.min(
      stepWidth + 8,
      rows.reduce((n, r) => Math.max(n, visibleLength(r.text)), 0),
    ) + 1;
  const zone = 2 * columns + 1;
  if (columns > 0 && width - stepWidth - 1 - zone - 1 < MIN_LABEL) return undefined;

  const active = (column: number, at: number) =>
    placed.some((r) => r.column === column && r.start < at && at < r.end);

  const lines = rows.map((row, at) => {
    const arrival = row.arrives !== undefined ? rails.get(row.arrives) : undefined;
    const out = row.leaves ? rails.get(row.leaves.to) : undefined;
    const join = arrival ?? out;
    const cells: string[] = Array.from({ length: zone }, () => " ");
    if (join) {
      const to = 2 * join.column + 1;
      for (let x = 0; x <= to; x++) cells[x] = "─";
      if (arrival) cells[0] = "◄";
      for (let c = 0; c < join.column; c++) if (active(c, at)) cells[2 * c + 1] = "┼";
      cells[to] = arrival ? "┐" : at === join.end ? "┘" : "┤";
    }
    for (let c = 0; c < columns; c++) {
      if (join && c <= join.column) continue;
      if (active(c, at)) cells[2 * c + 1] = "│";
    }
    const label = row.leaves && row.leaves.label !== "" ? ` ${row.leaves.label}` : "";
    return fit(`${fit(row.text, textWidth)}${dim(cells.join(""))}${dim(label)}`, width);
  });

  const legend = fit(
    dim(`● agent  ▪ command  ◆ person${columns > 0 ? "  ◄ where a return lands" : ""}`),
    width,
  );
  return {
    lines: [...lines, "", legend],
    anchor: headRow[Math.min(cursor, steps.length - 1)] ?? 0,
  };
}

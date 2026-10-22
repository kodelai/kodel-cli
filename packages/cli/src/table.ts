/**
 * Aligned columns for the list commands, as `kubectl get` prints them. The cells are already cleaned
 * with `plain` by the caller, so they hold no control characters or line breaks.
 */

/** Pads every column but the last to its widest cell (the header included); width is in code points. */
export function formatTable(header: string[], rows: string[][], withHeader: boolean): string[] {
  const all = withHeader ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
    });
  }
  return all.map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - [...cell].length),
      )
      .join("  ")
      .trimEnd(),
  );
}

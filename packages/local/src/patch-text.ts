/**
 * The text of a patch as it is kept: what git printed, made fit to be stored in the run's history.
 * Pure, so the rules can be tested without a repository.
 */
import { type RedactRule, redactText } from "@kodel-ai/pipeline-core";

/** The largest `history.changes.max_kb` the config takes (8 MB), and so the largest patch kept. */
export const MAX_PATCH_KB = 8192;

/** Read this much more than `max_kb` from git, so redaction sees whole tokens near the cut. */
export const PATCH_READ_MARGIN = 16 * 1024;

/**
 * The first line of every patch kept. Its form is fixed: a reader (`task_size`, a later report) may
 * rely on it. A cut patch says so here, at the top, where it is seen first.
 */
export function patchHeader(cutAtKb?: number): string {
  return cutAtKb === undefined
    ? "# kodel-patch v1\n"
    : `# kodel-patch v1; cut at ${cutAtKb} KB; more follows\n`;
}

export interface PreparedPatch {
  /** The whole file: header, then the patch. */
  text: string;
  truncated: boolean;
}

/**
 * Drop what must not be kept, then cut to size. In this order: the last partial line when git
 * was stopped (it may hold half a token that no rule would match), the `index` lines (a blob id lets
 * anyone test a guess of a small secret), redaction, and only then the cut, so that a token never
 * stands on the border between "redacted" and "cut".
 */
export function preparePatch(
  raw: Buffer,
  options: { cutByGit: boolean; maxKb: number; rules: RedactRule[] },
): PreparedPatch {
  let bytes = raw;
  if (options.cutByGit) {
    const end = bytes.lastIndexOf(10);
    bytes = end >= 0 ? bytes.subarray(0, end + 1) : Buffer.alloc(0);
  }
  // `index` at the start of a line is always a header line: the lines of a file begin with a space,
  // `+` or `-`.
  const withoutIndex = bytes
    .toString("utf8")
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]+)?\n/gm, "");
  const redacted = redactText(withoutIndex, options.rules);

  const maxBytes = options.maxKb * 1024;
  const whole = Buffer.from(redacted, "utf8");
  const fits = !options.cutByGit && whole.length <= maxBytes - Buffer.byteLength(patchHeader());
  if (fits) return { text: patchHeader() + redacted, truncated: false };

  const header = patchHeader(options.maxKb);
  const room = Math.max(maxBytes - Buffer.byteLength(header), 0);
  const slice = whole.subarray(0, room);
  // At the end of a line, so a multi-byte character is never cut in two.
  const end = slice.lastIndexOf(10);
  const body = end >= 0 ? slice.subarray(0, end + 1).toString("utf8") : "";
  return { text: header + body, truncated: true };
}

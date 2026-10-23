/**
 * The file edits `kodel init` makes. Each one is idempotent and reports what it did, so running
 * the command twice changes nothing the second time and `--dry-run` can show the same list.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Status = "created" | "updated" | "unchanged" | "skipped";

export interface Change {
  /** Relative to the repository root, with `/` as the separator. */
  path: string;
  status: Status;
  note?: string;
}

export interface Context {
  root: string;
  dryRun: boolean;
  /** Overwrite a file that is not ours, or that someone edited. */
  force: boolean;
  changes: Change[];
}

/** The new text of a file, or the reason it is left as it is. */
export type Edit = { text: string } | { skip: string };

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function editFile(
  ctx: Context,
  rel: string,
  edit: (previous: string | undefined) => Edit,
): Promise<void> {
  const file = join(ctx.root, rel);
  const previous = await readIfExists(file);
  const next = edit(previous);
  if ("skip" in next) {
    ctx.changes.push({ path: rel, status: "skipped", note: next.skip });
    return;
  }
  if (next.text === previous) {
    ctx.changes.push({ path: rel, status: "unchanged" });
    return;
  }
  if (!ctx.dryRun) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next.text);
  }
  ctx.changes.push({ path: rel, status: previous === undefined ? "created" : "updated" });
}

/**
 * Edit a JSON file the person may also edit. A file that is not plain JSON (comments, say) is left
 * alone: rewriting it would drop what the person wrote.
 */
export function editJson(
  previous: string | undefined,
  /** May throw `SkipEdit` to leave the file as it is. */
  change: (value: Record<string, unknown>) => void,
): Edit {
  let value: Record<string, unknown> = {};
  if (previous !== undefined && previous.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(previous);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { skip: "not a JSON object; left as it was" };
      }
      value = parsed as Record<string, unknown>;
    } catch {
      return { skip: "not plain JSON; left as it was" };
    }
  }
  const before = JSON.stringify(value);
  try {
    change(value);
  } catch (error) {
    if (error instanceof SkipEdit) return { skip: error.message };
    throw error;
  }
  // Same content: keep the person's own formatting.
  if (previous !== undefined && JSON.stringify(value) === before) return { text: previous };
  return { text: `${JSON.stringify(value, null, 2)}\n` };
}

/** Thrown from inside an edit to leave the file as it is, with the reason. */
export class SkipEdit extends Error {}

export function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined) {
    const made: Record<string, unknown> = {};
    parent[key] = made;
    return made;
  }
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  throw new SkipEdit(`"${key}" is not an object; left as it was`);
}

/** Add `items` to the array at `key`, keeping what is there and leaving out what is already in it. */
export function addToList(parent: Record<string, unknown>, key: string, items: string[]): void {
  const existing = parent[key];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new SkipEdit(`"${key}" is not a list; left as it was`);
  }
  const list = (existing as unknown[] | undefined) ?? [];
  for (const item of items) if (!list.includes(item)) list.push(item);
  parent[key] = list;
}

/**
 * A block of text that init owns inside a file the person owns, between two marker lines. A file
 * with only one of the markers is not touched: replacing "up to the other marker" could reach the
 * person's own lines.
 */
export function managedBlock(
  previous: string | undefined,
  begin: string,
  end: string,
  body: string,
): Edit {
  const block = `${begin}\n${body.trimEnd()}\n${end}`;
  const text = previous ?? "";
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if ((from === -1) !== (to === -1) || (from !== -1 && to < from)) {
    return { skip: "a kodel marker line is missing or out of order; fix the file by hand" };
  }
  if (from !== -1) return { text: text.slice(0, from) + block + text.slice(to + end.length) };
  if (text.trim() === "") return { text: `${block}\n` };
  return { text: `${text.trimEnd()}\n\n${block}\n` };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const STAMP = /\n<!-- kodel:managed sha256=([0-9a-f]{64}) -->\n?$/;

/** A file we install and may later update: its last line carries the hash of the rest. */
export function stamp(text: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${body}\n<!-- kodel:managed sha256=${sha256(body)} -->\n`;
}

/**
 * `managed`: ours and not edited, safe to replace. `modified`: ours, but edited since.
 * `foreign`: not written by init at all.
 */
export function ownership(existing: string): "managed" | "modified" | "foreign" {
  const found = STAMP.exec(existing);
  if (!found) return "foreign";
  const body = existing.slice(0, found.index);
  return sha256(body) === found[1] ? "managed" : "modified";
}

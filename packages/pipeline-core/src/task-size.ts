/**
 * The size of a task, read from the text of a `git diff` patch: how many files, how many lines
 * were added and removed, where, and in what languages. Pure and computed on read; nothing is stored.
 */

export interface TaskSize {
  files: number;
  added: number;
  removed: number;
  /** Files git did not diff line by line; they count as files but add no lines. */
  binary_files: number;
  /** The first path segment of each file (`.` for a file in the root), most files first. */
  top_dirs: { dir: string; files: number }[];
  /** The extension of each file, most files first (`(none)` for a file without one). */
  languages: { ext: string; files: number }[];
}

interface FileEntry {
  header: string;
  path?: string;
  renamedTo?: string;
  deletedFrom?: string;
  binary: boolean;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  "\\": 92,
};

/** Git quotes a path with special characters in C style: `"a/\303\244"` with octal bytes. */
function unquote(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charAt(i);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const next = body.charAt(i + 1);
    bytes.push(SIMPLE_ESCAPES[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/x` or `b/x` to `x`; `/dev/null` is no path. */
function stripSide(path: string, side: "a" | "b"): string | undefined {
  const text = unquote(path.trim());
  if (text === "/dev/null") return undefined;
  return text.startsWith(`${side}/`) ? text.slice(2) : text;
}

/** The path from `diff --git a/x b/x`, which is ambiguous with spaces: both sides name the same file. */
function pathFromHeader(rest: string): string | undefined {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return end === -1 ? undefined : stripSide(rest.slice(end + 2), "b");
  }
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    if (rest.slice(2, at) === rest.slice(at + 3)) return rest.slice(at + 3);
  }
  const last = rest.lastIndexOf(" b/");
  return last === -1 ? undefined : rest.slice(last + 3);
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

export function measurePatch(patch: string): TaskSize {
  const entries: FileEntry[] = [];
  let current: FileEntry | undefined;
  let added = 0;
  let removed = 0;
  // Lines still to come in the hunk being read; only inside a hunk is a `+` or `-` a changed line,
  // so a file whose own line starts with `--` is not taken for a header.
  let oldLeft = 0;
  let newLeft = 0;

  let from = 0;
  while (from <= patch.length) {
    const end = patch.indexOf("\n", from);
    const line = patch.slice(from, end === -1 ? patch.length : end);
    from = end === -1 ? patch.length + 1 : end + 1;

    // A patch cut off inside a hunk must not swallow the files after it.
    if ((oldLeft > 0 || newLeft > 0) && line.startsWith("diff --git ")) {
      oldLeft = 0;
      newLeft = 0;
    }
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line.charAt(0);
      if (mark === "+") {
        added += 1;
        newLeft -= 1;
      } else if (mark === "-") {
        removed += 1;
        oldLeft -= 1;
      } else if (mark !== "\\") {
        // a context line; an empty one is a context line whose space was trimmed
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      current = { header: line.slice(11), binary: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (line.startsWith("rename to ")) {
      current.renamedTo = unquote(line.slice(10).trimEnd());
    } else if (line.startsWith("deleted file mode")) {
      current.deletedFrom = "";
    } else if (line.startsWith("--- ")) {
      const old = stripSide(line.slice(4).replace(/\r$/, ""), "a");
      if (current.deletedFrom !== undefined && old !== undefined) current.deletedFrom = old;
    } else if (line.startsWith("+++ ")) {
      const path = stripSide(line.slice(4).replace(/\r$/, ""), "b");
      if (path !== undefined) current.path = path;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
    }
  }

  const dirs = new Map<string, number>();
  const exts = new Map<string, number>();
  for (const entry of entries) {
    const path =
      entry.renamedTo ||
      entry.path ||
      entry.deletedFrom ||
      pathFromHeader(entry.header.replace(/\r$/, "")) ||
      entry.header;
    const slash = path.indexOf("/");
    const dir = slash === -1 ? "." : path.slice(0, slash);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "(none)";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const ranked = <K extends string>(counts: Map<string, number>, key: K) =>
    [...counts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([name, files]) => ({ [key]: name, files }) as { [P in K]: string } & { files: number });
  return {
    files: entries.length,
    added,
    removed,
    binary_files: entries.filter((e) => e.binary).length,
    top_dirs: ranked(dirs, "dir"),
    languages: ranked(exts, "ext"),
  };
}

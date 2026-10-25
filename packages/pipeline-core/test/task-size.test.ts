import { describe, expect, test } from "bun:test";
import { measurePatch } from "../src";

const patch = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("jspb_task_size_from_patch_text", () => {
  test("an empty patch is a task of size zero, not an error", () => {
    expect(measurePatch("")).toEqual({
      files: 0,
      added: 0,
      removed: 0,
      binary_files: 0,
      top_dirs: [],
      languages: [],
    });
  });

  test("a new file counts its lines as added", () => {
    const size = measurePatch(
      patch(
        "diff --git a/src/a.ts b/src/a.ts",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/src/a.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ),
    );
    expect(size).toMatchObject({ files: 1, added: 2, removed: 0 });
    expect(size.top_dirs).toEqual([{ dir: "src", files: 1 }]);
    expect(size.languages).toEqual([{ ext: "ts", files: 1 }]);
  });

  test("a deleted file counts its lines as removed and is found under its old path", () => {
    const size = measurePatch(
      patch(
        "diff --git a/docs/old.md b/docs/old.md",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/docs/old.md",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-a",
        "-b",
        "-c",
      ),
    );
    expect(size).toMatchObject({ files: 1, added: 0, removed: 3 });
    expect(size.top_dirs).toEqual([{ dir: "docs", files: 1 }]);
    expect(size.languages).toEqual([{ ext: "md", files: 1 }]);
  });

  test("a pure rename is one file and no lines; the new path is the one counted", () => {
    const size = measurePatch(
      patch(
        "diff --git a/old/x.py b/new/x.py",
        "similarity index 100%",
        "rename from old/x.py",
        "rename to new/x.py",
      ),
    );
    expect(size).toMatchObject({ files: 1, added: 0, removed: 0 });
    expect(size.top_dirs).toEqual([{ dir: "new", files: 1 }]);
  });

  test("a binary file is a file with no lines", () => {
    const size = measurePatch(
      patch(
        "diff --git a/img/logo.png b/img/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/img/logo.png and b/img/logo.png differ",
      ),
    );
    expect(size).toMatchObject({ files: 1, added: 0, removed: 0, binary_files: 1 });
    expect(size.languages).toEqual([{ ext: "png", files: 1 }]);
  });

  test("a CRLF file counts each line once", () => {
    const size = measurePatch(
      "diff --git a/win.txt b/win.txt\r\n--- a/win.txt\r\n+++ b/win.txt\r\n@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n same\r\n",
    );
    expect(size).toMatchObject({ files: 1, added: 1, removed: 1 });
    expect(size.top_dirs).toEqual([{ dir: ".", files: 1 }]);
  });

  test("a path with spaces and a quoted unicode path are read", () => {
    const size = measurePatch(
      patch(
        "diff --git a/my dir/a b.ts b/my dir/a b.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/my dir/a b.ts",
        "@@ -0,0 +1 @@",
        "+x",
        'diff --git "a/\\303\\244/f.go" "b/\\303\\244/f.go"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/\\303\\244/f.go"',
        "@@ -0,0 +1 @@",
        "+y",
      ),
    );
    expect(size.files).toBe(2);
    expect(size.top_dirs.map((d) => d.dir).sort()).toEqual(["my dir", "ä"]);
    expect(size.languages.map((l) => l.ext).sort()).toEqual(["go", "ts"]);
  });

  test("a line that looks like a header inside a hunk is a changed line, not a header", () => {
    const size = measurePatch(
      patch(
        "diff --git a/a.sql b/a.sql",
        "--- a/a.sql",
        "+++ b/a.sql",
        "@@ -1,2 +1,2 @@",
        "--- a comment",
        "+++ a comment",
        " keep",
      ),
    );
    expect(size).toMatchObject({ files: 1, added: 1, removed: 1 });
  });

  test("one huge file is counted in a single pass", () => {
    const lines = 300_000;
    const body = Array.from({ length: lines }, (_, i) => `+line ${i}`);
    const text = patch(
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.txt",
      `@@ -0,0 +1,${lines} @@`,
      ...body,
    );
    const started = Date.now();
    const size = measurePatch(text);
    expect(size).toMatchObject({ files: 1, added: lines, removed: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("directories and languages are ranked by the number of files", () => {
    const file = (path: string) => [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      "@@ -0,0 +1 @@",
      "+x",
    ];
    const size = measurePatch(
      patch(...file("a/1.ts"), ...file("a/2.ts"), ...file("b/3.md"), ...file("Makefile")),
    );
    expect(size.top_dirs[0]).toEqual({ dir: "a", files: 2 });
    expect(size.languages[0]).toEqual({ ext: "ts", files: 2 });
    expect(size.languages.map((l) => l.ext)).toContain("(none)");
  });
});

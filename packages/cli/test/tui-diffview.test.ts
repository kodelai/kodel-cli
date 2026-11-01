import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleLength } from "../src/tui/ansi";
import {
  firstCode,
  highlight,
  languageOf,
  moveCode,
  moveHunk,
  parseDiff,
  placeOf,
  prepare,
  viewDiff,
} from "../src/tui/diffview";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top()
 import x from "x";
-const a = 1;
+const a = 2; // changed
+const b = "two";
 export {};
@@ -20,2 +21,3 @@
 tail
+more
 end
\\ No newline at end of file
`;

const rowsOf = () => parseDiff(DIFF);
const view = (over: Partial<Parameters<typeof viewDiff>[1]> = {}, text = DIFF) => {
  const diff = { kind: "text" };
  const p = prepare(diff, text, "src/a.ts");
  return {
    p,
    v: viewDiff(p, {
      width: 60,
      cursor: firstCode(p),
      focused: true,
      path: "src/a.ts",
      comments: [],
      ...over,
    }),
  };
};

describe("parsing a diff", () => {
  test("the header lines go, the hunks and their lines stay, each line with its numbers", () => {
    const rows = rowsOf();
    expect(rows.map((r) => r.kind)).toEqual([
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
      "hunk",
      "ctx",
      "add",
      "ctx",
      "note",
    ]);
    expect(rows[0]).toMatchObject({ old: 1, new: 1, text: "function top()" });
    expect(rows[1]).toMatchObject({ old: 1, new: 1, text: 'import x from "x";' });
    expect(rows[2]).toMatchObject({ old: 2, text: "const a = 1;" });
    expect(rows[2]?.new).toBeUndefined();
    expect(rows[3]).toMatchObject({ new: 2, text: "const a = 2; // changed" });
    expect(rows[4]).toMatchObject({ new: 3 });
    expect(rows[5]).toMatchObject({ old: 3, new: 4 });
    expect(rows[6]).toMatchObject({ kind: "hunk", old: 20, new: 21 });
    expect(rows[10]).toMatchObject({ kind: "note", text: "No newline at end of file" });
  });

  test("a new file, a deleted one and a binary one are told in a word", () => {
    expect(parseDiff("diff --git a/x b/x\nnew file mode 100644\n").map((r) => r.text)).toEqual([
      "new file",
    ]);
    expect(parseDiff("diff --git a/x b/x\ndeleted file mode 100644\n").map((r) => r.text)).toEqual([
      "deleted file",
    ]);
    expect(parseDiff("Binary files a/x and b/x differ\n").map((r) => r.text)).toEqual([
      "binary file",
    ]);
    expect(parseDiff("")).toEqual([]);
  });

  test("a line that is only the sign is an empty line, not the end", () => {
    const rows = parseDiff("@@ -1,3 +1,3 @@\n a\n+\n-\n c\n");
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["hunk", ""],
      ["ctx", "a"],
      ["add", ""],
      ["del", ""],
      ["ctx", "c"],
    ]);
  });
});

describe("colouring code", () => {
  test("the language comes from the file's extension", () => {
    expect(languageOf("a/b/c.ts")).toBe("ts");
    expect(languageOf("x.TSX")).toBe("ts");
    expect(languageOf("run.sh")).toBe("bash");
    expect(languageOf("conf.yml")).toBe("yaml");
    expect(languageOf("README.md")).toBe("md");
    expect(languageOf("Dockerfile")).toBeUndefined();
    expect(languageOf("image.png")).toBeUndefined();
    expect(languageOf("dir.d/file")).toBeUndefined();
  });

  test("a line is cut into pieces with a kind: keywords, strings, numbers, comments", () => {
    const kinds = highlight('const a = "x"; // why', "ts").map((s) => s.type);
    expect(kinds).toContain("kwd");
    expect(kinds).toContain("str");
    expect(kinds).toContain("cmnt");
    expect(highlight("let n = 42;", "ts").some((s) => s.type === "num")).toBe(true);
    expect(highlight('{"a": true}', "json").length).toBeGreaterThan(1);
  });

  test("the pieces put back together are the line, whatever the language", () => {
    const cases: [string, string][] = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is a template literal
      ["ts", "const a = `x ${y}`;"],
      ["py", "def f(x): return x"],
      ["sql", "SELECT * FROM t;"],
      ["md", "# title"],
      ["yaml", "  - key: value"],
      ["html", '<a href="x">y</a>'],
    ];
    for (const [language, line] of cases) {
      expect(
        highlight(line, language)
          .map((s) => s.text)
          .join(""),
      ).toBe(line);
    }
  });

  test("a language that is not known, an empty line and a very long line are plain", () => {
    expect(highlight("whatever", undefined)).toEqual([{ text: "whatever" }]);
    expect(highlight("whatever", "klingon")).toEqual([{ text: "whatever" }]);
    expect(highlight("", "ts")).toEqual([{ text: "" }]);
    const long = `const a = ${"1 + ".repeat(300)}1;`;
    expect(highlight(long, "ts")).toEqual([{ text: long }]);
  });
});

describe("the cursor", () => {
  test("it starts on the first line of code, and moves over code, skipping hunks and notes", () => {
    const { p } = view();
    expect(firstCode(p)).toBe(1);
    expect(moveCode(p, 1, 1)).toBe(2);
    expect(moveCode(p, 5, 1)).toBe(7); // over the second hunk's heading
    expect(moveCode(p, 7, -1)).toBe(5);
    expect(moveCode(p, 1, -1)).toBe(1);
    expect(moveCode(p, 1, 100)).toBe(9); // the last line of code, not the note after it
    expect(moveCode(p, p.rows.length, 0)).toBe(9);
  });

  test("[ and ] go to the first line of the previous and the next hunk", () => {
    const { p } = view();
    expect(moveHunk(p, 1, 1)).toBe(7);
    expect(moveHunk(p, 7, -1)).toBe(1);
    expect(moveHunk(p, 7, 1)).toBe(7);
    expect(moveHunk(p, 1, -1)).toBe(1);
  });

  test("a comment is about the line as it is now, or as it was for a removed one", () => {
    const rows = rowsOf();
    expect(placeOf("src/a.ts", rows[3] as never)).toBe("src/a.ts:2");
    expect(placeOf("src/a.ts", rows[1] as never)).toBe("src/a.ts:1");
    expect(placeOf("src/a.ts", rows[2] as never)).toBe("src/a.ts:2 (removed line)");
  });
});

describe("the picture of a diff", () => {
  test("each line has its number and a sign, the heading of a hunk says where it is", () => {
    const out = view().v.lines.map(stripAnsi).join("\n");
    expect(out).toContain("@@ line 1 @@  function top()");
    expect(out).toMatch(/\b1\s{3}import x from "x";/);
    expect(out).toMatch(/\b2 - const a = 1;/);
    expect(out).toMatch(/\b2 \+ const a = 2; \/\/ changed/);
    expect(out).toMatch(/\b3 \+ const b = "two";/);
    expect(out).toContain("@@ line 21 @@");
    expect(out).toContain("No newline at end of file");
  });

  test("code is coloured in the terminal's own colours, and the signs are green and red", () => {
    const raw = view().v.lines.join("\n");
    expect(raw).toContain("\u001b[35mconst\u001b[0m"); // a keyword
    expect(raw).toContain("\u001b[32m+\u001b[0m");
    expect(raw).toContain("\u001b[31m-\u001b[0m");
    expect(raw).toContain("\u001b[2m// changed\u001b[0m"); // a comment is dim
  });

  test("the cursor row is marked and stands out, and the view says where it is", () => {
    const { p } = view();
    const at = 3;
    const { lines, anchor } = view({ cursor: at }).v;
    expect(lines.map(stripAnsi).filter((l) => l.includes("▸"))).toHaveLength(1);
    expect(stripAnsi(lines[anchor] ?? "")).toContain("▸");
    expect(stripAnsi(lines[anchor] ?? "")).toContain("const a = 2");
    expect(lines[anchor]).toContain("\u001b[7m"); // reversed while the card has the keys
    const idle = view({ cursor: at, focused: false }).v.lines[anchor] ?? "";
    expect(idle).not.toContain("\u001b[7m");
    expect(idle).toContain("\u001b[1m");
    expect(p.rows[at]?.kind).toBe("add");
  });

  test("a long line wraps under itself, and a very long one is cut with a mark", () => {
    const text = `@@ -1,1 +1,2 @@\n ok\n+${"word ".repeat(10)}\n+${"x".repeat(2000)}\n`;
    const lines = view({ width: 30 }, text).v.lines;
    expect(lines.every((l) => visibleLength(l) <= 30)).toBe(true);
    const plain = lines.map(stripAnsi);
    expect(plain.some((l) => l.includes("↪"))).toBe(true);
    expect(plain.filter((l) => l.includes("↪")).length).toBeLessThan(15);
    expect(plain.some((l) => l.endsWith("…"))).toBe(true);
  });

  test("a comment is shown under its line, a removed line's under that one", () => {
    const comments = [
      { severity: "major", location: "src/a.ts:2", description: "Why changed?" },
      { severity: "minor", location: "src/a.ts:2 (removed line)", description: "Was fine." },
      { severity: "info", location: "src/other.ts:2", description: "Not here." },
    ];
    const plain = view({ comments }).v.lines.map(stripAnsi);
    const at = (needle: string) => plain.findIndex((l) => l.includes(needle));
    expect(at("✎ minor")).toBe(at("2 - const a = 1;") + 1);
    expect(at("✎ major")).toBe(at("2 + const a = 2;") + 1);
    expect(plain.join("\n")).toContain("Why changed?");
    expect(plain.join("\n")).not.toContain("Not here.");
  });

  test("the same diff laid out the same way is not worked out again", () => {
    const diff = { kind: "text" };
    const p = prepare(diff, DIFF, "src/a.ts");
    expect(prepare(diff, DIFF, "src/a.ts")).toBe(p);
    const o = { width: 60, cursor: 1, focused: true, path: "src/a.ts", comments: [] };
    expect(viewDiff(p, o)).toBe(viewDiff(p, o));
    expect(viewDiff(p, { ...o, cursor: 2 })).not.toBe(viewDiff(p, o));
  });

  test("a diff with no code at all still shows", () => {
    const { v } = view({}, "Binary files a/x and b/x differ\n");
    expect(v.lines.map(stripAnsi).join("")).toContain("binary file");
  });
});

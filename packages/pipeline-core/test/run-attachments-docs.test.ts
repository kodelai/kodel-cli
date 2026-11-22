/**
 * The notes for people about attachments (T-45) say what the code does: the limits and the types are
 * the exported constants, the exception to "redact at every write path" is named where the principle
 * is, and what an older build lacks is said in the notes on run formats.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_LIMITS,
  ATTACHMENT_TEXT_EXTENSIONS,
  MAX_ATTACHMENTS_SHOWN,
  NOT_SCANNED,
} from "../src";
import { ATTACHMENT_TOOLS } from "../src/mcp";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** The row of a table whose first cell starts with `label`, as its cells. */
function row(doc: string, label: string): string[] {
  const line = doc.split("\n").find((l) => l.startsWith(`| ${label}`));
  if (line === undefined) throw new Error(`docs/attachments.md has no row "${label}"`);
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
}

describe("t45 the notes about attachments", () => {
  test("t45_docs_name_the_limits", () => {
    const doc = read("docs/attachments.md");
    const kb = (bytes: number) => `${bytes / 1024} KB`;
    const mb = (bytes: number) => `${bytes / (1024 * 1024)} MB`;
    // the limits are the constants the engine refuses by
    expect(row(doc, "one text version")[1]).toBe(kb(ATTACHMENT_LIMITS.textBytes));
    expect(row(doc, "one image")[1]).toBe(mb(ATTACHMENT_LIMITS.imageBytes));
    expect(row(doc, "names in a run")[1]).toBe(String(ATTACHMENT_LIMITS.names));
    expect(row(doc, "versions in a run")[1]).toBe(String(ATTACHMENT_LIMITS.versions));
    expect(row(doc, "bytes stored in a run")[1]).toBe(mb(ATTACHMENT_LIMITS.runBytes));
    expect(doc).toContain(`\`attachments_omitted\` past ${MAX_ATTACHMENTS_SHOWN}`);
    expect(doc).toContain(`the ${ATTACHMENT_LIMITS.versions} versions end the loop`);
    // the types are the extensions the engine takes, and no other
    const listed = (label: string) =>
      [...(row(doc, label)[1] ?? "").matchAll(/`\.([a-z]+)`/g)].map((m) => m[1] as string).sort();
    expect(listed("text")).toEqual([...ATTACHMENT_TEXT_EXTENSIONS].sort());
    expect(listed("image")).toEqual(Object.keys(ATTACHMENT_IMAGE_EXTENSIONS).sort());
    expect(doc).toContain("PDF and every other type are refused");
    // the tools are the ones a host with attachments serves
    for (const tool of ATTACHMENT_TOOLS) expect(doc, tool.name).toContain(`\`${tool.name}\``);
  });

  test("t45_docs_name_the_exception_to_principle_3", () => {
    const doc = read("docs/attachments.md");
    expect(doc).toContain(`\`${NOT_SCANNED}\``);
    expect(doc).toContain("the one exception to principle 3");
    // and the principle itself says so, where a reader of the principles meets it
    const principle = read("AGENTS.md")
      .split("\n")
      .find((line) => line.startsWith("3. **Redact at every write path.**"));
    expect(principle).toContain("The one exception is an image");
    expect(principle).toContain(NOT_SCANNED);
    expect(principle).toContain("docs/attachments.md");
    // the limit the person accepted is stated, with the test that pins it
    expect(doc).toContain("the journal of an open run can be forged");
    expect(doc).toContain("`t45_limit_a_forged_journal_line_is_an_attachment`");
  });

  test("t45_docs_name_what_an_older_build_lacks", () => {
    const formats = read("docs/run-formats.md");
    const start = formats.indexOf("## Attachments (T-45)");
    expect(start).toBeGreaterThan(-1);
    const section = formats.slice(start, formats.indexOf("\n## ", start + 5));
    expect(section).toContain("`attachment_written`");
    expect(section).toContain("An older build of format 2 lacks the protection");
    expect(section).toContain("approves a gate without comparing them");
    expect(section).toContain("`UNSUPPORTED_FORMAT_FEATURE`");
    expect(section).toContain("fixtures/formats/v2-attachment/");
    // the notes on the history and on the patches point at the same place
    expect(read("docs/history.md")).toContain("docs/attachments.md");
    expect(read("docs/changes.md")).toContain("docs/attachments.md");
  });

  test("t45_docs_name_tests_that_exist", () => {
    const sources: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const next = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
        if (entry.isDirectory()) walk(next);
        else if (entry.name.endsWith(".test.ts")) sources.push(readFileSync(next, "utf8"));
      }
    };
    for (const folder of ["packages/", "tests/"]) walk(new URL(folder, root));
    const all = sources.join("\n");
    const named = [...read("docs/attachments.md").matchAll(/`(t45_[a-z0-9_]+)`/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(1);
    for (const name of named) {
      expect({ name, found: all.includes(`"${name}"`) }).toEqual({ name, found: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { compileRules } from "@kodel-ai/pipeline-core";
import { patchHeader, preparePatch } from "../src/patch-text";

// Tests of TASK-36TW: the text of a patch as it is kept.

const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const diff = (body: string) =>
  `diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1 @@\n${body}`;
const prepare = (text: string, over: Partial<Parameters<typeof preparePatch>[1]> = {}) =>
  preparePatch(Buffer.from(text), { cutByGit: false, maxKb: 512, rules: [], ...over });

describe("preparing a patch", () => {
  test("t36tw_header_is_always_the_first_line", () => {
    expect(prepare(diff("+x\n")).text.startsWith("# kodel-patch v1\n")).toBe(true);
    expect(prepare("").text).toBe("# kodel-patch v1\n");
    expect(patchHeader(3)).toBe("# kodel-patch v1; cut at 3 KB; more follows\n");
  });

  test("t36tw_index_lines_are_dropped_and_content_lines_that_look_like_them_stay", () => {
    const out = prepare(diff("+index abc..def 100644\n")).text;
    expect(out).not.toContain("index 1111111..2222222");
    expect(out).toContain("+index abc..def 100644");
  });

  test("t36tw_secret_added_removed_and_in_a_name_is_redacted", () => {
    const text = `diff --git a/${secret}.txt b/${secret}.txt\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old=${secret}\n+new=${secret}\n`;
    const out = prepare(text).text;
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  test("t36tw_hostile_project_rule_does_not_break_the_cut", () => {
    const rules = compileRules([{ name: "all", pattern: "(.|\\n)+" }]);
    expect(() => prepare(diff("+x\n"), { rules })).not.toThrow();
  });
});

describe("cutting a patch", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i}\n`).join("");

  test("t36tw_truncation_exact_and_plus_one", () => {
    const header = Buffer.byteLength(patchHeader());
    const body = "x".repeat(1024 - header - 1) + "\n"; // fills 1 KB exactly with the header
    expect(prepare(body, { maxKb: 1 }).truncated).toBe(false);
    expect(Buffer.byteLength(prepare(body, { maxKb: 1 }).text)).toBe(1024);
    expect(prepare(`${body}y\n`, { maxKb: 1 }).truncated).toBe(true);
  });

  test("t36tw_truncation_cuts_on_a_line_and_stays_within_the_size", () => {
    const out = prepare(lines(2_000), { maxKb: 1 });
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith(patchHeader(1))).toBe(true);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1024);
    expect(out.text.endsWith("\n")).toBe(true);
    const body = out.text.slice(patchHeader(1).length);
    for (const line of body.split("\n").filter(Boolean)) expect(line).toMatch(/^\+line \d+$/);
  });

  test("t36tw_truncation_never_splits_a_multibyte_character", () => {
    const out = prepare(`+${"é".repeat(2_000)}\n+${"ü".repeat(2_000)}\n`, { maxKb: 1 });
    expect(out.text).not.toContain("�");
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1024);
  });

  test("t36tw_a_single_line_longer_than_the_limit_leaves_just_the_header", () => {
    const out = prepare(`+${"x".repeat(5_000)}\n`, { maxKb: 1 });
    expect(out.text).toBe(patchHeader(1));
    expect(out.truncated).toBe(true);
  });

  test("t36tw_secret_cut_at_read_limit: the partial last line of a cut read is dropped before redaction", () => {
    // git was stopped in the middle of a token: half of it would match no rule.
    const half = secret.slice(0, 12);
    const out = prepare(`+first line\n+key=${half}`, { cutByGit: true }).text;
    expect(out).toContain("+first line");
    expect(out).not.toContain(half);
    expect(out.startsWith(patchHeader(512))).toBe(true);
  });

  test("t36tw_bytes_follow_redaction_when_it_shrinks_the_head", () => {
    // Redaction replaces the key with a short marker; the size and the cut are those of the result.
    const text = `+${secret}\n${lines(100)}`;
    const out = prepare(text, { maxKb: 1 });
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1024);
    expect(out.text).not.toContain(secret);
  });

  test("t36tw_limit_cut_pem: a key cut at the limit may leak a short piece of its body", () => {
    // Documented limit: the key rule needs BEGIN and END together. The test pins what happens.
    const pem = `+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n`;
    const out = prepare(pem, { cutByGit: true }).text;
    expect(out).toContain("BEGIN PRIVATE KEY");
  });
});

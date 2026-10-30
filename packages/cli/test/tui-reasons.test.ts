import { describe, expect, test } from "bun:test";
import { capLines, headOf, parseBlocking, parseCommentsCsv } from "../src/tui/reasons";

const ONE = '{"severity":"critical","location":"a.ts:1","description":"first"}';
const TWO =
  '{"severity":"major","location":"b.ts","description":"has } and ; { inside, and \\"quotes\\""}';

describe("the findings in a failure's reason", () => {
  test("the words before the JSON are the head, each object is a finding", () => {
    const found = parseBlocking(`2 blocking findings: ${ONE}; ${TWO}`);
    expect(found?.head).toBe("2 blocking findings");
    expect(found?.findings).toEqual([
      { severity: "critical", location: "a.ts:1", description: "first" },
      { severity: "major", location: "b.ts", description: 'has } and ; { inside, and "quotes"' },
    ]);
    expect(found?.cut).toBe(false);
  });

  test("a last finding that the engine cut short is not guessed at, and the cut is reported", () => {
    const found = parseBlocking(
      `3 blocking findings: ${ONE}; {"severity":"major","location":"b.ts","descrip`,
    );
    expect(found?.findings).toHaveLength(1);
    expect(found?.cut).toBe(true);
  });

  test("a reason that is not findings is not taken for them", () => {
    expect(parseBlocking("1 test failed: t40_wait_timeout_reports")).toBeUndefined();
    expect(parseBlocking("timed out after 900 s")).toBeUndefined();
    expect(parseBlocking("failed: {not json at all}")).toBeUndefined();
    expect(parseBlocking('failed: {"severity":1}')).toBeUndefined();
  });

  test("a finding without a place still is one", () => {
    const found = parseBlocking(
      '1 blocking finding: {"severity":"major","description":"no place"}',
    );
    expect(found?.findings).toEqual([{ severity: "major", location: "", description: "no place" }]);
  });

  test("the head of a reason is its first line, without the JSON behind it", () => {
    expect(headOf(`3 blocking findings: ${ONE}; ${TWO}`)).toBe("3 blocking findings");
    expect(headOf("1 test failed: t40_wait_timeout_reports\nmore lines")).toBe(
      "1 test failed: t40_wait_timeout_reports",
    );
    expect(headOf("failed: [timeout] while waiting")).toBe("failed: [timeout] while waiting");
    expect(headOf('failed: [{"a":1}]')).toBe("failed");
  });
});

describe("the comments in a rejection", () => {
  const reason = [
    "Please fix the tests.",
    "",
    "Comments (CSV):",
    "severity,location,description",
    'major,a.ts:1,"has, a comma"',
    'minor,b.ts,"say ""hi"" and',
    'break the line"',
    "",
  ].join("\n");

  test("what the person wrote comes first, then each comment as a row", () => {
    const found = parseCommentsCsv(reason);
    expect(found?.text).toBe("Please fix the tests.");
    expect(found?.rows).toEqual([
      { severity: "major", location: "a.ts:1", description: "has, a comma" },
      { severity: "minor", location: "b.ts", description: 'say "hi" and\nbreak the line' },
    ]);
  });

  test("the columns are found by their names, in whatever order", () => {
    const found = parseCommentsCsv("Comments (CSV):\ndescription,severity,location\nwhy,info,x.ts");
    expect(found?.rows).toEqual([{ severity: "info", location: "x.ts", description: "why" }]);
    expect(found?.text).toBe("");
  });

  test("a reason without comments is just words", () => {
    expect(parseCommentsCsv("no tests in the plan")).toBeUndefined();
  });
});

describe("cutting a long list of lines", () => {
  test("it keeps the first lines and says how many it left out", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    expect(capLines(lines, 12, (n) => `more ${n}`)).toEqual([...lines.slice(0, 12), "more 8"]);
    expect(capLines(lines.slice(0, 5), 12, (n) => `more ${n}`)).toEqual(lines.slice(0, 5));
  });
});

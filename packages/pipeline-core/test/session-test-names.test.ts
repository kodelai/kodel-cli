import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The placeholder id of decision D-A (TASK-HN8N, decision 5). Every session test name begins with it; before
 * the merge it is renamed here and in the names this check lists.
 */
export const SESSION_TEST_ID = "tA_";

const repo = join(import.meta.dir, "../../..");
const TEST_DIRS = [
  "packages/pipeline-core/test",
  "packages/local/test",
  "packages/cli/test",
  "packages/testkit/test",
  "tests/pty",
];
const SESSION_TEST_FILE = /^(?:session|attach|pty)[\w-]*\.test\.ts$/;
/** A call of `test`, of one of its variants, or of a local wrapper whose name ends in `Test`, up to the quote. */
const TEST_CALL =
  /(?:^|[^\w.])(?:test|\w+Test)(?:\.(?:skip|only|todo|if|skipIf)(?:\((?:[^()]|\([^()]*\))*\))?)?\(\s*(["'`])/gm;

const namesIn = (source: string): string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(TEST_CALL)) {
    const quote = match[1] as string;
    const from = (match.index ?? 0) + match[0].length;
    const to = source.indexOf(quote, from);
    names.push(source.slice(from, to < 0 ? from + 80 : to));
  }
  return names;
};

/** What a file's constant `ID` holds, when it declares one as a plain string. */
const idConstant = (source: string): string | undefined =>
  /^(?:export )?const ID(?:: string)? = (["'`])([^"'`$\\]*)\1;?$/m.exec(source)?.[2];

/**
 * The names of a file that do not carry the id. The id may be spelled out, or come from a constant named `ID`:
 * then the file must declare that constant with the id as its value (another `ID`, say a session id, is not it).
 */
const unprefixed = (source: string, id: string): string[] => {
  const byConstant = idConstant(source) === id;
  return namesIn(source).filter(
    (name) =>
      !name.startsWith(id) &&
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a test file, not a template
      !(byConstant && name.startsWith("${ID}")) &&
      !name.startsWith("session_test_names_"),
  );
};

describe("session test names", () => {
  test("session_test_names_carry_the_decision_id", () => {
    const files = TEST_DIRS.flatMap((dir) =>
      existsSync(join(repo, dir))
        ? readdirSync(join(repo, dir))
            .filter((file) => SESSION_TEST_FILE.test(file))
            .map((file) => join(repo, dir, file))
            // this file quotes test calls as text
            .filter((file) => file !== import.meta.path)
        : [],
    );
    expect(files.length).toBeGreaterThan(5);
    let seen = 0;
    for (const file of files) {
      const names = namesIn(readFileSync(file, "utf8"));
      seen += names.length;
      expect(names.length, `${file} has no test the check can read`).toBeGreaterThan(0);
      expect(unprefixed(readFileSync(file, "utf8"), SESSION_TEST_ID), file).toEqual([]);
    }
    expect(seen).toBeGreaterThan(100);
  });

  test("session_test_names_check_rejects_unprefixed", () => {
    const source = [
      'test("tA_one", () => {});',
      "test.skipIf(process.platform === 'win32')(",
      '  "tB_two: wrong id",',
      "  () => {});",
      "socketTest(`tA_three ${x}`, () => {});",
      "test.skip('four_without_id', () => {});",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a test file, not a template
      "test(`${ID}five`, () => {});",
      'expect(latest("not a test name")).toBe(1);',
    ].join("\n");
    expect(namesIn(source)).toEqual([
      "tA_one",
      "tB_two: wrong id",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: as above
      "tA_three ${x}",
      "four_without_id",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: as above
      "${ID}five",
    ]);
    // no constant `ID` in the file: a name that begins with it carries nothing
    expect(unprefixed(source, SESSION_TEST_ID)).toEqual([
      "tB_two: wrong id",
      "four_without_id",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: as above
      "${ID}five",
    ]);
    // the constant counts only with the id as its value
    for (const [declared, carries] of [
      ['const ID = "tA_";', true],
      ["const ID = 'tA_'", true],
      ['const ID = "a_000000000_0000";', false],
      ['const ID = "tB_";', false],
      ['const ID = "tA_" + other;', false],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: as above
      ["const ID = `tA_${x}`;", false],
      ['  const ID = "tA_";', false],
      ['const OTHER_ID = "tA_";', false],
    ] as const) {
      expect(unprefixed(`${declared}\n${source}`, SESSION_TEST_ID), declared).toEqual([
        "tB_two: wrong id",
        "four_without_id",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: as above
        ...(carries ? [] : ["${ID}five"]),
      ]);
    }
  });
});

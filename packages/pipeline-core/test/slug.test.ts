import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SLUG_MAX_LENGTH,
  KodelError,
  MAX_TITLE_LENGTH,
  runSlug,
  slugify,
  startDate,
  validateTitle,
} from "../src";

describe("slugify", () => {
  test("transliterates Russian and joins words with underscores", () => {
    expect(slugify("добавить лимит попыток входа")).toBe("dobavit_limit_popytok_vkhoda");
  });

  test("handles the letters that need care", () => {
    expect(slugify("Съёмка: щука, чаща, юла, ящик")).toBe("semka_shchuka_chashcha_yula_yashchik");
    expect(slugify("объём")).toBe("obem");
  });

  test("keeps Latin and digits, lowercases, drops punctuation", () => {
    expect(slugify("Fix login #42!")).toBe("fix_login_42");
    expect(slugify("  --Add   rate-limit (v2)--  ")).toBe("add_rate_limit_v2");
  });

  test("strips accents", () => {
    expect(slugify("Café déjà vu")).toBe("cafe_deja_vu");
  });

  test("mixes scripts", () => {
    expect(slugify("Починить login в API")).toBe("pochinit_login_v_api");
  });

  test("caps the length without leaving a trailing separator", () => {
    const slug = slugify("слово ".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(DEFAULT_SLUG_MAX_LENGTH);
    expect(slug.endsWith("_")).toBe(false);
    expect(slugify("abcdef ghijkl", 7)).toBe("abcdef");
  });

  test("text with nothing to transliterate falls back to a stable hash", () => {
    const a = slugify("🎉🎉🎉");
    expect(a).toMatch(/^task_[0-9a-f]{8}$/);
    expect(slugify("🎉🎉🎉")).toBe(a);
    expect(slugify("日本語のタスク")).toMatch(/^task_[0-9a-f]{8}$/);
    expect(slugify("🎉🎉🎉")).not.toBe(slugify("🔥🔥🔥"));
    expect(slugify("")).toMatch(/^task_[0-9a-f]{8}$/);
  });

  test("output is always a safe file name", () => {
    for (const input of [
      "../../etc/passwd",
      "a/b\\c",
      "C:\\x",
      "name.md",
      "tab\tnew\nline",
      "x".repeat(500),
    ]) {
      expect(slugify(input)).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  test("is idempotent", () => {
    const once = slugify("Добавить лимит попыток входа #7");
    expect(slugify(once)).toBe(once);
  });
});

describe("validateTitle", () => {
  const reason = (title: string) => {
    try {
      validateTitle(title);
    } catch (error) {
      expect(error).toBeInstanceOf(KodelError);
      const e = error as KodelError;
      expect(e.code).toBe("INVALID_ARGUMENTS");
      expect(e.issues).toEqual([{ path: ["title"], message: expect.any(String) }]);
      return e.message;
    }
    return undefined;
  };

  test("accepts kebab-case words and digits", () => {
    for (const title of [
      "pipeline-version-field",
      "a",
      "fix-login-2",
      "x".repeat(MAX_TITLE_LENGTH),
    ]) {
      expect(validateTitle(title)).toBe(title);
    }
  });

  test("refuses an empty title and one that is too long, saying how long", () => {
    expect(reason("")).toContain("must not be empty");
    expect(reason("x".repeat(MAX_TITLE_LENGTH + 1))).toContain(
      `${MAX_TITLE_LENGTH + 1} characters`,
    );
  });

  test("refuses what could change a path or the shell, with the form it wants", () => {
    for (const title of [
      "Upper-Case",
      "two words",
      "snake_case",
      "a/b",
      "..",
      "a..b",
      "../etc",
      "caf\u00e9",
      "\u0434\u0430",
      "a;b",
    ]) {
      expect(reason(title)).toBeDefined();
    }
    expect(reason("a..b")).toContain('".."');
    expect(reason("Upper")).toContain("kebab-case");
  });

  test("refuses a dash at the ends or two in a row", () => {
    for (const title of ["-a", "a-", "a--b", "-"]) {
      expect(reason(title)).toContain("dash");
    }
  });
});

describe("runSlug", () => {
  test("is the title as given", () => {
    expect(runSlug("pipeline-version-field", "any task")).toBe("pipeline-version-field");
  });

  test("without a title it is made from the task text, in kebab-case within the cap", () => {
    expect(runSlug(undefined, "Fix login #42!")).toBe("fix-login-42");
    expect(
      runSlug(
        undefined,
        "\u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u043b\u0438\u043c\u0438\u0442",
      ),
    ).toBe("dobavit-limit");
    const long = runSlug(undefined, "word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("a task with nothing to read still gives a valid, stable slug", () => {
    const slug = runSlug(undefined, "\u{1F389}\u{1F389}");
    expect(slug).toMatch(/^task-[0-9a-f]{8}$/);
    expect(runSlug(undefined, "\u{1F389}\u{1F389}")).toBe(slug);
    expect(validateTitle(slug)).toBe(slug);
  });

  test("two runs with the same title have the same slug: it is a label, not an identity", () => {
    expect(runSlug("same", "one task")).toBe(runSlug("same", "another task"));
  });
});

describe("startDate", () => {
  test("is the UTC day, also just before and after midnight", () => {
    expect(startDate(Date.UTC(2026, 9, 20, 12, 0, 0))).toBe("2026-10-20");
    expect(startDate(Date.UTC(2026, 9, 20, 23, 59, 59, 999))).toBe("2026-10-20");
    expect(startDate(Date.UTC(2026, 9, 21, 0, 0, 0))).toBe("2026-10-21");
  });
});

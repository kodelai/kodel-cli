import { describe, expect, test } from "bun:test";
import { DEFAULT_SLUG_MAX_LENGTH, slugify } from "../src";

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

import { describe, expect, test } from "bun:test";
import { ERROR_CODES, KodelError } from "../src";

describe("error codes", () => {
  test("are unique SCREAMING_SNAKE_CASE strings", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  test("list matches the contract (24 codes)", () => {
    // A new code must be added to the contract (error codes section) and to this count.
    expect(ERROR_CODES.length).toBe(24);
  });

  test("KodelError renders the code first", () => {
    const e = new KodelError("ATTEMPT_MISMATCH", "expected attempt 2");
    expect(e.toString()).toBe("ATTEMPT_MISMATCH: expected attempt 2");
    expect(e.toToolError()).toEqual({
      ok: false,
      code: "ATTEMPT_MISMATCH",
      message: "expected attempt 2",
    });
  });
});

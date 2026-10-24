import { describe, expect, test } from "bun:test";
import { ERROR_CODES, KodelError } from "../src";

describe("error codes", () => {
  test("are unique SCREAMING_SNAKE_CASE strings", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  test("list matches the contract (38 codes)", () => {
    // A new code must be added to the contract (error codes section) and to this count.
    expect(ERROR_CODES.length).toBe(38);
  });

  test("t16_details_is_the_one_place_for_extra_data_of_a_code", () => {
    const e = new KodelError("TASK_RATE_LIMITED", "slow down", undefined, { retry_after_s: 7 });
    expect(e.toToolError()).toEqual({
      ok: false,
      code: "TASK_RATE_LIMITED",
      message: "slow down",
      details: { retry_after_s: 7 },
    });
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

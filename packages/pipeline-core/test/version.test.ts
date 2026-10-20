import { describe, expect, test } from "bun:test";
import {
  BASELINE_VERSION,
  KodelError,
  MAX_SUPPORTED_MAJOR,
  parseVersion,
  resolveVersion,
} from "../src";

test("t12: absence of a version means 1.0.0 forever, whatever the engine supports", () => {
  expect(BASELINE_VERSION).toBe("1.0.0");
  expect(MAX_SUPPORTED_MAJOR).toBeGreaterThanOrEqual(parseVersion(BASELINE_VERSION).major);
});

describe("parseVersion", () => {
  test("a positive integer N becomes N.0.0", () => {
    expect(parseVersion(2)).toEqual({ version: "2.0.0", major: 2 });
  });

  test("semver strings keep their text, prerelease and build metadata included", () => {
    expect(parseVersion("1.2.3-beta.1+build.5")).toEqual({
      version: "1.2.3-beta.1+build.5",
      major: 1,
    });
  });

  test("everything else is rejected", () => {
    for (const bad of ["01.0.0", "1.0", "1", "", 0, -1, 1.5, true, null, [], {}, undefined]) {
      expect(() => parseVersion(bad)).toThrow(KodelError);
    }
  });
});

describe("resolveVersion", () => {
  test("a newer major is UNSUPPORTED_FORMAT whatever the form or where it comes from", () => {
    const tooNew = MAX_SUPPORTED_MAJOR + 1;
    for (const args of [[tooNew], [`${tooNew}.0.0-beta`], [undefined, tooNew]] as const) {
      try {
        resolveVersion(...args);
        throw new Error("expected resolveVersion to throw");
      } catch (e) {
        expect((e as KodelError).code).toBe("UNSUPPORTED_FORMAT");
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  checkProfiles,
  compareAgentVersions,
  HISTORY_FORMAT,
  HistoryCollectorRegistry,
  historyEventSchema,
  inAgentRange,
  inWindow,
  parseAgentRange,
  parseAgentVersion,
  previewOf,
  redactEvent,
  selectProfile,
  toTs,
} from "../src";

const usage = {
  v: HISTORY_FORMAT,
  agent: "claude-code",
  agent_version: "2.1.306",
  session_id: "s1",
  seq: 1,
  ts: "2026-10-21T10:00:00.000Z",
  kind: "usage",
  model: "m",
  input: 1,
  output: 2,
  cache_read: 3,
  cache_write: 4,
  reasoning: 0,
  semantics: "additive",
  message_id: "msg_1",
};

describe("vh9g agent history: the event format", () => {
  test("vh9g_a_usage_event_with_every_field_is_valid", () => {
    expect(
      historyEventSchema.safeParse({ ...usage, request_id: "req_1", cost: { basis: "unknown" } })
        .success,
    ).toBe(true);
  });

  test("vh9g_a_timestamp_must_be_utc_with_milliseconds", () => {
    expect(historyEventSchema.safeParse({ ...usage, ts: "2026-10-21T10:00:00Z" }).success).toBe(
      false,
    );
    expect(
      historyEventSchema.safeParse({ ...usage, ts: "2026-10-21T10:00:00.000+02:00" }).success,
    ).toBe(false);
  });

  test("vh9g_a_wrong_format_version_a_negative_count_and_an_unknown_kind_are_refused", () => {
    expect(historyEventSchema.safeParse({ ...usage, v: 2 }).success).toBe(false);
    expect(historyEventSchema.safeParse({ ...usage, output: -1 }).success).toBe(false);
    expect(historyEventSchema.safeParse({ ...usage, kind: "mood" }).success).toBe(false);
    expect(historyEventSchema.safeParse({ ...usage, semantics: "total" }).success).toBe(false);
  });

  test("vh9g_toTs_makes_utc_milliseconds_from_epoch_and_iso_and_nothing_from_junk", () => {
    expect(toTs(1_700_000_000_123)).toBe("2023-11-14T22:13:20.123Z");
    expect(toTs("2026-10-21T12:00:00+02:00")).toBe("2026-10-21T10:00:00.000Z");
    expect(toTs("yesterday")).toBeUndefined();
    expect(toTs({})).toBeUndefined();
    expect(toTs(undefined)).toBeUndefined();
  });

  test("vh9g_a_secret_across_the_cut_of_a_preview_is_redacted_before_the_cut", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    for (let inside = 8; inside < key.length; inside += 1) {
      // the cut at 499 characters falls `inside` characters into the key
      const preview = previewOf(`${"a".repeat(498 - inside)} ${key}`);
      expect(preview).not.toContain(key.slice(0, 8));
    }
  });

  test("vh9g_a_time_without_a_zone_is_utc_whatever_the_zone_of_the_machine", () => {
    expect(toTs("2026-01-01T10:00:00")).toBe("2026-01-01T10:00:00.000Z");
    expect(toTs("2026-01-01 10:00:00.5")).toBe("2026-01-01T10:00:00.500Z");
    expect(toTs("2026-01-01T10:00")).toBe("2026-01-01T10:00:00.000Z");
    expect(toTs("2026-01-01T10:00:00+02:00")).toBe("2026-01-01T08:00:00.000Z");
    expect(toTs("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("vh9g_toTs_refuses_a_year_the_format_cannot_hold", () => {
    expect(toTs(8.64e15)).toBeUndefined();
    expect(toTs("+275760-09-13T00:00:00.000Z")).toBeUndefined();
    expect(toTs("0001-01-01T00:00:00.000Z")).toBe("0001-01-01T00:00:00.000Z");
  });

  test("vh9g_previews_are_flat_and_capped", () => {
    expect(previewOf("a\n\n  b")).toBe("a b");
    expect(previewOf("x".repeat(600)).length).toBe(500);
    expect(previewOf("x".repeat(600))).toEndWith("…");
  });

  test("vh9g_redactEvent_redacts_every_string_of_an_event", () => {
    const event = historyEventSchema.parse({
      ...usage,
      kind: "message",
      role: "user",
      text_preview: "key AKIAIOSFODNN7EXAMPLE here",
    });
    const redacted = redactEvent(event);
    expect(JSON.stringify(redacted)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("vh9g_windows_cut_by_time_and_by_seq_inclusively", () => {
    const e = { ts: "2026-10-21T10:00:05.000Z", seq: 5 };
    expect(inWindow(e)).toBe(true);
    expect(inWindow(e, { from: e.ts, to: e.ts })).toBe(true);
    expect(inWindow(e, { from: "2026-10-21T10:00:05.001Z" })).toBe(false);
    expect(inWindow(e, { to: "2026-10-21T10:00:04.999Z" })).toBe(false);
    expect(inWindow(e, { seq_from: 6 })).toBe(false);
    expect(inWindow(e, { seq_from: 5 })).toBe(true);
  });
});

describe("vh9g agent history: versions and profiles", () => {
  const v = (text: string) => {
    const parsed = parseAgentVersion(text);
    if (!parsed) throw new Error(`bad version ${text}`);
    return parsed;
  };

  test("vh9g_versions_parse_compare_and_a_prerelease_is_older_than_its_release", () => {
    expect(parseAgentVersion("v2.1.306")).toEqual({ major: 2, minor: 1, patch: 306, pre: "" });
    expect(parseAgentVersion("2")).toEqual({ major: 2, minor: 0, patch: 0, pre: "" });
    expect(parseAgentVersion("2.1.0-beta.1+build")).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      pre: "beta.1",
    });
    expect(parseAgentVersion("latest")).toBeUndefined();
    expect(compareAgentVersions(v("1.9.9"), v("2.0.0"))).toBeLessThan(0);
    expect(compareAgentVersions(v("2.0.0-rc.1"), v("2.0.0"))).toBeLessThan(0);
    expect(compareAgentVersions(v("2.10.0"), v("2.9.0"))).toBeGreaterThan(0);
    expect(compareAgentVersions(v("2.0"), v("2.0.0"))).toBe(0);
  });

  test("vh9g_ranges_hold_at_both_sides_of_every_boundary", () => {
    expect(inAgentRange(v("1.99.99"), "<2.0.0")).toBe(true);
    expect(inAgentRange(v("2.0.0"), "<2.0.0")).toBe(false);
    expect(inAgentRange(v("2.0.0"), ">=2.0.0 <3.0.0")).toBe(true);
    expect(inAgentRange(v("2.99.0"), ">=2.0.0 <3.0.0")).toBe(true);
    expect(inAgentRange(v("3.0.0"), ">=2.0.0 <3.0.0")).toBe(false);
    expect(inAgentRange(v("2.0.0"), ">2.0.0")).toBe(false);
    expect(inAgentRange(v("2.0.1"), ">2.0.0")).toBe(true);
    expect(inAgentRange(v("0.0.1"), "*")).toBe(true);
  });

  test("vh9g_a_range_that_cannot_be_read_is_an_error", () => {
    expect(() => parseAgentRange("^2.0.0")).toThrow("invalid version range");
    expect(() => parseAgentRange("")).toThrow();
    expect(() => parseAgentRange(">=")).toThrow();
  });

  const oldP = { id: "old", versions: "<2.0.0" };
  const midP = { id: "mid", versions: ">=2.0.0 <3.0.0" };
  const newP = { id: "new", versions: ">=3.0.0" };
  const profiles = [oldP, midP, newP];

  test("vh9g_the_profile_follows_the_version_below_and_above_a_boundary", () => {
    const pick = (version: string) => selectProfile(profiles, version);
    expect(pick("1.9.9")).toEqual({ profile: oldP, match: "exact" });
    expect(pick("2.0.0")).toEqual({ profile: midP, match: "exact" });
    expect(pick("2.9.9")).toEqual({ profile: midP, match: "exact" });
    expect(pick("3.0.0")).toEqual({ profile: newP, match: "exact" });
    expect(pick("12.0.0")).toEqual({ profile: newP, match: "exact" });
  });

  test("vh9g_a_version_no_profile_lists_gets_the_nearest_one_and_is_marked", () => {
    const cc = { id: "cc-2", versions: ">=2.0.0 <3.0.0" };
    expect(selectProfile([cc], "1.5.0")).toEqual({ profile: cc, match: "below_known" });
    expect(selectProfile([cc], "3.1.0")).toEqual({ profile: cc, match: "above_known" });
    const a = { id: "a", versions: "<2.0.0" };
    const b = { id: "b", versions: ">=4.0.0" };
    expect(selectProfile([a, b], "3.0.0")).toEqual({ profile: a, match: "above_known" });
  });

  test("vh9g_no_version_or_an_unreadable_one_uses_the_newest_profile", () => {
    expect(selectProfile(profiles, undefined)).toEqual({
      profile: newP,
      match: "unknown_version",
    });
    expect(selectProfile(profiles, "nightly")).toEqual({
      profile: newP,
      match: "unknown_version",
    });
    expect(() => selectProfile([], "1.0.0")).toThrow("no profiles");
  });

  test("vh9g_checkProfiles_accepts_a_sound_list_and_names_the_problems_of_a_bad_one", () => {
    expect(checkProfiles(profiles)).toEqual([]);
    expect(checkProfiles([{ id: "x", versions: ">=2.0.0 <3.0.0" }])).toEqual([]);
    expect(checkProfiles([])).toEqual(["no profiles"]);
    expect(
      checkProfiles([
        { id: "a", versions: "*" },
        { id: "b", versions: ">=2.0.0" },
      ]).join(),
    ).toContain("overlap");
    expect(
      checkProfiles([
        { id: "a", versions: ">=2.0.0" },
        { id: "b", versions: "<2.0.0" },
      ]).join(),
    ).toContain("ascending");
    expect(
      checkProfiles([
        { id: "a", versions: "<2.0.0" },
        { id: "a", versions: ">=2.0.0" },
      ]).join(),
    ).toContain("duplicate");
    expect(checkProfiles([{ id: "a", versions: "~2" }]).join()).toContain("invalid version range");
  });
});

describe("vh9g agent history: the registry", () => {
  test("vh9g_a_collector_is_found_by_agent_id_and_cannot_be_registered_twice", () => {
    const collector = {
      agent: "x",
      profiles: [],
      locate: async () => [],
      read: async function* () {},
    };
    const registry = new HistoryCollectorRegistry().register(collector);
    expect(registry.get("x")).toBe(collector);
    expect(registry.get("y")).toBeUndefined();
    expect(registry.agents()).toEqual(["x"]);
    expect(() => registry.register(collector)).toThrow("already registered");
  });
});

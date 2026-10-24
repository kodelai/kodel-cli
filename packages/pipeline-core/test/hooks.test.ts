import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispatch,
  type HookAgent,
  type HookEvent,
  type HookHandler,
  HookRegistry,
  type HookTimer,
  normalizeClaudeCode,
  normalizeCodex,
  normalizeHookPayload,
  normalizeOpenCode,
  staleHookEvents,
} from "../src/hooks-index";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const FIXTURES = join(import.meta.dir, "../../../fixtures/hooks");

const fixture = (agent: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, agent, `${name}.json`), "utf8"));

/** A timer that fires only when the test says so. */
function manualTimer() {
  const pending: (() => void)[] = [];
  const timer: HookTimer = {
    start(_ms, onTimeout) {
      pending.push(onTimeout);
      return () => {
        const at = pending.indexOf(onTimeout);
        if (at >= 0) pending.splice(at, 1);
      };
    },
  };
  return { timer, fireAll: () => for_each(pending) };
}
function for_each(list: (() => void)[]) {
  for (const f of [...list]) f();
}

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
  agent: "claude-code",
  name: "SessionStart",
  session_id: "s1",
  cwd: "/p",
  ts: NOW.toISOString(),
  raw: {},
  ...over,
});

const handler = (over: Partial<HookHandler> & Pick<HookHandler, "id">): HookHandler => ({
  events: ["SessionStart"],
  run: () => undefined,
  ...over,
});

describe("hook registry", () => {
  test("events_are_derived_from_the_handlers_in_registration_order_without_repeats", () => {
    const registry = new HookRegistry()
      .register(handler({ id: "a", events: ["SessionStart", "Stop"] }))
      .register(handler({ id: "b", events: ["Stop", "PreToolUse"] }));
    expect(registry.events("claude-code")).toEqual(["SessionStart", "Stop", "PreToolUse"]);
  });

  test("a_handler_limited_to_agents_adds_its_events_only_for_them", () => {
    const registry = new HookRegistry()
      .register(handler({ id: "a" }))
      .register(handler({ id: "b", events: ["PreToolUse"], agents: ["codex"] }));
    expect(registry.events("codex")).toEqual(["SessionStart", "PreToolUse"]);
    expect(registry.events("claude-code")).toEqual(["SessionStart"]);
    expect(registry.handlersFor("claude-code", "PreToolUse")).toEqual([]);
  });

  test("a_second_handler_with_the_same_id_is_refused", () => {
    const registry = new HookRegistry().register(handler({ id: "a" }));
    expect(() => registry.register(handler({ id: "a" }))).toThrow("already registered");
  });

  test("a_new_handler_for_a_registered_event_does_not_change_the_events", () => {
    const registry = new HookRegistry().register(handler({ id: "a" }));
    const before = registry.events("claude-code");
    registry.register(handler({ id: "b" }));
    expect(registry.events("claude-code")).toEqual(before);
  });

  test("stale_events_name_what_is_missing_and_what_is_extra", () => {
    expect(staleHookEvents(["SessionStart", "Old"], ["SessionStart", "Stop"])).toEqual({
      missing: ["Stop"],
      extra: ["Old"],
    });
  });
});

describe("hook dispatch", () => {
  test("a_handler_that_throws_is_reported_and_the_others_still_run", async () => {
    const ran: string[] = [];
    const registry = new HookRegistry()
      .register(
        handler({
          id: "bad",
          run: () => {
            throw new Error("boom");
          },
        }),
      )
      .register(handler({ id: "async-bad", run: async () => Promise.reject(new Error("later")) }))
      .register(handler({ id: "good", run: () => void ran.push("good") }));
    const { timer } = manualTimer();
    const result = await dispatch(registry, event(), { root: "/p" }, { timer, timeoutMs: 1000 });
    expect(ran).toEqual(["good"]);
    expect(result.failures).toEqual([
      { handler: "bad", reason: "boom" },
      { handler: "async-bad", reason: "later" },
    ]);
  });

  test("a_handler_that_takes_too_long_times_out_and_the_others_still_run", async () => {
    const ran: string[] = [];
    const registry = new HookRegistry()
      .register(handler({ id: "slow", run: () => new Promise<void>(() => {}) }))
      .register(handler({ id: "good", run: () => void ran.push("good") }));
    const { timer, fireAll } = manualTimer();
    const pending = dispatch(registry, event(), { root: "/p" }, { timer, timeoutMs: 50 });
    await Promise.resolve();
    await Promise.resolve();
    fireAll();
    const result = await pending;
    expect(ran).toEqual(["good"]);
    expect(result.failures).toEqual([{ handler: "slow", reason: "timed out after 50 ms" }]);
  });

  test("the_timer_of_a_finished_handler_is_cancelled", async () => {
    const registry = new HookRegistry().register(handler({ id: "quick" }));
    const { timer, fireAll } = manualTimer();
    await dispatch(registry, event(), { root: "/p" }, { timer, timeoutMs: 50 });
    // Nothing is left to fire: a late timer would reject a promise nobody awaits.
    expect(() => fireAll()).not.toThrow();
  });

  test("a_handler_prints_only_when_it_says_it_may", async () => {
    const registry = new HookRegistry()
      .register(handler({ id: "quiet", run: () => "ignored" }))
      .register(handler({ id: "loud", prints: true, run: () => "wanted" }));
    const { timer } = manualTimer();
    const result = await dispatch(registry, event(), { root: "/p" }, { timer, timeoutMs: 1000 });
    expect(result.output).toBe("wanted");
  });

  test("output_keeps_the_order_of_registration_not_of_finishing", async () => {
    const registry = new HookRegistry()
      .register(
        handler({
          id: "first",
          prints: true,
          run: async () => {
            await new Promise((r) => setTimeout(r, 15));
            return "1";
          },
        }),
      )
      .register(handler({ id: "second", prints: true, run: () => "2" }));
    const { timer } = manualTimer();
    const result = await dispatch(registry, event(), { root: "/p" }, { timer, timeoutMs: 1000 });
    expect(result.output).toBe("12");
  });

  test("an_event_nobody_asked_for_runs_nothing", async () => {
    const registry = new HookRegistry().register(
      handler({
        id: "a",
        run: () => {
          throw new Error("must not run");
        },
      }),
    );
    const { timer } = manualTimer();
    const result = await dispatch(
      registry,
      event({ name: "PreToolUse" }),
      { root: "/p" },
      { timer, timeoutMs: 1000 },
    );
    expect(result).toEqual({ output: "", failures: [] });
  });
});

describe("hook normalizers", () => {
  const cases: [HookAgent, (p: unknown, n: Date) => HookEvent | undefined][] = [
    ["claude-code", normalizeClaudeCode],
    ["codex", normalizeCodex],
    ["opencode", normalizeOpenCode],
  ];

  for (const [agent, normalize] of cases) {
    const dir = join(FIXTURES, agent);
    for (const file of readdirSync(dir)) {
      const name = file.replace(/\.json$/, "");
      test(`${agent}_${name}_from_a_real_payload_becomes_an_event`, () => {
        const payload = fixture(agent, name);
        const got = normalize(payload, NOW);
        expect(got?.agent).toBe(agent);
        expect(got?.name).toBe(name);
        expect(got?.session_id).toBe(payload.session_id as string);
        expect(got?.cwd).toBe(payload.cwd as string);
        expect(got?.ts).toBe(NOW.toISOString());
        expect(got?.raw).toBe(payload);
        if (typeof payload.tool_name === "string") expect(got?.tool).toBe(payload.tool_name);
        if (typeof payload.transcript_path === "string") {
          expect(got?.transcript_path).toBe(payload.transcript_path);
        }
      });
    }
  }

  test("the_tool_is_set_for_tool_events_and_not_for_others", () => {
    expect(normalizeClaudeCode(fixture("claude-code", "PreToolUse"), NOW)?.tool).toBe("Bash");
    expect(normalizeClaudeCode(fixture("claude-code", "SessionStart"), NOW)?.tool).toBeUndefined();
  });

  test("a_codex_payload_with_a_null_transcript_still_makes_an_event", () => {
    const payload = { ...fixture("codex", "SessionStart"), transcript_path: null };
    const got = normalizeCodex(payload, NOW);
    expect(got?.name).toBe("SessionStart");
    expect(got?.transcript_path).toBeUndefined();
  });

  test("unknown_fields_are_kept_in_raw_and_do_not_matter", () => {
    const payload = { ...fixture("claude-code", "SessionStart"), invented: { deep: [1] } };
    expect(normalizeClaudeCode(payload, NOW)?.raw.invented).toEqual({ deep: [1] });
  });

  test("missing_or_wrong_fields_give_no_event_and_never_throw", () => {
    const good = fixture("claude-code", "SessionStart");
    for (const key of ["hook_event_name", "session_id", "cwd"]) {
      const { [key]: _gone, ...rest } = good;
      expect(normalizeClaudeCode(rest, NOW)).toBeUndefined();
      expect(normalizeClaudeCode({ ...good, [key]: 42 }, NOW)).toBeUndefined();
      expect(normalizeClaudeCode({ ...good, [key]: "" }, NOW)).toBeUndefined();
    }
    for (const bad of [null, undefined, 7, "SessionStart", [], [good], true]) {
      expect(normalizeClaudeCode(bad, NOW)).toBeUndefined();
    }
  });

  test("a_hostile_event_name_or_id_is_refused", () => {
    const good = fixture("claude-code", "SessionStart");
    for (const over of [
      { hook_event_name: "Session Start" },
      { hook_event_name: "../x" },
      { hook_event_name: "A".repeat(65) },
      { session_id: "s\u001b[31m" },
      { session_id: "a\nb" },
      { session_id: "x".repeat(201) },
      { cwd: "/p\u0000q" },
      { cwd: "/".repeat(4097) },
    ]) {
      expect(normalizeClaudeCode({ ...good, ...over }, NOW)).toBeUndefined();
    }
  });

  test("a_hostile_optional_field_is_dropped_but_the_event_stays", () => {
    const good = fixture("claude-code", "PreToolUse");
    const got = normalizeClaudeCode(
      { ...good, transcript_path: "/t\u001b[2J", tool_name: "x".repeat(65) },
      NOW,
    );
    expect(got?.name).toBe("PreToolUse");
    expect(got?.transcript_path).toBeUndefined();
    expect(got?.tool).toBeUndefined();
  });

  test("normalize_hook_payload_picks_the_normalizer_by_agent", () => {
    const payload = fixture("codex", "SessionStart");
    expect(normalizeHookPayload("codex", payload, NOW)?.agent).toBe("codex");
    expect(normalizeHookPayload("opencode", payload, NOW)?.agent).toBe("opencode");
  });
});

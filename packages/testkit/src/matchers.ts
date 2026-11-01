import type { ScenarioState } from "./types";

export interface MatchResult {
  ok: boolean;
  expected: unknown;
  actual: unknown;
  detail: string;
}

/** `apply` compares the state with what the scenario expects. */
export interface Matcher {
  key: string;
  apply(state: ScenarioState, expected: unknown): MatchResult;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function subsetOf(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) picked[key] = actual[key];
  return { ok: same(picked, expected), picked };
}

const byNode = (state: ScenarioState, field: "attempt" | "status" | "outcome") =>
  Object.fromEntries(state.nodes.map((n) => [n.slug, n[field]]));

const builtins: Matcher[] = [
  {
    key: "runStatus",
    apply: (s, expected) => ({
      ok: s.runStatus === expected,
      expected,
      actual: s.runStatus,
      detail: "run status",
    }),
  },
  {
    key: "waitingGates",
    apply: (s, expected) => ({
      ok: same(s.waitingGates, expected),
      expected,
      actual: s.waitingGates,
      detail: "the human nodes the run waits on",
    }),
  },
  {
    key: "attempts",
    apply: (s, expected) => {
      const { ok, picked } = subsetOf(byNode(s, "attempt"), expected as Record<string, unknown>);
      return { ok, expected, actual: picked, detail: "attempts per node" };
    },
  },
  {
    key: "nodeStatus",
    apply: (s, expected) => {
      const { ok, picked } = subsetOf(byNode(s, "status"), expected as Record<string, unknown>);
      return { ok, expected, actual: picked, detail: "node status" };
    },
  },
  {
    key: "nodeOutcome",
    apply: (s, expected) => {
      const { ok, picked } = subsetOf(byNode(s, "outcome"), expected as Record<string, unknown>);
      return { ok, expected, actual: picked, detail: "node outcome label" };
    },
  },
  {
    key: "trail",
    apply: (s, expected) => ({
      ok: same(s.trail, expected),
      expected,
      actual: s.trail,
      detail: "nodes entered, in order (rework inside a node is not a new entry)",
    }),
  },
  {
    key: "executed",
    apply: (s, expected) => {
      const wanted = expected as string[];
      return {
        ok: wanted.every((slug) => s.trail.includes(slug)),
        expected,
        actual: [...new Set(s.trail)],
        detail: "nodes that were entered at least once",
      };
    },
  },
  {
    key: "never",
    apply: (s, expected) => {
      const forbidden = expected as string[];
      const hit = forbidden.filter((slug) => s.trail.includes(slug));
      return { ok: hit.length === 0, expected: [], actual: hit, detail: "nodes that must not run" };
    },
  },
  {
    key: "journalHas",
    apply: (s, expected) => {
      const wanted = ([] as string[]).concat(expected as string | string[]);
      const missing = wanted.filter((kind) => !s.journal.includes(kind));
      return {
        ok: missing.length === 0,
        expected: wanted,
        actual: missing.length === 0 ? wanted : { missing },
        detail: "journal event kinds that must be present",
      };
    },
  },
  {
    key: "journalLacks",
    apply: (s, expected) => {
      const forbidden = ([] as string[]).concat(expected as string | string[]);
      const hit = forbidden.filter((kind) => s.journal.includes(kind));
      return {
        ok: hit.length === 0,
        expected: [],
        actual: hit,
        detail: "journal event kinds that must be absent",
      };
    },
  },
];

/** A fresh registry per run (never a module singleton), optionally with custom matchers. */
export function createMatchers(extra: Matcher[] = []): Map<string, Matcher> {
  const registry = new Map<string, Matcher>();
  for (const m of [...builtins, ...extra]) registry.set(m.key, m);
  return registry;
}

export const BUILTIN_MATCHER_KEYS = builtins.map((m) => m.key);

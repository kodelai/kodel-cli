/**
 * A history collector for an invented agent whose files look nothing like Claude Code's: one JSON document
 * per session in `<project>/.fakeagent/<id>.json` (`{ version, entries: [...] }`), epoch-millisecond or ISO
 * times by version, usage given as a total with the cached part inside it. It proves that the collector
 * interface and the contract suite are not shaped after one agent, and that version profiles work: the two
 * profiles read the same facts from two different shapes.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type AgentHistoryCollector,
  type DraftEvent,
  type FormatProfile,
  HISTORY_FORMAT,
  type HistoryEvent,
  type HistoryWindow,
  inWindow,
  KodelError,
  newReadStats,
  type ReadOptions,
  type SessionRef,
  selectProfile,
  toTs,
} from "@kodel-ai/pipeline-core";

const MARKER = join(".kodel", "config.yaml");
const isProject = (root: string): Promise<boolean> =>
  stat(join(root, MARKER)).then(
    (s) => s.isFile(),
    () => false,
  );

export const FAKE_AGENT = "fake-agent";
export const FAKE_DIR = ".fakeagent";

interface Env {
  agent_version: string;
  session_id: string;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);

/** Versions below 2: `{ t: epoch ms, k: "msg" | "tool" | "use", ... }`; the input of a usage includes the cached part. */
function readV1(entry: unknown, env: Env): DraftEvent[] {
  const e = entry as Json;
  const ts = toTs(e["t"]);
  if (ts === undefined) return [];
  const base = { agent: FAKE_AGENT, ...env, ts };
  if (e["k"] === "msg")
    return [{ ...base, kind: "message", role: "user", text_preview: String(e["text"] ?? "") }];
  if (e["k"] === "tool") {
    const started = ts;
    const out: DraftEvent[] = [
      { ...base, kind: "tool_call", id: String(e["id"]), name: String(e["tool"]), started },
    ];
    const ended = toTs(e["done"]);
    if (ended !== undefined) {
      out.push({
        ...base,
        ts: ended,
        kind: "tool_result",
        id: String(e["id"]),
        ok: e["ok"] !== false,
        ended,
      });
    }
    return out;
  }
  if (e["k"] === "use") {
    return [
      {
        ...base,
        kind: "usage",
        model: String(e["model"] ?? "fake-1"),
        input: num(e["total_in"]),
        output: num(e["out"]),
        cache_read: num(e["cached"]),
        cache_write: 0,
        reasoning: 0,
        semantics: "overlap",
        message_id: String(e["id"]),
        cost: { basis: "unknown" },
      },
    ];
  }
  return [];
}

/** Versions 2 and later: `{ at: ISO, type: "message" | "call" | "usage", ... }`, cached tokens apart from the input. */
function readV2(entry: unknown, env: Env): DraftEvent[] {
  const e = entry as Json;
  const ts = toTs(e["at"]);
  if (ts === undefined) return [];
  const base = { agent: FAKE_AGENT, ...env, ts };
  if (e["type"] === "message") {
    return [{ ...base, kind: "message", role: "user", text_preview: String(e["text"] ?? "") }];
  }
  if (e["type"] === "call") {
    const out: DraftEvent[] = [
      { ...base, kind: "tool_call", id: String(e["id"]), name: String(e["name"]), started: ts },
    ];
    const ended = toTs(e["ended"]);
    if (ended !== undefined) {
      out.push({
        ...base,
        ts: ended,
        kind: "tool_result",
        id: String(e["id"]),
        ok: e["ok"] !== false,
        ended,
      });
    }
    return out;
  }
  if (e["type"] === "usage") {
    return [
      {
        ...base,
        kind: "usage",
        model: String(e["model"] ?? "fake-2"),
        input: num(e["input"]),
        output: num(e["output"]),
        cache_read: num(e["cache_read"]),
        cache_write: num(e["cache_write"]),
        reasoning: 0,
        semantics: "additive",
        message_id: String(e["id"]),
        cost: { basis: "unknown" },
      },
    ];
  }
  return [];
}

export const FAKE_PROFILES: readonly FormatProfile<unknown, Env, DraftEvent>[] = [
  { id: "fa-1", versions: "<2.0.0", normalize: readV1 },
  { id: "fa-2", versions: ">=2.0.0", normalize: readV2 },
];

export function fakeAgentCollector(): AgentHistoryCollector {
  async function* read(
    ref: SessionRef,
    window?: HistoryWindow,
    options: ReadOptions = {},
  ): AsyncGenerator<HistoryEvent> {
    if (!(await isProject(ref.project_root))) {
      throw new KodelError(
        "HISTORY_PATH_OUTSIDE_PROJECT",
        "the project root is not a Kodel project",
      );
    }
    const real = await realpath(ref.path).catch(() => resolve(ref.path));
    const root = await realpath(ref.project_root).catch(() => resolve(ref.project_root));
    const rel = relative(root, real);
    if (rel.startsWith("..") || resolve(root, rel) !== real) {
      throw new KodelError("HISTORY_PATH_OUTSIDE_PROJECT", "the session is outside the project");
    }
    let doc: { version?: unknown; entries?: unknown };
    try {
      doc = JSON.parse(await readFile(real, "utf8")) as typeof doc;
    } catch {
      throw new KodelError(
        "HISTORY_SESSION_UNREADABLE",
        `cannot read the session ${ref.session_id}`,
      );
    }
    const version = typeof doc.version === "string" ? doc.version : "";
    const { profile, match } = selectProfile(FAKE_PROFILES, version === "" ? undefined : version);
    const stats = options.stats ?? newReadStats();
    if (match !== "exact") stats.drift.push({ agent_version: version, profile: profile.id, match });
    const env: Env = { agent_version: version, session_id: ref.session_id };
    let seq = 0;
    for (const entry of Array.isArray(doc.entries) ? doc.entries : []) {
      stats.lines += 1;
      stats.profiles[profile.id] = (stats.profiles[profile.id] ?? 0) + 1;
      for (const draft of profile.normalize(entry, env)) {
        seq += 1;
        const event = { ...draft, v: HISTORY_FORMAT, seq } as HistoryEvent;
        if (inWindow(event, window)) yield event;
      }
    }
  }

  return {
    agent: FAKE_AGENT,
    profiles: FAKE_PROFILES,
    async locate(projectRoot) {
      if (!(await isProject(projectRoot))) return [];
      const dir = join(projectRoot, FAKE_DIR);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      return names
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => ({
          agent: FAKE_AGENT,
          session_id: n.slice(0, -".json".length),
          project_root: projectRoot,
          path: join(dir, n),
        }));
    },
    read,
  };
}

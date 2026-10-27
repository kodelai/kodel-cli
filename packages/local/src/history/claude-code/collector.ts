/**
 * The Claude Code history collector: `~/.claude/projects/<folder>/<session>.jsonl`, with the logs of
 * subagents in `<session>/subagents/agent-<id>.jsonl`.
 */
import { join } from "node:path";
import {
  type AgentHistoryCollector,
  type CaptureOptions,
  checkProfiles,
  type DraftEvent,
  HISTORY_FORMAT,
  type HistoryEvent,
  type HistoryWindow,
  inWindow,
  KodelError,
  type LocateOptions,
  newReadStats,
  type ReadCheckpoint,
  type ReadOptions,
  redactEvent,
  type SessionRef,
  selectProfile,
} from "@kodel-ai/pipeline-core";
import { streamJsonl } from "../jsonl";
import {
  assertInside,
  isFile,
  isInside,
  isKodelProject,
  projectWorkdirs,
  realOrSelf,
} from "../scope";
import { claudeConfigDir, firstCwd, locateClaudeSessions } from "./locate";
import {
  AGENT_ID,
  CLAUDE_PROFILES,
  type ClaudeState,
  flushPending,
  newClaudeState,
} from "./normalize";

/** What a read keeps between passes, so that the next pass continues where this one stopped. */
interface ReaderState {
  claude: ClaudeState;
  /** Events of a response that has not closed, in order; they were not given to the consumer. */
  unreleased: DraftEvent[];
  seq: number;
  lastTs: string;
  drifted: boolean;
}

export interface ClaudeCodeCollectorOptions {
  /** Where Claude Code keeps its data; `CLAUDE_CONFIG_DIR` or `~/.claude` when not given. */
  configDir?: string;
  /**
   * Remember the project's directories (30 s) and the `cwd` of each log between reads. For a consumer that reads the
   * same log every few seconds; a directory added in between is seen after the time is up.
   */
  cacheScope?: boolean;
}

const SCOPE_TTL_MS = 30_000;
const SCOPE_CACHE_ENTRIES = 512;

export function claudeCodeCollector(
  options: ClaudeCodeCollectorOptions = {},
): AgentHistoryCollector {
  const configDir = options.configDir ?? claudeConfigDir();
  const store = join(configDir, "projects");
  const problems = checkProfiles(CLAUDE_PROFILES);
  if (problems.length > 0) throw new Error(`claude-code profiles: ${problems.join("; ")}`);
  const dirsCache = new Map<string, { at: number; dirs: string[] }>();
  const cwdCache = new Map<string, string | undefined>();

  async function workdirsOf(root: string): Promise<string[]> {
    if (options.cacheScope !== true) return projectWorkdirs(root);
    const hit = dirsCache.get(root);
    if (hit !== undefined && Date.now() - hit.at < SCOPE_TTL_MS) return hit.dirs;
    const dirs = await projectWorkdirs(root);
    dirsCache.set(root, { at: Date.now(), dirs });
    return dirs;
  }

  async function cwdOf(path: string): Promise<string | undefined> {
    if (options.cacheScope !== true) return firstCwd(path);
    if (cwdCache.has(path)) return cwdCache.get(path);
    const found = await firstCwd(path);
    // A log with no `cwd` yet may get one when it grows; only a found one is kept.
    if (found !== undefined) {
      if (cwdCache.size >= SCOPE_CACHE_ENTRIES) cwdCache.clear();
      cwdCache.set(path, found);
    }
    return found;
  }

  async function* read(
    ref: SessionRef,
    window?: HistoryWindow,
    readOptions: ReadOptions = {},
  ): AsyncGenerator<HistoryEvent> {
    if (ref.agent !== AGENT_ID) {
      throw new KodelError("HISTORY_SESSION_UNREADABLE", `not a ${AGENT_ID} session: ${ref.agent}`);
    }
    if (!(await isKodelProject(ref.project_root))) {
      throw new KodelError(
        "HISTORY_PATH_OUTSIDE_PROJECT",
        "the project root is not a Kodel project: it has no project marker",
        undefined,
        { project_root: ref.project_root },
      );
    }
    await assertInside(ref.path, [store], "the session log");
    if (!(await isFile(ref.path))) {
      throw new KodelError(
        "HISTORY_SESSION_UNREADABLE",
        `the session log is not a file: ${ref.session_id}`,
      );
    }
    // A log in the agent's store belongs to a project by its own `cwd`; the one a ref carries is only a hint
    // (a hand-made ref can say anything), and a log of another project is not read.
    const workdirs = [
      ...(await workdirsOf(ref.project_root)),
      ...(await Promise.all((readOptions.extraWorkdirs ?? []).map((dir) => realOrSelf(dir)))),
    ];
    const cwd = await cwdOf(ref.path);
    const real = cwd === undefined ? undefined : await realOrSelf(cwd);
    if (real === undefined || !workdirs.some((dir) => isInside(dir, real))) {
      throw new KodelError(
        "HISTORY_PATH_OUTSIDE_PROJECT",
        `the session ${ref.session_id} does not belong to the project`,
        undefined,
        { session_id: ref.session_id },
      );
    }

    const stats = readOptions.stats ?? newReadStats();
    const capture: CaptureOptions | undefined = readOptions.capture;
    const holdBack = readOptions.holdBack === true;
    const resumed = readOptions.resume?.state as ReaderState | undefined;
    const reader: ReaderState = resumed ?? {
      claude: newClaudeState(ref.session_id, ref.parent_session_id, capture),
      unreleased: [],
      seq: 0,
      lastTs: "",
      drifted: false,
    };
    const state = reader.claude;
    const chosen = new Map<
      string,
      ReturnType<typeof selectProfile<(typeof CLAUDE_PROFILES)[number]>>
    >();
    const progress = { offset: readOptions.resume?.offset ?? readOptions.fromOffset ?? 0 };

    /** Numbers, redacts and windows the events of one step of the read; the numbering is part of the reader's state. */
    const shape = (drafts: DraftEvent[]): HistoryEvent[] => {
      const shaped: HistoryEvent[] = [];
      for (const draft of drafts) {
        reader.seq += 1;
        // The normalizer keeps time from going back; this is the same rule for the events it builds out of order.
        const ts = draft.ts < reader.lastTs ? reader.lastTs : draft.ts;
        reader.lastTs = ts;
        const event = redactEvent(
          { ...draft, ts, v: HISTORY_FORMAT, seq: reader.seq } as HistoryEvent,
          capture?.rules,
          capture?.skipIds === true ? { skipIds: true } : {},
        );
        if (inWindow(event, window)) shaped.push(event);
      }
      return shaped;
    };
    /**
     * Published before the events of an entry are given out, so the checkpoint is always one the state and the offset
     * agree on: a consumer that takes only some of an entry's events does not leave the checkpoint behind it.
     */
    const publish = (): void => {
      if (readOptions.checkpoint === undefined) return;
      readOptions.checkpoint.value = {
        offset: progress.offset,
        seq: reader.seq,
        state: reader,
      } satisfies ReadCheckpoint;
    };

    const counters = { lines: 0, invalid_lines: 0 };
    const skippedBefore = state.skipped;
    let stopped = false;
    // A read that ends at once (nothing new, or told to stop) still leaves a point to continue from.
    publish();
    try {
      for await (const entry of streamJsonl(ref.path, {
        counters,
        progress,
        start: progress.offset,
        ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
      })) {
        if (readOptions.shouldStop?.() === true) {
          stopped = true;
          break;
        }
        const version =
          typeof (entry as { version?: unknown } | null)?.version === "string"
            ? (entry as { version: string }).version
            : "";
        let choice = chosen.get(version);
        if (choice === undefined) {
          choice = selectProfile(CLAUDE_PROFILES, version === "" ? undefined : version);
          chosen.set(version, choice);
        }
        const { profile, match } = choice;
        const drafts = profile.normalize(entry, state);
        let closed = holdBack ? state.closedCount : drafts.length;
        if (drafts.length > 0 || match === "exact") {
          stats.profiles[profile.id] = (stats.profiles[profile.id] ?? 0) + 1;
        }
        if (
          match !== "exact" &&
          version !== "" &&
          !stats.drift.some((d) => d.agent_version === version)
        ) {
          stats.drift.push({ agent_version: version, profile: profile.id, match });
        }
        if (match !== "exact" && version !== "" && !reader.drifted && drafts.length > 0) {
          reader.drifted = true;
          const first = drafts[0];
          if (first !== undefined) {
            drafts.unshift({
              agent: AGENT_ID,
              agent_version: version,
              session_id: state.sessionId,
              ...(state.parentSessionId === undefined
                ? {}
                : { parent_session_id: state.parentSessionId }),
              ts: first.ts,
              kind: "system",
              subtype: "format_drift",
              detail: `read with profile ${profile.id} (${match})`,
            });
            if (closed > 0) closed += 1;
          }
        }
        let given: HistoryEvent[];
        if (holdBack) {
          const settled = [...reader.unreleased, ...drafts.slice(0, closed)];
          reader.unreleased = drafts.slice(closed);
          given = shape(settled);
        } else {
          given = shape(drafts);
        }
        publish();
        yield* given;
      }
      if (!holdBack) {
        const rest = shape(flushPending(state));
        publish();
        yield* rest;
      } else if (!stopped) {
        // Lines that gave no entry (a damaged line, a torn one) still move the offset.
        publish();
      }
    } finally {
      // Also when the consumer stops early (a window, an abort): what was read is still counted.
      stats.lines += counters.lines;
      stats.invalid_lines += counters.invalid_lines;
      stats.skipped_entries += state.skipped - skippedBefore;
    }
  }

  return {
    agent: AGENT_ID,
    profiles: CLAUDE_PROFILES,
    locate: (root: string, locateOptions?: LocateOptions) =>
      locateClaudeSessions(root, store, locateOptions),
    read,
  };
}

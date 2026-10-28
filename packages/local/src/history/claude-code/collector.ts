/**
 * The Claude Code history collector: `~/.claude/projects/<folder>/<session>.jsonl`, with the logs of
 * subagents in `<session>/subagents/agent-<id>.jsonl`.
 */
import { join } from "node:path";
import {
  type AgentHistoryCollector,
  checkProfiles,
  type DraftEvent,
  HISTORY_FORMAT,
  type HistoryEvent,
  type HistoryWindow,
  inWindow,
  KodelError,
  type LocateOptions,
  newReadStats,
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
import { claudeConfigDir, firstCwd, type IndexLocator, locateClaudeSessions } from "./locate";
import { AGENT_ID, CLAUDE_PROFILES, flushPending, newClaudeState } from "./normalize";

export interface ClaudeCodeCollectorOptions {
  /** Where Claude Code keeps its data; `CLAUDE_CONFIG_DIR` or `~/.claude` when not given. */
  configDir?: string;
  /**
   * Where the hook's session index of a project is. Absent: asked of the project's config with the
   * line matcher the hook uses (which is what the host resolves too, since the loader enforces that
   * they agree). A caller that already knows the place can pass it.
   */
  indexLocator?: IndexLocator;
}

export function claudeCodeCollector(
  options: ClaudeCodeCollectorOptions = {},
): AgentHistoryCollector {
  const configDir = options.configDir ?? claudeConfigDir();
  const store = join(configDir, "projects");
  const problems = checkProfiles(CLAUDE_PROFILES);
  if (problems.length > 0) throw new Error(`claude-code profiles: ${problems.join("; ")}`);

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
    const workdirs = await projectWorkdirs(ref.project_root);
    const cwd = await firstCwd(ref.path);
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
    const state = newClaudeState(ref.session_id, ref.parent_session_id);
    const chosen = new Map<
      string,
      ReturnType<typeof selectProfile<(typeof CLAUDE_PROFILES)[number]>>
    >();
    let seq = 0;
    let lastTs = "";
    let drifted = false;

    const emit = function* (drafts: DraftEvent[]): Generator<HistoryEvent> {
      for (const draft of drafts) {
        seq += 1;
        // The normalizer keeps time from going back; this is the same rule for the events it builds out of order.
        const ts = draft.ts < lastTs ? lastTs : draft.ts;
        lastTs = ts;
        const event = redactEvent({ ...draft, ts, v: HISTORY_FORMAT, seq } as HistoryEvent);
        if (inWindow(event, window)) yield event;
      }
    };

    const counters = { lines: 0, invalid_lines: 0 };
    try {
      for await (const entry of streamJsonl(ref.path, {
        counters,
        ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
      })) {
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
        if (match !== "exact" && version !== "" && !drifted && drafts.length > 0) {
          drifted = true;
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
          }
        }
        yield* emit(drafts);
      }
      yield* emit(flushPending(state));
    } finally {
      // Also when the consumer stops early (a window, an abort): what was read is still counted.
      stats.lines += counters.lines;
      stats.invalid_lines += counters.invalid_lines;
      stats.skipped_entries += state.skipped;
    }
  }

  return {
    agent: AGENT_ID,
    profiles: CLAUDE_PROFILES,
    locate: (root: string, locateOptions?: LocateOptions) =>
      locateClaudeSessions(root, store, locateOptions, options.indexLocator),
    read,
  };
}

/**
 * The state of the runs as `planServe` and `admitStart` read it: every run of the project as a
 * `ServeRunView`, the runs that cannot be read, and the worker records behind them. The daemon reads it
 * every cycle; a start by hand (the manager, the web UI, the TUI) reads it under the start lock, so both
 * count places and open runs the same way.
 */
import {
  capabilitiesOf,
  type JournalRecord,
  KodelError,
  type NextStep,
} from "@kodel-ai/pipeline-core";
import {
  decisionOf,
  lastAgentCallOf,
  type ServeRunView,
  type ServeUnreadableRun,
  type ServeWorkerView,
} from "@kodel-ai/pipeline-core/serve";
import type { RunSummary } from "../pipeline-host";
import type { RunMeta } from "../store";

/** How long the journal of a run whose worker is alive is believed: it is read at most this often. */
export const LIVE_JOURNAL_TTL_MS = 60_000;

export const ENDED = ["completed", "failed", "canceled"];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The part of a run the reading uses. */
export interface GatherRunPort {
  journal(): Promise<JournalRecord[]>;
  inspect(): Promise<NextStep>;
  integrityStatus(): Promise<"ok" | "modified" | "unknown">;
}

/** The part of the host the reading uses. */
export interface GatherHostPort {
  open(runId: string): Promise<GatherRunPort | undefined>;
  /** Every run; a run `skip` names comes back `skipped`, its state not read. */
  runSummaries(options?: { skip?: (runId: string) => boolean }): Promise<RunSummary[]>;
  /** The root of another checkout that made the run, when it is not this one. */
  foreignRootOf?(meta: RunMeta): string | undefined;
}

export interface GatherLauncherPort {
  /** The latest record of each run named; a run without a record is absent. Throws when the records cannot be read. */
  statuses(runIds: readonly string[]): Promise<Map<string, ServeWorkerView>>;
}

export interface GatheredRuns {
  runs: ServeRunView[];
  unreadable: ServeUnreadableRun[];
  /** Runs of this checkout that cannot be read, have no worker record and are not known to have ended. */
  unreadableOpen: string[];
}

/** Why a run that a worker had cannot be read, in the three words the history rules keep apart. */
export function unreadableWhy(code: string, message: string): ServeUnreadableRun["why"] {
  if (code === "STATE_MODIFIED_EXTERNALLY") return "modified";
  if (/newer kodel/.test(message)) return "newer";
  return "cannot_read";
}

export const unreadableWords: Record<ServeUnreadableRun["why"], string> = {
  cannot_read: "cannot read",
  newer: "written by a newer kodel, upgrade kodel",
  modified: "was modified",
};

/**
 * A reader of the runs. It keeps what it learned between reads (an ended run is not read again, the
 * journal of a live worker is believed for a minute), so the daemon makes one for its life and a start
 * by hand makes one for each call.
 */
export function createRunGatherer(deps: {
  host: GatherHostPort;
  launcher: GatherLauncherPort;
  now: () => number;
  /** A line said once per change of the condition behind `topic`; `undefined` clears it. */
  sayOnChange?: (topic: string, line: string | undefined) => void;
}): { gather(): Promise<GatheredRuns> } {
  const now = deps.now;
  const sayOnChange = deps.sayOnChange ?? (() => undefined);
  /** Ended runs, read once: nothing about them changes any more. */
  const ended = new Map<string, ServeRunView>();
  // Ended runs of this checkout whose worker may still be alive (an agent finishing its last answer, a run
  // canceled under it): their records are read until the worker has stopped, so it keeps its worker place.
  const endedWatch = new Set<string>();
  /** What the journal of a run with a live worker said when it was last read, and the run's answer then. */
  const liveJournals = new Map<
    string,
    {
      at: number;
      waiting: boolean;
      marks: ReturnType<typeof decisionOf>;
      noted: string[];
      lastAgentAt?: number;
    }
  >();

  /** The runs as the plan sees them, and the ones that cannot be read. Throws, naming what, when the runs or the worker records cannot be read. */
  const gather = async (): Promise<GatheredRuns> => {
    // An ended run's state is not read again: with many runs that would be every state file every cycle.
    const summaries = await deps.host
      .runSummaries({ skip: (runId) => ended.has(runId) })
      .catch((error: unknown) => {
        throw new Error(`the runs cannot be read: ${messageOf(error)}`);
      });
    const runs: ServeRunView[] = [];
    const own: { summary: RunSummary; runId: string }[] = [];
    const broken: RunSummary[] = [];
    for (const summary of summaries) {
      const runId = summary.meta.runId;
      const known = ended.get(runId);
      if (known !== undefined) {
        if (!endedWatch.has(runId)) runs.push(known);
        continue;
      }
      const state = summary.state;
      if (state === undefined) {
        if (deps.host.foreignRootOf?.(summary.meta) === undefined) broken.push(summary);
        continue;
      }
      const base: ServeRunView = {
        runId,
        status: state.status,
        canNote: false,
        ...(state.taskKey === undefined ? {} : { taskKey: state.taskKey }),
        ...(deps.host.foreignRootOf?.(summary.meta) === undefined
          ? {}
          : { foreign: true as const }),
        waitsForPerson: false,
        noted: [],
      };
      if (ENDED.includes(state.status)) {
        ended.set(runId, base);
        if (deps.host.foreignRootOf?.(summary.meta) === undefined) endedWatch.add(runId);
        else runs.push(base);
      } else if (deps.host.foreignRootOf?.(summary.meta) !== undefined) {
        // Another checkout's run: it names its task, but its worker is not this daemon's business.
        runs.push(base);
      } else {
        own.push({ summary, runId });
      }
    }
    const watched = [...endedWatch].filter((id) => ended.has(id));
    const ids = [...own.map((o) => o.runId), ...broken.map((b) => b.meta.runId), ...watched];
    const workers =
      ids.length === 0
        ? new Map<string, ServeWorkerView>()
        : await deps.launcher.statuses(ids).catch((error: unknown) => {
            throw new Error(`the worker records cannot be read: ${messageOf(error)}`);
          });
    // Where the process table cannot be read an agent left behind a wrapper that died is not seen:
    // the recorded process alone answers, and it is said once.
    sayOnChange(
      "process-table",
      [...workers.values()].some((worker) => worker.groupUnread === true)
        ? "environment: cannot read the process table: an agent left behind a dead wrapper would not be seen"
        : undefined,
    );
    for (const runId of watched) {
      const view = ended.get(runId) as ServeRunView;
      const worker = workers.get(runId);
      if (
        worker !== undefined &&
        (worker.state === "starting" ||
          worker.state === "running" ||
          worker.state === "unknown" ||
          // Its process still runs without a holder: alive, until a person stops it.
          worker.childAlive === true)
      ) {
        runs.push({ ...view, worker });
      } else {
        endedWatch.delete(runId);
        runs.push(view);
      }
    }
    const unreadable: ServeUnreadableRun[] = [];
    const unreadableOpen: string[] = [];
    for (const summary of broken) {
      const worker = workers.get(summary.meta.runId);
      if (worker === undefined) {
        // It holds no place, but its task is not known: tasks with a conflict wait for it (T-45).
        unreadableOpen.push(summary.meta.runId);
        continue;
      }
      const code = summary.unreadable?.code ?? "ERROR";
      const message = summary.unreadable?.message ?? "cannot read";
      const why = unreadableWhy(code, message);
      unreadable.push({
        runId: summary.meta.runId,
        why,
        detail: `${unreadableWords[why]}: ${message}`,
        worker,
      });
    }
    for (const { summary, runId } of own) {
      const state = summary.state as NonNullable<RunSummary["state"]>;
      const worker = workers.get(runId);
      const base: ServeRunView = {
        runId,
        status: state.status,
        canNote: capabilitiesOf(state.v).workerNotes,
        ...(state.taskKey === undefined ? {} : { taskKey: state.taskKey }),
        waitsForPerson: false,
        noted: [],
        ...(worker === undefined ? {} : { worker }),
      };
      const settled =
        worker !== undefined &&
        (worker.state === "exited" || worker.state === "lost" || worker.state === "killed");
      // A worker in a terminal stays alive at a wait: whether its run only waits for the person is
      // asked every cycle, because that is what frees its worker place.
      const liveTerminal =
        worker !== undefined &&
        worker.terminal === true &&
        (worker.state === "starting" || worker.state === "running");
      if (!settled && !liveTerminal) {
        liveJournals.delete(runId);
        runs.push(base);
        continue;
      }
      try {
        const run = await deps.host.open(runId);
        if (run === undefined) throw new KodelError("UNKNOWN_RUN", `there is no run "${runId}"`);
        const next = await run.inspect();
        const waiting = "waiting" in next;
        const at = now();
        const kept = liveTerminal ? liveJournals.get(runId) : undefined;
        // The journal of a live worker's run is read at most once a minute, and when its answer changed
        // (a decision, a new wait); a worker that ended is read every cycle, as before.
        let read = kept;
        if (kept === undefined || kept.waiting !== waiting || at - kept.at >= LIVE_JOURNAL_TTL_MS) {
          if ((await run.integrityStatus()) === "modified") {
            throw new KodelError(
              "STATE_MODIFIED_EXTERNALLY",
              `the state of run ${runId} was changed outside kodel`,
            );
          }
          const journal = await run.journal();
          const lastAgentAt = lastAgentCallOf(journal);
          read = {
            at,
            waiting,
            marks: decisionOf(journal),
            noted: journal
              .filter((r) => r.event === "worker_note")
              .map((r) => (typeof r.id === "string" ? r.id : String(r.worker))),
            ...(lastAgentAt === undefined ? {} : { lastAgentAt }),
          };
        }
        if (liveTerminal) liveJournals.set(runId, read as NonNullable<typeof read>);
        else liveJournals.delete(runId);
        const known = read as NonNullable<typeof read>;
        runs.push({
          ...base,
          waitsForPerson: waiting,
          ...(liveTerminal ? { idleAtWait: waiting } : {}),
          marks: known.marks,
          noted: known.noted,
          ...(known.lastAgentAt === undefined ? {} : { lastAgentAt: known.lastAgentAt }),
          marksAt: known.at,
        });
      } catch (error) {
        // A read that failed keeps both places of a live worker (the unreadable path), and is tried again.
        liveJournals.delete(runId);
        const code = error instanceof KodelError ? error.code : "ERROR";
        const why = unreadableWhy(code, messageOf(error));
        unreadable.push({
          runId,
          why,
          detail: `${unreadableWords[why]}: ${messageOf(error)}`,
          ...(worker === undefined ? {} : { worker }),
        });
      }
    }
    // A run that left the list (it ended, or is another checkout's now) is not read here again.
    const listed = new Set(own.map((o) => o.runId));
    for (const runId of liveJournals.keys()) if (!listed.has(runId)) liveJournals.delete(runId);
    return { runs, unreadable, unreadableOpen };
  };
  return { gather };
}

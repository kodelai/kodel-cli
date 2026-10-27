/** Reads the runs of a project into sessions. Read-only: nothing here writes, decides or restarts work. */
import {
  type JournalRecord,
  KodelError,
  type NextStep,
  type RunState,
  runSlug,
} from "@kodel-ai/pipeline-core";
import {
  type Activity,
  formatAge,
  HEARTBEAT_STALE_MS,
  type Need,
  QUIET_MS,
  type Session,
  type StepLine,
  type StepState,
} from "./session";

/** The part of a run the screens read; `LocalRun` fits it. */
export interface RunHandle {
  integrityStatus(): Promise<"ok" | "modified" | "unknown">;
  sealStatus(): Promise<"sealed" | "modified" | "unsealed" | "open">;
  inspect(): Promise<NextStep>;
  journal(): Promise<JournalRecord[]>;
}

/** The part of the host the screens read; `LocalPipelineHost` fits it. */
export interface SessionSource {
  runSummaries(): Promise<
    {
      meta: {
        runId: string;
        pipeline: string;
        task: string;
        slug?: string;
        createdAt: number;
        workdir?: string;
      };
      state: RunState | undefined;
    }[]
  >;
  open(runId: string): Promise<RunHandle | undefined>;
  pipelineProposals(): Promise<unknown[]>;
}

export interface Loaded {
  sessions: Session[];
  /** Pipelines the agent proposed outside a run, which wait for a person. */
  proposals: number;
}

const PAUSE_TEXT = {
  consecutive: "a step failed too many times in a row",
  total: "a step used up all its attempts",
  restarts: "engine work kept getting interrupted",
} as const;

const STEP_STATE: Record<string, StepState> = {
  pending: "pending",
  running: "running",
  rework: "running",
  waiting: "waiting",
  passed: "done",
  failed: "failed",
  skipped: "pending",
};

export async function loadSessions(source: SessionSource, now: number): Promise<Loaded> {
  const [summaries, proposals] = await Promise.all([
    source.runSummaries(),
    source.pipelineProposals().catch(() => []),
  ]);
  const sessions = await Promise.all(summaries.map((s) => buildSession(source, s, now)));
  return { sessions, proposals: proposals.length };
}

type Summary = Awaited<ReturnType<SessionSource["runSummaries"]>>[number];

async function buildSession(
  source: SessionSource,
  { meta, state }: Summary,
  now: number,
): Promise<Session> {
  const base = {
    id: meta.runId,
    title: meta.slug ?? state?.slug ?? runSlug(undefined, meta.task),
    pipeline: meta.pipeline,
    ...(meta.workdir === undefined ? {} : { workdir: meta.workdir }),
    steps: [] as StepLine[],
    log: [] as string[],
  };
  if (!state) {
    return unreadable(
      base,
      meta.createdAt,
      "The state of this run cannot be read",
      "It was written by another version of kodel, or the file is damaged.",
    );
  }
  let run: RunHandle | undefined;
  try {
    run = await source.open(meta.runId);
  } catch (error) {
    return problem(
      { ...base, steps: stepLines(state) },
      error,
      state.startedAt,
      "This run cannot be opened",
    );
  }
  if (!run) {
    return unreadable(
      base,
      state.startedAt,
      "This run cannot be opened",
      "Its pipeline is not available.",
    );
  }
  const journal = await run.journal().catch(() => [] as JournalRecord[]);
  const full = { ...base, steps: stepLines(state), log: logLines(journal, now) };
  const ended =
    state.status === "completed" || state.status === "failed" || state.status === "canceled";

  const trust = ended
    ? await run.sealStatus().catch(() => "sealed")
    : await run.integrityStatus().catch(() => "ok");
  if (trust === "modified") {
    return waiting(
      full,
      "hand_edit",
      lastTs(journal, "manual_edit") ?? state.finishedAt ?? state.startedAt,
      {
        step: "hand edit",
        headline: "Files of this run were changed outside kodel",
        prompt: "Look at what changed, then accept the run as it is now.",
      },
    );
  }
  if (ended) return finished(full, state, journal);

  let next: NextStep;
  try {
    next = await run.inspect();
  } catch (error) {
    return problem(full, error, state.startedAt, "This run cannot be read");
  }
  if ("waiting" in next) return fromWaiting(full, state, journal, next.waiting);
  return running(full, state, journal, "running" in next, now);
}

/** A run that refuses to open: changed by hand (a person can accept it) or unreadable (nothing to decide). */
function problem(base: Base, error: unknown, since: number, headline: string): Session {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof KodelError && error.code === "STATE_MODIFIED_EXTERNALLY") {
    return waiting(base, "hand_edit", since, {
      step: "hand edit",
      headline: "Files of this run were changed outside kodel",
      prompt: message,
    });
  }
  return unreadable(base, since, headline, message);
}

function unreadable(base: Base, since: number, headline: string, prompt: string): Session {
  return { ...base, status: "unreadable", step: "unreadable", since, headline, prompt };
}

type Base = Pick<Session, "id" | "title" | "pipeline" | "steps" | "log"> & { workdir?: string };

function waiting(
  base: Base,
  need: Need,
  since: number,
  fields: Pick<Session, "step" | "headline"> & Partial<Session>,
): Session {
  return { ...base, status: "waiting", need, since, ...fields };
}

type Waiting = Extract<NextStep, { waiting: unknown }>["waiting"];

function fromWaiting(base: Base, state: RunState, journal: JournalRecord[], w: Waiting): Session {
  const command = w.how_to_decide.cli;
  if (w.reason === "pipeline_changed") {
    const edited = w.pipeline_change?.source === "file";
    const after =
      w.behind === "gate"
        ? `approve «${w.node_slug}»`
        : w.behind === "paused"
          ? "resume the run"
          : "the run goes on after the current step";
    return waiting(
      base,
      "pipeline_edit",
      lastTs(journal, "pipeline_change_proposed") ?? sinceLast(journal, state),
      {
        step: "pipeline edit",
        headline: edited
          ? "The pipeline file of this run was edited"
          : "The agent proposes to change this run's pipeline",
        prompt: w.prompt,
        after,
        command,
      },
    );
  }
  if (w.reason === "paused") {
    const why = state.pause ? PAUSE_TEXT[state.pause.reason] : "the run stopped";
    return waiting(base, "paused", lastTs(journal, "run_paused") ?? sinceLast(journal, state), {
      step: "paused",
      headline: `Paused at «${w.node_slug}»: ${why}`,
      prompt: w.prompt,
      command,
    });
  }
  return waiting(base, "approve", lastTs(journal, "gate_waiting") ?? sinceLast(journal, state), {
    step: "approve",
    headline: `Step «${w.node_slug}» waits for your decision`,
    prompt: w.prompt,
    command,
  });
}

function running(
  base: Base,
  state: RunState,
  journal: JournalRecord[],
  engine: boolean,
  now: number,
): Session {
  const visit = state.active[0];
  const heard = journal.at(-1)?.ts ?? state.startedAt;
  let activity: Activity;
  let quietMs: number | undefined;
  if (engine) {
    const beat = visit?.heartbeatAt ?? heard;
    activity = now - beat > HEARTBEAT_STALE_MS ? "quiet" : "working";
    if (activity === "quiet") quietMs = now - beat;
  } else {
    activity = now - heard > QUIET_MS ? "quiet" : "agent";
    if (activity === "quiet") quietMs = now - heard;
  }
  return {
    ...base,
    status: "running",
    activity,
    ...(quietMs === undefined ? {} : { quietMs }),
    step: quietMs === undefined ? (visit?.node ?? "…") : `quiet ${formatAge(quietMs)}`,
    since: state.startedAt,
  };
}

function finished(base: Base, state: RunState, journal: JournalRecord[]): Session {
  const since = state.finishedAt ?? state.startedAt;
  if (state.status === "completed") return { ...base, status: "done", step: "done", since };
  if (state.status === "canceled") return { ...base, status: "canceled", step: "canceled", since };
  const end = journal.findLast((r) => r.event === "run_finished");
  const lastNode = journal.findLast((r) => r.event === "node_finished");
  const reason = typeof end?.reason === "string" ? end.reason : "the run failed";
  return {
    ...base,
    status: "failed",
    step: typeof lastNode?.node === "string" ? lastNode.node : "failed",
    since,
    reason,
  };
}

function stepLines(state: RunState): StepLine[] {
  const seen = new Set<string>();
  const lines: StepLine[] = [];
  for (const slug of state.trail) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const node = state.nodes[slug];
    if (!node) continue;
    lines.push({
      name: slug,
      state: STEP_STATE[node.status] ?? "pending",
      ...(node.attempt > 1 ? { note: `attempt ${node.attempt}` } : {}),
    });
  }
  return lines;
}

function lastTs(journal: JournalRecord[], event: string): number | undefined {
  return journal.findLast((r) => r.event === event)?.ts;
}

/** A wait whose own record is not there: the latest sign of life is the nearest honest answer. */
function sinceLast(journal: JournalRecord[], state: RunState): number {
  return journal.at(-1)?.ts ?? state.startedAt;
}

const DETAIL_FIELDS = ["node", "outcome", "check", "reason", "code", "message"] as const;

function logLines(journal: JournalRecord[], now: number): string[] {
  return journal.slice(-14).map((r) => {
    const detail = DETAIL_FIELDS.flatMap((f) =>
      typeof r[f] === "string" ? [String(r[f])] : [],
    ).join(" ");
    const at = new Date(r.ts);
    const clock = at.toTimeString().slice(0, 8);
    const day =
      now - r.ts > 20 * 3_600_000
        ? `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} `
        : "";
    return `${day}${clock} ${r.event.padEnd(18)} ${detail}`.trimEnd();
  });
}

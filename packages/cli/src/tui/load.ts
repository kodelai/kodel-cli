/** Reads the runs of a project into sessions. Read-only: nothing here writes, decides or restarts work. */

import {
  cleanSessionName,
  EXECUTOR_SOURCES,
  type ExecutorSource,
  type JournalRecord,
  KodelError,
  type NextStep,
  type RunState,
  runSlug,
  SAFE_SESSION_ID,
} from "@kodel-ai/pipeline-core";
import type { PipeEntry } from "./pipelines";
import { canReadPipelines, loadPipelines } from "./pipes-load";
import {
  type Activity,
  type AgentSession,
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
  /** What the Pipeline screen shows; a source that cannot say gives none. */
  pipelines?: PipeEntry[];
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

/**
 * How long the pipelines are kept before they are read again. Reading them parses every pipeline file and
 * diffs every proposal, and the list of runs is read every two seconds, whichever screen is open.
 */
const PIPELINES_EVERY_MS = 10_000;

const pipelinesKept = new WeakMap<object, { at: number; key: string; entries: PipeEntry[] }>();

export async function loadSessions(source: SessionSource, now: number): Promise<Loaded> {
  const [summaries, proposals] = await Promise.all([
    source.runSummaries(),
    source.pipelineProposals().catch(() => []),
  ]);
  const sessions = await Promise.all(summaries.map((s) => buildSession(source, s, now)));
  if (!canReadPipelines(source)) return { sessions, proposals: proposals.length, pipelines: [] };
  // What is read again at once is what a person is waiting to see: a proposal, or a change of a run's
  // pipeline, that appeared or went. The rest can be a few seconds old.
  const key = [
    proposals.length,
    ...sessions.filter((s) => s.need === "pipeline_edit").map((s) => `${s.id}:${s.since}`),
  ].join("|");
  const kept = pipelinesKept.get(source);
  if (kept && kept.key === key && now - kept.at < PIPELINES_EVERY_MS) {
    return { sessions, proposals: proposals.length, pipelines: kept.entries };
  }
  const entries = await loadPipelines(source, sessions).catch(() => kept?.entries ?? []);
  pipelinesKept.set(source, { at: now, key, entries });
  return { sessions, proposals: proposals.length, pipelines: entries };
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
  const agentSession = agentSessionOf(journal);
  const full = {
    ...base,
    steps: stepLines(state),
    log: logLines(journal, now),
    ...(agentSession === undefined ? {} : { agentSession }),
  };
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

type Base = Pick<Session, "id" | "title" | "pipeline" | "steps" | "log"> & {
  workdir?: string;
  agentSession?: AgentSession;
};

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
    const pause = state.pauses?.[0];
    const why = pause ? PAUSE_TEXT[pause.reason] : "the run stopped";
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
  const heard = lastSign(journal) ?? state.startedAt;
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
  return lastSign(journal) ?? state.startedAt;
}

/** The name of a session changing says nothing about the agent: a rename must not make a stuck agent look alive. */
const NOT_A_SIGN_OF_LIFE = ["agent_session_named"];

function lastSign(journal: JournalRecord[]): number | undefined {
  return journal.findLast((r) => !NOT_A_SIGN_OF_LIFE.includes(r.event))?.ts;
}

// ── the agent session of a run ───────────────────────────────────────────────

/** The records that say who acted, and so in which session. */
const SESSION_RECORDS = ["run_started", "step_served", "agent_completed"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The session a record names, if it names a valid one: a journal can be edited or written by another engine. */
function sessionOf(record: JournalRecord): { id: string; source: ExecutorSource } | undefined {
  if (!SESSION_RECORDS.includes(record.event) || !isObject(record.executor)) return undefined;
  const session = record.executor.session;
  if (!isObject(session)) return undefined;
  const { value, source } = session;
  if (typeof value !== "string" || !SAFE_SESSION_ID.test(value)) return undefined;
  if (typeof source !== "string" || !(EXECUTOR_SOURCES as readonly string[]).includes(source)) {
    return undefined;
  }
  return { id: value, source: source as ExecutorSource };
}

/** The session of the newest record that names one, in the order the records were written. */
export function lastSession(
  journal: readonly JournalRecord[],
): { id: string; source: ExecutorSource } | undefined {
  for (let i = journal.length - 1; i >= 0; i--) {
    const found = sessionOf(journal[i] as JournalRecord);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The newest name the journal has for a session, from a record of the executor or from the event that
 * names a session; and whether the event names it at all, which is the copy of the agent's log saying the
 * session called this run's tools. The name is cleaned again here: the writer cleaned it, but a journal is
 * not trusted.
 */
export function sessionName(
  journal: readonly JournalRecord[],
  id: string,
): { name?: string; proven: boolean } {
  let name: string | undefined;
  let proven = false;
  for (let i = journal.length - 1; i >= 0; i--) {
    const record = journal[i] as JournalRecord;
    if (record.event === "agent_session_named") {
      if (record.session !== id) continue;
      proven = true;
      name ??= cleanSessionName(record.name);
    } else if (name === undefined && sessionOf(record)?.id === id) {
      const named = (record.executor as Record<string, unknown>).session_name;
      if (isObject(named)) name = cleanSessionName(named.value);
    }
  }
  return { ...(name === undefined ? {} : { name }), proven };
}

/** The session the run was last worked in, with its name, or nothing when the journal names none. */
export function agentSessionOf(journal: readonly JournalRecord[]): AgentSession | undefined {
  const last = lastSession(journal);
  if (last === undefined) return undefined;
  return { ...last, ...sessionName(journal, last.id) };
}

const DETAIL_FIELDS = ["node", "outcome", "check", "reason", "code", "message"] as const;

export function logLines(journal: JournalRecord[], now: number, last = 14): string[] {
  // The renaming of a session is not part of what happened to the run: no raw event name in the card.
  const shown = journal.filter((r) => !NOT_A_SIGN_OF_LIFE.includes(r.event));
  return shown.slice(-last).map((r) => {
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

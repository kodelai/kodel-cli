/**
 * The manager's reads over the local history (decision 5M9D): the inbox, a run's report, the files a
 * run changed, and the watch. Everything here reads: a run is looked at with `inspect()`, never with
 * the tick that restarts work, and nothing is journaled. The one effect outside the run's files is the
 * snapshotter's (`gateChanges`): it writes unreferenced objects into the repository's git object store,
 * as the gate answer and `kodel gate` do (`docs/mcp-roles.md`).
 */
import { randomBytes } from "node:crypto";
import {
  type AlsoWaiting,
  type GateChangesData,
  type InboxData,
  type InboxItem,
  KodelError,
  MANAGER_LIMITS,
  type ManagerHost,
  type NextStep,
  type PipelineChange,
  type RunState,
  type RunTaskLink,
  TASK_LIMITS,
  type WatchData,
  type WatchEvent,
} from "@kodel-ai/pipeline-core";
import { capChanges, type LocalRun } from "./host";
import type { LocalPipelineHost, RunSummary } from "./pipeline-host";
import type { ServeTasksPort } from "./serve/daemon";

export interface ManagerReadsOptions {
  host: Pick<
    LocalPipelineHost,
    | "runSummaries"
    | "foreignRootOf"
    | "open"
    | "historyRun"
    | "historyRedact"
    | "pipelineProposals"
    | "pipelineProposal"
  > & { taskLink?(): Promise<RunTaskLink | undefined> };
  /** The tracker, when tasks are on: the tasks that wait for approval and the ones a finished run left open. */
  tasks?: Pick<ServeTasksPort, "list" | "get">;
  /** The host's clock and its timer: the watch runs on them, so a test drives it without waiting. */
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** More for the inbox from a caller that knows it (the CLI: what the platform cannot run). */
  extraInbox?: () => Promise<InboxData>;
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const isOpen = (state: RunState) => state.status === "running" || state.status === "paused";

/** Which way a run cannot be read, by rule 3: a newer format, a state that does not fit, a changed one. */
function problemOf(code: string, message: string): string {
  if (code === "STATE_MODIFIED_EXTERNALLY") return "modified";
  if (code === "UNSUPPORTED_FORMAT" && message.includes("newer kodel")) return "newer_format";
  return "cannot_read";
}

const unreadableItem = (summary: RunSummary, code: string, message: string): InboxItem => ({
  kind: "unreadable",
  run_id: summary.meta.runId,
  pipeline: summary.meta.pipeline,
  problem: problemOf(code, message),
  message,
});

const errorOf = (error: unknown) => ({
  code: error instanceof KodelError ? error.code : "ERROR",
  message: error instanceof Error ? error.message : String(error),
});

interface RunLook {
  key: string;
  pipeline: string;
  status: string;
  ended: boolean;
  steps: { node_slug: string; attempt: number; phase: string }[];
  paused_at: string[];
}

interface Snapshot {
  runs: Map<string, RunLook>;
  proposals: string;
}

function lookOf(summary: RunSummary): RunLook {
  const { state, unreadable, meta } = summary;
  if (state === undefined) {
    return {
      key: `unreadable|${unreadable?.code ?? "?"}`,
      pipeline: meta.pipeline,
      status: "unreadable",
      ended: false,
      steps: [],
      paused_at: [],
    };
  }
  const steps = state.active
    .map((v) => ({ node_slug: v.node, attempt: v.attempt, phase: v.phase }))
    .sort((a, b) => (a.node_slug < b.node_slug ? -1 : a.node_slug > b.node_slug ? 1 : 0));
  const pausedAt = state.pauses.map((p) => p.node).sort();
  return {
    key: [
      state.status,
      steps.map((s) => `${s.node_slug}:${s.attempt}:${s.phase}`).join(","),
      state.pauses
        .map((p) => `${p.node}:${p.reason}`)
        .sort()
        .join(","),
    ].join("|"),
    pipeline: meta.pipeline,
    status: String(state.status),
    ended: !isOpen(state),
    steps,
    paused_at: pausedAt,
  };
}

function eventsBetween(base: Snapshot, now: Snapshot): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [runId, look] of now.runs) {
    const before = base.runs.get(runId);
    if (before?.key === look.key) continue;
    const common = { run_id: runId, pipeline: look.pipeline, status: look.status };
    if (look.status === "unreadable") events.push({ kind: "run_unreadable", ...common });
    else if (look.ended) events.push({ kind: "run_ended", ...common });
    else {
      events.push({
        kind: before === undefined ? "run_started" : "run_moved",
        ...common,
        waits_for_person:
          look.paused_at.length > 0 || look.steps.some((step) => step.phase === "human"),
        steps: look.steps,
        ...(look.paused_at.length === 0 ? {} : { paused_at: look.paused_at }),
      });
    }
  }
  if (base.proposals !== now.proposals) {
    events.push({
      kind: "proposals_changed",
      names: now.proposals === "" ? [] : now.proposals.split("\n"),
    });
  }
  return events;
}

/** The manager's reads over a local host. One per server: the cursors of the watch live in it. */
export function createManagerReads(options: ManagerReadsOptions): ManagerHost {
  const { host, tasks } = options;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  // A cursor names a snapshot of this very object: one from another server, or from before a restart, is not here.
  const nonce = randomBytes(6).toString("hex");
  let counter = 0;
  const snapshots = new Map<string, Snapshot>();
  /** What an ended run looked like when it was last read: it is not read again. */
  const ended = new Map<string, RunLook>();

  const ours = async (skip?: (runId: string) => boolean): Promise<RunSummary[]> =>
    (await host.runSummaries(skip === undefined ? {} : { skip })).filter(
      (summary) => host.foreignRootOf(summary.meta) === undefined,
    );

  const look = async (): Promise<Snapshot> => {
    const runs = new Map<string, RunLook>();
    for (const summary of await ours((runId) => ended.has(runId))) {
      const runId = summary.meta.runId;
      const kept = ended.get(runId);
      if (summary.skipped === true && kept !== undefined) {
        runs.set(runId, kept);
        continue;
      }
      const seen = lookOf(summary);
      if (seen.ended) ended.set(runId, seen);
      runs.set(runId, seen);
    }
    const proposals = await host.pipelineProposals().catch(() => []);
    return {
      runs,
      proposals: proposals
        .map((p) => `${p.name}@${p.proposed_at}`)
        .sort()
        .join("\n"),
    };
  };

  const keep = (snapshot: Snapshot): string => {
    counter += 1;
    const id = `w${nonce}-${counter.toString(36)}`;
    snapshots.set(id, snapshot);
    while (snapshots.size > MANAGER_LIMITS.snapshots) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    return id;
  };

  const attemptOf = (state: RunState, node: string) =>
    state.active.find((v) => v.node === node)?.attempt;

  const changeItem = (
    summary: RunSummary,
    change: PipelineChange,
    proposed: string | undefined,
  ): InboxItem => ({
    kind: "pipeline_change",
    run_id: summary.meta.runId,
    pipeline: summary.meta.pipeline,
    ...(change.hash === undefined ? {} : { hash: change.hash }),
    source: change.source,
    ...(proposed === undefined ? {} : { summary: proposed }),
    changes: change.changes,
    redo: change.redo,
    ...(change.refused === undefined ? {} : { refused: change.refused }),
    command: change.apply,
    show: `kodel pipeline changes show ${summary.meta.runId}`,
  });

  const also = (summary: RunSummary, state: RunState, list: AlsoWaiting[] | undefined) =>
    (list ?? []).map(
      (other): InboxItem => ({
        kind: other.reason,
        run_id: summary.meta.runId,
        pipeline: summary.meta.pipeline,
        node_slug: other.node_slug,
        ...(other.reason === "gate" ? { attempt: attemptOf(state, other.node_slug) } : {}),
        prompt: other.prompt,
        command: other.how_to_decide.cli,
      }),
    );

  /** The summary the agent gave with the proposal that waits: the last one the journal has. */
  const proposedSummary = async (run: LocalRun, change: PipelineChange) => {
    if (change.source !== "proposal") return undefined;
    const journal = await run.journal().catch(() => []);
    const record = journal.findLast(
      (r) => r.event === "pipeline_change_proposed" && r.withdrawn !== true,
    );
    return typeof record?.summary === "string" ? record.summary : undefined;
  };

  /** A background worker the daemon saw gone, when nothing was served to anyone since. */
  const workerGone = async (summary: RunSummary, run: LocalRun): Promise<InboxItem[]> => {
    const journal = await run.journal().catch(() => []);
    const gone = journal.findLast((r) => r.event === "worker_note" && r.what === "gone");
    if (gone === undefined) return [];
    const moved = journal.some(
      (r) => r.seq > gone.seq && (r.event === "step_served" || r.event === "agent_completed"),
    );
    if (moved) return [];
    return [
      {
        kind: "worker_gone",
        run_id: summary.meta.runId,
        pipeline: summary.meta.pipeline,
        worker: String(gone.worker ?? ""),
        reason: typeof gone.reason === "string" ? gone.reason : "unknown",
        command: "kodel agent ls",
        note: "the run is open and has no agent: any agent of the project continues it, or kodel serve resumes it after a decision",
      },
    ];
  };

  const openRunItems = async (summary: RunSummary, state: RunState): Promise<InboxItem[]> => {
    const runId = summary.meta.runId;
    const run = await host.open(runId);
    if (run === undefined) {
      return [
        unreadableItem(
          summary,
          "UNSUPPORTED_FORMAT",
          `run ${runId} cannot be continued by this kodel: its pipeline was not kept with it`,
        ),
      ];
    }
    if ((await run.integrityStatus()) === "modified") {
      return [
        {
          ...unreadableItem(
            summary,
            "STATE_MODIFIED_EXTERNALLY",
            `the state of run ${runId} was changed outside kodel`,
          ),
          command: `kodel ack ${runId}`,
        },
      ];
    }
    const step: NextStep = await run.inspect();
    const base = { run_id: runId, pipeline: summary.meta.pipeline, slug: summary.meta.slug };
    const items: InboxItem[] = [];
    let change: PipelineChange | undefined;
    if ("waiting" in step) {
      const { waiting } = step;
      change = waiting.pipeline_change;
      if (waiting.reason !== "pipeline_changed" || waiting.behind === "gate") {
        // Behind a change the gate still waits: both are the person's.
        const gate = waiting.reason === "gate" || waiting.behind === "gate";
        if (gate || waiting.reason === "paused") {
          items.push({
            kind: gate ? "gate" : "paused",
            ...base,
            node_slug: waiting.node_slug,
            ...(gate ? { attempt: attemptOf(state, waiting.node_slug) } : {}),
            ...(waiting.reason === "pipeline_changed" ? {} : { prompt: waiting.prompt }),
            command:
              waiting.reason === "pipeline_changed"
                ? `kodel gate approve ${runId}`
                : waiting.how_to_decide.cli,
          });
        }
      } else if (waiting.behind === "paused") {
        items.push({
          kind: "paused",
          ...base,
          node_slug: waiting.node_slug,
          command: `kodel resume ${runId}`,
        });
      }
      items.push(...also(summary, state, waiting.also_waiting));
    } else if ("node" in step) {
      change = step.node.pipeline_change;
      items.push(...also(summary, state, step.node.also_waiting));
    } else if ("running" in step) {
      change = step.running.pipeline_change;
      items.push(...also(summary, state, step.running.also_waiting));
    }
    if (change !== undefined) {
      items.push(changeItem(summary, change, await proposedSummary(run, change)));
    }
    items.push(...(await workerGone(summary, run)));
    return items;
  };

  /** A run that completed for a task the engine does not close (`tasks.on_run.mode: ask`) and that is still open. */
  const taskOpen = async (summary: RunSummary, state: RunState): Promise<InboxItem[]> => {
    if (tasks === undefined || state.status !== "completed" || state.taskKey === undefined) {
      return [];
    }
    const task = await tasks.get(state.taskKey).catch(() => undefined);
    if (task === undefined || task.state === "done") return [];
    return [
      {
        kind: "task_open",
        run_id: summary.meta.runId,
        pipeline: summary.meta.pipeline,
        key: task.key,
        title: task.title,
        status: task.status,
        command: `kodel task set ${task.key} --status <the done status of the tracker>`,
      },
    ];
  };

  const approvals = async (): Promise<InboxItem[]> => {
    if (tasks === undefined) return [];
    const items: InboxItem[] = [];
    let cursor: string | undefined;
    // Bounded: a tracker with thousands of tasks is not read to its end for one answer.
    for (let page = 0; page < 5; page++) {
      const answer = await tasks.list({
        state: ["todo", "progress"],
        limit: TASK_LIMITS.listMax,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const task of answer.tasks) {
        if (task.needs_approval !== true) continue;
        items.push({
          kind: "task_approval",
          key: task.key,
          title: task.title,
          status: task.status,
          command: `kodel task approve ${task.key}`,
        });
      }
      if (answer.next === undefined) break;
      cursor = answer.next;
    }
    return items;
  };

  return {
    historyRedact: (text) => host.historyRedact(text),

    async inbox(): Promise<InboxData> {
      const items: InboxItem[] = [];
      const off: Record<string, string> = {};
      const asks = (await host.taskLink?.().catch(() => undefined))?.mode === "ask";
      for (const summary of await ours()) {
        const { state, unreadable } = summary;
        if (state === undefined) {
          items.push(
            unreadableItem(
              summary,
              unreadable?.code ?? "ERROR",
              unreadable?.message ?? "the run cannot be read",
            ),
          );
          continue;
        }
        try {
          if (isOpen(state)) items.push(...(await openRunItems(summary, state)));
          else if (asks) items.push(...(await taskOpen(summary, state)));
        } catch (error) {
          const { code, message } = errorOf(error);
          items.push(unreadableItem(summary, code, message));
        }
      }
      try {
        for (const record of await host.pipelineProposals()) {
          const view = await host.pipelineProposal(record.name).catch(() => undefined);
          items.push({
            kind: "proposal",
            name: record.name,
            proposal: record.kind,
            summary: record.summary,
            ...(view?.changes === undefined ? {} : { changes: view.changes }),
            ...(view?.refused === undefined ? {} : { refused: view.refused }),
            command: `kodel pipeline proposals apply ${record.name}`,
            show: `kodel pipeline proposals show ${record.name}`,
          });
        }
      } catch (error) {
        off.proposals = errorOf(error).message;
      }
      try {
        items.push(...(await approvals()));
      } catch (error) {
        off.tasks = errorOf(error).message;
      }
      if (tasks === undefined)
        off.tasks = "tasks are off in this project, or the tracker cannot be opened";
      const extra = await options.extraInbox?.().catch(() => undefined);
      if (extra !== undefined) {
        items.push(...extra.items);
        Object.assign(off, extra.off ?? {});
      }
      return { items, ...(Object.keys(off).length === 0 ? {} : { off }) };
    },

    async runReport(runId) {
      const found = await host.historyRun(runId, { patch: false });
      return found === undefined ? undefined : { pipeline: found.pipeline, report: found.report };
    },

    async gateChanges(runId): Promise<GateChangesData | undefined> {
      const summary = (await ours()).find((s) => s.meta.runId === runId);
      if (summary === undefined) return undefined;
      const run = await host.open(runId);
      if (run === undefined) return undefined;
      const state = await run.state();
      const gates = state.active
        .filter((v) => v.phase === "human")
        .map((v) => ({ node_slug: v.node, attempt: v.attempt }));
      const found = await run.changesSinceStart();
      if (found.kind !== "changes") {
        return {
          run_id: runId,
          kind: found.kind,
          gates,
          ...(found.kind === "unavailable" ? { reason: found.reason } : {}),
        };
      }
      const { shown, omitted } = capChanges(found.files);
      return {
        run_id: runId,
        kind: "changes",
        files: shown,
        ...(omitted > 0 ? { omitted } : {}),
        ...(found.note === undefined ? {} : { note: found.note }),
        gates,
      };
    },

    async watch(cursor, waitMs, signal): Promise<WatchData> {
      let base: Snapshot;
      let current: Snapshot;
      if (cursor === undefined) {
        base = await look();
        current = base;
      } else {
        const known = snapshots.get(cursor);
        if (known === undefined) {
          throw new KodelError(
            "INVALID_CURSOR",
            "the cursor is not one of this server's (it was started again, or the cursor is too old); call manager_watch again without it",
          );
        }
        base = known;
        current = await look();
      }
      const deadline = clock() + Math.max(0, waitMs);
      for (;;) {
        const events = eventsBetween(base, current);
        if (events.length > 0) return { cursor: keep(current), events, timed_out: false };
        if (signal.aborted) {
          return { cursor: keep(current), events: [], timed_out: false, cancelled: true };
        }
        const left = deadline - clock();
        if (left <= 0) return { cursor: keep(current), events: [], timed_out: true };
        await sleep(Math.min(MANAGER_LIMITS.watchIntervalMs, left), signal);
        if (signal.aborted) {
          return { cursor: keep(current), events: [], timed_out: false, cancelled: true };
        }
        current = await look();
      }
    },
  };
}

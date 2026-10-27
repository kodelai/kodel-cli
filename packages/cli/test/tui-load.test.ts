import { describe, expect, test } from "bun:test";
import {
  type JournalRecord,
  KodelError,
  type NextStep,
  type RunState,
} from "@kodel-ai/pipeline-core";
import { loadSessions, type RunHandle, type SessionSource } from "../src/tui/load";

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const MIN = 60_000;

function state(over: Partial<RunState> = {}): RunState {
  return {
    v: 1,
    runId: "r_1",
    task: "fix the wait timeout",
    specHash: "h",
    status: "running",
    startedAt: NOW - 30 * MIN,
    nodes: {
      implement: { slug: "implement", status: "passed", outcome: "ok", attempt: 1 },
      review: { slug: "review", status: "waiting", outcome: null, attempt: 2 },
    },
    active: [],
    trail: ["implement", "review"],
    nextVisitId: 1,
    seq: 1,
    ...over,
  } as unknown as RunState;
}

const record = (
  event: string,
  minutesAgo: number,
  rest: Record<string, unknown> = {},
): JournalRecord => ({
  v: 1,
  seq: 1,
  ts: NOW - minutesAgo * MIN,
  event,
  ...rest,
});

interface Fake {
  state?: RunState | undefined;
  journal?: JournalRecord[];
  next?: NextStep;
  integrity?: "ok" | "modified" | "unknown";
  seal?: "sealed" | "modified" | "unsealed" | "open";
  openError?: Error;
  inspectError?: Error;
}

function source(fake: Fake, proposals = 0): SessionSource {
  const run: RunHandle = {
    integrityStatus: async () => fake.integrity ?? "ok",
    sealStatus: async () => fake.seal ?? "open",
    inspect: async () => {
      if (fake.inspectError) throw fake.inspectError;
      return fake.next ?? ({ node: {} } as unknown as NextStep);
    },
    journal: async () => fake.journal ?? [],
  };
  return {
    runSummaries: async () => [
      {
        meta: {
          runId: "r_1",
          pipeline: "dev",
          task: "fix the wait timeout",
          slug: "fix-wait",
          createdAt: NOW - 30 * MIN,
        },
        state: "state" in fake ? fake.state : state(),
      },
    ],
    open: async () => {
      if (fake.openError) throw fake.openError;
      return run;
    },
    pipelineProposals: async () => Array.from({ length: proposals }, () => ({})),
  };
}

const waitingNext = (w: Record<string, unknown>) =>
  ({
    waiting: {
      node_slug: "review",
      prompt: "Look at it.",
      how_to_decide: { cli: "kodel gate approve|reject r_1" },
      ...w,
    },
  }) as unknown as NextStep;

const one = async (fake: Fake, proposals = 0) => {
  const loaded = await loadSessions(source(fake, proposals), NOW);
  const session = loaded.sessions[0];
  if (!session) throw new Error("no session");
  return { session, loaded };
};

describe("tui loading sessions", () => {
  test("a human step is `approve`, waiting since the gate was reached", async () => {
    const { session } = await one({
      next: waitingNext({ reason: "gate" }),
      journal: [record("node_entered", 22), record("gate_waiting", 21)],
    });
    expect(session.status).toBe("waiting");
    expect(session.need).toBe("approve");
    expect(session.since).toBe(NOW - 21 * MIN);
    expect(session.command).toBe("kodel gate approve|reject r_1");
    expect(session.title).toBe("fix-wait");
    expect(session.steps.map((s) => s.name)).toEqual(["implement", "review"]);
    expect(session.steps[1]?.note).toBe("attempt 2");
  });

  test("a pipeline change that holds an approval is one row, `pipeline edit`, with the approval after it", async () => {
    const { session } = await one({
      next: waitingNext({
        reason: "pipeline_changed",
        behind: "gate",
        pipeline_change: { source: "proposal", apply: "kodel pipeline changes apply r_1" },
        how_to_decide: { cli: "kodel pipeline changes apply r_1" },
      }),
      journal: [record("pipeline_change_proposed", 40), record("gate_waiting", 41)],
    });
    expect(session.need).toBe("pipeline_edit");
    expect(session.after).toBe("approve «review»");
    expect(session.since).toBe(NOW - 40 * MIN);
    expect(session.command).toContain("changes apply");
  });

  test("a paused run says why, in plain words", async () => {
    const { session } = await one({
      state: state({
        status: "paused",
        pause: { reason: "total", node: "implement" },
      } as Partial<RunState>),
      next: waitingNext({ reason: "paused", node_slug: "implement" }),
      journal: [record("run_paused", 7)],
    });
    expect(session.need).toBe("paused");
    expect(session.headline).toContain("used up all its attempts");
    expect(session.since).toBe(NOW - 7 * MIN);
  });

  test("files changed by hand come before everything else", async () => {
    const open = await one({ integrity: "modified", next: waitingNext({ reason: "gate" }) });
    expect(open.session.need).toBe("hand_edit");
    const ended = await one({
      state: state({ status: "completed", finishedAt: NOW - 3 * MIN }),
      seal: "modified",
    });
    expect(ended.session.need).toBe("hand_edit");
    const refused = await one({
      openError: new KodelError("STATE_MODIFIED_EXTERNALLY", "the pinned copy changed"),
    });
    expect(refused.session.need).toBe("hand_edit");
    expect(refused.session.prompt).toContain("the pinned copy changed");
  });

  test("a run that cannot be read is `unreadable`: no decision, and it does not wait for anyone", async () => {
    expect((await one({ state: undefined })).session).toMatchObject({ status: "unreadable" });
    const format = await one({
      openError: new KodelError("UNSUPPORTED_FORMAT", "written in format 1"),
    });
    expect(format.session.status).toBe("unreadable");
    expect(format.session.need).toBeUndefined();
    expect(format.session.prompt).toContain("written in format 1");
  });

  test("finished runs: done, canceled, and failed with the reason and the failing step", async () => {
    const finishedAt = NOW - 2 * 3_600_000;
    expect(
      (await one({ state: state({ status: "completed", finishedAt }), seal: "sealed" })).session,
    ).toMatchObject({
      status: "done",
      since: finishedAt,
    });
    expect(
      (await one({ state: state({ status: "canceled", finishedAt }), seal: "sealed" })).session
        .status,
    ).toBe("canceled");
    const { session } = await one({
      state: state({ status: "failed", finishedAt }),
      seal: "sealed",
      journal: [
        record("node_finished", 130, { node: "implement", outcome: "no-fix" }),
        record("run_finished", 120, {
          reason: 'node "implement" failed with "no-fix" and nothing handles that',
        }),
      ],
    });
    expect(session.status).toBe("failed");
    expect(session.step).toBe("implement");
    expect(session.reason).toContain("nothing handles that");
    expect(session.need).toBeUndefined();
  });

  test("running: the agent's turn, quiet after five minutes without a record", async () => {
    const live = await one({ journal: [record("node_entered", 1)] });
    expect(live.session).toMatchObject({
      status: "running",
      activity: "agent",
      since: NOW - 30 * MIN,
    });
    const quiet = await one({ journal: [record("node_entered", 12)] });
    expect(quiet.session.activity).toBe("quiet");
    expect(quiet.session.step).toBe("quiet 12m");
  });

  test("running: engine work is `working` while its heartbeat is fresh, quiet when it is not", async () => {
    const engineNext = { running: { items: [] } } as unknown as NextStep;
    const fresh = await one({
      state: state({
        active: [
          {
            node: "checks",
            attempt: 1,
            visitId: 1,
            phase: "engine",
            checkIndex: 0,
            heartbeatAt: NOW - 5_000,
            startedAt: NOW,
          } as never,
        ],
      }),
      next: engineNext,
    });
    expect(fresh.session.activity).toBe("working");
    const stale = await one({
      state: state({
        active: [
          {
            node: "checks",
            attempt: 1,
            visitId: 1,
            phase: "engine",
            checkIndex: 0,
            heartbeatAt: NOW - 3 * MIN,
            startedAt: NOW,
          } as never,
        ],
      }),
      next: engineNext,
    });
    expect(stale.session.activity).toBe("quiet");
  });

  test("proposals are counted, not listed as sessions", async () => {
    const { loaded } = await one({ next: waitingNext({ reason: "gate" }) }, 2);
    expect(loaded.proposals).toBe(2);
    expect(loaded.sessions).toHaveLength(1);
  });
});

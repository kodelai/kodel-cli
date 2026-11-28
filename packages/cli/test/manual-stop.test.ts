/**
 * The shared stop of a run's agent (`stopRunAgent`): the lock, the records read again inside it, the
 * answers for every run that cannot be stopped, the note, the journal event, and that a stop through it is
 * a person's stop for the daemon and the TUI.
 */
import { describe, expect, test } from "bun:test";
import { KodelError, SessionError } from "@kodel-ai/pipeline-core";
import { type ManualStopHost, stopRunAgent } from "../src/manual-stop";
import type { WorkerStatus } from "../src/worker-launcher";
import { FakeLauncher } from "./fake-launcher";

const RUN = "r_0mwwhh8jl_8hsz";
const OTHER = "r_0mwwhh8jl_aaaa";

const worker = (run: string, over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  id: `a_${run}`,
  name: `kw-${run}`,
  state: "running",
  label: "running",
  started: 1,
  resumed: [],
  resumes: 0,
  ...over,
});

interface World {
  host: ManualStopHost;
  launcher: FakeLauncher;
  noted: (string | undefined)[];
  locks: number;
}

function world(
  over: {
    runs?: Record<string, { status: string; root?: string } | undefined>;
    lock?: boolean;
    written?: boolean;
  } = {},
): World {
  const launcher = new FakeLauncher();
  launcher.statusMap.set(RUN, worker(RUN));
  launcher.statusMap.set(OTHER, worker(OTHER));
  const noted: (string | undefined)[] = [];
  const runs = over.runs ?? { [RUN]: { status: "running" }, [OTHER]: { status: "running" } };
  const w: World = {
    launcher,
    noted,
    locks: 0,
    host: {
      async runSummaries() {
        return Object.entries(runs).map(([runId, v]) => ({
          meta: { runId, ...(v?.root === undefined ? {} : { root: v.root }) },
          state: v === undefined ? undefined : { status: v.status },
        }));
      },
      foreignRootOf: (meta) => meta.root,
      async open() {
        return {
          async noteAgentStopped(input) {
            noted.push(input.instruction);
            return { written: over.written !== false };
          },
        };
      },
      ...(over.lock === false
        ? {}
        : {
            async withWorkerStartLock<T>(fn: () => Promise<T>) {
              w.locks += 1;
              return fn();
            },
          }),
    },
  };
  return w;
}

describe("mstart the stop of a run's agent", () => {
  test("mstart_stop_targets_only_the_run_worker", async () => {
    const w = world();
    const answer = await stopRunAgent(w, {
      runId: RUN,
      by: "agent",
      instruction: "the person said stop",
    });
    expect(answer).toMatchObject({
      status: "stopped",
      agent: `kw-${RUN}`,
      run_id: RUN,
      journaled: true,
    });
    expect(w.launcher.stopped).toEqual([RUN]);
    expect(w.launcher.stopVias).toEqual(["manager"]);
    expect(w.launcher.statusMap.get(OTHER)?.state).toBe("running");
    expect(w.locks).toBe(1);
    expect(w.noted).toEqual(["the person said stop"]);
  });

  test("mstart_stop_note_names_cancel_and_both_ways_on", async () => {
    const w = world();
    const live = await stopRunAgent(w, { runId: RUN, by: "agent" });
    if (live.status !== "stopped") throw new Error("not stopped");
    expect(live.note).toContain("still open");
    expect(live.note).toContain("TASK-9JTV");
    expect(live.note).toContain("s in kodel tui");
    expect(live.note).toContain("pipeline_next_step");
    expect(live.note).toContain("--resume does not");
    expect(live.note).toContain("terminal");
    expect(live.note).toContain("max_runs");
    // An agent that had already ended at a wait was waiting: only the decision's way on is named.
    const w2 = world();
    w2.launcher.statusMap.set(RUN, worker(RUN, { state: "exited", label: "exited (0)" }));
    const waiting = await stopRunAgent(w2, { runId: RUN, by: "agent" });
    if (waiting.status !== "stopped") throw new Error("not stopped");
    expect(waiting.note).toContain("s in kodel tui");
    expect(waiting.note).not.toContain("max_runs");
  });

  test("mstart_stop_during_starting", async () => {
    const w = world();
    w.launcher.statusMap.set(RUN, worker(RUN, { state: "starting", label: "starting" }));
    const answer = await stopRunAgent(w, { runId: RUN, by: "agent" });
    expect(answer).toMatchObject({ status: "refused", why: "starting", retry: true });
    expect(w.launcher.stopped).toEqual([]);
    expect(w.noted).toEqual([]);
  });

  test("mstart_stop_answers_for_odd_runs", async () => {
    const refused = async (w: World, run = RUN) => stopRunAgent(w, { runId: run, by: "agent" });
    expect(await refused(world(), "r_0mwwhh8jl_zzzz")).toMatchObject({ why: "unknown_run" });
    expect(
      await refused(world({ runs: { [RUN]: { status: "running", root: "/elsewhere" } } })),
    ).toMatchObject({
      why: "foreign_checkout",
    });
    expect(await refused(world({ runs: { [RUN]: { status: "completed" } } }))).toMatchObject({
      why: "run_over",
    });
    const noAgent = world();
    noAgent.launcher.statusMap.delete(RUN);
    expect(await refused(noAgent)).toMatchObject({ why: "no_agent" });
    const unreadable = world();
    unreadable.launcher.statusMap.set(RUN, worker(RUN, { state: "unknown", label: "unknown" }));
    expect(await refused(unreadable)).toMatchObject({ why: "agent_unreadable" });
    expect(await refused(world({ lock: false }))).toMatchObject({ why: "no_lock" });
    const identity = world();
    identity.launcher.stop = async () => {
      throw new SessionError("IDENTITY_UNKNOWN", "cannot read the identity of 4242");
    };
    expect(await refused(identity)).toMatchObject({ why: "identity_unknown" });
    const busy = world();
    busy.host.withWorkerStartLock = async () => {
      throw new KodelError("STATE_LOCKED", "held");
    };
    expect(await refused(busy)).toMatchObject({ why: "busy", retry: true });
    for (const w of [identity, busy, noAgent]) expect(w.noted).toEqual([]);
  });

  test("mstart_stop_already_stopped", async () => {
    const w = world();
    w.launcher.statusMap.set(
      RUN,
      worker(RUN, { state: "killed", label: "stopped", stopped: true }),
    );
    const answer = await stopRunAgent(w, { runId: RUN, by: "agent" });
    expect(answer).toMatchObject({ status: "refused", why: "already_stopped" });
    expect(w.launcher.stopped).toEqual([]);
    expect(w.noted).toEqual([]);
  });

  test("mstart_stop_reads_the_records_again_and_the_run_stays_open", async () => {
    const w = world();
    await stopRunAgent(w, { runId: RUN, by: "agent" });
    // read before the stop, and again after it; the run's own state is not touched by it
    expect(w.launcher.calls.filter((c) => c === "statuses")).toHaveLength(2);
    expect((await w.host.runSummaries()).find((s) => s.meta.runId === RUN)?.state?.status).toBe(
      "running",
    );
  });

  test("mstart_stop_event_in_journal_only_for_an_agent", async () => {
    const byPerson = world();
    expect(await stopRunAgent(byPerson, { runId: RUN, by: "person" })).toMatchObject({
      status: "stopped",
      journaled: false,
    });
    expect(byPerson.noted).toEqual([]);
    // The web page's stop is the person's: the note on the record says `web`, never `manager`.
    expect(byPerson.launcher.stopVias).toEqual(["web"]);
    // A journal that has no place for the event is said in the answer, and the stop stands.
    const none = world({ written: false });
    const answer = await stopRunAgent(none, { runId: RUN, by: "agent" });
    if (answer.status !== "stopped") throw new Error("not stopped");
    expect(answer.journaled).toBe(false);
    expect(answer.note).toContain("no event was written");
  });
});

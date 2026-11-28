/**
 * The shared reading of the runs for `kodel serve` and for a start by hand: what it hands to
 * `admitStart`. The daemon's own cycles are in `serve-daemon.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { RunState } from "@kodel-ai/pipeline-core";
import { admitStart } from "@kodel-ai/pipeline-core/serve";
import type { RunSummary } from "../src/pipeline-host";
import { createRunGatherer } from "../src/serve/gather";
import type { RunMeta } from "../src/store";

const meta = (runId: string): RunMeta => ({ runId }) as RunMeta;
const state = (status: string, taskKey?: string): RunState =>
  ({ status, ...(taskKey === undefined ? {} : { taskKey }), v: 2 }) as unknown as RunState;

function gatherer(summaries: RunSummary[], foreign: string[] = []) {
  const reads: string[] = [];
  const made = createRunGatherer({
    host: {
      open: async () => undefined,
      runSummaries: async (options) => {
        reads.push("summaries");
        // As the host does: a run that is skipped comes back with no state.
        return summaries.map((s) =>
          options?.skip?.(s.meta.runId) === true
            ? { meta: s.meta, state: undefined, skipped: true as const }
            : s,
        );
      },
      foreignRootOf: (m) => (foreign.includes(m.runId) ? "/elsewhere" : undefined),
    },
    launcher: { statuses: async () => new Map() },
    now: () => 1_000,
  });
  return { ...made, reads };
}

describe("mstart the shared reading of the runs", () => {
  test("t44_mstart_gather_feeds_the_manual_admission", async () => {
    const { gather } = gatherer(
      [
        { meta: meta("r_open"), state: state("running", "T-1") },
        { meta: meta("r_done"), state: state("completed", "T-2") },
        { meta: meta("r_foreign"), state: state("running", "T-3") },
        { meta: meta("r_broken"), state: undefined, unreadable: { code: "X", message: "bad" } },
      ],
      ["r_foreign"],
    );
    const { runs, unreadable, unreadableOpen } = await gather();
    expect(runs.map((r) => r.runId).sort()).toEqual(["r_done", "r_foreign", "r_open"]);
    expect(runs.find((r) => r.runId === "r_foreign")?.foreign).toBe(true);
    expect(runs.find((r) => r.runId === "r_open")?.foreign).toBeUndefined();
    // A broken run with no worker record is open as far as anyone knows.
    expect(unreadable).toEqual([]);
    expect(unreadableOpen).toEqual(["r_broken"]);
    const view = (key: string) => ({
      key,
      title: key,
      status: "todo",
      state: "todo" as const,
      started_runs: 0,
    });
    // The task of an open run of this checkout is held; a finished one's and another checkout's are not.
    // The broken run is read first, and closes every start: it may be the task's own.
    expect(
      admitStart({ mode: "manual", task: view("T-1"), runs, unreadable_open: unreadableOpen }),
    ).toMatchObject({
      ok: false,
      why: "has_run",
    });
    expect(admitStart({ mode: "manual", task: view("T-2"), runs })).toEqual({
      ok: true,
      warnings: [],
    });
    expect(admitStart({ mode: "manual", task: view("T-3"), runs })).toEqual({
      ok: true,
      warnings: [],
    });
  });

  test("t44_mstart_gather_reads_an_ended_run_once", async () => {
    const summaries: RunSummary[] = [{ meta: meta("r_done"), state: state("completed", "T-2") }];
    const { gather } = gatherer(summaries);
    const first = await gather();
    // The second read skips the ended run's state, and still lists it.
    summaries[0] = { meta: meta("r_done"), state: undefined };
    const second = await gather();
    expect(second.runs).toEqual(first.runs);
  });
});

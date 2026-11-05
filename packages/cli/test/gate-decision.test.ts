/** The checks of a decision at a gate or a pause, on a run that is faked so that every refusal can be made. */
import { describe, expect, test } from "bun:test";
import type { ChangeReport } from "@kodel-ai/local";
import type { Decision, RunState } from "@kodel-ai/pipeline-core";
import {
  commitGateDecision,
  commitResume,
  DecisionRefused,
  type DecisionRun,
  prepareGateDecision,
  prepareResume,
} from "../src/gate-decision";

interface Fake extends DecisionRun {
  calls: string[];
}

const OK: Decision = { ok: true } as unknown as Decision;

/** A run waiting at the gate `g` (attempt 1), with what each question of the engine answers. */
function fake(
  over: {
    attempt?: number;
    nodes?: string[];
    changes?: ChangeReport | (() => Promise<ChangeReport>);
    comments?:
      | { csv: string; count: number }
      | undefined
      | (() => { csv: string; count: number } | undefined);
    pending?: boolean;
    foreign?: string;
    pauses?: string[];
    status?: "running" | "paused";
  } = {},
): Fake {
  const calls: string[] = [];
  const nodes = over.nodes ?? ["g"];
  return {
    runId: "r_test",
    calls,
    foreignRoot: async () => over.foreign,
    state: async () => {
      calls.push("state");
      return {
        status: over.status ?? "running",
        active: nodes.map((node) => ({ node, phase: "human", attempt: over.attempt ?? 1 })),
        pauses: (over.pauses ?? []).map((node) => ({ node, reason: "restarts" })),
      } as unknown as RunState;
    },
    pendingChange: async () => {
      calls.push("pending");
      return over.pending
        ? ({ info: { blocking: true, apply: "kodel pipeline changes apply r_test" } } as never)
        : undefined;
    },
    changesSinceGate: async () => {
      calls.push("changes");
      const c = over.changes ?? { kind: "changes", files: {} };
      return typeof c === "function" ? c() : c;
    },
    gateResults: async () => {
      calls.push("results");
      return typeof over.comments === "function" ? over.comments() : over.comments;
    },
    decideHuman: async () => {
      calls.push("decide");
      return OK;
    },
    resume: async () => {
      calls.push("resume");
      return OK;
    },
  };
}

const refused = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof DecisionRefused) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("task_dxn6 gate-decision: prepare", () => {
  test("the attempt is optional (the command has none) and checked when given", async () => {
    const run = fake({ attempt: 2 });
    expect((await prepareGateDecision(run, { decision: "approve" })).attempt).toBe(2);
    const error = await refused(
      prepareGateDecision(run, { decision: "approve", expectAttempt: 1 }),
    );
    expect(error.message).toContain("no longer at the attempt you looked at");
  });

  test("several waiting gates need a name; a name that is not waiting is refused", async () => {
    const run = fake({ nodes: ["a-gate", "b-gate"] });
    expect((await refused(prepareGateDecision(run, { decision: "approve" }))).message).toContain(
      "waits for a decision at 2 steps",
    );
    expect((await prepareGateDecision(run, { decision: "approve", node: "b-gate" })).node).toBe(
      "b-gate",
    );
    expect(
      (await refused(prepareGateDecision(run, { decision: "approve", node: "nope" }))).message,
    ).toContain('is not waiting for a decision at "nope"');
  });

  test("a rejection needs a reason or recorded comments; the refusal says which key asks for one", async () => {
    const none = fake();
    const error = await refused(prepareGateDecision(none, { decision: "reject" }));
    expect(error.code).toBe("needs_reason");
    expect(error.message).toContain("a rejection needs a reason");
    const withReason = await prepareGateDecision(none, { decision: "reject", reason: "no" });
    expect(withReason.questions).toHaveLength(1);
    const withComments = fake({ comments: { csv: "a.ts,too big", count: 1 } });
    const prepared = await prepareGateDecision(withComments, { decision: "reject" });
    expect(prepared.questions[0]).toContain("1 comment(s) recorded");
  });

  test("changes that cannot be checked need a second yes for an approval and not for a rejection", async () => {
    const changes: ChangeReport = { kind: "unavailable", reason: "git failed" };
    const approve = await prepareGateDecision(fake({ changes }), { decision: "approve" });
    expect(approve.questions).toHaveLength(2);
    expect(approve.questions[0]).toContain("WARNING");
    const reject = await prepareGateDecision(fake({ changes }), {
      decision: "reject",
      reason: "x",
    });
    expect(reject.questions).toHaveLength(1);
  });

  test("a pending change of the pipeline refuses, unless the person says to decide anyway", async () => {
    const run = fake({ pending: true });
    expect((await refused(prepareGateDecision(run, { decision: "approve" }))).message).toContain(
      "--ignore-pending-change",
    );
    expect(
      (await prepareGateDecision(run, { decision: "approve", ignorePendingChange: true })).node,
    ).toBe("g");
    // the screen has no such flag to name
    const quiet = await refused(
      prepareGateDecision(run, { decision: "approve", offerIgnore: false }),
    );
    expect(quiet.message).toContain("a change of the pipeline");
    expect(quiet.message).not.toContain("--ignore-pending-change");
  });

  test("a changesSinceGate that throws is not turned into a decision", async () => {
    const run = fake({
      changes: async () => {
        throw new Error("boom");
      },
    });
    await expect(prepareGateDecision(run, { decision: "approve" })).rejects.toThrow("boom");
    expect(run.calls).not.toContain("decide");
  });

  test("a run made by another checkout is named", async () => {
    const run = fake({ foreign: "/other" });
    expect((await prepareGateDecision(run, { decision: "approve" })).foreign).toBe("/other");
  });
});

describe("task_dxn6 gate-decision: commit", () => {
  test("without recheck it writes at once and looks at nothing, as the command always did", async () => {
    const run = fake();
    const prepared = await prepareGateDecision(run, { decision: "approve" });
    run.calls.length = 0;
    await commitGateDecision(run, prepared, undefined);
    expect(run.calls).toEqual(["decide"]);
  });

  test("with recheck, a gate decided or reworked meanwhile is refused and nothing is written", async () => {
    const run = fake();
    const prepared = await prepareGateDecision(run, { decision: "approve" });
    const moved = fake({ attempt: 2 });
    const error = await refused(commitGateDecision(moved, prepared, undefined, { recheck: true }));
    expect(error.message).toContain("no longer waiting for this decision");
    expect(moved.calls).not.toContain("decide");
    const gone = fake({ nodes: [] });
    await refused(commitGateDecision(gone, prepared, undefined, { recheck: true }));
    expect(gone.calls).not.toContain("decide");
  });

  test("with recheck, a change of the pipeline that arrived after the question is refused", async () => {
    const prepared = await prepareGateDecision(fake(), { decision: "approve" });
    const later = fake({ pending: true });
    await refused(commitGateDecision(later, prepared, undefined, { recheck: true }));
    expect(later.calls).not.toContain("decide");
  });

  test("with recheck, comments that went or changed are refused, and a typed reason does not hide a change", async () => {
    const shown = { csv: "a.ts,too big", count: 1 };
    const prepared = await prepareGateDecision(fake({ comments: shown }), { decision: "reject" });
    const gone = fake({ comments: undefined });
    expect(
      (await refused(commitGateDecision(gone, prepared, undefined, { recheck: true }))).message,
    ).toContain("are gone");
    const changed = fake({ comments: { csv: "a.ts,too big\nb.ts,more", count: 2 } });
    expect(
      (await refused(commitGateDecision(changed, prepared, "no", { recheck: true }))).message,
    ).toContain("changed while you were reading");
    expect(changed.calls).not.toContain("decide");
  });

  test("with recheck, files that moved are refused, except while a fork's other branches ran", async () => {
    const shown: ChangeReport = { kind: "changes", files: { "a.ts": 3 } };
    const prepared = await prepareGateDecision(fake({ changes: shown }), { decision: "approve" });
    const moved: ChangeReport = { kind: "changes", files: { "a.ts": 5 } };
    const stricter = fake({ changes: moved });
    expect(
      (await refused(commitGateDecision(stricter, prepared, undefined, { recheck: true }))).message,
    ).toContain("the files changed while you were reading");
    const shared = fake({ changes: { ...moved, note: "other branches ran" } as ChangeReport });
    await commitGateDecision(shared, prepared, undefined, { recheck: true });
    expect(shared.calls).toContain("decide");
    const unlisted = fake({ changes: { kind: "unavailable", reason: "x" } });
    await refused(commitGateDecision(unlisted, prepared, undefined, { recheck: true }));
  });

  test("with recheck, changes that became unavailable after a plain list are refused; an unavailable one stays so", async () => {
    const plainList = await prepareGateDecision(fake(), { decision: "approve" });
    const worse = fake({ changes: { kind: "unavailable", reason: "x" } });
    await refused(commitGateDecision(worse, plainList, undefined, { recheck: true }));
    const unavailable = await prepareGateDecision(fake({ changes: worse_() }), {
      decision: "approve",
    });
    await commitGateDecision(fake({ changes: worse_() }), unavailable, undefined, {
      recheck: true,
    });
  });
});

const worse_ = (): ChangeReport => ({ kind: "unavailable", reason: "x" });

describe("task_dxn6 gate-decision: resume", () => {
  test("a run of another checkout is refused before anything else", async () => {
    const run = fake({ foreign: "/other", pending: true, pauses: ["check"], status: "paused" });
    const error = await refused(prepareResume(run, {}));
    expect(error.message).toContain("belongs to the checkout at /other");
  });

  test("a run that is not paused, or paused at several steps without a name, is refused", async () => {
    expect((await refused(prepareResume(fake(), {}))).message).toContain("is not paused");
    const two = fake({ pauses: ["b", "c"], status: "running" });
    expect((await refused(prepareResume(two, {}))).message).toContain("paused at 2 steps");
    expect((await prepareResume(two, { node: "c" })).node).toBe("c");
    expect((await refused(prepareResume(two, { node: "x" }))).message).toContain(
      'not paused at "x"',
    );
  });

  test("with recheck, a pause that went meanwhile, or a pending change, is refused and nothing is written", async () => {
    const prepared = await prepareResume(fake({ pauses: ["check"], status: "paused" }), {});
    const gone = fake({ pauses: [], status: "paused" });
    await refused(commitResume(gone, prepared, { recheck: true }));
    expect(gone.calls).not.toContain("resume");
    const pending = fake({ pauses: ["check"], status: "paused", pending: true });
    await refused(commitResume(pending, prepared, { recheck: true }));
    const fine = fake({ pauses: ["check"], status: "paused" });
    await commitResume(fine, prepared, { recheck: true });
    expect(fine.calls).toContain("resume");
  });
});

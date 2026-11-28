/**
 * The one path every cancel takes (NE3N): the cancel is written first, the run's agents are stopped
 * after it under the start lock, and the answer names what stays.
 */
import { describe, expect, test } from "bun:test";
import {
  type AgentDecision,
  type Decision,
  KodelError,
  type RunState,
} from "@kodel-ai/pipeline-core";
import {
  type CancelableRun,
  type CancelPorts,
  cancelLines,
  cancelRun,
  shellWord,
} from "../src/cancel-run";

const RUN = "r_0mwaaaaaa_aaaa";

interface Fake {
  ports: CancelPorts;
  calls: string[];
  canceledWith: { reason?: string; byAgent?: AgentDecision }[];
}

function fake(
  options: {
    status?: RunState["status"];
    noop?: boolean;
    refuse?: KodelError;
    openThrows?: KodelError;
    missing?: boolean;
    foreign?: string;
    taskKey?: string;
    where?: { path: string; branch?: string };
    engineSession?: { node: string; name: string; id?: string };
    finishFails?: Error;
    noLauncher?: boolean;
    lockFails?: Error;
  } = {},
): Fake {
  const calls: string[] = [];
  const canceledWith: { reason?: string; byAgent?: AgentDecision }[] = [];
  let locked = false;
  const run: CancelableRun = {
    async cancel(input) {
      calls.push(`cancel${locked ? " (under the start lock)" : ""}`);
      canceledWith.push(input);
      if (options.refuse) return { ok: false, error: options.refuse };
      const state = {
        status: options.status ?? "canceled",
        ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
        ...(options.engineSession === undefined ? {} : { engineSession: options.engineSession }),
      } as unknown as RunState;
      return {
        ok: true,
        state,
        effects: [],
        journal: [],
        ...(options.noop ? { noop: true as const } : {}),
      } as Decision;
    },
    async location() {
      return options.where;
    },
    async foreignRoot() {
      return options.foreign;
    },
  };
  const ports: CancelPorts = {
    async open() {
      if (options.openThrows) throw options.openThrows;
      return options.missing ? undefined : run;
    },
    async withWorkerStartLock(fn) {
      calls.push("start lock");
      if (options.lockFails) throw options.lockFails;
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
    ...(options.noLauncher
      ? {}
      : {
          async finishWorkers(runId: string) {
            calls.push(`finish ${runId}${locked ? " (under the start lock)" : ""}`);
            if (options.finishFails) throw options.finishFails;
          },
        }),
    async stopSession(id) {
      calls.push(`stop session ${id}`);
    },
  };
  return { ports, calls, canceledWith };
}

describe("tne3n the cancel of a run", () => {
  test("tne3n_agents_stopped_after_write_under_start_lock", async () => {
    const f = fake({ engineSession: { node: "build", name: "ks-build", id: "s1" } });
    const answer = await cancelRun(f.ports, { runId: RUN, reason: "a duplicate" });
    expect(answer.ok).toBe(true);
    // written first, outside the start lock; the stops after it, under the lock
    expect(f.calls).toEqual([
      "cancel",
      "start lock",
      `finish ${RUN} (under the start lock)`,
      "stop session s1",
    ]);
    if (answer.ok) expect(answer.agents_left).toEqual([]);
  });

  test("tne3n_failed_or_absent_stop_answers", async () => {
    const failed = await cancelRun(fake({ finishFails: new Error("stuck") }).ports, {
      runId: RUN,
      reason: "x",
    });
    // the run stays canceled; the answer names what is left
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.agents_left).toHaveLength(1);
      expect(failed.agents_left[0]).toContain("stuck");
    }
    // an engine session with no id cannot be stopped by kodel: it is named
    const noId = await cancelRun(
      fake({ engineSession: { node: "build", name: "ks-build" } }).ports,
      { runId: RUN, reason: "x" },
    );
    if (noId.ok) expect(noId.agents_left[0]).toContain("not recorded as started");
    // where no launcher can list the agents, the answer says so
    const none = await cancelRun(fake({ noLauncher: true }).ports, { runId: RUN, reason: "x" });
    if (none.ok) expect(none.notes.join(" ")).toContain("kodel agent ls");
  });

  test("tne3n_start_lock_not_taken_leaves_the_run_canceled_and_names_it", async () => {
    const f = fake({
      taskKey: "KDL-1",
      where: { path: "/w", branch: "kodel/r_1" },
      lockFails: new KodelError("STATE_LOCKED", "the start lock is held"),
    });
    const answer = await cancelRun(f.ports, { runId: RUN, reason: "x" });
    // written, and answered as canceled with what stays, never as a failed cancel
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(f.calls).toEqual(["cancel", "start lock"]);
    expect(answer.agents_left).toHaveLength(1);
    expect(answer.agents_left[0]).toContain("the start lock is held");
    expect(answer.task).toEqual({ key: "KDL-1", still_open: true });
    expect(answer.remove_commands).toHaveLength(2);
  });

  test("tne3n_repeat_cancel_retries_stop", async () => {
    const f = fake({ noop: true });
    const answer = await cancelRun(f.ports, { runId: RUN, reason: "again" });
    expect(answer.ok && answer.noop).toBe(true);
    expect(f.calls).toContain(`finish ${RUN} (under the start lock)`);
  });

  test("tne3n_finished_run_refused_and_no_agent_stopped", async () => {
    const f = fake({ refuse: new KodelError("RUN_FINISHED", "it has completed") });
    const answer = await cancelRun(f.ports, { runId: RUN, reason: "x" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe("RUN_FINISHED");
    expect(f.calls).toEqual(["cancel"]);
    // a run that ended otherwise meanwhile is never answered as canceled
    const ended = await cancelRun(fake({ status: "completed" }).ports, {
      runId: RUN,
      reason: "x",
    });
    expect(!ended.ok && ended.error.code).toBe("RUN_FINISHED");
  });

  test("tne3n_reason_is_required_and_bounded", async () => {
    const f = fake();
    for (const reason of ["", "   ", "x".repeat(2_001)]) {
      const answer = await cancelRun(f.ports, { runId: RUN, reason });
      expect(!answer.ok && answer.error.code).toBe("INVALID_ARGUMENTS");
    }
    expect(f.calls).toEqual([]);
    await cancelRun(f.ports, { runId: RUN, reason: "  trimmed  " });
    expect(f.canceledWith[0]?.reason).toBe("trimmed");
  });

  test("tne3n_pre_versions_run_refused", async () => {
    const f = fake({
      openThrows: new KodelError(
        "UNSUPPORTED_FORMAT",
        `run ${RUN} was written before pipelines were kept in versions (meta format 1, this kodel reads meta format 2); finish it with the kodel that started it`,
      ),
    });
    const answer = await cancelRun(f.ports, { runId: RUN, reason: "x" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.code).toBe("UNSUPPORTED_FORMAT");
      expect(answer.error.message).toContain("cannot be canceled");
      expect(answer.error.message).not.toContain("upgrade kodel");
    }
    // a newer one keeps its own message: upgrade kodel
    const newer = await cancelRun(
      fake({
        openThrows: new KodelError("UNSUPPORTED_FORMAT", "written by a newer kodel; upgrade kodel"),
      }).ports,
      { runId: RUN, reason: "x" },
    );
    if (!newer.ok) expect(newer.error.message).toContain("upgrade kodel");
    expect(f.calls).toEqual([]);
  });

  test("tne3n_unknown_and_foreign_runs", async () => {
    const missing = await cancelRun(fake({ missing: true }).ports, { runId: RUN, reason: "x" });
    expect(!missing.ok && missing.error.code).toBe("UNKNOWN_RUN");
    // an agent cancels only its own checkout's runs; a person may cancel another clone's
    const foreign = fake({ foreign: "/elsewhere" });
    const byAgent = await cancelRun(foreign.ports, {
      runId: RUN,
      reason: "x",
      byAgent: { instruction: "cancel it", viaManager: true },
    });
    expect(!byAgent.ok && byAgent.error.code).toBe("WORKDIR_INVALID");
    expect(foreign.calls).toEqual([]);
    const byPerson = await cancelRun(foreign.ports, { runId: RUN, reason: "x" });
    expect(byPerson.ok).toBe(true);
  });

  test("tne3n_answer_names_task_branch_worktree", async () => {
    const answer = await cancelRun(
      fake({
        taskKey: "KDL-1",
        where: { path: "/tmp/a repo/.kodel/worktrees/it's", branch: "kodel/r_1" },
      }).ports,
      { runId: RUN, reason: "x" },
    );
    if (!answer.ok) throw answer.error;
    expect(answer.task).toEqual({ key: "KDL-1", still_open: true });
    expect(answer.branch).toBe("kodel/r_1");
    expect(answer.remove_commands).toEqual([
      `git worktree remove '/tmp/a repo/.kodel/worktrees/it'\\''s'`,
      "git branch -d kodel/r_1",
    ]);
    // a run worked in the root has no worktree and nothing to remove
    const root = await cancelRun(fake().ports, { runId: RUN, reason: "x" });
    if (root.ok) {
      expect(root.task).toBeNull();
      expect(root.remove_commands).toEqual([]);
      expect(root.worktree).toBeUndefined();
    }
  });

  test("tne3n_cli_output", async () => {
    const answer = await cancelRun(
      fake({
        taskKey: "KDL-1",
        where: { path: "/w t", branch: "kodel/r_1" },
        finishFails: new Error("stuck"),
      }).ports,
      { runId: RUN, reason: "x" },
    );
    if (!answer.ok) throw answer.error;
    const lines = cancelLines(answer);
    expect(lines[0]).toBe(`canceled ${RUN}`);
    expect(lines).toContain("branch kodel/r_1");
    expect(lines).toContain("worktree /w t");
    expect(lines).toContain("remove: git worktree remove '/w t'");
    expect(lines).toContain("remove: git branch -d kodel/r_1");
    expect(lines.some((line) => line.startsWith("task KDL-1 is still open"))).toBe(true);
    expect(lines.some((line) => line.startsWith("agent left running:"))).toBe(true);
    // no command is chained: each is its own line, for any shell
    expect(lines.join("\n")).not.toContain("&&");
    expect(lines.join("\n")).not.toContain("branch -D");
  });

  test("tne3n_shell_word_quotes_what_is_not_plain", () => {
    expect(shellWord("kodel/r_1")).toBe("kodel/r_1");
    expect(shellWord("a b")).toBe("'a b'");
    expect(shellWord("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
  });
});

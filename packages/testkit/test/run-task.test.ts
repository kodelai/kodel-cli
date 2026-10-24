import { describe, expect, test } from "bun:test";
import {
  createRunTaskLink,
  endAction,
  KodelError,
  TASK_ON_RUN_MODES,
  type Task,
  TaskService,
} from "@kodel-ai/pipeline-core";
import { MemoryTaskAdapter, type MemoryTaskOptions } from "../src";

const RUN = "r_0mvmwfdu8_jpsh";
const SECRET = "AKIAIOSFODNN7EXAMPLE";

async function setup(options: MemoryTaskOptions = {}, mode: "auto" | "ask" = "auto") {
  const adapter = new MemoryTaskAdapter(options);
  const service = new TaskService(adapter);
  const link = createRunTaskLink(service, mode);
  const made = await service.create({ title: "a task" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const key = (made.task as Task).key;
  const get = async () => {
    const got = await service.get({ key });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return got.task as Task;
  };
  return { service, link, key, get };
}

describe("endAction", () => {
  test("run_task_end_action_follows_the_mode_and_how_the_run_ended", () => {
    expect(TASK_ON_RUN_MODES).toEqual(["auto", "ask", "disabled"]);
    expect(endAction("auto", "completed")).toBe("close");
    expect(endAction("ask", "completed")).toBe("hint");
    expect(endAction("disabled", "completed")).toBe("none");
    for (const status of ["failed", "canceled"] as const) {
      expect(endAction("auto", status)).toBe("comment");
      expect(endAction("ask", status)).toBe("comment");
      expect(endAction("disabled", status)).toBe("none");
    }
  });
});

describe("the tie to a tracker with its own status names", () => {
  test("run_task_state_chosen_by_state_not_by_status_name", async () => {
    const { link, key, get } = await setup();
    const prepared = await link.prepare(key, false);
    expect(prepared).toEqual({ key, restarting: false });
    expect(await link.begin(key, RUN, false)).toEqual({});
    let task = await get();
    expect(task.status).toBe("In Progress");
    expect(task.state).toBe("progress");
    expect(task.runs).toEqual([RUN]);

    expect((await link.end(key, RUN, "completed")).what).toBe("closed");
    task = await get();
    expect(task.status).toBe("Done");
    expect(task.state).toBe("done");
  });

  test("run_task_a_status_the_workflow_forbids_is_not_picked", async () => {
    // From "In Progress" only "Won't Do" is allowed: it is a status in state done, so it is taken.
    const { link, key, get } = await setup({
      workflow: { Backlog: ["In Progress"], "In Progress": ["Won't Do"] },
    });
    await link.begin(key, RUN, false);
    expect((await link.end(key, RUN, "completed")).what).toBe("closed");
    expect((await get()).status).toBe("Won't Do");
  });

  test("run_task_a_failed_or_canceled_run_adds_a_comment_and_keeps_the_status", async () => {
    const { link, key, get } = await setup();
    await link.begin(key, RUN, false);
    expect((await link.end(key, RUN, "canceled")).what).toBe("commented");
    const task = await get();
    expect(task.state).toBe("progress");
    expect(task.comment).toBe(`run ${RUN} canceled`);
  });

  test("run_task_ask_mode_does_not_touch_the_tracker_at_the_end", async () => {
    const { link, key, get } = await setup({}, "ask");
    await link.begin(key, RUN, false);
    expect((await link.end(key, RUN, "completed")).what).toBe("hinted");
    expect((await get()).state).toBe("progress");
  });

  test("run_task_done_task_needs_restart_task_and_then_goes_back_to_progress", async () => {
    const { link, service, key, get } = await setup();
    await link.begin(key, RUN, false);
    await link.end(key, RUN, "completed");

    const refused = await link.prepare(key, false).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(KodelError);
    expect((refused as KodelError).code).toBe("TASK_ALREADY_DONE");
    expect((refused as KodelError).message).toContain(RUN);
    expect((refused as KodelError).details).toMatchObject({ task: key, runs: [RUN] });

    const again = await link.prepare(key, true);
    expect(again).toEqual({ key, restarting: true });
    await link.begin(key, "r_0mvmwfdu9_abcd", true);
    const task = await get();
    expect(task.state).toBe("progress");
    expect(task.runs).toEqual([RUN, "r_0mvmwfdu9_abcd"]);
    expect(task.comment).toBe("restarted by run r_0mvmwfdu9_abcd");
    expect(service).toBeDefined();
  });

  test("run_task_an_unknown_task_is_an_error_but_a_tracker_that_is_down_is_a_warning", async () => {
    const { link } = await setup();
    const unknown = await link.prepare("MEM-999", false).catch((e: unknown) => e);
    expect((unknown as KodelError).code).toBe("TASK_NOT_FOUND");

    let down = false;
    const adapter = new MemoryTaskAdapter({
      before: () => {
        if (down) throw new Error(`the tracker said no, token ${SECRET}`);
      },
    });
    const service = new TaskService(adapter);
    const made = await service.create({ title: "t" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const key = (made.task as Task).key;
    const flaky = createRunTaskLink(service, "auto");
    down = true;
    const prepared = await flaky.prepare(key, false);
    expect(prepared.key).toBeUndefined();
    expect(prepared.warning).toContain("the task was not looked up");
    expect(prepared.warning).not.toContain(SECRET);
    const begun = await flaky.begin(key, RUN, false);
    expect(begun.failed).toBe(true);
    expect(begun.note).not.toContain(SECRET);
    const ended = await flaky.end(key, RUN, "completed");
    expect(ended.what).toBe("failed");
    expect(ended.note).not.toContain(SECRET);
  });

  test("run_task_an_adapter_without_comments_or_runs_is_still_moved", async () => {
    const { link, key, get } = await setup({ capabilities: { runs: "none", comment: "none" } });
    expect(await link.begin(key, RUN, false)).toEqual({});
    let task = await get();
    expect(task.state).toBe("progress");
    expect(task.runs).toEqual([]);
    await link.end(key, RUN, "completed");
    task = await get();
    expect(task.state).toBe("done");
  });
});

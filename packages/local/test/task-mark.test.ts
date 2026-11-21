import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KodelError,
  needsApproval,
  type Task,
  type TaskPatch,
  TaskService,
} from "@kodel-ai/pipeline-core";
import { buildTaskTools, invokeTaskTool } from "@kodel-ai/pipeline-core/mcp";
import { parse } from "yaml";
import { LocalTaskAdapter, TASKS_DIR } from "../src";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures", "task-formats", "v1");
const RUN = "r_0mviewgvl_i1ig";
const o = () => ({ signal: new AbortController().signal });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kodel-taskmark-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapter(clock?: () => number) {
  let now = Date.UTC(2026, 10, 20, 9);
  return new LocalTaskAdapter({
    storeRoot: root,
    prefix: "KDL",
    clock:
      clock ??
      (() => {
        now += 1000;
        return now;
      }),
    random: Math.random,
  });
}

const fileOf = (key: string) => join(root, TASKS_DIR, `${key}.yaml`);
const onDisk = async (key: string) =>
  parse(await readFile(fileOf(key), "utf8")) as Record<string, unknown>;

const refused = async (work: Promise<unknown>): Promise<KodelError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(KodelError);
    return error as KodelError;
  }
  throw new Error("did not fail");
};

describe("the mark on tasks an agent made or changed (T-44)", () => {
  test("t44_task_mark_is_set_by_the_tool", async () => {
    const a = adapter();
    const service = new TaskService(a);
    const tools = buildTaskTools(a.capabilities);
    const call = (name: string, input: unknown) => invokeTaskTool(service, tools, name, input);

    const made = await call("task_create", { title: "Found while working", run: RUN });
    expect(made.ok).toBe(true);
    const key = ((made as unknown as { task: Task }).task as Task).key;
    const file = await onDisk(key);
    expect(file.created_by).toBe("agent");
    expect(file.created_in_run).toBe(RUN);
    expect(file.agent_edited_at).toBeUndefined();

    // A person's task: a comment from the agent does not mark it, a change of the title does.
    const persons = (await a.create({ title: "A person's task" }, o())).key;
    await call("task_update", { key: persons, comment: "looked at it" });
    expect((await onDisk(persons)).agent_edited_at).toBeUndefined();
    await call("task_update", { key: persons, title: "Rewritten by the agent" });
    expect(typeof (await onDisk(persons)).agent_edited_at).toBe("string");

    // What the engine itself does to a task for a run is not an agent's edit.
    const engines = (await a.create({ title: "Tied to a run" }, o())).key;
    const task = await service.taskForRun(engines);
    await service.advanceForRun(task, "progress", { comment: `run ${RUN} started`, add_run: RUN });
    const moved = await onDisk(engines);
    expect(moved.status).toBe("progress");
    expect(moved.agent_edited_at).toBeUndefined();

    // No tool can set, clear or approve the marks.
    for (const [name, input] of [
      ["task_create", { title: "x", created_by: "person" }],
      ["task_update", { key, approved_at: "2030-01-01T00:00:00.000Z" }],
      ["task_update", { key, by_agent: false, title: "y" }],
      ["task_update", { key, agent_edited_at: "2000-01-01T00:00:00.000Z" }],
    ] as const) {
      const answer = await call(name, input);
      expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    }
    for (const name of ["created_by", "created_in_run", "agent_edited_at", "approved_at"]) {
      expect(await call("task_update", { key, clear: [name] })).toMatchObject({
        ok: false,
        code: "INVALID_TASK",
      });
    }
    expect(tools.map((t) => t.name).some((n) => n.includes("approve"))).toBe(false);
    expect(needsApproval((await a.get(key, o()))?.task as Task)).toBe(true);
  });

  test("t44_task_mark_round_trip", async () => {
    await mkdir(join(root, TASKS_DIR), { recursive: true });
    for (const [name, key] of [
      ["person-before-marks.yaml", "TASK-BBBB"],
      ["agent-with-marks.yaml", "TASK-MMMM"],
    ] as const) {
      await copyFile(join(FIXTURES, name), fileOf(key));
    }
    const a = new LocalTaskAdapter({
      storeRoot: root,
      prefix: "TASK",
      clock: () => Date.UTC(2026, 10, 21),
      random: Math.random,
    });

    const old = (await a.get("TASK-BBBB", o()))?.task as Task;
    expect(old.created_by).toBeUndefined();
    expect(old.agent_edited_at).toBeUndefined();
    expect(needsApproval(old)).toBe(false);

    const marked = (await a.get("TASK-MMMM", o()))?.task as Task;
    expect(marked).toMatchObject({
      created_by: "agent",
      created_in_run: RUN,
      agent_edited_at: "2026-11-20T14:03:03.000Z",
      approved_at: "2026-11-20T14:02:02.000Z",
    });
    expect(needsApproval(marked)).toBe(true);
    const listed = await a.list({ state: ["todo", "progress", "done"], limit: 10 }, o());
    const rows = Object.fromEntries(listed.tasks.map((t) => [t.key, t]));
    expect(rows["TASK-MMMM"]?.needs_approval).toBe(true);
    expect(rows["TASK-MMMM"]?.created_in_run).toBe(RUN);
    expect(rows["TASK-BBBB"]?.needs_approval).toBeUndefined();

    // Written back by a person's change: every key is kept as it was, in the same order.
    for (const [name, key] of [
      ["person-before-marks.yaml", "TASK-BBBB"],
      ["agent-with-marks.yaml", "TASK-MMMM"],
    ] as const) {
      const before = await readFile(join(FIXTURES, name), "utf8");
      await a.update(key, { comment: "read back" }, o());
      const after = await readFile(fileOf(key), "utf8");
      const was = parse(before) as Record<string, unknown>;
      const now = parse(after) as Record<string, unknown>;
      const { comments: _c1, updated_at: _u1, ...keptBefore } = was;
      const { comments: _c2, updated_at: _u2, ...keptAfter } = now;
      expect(keptAfter).toEqual(keptBefore);
      expect(Object.keys(now).filter((k) => k !== "comments")).toEqual(
        Object.keys(was).filter((k) => k !== "comments"),
      );
    }
    const unmarked = await onDisk("TASK-BBBB");
    for (const k of ["created_by", "created_in_run", "agent_edited_at", "approved_at"]) {
      expect(k in unmarked).toBe(false);
    }
  });

  test("t44_approve_refuses_a_changed_task", async () => {
    const a = adapter();
    const made = await a.create({ title: "An agent's task", created_by: "agent" }, o());
    const shown = made.updated_at;
    // The task changes while the person reads it.
    await a.update(made.key, { comment: "one more thing" }, o());
    const stale = await refused(a.approve(made.key, shown, o()));
    expect(stale.code).toBe("TASK_TRANSITION_REFUSED");
    expect(stale.message).toContain("changed while you were reading; look again");
    expect((await onDisk(made.key)).approved_at).toBeUndefined();

    const fresh = (await a.get(made.key, o()))?.task as Task;
    const approved = (await a.approve(made.key, fresh.updated_at, o())) as Task;
    expect(needsApproval(approved)).toBe(false);
    expect(Date.parse(approved.approved_at as string)).toBeGreaterThan(Date.parse(made.created_at));
    expect(await a.approve("KDL-2222", "x", o())).toBeUndefined();

    // Through the service, as `kodel task approve` calls it.
    const service = new TaskService(a);
    const other = await a.create({ title: "Another", created_by: "agent" }, o());
    await a.update(other.key, { title: "Changed" }, o());
    expect(await service.approve({ key: other.key, seen: other.updated_at })).toMatchObject({
      ok: false,
      code: "TASK_TRANSITION_REFUSED",
    });
  });

  test("t44_agent_edit_needs_a_new_approval", async () => {
    const a = adapter();
    const parent = (await a.create({ title: "Parent" }, o())).key;
    const edits: [string, TaskPatch][] = [
      ["title", { title: "Matches the rule now" }],
      ["body", { body: "new text" }],
      ["status", { status: "progress" }],
      ["priority", { priority: "high" }],
      ["parent", { parent }],
      ["clear body", { clear: ["body"] }],
    ];
    for (const [what, patch] of edits) {
      // A person's task, and the same task once approved: each agent edit makes it wait again.
      const task = await a.create({ title: `A person's task (${what})`, body: "old text" }, o());
      expect(needsApproval(task)).toBe(false);
      const edited = await a.update(task.key, { ...patch, by_agent: true }, o());
      expect(needsApproval(edited?.task as Task), what).toBe(true);
      const approved = (await a.approve(task.key, edited?.task.updated_at as string, o())) as Task;
      expect(needsApproval(approved), what).toBe(false);
      const undo: TaskPatch =
        what === "clear body"
          ? { body: "back" }
          : what === "parent"
            ? { clear: ["parent"] }
            : what === "status"
              ? { status: "todo" }
              : what === "priority"
                ? { priority: "low" }
                : { title: "Again", body: "again" };
      const again = await a.update(task.key, { ...undo, by_agent: true }, o());
      expect(needsApproval(again?.task as Task), what).toBe(true);
    }

    // The same value is no change; a person's edit and a comment do not mark.
    const same = await a.create({ title: "Same", body: "b" }, o());
    const noop = await a.update(same.key, { title: "Same", by_agent: true }, o());
    expect(needsApproval(noop?.task as Task)).toBe(false);
    const byPerson = await a.update(same.key, { title: "By a person" }, o());
    expect(needsApproval(byPerson?.task as Task)).toBe(false);

    // A clock that does not move: an edit in the instant of the approval still waits.
    const fixed = new LocalTaskAdapter({
      storeRoot: root,
      prefix: "KDL",
      clock: () => Date.UTC(2026, 10, 20, 12),
      random: Math.random,
    });
    const stuck = await fixed.create({ title: "Stuck clock", created_by: "agent" }, o());
    const ok = (await fixed.approve(stuck.key, stuck.updated_at, o())) as Task;
    expect(needsApproval(ok)).toBe(false);
    const later = await fixed.update(stuck.key, { title: "Edited", by_agent: true }, o());
    expect(needsApproval(later?.task as Task)).toBe(true);
  });
});

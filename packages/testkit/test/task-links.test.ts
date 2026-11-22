/** Task links through the service and the tools (TASK-9RZD, T-45). */
import { describe, expect, test } from "bun:test";
import {
  needsApproval,
  type Task,
  type TaskAdapterCapabilities,
  TaskService,
  type TaskSummary,
  type ToolResult,
} from "@kodel-ai/pipeline-core";
import {
  buildTaskTools,
  invokeTaskTool,
  TASK_INSTRUCTIONS,
  TASK_TOOLS_VERSION,
} from "@kodel-ai/pipeline-core/mcp";
import { MemoryTaskAdapter, type MemoryTaskOptions } from "../src";

const LINK_PARAMETERS = [
  "depends_on",
  "add_depends_on",
  "remove_depends_on",
  "conflicts_with",
  "add_conflicts_with",
  "remove_conflicts_with",
];

function setup(options: MemoryTaskOptions = {}) {
  const adapter = new MemoryTaskAdapter(options);
  const service = new TaskService(adapter);
  const tools = buildTaskTools(adapter.capabilities);
  const call = (name: string, input: unknown) => invokeTaskTool(service, tools, name, input);
  return { adapter, service, tools, call };
}

const taskOf = (answer: ToolResult): Task => {
  if (!answer.ok) throw new Error(`expected ok, got ${JSON.stringify(answer)}`);
  return (answer as unknown as { task: Task }).task;
};

describe("t45 links through the tools", () => {
  test("t45_links_are_offered_only_with_the_capability", async () => {
    expect(TASK_TOOLS_VERSION).toBe(2);
    expect(TASK_INSTRUCTIONS).toContain("depends_on");
    expect(TASK_INSTRUCTIONS).toContain("conflicts_with");

    const shapes = (caps: TaskAdapterCapabilities) =>
      Object.fromEntries(buildTaskTools(caps).map((t) => [t.name, Object.keys(t.shape)]));
    const off = setup({ capabilities: { links: false } });
    const without = shapes(off.adapter.capabilities);
    for (const keys of Object.values(without)) {
      for (const name of LINK_PARAMETERS) expect(keys).not.toContain(name);
    }
    const on = setup();
    const withLinks = shapes(on.adapter.capabilities);
    expect(withLinks.task_create).toEqual(expect.arrayContaining(["depends_on", "conflicts_with"]));
    expect(withLinks.task_update).toEqual(expect.arrayContaining(LINK_PARAMETERS));
    for (const name of ["task_schema", "task_list", "task_get"]) {
      for (const parameter of LINK_PARAMETERS) expect(withLinks[name]).not.toContain(parameter);
    }

    // Without the capability a tool refuses the parameter and the service refuses the patch.
    const made = taskOf(await off.call("task_create", { title: "One" }));
    expect(await off.call("task_create", { title: "Two", depends_on: [made.key] })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(
      await off.call("task_update", { key: made.key, add_depends_on: [made.key] }),
    ).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    for (const patch of [
      { depends_on: [made.key] },
      { remove_conflicts_with: [made.key] },
      { clear: ["depends_on"] },
    ]) {
      expect(await off.service.update({ key: made.key, ...patch })).toMatchObject({
        ok: false,
        code: "TASK_UNSUPPORTED",
      });
    }
    expect(await off.service.create({ title: "Three", conflicts_with: [made.key] })).toMatchObject({
      ok: false,
      code: "TASK_UNSUPPORTED",
    });
    const read = taskOf(await off.service.get({ key: made.key }));
    expect(read.depends_on).toBeUndefined();
    expect(read.blocked_by).toBeUndefined();
  });

  test("t45_service_resolves_and_checks_link_keys", async () => {
    const { call, service } = setup();
    const a = taskOf(await call("task_create", { title: "A" }));
    const b = taskOf(await call("task_create", { title: "B" }));
    // Keys are taken as a person types them, and a key named twice in two spellings is one link.
    const c = taskOf(
      await call("task_create", { title: "C", depends_on: ["#1", a.key.toLowerCase()] }),
    );
    expect(c.depends_on).toEqual([a.key]);
    expect(c.blocked_by).toEqual([a.key]);
    expect(c.dependencies).toEqual([{ key: a.key, state: "open" }]);

    expect(
      await call("task_update", { key: c.key, add_depends_on: ["nonsense key"] }),
    ).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    const unknown = await call("task_update", { key: c.key, add_conflicts_with: ["MEM-999"] });
    expect(unknown).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
    expect((unknown as { message: string }).message).toContain("MEM-999");
    // A key is a name: one that redaction would change is refused, never stored.
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const refused = await service.update({ key: c.key, add_depends_on: [secret] });
    expect(refused).toMatchObject({ ok: false, code: "INVALID_TASK" });
    expect(JSON.stringify(refused)).not.toContain(secret);
    // The same key added and removed under two spellings is caught after the keys are resolved.
    expect(
      await service.update({ key: c.key, add_depends_on: ["#2"], remove_depends_on: [b.key] }),
    ).toMatchObject({ ok: false, code: "INVALID_TASK" });
    expect(await call("task_update", { key: c.key, add_depends_on: [c.key] })).toMatchObject({
      ok: false,
      code: "INVALID_TASK",
    });
    expect(await call("task_update", { key: a.key, add_depends_on: [c.key] })).toMatchObject({
      ok: false,
      code: "INVALID_TASK",
      message: expect.stringContaining(`${a.key} -> ${c.key} -> ${a.key}`),
    });
    expect(taskOf(await call("task_get", { key: c.key })).depends_on).toEqual([a.key]);
    const many = Array.from({ length: 21 }, (_, i) => `MEM-${i + 1}`);
    expect(await call("task_update", { key: c.key, depends_on: many })).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
    expect(await service.update({ key: c.key, depends_on: many })).toMatchObject({
      ok: false,
      code: "INVALID_TASK",
    });
  });

  test("t45_link_change_does_not_touch_the_approval_mark", async () => {
    const { adapter, call, service } = setup();
    const o = { signal: new AbortController().signal };
    // Three tasks of a person: none waits for approval.
    const a = await adapter.create({ title: "A" }, o);
    const b = await adapter.create({ title: "B" }, o);
    const c = await adapter.create({ title: "C", conflicts_with: [a.key] }, o);
    const marks = async () =>
      Promise.all(
        [a, b, c].map(async (t) => needsApproval(taskOf(await service.get({ key: t.key })))),
      );
    for (const patch of [
      { add_depends_on: [b.key] },
      { add_conflicts_with: [b.key] },
      // The conflict with C is held on C's side: removing it marks neither task.
      { remove_conflicts_with: [c.key] },
      { remove_depends_on: [b.key] },
      { clear: ["conflicts_with"] },
    ]) {
      const answer = await call("task_update", { key: a.key, ...patch });
      expect(answer.ok).toBe(true);
      expect(taskOf(answer).agent_edited_at).toBeUndefined();
      expect(await marks()).toEqual([false, false, false]);
    }
    // What the mark is about still sets it: a status an agent sets, with or without a link change.
    const closed = await call("task_update", {
      key: b.key,
      status: "Done",
      add_depends_on: [c.key],
    });
    expect(needsApproval(taskOf(closed))).toBe(true);
    expect(await marks()).toEqual([false, true, false]);
  });

  test("t45_blocked_by_is_the_cores_reading_of_dependencies", async () => {
    // An adapter that declares links and does not say the state of a dependency: fail closed.
    class Silent extends MemoryTaskAdapter {
      override async get(key: string, o: { signal: AbortSignal }) {
        const found = await super.get(key, o);
        if (found) {
          delete found.task.dependencies;
          delete found.task.blocked_by;
        }
        return found;
      }
      override async list(...args: Parameters<MemoryTaskAdapter["list"]>) {
        const answer = await super.list(...args);
        for (const t of answer.tasks) {
          t.blocked_by = ["MEM-777"];
          if (t.dependencies) t.dependencies = t.dependencies.map((d) => ({ ...d, state: "done" }));
        }
        return answer;
      }
    }
    const adapter = new Silent();
    const service = new TaskService(adapter);
    const o = { signal: new AbortController().signal };
    const a = await adapter.create({ title: "A" }, o);
    const b = await adapter.create({ title: "B", depends_on: [a.key] }, o);
    expect(taskOf(await service.get({ key: b.key })).blocked_by).toEqual([a.key]);
    // And what the adapter says in `blocked_by` itself is not taken: the dependencies decide.
    const listed = (await service.list({})) as unknown as { tasks: TaskSummary[] };
    const row = listed.tasks.find((t) => t.key === b.key);
    expect(row?.blocked_by).toBeUndefined();
    expect(listed.tasks.find((t) => t.key === a.key)?.blocked_by).toBeUndefined();
  });

  test("t45_finished_task_is_not_blocked_through_the_service", async () => {
    const { adapter, service } = setup();
    const o = { signal: new AbortController().signal };
    const a = await adapter.create({ title: "Open dependency" }, o);
    const b = await adapter.create({ title: "Closed first", depends_on: [a.key] }, o);
    const closed = await service.update({ key: b.key, status: "Done" });
    expect(closed.ok).toBe(true);
    expect(taskOf(await service.get({ key: b.key })).blocked_by).toBeUndefined();
    const listed = (await service.list({ state: ["done"] })) as unknown as { tasks: TaskSummary[] };
    expect(listed.tasks.find((t) => t.key === b.key)?.blocked_by).toBeUndefined();
  });
});

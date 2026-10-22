import { describe, expect, test } from "bun:test";
import {
  type CallOptions,
  KodelError,
  type PriorityInfo,
  type StatusInfo,
  type SubtaskRef,
  type Task,
  type TaskAdapterCapabilities,
  type TaskFilter,
  type TaskProblem,
  type TaskSchema,
  TaskService,
  type TaskServiceOptions,
  type TaskSummary,
  type ToolResult,
  type TransitionInfo,
} from "@kodel-ai/pipeline-core";
import { MemoryTaskAdapter, type MemoryTaskOptions, taskAdapterContract } from "../src";

const SECRET = "AKIAIOSFODNN7EXAMPLE";

function setup(options: MemoryTaskOptions = {}, serviceOptions: TaskServiceOptions = {}) {
  const calls: string[] = [];
  const adapter = new MemoryTaskAdapter({
    ...options,
    before: async (method, o) => {
      calls.push(method);
      await options.before?.(method, o);
    },
  });
  return { adapter, calls, svc: new TaskService(adapter, serviceOptions) };
}

/** The success answers of the task tools, as far as these tests look into them. */
interface Answer {
  adapter: string;
  capabilities: TaskAdapterCapabilities;
  statuses: StatusInfo[];
  priorities: PriorityInfo[];
  transitions: TransitionInfo[];
  truncated?: boolean;
  task: Task;
  tasks: TaskSummary[];
  subtasks: SubtaskRef[];
  subtasks_truncated?: boolean;
  open_subtasks?: number;
  next?: string;
  problems: TaskProblem[];
}

function ok(result: ToolResult): Answer {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as unknown as Answer;
}
function fail(result: ToolResult): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  return result;
}

describe("t13_nothing_secret_reaches_the_adapter_or_comes_back", () => {
  test("title, body, comment and fields are redacted before the adapter", async () => {
    const { svc, adapter } = setup();
    const made = ok(
      await svc.create({ title: `key ${SECRET}`, body: `b ${SECRET}`, comment: `c ${SECRET}` }),
    );
    const read = await adapter.get(made.task.key, { signal: new AbortController().signal });
    const everything = JSON.stringify(read);
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain("[REDACTED");
  });

  test("a secret in an update is redacted too", async () => {
    const { svc, adapter } = setup();
    const { task } = ok(await svc.create({ title: "t" }));
    ok(await svc.update({ key: task.key, title: SECRET, body: SECRET, comment: SECRET }));
    const read = await adapter.get(task.key, { signal: new AbortController().signal });
    expect(JSON.stringify(read)).not.toContain(SECRET);
  });

  test("an adapter's refusal that echoes a value does not echo the secret", async () => {
    const { svc } = setup();
    const answer = fail(await svc.create({ title: "t", fields: { Component: SECRET } }));
    expect(answer.code).toBe("INVALID_TASK");
    expect(answer.message).not.toContain(SECRET);
  });

  test("the text and the details of an adapter's error are redacted", async () => {
    const { svc } = setup({
      before: (method) => {
        if (method === "get") {
          throw new KodelError("TASK_AUTH_FAILED", `denied for ${SECRET}`, undefined, {
            hint: SECRET,
          });
        }
      },
    });
    const answer = fail(await svc.get({ key: "MEM-1" }));
    expect(answer.code).toBe("TASK_AUTH_FAILED");
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });
});

describe("failures are answers, not exceptions", () => {
  test("t16_an_unknown_thrown_error_is_TASK_ADAPTER_FAILED_with_a_redacted_message", async () => {
    const { svc } = setup({
      before: (method) => {
        if (method === "list") throw new Error(`connection refused with ${SECRET}`);
      },
    });
    const answer = fail(await svc.list());
    expect(answer.code).toBe("TASK_ADAPTER_FAILED");
    expect(answer.message).toContain("connection refused");
    expect(answer.message).not.toContain(SECRET);
  });

  test("t16_details_travel_in_details_and_nowhere_else", async () => {
    const { svc } = setup({
      before: (method) => {
        if (method === "create") {
          throw new KodelError("TASK_RATE_LIMITED", "slow down", undefined, { retry_after_s: 7 });
        }
      },
    });
    expect(await svc.create({ title: "t" })).toEqual({
      ok: false,
      code: "TASK_RATE_LIMITED",
      message: "slow down",
      details: { retry_after_s: 7 },
    });
  });

  test("an adapter that never answers is given up on", async () => {
    const { svc } = setup(
      { before: (method) => (method === "list" ? new Promise<void>(() => {}) : undefined) },
      { timeoutMs: 30 },
    );
    const answer = fail(await svc.list());
    expect(answer.code).toBe("TASK_ADAPTER_FAILED");
    expect(answer.message).toContain("did not answer");
  });

  test("an adapter that finishes in time is not hurt by the timer that fires later", async () => {
    const { svc } = setup({}, { timeoutMs: 20 });
    ok(await svc.list());
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  test("an unknown key is TASK_NOT_FOUND, whether it parses or not", async () => {
    const { svc } = setup();
    expect(fail(await svc.get({ key: "MEM-99" })).code).toBe("TASK_NOT_FOUND");
    expect(fail(await svc.get({ key: "../etc/passwd" })).code).toBe("TASK_NOT_FOUND");
    expect(fail(await svc.update({ key: "MEM-99", title: "x" })).code).toBe("TASK_NOT_FOUND");
  });

  test("a missing parent is TASK_NOT_FOUND", async () => {
    const { svc } = setup();
    const answer = fail(await svc.create({ title: "t", parent: "MEM-99" }));
    expect(answer.code).toBe("TASK_NOT_FOUND");
  });

  test("an empty update is refused before the adapter is asked anything", async () => {
    const { svc, calls } = setup();
    const { task } = ok(await svc.create({ title: "t" }));
    calls.length = 0;
    expect(fail(await svc.update({ key: task.key })).code).toBe("INVALID_TASK");
    expect(calls).toEqual([]);
  });

  test("a refused move names where the task can go", async () => {
    const { svc } = setup({ workflow: { Backlog: ["In Progress"] } });
    const { task } = ok(await svc.create({ title: "t" }));
    const answer = fail(await svc.update({ key: task.key, status: "Done" }));
    expect(answer.code).toBe("TASK_TRANSITION_REFUSED");
    expect(answer.message).toContain("In Progress");
  });

  test("an unknown status says what the statuses are", async () => {
    const { svc } = setup();
    const { task } = ok(await svc.create({ title: "t" }));
    const answer = fail(await svc.update({ key: task.key, status: "Finished" }));
    expect(answer.code).toBe("INVALID_TASK");
    expect(answer.message).toContain("Won't Do");
  });
});

describe("what the adapter has said it cannot do is not asked of it", () => {
  const NONE: Partial<TaskAdapterCapabilities> = {
    subtasks: false,
    runs: "none",
    comment: "none",
    fields: false,
  };

  test("subtasks, runs, comments and fields are TASK_UNSUPPORTED and the adapter is not called", async () => {
    const { svc, calls } = setup({ capabilities: NONE });
    const { task } = ok(await svc.create({ title: "t" }));
    calls.length = 0;
    const asks = [
      await svc.create({ title: "t", parent: task.key }),
      await svc.create({ title: "t", run: "r_0mvimyn54_tc9o" }),
      await svc.create({ title: "t", comment: "c" }),
      await svc.create({ title: "t", fields: { Component: "Backend" } }),
      await svc.update({ key: task.key, add_run: "r_0mvimyn54_tc9o" }),
      await svc.update({ key: task.key, clear: ["parent"] }),
      await svc.update({ key: task.key, clear: ["fields.Component"] }),
      await svc.list({ parent: task.key }),
      await svc.list({ top_level: true }),
    ];
    for (const answer of asks) expect(fail(answer).code).toBe("TASK_UNSUPPORTED");
    expect(calls.filter((c) => c !== "resolveKey")).toEqual([]);
  });

  test("filtering by run needs an adapter that can search runs", async () => {
    const { svc } = setup({ capabilities: { runs: "attach" } });
    expect(fail(await svc.list({ run: "r_0mvimyn54_tc9o" })).code).toBe("TASK_UNSUPPORTED");
  });
});

describe("keys", () => {
  test("every key goes through the adapter's resolveKey", async () => {
    const { svc, calls } = setup();
    const { task } = ok(await svc.create({ title: "t" }));
    calls.length = 0;
    expect(ok(await svc.get({ key: "mem-1" })).task.key).toBe(task.key);
    expect(ok(await svc.get({ key: "#1" })).task.key).toBe(task.key);
    expect(ok(await svc.get({ key: "1" })).task.key).toBe(task.key);
    expect(calls.filter((c) => c === "resolveKey").length).toBe(3);
  });

  test("a parent is resolved the same way", async () => {
    const { svc } = setup();
    ok(await svc.create({ title: "p" }));
    const child = ok(await svc.create({ title: "c", parent: "mem-1" }));
    expect(child.task.parent).toBe("MEM-1");
  });
});

describe("the schema", () => {
  test("t7_it_is_cached_only_when_the_host_gives_a_clock_and_asked_again_after_the_ttl", async () => {
    let now = 0;
    const cached = setup({}, { now: () => now, schemaTtlMs: 1000 });
    ok(await cached.svc.schema());
    ok(await cached.svc.schema());
    expect(cached.calls.filter((c) => c === "schema").length).toBe(1);
    now = 5000;
    ok(await cached.svc.schema());
    expect(cached.calls.filter((c) => c === "schema").length).toBe(2);

    const plain = setup();
    ok(await plain.svc.schema());
    ok(await plain.svc.schema());
    expect(plain.calls.filter((c) => c === "schema").length).toBe(2);
  });

  test("t7_an_INVALID_TASK_drops_the_cache_so_new_values_are_seen", async () => {
    const { svc, calls } = setup({}, { now: () => 0 });
    ok(await svc.schema());
    const { task } = ok(await svc.create({ title: "t" }));
    fail(await svc.update({ key: task.key, status: "Nope" }));
    ok(await svc.schema());
    expect(calls.filter((c) => c === "schema").length).toBe(2);
  });

  test("a schema for a task is never cached and lists the moves", async () => {
    const { svc, calls } = setup({ workflow: { Backlog: ["In Progress"] } }, { now: () => 0 });
    const { task } = ok(await svc.create({ title: "t" }));
    const first = ok(await svc.schema({ key: task.key }));
    ok(await svc.schema({ key: task.key }));
    expect(first.transitions.map((t: { to: string }) => t.to)).toEqual(["Backlog", "In Progress"]);
    expect(calls.filter((c) => c === "schema").length).toBe(2);
  });

  test("it carries the adapter, its capabilities and the tracker's own values", async () => {
    const { svc } = setup();
    const schema = ok(await svc.schema());
    expect(schema.adapter).toBe("memory");
    expect(schema.capabilities).toMatchObject({ subtasks: true, runs: "full" });
    expect(schema.statuses.map((s: { name: string }) => s.name)).toEqual([
      "Backlog",
      "In Progress",
      "Done",
      "Won't Do",
    ]);
    expect(schema.priorities[0]).toMatchObject({ name: "Highest" });
  });

  test("a huge schema is cut and says so", async () => {
    class Big extends MemoryTaskAdapter {
      override async schema(): Promise<TaskSchema> {
        return {
          statuses: Array.from({ length: 120 }, (_, i) => ({
            name: `S${i}`,
            state: "todo" as const,
            description: "d".repeat(500),
          })),
          fields: [],
        };
      }
    }
    const svc = new TaskService(new Big());
    const schema = ok(await svc.schema());
    expect(schema.statuses.length).toBe(50);
    expect(schema.statuses[0]?.description?.length).toBe(300);
    expect(schema.truncated).toBe(true);
  });
});

describe("lists and reads are bounded", () => {
  test("the unfinished are the default and a finished task leaves the list", async () => {
    const { svc } = setup();
    const a = ok(await svc.create({ title: "a" })).task;
    const b = ok(await svc.create({ title: "b" })).task;
    ok(await svc.update({ key: b.key, status: "Done" }));
    expect(ok(await svc.list()).tasks.map((t: { key: string }) => t.key)).toEqual([a.key]);
    expect(
      ok(await svc.list({ state: ["done"] })).tasks.map((t: { key: string }) => t.key),
    ).toEqual([b.key]);
  });

  test("t18_next_is_passed_on_and_continues_the_list", async () => {
    const { svc } = setup();
    for (let i = 0; i < 5; i += 1) ok(await svc.create({ title: `t${i}` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const answer = ok(await svc.list(cursor ? { limit: 2, cursor } : { limit: 2 }));
      seen.push(...answer.tasks.map((t: { key: string }) => t.key));
      if (!answer.next) break;
      cursor = answer.next;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("an adapter that returns more than the limit is cut and flagged", async () => {
    class Greedy extends MemoryTaskAdapter {
      override async list(filter: TaskFilter, o: CallOptions) {
        return super.list({ ...filter, limit: 100 }, o);
      }
    }
    const adapter = new Greedy();
    const svc = new TaskService(adapter);
    for (let i = 0; i < 4; i += 1) ok(await svc.create({ title: `t${i}` }));
    const answer = ok(await svc.list({ limit: 2 }));
    expect(answer.tasks.length).toBe(2);
    expect(answer.truncated).toBe(true);
    expect(answer.next).toBeUndefined();
  });

  test("t12_get_trims_subtasks_to_a_hundred_and_comments_to_twenty", async () => {
    class Crowded extends MemoryTaskAdapter {
      override async get(key: string, o: CallOptions) {
        const found = await super.get(key, o);
        if (!found) return found;
        const subtasks = Array.from({ length: 130 }, (_, i) => ({
          key: `MEM-${i + 100}`,
          title: `s${i}`,
        }));
        const comments = Array.from({ length: 30 }, (_, i) => ({
          text: `c${i}`,
          at: "2026-01-01T00:00:00Z",
        }));
        return { ...found, task: { ...found.task, comments }, subtasks };
      }
    }
    const svc = new TaskService(new Crowded());
    const { task } = ok(await svc.create({ title: "t" }));
    const read = ok(await svc.get({ key: task.key }));
    expect(read.subtasks.length).toBe(100);
    expect(read.subtasks_truncated).toBe(true);
    expect(read.task.comments?.length).toBe(20);
    expect(read.task.comments?.[19]?.text).toBe("c29");
    expect(read.task.comments_truncated).toBe(true);
  });
});

describe("t8_subtasks_have_no_automatic_status", () => {
  test("finishing a parent says how many children are open and touches none", async () => {
    const { svc } = setup();
    const parent = ok(await svc.create({ title: "p" })).task;
    const kid = ok(await svc.create({ title: "k", parent: parent.key })).task;
    const answer = ok(await svc.update({ key: parent.key, status: "Done" }));
    expect(answer.open_subtasks).toBe(1);
    expect(ok(await svc.get({ key: kid.key })).task.status).toBe("Backlog");
  });

  test("finishing the last child leaves the parent as it is", async () => {
    const { svc } = setup();
    const parent = ok(await svc.create({ title: "p" })).task;
    const kid = ok(await svc.create({ title: "k", parent: parent.key })).task;
    const answer = ok(await svc.update({ key: kid.key, status: "Done" }));
    expect(answer.open_subtasks).toBeUndefined();
    expect(ok(await svc.get({ key: parent.key })).task.status).toBe("Backlog");
  });

  test("a parent with finished children reports none open", async () => {
    const { svc } = setup();
    const parent = ok(await svc.create({ title: "p" })).task;
    const kid = ok(await svc.create({ title: "k", parent: parent.key })).task;
    ok(await svc.update({ key: kid.key, status: "Done" }));
    expect(ok(await svc.update({ key: parent.key, status: "Done" })).open_subtasks).toBeUndefined();
  });
});

describe("doctor", () => {
  test("verify answers with the adapter's problems", async () => {
    const { svc } = setup();
    expect(ok(await svc.verify())).toMatchObject({ adapter: "memory", problems: [] });
  });
});

describe("the conformance suite can fail", () => {
  const caseNamed = (cases: ReturnType<typeof taskAdapterContract>, part: string) => {
    const found = cases.find((c) => c.name.includes(part));
    if (!found) throw new Error(`no case about ${part}`);
    return found;
  };

  test("an adapter that ignores the cursor is caught by the paging case", async () => {
    class NoCursor extends MemoryTaskAdapter {
      override async list(filter: TaskFilter, o: CallOptions) {
        const { cursor: _dropped, ...rest } = filter;
        return super.list(rest, o);
      }
    }
    const cases = taskAdapterContract(() => ({ adapter: new NoCursor() }));
    await expect(caseNamed(cases, "paging").run()).rejects.toThrow(/came twice/);
  });

  test("an adapter that ignores the limit is caught", async () => {
    class NoLimit extends MemoryTaskAdapter {
      override async list(filter: TaskFilter, o: CallOptions) {
        return super.list({ ...filter, limit: 100 }, o);
      }
    }
    const cases = taskAdapterContract(() => ({ adapter: new NoLimit() }));
    await expect(caseNamed(cases, "limit is honoured").run()).rejects.toThrow(/limit/);
  });

  test("an adapter that lets a path through resolveKey is caught", async () => {
    class Loose extends MemoryTaskAdapter {
      override async resolveKey(input: string) {
        return input;
      }
    }
    const cases = taskAdapterContract(() => ({ adapter: new Loose() }));
    await expect(caseNamed(cases, "resolveKey never lets").run()).rejects.toThrow(/resolveKey/);
  });

  test("an adapter that accepts an unknown status is caught", async () => {
    class Lax extends MemoryTaskAdapter {
      override async update(
        key: string,
        patch: Parameters<MemoryTaskAdapter["update"]>[1],
        o: CallOptions,
      ) {
        if (patch.status === "No Such Status") return super.update(key, { title: "x" }, o);
        return super.update(key, patch, o);
      }
    }
    const cases = taskAdapterContract(() => ({ adapter: new Lax() }));
    await expect(caseNamed(cases, "unknown status").run()).rejects.toThrow();
  });
});

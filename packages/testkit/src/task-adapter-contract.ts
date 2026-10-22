/**
 * The conformance suite of the task adapter contract. `taskAdapterContract(make)` returns the cases
 * as plain data (`{ name, run }`, a case fails by throwing), so it does not depend on a test
 * framework: a test file registers them with its own `test`. Every adapter must pass all of them
 * (the `local` one, the in-memory one, a tracker's), and so can the author of a third-party
 * adapter. A case that needs a capability the adapter does not declare returns early.
 */
import {
  type CallOptions,
  isTaskState,
  KodelError,
  type NewTask,
  TASK_CONTRACT,
  TASK_LIMITS,
  type Task,
  type TaskAdapter,
  type TaskFilter,
  type TaskSummary,
} from "@kodel-ai/pipeline-core";

export interface ContractSubject {
  /** A fresh adapter with no tasks. */
  adapter: TaskAdapter;
  /** What every `create` needs besides a title (an adapter whose tracker demands a field). */
  newTask?: Partial<NewTask>;
  dispose?: () => Promise<void> | void;
}

export interface ContractCase {
  name: string;
  run(): Promise<void>;
}

const RUN_A = "r_0mvimyn54_tc9o";
const RUN_B = "r_0mvin1n0q_c91r";
const RUN_C = "r_0mvinj6qo_oeiv";
const ALL_STATES = ["todo", "progress", "done"] as TaskFilter["state"];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

async function rejection(work: Promise<unknown>, what: string): Promise<KodelError> {
  try {
    await work;
  } catch (error) {
    assert(
      error instanceof KodelError,
      `${what} threw something that is not a KodelError: ${String(error)}`,
    );
    return error;
  }
  throw new Error(`conformance: ${what} did not fail`);
}

export function taskAdapterContract(
  make: () => Promise<ContractSubject> | ContractSubject,
): ContractCase[] {
  const o = (): CallOptions => ({ signal: new AbortController().signal });
  const cases: ContractCase[] = [];

  function add(name: string, body: (s: ContractSubject, make: Helpers) => Promise<void>) {
    cases.push({
      name,
      run: async () => {
        const subject = await make();
        try {
          const { adapter } = subject;
          const create = async (title: string, extra: Partial<NewTask> = {}): Promise<Task> =>
            adapter.create({ ...subject.newTask, title, ...extra }, o());
          await body(subject, { create });
        } finally {
          await subject.dispose?.();
        }
      },
    });
  }

  type Helpers = { create: (title: string, extra?: Partial<NewTask>) => Promise<Task> };

  const listAll = async (a: TaskAdapter, filter: Partial<TaskFilter> = {}) => {
    const filled: TaskFilter = { state: ALL_STATES, limit: TASK_LIMITS.listMax, ...filter };
    return a.list(filled, o());
  };

  add("the adapter declares this contract and sane capabilities", async ({ adapter }) => {
    assert(adapter.contract === TASK_CONTRACT, "contract is not the one this kodel supports");
    assert(adapter.kind.length > 0, "kind is empty");
    const caps = adapter.capabilities;
    assert(
      ["none", "attach", "full"].includes(caps.runs),
      "capabilities.runs is not none|attach|full",
    );
    assert(["none", "append"].includes(caps.comment), "capabilities.comment is not none|append");
    assert(
      typeof caps.subtasks === "boolean" && typeof caps.fields === "boolean",
      "capabilities are not flags",
    );
  });

  add(
    "the schema lists statuses with a state, unique names, and at most five summary fields",
    async ({ adapter }) => {
      const schema = await adapter.schema({}, o());
      assert(schema.statuses.length > 0, "no statuses");
      const names = schema.statuses.map((s) => s.name);
      assert(new Set(names).size === names.length, "status names are not unique");
      assert(
        schema.statuses.every((s) => isTaskState(s.state)),
        "a status has no valid state",
      );
      assert(
        schema.statuses.some((s) => s.state === "todo"),
        "no status has the state todo",
      );
      assert(
        schema.statuses.some((s) => s.state === "done"),
        "no status has the state done",
      );
      if (schema.priorities) {
        const p = schema.priorities.map((x) => x.name);
        assert(new Set(p).size === p.length, "priority names are not unique");
      }
      assert(
        Boolean(schema.priorities?.length) === adapter.capabilities.priority,
        "capabilities.priority does not match whether the schema lists priorities",
      );
      assert(
        Boolean(schema.types?.length) === adapter.capabilities.types,
        "capabilities.types does not match whether the schema lists types",
      );
      const summary = schema.fields.filter((f) => f.summary);
      assert(summary.length <= TASK_LIMITS.summaryFields, "more than five summary fields");
      assert(
        schema.fields.every((f) => !(f.readonly && f.required)),
        "a read-only field is required",
      );
    },
  );

  add("create returns a complete task", async ({ adapter }, { create }) => {
    const task = await create("A thing to do later");
    const schema = await adapter.schema({}, o());
    assert(task.key.length > 0, "empty key");
    assert(task.title === "A thing to do later", "title was changed");
    const status = schema.statuses.find((s) => s.name === task.status);
    assert(status, `status "${task.status}" is not in the schema`);
    assert(status.state === task.state, "state does not match the schema's state of the status");
    assert(Array.isArray(task.runs), "runs is not a list");
    assert(!Number.isNaN(Date.parse(task.created_at)), "created_at is not a date");
    assert(!Number.isNaN(Date.parse(task.updated_at)), "updated_at is not a date");
    if (task.priority !== undefined && schema.priorities) {
      assert(
        schema.priorities.some((p) => p.name === task.priority),
        "priority is not in the schema",
      );
    }
  });

  add("get finds a task by key and by id, with its subtasks", async ({ adapter }, { create }) => {
    const task = await create("Find me");
    const byKey = await adapter.get(task.key, o());
    assert(
      byKey && byKey.task.key === task.key && byKey.task.title === "Find me",
      "get by key failed",
    );
    assert(Array.isArray(byKey.subtasks), "subtasks is not a list");
    if (task.id !== undefined) {
      const byId = await adapter.get(task.id, o());
      assert(byId && byId.task.key === task.key, "get by id failed");
    }
  });

  add("an unknown key is undefined for get and update, never a throw", async ({ adapter }) => {
    for (const key of ["ZZ-2222", "ZZ-99999999", "no such thing"]) {
      assert((await adapter.get(key, o())) === undefined, `get(${key}) was not undefined`);
      assert(
        (await adapter.update(key, { title: "x" }, o())) === undefined,
        `update(${key}) was not undefined`,
      );
    }
  });

  add(
    "resolveKey never lets a path or a control character through",
    async ({ adapter }, { create }) => {
      for (const input of [
        "../etc/passwd",
        "a/b",
        "a\\b",
        "x\u0000y",
        "",
        "   ",
        "..",
        "KDL-12/../x",
      ]) {
        const key = await adapter.resolveKey(input, o());
        if (key === undefined) continue;
        assert(
          ![...key].some((ch) => ch === "/" || ch === "\\" || ch.charCodeAt(0) < 32),
          `resolveKey(${JSON.stringify(input)}) gave ${JSON.stringify(key)}`,
        );
      }
      const task = await create("Resolve me");
      assert(
        (await adapter.resolveKey(task.key, o())) === task.key,
        "resolveKey(key) is not the key",
      );
    },
  );

  add("a key that is not valid reaches no task", async ({ adapter }) => {
    for (const key of ["../x", "a/b", "x\u0000y"]) {
      assert(
        (await adapter.get(key, o())) === undefined,
        `get(${JSON.stringify(key)}) found something`,
      );
    }
  });

  add(
    "title and text change, and the same change twice gives the same task",
    async ({ adapter }, { create }) => {
      const task = await create("Before", { body: "old" });
      const first = await adapter.update(task.key, { title: "After", body: "new" }, o());
      assert(
        first && first.task.title === "After" && first.task.body === "new",
        "update did not apply",
      );
      const second = await adapter.update(task.key, { title: "After", body: "new" }, o());
      assert(
        second && second.task.title === "After" && second.task.body === "new",
        "repeat changed it",
      );
      assert(second.task.status === first.task.status, "repeat changed the status");
      assert(
        Date.parse(second.task.updated_at) >= Date.parse(task.created_at),
        "updated_at went back",
      );
    },
  );

  add(
    "a move to each status either succeeds or is refused with TASK_TRANSITION_REFUSED",
    async ({ adapter }, { create }) => {
      const schema = await adapter.schema({}, o());
      let moved = 0;
      for (const status of schema.statuses) {
        const task = await create(`Move to ${status.name}`);
        try {
          const done = await adapter.update(task.key, { status: status.name }, o());
          assert(
            done?.task.status === status.name,
            `moved to ${status.name} but reads ${done?.task.status}`,
          );
          assert(
            done.task.state === status.state,
            `state of ${status.name} is not ${status.state}`,
          );
          moved += 1;
        } catch (error) {
          assert(
            error instanceof KodelError && error.code === "TASK_TRANSITION_REFUSED",
            `moving to ${status.name} failed with ${String(error)}`,
          );
          assert(error.message.length > 0, "a refused move has no message");
        }
      }
      assert(moved > 0, "no status could be reached");
    },
  );

  add(
    "an unknown status or priority is INVALID_TASK and names the allowed values",
    async ({ adapter }, { create }) => {
      const schema = await adapter.schema({}, o());
      const task = await create("Bad values");
      const badStatus = await rejection(
        adapter.update(task.key, { status: "No Such Status" }, o()),
        "unknown status",
      );
      assert(badStatus.code === "INVALID_TASK", `unknown status is ${badStatus.code}`);
      const first = schema.statuses[0];
      assert(
        first && badStatus.message.includes(first.name),
        "the message does not list the allowed statuses",
      );
      if (schema.priorities?.[0]) {
        const bad = await rejection(
          adapter.update(task.key, { priority: "No Such Priority" }, o()),
          "unknown priority",
        );
        assert(bad.code === "INVALID_TASK", `unknown priority is ${bad.code}`);
        assert(
          bad.message.includes(schema.priorities[0].name),
          "the message does not list the priorities",
        );
      }
    },
  );

  add("clear empties a field and never sends the text null", async ({ adapter }, { create }) => {
    const task = await create("Has a body", { body: "something" });
    try {
      const done = await adapter.update(task.key, { clear: ["body"] }, o());
      assert(done, "task vanished");
      assert(
        done.task.body === undefined || done.task.body === "",
        `body is ${JSON.stringify(done.task.body)}`,
      );
    } catch (error) {
      assert(
        error instanceof KodelError && error.code === "TASK_UNSUPPORTED",
        `clear body failed with ${String(error)}`,
      );
    }
  });

  add("comments are appended and the latest is the comment", async ({ adapter }, { create }) => {
    if (adapter.capabilities.comment !== "append") return;
    const task = await create("Noted", { comment: "first" });
    assert(task.comment === "first", "the comment given at creation is not the comment");
    const second = await adapter.update(task.key, { comment: "second" }, o());
    assert(second?.task.comment === "second", "the new note is not the latest");
    await adapter.update(task.key, { comment: "second" }, o());
    const read = await adapter.get(task.key, o());
    const texts = (read?.task.comments ?? []).map((c) => c.text);
    assert(texts.length === 3, `expected 3 notes, got ${texts.length}`);
    assert(texts[0] === "first" && texts[2] === "second", "notes are not oldest first");
  });

  add(
    "runs are attached in order, once, and can be searched when the adapter says so",
    async ({ adapter }, { create }) => {
      if (adapter.capabilities.runs === "none") return;
      const task = await create("Many runs", { run: RUN_A });
      assert(
        task.runs.length === 1 && task.runs[0] === RUN_A,
        "the run given at creation is not attached",
      );
      await adapter.update(task.key, { add_run: RUN_B }, o());
      const again = await adapter.update(task.key, { add_run: RUN_B }, o());
      assert(
        JSON.stringify(again?.task.runs) === JSON.stringify([RUN_A, RUN_B]),
        `runs are ${JSON.stringify(again?.task.runs)}`,
      );
      if (adapter.capabilities.runs === "full") {
        const found = await listAll(adapter, { run: RUN_B });
        assert(
          found.tasks.some((t) => t.key === task.key),
          "the run filter did not find the task",
        );
        const none = await listAll(adapter, { run: RUN_C });
        assert(
          !none.tasks.some((t) => t.key === task.key),
          "the run filter found a task of another run",
        );
      }
    },
  );

  add(
    "subtasks: attached, listed, moved, detached, and never a cycle",
    async (subject, { create }) => {
      const { adapter } = subject;
      if (!adapter.capabilities.subtasks) return;
      const parent = await create("Parent");
      const other = await create("Other parent");
      const child = await create("Child", { parent: parent.key });
      assert(child.parent === parent.key, "the child does not name its parent");
      const read = await adapter.get(parent.key, o());
      assert(
        read?.subtasks.some((s) => s.key === child.key && s.title === "Child"),
        "get(parent) misses the child",
      );
      const kids = await listAll(adapter, { parent: parent.key });
      assert(
        kids.tasks.length === 1 && kids.tasks[0]?.key === child.key,
        "the parent filter is wrong",
      );
      const top = await listAll(adapter, { top_level: true });
      assert(!top.tasks.some((t) => t.key === child.key), "top_level shows a subtask");
      assert(
        top.tasks.some((t) => t.key === parent.key),
        "top_level hides a top-level task",
      );
      const summary = top.tasks.find((t) => t.key === parent.key);
      assert(
        summary?.subtasks?.total === 1 && summary.subtasks.done === 0,
        "the parent summary has no counts",
      );

      const moved = await adapter.update(child.key, { parent: other.key }, o());
      assert(moved?.task.parent === other.key, "the move under another parent failed");
      const cycle = await rejection(
        adapter.update(other.key, { parent: child.key }, o()),
        "a cycle",
      );
      assert(cycle.code === "INVALID_TASK", `a cycle is ${cycle.code}`);
      const self = await rejection(
        adapter.update(other.key, { parent: other.key }, o()),
        "self as parent",
      );
      assert(self.code === "INVALID_TASK", `self as parent is ${self.code}`);
      try {
        const detached = await adapter.update(child.key, { clear: ["parent"] }, o());
        assert(detached?.task.parent === undefined, "clear parent left a parent");
      } catch (error) {
        assert(
          error instanceof KodelError && ["TASK_UNSUPPORTED", "INVALID_TASK"].includes(error.code),
          `detach failed with ${String(error)}`,
        );
      }
      const missing = await rejection(
        adapter.create({ ...subject.newTask, title: "Orphan", parent: "ZZ-2222" }, o()),
        "a missing parent",
      );
      assert(
        ["TASK_NOT_FOUND", "INVALID_TASK"].includes(missing.code),
        `a missing parent is ${missing.code}`,
      );
    },
  );

  add(
    "finishing a parent with unfinished children says how many",
    async ({ adapter }, { create }) => {
      if (!adapter.capabilities.subtasks) return;
      const schema = await adapter.schema({}, o());
      const done = schema.statuses.find((s) => s.state === "done");
      assert(done, "no done status");
      const parent = await create("Parent");
      await create("Open child", { parent: parent.key });
      try {
        const result = await adapter.update(parent.key, { status: done.name }, o());
        assert(result?.open_subtasks === 1, `open_subtasks is ${result?.open_subtasks}`);
      } catch (error) {
        assert(
          error instanceof KodelError && error.code === "TASK_TRANSITION_REFUSED",
          `finishing failed with ${String(error)}`,
        );
      }
    },
  );

  add(
    "list filters by state, status and priority, and a summary carries no body",
    async ({ adapter }, { create }) => {
      const schema = await adapter.schema({}, o());
      const task = await create("Listed", { body: "a long body" });
      const open = await adapter.list({ state: ["todo", "progress"], limit: 50 }, o());
      assert(
        open.tasks.some((t) => t.key === task.key),
        "a new task is not among the unfinished ones",
      );
      const finished = await adapter.list({ state: ["done"], limit: 50 }, o());
      assert(
        !finished.tasks.some((t) => t.key === task.key),
        "a new task is among the finished ones",
      );
      const byStatus = await listAll(adapter, { status: task.status });
      assert(
        byStatus.tasks.some((t) => t.key === task.key),
        "the status filter missed the task",
      );
      if (task.priority !== undefined) {
        const byPriority = await listAll(adapter, { priority: task.priority });
        assert(
          byPriority.tasks.some((t) => t.key === task.key),
          "the priority filter missed the task",
        );
      }
      const summary = open.tasks.find((t) => t.key === task.key) as TaskSummary &
        Record<string, unknown>;
      assert(!("body" in summary), "a summary carries the body");
      assert(!("runs" in summary), "a summary carries the run list");
      const shown = Object.keys(summary.fields ?? {});
      const allowed = new Set(schema.fields.filter((f) => f.summary).map((f) => f.name));
      assert(
        shown.every((n) => allowed.has(n)),
        "a summary shows a field that is not declared summary",
      );
    },
  );

  add(
    "paging by next returns every task exactly once, in a stable order",
    async ({ adapter }, { create }) => {
      const made: string[] = [];
      for (let i = 0; i < 5; i += 1) made.push((await create(`Task ${i}`)).key);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const filter: TaskFilter = { state: ALL_STATES, limit: 2 };
        if (cursor !== undefined) filter.cursor = cursor;
        const answer = await adapter.list(filter, o());
        assert(answer.tasks.length <= 2, "a page is longer than the limit");
        seen.push(...answer.tasks.map((t) => t.key));
        if (answer.next === undefined) break;
        assert(answer.tasks.length > 0, "an empty page has a next");
        cursor = answer.next;
      }
      assert(new Set(seen).size === seen.length, "a task came twice");
      assert(
        made.every((k) => seen.includes(k)),
        "a task never came",
      );
      const once = (await listAll(adapter)).tasks.map((t) => t.key);
      const twice = (await listAll(adapter)).tasks.map((t) => t.key);
      assert(JSON.stringify(once) === JSON.stringify(twice), "the order is not stable");
    },
  );

  add("the limit is honoured and a longer list says so", async ({ adapter }, { create }) => {
    for (let i = 0; i < 4; i += 1) await create(`Task ${i}`);
    const answer = await adapter.list({ state: ALL_STATES, limit: 2 }, o());
    assert(answer.tasks.length <= 2, "the limit was not honoured");
    assert(
      answer.next !== undefined || answer.truncated,
      "a longer list gives neither next nor truncated",
    );
  });

  return cases;
}

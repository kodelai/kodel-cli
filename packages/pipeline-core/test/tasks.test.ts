import { describe, expect, test } from "bun:test";
import {
  checkResolvedKey,
  KodelError,
  OPEN_STATES,
  readState,
  TASK_CONTRACT,
  TASK_LIMITS,
  type TaskAdapter,
  TaskAdapterRegistry,
  type TaskFilter,
  validateFilter,
  validateNewTask,
  validatePatch,
} from "../src";

const RUN = "r_0mvimyn54_tc9o";

const refused = (work: () => void): KodelError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(KodelError);
    return error as KodelError;
  }
  throw new Error("did not throw");
};

const failed = async (work: Promise<unknown>): Promise<KodelError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(KodelError);
    return error as KodelError;
  }
  throw new Error("did not fail");
};

describe("what the agent sends is checked", () => {
  test("a good task passes", () => {
    expect(() =>
      validateNewTask({
        title: "Fix the report",
        body: "text",
        priority: "High",
        comment: "why",
        run: RUN,
        parent: "KDL-7K3Q",
        fields: { Component: "Backend", Labels: ["a", "b"], Points: 3, Flag: true },
      }),
    ).not.toThrow();
  });

  test("the title is one line of 1-200 characters", () => {
    for (const title of ["", "   ", "two\nlines", "x".repeat(TASK_LIMITS.title + 1)]) {
      expect(refused(() => validateNewTask({ title })).code).toBe("INVALID_TASK");
    }
    expect(() => validateNewTask({ title: "x".repeat(TASK_LIMITS.title) })).not.toThrow();
  });

  test("body, comment, run and fields are bounded", () => {
    const base = { title: "t" };
    expect(
      refused(() => validateNewTask({ ...base, body: "x".repeat(TASK_LIMITS.body + 1) })).code,
    ).toBe("INVALID_TASK");
    expect(
      refused(() => validateNewTask({ ...base, comment: "x".repeat(TASK_LIMITS.comment + 1) }))
        .code,
    ).toBe("INVALID_TASK");
    expect(refused(() => validateNewTask({ ...base, run: "nope" })).message).toContain("run id");
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, "v"]));
    expect(refused(() => validateNewTask({ ...base, fields: many })).message).toContain(
      "more than 20",
    );
    expect(
      refused(() => validateNewTask({ ...base, fields: { a: { nested: 1 } as never } })).code,
    ).toBe("INVALID_TASK");
    expect(refused(() => validateNewTask({ ...base, fields: { "bad\u0000name": "v" } })).code).toBe(
      "INVALID_TASK",
    );
    expect(refused(() => validateNewTask({ ...base, fields: { a: "x".repeat(501) } })).code).toBe(
      "INVALID_TASK",
    );
  });

  test("t17_a_patch_needs_a_change_and_clear_names_known_fields", () => {
    expect(refused(() => validatePatch({})).message).toContain("nothing to change");
    expect(() =>
      validatePatch({ clear: ["body", "priority", "type", "parent", "fields.Component"] }),
    ).not.toThrow();
    expect(refused(() => validatePatch({ clear: ["title"] })).message).toContain("cannot clear");
    expect(refused(() => validatePatch({ clear: [] })).code).toBe("INVALID_TASK");
    expect(refused(() => validatePatch({ clear: ["body", "body"] })).message).toContain("twice");
    expect(refused(() => validatePatch({ body: "x", clear: ["body"] })).message).toContain(
      "both set and cleared",
    );
  });

  test("a filter needs a sane limit, states and cursor", () => {
    const ok: TaskFilter = { state: ["todo"], limit: 50 };
    expect(() => validateFilter(ok)).not.toThrow();
    expect(refused(() => validateFilter({ ...ok, limit: 0 })).code).toBe("INVALID_TASK");
    expect(refused(() => validateFilter({ ...ok, limit: TASK_LIMITS.listMax + 1 })).code).toBe(
      "INVALID_TASK",
    );
    expect(refused(() => validateFilter({ ...ok, state: [] })).code).toBe("INVALID_TASK");
    expect(refused(() => validateFilter({ ...ok, state: ["finished" as never] })).code).toBe(
      "INVALID_TASK",
    );
    expect(refused(() => validateFilter({ ...ok, cursor: "" })).code).toBe("INVALID_TASK");
  });

  test("t2_an_unknown_state_counts_as_todo_and_open_means_not_done", () => {
    expect(readState("done")).toBe("done");
    expect(readState("cancelled")).toBe("todo");
    expect(readState(undefined)).toBe("todo");
    expect([...OPEN_STATES]).toEqual(["todo", "progress"]);
  });

  test("a key from an adapter must be printable and short", () => {
    expect(checkResolvedKey("KDL-7K3Q")).toBe("KDL-7K3Q");
    for (const bad of ["", "a\nb", "x".repeat(TASK_LIMITS.key + 1)]) {
      expect(refused(() => checkResolvedKey(bad)).code).toBe("TASK_ADAPTER_FAILED");
    }
  });
});

function adapterOf(kind: string, contract: unknown = TASK_CONTRACT): TaskAdapter {
  return {
    contract: contract as 1,
    kind,
    capabilities: { subtasks: false, runs: "none", comment: "none", fields: false },
  } as unknown as TaskAdapter;
}

const ctx = { options: {}, clock: () => 0, random: () => 0.5 };

describe("the registry of task adapters", () => {
  test("creates an adapter by kind and passes the context through", async () => {
    const registry = new TaskAdapterRegistry();
    let seen: unknown;
    registry.register("memory", (c) => {
      seen = c;
      return adapterOf("memory");
    });
    expect((await registry.create("memory", ctx)).kind).toBe("memory");
    expect(seen).toBe(ctx);
  });

  test("an unknown kind is CONFIG_INVALID and names the known kinds", async () => {
    const registry = new TaskAdapterRegistry();
    registry.register("local", () => adapterOf("local"));
    registry.register("jira", () => adapterOf("jira"));
    const error = await failed(registry.create("trello", ctx));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("trello");
    expect(error.message).toContain("jira, local");
  });

  test("a kind cannot be registered twice", () => {
    const registry = new TaskAdapterRegistry();
    registry.register("local", () => adapterOf("local"));
    expect(refused(() => registry.register("local", () => adapterOf("local"))).code).toBe(
      "CONFIG_INVALID",
    );
  });

  test("t14_an_adapter_written_for_another_contract_is_refused_with_both_numbers", async () => {
    const registry = new TaskAdapterRegistry();
    registry.register("future", () => adapterOf("future", 2));
    const error = await failed(registry.create("future", ctx));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("task contract 2");
    expect(error.message).toContain(`supports ${TASK_CONTRACT}`);
  });

  test("an adapter that says it is another kind is refused", async () => {
    const registry = new TaskAdapterRegistry();
    registry.register("a", () => adapterOf("b"));
    const error = await failed(registry.create("a", ctx));
    expect(error.code).toBe("CONFIG_INVALID");
  });
});

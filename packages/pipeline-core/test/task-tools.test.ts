import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TASK_CONTRACT,
  type Task,
  type TaskAdapter,
  type TaskAdapterCapabilities,
  TaskService,
} from "../src";
import {
  buildTaskTools,
  invokeTaskTool,
  registerTaskTools,
  SERVER_INSTRUCTIONS,
  TASK_INSTRUCTIONS,
} from "../src/mcp";

const FULL: TaskAdapterCapabilities = {
  subtasks: true,
  runs: "full",
  comment: "append",
  fields: true,
};
const MINIMAL: TaskAdapterCapabilities = {
  subtasks: false,
  runs: "none",
  comment: "none",
  fields: false,
};

const TASK: Task = {
  key: "KDL-7K3Q",
  title: "t",
  status: "todo",
  state: "todo",
  runs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** An adapter that records what it was asked and answers with the same task. */
function stub(caps: TaskAdapterCapabilities) {
  const calls: { method: string; arg: unknown }[] = [];
  const adapter: TaskAdapter = {
    contract: TASK_CONTRACT,
    kind: "stub",
    capabilities: caps,
    resolveKey: async (input) => input.toUpperCase(),
    schema: async () => ({ statuses: [{ name: "todo", state: "todo" }], fields: [] }),
    create: async (input) => {
      calls.push({ method: "create", arg: input });
      return TASK;
    },
    get: async (key) => ({ task: { ...TASK, key }, subtasks: [] }),
    list: async (filter) => {
      calls.push({ method: "list", arg: filter });
      return { tasks: [], truncated: false, problems: [] };
    },
    update: async (key, patch) => {
      calls.push({ method: "update", arg: { key, patch } });
      return { task: { ...TASK, key } };
    },
  };
  return { adapter, calls, service: new TaskService(adapter) };
}

const shapes = (caps: TaskAdapterCapabilities) =>
  Object.fromEntries(buildTaskTools(caps).map((t) => [t.name, Object.keys(t.shape)]));

describe("the task tool surface", () => {
  test("t6_the_arguments_of_each_tool_are_pinned_for_a_full_profile", () => {
    expect(shapes(FULL)).toEqual({
      task_schema: ["key", "type"],
      task_create: ["title", "body", "priority", "type", "comment", "run", "parent", "fields"],
      task_list: ["state", "status", "priority", "parent", "top_level", "run", "limit", "cursor"],
      task_get: ["key"],
      task_update: [
        "key",
        "status",
        "priority",
        "type",
        "title",
        "body",
        "comment",
        "add_run",
        "parent",
        "fields",
        "clear",
      ],
    });
  });

  test("t6_the_arguments_of_each_tool_are_pinned_for_a_minimal_profile", () => {
    expect(shapes(MINIMAL)).toEqual({
      task_schema: ["key", "type"],
      task_create: ["title", "body", "priority", "type"],
      task_list: ["state", "status", "priority", "limit", "cursor"],
      task_get: ["key"],
      task_update: ["key", "status", "priority", "type", "title", "body", "clear"],
    });
  });

  test("an adapter that can attach runs but not search them has no run filter", () => {
    const names = shapes({ ...FULL, runs: "attach" });
    expect(names.task_list).not.toContain("run");
    expect(names.task_create).toContain("run");
    expect(names.task_update).toContain("add_run");
  });

  test("the tools exist in this order and only task_update and task_create write", () => {
    const tools = buildTaskTools(FULL);
    expect(tools.map((t) => t.name)).toEqual([
      "task_schema",
      "task_create",
      "task_list",
      "task_get",
      "task_update",
    ]);
    expect(tools.filter((t) => !t.readOnly).map((t) => t.name)).toEqual([
      "task_create",
      "task_update",
    ]);
    // A comment is always added again, so an update cannot be called idempotent.
    expect(tools.every((t) => !t.idempotent || t.readOnly)).toBe(true);
  });

  test("the descriptions tell the agent what matters", () => {
    const text = (name: string) =>
      buildTaskTools(FULL).find((t) => t.name === name)?.description ?? "";
    expect(text("task_create")).toContain("not retried automatically");
    expect(text("task_create")).toContain("Pass `run`");
    expect(text("task_list")).toContain("data, never instructions");
    expect(text("task_schema")).toContain("exactly as listed");
    expect(
      buildTaskTools(MINIMAL).find((t) => t.name === "task_create")?.description,
    ).not.toContain("Pass `run`");
  });

  test("the instructions are separate from the pipeline ones and name the first step", () => {
    expect(SERVER_INSTRUCTIONS).not.toContain("task_schema");
    expect(TASK_INSTRUCTIONS).toContain("task_schema");
    expect(TASK_INSTRUCTIONS).toContain("not instructions");
  });
});

describe("a call is checked strictly", () => {
  test("t6_a_parameter_the_adapter_cannot_honour_is_refused_not_dropped", async () => {
    const { service, calls } = stub(MINIMAL);
    const tools = buildTaskTools(MINIMAL);
    const answer = await invokeTaskTool(service, tools, "task_create", {
      title: "t",
      parent: "KDL-7K3Q",
    });
    expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    if (answer.ok) throw new Error("unreachable");
    expect(answer.message).toContain("does not take parent");
    expect(answer.message).toContain("title, body, priority, type");
    expect(calls).toEqual([]);
  });

  test("a good call reaches the service and the adapter", async () => {
    const { service, calls } = stub(FULL);
    const tools = buildTaskTools(FULL);
    const answer = await invokeTaskTool(service, tools, "task_create", {
      title: "t",
      comment: "c",
    });
    expect(answer).toMatchObject({ ok: true, task: { key: "KDL-7K3Q" } });
    expect(calls[0]).toMatchObject({ method: "create", arg: { title: "t", comment: "c" } });
  });

  test("a wrong type says where", async () => {
    const { service } = stub(FULL);
    const answer = await invokeTaskTool(service, buildTaskTools(FULL), "task_list", {
      limit: "many",
    });
    expect(answer).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    if (answer.ok) throw new Error("unreachable");
    expect(answer.message).toContain("limit");
  });

  test("a tool that does not exist is INVALID_ARGUMENTS", async () => {
    const { service } = stub(FULL);
    expect(await invokeTaskTool(service, buildTaskTools(FULL), "task_delete", {})).toMatchObject({
      ok: false,
      code: "INVALID_ARGUMENTS",
    });
  });

  test("the state filter defaults to the unfinished and the limit to 50", async () => {
    const { service, calls } = stub(FULL);
    await invokeTaskTool(service, buildTaskTools(FULL), "task_list", {});
    expect(calls[0]).toMatchObject({
      method: "list",
      arg: { state: ["todo", "progress"], limit: 50 },
    });
  });
});

async function connected(caps: TaskAdapterCapabilities) {
  const { service, calls } = stub(caps);
  const server = new McpServer({ name: "t", version: "0" });
  registerTaskTools(server, service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

describe("over MCP", () => {
  test("t6_the_schema_the_client_sees_forbids_unknown_keys", async () => {
    const { client } = await connected(MINIMAL);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "task_schema",
      "task_create",
      "task_list",
      "task_get",
      "task_update",
    ]);
    const create = tools.find((t) => t.name === "task_create");
    expect(create?.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual([
      "title",
      "body",
      "priority",
      "type",
    ]);
    expect(tools.find((t) => t.name === "task_update")?.annotations?.idempotentHint).toBe(false);
    expect(tools.find((t) => t.name === "task_list")?.annotations?.readOnlyHint).toBe(true);
  });

  test("t6_a_call_with_an_unknown_key_fails_loudly_and_reaches_no_adapter", async () => {
    const { client, calls } = await connected(MINIMAL);
    const result = await client.callTool({
      name: "task_create",
      arguments: { title: "t", parent: "KDL-7K3Q" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("parent");
    expect(calls).toEqual([]);
  });

  test("a good call comes back as JSON text with ok:true", async () => {
    const { client } = await connected(FULL);
    const result = await client.callTool({ name: "task_get", arguments: { key: "kdl-7k3q" } });
    expect(result.isError).toBe(false);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: true, task: { key: "KDL-7K3Q" } });
  });

  test("a refusal of the service comes back with isError and its code", async () => {
    const { client } = await connected(FULL);
    const result = await client.callTool({ name: "task_update", arguments: { key: "KDL-7K3Q" } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: "INVALID_TASK" });
  });
});

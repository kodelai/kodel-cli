/**
 * Decision 5M9D: an agent connected to `kodel mcp` can call exactly the tools chosen by the role, the
 * person's `mcp.roles` block and `--read-only`. This file holds the part that needs no process: the
 * role tables, the resolver, the marks, the texts and the dispatchers. The same through a real server
 * is in `packages/cli/test/mcp-roles.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_ACTION_TOOLS,
  ATTACHMENT_TOOL_NAMES,
  DECISION_TOOLS,
  HISTORY_TOOL_NAMES,
  KNOWN_TOOL_NAMES,
  MANAGER_TOOL_NAMES,
  PIPELINE_TOOL_NAMES,
  type PipelineService,
  ROLE_TOOLS,
  type RoleOverrides,
  RUN_CORE,
  resolveToolSet,
  roleOverridesProblem,
  type ServerRole,
  servedUnderKeys,
  TASK_CONTRACT,
  TASK_TOOL_NAMES,
  type TaskAdapter,
  type TaskAdapterCapabilities,
  TaskService,
  toolsFingerprint,
} from "../src";
import {
  type AgentDecider,
  buildTaskTools,
  CONTRACT_VERSION,
  decisionTools,
  HISTORY_TOOLS,
  invokeHistoryTool,
  invokeManagerTool,
  invokeTaskTool,
  invokeTool,
  keepOnly,
  MANAGER_TOOLS,
  type ManagerToolDescriptor,
  serverInstructions,
  type ToolSpec,
  taskInstructions,
  toolsFor,
} from "../src/mcp";

const FULL: TaskAdapterCapabilities = {
  subtasks: true,
  runs: "full",
  comment: "append",
  fields: true,
  priority: true,
  types: true,
  provenance: true,
};
const MINIMAL: TaskAdapterCapabilities = {
  subtasks: false,
  runs: "none",
  comment: "none",
  fields: false,
  priority: false,
  types: false,
};
const PROFILES: TaskAdapterCapabilities[] = [
  FULL,
  MINIMAL,
  { ...MINIMAL, runs: "attach" },
  { ...FULL, comment: "none", subtasks: false },
];

const decider: AgentDecider = {
  decideGate: async () => ({ ok: true }),
  acceptChange: async () => ({ ok: true }),
  cancelRun: async () => ({ ok: true }),
};
const BOTH = { gate: true, pipelineChange: true };
/** `manager_cancel_run` (NE3N): a manager's server only, under its key; never one with no role. */
const CANCEL = "manager_cancel_run";
const withoutCancel = (names: readonly string[]) => names.filter((n) => n !== CANCEL);

interface Setup {
  role?: ServerRole;
  readOnly?: boolean;
  decisions?: boolean;
  /** `decisions.agent.start_task` and `stop_agent`: the manager's acting tools are served. */
  keys?: boolean;
  tasks?: TaskAdapterCapabilities;
  taskLink?: "auto" | "ask";
  overrides?: RoleOverrides;
  /** The host keeps attachments, as the local one does; `false` for a host that keeps none. */
  attachments?: boolean;
}

/** A server's surface, put together the way `createServer` of the CLI does it. */
function surface(setup: Setup) {
  const lookWith = setup.role === "manager" ? "manager_inbox" : "pipeline_next_step";
  // As the CLI does: the cancel's key is on with the others, and only a manager gets the tool.
  const flags = setup.decisions === true ? { ...BOTH, cancelRun: setup.role === "manager" } : {};
  const taskLink = setup.tasks !== undefined && setup.taskLink !== undefined;
  const attachments = setup.attachments !== false;
  const keys = setup.keys === true ? { startTask: true, stopAgent: true } : undefined;
  const managerTools = MANAGER_TOOLS.filter((tool) => servedUnderKeys(tool.name, keys));
  const resolved = resolveToolSet({
    ...(setup.role === undefined ? {} : { role: setup.role }),
    ...(setup.overrides === undefined ? {} : { overrides: setup.overrides }),
    readOnly: setup.readOnly === true,
    available: [
      ...toolsFor({ taskLink, attachments }),
      ...decisionTools(flags, decider, { lookWith }),
      ...HISTORY_TOOLS,
      ...managerTools,
      ...(setup.tasks === undefined ? [] : buildTaskTools(setup.tasks)),
    ],
  });
  if (resolved.refused !== undefined) throw new Error(resolved.refused);
  const only = resolved.names;
  const tools: ToolSpec[] = [
    ...keepOnly(
      [
        ...toolsFor({
          taskLink,
          attachments,
          ...(setup.role === undefined ? {} : { role: setup.role }),
          served: only,
        }),
        ...decisionTools(flags, decider, { lookWith }),
      ],
      only,
    ),
    ...keepOnly(HISTORY_TOOLS, only),
    ...keepOnly(managerTools, only),
    ...(setup.tasks === undefined ? [] : keepOnly(buildTaskTools(setup.tasks, only), only)),
  ];
  const served = tools.map((tool) => tool.name);
  const base = serverInstructions({
    decisions: flags,
    attachments,
    ...(setup.role === undefined ? {} : { role: setup.role }),
    served,
  });
  const instructions = served.some((name) => name.startsWith("task_"))
    ? `${base}\n\n${taskInstructions(setup.taskLink ?? "disabled", taskLink, served)}`
    : base;
  return { tools, served, instructions, unapplied: resolved.unapplied };
}

const sorted = (names: readonly string[]) => [...names].sort();

describe("5m9d the role tables", () => {
  test("5m9d_role_sets_are_exactly_the_listed_tools", () => {
    // The lists of the task, spelled out: a new tool is reviewed here.
    expect(sorted(ROLE_TOOLS.worker)).toEqual(
      sorted([
        "pipeline_start",
        "pipeline_next_step",
        "pipeline_take_step",
        "pipeline_complete_step",
        "pipeline_report_result",
        "pipeline_list",
        "pipeline_resolve",
        "pipeline_plan",
        "pipeline_docs",
        "pipeline_feedback",
        "pipeline_propose_change",
        "pipeline_attachment_write",
        "pipeline_attachment_read",
        "pipeline_attachment_list",
        "task_get",
        "task_list",
        "task_schema",
        "task_create",
      ]),
    );
    expect(sorted(ROLE_TOOLS.manager)).toEqual(
      sorted([
        "history_runs",
        "history_run_details",
        "history_agent_log",
        "history_stats",
        "task_schema",
        "task_create",
        "task_list",
        "task_get",
        "task_update",
        "pipeline_list",
        "pipeline_resolve",
        "pipeline_docs",
        "pipeline_propose_change",
        "pipeline_attachment_read",
        "pipeline_attachment_list",
        "pipeline_decide_gate",
        "pipeline_accept_change",
        "manager_cancel_run",
        "manager_start_task",
        "manager_stop_agent",
        "manager_inbox",
        "manager_run_report",
        "manager_gate_changes",
        "manager_serve_status",
        "manager_agents",
        "manager_agent_log",
        "manager_watch",
      ]),
    );
    const worker = surface({ role: "worker", decisions: true, tasks: FULL, taskLink: "ask" });
    expect(sorted(worker.served)).toEqual(sorted(ROLE_TOOLS.worker));
    const manager = surface({ role: "manager", decisions: true, keys: true, tasks: FULL });
    expect(sorted(manager.served)).toEqual(sorted(ROLE_TOOLS.manager));
    for (const name of ["pipeline_start", "pipeline_next_step", "pipeline_take_step"]) {
      expect(manager.served).not.toContain(name);
    }
    expect(manager.served).not.toContain("pipeline_complete_step");
    expect(manager.served).not.toContain("pipeline_report_result");
  });

  test("5m9d_no_role_serves_the_union", () => {
    const all = surface({ decisions: true, keys: true, tasks: FULL });
    // The union of both roles, but for the cancel: a server with no role may work the run itself.
    expect(sorted(all.served)).toEqual(sorted(withoutCancel(KNOWN_TOOL_NAMES)));
    expect(sorted(all.served)).toEqual(
      sorted(withoutCancel([...new Set([...ROLE_TOOLS.worker, ...ROLE_TOOLS.manager])])),
    );
    expect(all.served).not.toContain(CANCEL);
    // Without tasks and without decisions.agent the tools of both are absent, as before.
    const plain = surface({});
    expect(plain.served.filter((n) => n.startsWith("task_"))).toEqual([]);
    for (const name of DECISION_TOOLS) expect(plain.served).not.toContain(name);
  });

  test("5m9d_union_follows_the_overrides_of_both_roles", () => {
    // Removed in one role alone: the other still has it, so the server with no role keeps it, and says so.
    const one = surface({ overrides: { worker: { remove: ["pipeline_list"] } } });
    expect(one.served).toContain("pipeline_list");
    expect(one.unapplied.map((u) => u.name)).toEqual(["pipeline_list"]);
    // Removed in both: gone.
    const both = surface({
      overrides: {
        worker: { remove: ["pipeline_list"] },
        manager: { remove: ["pipeline_list"] },
      },
    });
    expect(both.served).not.toContain("pipeline_list");
    expect(both.unapplied).toEqual([]);
    // A tool only one role has is removed by that role's block.
    const history = surface({ overrides: { manager: { remove: ["history_stats"] } } });
    expect(history.served).not.toContain("history_stats");
    // An `add` in one role and a `remove` in the other: the union has it.
    const added = surface({
      overrides: {
        manager: { add: ["pipeline_plan"] },
        worker: { remove: ["pipeline_plan"] },
      },
    });
    expect(added.served).toContain("pipeline_plan");
  });

  test("5m9d_the_person_can_give_the_manager_run_tools", () => {
    const manager = surface({
      role: "manager",
      overrides: { manager: { add: ["pipeline_start", "pipeline_next_step"] } },
    });
    expect(manager.served).toContain("pipeline_start");
    expect(manager.served).toContain("pipeline_next_step");
    expect(manager.served).not.toContain("pipeline_complete_step");
  });

  test("5m9d_decision_tools_still_need_decisions_agent", () => {
    // Named in `add`, but the config does not let the agent decide: not served, and named as unapplied.
    const off = surface({
      role: "manager",
      overrides: { manager: { add: ["pipeline_decide_gate"] } },
    });
    expect(off.served).not.toContain("pipeline_decide_gate");
    expect(off.unapplied.map((u) => u.name)).toEqual(["pipeline_decide_gate"]);
    expect(surface({ role: "manager", decisions: true }).served).toContain("pipeline_decide_gate");
  });

  test("5m9d_an_unserved_known_name_is_reported", () => {
    // A task tool with tasks off.
    const tasksOff = surface({ role: "worker", overrides: { worker: { add: ["task_update"] } } });
    expect(tasksOff.served).not.toContain("task_update");
    expect(tasksOff.unapplied).toEqual([
      { name: "task_update", why: expect.stringContaining("tasks on") as unknown as string },
    ]);
    // With tasks on the same block gives the worker the tool.
    const tasksOn = surface({
      role: "worker",
      tasks: FULL,
      overrides: { worker: { add: ["task_update"] } },
    });
    expect(tasksOn.served).toContain("task_update");
    expect(tasksOn.unapplied).toEqual([]);
  });
});

describe("5m9d the marks", () => {
  const everyTool = (): ToolSpec[] => [
    ...toolsFor({ taskLink: true, attachments: true }),
    ...decisionTools({ ...BOTH, cancelRun: true }, decider, { lookWith: "manager_inbox" }),
    ...HISTORY_TOOLS,
    ...MANAGER_TOOLS,
    ...buildTaskTools(FULL),
  ];

  test("5m9d_every_tool_has_a_mark_and_a_role", () => {
    const tools = everyTool();
    expect(sorted(tools.map((t) => t.name))).toEqual(sorted(KNOWN_TOOL_NAMES));
    for (const tool of tools) {
      expect(typeof tool.readOnly, tool.name).toBe("boolean");
      expect(typeof tool.idempotent, tool.name).toBe("boolean");
      // An allow-list: a tool that is in no role is served by no role.
      const inARole =
        ROLE_TOOLS.worker.includes(tool.name) || ROLE_TOOLS.manager.includes(tool.name);
      expect(inARole, tool.name).toBe(true);
    }
    // The name lists kept without the SDK are the registries'.
    expect(sorted(MANAGER_TOOL_NAMES)).toEqual(
      sorted(MANAGER_TOOLS.map((t) => t.name).filter((n) => !AGENT_ACTION_TOOLS.includes(n))),
    );
    expect(sorted(AGENT_ACTION_TOOLS)).toEqual(
      sorted(MANAGER_TOOLS.map((t) => t.name).filter((n) => AGENT_ACTION_TOOLS.includes(n))),
    );
    expect(sorted([...PIPELINE_TOOL_NAMES, ...HISTORY_TOOL_NAMES])).toEqual(
      sorted(
        [...toolsFor({ attachments: true }), ...decisionTools(BOTH, decider), ...HISTORY_TOOLS].map(
          (t) => t.name,
        ),
      ),
    );
    for (const name of RUN_CORE) expect(ROLE_TOOLS.worker).toContain(name);
  });

  test("5m9d_task_tool_names_match_the_registry", () => {
    for (const caps of PROFILES) {
      expect(sorted(buildTaskTools(caps).map((t) => t.name))).toEqual(sorted(TASK_TOOL_NAMES));
    }
  });

  test("5m9d_write_tools_are_the_pinned_list", () => {
    const writes = everyTool()
      .filter((tool) => !tool.readOnly)
      .map((tool) => tool.name);
    expect(sorted(writes)).toEqual(
      sorted([
        "pipeline_start",
        "pipeline_next_step",
        "pipeline_take_step",
        "pipeline_report_result",
        "pipeline_complete_step",
        "pipeline_feedback",
        "pipeline_propose_change",
        "pipeline_decide_gate",
        "pipeline_accept_change",
        "manager_cancel_run",
        "pipeline_attachment_write",
        "manager_start_task",
        "manager_stop_agent",
        "task_create",
        "task_update",
      ]),
    );
  });

  test("5m9d_read_only_is_applied_last", () => {
    const readOnly = surface({ readOnly: true, decisions: true, tasks: FULL });
    for (const tool of readOnly.tools) expect(tool.readOnly, tool.name).toBe(true);
    expect(readOnly.served).not.toContain("pipeline_next_step");
    expect(readOnly.served).toContain("pipeline_list");
    expect(readOnly.served).toContain("manager_inbox");
    // `add` is applied before `--read-only`, so it cannot bring a write back.
    const added = surface({
      role: "manager",
      readOnly: true,
      overrides: { manager: { add: ["pipeline_start", "pipeline_plan"] } },
    });
    expect(added.served).not.toContain("pipeline_start");
    expect(added.served).toContain("pipeline_plan");
    expect(added.unapplied.map((u) => u.name)).toEqual(["pipeline_start"]);
    // A worker that only reads cannot work a run: the resolver refuses the pair.
    const refused = resolveToolSet({ role: "worker", readOnly: true, available: [] });
    expect(refused.refused).toContain("--role worker cannot be --read-only");
  });

  test("5m9d_fingerprint_covers_the_role_and_the_final_set", () => {
    expect(CONTRACT_VERSION).toBe(8);
    const hash = (setup: Setup, header: { role: ServerRole | "all"; readOnly: boolean }) =>
      createHash("sha256")
        .update(toolsFingerprint(surface(setup).tools, header))
        .digest("hex");
    const all = { role: "all" as const, readOnly: false };
    // Same input, same text.
    expect(hash({}, all)).toBe(hash({}, all));
    const seen = new Set([
      hash({}, all),
      // the role alone, over the same tools
      hash({}, { role: "worker", readOnly: false }),
      // `--read-only` alone
      hash({}, { role: "all", readOnly: true }),
      hash({ role: "worker" }, { role: "worker", readOnly: false }),
      hash({ role: "manager" }, { role: "manager", readOnly: false }),
      hash({ readOnly: true }, { role: "all", readOnly: true }),
      // a task tool
      hash({ tasks: FULL }, all),
      hash({ tasks: MINIMAL }, all),
    ]);
    expect(seen.size).toBe(8);
    // A mark: the same tool with the other mark hashes differently.
    const [first, ...rest] = surface({}).tools;
    if (first === undefined) throw new Error("no tool");
    expect(toolsFingerprint([{ ...first, readOnly: !first.readOnly }, ...rest], all)).not.toBe(
      toolsFingerprint([first, ...rest], all),
    );
    // A host with no roles passes no header and gets the plain list, as before the header existed.
    expect(toolsFingerprint([first]).startsWith("[")).toBe(true);
  });
});

describe("5m9d the config check", () => {
  test("5m9d_config_names_an_unknown_tool", () => {
    expect(roleOverridesProblem({ manager: { add: ["pipeline_strat"] } })).toContain(
      '"pipeline_strat"',
    );
    expect(roleOverridesProblem({ worker: { remove: ["nope_tool"] } })).toContain('"nope_tool"');
    expect(roleOverridesProblem({})).toBeUndefined();
    expect(roleOverridesProblem({ manager: { add: ["pipeline_start"] } })).toBeUndefined();
  });

  test("5m9d_config_refuses_decision_tools_for_the_worker", () => {
    for (const name of DECISION_TOOLS) {
      const problem = roleOverridesProblem({ worker: { add: [name] } });
      expect(problem).toContain(`"${name}"`);
      expect(problem).toContain("never");
      // Whatever table is handed in, the resolver gives the worker none.
      const forced = resolveToolSet({
        role: "worker",
        available: [{ name, readOnly: false }],
        roles: { worker: [name], manager: [] },
      });
      expect(forced.refused === undefined && forced.names).toEqual([]);
    }
  });

  test("5m9d_config_refuses_removing_the_core_of_a_run", () => {
    for (const name of RUN_CORE) {
      expect(roleOverridesProblem({ worker: { remove: [name] } })).toContain(`"${name}"`);
    }
    // The manager may lose anything.
    expect(roleOverridesProblem({ manager: { remove: ["manager_inbox"] } })).toBeUndefined();
    expect(roleOverridesProblem({ worker: { remove: ["pipeline_plan"] } })).toBeUndefined();
  });

  test("5m9d_config_refuses_a_name_in_add_and_remove", () => {
    const problem = roleOverridesProblem({
      manager: { add: ["pipeline_plan"], remove: ["pipeline_plan"] },
    });
    expect(problem).toContain('"pipeline_plan"');
    expect(problem).toContain("both add and remove");
    // The resolver refuses a block with a problem instead of serving anything.
    expect(
      resolveToolSet({ overrides: { manager: { add: ["x_tool"] } }, available: [] }).refused,
    ).toContain('"x_tool"');
  });
});

describe("5m9d the dispatchers", () => {
  const taskService = () => {
    const adapter = {
      contract: TASK_CONTRACT,
      kind: "stub",
      capabilities: FULL,
    } as unknown as TaskAdapter;
    return new TaskService(adapter, { rules: [] } as never);
  };

  test("5m9d_each_dispatcher_refuses_a_tool_outside_the_set", async () => {
    const only = surface({ role: "manager", decisions: true, tasks: FULL }).served.filter(
      (name) => !["pipeline_list", "history_runs", "task_update", "manager_inbox"].includes(name),
    );
    const none = {} as PipelineService;
    const refused = { ok: false, code: "INVALID_ARGUMENTS" };
    const pipeline = keepOnly(toolsFor({ role: "manager", served: only }), only);
    expect(await invokeTool(none, "pipeline_list", {}, pipeline)).toMatchObject({
      ...refused,
      message: 'there is no tool "pipeline_list"',
    });
    // Not in the manager's set at all.
    expect(await invokeTool(none, "pipeline_start", { task: "x" }, pipeline)).toMatchObject({
      ...refused,
      message: 'there is no tool "pipeline_start"',
    });
    expect(
      await invokeHistoryTool(none, "history_runs", {}, keepOnly(HISTORY_TOOLS, only)),
    ).toMatchObject({ ...refused, message: 'there is no tool "history_runs"' });
    expect(
      await invokeTaskTool(
        taskService(),
        keepOnly(buildTaskTools(FULL, only), only),
        "task_update",
        { key: "K-1", title: "x" },
      ),
    ).toMatchObject({ ...refused, message: 'there is no tool "task_update"' });
    expect(
      await invokeManagerTool({}, "manager_inbox", {}, keepOnly(MANAGER_TOOLS, only)),
    ).toMatchObject({ ...refused, message: 'there is no tool "manager_inbox"' });
    // A name that never existed is refused the same way by every one of them.
    expect(await invokeTool(none, "pipeline_approve", {}, pipeline)).toMatchObject(refused);
    expect(await invokeManagerTool({}, "manager_decide", {})).toMatchObject(refused);
  });

  test("5m9d_manager_propose_change_is_strict", async () => {
    const calls: unknown[] = [];
    const service = {
      proposeChange: async (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    } as unknown as PipelineService;
    const manager = toolsFor({ role: "manager" });
    const tool = manager.find((t) => t.name === "pipeline_propose_change");
    expect(Object.keys(tool?.shape ?? {})).toEqual(["pipeline", "summary", "name"]);
    // A call with run_id is refused, not read as a proposal for the project.
    const withRun = await invokeTool(
      service,
      "pipeline_propose_change",
      { run_id: "r_0mvu1vxry_4ggv", pipeline: "name: x", summary: "s" },
      manager,
    );
    expect(withRun).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect((withRun as { message: string }).message).toContain("run_id");
    expect(
      await invokeTool(
        service,
        "pipeline_propose_change",
        { pipeline: "name: x", summary: "s", extra: 1 },
        manager,
      ),
    ).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(calls).toEqual([]);
    expect(
      await invokeTool(
        service,
        "pipeline_propose_change",
        { pipeline: "name: x", summary: "s" },
        manager,
      ),
    ).toEqual({ ok: true });
    // The worker's takes run_id as today.
    const worker = toolsFor({ role: "worker" });
    expect(
      Object.keys(worker.find((t) => t.name === "pipeline_propose_change")?.shape ?? {}),
    ).toContain("run_id");
    await invokeTool(
      service,
      "pipeline_propose_change",
      { run_id: "r_0mvu1vxry_4ggv", pipeline: "name: x", summary: "s" },
      worker,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ run_id: "r_0mvu1vxry_4ggv" });
  });
});

describe("5m9d the texts", () => {
  const SETUPS: Setup[] = [];
  for (const role of [undefined, "worker", "manager"] as const) {
    for (const readOnly of [false, true]) {
      if (role === "worker" && readOnly) continue;
      for (const decisions of [false, true]) {
        for (const tasks of [undefined, FULL, MINIMAL]) {
          for (const taskLink of [undefined, "auto", "ask"] as const) {
            if (tasks === undefined && taskLink !== undefined) continue;
            SETUPS.push({
              ...(role === undefined ? {} : { role }),
              readOnly,
              decisions,
              ...(tasks === undefined ? {} : { tasks }),
              ...(taskLink === undefined ? {} : { taskLink }),
            });
          }
        }
      }
    }
  }

  test("5m9d_texts_name_only_served_tools", () => {
    expect(SETUPS.length).toBeGreaterThan(50);
    for (const setup of SETUPS) {
      const { tools, served, instructions } = surface(setup);
      const absent = KNOWN_TOOL_NAMES.filter((name) => !served.includes(name));
      const where = JSON.stringify({ ...setup, tasks: setup.tasks === undefined ? "off" : "on" });
      for (const name of absent) {
        const word = new RegExp(`\\b${name}\\b`);
        expect(word.test(instructions), `${name} in the instructions of ${where}`).toBe(false);
        for (const tool of tools) {
          const text = [
            tool.description,
            ...Object.values(tool.shape).map((field) => field.description ?? ""),
          ].join("\n");
          expect(word.test(text), `${name} in ${tool.name} of ${where}`).toBe(false);
        }
      }
    }
  });

  test("5m9d_worker_role_ignores_decisions_agent", () => {
    // The config lets an agent decide, and the worker's surface is the one without it.
    const withAllowance = surface({ role: "worker", decisions: true, tasks: FULL });
    const without = surface({ role: "worker", tasks: FULL });
    expect(withAllowance.served).toEqual(without.served);
    expect(withAllowance.instructions).toBe(without.instructions);
    expect(withAllowance.instructions).not.toContain("lets you decide");
    expect(withAllowance.instructions).not.toContain("Unless rule");
    // The worker keeps the numbers the other texts refer to.
    for (const rule of ["1. ", "4. ", "9. ", "9a. ", "9b. "]) {
      expect(withAllowance.instructions).toContain(`\n${rule}`);
    }
    expect(withAllowance.instructions).not.toContain("\n9c. ");
    // 9d is the rule of the attachment tools, which the worker has; 9e is the manager's.
    expect(withAllowance.instructions).toContain("\n9d. pipeline_attachment_write ");
    expect(withAllowance.instructions).not.toContain("\n9e. ");
  });

  test("5m9d_attachment_tools_follow_the_role", () => {
    const names = (list: readonly string[]) =>
      list.filter((n) => n.startsWith("pipeline_attachment_"));
    // The worker keeps files with the run; the manager reads what the person is shown and writes none.
    const worker = surface({ role: "worker" });
    expect(sorted(names(worker.served))).toEqual(sorted(ATTACHMENT_TOOL_NAMES));
    const manager = surface({ role: "manager", decisions: true });
    expect(sorted(names(manager.served))).toEqual([
      "pipeline_attachment_list",
      "pipeline_attachment_read",
    ]);
    expect(manager.instructions).toContain(
      "pipeline_attachment_list and pipeline_attachment_read show",
    );
    expect(manager.instructions).not.toContain("pipeline_attachment_write");
    // A decision through a manager is held against what manager_gate_changes showed.
    const decide = manager.tools.find((t) => t.name === "pipeline_decide_gate");
    expect(decide?.description).toContain("manager_gate_changes");
    expect(decide?.description).not.toContain("waiting answer");
    // `--read-only` keeps the two that read.
    const readOnly = surface({ readOnly: true });
    expect(sorted(names(readOnly.served))).toEqual([
      "pipeline_attachment_list",
      "pipeline_attachment_read",
    ]);
    expect(readOnly.instructions).not.toContain("pipeline_attachment_write");
    // A host that keeps no attachments serves none, names none, and says so of an `add`.
    const none = surface({
      role: "manager",
      attachments: false,
      overrides: { manager: { add: ["pipeline_attachment_write"] } },
    });
    expect(names(none.served)).toEqual([]);
    expect(none.instructions).not.toContain("pipeline_attachment");
    expect(none.unapplied).toEqual([
      {
        name: "pipeline_attachment_write",
        why: expect.stringContaining("keeps no attachments") as unknown as string,
      },
    ]);
    // The person can give the manager the write, as any other tool.
    const given = surface({
      role: "manager",
      overrides: { manager: { add: ["pipeline_attachment_write"] } },
    });
    expect(sorted(names(given.served))).toEqual(sorted(ATTACHMENT_TOOL_NAMES));
  });

  test("5m9d_manager_decides_from_the_inbox", () => {
    const manager = surface({ role: "manager", decisions: true });
    // The cancel decides no waiting step; it is served beside them and named in the rule.
    expect(manager.served).toContain(CANCEL);
    expect(manager.instructions).toContain(CANCEL);
    for (const name of withoutCancel(DECISION_TOOLS)) {
      const tool = manager.tools.find((t) => t.name === name);
      expect(tool?.description).toContain("manager_inbox");
      expect(tool?.description).toContain("no step is handed to you");
      expect(tool?.description).not.toContain("tell_the_person");
    }
    expect(manager.instructions).toContain("pipeline_decide_gate");
    expect(manager.instructions).toContain("manager_inbox lists");
    expect(manager.instructions).toContain("It works no run");
    // Where the run is worked the decision tools read as they always did.
    const all = surface({ decisions: true });
    expect(all.tools.find((t) => t.name === "pipeline_decide_gate")?.description).toContain(
      "do what `tell_the_person` says",
    );
  });

  const golden = (name: string) =>
    readFileSync(join(import.meta.dir, "fixtures", name), "utf8").replace(/\n$/, "");

  test("5m9d_no_role_instructions_match_the_golden_text", () => {
    // The golden files were written from `main` before any edit of this change and are never
    // regenerated here. What differs is listed, and each entry is asserted on its own.
    const REPLACED = [
      {
        from: "pipeline_next_step only reads; it never takes a step.",
        to: "pipeline_next_step never takes a step.",
      },
      {
        // T-47: the `engines` block is the person's, said after rule 5.
        from: "is pipeline_propose_change, and a person accepts it.",
        to: "is pipeline_propose_change, and a person accepts it. The `engines` block of the project config (.kodel/config.yaml) is the person's as well: it says which programs kodel starts as agents, so never add to it or change it.",
      },
    ];
    const ADDED = [/^9e\. To look after the runs for the person: manager_inbox lists /];
    const cases: [string, string][] = [
      ["instructions-no-role.txt", surface({}).instructions],
      // A host that keeps no attachments has no rule 9d; the added rule keeps its number.
      ["instructions-no-role-no-attachments.txt", surface({ attachments: false }).instructions],
      [
        "instructions-no-role-tasks-ask.txt",
        surface({ tasks: FULL, taskLink: "ask" }).instructions,
      ],
      [
        "instructions-no-role-decisions-dialog.txt",
        serverInstructions({
          dialog: true,
          waitHint: false,
          decisions: BOTH,
          attachments: true,
          served: surface({ decisions: true }).served,
        }),
      ],
    ];
    for (const [file, now] of cases) {
      const lines = now.split("\n");
      const added = lines.filter((line) => ADDED.some((pattern) => pattern.test(line)));
      expect(added, file).toHaveLength(ADDED.length);
      const kept = lines.filter((line) => !added.includes(line));
      const before = golden(file).split("\n");
      expect(kept.length, file).toBe(before.length);
      let replaced = 0;
      before.forEach((line, i) => {
        const change = REPLACED.find((r) => line.includes(r.from));
        if (change === undefined) {
          expect(kept[i], `${file} line ${i + 1}`).toBe(line);
        } else {
          replaced += 1;
          expect(kept[i], `${file} line ${i + 1}`).toBe(line.replace(change.from, change.to));
        }
      });
      expect(replaced, file).toBe(REPLACED.length);
      // The added rule stands after 9c, and after 9d (the attachment tools, T-45) where the host keeps
      // attachments, and before the dialog rule, so the others keep their numbers.
      const at = lines.findIndex((line) => line.startsWith("9e. "));
      const last = file.includes("no-attachments") ? "9c. " : "9d. ";
      expect(lines[at - 1]?.startsWith(last), file).toBe(true);
    }
  });
});

describe("mstart the manager's acting tools", () => {
  const resolved = (input: Parameters<typeof resolveToolSet>[0]) => {
    const answer = resolveToolSet(input);
    if (answer.refused !== undefined) throw new Error(answer.refused);
    return answer;
  };
  const nonAction = [{ name: "manager_inbox", readOnly: true }];
  const acting = [
    { name: "manager_start_task", readOnly: false },
    { name: "manager_stop_agent", readOnly: false },
  ];

  test("5m9d_new_tools_need_keys", () => {
    // Without a key the tool is not available, whatever the role or an `add` says.
    const off = resolved({
      role: "manager",
      overrides: { manager: { add: ["manager_start_task"] } },
      available: nonAction,
    });
    expect(off.refused).toBeUndefined();
    expect(off.names).toEqual(["manager_inbox"]);
    expect(off.unapplied?.map((u) => u.name)).toEqual(["manager_start_task"]);
    expect(off.unapplied?.[0]?.why).toContain("decisions.agent.start_task");
    // With the keys both are served to the manager and to a server with no role.
    for (const role of [undefined, "manager" as const]) {
      const on = resolved({
        ...(role === undefined ? {} : { role }),
        available: [...nonAction, ...acting],
      });
      expect(on.names).toContain("manager_start_task");
      expect(on.names).toContain("manager_stop_agent");
    }
    // One key serves one tool.
    const one = resolved({
      role: "manager",
      available: [...nonAction, { name: "manager_stop_agent", readOnly: false }],
    });
    expect(sorted(one.names)).toEqual(["manager_inbox", "manager_stop_agent"]);
    // They write, so `--read-only` drops them, and the worker never has them.
    const readOnly = resolved({
      role: "manager",
      readOnly: true,
      available: [...nonAction, ...acting],
    });
    expect(readOnly.names).toEqual(["manager_inbox"]);
    const worker = resolved({ role: "worker", available: [...nonAction, ...acting] });
    expect(worker.names).not.toContain("manager_start_task");
    expect(worker.names).not.toContain("manager_stop_agent");
    expect(sorted([...ROLE_TOOLS.worker].filter((n) => AGENT_ACTION_TOOLS.includes(n)))).toEqual(
      [],
    );
    // Served as a table row: a key tool is known to the config check.
    expect(KNOWN_TOOL_NAMES).toContain("manager_start_task");
  });

  test("5m9d_worker_add_is_refused", () => {
    for (const name of AGENT_ACTION_TOOLS) {
      expect(roleOverridesProblem({ worker: { add: [name] } })).toContain(
        "never given a tool that decides",
      );
      // The manager block may name them (they stay behind the key).
      expect(roleOverridesProblem({ manager: { add: [name] } })).toBeUndefined();
      // A table that hands them to the worker does not make the worker serve them.
      const roles = { ...ROLE_TOOLS, worker: [...ROLE_TOOLS.worker, name] };
      const served = resolved({
        role: "worker",
        roles,
        available: [{ name, readOnly: false }],
      });
      expect(served.names).not.toContain(name);
    }
  });

  test("mstart_key_rechecked_per_call", async () => {
    let on = true;
    let ran = 0;
    const tool: ManagerToolDescriptor = {
      name: "manager_start_task",
      title: "start",
      description: "start",
      shape: {},
      readOnly: false,
      idempotent: false,
      strict: true,
      run: async () => {
        ran += 1;
        return { started: true };
      },
    };
    const host = { agentKeys: async () => ({ start_task: on, stop_agent: false }) };
    expect((await invokeManagerTool(host, tool.name, {}, [tool])).ok).toBe(true);
    // The person turns the key off: the very next call is refused as a tool that is not there.
    on = false;
    const refused = await invokeManagerTool(host, tool.name, {}, [tool]);
    expect(refused).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    // A host that cannot say what the keys are allows nothing; so does one whose read fails.
    expect((await invokeManagerTool({}, tool.name, {}, [tool])).ok).toBe(false);
    const broken = { agentKeys: async () => Promise.reject(new Error("config unreadable")) };
    expect((await invokeManagerTool(broken, tool.name, {}, [tool])).ok).toBe(false);
    expect(ran).toBe(1);
  });

  test("mstart_doctor_and_instructions_know_keys", () => {
    const served = [...HISTORY_TOOLS, ...MANAGER_TOOLS]
      .map((t) => t.name)
      .filter((name) => !AGENT_ACTION_TOOLS.includes(name));
    const both = [...served, ...AGENT_ACTION_TOOLS];
    const text = serverInstructions({
      role: "manager",
      decisions: { startTask: true, stopAgent: true },
      served: both,
    });
    expect(text).toContain("manager_start_task starts the run of a task");
    expect(text).toContain("manager_stop_agent stops the agent");
    // `force` is for the person's word only.
    expect(text).toContain("`force: true` only when the person has told you");
    expect(text).toContain("Never use `force` to get past a refusal on your own");
    // Without the key, or without the tool, no word of it.
    for (const options of [
      { role: "manager" as const, decisions: {}, served: both },
      { role: "manager" as const, decisions: { startTask: true, stopAgent: true }, served },
    ]) {
      const quiet = serverInstructions(options);
      expect(quiet).not.toContain("manager_start_task");
      expect(quiet).not.toContain("manager_stop_agent");
      expect(quiet).not.toContain("force");
    }
    // Only the stop key: the start tool is not named.
    const stopOnly = serverInstructions({
      role: "manager",
      decisions: { stopAgent: true },
      served: both,
    });
    expect(stopOnly).toContain("manager_stop_agent");
    expect(stopOnly).not.toContain("manager_start_task");
    // A server with no role says it too, after the rules it already has.
    const noRole = serverInstructions({
      decisions: { startTask: true },
      served: [...PIPELINE_TOOL_NAMES, ...both],
    });
    expect(noRole).toContain("manager_start_task starts the run of a task");
  });
});

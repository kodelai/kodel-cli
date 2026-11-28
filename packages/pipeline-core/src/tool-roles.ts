/**
 * Which tools a server serves (decision 5M9D): by the role it was started with, then by the person's
 * `mcp.roles` block, then by `--read-only`. Pure, and without the MCP SDK: a host hands in what it can
 * serve and registers exactly the names it gets back. The roles are allow-lists, so a tool that is in
 * no role is served by no role; the lists below are the place a new tool is reviewed.
 */

export const SERVER_ROLES = ["worker", "manager"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

/** What a record says of the server behind it: a role, or `all` for a server started with none. */
export type ExecutorRole = ServerRole | "all";

export function isExecutorRole(value: unknown): value is ExecutorRole {
  return value === "worker" || value === "manager" || value === "all";
}

/** The tools a run cannot be worked without: the worker always has them. */
export const RUN_CORE: readonly string[] = [
  "pipeline_start",
  "pipeline_next_step",
  "pipeline_take_step",
  "pipeline_complete_step",
];

/**
 * The tools that decide for a person; served only under `decisions.agent`, and never to the worker.
 * `manager_cancel_run` (NE3N) is served only on a manager's server, never on one with no role.
 */
export const DECISION_TOOLS: readonly string[] = [
  "pipeline_decide_gate",
  "pipeline_accept_change",
  "manager_cancel_run",
];

/** The task tools (`mcp/task-tools.ts`); a test keeps the list equal to the registry for every adapter profile. */
export const TASK_TOOL_NAMES: readonly string[] = [
  "task_schema",
  "task_create",
  "task_list",
  "task_get",
  "task_update",
];

/** The manager's read tools (`mcp/manager-tools.ts`). */
export const MANAGER_TOOL_NAMES: readonly string[] = [
  "manager_inbox",
  "manager_run_report",
  "manager_gate_changes",
  "manager_serve_status",
  "manager_agents",
  "manager_agent_log",
  "manager_watch",
];

/**
 * The attachment tools (`mcp/tools.ts`, T-45), served only by a host that keeps attachments. Writing is
 * part of working a step; the manager reads what the person is shown at a gate and writes nothing.
 */
export const ATTACHMENT_TOOL_NAMES: readonly string[] = [
  "pipeline_attachment_write",
  "pipeline_attachment_read",
  "pipeline_attachment_list",
];

const HISTORY: readonly string[] = [
  "history_runs",
  "history_run_details",
  "history_agent_log",
  "history_stats",
];

export const ROLE_TOOLS: Readonly<Record<ServerRole, readonly string[]>> = {
  worker: [
    ...RUN_CORE,
    "pipeline_report_result",
    "pipeline_list",
    "pipeline_resolve",
    "pipeline_plan",
    "pipeline_docs",
    "pipeline_feedback",
    "pipeline_propose_change",
    ...ATTACHMENT_TOOL_NAMES,
    "task_get",
    "task_list",
    "task_schema",
    "task_create",
  ],
  manager: [
    ...HISTORY,
    ...TASK_TOOL_NAMES,
    "pipeline_list",
    "pipeline_resolve",
    "pipeline_docs",
    "pipeline_propose_change",
    "pipeline_attachment_read",
    "pipeline_attachment_list",
    ...DECISION_TOOLS,
    ...MANAGER_TOOL_NAMES,
  ],
};

/** Every tool name a server of this engine can register. */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  ...new Set([...ROLE_TOOLS.worker, ...ROLE_TOOLS.manager]),
];

export interface RoleOverride {
  add?: readonly string[];
  remove?: readonly string[];
}

/** The `mcp.roles` block of the project config. */
export type RoleOverrides = Partial<Record<ServerRole, RoleOverride>>;

/**
 * What is wrong with an `mcp.roles` block, naming the tool, or nothing. A name no role knows is a typo
 * and must not pass in silence; the worker is never given a decision tool and never loses the tools a
 * run is worked with.
 */
export function roleOverridesProblem(
  overrides: RoleOverrides,
  roles: Readonly<Record<ServerRole, readonly string[]>> = ROLE_TOOLS,
): string | undefined {
  const known = new Set([...roles.worker, ...roles.manager]);
  for (const role of SERVER_ROLES) {
    const add = overrides[role]?.add ?? [];
    const remove = overrides[role]?.remove ?? [];
    for (const name of [...add, ...remove]) {
      if (!known.has(name)) return `mcp.roles.${role} names "${name}", which is not a tool`;
    }
    for (const name of add) {
      if (remove.includes(name)) {
        return `mcp.roles.${role} has "${name}" in both add and remove`;
      }
    }
    if (role === "worker") {
      const decides = add.find((name) => DECISION_TOOLS.includes(name));
      if (decides !== undefined) {
        return `mcp.roles.worker.add names "${decides}": the worker is never given a tool that decides for the person`;
      }
      const core = remove.find((name) => RUN_CORE.includes(name));
      if (core !== undefined) {
        return `mcp.roles.worker.remove names "${core}": a run cannot be worked without it`;
      }
    }
  }
  return undefined;
}

/** A name of the config that did nothing on this server, and why. */
export interface Unapplied {
  name: string;
  why: string;
}

export type ResolvedToolSet =
  | { names: string[]; unapplied: Unapplied[]; refused?: undefined }
  | { refused: string };

const afterOverride = (base: readonly string[], override: RoleOverride | undefined): string[] => {
  const remove = new Set(override?.remove ?? []);
  return [...new Set([...base, ...(override?.add ?? [])])].filter((name) => !remove.has(name));
};

/**
 * The final set, in this order: the role (no role is the union of the roles), the config's overrides,
 * then `--read-only`, which is last so that an `add` cannot bring a write back. `available` is what the
 * host can serve at all (no task tool with tasks off, no decision tool without `decisions.agent`) with
 * each tool's read-only mark; a name outside it is never in the answer.
 */
export function resolveToolSet(input: {
  role?: ServerRole;
  overrides?: RoleOverrides;
  readOnly?: boolean;
  available: readonly { name: string; readOnly: boolean }[];
  roles?: Readonly<Record<ServerRole, readonly string[]>>;
}): ResolvedToolSet {
  const roles = input.roles ?? ROLE_TOOLS;
  const overrides = input.overrides ?? {};
  const problem = roleOverridesProblem(overrides, roles);
  if (problem !== undefined) return { refused: problem };
  if (input.role === "worker" && input.readOnly === true) {
    return {
      refused: "--role worker cannot be --read-only: a run is worked with tools that write",
    };
  }
  const unapplied: Unapplied[] = [];
  const worker = afterOverride(roles.worker, overrides.worker).filter(
    // Whatever the table handed in says, the worker decides nothing for the person.
    (name) => !DECISION_TOOLS.includes(name),
  );
  const manager = afterOverride(roles.manager, overrides.manager);
  let wanted: string[];
  if (input.role === "worker") wanted = worker;
  else if (input.role === "manager") wanted = manager;
  else {
    wanted = [...new Set([...worker, ...manager])];
    for (const role of SERVER_ROLES) {
      for (const name of overrides[role]?.remove ?? []) {
        if (wanted.includes(name)) {
          unapplied.push({
            name,
            why: `removed from the ${role} only: a server with no role serves both roles, and the other one still has it`,
          });
        }
      }
    }
  }
  const available = new Map(input.available.map((tool) => [tool.name, tool.readOnly]));
  const added = new Set(
    (input.role === undefined ? SERVER_ROLES : [input.role]).flatMap(
      (role) => overrides[role]?.add ?? [],
    ),
  );
  const names: string[] = [];
  for (const name of wanted) {
    const readOnly = available.get(name);
    if (readOnly === undefined) {
      if (added.has(name)) {
        unapplied.push({
          name,
          why: DECISION_TOOLS.includes(name)
            ? "added by mcp.roles, but this server serves a decision tool only under decisions.agent"
            : ATTACHMENT_TOOL_NAMES.includes(name)
              ? "added by mcp.roles, but this server keeps no attachments"
              : "added by mcp.roles, but this server cannot serve it (a task tool needs tasks on)",
        });
      }
      continue;
    }
    if (input.readOnly === true && !readOnly) {
      if (added.has(name)) {
        unapplied.push({
          name,
          why: "added by mcp.roles, but it writes and the server is --read-only",
        });
      }
      continue;
    }
    names.push(name);
  }
  return { names, unapplied };
}

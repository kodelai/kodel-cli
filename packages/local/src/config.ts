/**
 * The project config: `config.yaml` in the store root (by default `<root>/.kodel`). It is the
 * person's file, like the pipelines: it is not an MCP tool and the agent has no way to change it.
 * Without the file everything has its default.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_LOG_KINDS,
  AGENT_LOG_MODES,
  type AgentsConfig,
  DEFAULT_AGENTS,
  DEFAULT_TASK_ON_RUN,
  defaultAgentLog,
  defaultHistory,
  defaultToolCalls,
  defaultUsage,
  type HistoryConfig,
  isValidGlob,
  KodelError,
  MAX_SUPPORTED_MAJOR,
  MAX_TOOL_PREVIEW_CHARS,
  parseVersion,
  pricesOverrideSchema,
  type RoleOverrides,
  roleOverridesProblem,
  TASK_ON_RUN_MODES,
  type TaskOnRunMode,
} from "@kodel-ai/pipeline-core";
import type { ServeRules } from "@kodel-ai/pipeline-core/serve";
import { parse } from "yaml";
import { z } from "zod";
import { type EngineProfile, enginesSchema } from "./engines";
import { MAX_PATCH_KB } from "./patch-text";
import { CONFIG_FILE } from "./project-locate";
import {
  parseStorageLines,
  projectIdProblem,
  STORAGE_MODES,
  type StorageMode,
  StoragePathsError,
} from "./storage-paths";

export const DEFAULT_WORKTREE_DIR = ".kodel/worktrees";

export interface WorktreeConfig {
  /** `auto`: each run gets its own git worktree. `off`: runs work in the repository root. */
  mode: "auto" | "off";
  /** Where the worktrees are made: relative to the repository root, or absolute. */
  dir: string;
}

export interface PipelineConfig {
  /**
   * What a run uses when its pipeline file has changes that are not committed (it works in a worktree
   * made from the last commit, which does not have them). `ask`: the agent asks the person each time.
   * For people who work on the pipeline itself and always mean the file as it is.
   */
  uncommitted: "ask" | "working" | "committed";
}

export interface AgentHintsConfig {
  /**
   * Whether the answers that wait for a person offer the agent `kodel wait` (and the server's
   * instructions say so). Off for a project whose agent should only end its turn and be told.
   */
  wait: boolean;
}

export interface DecisionsConfig {
  /**
   * Whether a client that can show a form is asked there at a gate, a pause, a change of a run's
   * pipeline and a state changed outside kodel. Off: the agent's answer is `waiting` and the person
   * decides with a command, so they can talk to the agent first.
   */
  dialog: boolean;
  /**
   * What the agent may decide itself, on the person's instruction in the chat. There is no key for
   * `ack`: that stays with a person.
   */
  agent: {
    gate: boolean;
    pipeline_change: boolean;
    /** A manager's server may cancel a run (`manager_cancel_run`, NE3N); never a worker or a server with no role. */
    cancel_run: boolean;
  };
}

export interface TasksConfig {
  /** Off by default: the MCP server then has no task tools at all. */
  enabled: boolean;
  /** The kind of the adapter that keeps the tasks. */
  adapter: string;
  /** How long one call of the adapter may take, in seconds. */
  timeout_s: number;
  /** What the engine does to a task that a run was started for: see `TASK_ON_RUN_MODES`. */
  on_run: { mode: TaskOnRunMode };
  /**
   * The settings of each adapter, one block per kind. They are kept unchecked here: the adapter in
   * use checks its own block, and the others are ignored, so switching `adapter` does not mean
   * rewriting them. The group has its own key so a core key can never collide with an adapter name.
   */
  adapters: Record<string, unknown>;
}

export interface ProjectConfig {
  version: string;
  worktree: WorktreeConfig;
  pipeline: PipelineConfig;
  agent_hints: AgentHintsConfig;
  decisions: DecisionsConfig;
  tasks: TasksConfig;
  history: HistoryConfig;
  /** How the open steps of a fork are worked, and how long a worker's hold on one lasts. */
  agents: AgentsConfig;
  /**
   * Where runs, the proposals made outside a run, `start.lock` and the session index are kept:
   * `project` (under `.kodel`, the default) or `home` (`~/.kodel/projects/<project_id>/`).
   */
  storage: StorageMode;
  /** The stable name of the project's folder in `home` mode; it is committed, so a move keeps the history. */
  project_id?: string;
  /**
   * The programs that run steps with `engine:` (T-42), by profile name. The person's block: the agent
   * never edits it. Empty when the config has none.
   */
  engines: Record<string, EngineProfile>;
  /**
   * What `kodel serve` may do (TASK-G8KM, T-44): the person's block, off by default. Without `start`
   * rules the daemon starts nothing and only resumes and watches.
   */
  serve: ServeRules;
  /**
   * Which tools each role of `kodel mcp` serves, over the built-in lists (5M9D). The person's block:
   * the agent never edits it. A block that cannot be used stops `kodel mcp`.
   */
  mcp: { roles: RoleOverrides };
}

export { DEFAULT_AGENTS };

export const DEFAULT_SERVE: ServeRules = {
  enabled: false,
  max_workers: 1,
  max_runs: 1,
  stalled_after_s: 1800,
  start: [],
};

export const DEFAULT_WORKTREE: WorktreeConfig = { mode: "auto", dir: DEFAULT_WORKTREE_DIR };
export const DEFAULT_PIPELINE: PipelineConfig = { uncommitted: "ask" };
export const DEFAULT_AGENT_HINTS: AgentHintsConfig = { wait: true };
export const DEFAULT_DECISIONS: DecisionsConfig = {
  dialog: false,
  agent: { gate: false, pipeline_change: false, cancel_run: false },
};
export const DEFAULT_TASKS: TasksConfig = {
  enabled: false,
  adapter: "local",
  timeout_s: 30,
  on_run: { mode: DEFAULT_TASK_ON_RUN },
  adapters: {},
};

export { CONFIG_FILE };

const MAX_EXCLUDE_GLOBS = 256;

// Whole kilobytes, at least one: 0 would mean "keep nothing", which is what `enabled: false` says.
const maxKb = z.number().int().min(1);

// A cap of characters is a whole number from 0 (the kind is left out) to a bound far above any real text.
const previewChars = z.number().int().min(0).max(1_000_000);

// One number for every kind, or a number per kind; a kind that is not named keeps its default.
const agentLogSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(AGENT_LOG_MODES).optional(),
    preview_chars: z
      .union([
        previewChars,
        z
          .object(
            Object.fromEntries(AGENT_LOG_KINDS.map((kind) => [kind, previewChars.optional()])),
          )
          .strict(),
      ])
      .optional(),
    max_kb: maxKb.optional(),
    // Seconds between copies while the run goes; 0 copies only at the end of a step.
    interval_s: z.number().int().min(0).max(3_600).optional(),
  })
  .strict();

// `prices` is the shipped table's override: per model, all four prices, a safe id and a bound on how many, so what is
// frozen into the run's state is never free text.
const usageSchema = z
  .object({
    enabled: z.boolean().optional(),
    prices: pricesOverrideSchema.optional(),
  })
  .strict();

// `preview_chars` is the cut of the preview of a call's input; a preview exists only when the agent's own log is kept as
// `full` text, and `0` stores none. The bound keeps what the journal holds small.
const toolCallsSchema = z
  .object({
    enabled: z.boolean().optional(),
    preview_chars: z.number().int().min(0).max(MAX_TOOL_PREVIEW_CHARS).optional(),
  })
  .strict();

// Strict at every level like the rest: a misspelled category must not leave a switch on without the
// person noticing, and a switch is the point of this section.
const historySchema = z
  .object({
    changes: z
      .object({
        enabled: z.boolean().optional(),
        exclude: z
          .array(z.string().refine(isValidGlob, { message: "not a valid glob" }))
          .max(MAX_EXCLUDE_GLOBS)
          .optional(),
        // A patch is read whole to be redacted, and the report reads it back: it has an upper bound.
        max_kb: maxKb.max(MAX_PATCH_KB).optional(),
      })
      .strict()
      .optional(),
    output: z
      .object({ enabled: z.boolean().optional(), max_kb: maxKb.optional() })
      .strict()
      .optional(),
    prompts: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    executor: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    tool_log: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    agent_log: agentLogSchema.optional(),
    usage: usageSchema.optional(),
    tool_calls: toolCallsSchema.optional(),
  })
  .strict();

/** The keys of the `history` section; a test compares them with the categories the engine can write. */
export const HISTORY_SECTION_KEYS = Object.keys(historySchema.shape);

// Unknown keys are refused, not ignored: a misspelled `mode` must not leave the default in force
// without the person noticing.
const agentHintsSchema = z
  .object({
    wait: z.boolean().optional(),
  })
  .strict();

const names = z.array(z.string().min(1).max(64)).max(64);

// Strict at every level: a misspelled key of a rule must not widen what the daemon starts.
export const serveSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_workers: z.number().int().min(1).max(64).optional(),
    max_runs: z.number().int().min(1).max(64).optional(),
    stalled_after_s: z.number().int().min(0).max(86_400).optional(),
    start: z
      .array(
        z
          .object({
            pipeline: z.string().min(1),
            match: z
              .object({
                status: names.optional(),
                priority: names.optional(),
                parent: z.string().min(1).max(64).optional(),
                approval: z.enum(["required", "any"]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
  })
  .strict();

/** The `serve` block with its defaults. */
export function serveRulesOf(given: z.infer<typeof serveSchema> | undefined): ServeRules {
  return {
    enabled: given?.enabled ?? DEFAULT_SERVE.enabled,
    max_workers: given?.max_workers ?? DEFAULT_SERVE.max_workers,
    max_runs: given?.max_runs ?? DEFAULT_SERVE.max_runs,
    stalled_after_s: given?.stalled_after_s ?? DEFAULT_SERVE.stalled_after_s,
    start: (given?.start ?? []).map((rule) => ({
      pipeline: rule.pipeline,
      match: {
        ...(rule.match?.status === undefined ? {} : { status: rule.match.status }),
        ...(rule.match?.priority === undefined ? {} : { priority: rule.match.priority }),
        ...(rule.match?.parent === undefined ? {} : { parent: rule.match.parent }),
        // Required unless the person says otherwise: an agent's task waits for `kodel task approve`.
        approval: rule.match?.approval ?? "required",
      },
    })),
  };
}

const toolNames = z.array(z.string().min(1).max(64)).max(64);
const roleOverrideSchema = z
  .object({ add: toolNames.optional(), remove: toolNames.optional() })
  .strict();

// Strict at every level: a misspelled role or key must not leave a tool served that the person removed.
const mcpSchema = z
  .object({
    roles: z
      .object({ worker: roleOverrideSchema.optional(), manager: roleOverrideSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();

function mcpRolesOf(given: z.infer<typeof mcpSchema> | undefined): RoleOverrides {
  const roles: RoleOverrides = {};
  for (const role of ["worker", "manager"] as const) {
    const override = given?.roles?.[role];
    if (override === undefined) continue;
    roles[role] = {
      ...(override.add === undefined ? {} : { add: override.add }),
      ...(override.remove === undefined ? {} : { remove: override.remove }),
    };
  }
  return roles;
}

const configSchema = z
  .object({
    version: z.union([z.number(), z.string()]).optional(),
    worktree: z
      .object({
        mode: z.enum(["auto", "off"]).optional(),
        dir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    pipeline: z
      .object({
        uncommitted: z.enum(["ask", "working", "committed"]).optional(),
      })
      .strict()
      .optional(),
    agent_hints: agentHintsSchema.optional(),
    decisions: z
      .object({
        dialog: z.boolean().optional(),
        agent: z
          .object({
            gate: z.boolean().optional(),
            pipeline_change: z.boolean().optional(),
            cancel_run: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    tasks: z
      .object({
        enabled: z.boolean().optional(),
        adapter: z.string().min(1).optional(),
        timeout_s: z.number().int().min(1).max(300).optional(),
        on_run: z
          .object({ mode: z.enum(TASK_ON_RUN_MODES).optional() })
          .strict()
          .optional(),
        adapters: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    history: historySchema.optional(),
    agents: z
      .object({
        subagents: z.enum(["auto", "yes", "no"]).optional(),
        max_parallel: z.number().int().min(1).max(64).optional(),
        claim_ttl_s: z.number().int().min(1).max(86_400).optional(),
      })
      .strict()
      .optional(),
    storage: z.enum(STORAGE_MODES as [StorageMode, ...StorageMode[]]).optional(),
    project_id: z.string().optional(),
    engines: enginesSchema.optional(),
    serve: serveSchema.optional(),
    mcp: mcpSchema.optional(),
  })
  .strict();

const invalid = (file: string, message: string) =>
  new KodelError("CONFIG_INVALID", `${file}: ${message}`);

/**
 * Only the `agent_hints` block of the config in `storeRoot`, for a reader that keeps going on a config
 * that does not load: a bad value elsewhere must not undo a valid `wait: false`. The defaults when the
 * block itself cannot be read.
 */
export async function loadAgentHints(storeRoot: string): Promise<AgentHintsConfig> {
  try {
    const raw: unknown = parse(await readFile(join(storeRoot, CONFIG_FILE), "utf8"));
    const block =
      raw !== null && typeof raw === "object" ? Reflect.get(raw, "agent_hints") : undefined;
    const parsed = agentHintsSchema.safeParse(block ?? {});
    return { wait: (parsed.success ? parsed.data.wait : undefined) ?? DEFAULT_AGENT_HINTS.wait };
  } catch {
    return { ...DEFAULT_AGENT_HINTS };
  }
}

/**
 * Only the `mcp` block of the config in `storeRoot`: the overrides of the roles, none when there is no
 * block. Unlike the other single-block readers it throws (`CONFIG_INVALID`) when the block cannot be
 * used: a server must not serve more than the person wrote because of a typo. A problem in another
 * block is not this reader's. A file that is not YAML at all stops only when it has a top-level `mcp:`
 * line: the person narrowed the set and it cannot be read.
 */
export async function loadMcpRoles(storeRoot: string): Promise<RoleOverrides> {
  const file = join(storeRoot, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw invalid(
      file,
      `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (!/^mcp[ \t]*:/m.test(text)) return {};
    throw invalid(
      file,
      `not valid YAML, so its mcp block cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || !Reflect.has(raw, "mcp")) return {};
  const parsed = mcpSchema.safeParse(Reflect.get(raw, "mcp"));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = ["mcp", ...(first?.path ?? [])].join(".");
    const keys = first && "keys" in first ? `: ${(first.keys as string[]).join(", ")}` : "";
    throw invalid(file, `${first?.message ?? "invalid"}${keys} (at "${where}")`);
  }
  const roles = mcpRolesOf(parsed.data);
  const problem = roleOverridesProblem(roles);
  if (problem !== undefined) throw invalid(file, problem);
  return roles;
}

/** Read the config in `storeRoot`; the defaults when there is no file. */
export async function loadConfig(storeRoot: string): Promise<ProjectConfig> {
  const file = join(storeRoot, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: parseVersion(1).version,
        worktree: { ...DEFAULT_WORKTREE },
        pipeline: { ...DEFAULT_PIPELINE },
        agent_hints: { ...DEFAULT_AGENT_HINTS },
        decisions: { dialog: false, agent: { ...DEFAULT_DECISIONS.agent } },
        tasks: { ...DEFAULT_TASKS, on_run: { ...DEFAULT_TASKS.on_run }, adapters: {} },
        history: {
          ...defaultHistory(),
          agent_log: defaultAgentLog(),
          usage: defaultUsage(),
          tool_calls: defaultToolCalls(),
        },
        agents: { ...DEFAULT_AGENTS },
        storage: "project",
        engines: {},
        serve: serveRulesOf(undefined),
        mcp: { roles: {} },
      };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw invalid(
      file,
      `not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".");
    // zod names the unknown keys of a strict object in `keys`; say them, so the person sees which.
    const keys = first && "keys" in first ? `: ${(first.keys as string[]).join(", ")}` : "";
    // A key of the top level that this engine does not know may belong to a newer one: say that
    // too, so a person with an older build knows what to do (upgrade, or remove the key).
    if (first && "keys" in first && first.path.length === 0) {
      throw invalid(
        file,
        `unknown key${(first.keys as string[]).length > 1 ? "s" : ""}${keys}; is the file written for a newer kodel? upgrade kodel or remove the key`,
      );
    }
    throw invalid(file, `${first?.message ?? "invalid"}${keys}${where ? ` (at "${where}")` : ""}`);
  }
  // The hook reads these two keys with a line matcher (it cannot load this file within its budget),
  // so a spelling the matcher cannot read is refused here: the hook and the server then cannot
  // disagree about where the history goes.
  try {
    const lines = parseStorageLines(text);
    // Both ways: what the parser read is what the matcher reads, and a line the matcher reads is
    // the key the parser read (a line of the matcher's that is not the parser's key would be a
    // setting for the hook and none for the server).
    if (lines.storage !== parsed.data.storage) {
      throw new StoragePathsError(
        parsed.data.storage === undefined
          ? `storage is a line the config does not read as that key; write it as "storage: home" or "storage: project" at the top level`
          : `storage must be written as "storage: ${parsed.data.storage}" on a line of its own, not as a flow mapping, an anchor or a block`,
      );
    }
    if (parsed.data.project_id !== undefined) {
      const problem = projectIdProblem(parsed.data.project_id);
      if (problem !== undefined) throw new StoragePathsError(`project_id ${problem}`);
    }
    if (lines.project_id !== parsed.data.project_id) {
      throw new StoragePathsError(
        parsed.data.project_id === undefined
          ? `project_id is a line the config does not read as that key; write it as "project_id: my-app-k3f9a2x1" at the top level`
          : `project_id must be written as "project_id: ${parsed.data.project_id}" on a line of its own`,
      );
    }
  } catch (error) {
    if (error instanceof StoragePathsError) throw invalid(file, error.message);
    throw error;
  }
  const mcpRoles = mcpRolesOf(parsed.data.mcp);
  const mcpProblem = roleOverridesProblem(mcpRoles);
  if (mcpProblem !== undefined) throw invalid(file, mcpProblem);
  let version: { version: string; major: number };
  try {
    version = parseVersion(parsed.data.version ?? 1);
  } catch (error) {
    throw invalid(file, error instanceof Error ? error.message : String(error));
  }
  if (version.major > MAX_SUPPORTED_MAJOR) {
    throw new KodelError(
      "UNSUPPORTED_FORMAT",
      `${file}: version ${version.version} is newer than this engine supports (max major ${MAX_SUPPORTED_MAJOR}); upgrade kodel`,
    );
  }
  return {
    version: version.version,
    worktree: {
      mode: parsed.data.worktree?.mode ?? DEFAULT_WORKTREE.mode,
      dir: parsed.data.worktree?.dir ?? DEFAULT_WORKTREE.dir,
    },
    pipeline: { uncommitted: parsed.data.pipeline?.uncommitted ?? DEFAULT_PIPELINE.uncommitted },
    agent_hints: { wait: parsed.data.agent_hints?.wait ?? DEFAULT_AGENT_HINTS.wait },
    decisions: {
      dialog: parsed.data.decisions?.dialog ?? DEFAULT_DECISIONS.dialog,
      agent: {
        gate: parsed.data.decisions?.agent?.gate ?? DEFAULT_DECISIONS.agent.gate,
        pipeline_change:
          parsed.data.decisions?.agent?.pipeline_change ?? DEFAULT_DECISIONS.agent.pipeline_change,
        cancel_run: parsed.data.decisions?.agent?.cancel_run ?? DEFAULT_DECISIONS.agent.cancel_run,
      },
    },
    tasks: {
      enabled: parsed.data.tasks?.enabled ?? DEFAULT_TASKS.enabled,
      adapter: parsed.data.tasks?.adapter ?? DEFAULT_TASKS.adapter,
      timeout_s: parsed.data.tasks?.timeout_s ?? DEFAULT_TASKS.timeout_s,
      on_run: { mode: parsed.data.tasks?.on_run?.mode ?? DEFAULT_TASKS.on_run.mode },
      adapters: parsed.data.tasks?.adapters ?? {},
    },
    history: mergeHistory(parsed.data.history),
    agents: {
      subagents: parsed.data.agents?.subagents ?? DEFAULT_AGENTS.subagents,
      max_parallel: parsed.data.agents?.max_parallel ?? DEFAULT_AGENTS.max_parallel,
      claim_ttl_s: parsed.data.agents?.claim_ttl_s ?? DEFAULT_AGENTS.claim_ttl_s,
    },
    storage: parsed.data.storage ?? "project",
    ...(parsed.data.project_id === undefined ? {} : { project_id: parsed.data.project_id }),
    engines: parsed.data.engines ?? {},
    serve: serveRulesOf(parsed.data.serve),
    mcp: { roles: mcpRoles },
  };
}

function mergeHistory(given: z.infer<typeof historySchema> | undefined): HistoryConfig {
  const d = defaultHistory();
  return {
    changes: {
      enabled: given?.changes?.enabled ?? d.changes.enabled,
      exclude: given?.changes?.exclude ?? d.changes.exclude,
      max_kb: given?.changes?.max_kb ?? d.changes.max_kb,
    },
    output: {
      enabled: given?.output?.enabled ?? d.output.enabled,
      max_kb: given?.output?.max_kb ?? d.output.max_kb,
    },
    prompts: { enabled: given?.prompts?.enabled ?? d.prompts.enabled },
    executor: { enabled: given?.executor?.enabled ?? d.executor.enabled },
    tool_log: { enabled: given?.tool_log?.enabled ?? d.tool_log.enabled },
    agent_log: mergeAgentLog(given?.agent_log),
    usage: {
      enabled: given?.usage?.enabled ?? defaultUsage().enabled,
      prices: given?.usage?.prices ?? {},
    },
    tool_calls: {
      enabled: given?.tool_calls?.enabled ?? defaultToolCalls().enabled,
      preview_chars: given?.tool_calls?.preview_chars ?? defaultToolCalls().preview_chars,
    },
  };
}

function mergeAgentLog(given: z.infer<typeof agentLogSchema> | undefined) {
  const d = defaultAgentLog();
  const chars = given?.preview_chars;
  return {
    enabled: given?.enabled ?? d.enabled,
    mode: given?.mode ?? d.mode,
    preview_chars:
      typeof chars === "number"
        ? { user: chars, agent: chars, tool_input: chars, tool_result: chars }
        : {
            user: chars?.user ?? d.preview_chars.user,
            agent: chars?.agent ?? d.preview_chars.agent,
            tool_input: chars?.tool_input ?? d.preview_chars.tool_input,
            tool_result: chars?.tool_result ?? d.preview_chars.tool_result,
          },
    max_kb: given?.max_kb ?? d.max_kb,
    interval_s: given?.interval_s ?? d.interval_s,
  };
}

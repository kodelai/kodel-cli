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
  DEFAULT_TASK_ON_RUN,
  defaultAgentLog,
  defaultHistory,
  type HistoryConfig,
  isValidGlob,
  KodelError,
  MAX_SUPPORTED_MAJOR,
  parseVersion,
  TASK_ON_RUN_MODES,
  type TaskOnRunMode,
} from "@kodel-ai/pipeline-core";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_PATCH_KB } from "./patch-text";
import { CONFIG_FILE } from "./project-locate";

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
}

export const DEFAULT_WORKTREE: WorktreeConfig = { mode: "auto", dir: DEFAULT_WORKTREE_DIR };
export const DEFAULT_PIPELINE: PipelineConfig = { uncommitted: "ask" };
export const DEFAULT_AGENT_HINTS: AgentHintsConfig = { wait: true };
export const DEFAULT_DECISIONS: DecisionsConfig = {
  dialog: false,
  agent: { gate: false, pipeline_change: false },
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
  })
  .strict();

/** The keys of the `history` section; a test compares them with the categories the engine can write. */
export const HISTORY_SECTION_KEYS = Object.keys(historySchema.shape);

// Unknown keys are refused, not ignored: a misspelled `mode` must not leave the default in force
// without the person noticing.
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
    agent_hints: z
      .object({
        wait: z.boolean().optional(),
      })
      .strict()
      .optional(),
    decisions: z
      .object({
        dialog: z.boolean().optional(),
        agent: z
          .object({
            gate: z.boolean().optional(),
            pipeline_change: z.boolean().optional(),
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
  })
  .strict();

const invalid = (file: string, message: string) =>
  new KodelError("CONFIG_INVALID", `${file}: ${message}`);

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
        history: { ...defaultHistory(), agent_log: defaultAgentLog() },
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

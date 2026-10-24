/**
 * The project config: `config.yaml` in the store root (by default `<root>/.kodel`). It is the
 * person's file, like the pipelines: it is not an MCP tool and the agent has no way to change it.
 * Without the file everything has its default.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KodelError, MAX_SUPPORTED_MAJOR, parseVersion } from "@kodel-ai/pipeline-core";
import { parse } from "yaml";
import { z } from "zod";

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

export interface TasksConfig {
  /** Off by default: the MCP server then has no task tools at all. */
  enabled: boolean;
  /** The kind of the adapter that keeps the tasks. */
  adapter: string;
  /** How long one call of the adapter may take, in seconds. */
  timeout_s: number;
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
  tasks: TasksConfig;
}

export const DEFAULT_WORKTREE: WorktreeConfig = { mode: "auto", dir: DEFAULT_WORKTREE_DIR };
export const DEFAULT_PIPELINE: PipelineConfig = { uncommitted: "ask" };
export const DEFAULT_AGENT_HINTS: AgentHintsConfig = { wait: true };
export const DEFAULT_TASKS: TasksConfig = {
  enabled: false,
  adapter: "local",
  timeout_s: 30,
  adapters: {},
};

export const CONFIG_FILE = "config.yaml";

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
    tasks: z
      .object({
        enabled: z.boolean().optional(),
        adapter: z.string().min(1).optional(),
        timeout_s: z.number().int().min(1).max(300).optional(),
        adapters: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
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
        tasks: { ...DEFAULT_TASKS, adapters: {} },
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
    tasks: {
      enabled: parsed.data.tasks?.enabled ?? DEFAULT_TASKS.enabled,
      adapter: parsed.data.tasks?.adapter ?? DEFAULT_TASKS.adapter,
      timeout_s: parsed.data.tasks?.timeout_s ?? DEFAULT_TASKS.timeout_s,
      adapters: parsed.data.tasks?.adapters ?? {},
    },
  };
}

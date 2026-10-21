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

export interface ProjectConfig {
  version: string;
  worktree: WorktreeConfig;
}

export const DEFAULT_WORKTREE: WorktreeConfig = { mode: "auto", dir: DEFAULT_WORKTREE_DIR };

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
      return { version: parseVersion(1).version, worktree: { ...DEFAULT_WORKTREE } };
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
  };
}

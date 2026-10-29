/**
 * Finding the place a project keeps its history, from its config: `project` (the default) or
 * `home`. The hook has its own, smaller way (`storage-paths.ts`); this one loads the config.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { CONFIG_FILE, loadConfig } from "./config";
import { canonicalRoot } from "./project-locate";
import {
  generateProjectId,
  homePlace,
  linesToAdd,
  projectPlace,
  readStorageSettings,
  resolveBase,
  StoragePathsError,
  type StoragePlace,
  type StorageSettings,
} from "./storage-paths";

export interface ResolveStorageInput {
  /** The project root (the folder with `.kodel`). */
  root: string;
  /**
   * Called when the strict loader refused the config and the place was read with the line matcher
   * instead, so that a command that does not load the config otherwise can say so.
   */
  onConfigProblem?: (message: string) => void;
  /** The project's data folder, `<root>/.kodel`. */
  dataDir: string;
  env?: Record<string, string | undefined>;
  /** Replaces the user's home folder (tests). */
  home?: string;
}

/**
 * The settings of the config. The strict loader is the authority; when it refuses the file (or the
 * file cannot be read) the line matcher is asked, because the commands that only read a run still
 * have to find the history. `pipeline_start` loads the config itself and refuses a file it cannot
 * load, so a broken config never starts a run in a place nobody chose.
 */
async function settingsOf(
  dataDir: string,
  onConfigProblem?: (message: string) => void,
): Promise<StorageSettings> {
  try {
    const config = await loadConfig(dataDir);
    return {
      storage: config.storage,
      ...(config.project_id === undefined ? {} : { projectId: config.project_id }),
    };
  } catch (error) {
    const text = await readFile(join(dataDir, CONFIG_FILE), "utf8").catch(() => undefined);
    if (text === undefined) throw error;
    let settings: StorageSettings;
    try {
      settings = readStorageSettings(text);
    } catch {
      throw error;
    }
    // The place is read from what the matcher could make out; the person is told the config was refused.
    onConfigProblem?.(error instanceof Error ? error.message : String(error));
    return settings;
  }
}

/** The place the config names. Throws `CONFIG_INVALID` for a `home` project that cannot be placed. */
export async function resolveStoragePlace(input: ResolveStorageInput): Promise<StoragePlace> {
  const settings = await settingsOf(input.dataDir, input.onConfigProblem);
  if (settings.storage === "project") return projectPlace(input.dataDir);
  if (settings.projectId === undefined) {
    throw new KodelError(
      "CONFIG_INVALID",
      `storage is "home" but the config has no project_id. Add these two lines to .kodel/${CONFIG_FILE}:\n${linesToAdd(generateProjectId(basename(input.root)))}`,
    );
  }
  try {
    return homePlace({
      // One spelling per checkout: a root given with a symlink in it, or a linked worktree of the
      // project, is the same checkout as the main one, so its runs are not foreign to it.
      root: await canonicalRoot(input.root),
      projectId: settings.projectId,
      base: resolveBase(input.env ?? process.env, input.home),
    });
  } catch (error) {
    if (error instanceof StoragePathsError) throw new KodelError("CONFIG_INVALID", error.message);
    throw error;
  }
}

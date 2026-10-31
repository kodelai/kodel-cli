/**
 * Where a project keeps what it writes: `project` (under `<root>/.kodel`, the default) or `home`
 * (`~/.kodel/projects/<project_id>/`). This file is small on purpose (node only): the hook binary is
 * bundled from it, and the hook has a size and a time budget, so it reads the two keys with a line
 * matcher instead of loading the config.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type StorageMode = "project" | "home";

export const STORAGE_MODES: readonly StorageMode[] = ["project", "home"];

/** What is wrong with the storage settings; the hosts turn it into a `CONFIG_INVALID` error. */
export class StoragePathsError extends Error {}

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
// Names Windows will not take as a file name, also with an extension (`con.txt`).
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;

/** What is wrong with a `project_id` (it is a folder name on three systems), or undefined. */
export function projectIdProblem(id: string): string | undefined {
  if (!PROJECT_ID.test(id)) {
    return "must be 3 to 64 characters of a-z, 0-9, dot, underscore and dash, starting with a letter or a digit";
  }
  if (id.includes("..")) return "must not contain two dots in a row";
  if (id.endsWith(".")) return "must not end with a dot";
  if (DEVICE_NAME.test(id)) return "is a name that Windows keeps for a device";
  return undefined;
}

/**
 * A new id from a folder name: lowercased, then cut to `[a-z0-9._-]`, leading non-alphanumerics
 * dropped, at most 24 characters, `p` if nothing is left; then a dash and 8 random characters.
 */
export function generateProjectId(
  folderName: string,
  random: (size: number) => Buffer = randomBytes,
): string {
  const cleaned = folderName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 24)
    .replace(/\.+$/, "");
  const prefix = cleaned === "" ? "p" : cleaned;
  const suffix = Array.from(random(8), (byte) => (byte % 36).toString(36)).join("");
  let id = `${prefix}-${suffix}`;
  // A device name (`con`) gets the fallback prefix; the random part makes the rest unique.
  if (projectIdProblem(id) !== undefined) id = `p-${prefix.replace(/[^a-z0-9]/g, "")}${suffix}`;
  return id;
}

export interface StorageLines {
  /** The raw value of a top-level `storage:` line, undefined when there is none. */
  storage?: string;
  /** The raw value of a top-level `project_id:` line, undefined when there is none. */
  project_id?: string;
}

/**
 * Reads the two keys as top-level scalar lines (`storage: home`, optional quotes, a trailing
 * comment). A line it cannot read as a scalar (a flow mapping, an anchor, a block scalar) gives the
 * value `\0`, which no setting accepts. A key twice is an error.
 */
export function parseStorageLines(text: string): StorageLines {
  const found: StorageLines = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const match = /^(storage|project_id):[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] as "storage" | "project_id";
    if (found[key] !== undefined) {
      throw new StoragePathsError(`${key} is set twice in the config`);
    }
    found[key] = scalar(match[2] ?? "");
  }
  return found;
}

function scalar(rest: string): string {
  const value = rest.replace(/[ \t]+#.*$/, "").trim();
  const quoted = /^"([^"\\]*)"$|^'([^']*)'$/.exec(value);
  if (quoted !== null) return quoted[1] ?? quoted[2] ?? "";
  // Not a plain scalar: a mapping, a list, an anchor, a tag, a block scalar, an alias, empty.
  if (value === "" || /^[{[&*!|>%@`]/.test(value) || value.startsWith("#")) return "\0";
  return value;
}

export interface StorageSettings {
  storage: StorageMode;
  projectId?: string;
}

/** The settings from the lines, validated. Nothing set means `project`. */
export function settingsFromLines(lines: StorageLines): StorageSettings {
  let storage: StorageMode = "project";
  if (lines.storage !== undefined) {
    if (lines.storage !== "project" && lines.storage !== "home") {
      throw new StoragePathsError(
        `storage must be "project" or "home" on a line of its own (storage: home), got ${JSON.stringify(lines.storage === "\0" ? "something else" : lines.storage)}`,
      );
    }
    storage = lines.storage;
  }
  if (lines.project_id === undefined) return { storage };
  const problem = projectIdProblem(lines.project_id);
  if (problem !== undefined) {
    throw new StoragePathsError(
      `project_id ${problem} (write it as project_id: my-app-k3f9a2x1 on a line of its own)`,
    );
  }
  return { storage, projectId: lines.project_id };
}

/** The settings from the text of a config, read by the line matcher (the hook, an unreadable config). */
export const readStorageSettings = (text: string): StorageSettings =>
  settingsFromLines(parseStorageLines(text));

/** The two lines a person adds to the config to turn `home` on. */
export const linesToAdd = (projectId: string): string => `storage: home\nproject_id: ${projectId}`;

/**
 * The base the history goes under: `$KODEL_STATE_DIR`, else `~/.kodel`. The home folder is looked
 * up only when it is needed.
 */
export function resolveBase(
  env: Record<string, string | undefined> = process.env,
  home?: string,
): string {
  const given = env.KODEL_STATE_DIR;
  if (given !== undefined && given !== "") {
    if (!isAbsolute(given)) {
      throw new StoragePathsError(
        `KODEL_STATE_DIR must be an absolute path (got "${given}"); the history cannot be placed from a relative one`,
      );
    }
    return resolve(given);
  }
  let folder = home;
  if (folder === undefined) {
    try {
      folder = homedir();
    } catch {
      folder = "";
    }
  }
  if (folder === "") {
    throw new StoragePathsError("cannot find the home directory; set KODEL_STATE_DIR");
  }
  return join(folder, ".kodel");
}

/** A short key of a checkout (the real path of the project root), for what must not be shared between clones. */
export const checkoutKey = (root: string): string => {
  const spelled = resolve(root);
  // Where the file system folds case, two spellings of one checkout are one.
  const folded =
    process.platform === "win32" || process.platform === "darwin" ? spelled.toLowerCase() : spelled;
  return createHash("sha256").update(folded).digest("hex").slice(0, 12);
};

/** The key of the integrity hashes of a project in `home` mode: the id, not the path, so a move keeps them. */
export const homeHashKey = (projectId: string): string =>
  createHash("sha256").update(`project\0${projectId}`).digest("hex").slice(0, 16);

/** Where each kind of data is kept, and how to prepare the place. */
export interface StoragePlace {
  mode: StorageMode;
  /** `home` only: the project's id and the base above its tree. */
  projectId?: string;
  base?: string;
  /** `home` only: `<base>/projects/<project_id>`. */
  tree?: string;
  /** The folder that holds one folder per run. */
  runsRoot: string;
  /** The folder of the proposals made outside a run. */
  proposalsRoot: string;
  /** The folder that holds `start.lock`. */
  lockRoot: string;
  /** The file of started agent sessions. */
  sessionsPath: string;
  /** `home` only: the key of the integrity hashes. */
  hashKey?: string;
  /** `home` only: the project root that made a run, for telling a clone's runs from ours. */
  checkoutRoot?: string;
}

/** The place of a project that keeps everything under its own `.kodel`. */
export function projectPlace(dataDir: string): StoragePlace {
  return {
    mode: "project",
    runsRoot: join(dataDir, "runs"),
    proposalsRoot: join(dataDir, "proposals"),
    lockRoot: dataDir,
    sessionsPath: join(dataDir, "sessions.jsonl"),
  };
}

/** The place of a project in `home` mode (no file system access). */
export function homePlace(input: { root: string; projectId: string; base: string }): StoragePlace {
  const tree = join(input.base, "projects", input.projectId);
  return {
    mode: "home",
    projectId: input.projectId,
    base: input.base,
    tree,
    runsRoot: join(tree, "runs"),
    proposalsRoot: join(tree, "proposals", checkoutKey(input.root)),
    lockRoot: tree,
    sessionsPath: join(tree, "sessions.jsonl"),
    hashKey: homeHashKey(input.projectId),
    checkoutRoot: input.root,
  };
}

/**
 * The place of a project root, read from its config with the line matcher (no yaml, no zod: the hook
 * uses this). No config means `project`. Throws `StoragePathsError` for a config that names a place
 * that cannot be used. The root is taken as it is given: the place it returns is right for the
 * files that do not depend on which checkout it is (the session index, the runs); the folder of the
 * proposals depends on the checkout, and the host brings the root to its real path first
 * (`resolveStoragePlace`), so a caller that needs that folder asks the host, not this.
 */
export async function placeOfRoot(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Promise<StoragePlace> {
  const dataDir = join(root, ".kodel");
  let text: string;
  try {
    text = await readFile(join(dataDir, "config.yaml"), "utf8");
  } catch (error) {
    // No config is the project place; a config that is there and cannot be read is not (the loader
    // refuses it too), so the hook writes nothing rather than into the repository by guess.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return projectPlace(dataDir);
    throw new StoragePathsError(
      `the config cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}), so the place of the history is not known`,
    );
  }
  const settings = readStorageSettings(text);
  if (settings.storage === "project") return projectPlace(dataDir);
  if (settings.projectId === undefined) {
    throw new StoragePathsError("storage is home but the config has no project_id");
  }
  return homePlace({ root, projectId: settings.projectId, base: resolveBase(env) });
}

/** Whether two places are the same one (the server compares the place it started with). */
export const samePlace = (a: StoragePlace, b: StoragePlace): boolean =>
  a.mode === b.mode && a.runsRoot === b.runsRoot && a.projectId === b.projectId;

/**
 * Text that is shown to an agent or kept in the journal, without the home base (the folder and the
 * user's name in it): the raw spelling and the real path of it are both replaced by `<home>`.
 */
export function scrubHome(text: string, place: StoragePlace | undefined): string {
  if (place?.base === undefined) return text;
  const forms = new Set([place.base]);
  try {
    forms.add(realpathSync(place.base));
  } catch {
    // The base may not exist yet; its raw spelling is still replaced.
  }
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join("<home>");
  }
  return out;
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Makes the folders of a `home` place, with mode 0700 (`~/.kodel` only if it is missing: it is
 * shared with another product and is not chmodded when it exists). Any folder of the tree that is a
 * link leaving the base is refused. A `project` place is the project's own and needs nothing.
 * `tree` makes only the project's own folder (the hook writes one file there); the default makes
 * the folders of the runs and of the proposals as well.
 */
export async function ensurePlace(
  place: StoragePlace,
  scope: "tree" | "all" = "all",
): Promise<void> {
  if (place.mode !== "home" || place.base === undefined || place.tree === undefined) return;
  await mkdir(place.base, { recursive: true, mode: 0o700 });
  const realBase = await realpath(place.base);
  const folders =
    scope === "tree"
      ? [join(place.base, "projects"), place.tree]
      : [
          join(place.base, "projects"),
          place.tree,
          place.runsRoot,
          dirname(place.proposalsRoot),
          place.proposalsRoot,
        ];
  for (const folder of folders) {
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink() && !isInside(realBase, await realpath(folder))) {
      throw new StoragePathsError(
        `${folder} is a link that leaves ${realBase}; the history is not placed through it`,
      );
    }
  }
  const made = scope === "tree" ? [place.tree] : [place.runsRoot, place.proposalsRoot];
  for (const folder of made) await mkdir(folder, { recursive: true, mode: 0o700 });
}

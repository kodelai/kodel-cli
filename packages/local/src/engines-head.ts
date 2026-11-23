/**
 * The `engines:` block as committed (T-47). A worker's shell can write `.kodel/config.yaml`, and that
 * block names the program of the next unattended start, so a start by the daemon or the TUI uses the
 * block only when the working copy's equals the one in `HEAD` of the checkout. Only this block is
 * compared (an edit of `serve` beside it changes nothing), parsed, so a comment or the order of keys is
 * no difference. A commit on the checkout's own branch does change it: that is the stated limit.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { CONFIG_FILE, loadConfig } from "./config";
import { type EngineProfile, enginesSchema } from "./engines";
import { SAFE_CONFIG } from "./git";

/** What `HEAD` of the checkout holds at the config's path. */
export type HeadConfig =
  /** The file as committed. */
  | { kind: "held"; text: string }
  /** `HEAD` does not hold the file (or there is no commit yet) and git tracks it: it is staged, not committed. */
  | { kind: "not_committed" }
  /** `HEAD` does not hold it and git does not track it, or the project is in no repository. */
  | { kind: "untracked" }
  /** git itself failed; `reason` is in its own words. */
  | { kind: "failed"; reason: string };

/** Reads what `HEAD` of the checkout at `root` holds for `file` (absolute, under `root`). */
export type HeadConfigReader = (root: string, file: string) => Promise<HeadConfig>;

/** One git call: its exit code and what it wrote. Rejects only when git cannot be run at all. */
export type GitExec = (
  args: readonly string[],
  cwd: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const HEAD_READ_TIMEOUT_MS = 10_000;

const execGit: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: HEAD_READ_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (error.killed) resolve({ code: null, stdout, stderr });
        else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
        else reject(error);
      },
    );
  });

/** Whether `dir` or a folder above it is the top of a repository (a `.git` folder, or a worktree's file). */
function inRepository(dir: string, exists: (path: string) => boolean): boolean {
  let at = dir;
  for (;;) {
    if (exists(join(at, ".git"))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/**
 * The real reader. Every question is one whose answer is in git's output, not in its exit code, so that
 * a failure (git not found, `safe.directory`, a locked index) is never read as "not there"; the one
 * exception is a repository with no commit, which `rev-parse --verify --quiet` answers with code 1 and
 * no words. The path is given relative to the root, so git finds it from the top of the repository.
 */
export function gitHeadConfigReader(
  exec: GitExec = execGit,
  exists: (path: string) => boolean = existsSync,
): HeadConfigReader {
  return async (root, file) => {
    if (!inRepository(root, exists)) return { kind: "untracked" };
    const path = relative(root, file).split(sep).join("/");
    const run = async (args: readonly string[]) => {
      try {
        return await exec(args, root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const said = error instanceof Error ? error.message : String(error);
        return {
          code: -1,
          stdout: "",
          stderr: code === "ENOENT" ? `git was not found (${said})` : said,
        };
      }
    };
    const failed = (what: string, result: { code: number | null; stderr: string }): HeadConfig => ({
      kind: "failed",
      reason:
        result.code === null
          ? `git ${what} did not answer in ${HEAD_READ_TIMEOUT_MS / 1000} s`
          : `git ${what} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
    });
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const unborn = head.code === 1 && head.stderr.trim() === "";
    if (head.code !== 0 && !unborn) return failed("rev-parse", head);
    if (!unborn) {
      const listed = await run(["ls-tree", "HEAD", "--", path]);
      if (listed.code !== 0) return failed("ls-tree", listed);
      if (listed.stdout.trim() !== "") {
        const shown = await run(["show", `HEAD:./${path}`]);
        return shown.code === 0 ? { kind: "held", text: shown.stdout } : failed("show", shown);
      }
    }
    const tracked = await run(["ls-files", "--", path]);
    if (tracked.code !== 0) return failed("ls-files", tracked);
    return tracked.stdout.trim() === "" ? { kind: "untracked" } : { kind: "not_committed" };
  };
}

/** The `engines` block of a config text, by the schema; throws when the text or the block cannot be read. */
export function enginesOfText(text: string): Record<string, EngineProfile> {
  const raw: unknown = parse(text);
  const block = raw !== null && typeof raw === "object" ? Reflect.get(raw, "engines") : undefined;
  return enginesSchema.parse(block ?? {});
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;

const sameBlock = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The working copy's `engines` block, and how it stands to the committed one. */
export type EnginesAgainstHead = { engines: Record<string, EngineProfile> } & (
  | { state: "committed" }
  /** There is no committed version to hold it to. */
  | { state: "untracked" }
  /** `head`: the committed block; absent when the committed file cannot be read. */
  | { state: "differs"; head?: Record<string, EngineProfile> }
  | { state: "failed"; reason: string }
);

export interface EnginesAgainstHeadInput {
  /** The checkout: the project root, never a run's worktree. */
  root: string;
  /** Where the config is (`<root>/.kodel`). */
  storeRoot: string;
  read?: HeadConfigReader;
}

/**
 * Reads the working copy's `engines` block and compares it with `HEAD`, which is read once. Throws what
 * `loadConfig` throws when the working copy's config does not load.
 */
export async function enginesAgainstHead(
  input: EnginesAgainstHeadInput,
): Promise<EnginesAgainstHead> {
  const engines = (await loadConfig(input.storeRoot)).engines;
  const read = input.read ?? gitHeadConfigReader();
  let head: HeadConfig;
  try {
    head = await read(input.root, join(input.storeRoot, CONFIG_FILE));
  } catch (error) {
    head = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (head.kind === "failed") return { state: "failed", engines, reason: head.reason };
  if (head.kind === "untracked") return { state: "untracked", engines };
  let committed: Record<string, EngineProfile> | undefined = {};
  if (head.kind === "held") {
    try {
      committed = enginesOfText(head.text);
    } catch {
      committed = undefined;
    }
  }
  if (committed !== undefined && sameBlock(engines, committed)) {
    return { state: "committed", engines };
  }
  return { state: "differs", engines, ...(committed === undefined ? {} : { head: committed }) };
}

const CONFIG_NAME = `.kodel/${CONFIG_FILE}`;

/** What a start by the daemon or the TUI is told when the block is not the committed one. */
export const ENGINES_ONLY_AS_COMMITTED = `engines is used only as committed: commit ${CONFIG_NAME} or put the block back as it was`;

/** What it is told for a `terminal.command` in a config that has no committed version. */
export const COMMIT_TO_USE_TERMINAL_COMMAND = `commit ${CONFIG_NAME} to use terminal.command`;

export type UnattendedEngines =
  | { ok: true; engines: Record<string, EngineProfile>; note?: string }
  | { ok: false; reason: string };

/**
 * The block for a start nobody watches (the daemon, the TUI's `s`): only as committed. With no committed
 * version `worker:` is honoured and `note` says so once, and a `terminal.command` is refused: a worker's
 * shell can write that file, and it must not choose the program of the next start. git failing refuses,
 * with git's reason.
 */
export function unattendedEngines(found: EnginesAgainstHead): UnattendedEngines {
  if (found.state === "committed") return { ok: true, engines: found.engines };
  if (found.state === "differs") return { ok: false, reason: ENGINES_ONLY_AS_COMMITTED };
  if (found.state === "failed") {
    return {
      ok: false,
      reason: `engines is used only as committed, and the committed ${CONFIG_NAME} cannot be read: ${found.reason}`,
    };
  }
  const profiles = Object.entries(found.engines);
  const withCommand = profiles.find(([, p]) => p.terminal?.command !== undefined)?.[0];
  if (withCommand !== undefined) {
    return {
      ok: false,
      reason: `engines.${withCommand}.terminal.command is used only as committed, and git does not track ${CONFIG_NAME}: ${COMMIT_TO_USE_TERMINAL_COMMAND}`,
    };
  }
  const withWorker = profiles.find(([, p]) => p.worker !== undefined);
  return {
    ok: true,
    engines: found.engines,
    ...(withWorker === undefined
      ? {}
      : {
          note: `engines.${withWorker[0]}.worker: ${withWorker[1].worker} is taken from a ${CONFIG_NAME} that git does not track (there is no committed version to hold it to)`,
        }),
  };
}

/** The keys of a profile whose values are shown to the person; `env` may hold a secret and is only named. */
const SHOWN_KEYS = ["command", "worker", "terminal", "model_flag", "pass_env", "timeout"];

function profileLines(
  now: Record<string, EngineProfile>,
  head: Record<string, EngineProfile> | undefined,
): string[] {
  const lines: string[] = [];
  const value = (profile: EngineProfile | undefined, key: string) =>
    profile === undefined ? undefined : Reflect.get(profile, key);
  const show = (key: string, v: unknown) =>
    v === undefined ? "absent" : SHOWN_KEYS.includes(key) ? JSON.stringify(canonical(v)) : "set";
  for (const name of [...new Set([...Object.keys(head ?? {}), ...Object.keys(now)])].sort()) {
    const a = head !== undefined && Object.hasOwn(head, name) ? head[name] : undefined;
    const b = Object.hasOwn(now, name) ? now[name] : undefined;
    for (const key of [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort()) {
      const [was, is] = [value(a, key), value(b, key)];
      if (head !== undefined && sameBlock(was, is)) continue;
      lines.push(
        head === undefined
          ? `  engines.${name}.${key}: ${show(key, is)}`
          : `  engines.${name}.${key}: committed ${show(key, was)}, now ${SHOWN_KEYS.includes(key) || is === undefined ? show(key, is) : "changed"}`,
      );
    }
  }
  return lines;
}

/**
 * What a person is shown before they are asked (`kodel agent start`): nothing when the block is the
 * committed one, else what differs or why it cannot be told. A value of `env` is never printed.
 */
export function enginesQuestion(found: EnginesAgainstHead): string[] {
  if (found.state === "committed") return [];
  if (found.state === "differs") {
    return found.head === undefined
      ? [
          `the engines block of the committed ${CONFIG_NAME} cannot be read; the one in use now:`,
          ...profileLines(found.engines, undefined),
        ]
      : [
          `the engines block of ${CONFIG_NAME} is not the committed one:`,
          ...profileLines(found.engines, found.head),
        ];
  }
  if (found.state === "failed") {
    return [
      `the committed ${CONFIG_NAME} cannot be read: ${found.reason}`,
      ...profileLines(found.engines, undefined),
    ];
  }
  return Object.keys(found.engines).length === 0
    ? []
    : [
        `git does not track ${CONFIG_NAME}, so its engines block has no committed version:`,
        ...profileLines(found.engines, undefined),
      ];
}

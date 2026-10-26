/**
 * The patch of the work between two trees, computed in a private git dir.
 *
 * A plain `git diff` between two trees still reads the `.gitattributes` and the config of the
 * repository, which the agent can write: one line makes every file "binary" and the patch empty, and
 * other keys make git run a program. So nothing here asks the repository to do the diff.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { minimatch } from "minimatch";
import { checkTreeId, type Deadline, DeadlineError, git } from "./git";

/**
 * The text of `git diff` from the tree `from` to the tree `to`, paths relative to the project
 * folder. Computed in a private git dir (see `withIsolatedGit`), so nothing the agent wrote into the
 * repository's config, attributes or hooks takes part. Paths that match `exclude` are left out by
 * building both trees without them. `maxBytes` bounds what is read: past it git is stopped and
 * `cut` says so.
 */
export async function patchBetween(
  root: string,
  from: string,
  to: string,
  options: PatchOptions,
): Promise<PatchOutput> {
  checkTreeId(from, "the start tree");
  checkTreeId(to, "the end tree");
  let timeoutMs: number | undefined;
  if (options.deadline !== undefined) {
    timeoutMs = options.deadline.remainingMs();
    if (timeoutMs <= 0) throw new DeadlineError();
  }
  // Not `repoPrefix`: that one answers "" on any failure, and a wrong prefix is a wrong patch.
  const { stdout: prefixOut } = await git(
    ["rev-parse", "--show-prefix"],
    root,
    { GIT_OPTIONAL_LOCKS: "0" },
    undefined,
    timeoutMs,
  );
  const prefix = prefixOut.trim().replace(/\/+$/, "");
  const exclude = options.exclude ?? [];
  return withIsolatedGit(root, options.deadline, async (iso) => {
    let a = from;
    let b = to;
    if (exclude.length > 0) {
      const listed = await iso.run([
        "diff-tree",
        "-r",
        "-z",
        "--name-only",
        "--no-renames",
        "--end-of-options",
        from,
        to,
      ]);
      const drop = new Set(
        listed.stdout
          .toString("utf8")
          .split("\0")
          .filter(Boolean)
          .filter((path) => {
            // Outside the project folder the diff leaves it out anyway (`--relative`).
            if (prefix !== "" && !path.startsWith(`${prefix}/`)) return false;
            const inside = prefix === "" ? path : path.slice(prefix.length + 1);
            return exclude.some((glob) => minimatch(inside, glob, { dot: true }));
          }),
      );
      if (drop.size > 0) {
        a = await iso.withoutPaths(from, drop, "a");
        b = await iso.withoutPaths(to, drop, "b");
      }
    }
    const out = await iso.run(
      [
        "-c",
        "core.quotePath=true",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...(prefix === "" ? [] : [`--relative=${prefix}/`]),
        "--end-of-options",
        a,
        b,
      ],
      { maxBytes: options.maxBytes },
    );
    return { patch: out.stdout, cut: out.cut };
  });
}

export interface PatchOptions {
  /** Globs (project-relative, `dot: true`) of paths that get no patch. */
  exclude?: string[];
  /** Read at most this many bytes of the diff. */
  maxBytes: number;
  deadline?: Deadline;
}

export interface PatchOutput {
  patch: Buffer;
  /** The diff was longer than `maxBytes`; what is here is a prefix of it. */
  cut: boolean;
}

interface IsolatedOutput {
  stdout: Buffer;
  cut: boolean;
}

export interface IsolatedGit {
  run(
    args: string[],
    options?: { input?: Buffer; maxBytes?: number; env?: Record<string, string> },
  ): Promise<IsolatedOutput>;
  /** The tree `tree` without the paths in `drop`, written into the private git dir. */
  withoutPaths(tree: string, drop: Set<string>, name: string): Promise<string>;
}

/** The environment for the private git dir: nothing of git's own variables, no user or system config. */
function scrubbedEnvironment(scratch: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    // `GIT_EXEC_PATH` says where a portable git keeps its programs; without it git does not start.
    if (name.startsWith("GIT_") && name !== "GIT_EXEC_PATH") continue;
    env[key] = value;
  }
  const home = join(scratch, "home");
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    // A file that does not exist is skipped by git; the null device is not sure to be on Windows.
    GIT_CONFIG_GLOBAL: join(scratch, "no-such-config"),
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(scratch, "xdg"),
  };
}

/** A git run with exactly this environment, a time limit, and a limit on what it may print. */
function runIsolated(
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    input?: Buffer;
    deadline?: Deadline;
    maxBytes?: number;
  },
): Promise<IsolatedOutput> {
  return new Promise((resolveResult, reject) => {
    let timeoutMs: number | undefined;
    if (options.deadline !== undefined) {
      timeoutMs = options.deadline.remainingMs();
      if (timeoutMs <= 0) {
        reject(new DeadlineError());
        return;
      }
    }
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let timedOut = false;
    let stderr = "";
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => {
      if (cut) return;
      const room = options.maxBytes === undefined ? data.length : options.maxBytes - size;
      if (data.length > room) {
        chunks.push(data.subarray(0, Math.max(room, 0)));
        size += Math.max(room, 0);
        cut = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(data);
      size += data.length;
    });
    child.stderr.on("data", (data: Buffer) => {
      if (stderr.length < 4_000) stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new DeadlineError());
      else if (cut) resolveResult({ stdout: Buffer.concat(chunks), cut: true });
      else if (code !== 0)
        reject(
          new Error(`git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${stderr.trim()}`),
        );
      else resolveResult({ stdout: Buffer.concat(chunks), cut: false });
    });
    child.stdin.on("error", () => undefined); // a failing git reports through its exit
    child.stdin.end(options.input);
  });
}

/**
 * Run `fn` with a git that sees only the objects of the repository at `cwd`. A plain `git diff`
 * between two trees still reads the `.gitattributes` and the config of the repository, which the
 * agent can write: one line makes every file "binary" and the patch empty. So the diff runs in a
 * bare git dir made for the occasion: no config, no attributes, no hooks, no template, none of the
 * environment's `GIT_*` variables; the repository's objects are reached through `alternates`.
 * Finding where the objects are runs in the normal environment (so `safe.directory` is honoured).
 */
export async function withIsolatedGit<T>(
  cwd: string,
  deadline: Deadline | undefined,
  fn: (iso: IsolatedGit) => Promise<T>,
): Promise<T> {
  const left = (): number | undefined => {
    if (deadline === undefined) return undefined;
    const ms = deadline.remainingMs();
    if (ms <= 0) throw new DeadlineError();
    return ms;
  };
  const { stdout: where } = await git(
    ["rev-parse", "--git-path", "objects"],
    cwd,
    { GIT_OPTIONAL_LOCKS: "0" },
    undefined,
    left(),
  );
  // Git prints it relative to the directory it was asked in (`.git/objects`); the alternates file is
  // read from somewhere else.
  const objects = resolve(cwd, where.trim());
  if (!isAbsolute(objects)) throw new Error("the object directory of the repository is unknown");
  let format = "sha1";
  try {
    const { stdout } = await git(["rev-parse", "--show-object-format"], cwd, {}, undefined, left());
    format = stdout.trim() || "sha1";
  } catch (error) {
    if (error instanceof DeadlineError) throw error;
    // git older than 2.26 has no such question and no other format
  }
  const scratch = await mkdtemp(join(tmpdir(), "kodel-patch-"));
  try {
    const base = scrubbedEnvironment(scratch);
    const gitDir = join(scratch, "git");
    await runIsolated(
      [
        "init",
        "--bare",
        "--quiet",
        "--template=",
        ...(format === "sha1" ? [] : [`--object-format=${format}`]),
        gitDir,
      ],
      { cwd: scratch, env: base, ...(deadline ? { deadline } : {}) },
    );
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(
      join(gitDir, "objects", "info", "alternates"),
      `${objects.replaceAll("\\", "/")}\n`,
    );
    const env = { ...base, GIT_DIR: gitDir };
    let indexes = 0;
    const iso: IsolatedGit = {
      run: (args, options = {}) =>
        runIsolated(args, {
          cwd: scratch,
          env: { ...env, ...options.env },
          ...(options.input ? { input: options.input } : {}),
          ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
          ...(deadline ? { deadline } : {}),
        }),
      async withoutPaths(tree, drop) {
        const listing = (await iso.run(["ls-tree", "-r", "-z", "--end-of-options", tree])).stdout;
        // Bytes, not text: a path that is not UTF-8 must come out as it went in.
        const kept: Buffer[] = [];
        let from = 0;
        while (from < listing.length) {
          let to = listing.indexOf(0, from);
          if (to < 0) to = listing.length;
          const entry = listing.subarray(from, to);
          from = to + 1;
          const tab = entry.indexOf(9);
          if (tab < 0) continue;
          const [mode, , sha] = entry.subarray(0, tab).toString("latin1").split(" ");
          const path = entry.subarray(tab + 1);
          if (drop.has(path.toString("utf8"))) continue;
          kept.push(
            Buffer.concat([Buffer.from(`${mode} ${sha}\t`, "latin1"), path, Buffer.from([0])]),
          );
        }
        indexes += 1;
        const index = { GIT_INDEX_FILE: join(scratch, `index-${indexes}`) };
        await iso.run(["update-index", "--add", "-z", "--index-info"], {
          input: Buffer.concat(kept),
          env: index,
        });
        const written = await iso.run(["write-tree"], { env: index });
        return written.stdout.toString("utf8").trim();
      },
    };
    return await fn(iso);
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

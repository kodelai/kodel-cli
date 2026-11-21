import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** The one PTY module. It is an optional dependency and external to the bundle: only `loadPty` imports it. */
export const PTY_MODULE = "@lydell/node-pty";

/** What the session code needs of a terminal the module made. A signal comes as a number (0 for none). */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

export type PtyProbe = { ok: true } | { ok: false; reason: string };
export type PtyLoad = { ok: true; pty: PtyModule } | { ok: false; reason: string };

/** Everything the check reads of the machine, so a test can give it another machine. */
export interface PtyHost {
  platform: string;
  arch: string;
  /** The launcher is Bun: the module loads there, but a spawned terminal never reports data or an exit. */
  bun: boolean;
  /** `false` on a Linux without glibc (Alpine): the prebuilt binary of linux needs it. */
  glibc: boolean;
  /** The file a specifier resolves to, looked up from `from` (a file path) or from this program. */
  resolve(specifier: string, from?: string): string | undefined;
  executable(path: string): boolean;
  load(specifier: string): Promise<unknown>;
}

const INSTALL_HINT = "install kodel without --omit=optional (or --no-optional) to get it";

export function ptyHost(): PtyHost {
  return {
    platform: process.platform,
    arch: process.arch,
    bun: process.versions.bun !== undefined,
    glibc: process.platform !== "linux" || hasGlibc(),
    resolve(specifier, from) {
      try {
        return createRequire(from ?? import.meta.url).resolve(specifier);
      } catch {
        return undefined;
      }
    },
    executable(path) {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    // The file the check found is the file that is loaded: `import()` of the bare name looks in fewer places
    // than the lookup above (no `NODE_PATH`, no folders of the home directory), so a module found only there
    // passed the check and then failed to load.
    load: (specifier) =>
      import(pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href),
  };
}

function hasGlibc(): boolean {
  try {
    const header = (process.report?.getReport() as { header?: Record<string, unknown> } | undefined)
      ?.header;
    return typeof header?.glibcVersionRuntime === "string";
  } catch {
    return false;
  }
}

/**
 * Whether a terminal session can be started here, without loading the module: the starter asks this before it
 * writes anything, and the holder asks again when it loads. It sees what an install left out, not every failure
 * of the load.
 */
export function probePty(host: PtyHost = ptyHost()): PtyProbe {
  if (host.platform === "win32") {
    return { ok: false, reason: "terminal sessions are not supported on Windows" };
  }
  if (host.bun) {
    return {
      ok: false,
      reason:
        "a terminal session cannot run under Bun: use the built kodel on Node (`bun run build`, then `node packages/cli/dist/kodel.js`)",
    };
  }
  const main = host.resolve(`${PTY_MODULE}/package.json`);
  if (main === undefined) {
    return {
      ok: false,
      reason: `the optional package ${PTY_MODULE} is not installed: ${INSTALL_HINT}`,
    };
  }
  const binary = `${PTY_MODULE}-${host.platform}-${host.arch}`;
  if (host.resolve(`${binary}/pty.node`, main) === undefined) {
    return {
      ok: false,
      reason: `${PTY_MODULE} has no binary package installed for this platform (${binary}): ${INSTALL_HINT}; a platform without such a package is not supported`,
    };
  }
  if (!host.glibc) {
    return {
      ok: false,
      reason: `${PTY_MODULE} has no binary for a Linux without glibc (Alpine, musl): terminal sessions are not supported here`,
    };
  }
  // Only the darwin binary starts the child through this helper; an installer that drops the mode bit breaks it.
  if (host.platform === "darwin") {
    const helper = host.resolve(`${binary}/spawn-helper`, main);
    if (helper === undefined || !host.executable(helper)) {
      return {
        ok: false,
        reason: `the spawn-helper of ${binary} is ${helper === undefined ? "missing" : `not executable (chmod +x ${helper})`}`,
      };
    }
  }
  return { ok: true };
}

const isPtyModule = (value: unknown): value is PtyModule =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { spawn?: unknown }).spawn === "function";

/** Loads the module after the same check, so a refusal names its reason and nothing half loaded is handed out. */
export async function loadPty(host: PtyHost = ptyHost()): Promise<PtyLoad> {
  const probe = probePty(host);
  if (!probe.ok) return probe;
  let loaded: unknown;
  try {
    loaded = await host.load(PTY_MODULE);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${PTY_MODULE} could not be loaded: ${text.split("\n")[0] ?? ""}` };
  }
  // A CommonJS module imported from ESM has its exports under `default`.
  const inner = (loaded as { default?: unknown } | null)?.default;
  const pty = isPtyModule(inner) ? inner : loaded;
  if (!isPtyModule(pty)) {
    return { ok: false, reason: `${PTY_MODULE} was loaded but has no spawn function` };
  }
  return { ok: true, pty };
}

/** The message of a refusal, in the shape the session commands print (`UNSUPPORTED: ...`). */
export const ptyUnsupported = (reason: string): string => `UNSUPPORTED: ${reason}`;

const CHECK_TIMEOUT_MS = 10_000;

/**
 * `kodel pty-check [--spawn]`: says whether a terminal session can run here and why not. With `--spawn` it also
 * runs `sh -c 'stty size'` in a terminal of 100 columns and 30 rows, which is what the packaging checks ask of an
 * installed kodel. It starts nothing a caller chose.
 */
export async function ptyCheckMain(
  args: string[],
  out: (text: string) => void,
  host: PtyHost = ptyHost(),
): Promise<number> {
  if (!args.includes("--spawn")) {
    const probe = probePty(host);
    out(`${JSON.stringify(probe)}\n`);
    return probe.ok ? 0 : 1;
  }
  const result = await loadPty(host);
  if (!result.ok) {
    out(`${JSON.stringify(result)}\n`);
    return 1;
  }
  const smoke = await new Promise<{ ok: boolean; output?: string; reason?: string }>((resolve) => {
    try {
      const child = result.pty.spawn("/bin/sh", ["-c", "stty size"], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, output, reason: "the terminal reported no exit in time" });
      }, CHECK_TIMEOUT_MS);
      child.onData((data) => {
        output += data;
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        const fits = exitCode === 0 && output.trim() === "30 100";
        resolve(
          fits
            ? { ok: true, output: output.trim() }
            : { ok: false, output, reason: `stty size answered exit ${exitCode}` },
        );
      });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  out(`${JSON.stringify(smoke)}\n`);
  return smoke.ok ? 0 : 1;
}

/**
 * Running a pipeline command. The command goes through the platform shell (`sh -c` or `cmd /c`),
 * stdin is closed, stdout and stderr are merged into a bounded tail, and a timeout or an abort
 * kills the whole process tree, not just the shell.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  /** How much of the end of the output to keep. */
  maxTailBytes?: number;
  /** Added to this process's environment, or used as the whole environment with `inheritEnv: false`. */
  env?: Record<string, string | undefined>;
  /** Whether the command starts from this process's environment (the default) or only from `env`. */
  inheritEnv?: boolean;
  signal?: AbortSignal;
  /** Applied to the tail before it is returned (secret redaction). */
  redact?: (text: string) => string;
}

export interface CommandResult {
  /** The exit code; 128 plus the signal number when a signal ended it; 127 if it could not start. */
  exit: number;
  timedOut: boolean;
  aborted: boolean;
  /** The end of stdout and stderr together. */
  tail: string;
  /** Whether earlier output was dropped to stay within `maxTailBytes`. */
  truncated: boolean;
  durationMs: number;
}

export const DEFAULT_MAX_TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 2_000;
const PIPE_GRACE_MS = 2_000;

function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => {},
    );
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref();
}

export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const maxTail = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const started = Date.now();

  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exit: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      let tail = Buffer.concat(chunks).toString("utf8").replace(/^�+/, "");
      if (truncated) tail = `[earlier output omitted]\n${tail}`;
      resolve({
        exit,
        timedOut,
        aborted,
        tail: options.redact ? options.redact(tail) : tail,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    const child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const collect = (data: Buffer) => {
      chunks.push(data);
      kept += data.length;
      while (kept > maxTail && chunks.length > 0) {
        const first = chunks[0] as Buffer;
        const excess = kept - maxTail;
        truncated = true;
        if (first.length <= excess) {
          chunks.shift();
          kept -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          kept -= excess;
        }
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, options.timeoutMs);
    }

    child.on("error", (error) => {
      chunks = [Buffer.from(`could not start the command: ${error.message}`)];
      finish(127);
    });
    const exitCode = (code: number | null, signal: NodeJS.Signals | null) =>
      code !== null ? code : 128 + (signal ? (constants.signals[signal] ?? 1) : 1);
    child.on("close", (code, signal) => finish(exitCode(code, signal)));
    // A grandchild that left the process group can hold the output pipes open for ever, and then
    // `close` never comes. The command is over when its shell has exited, plus a moment to read the end.
    child.on("exit", (code, signal) => {
      exitTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode(code, signal));
      }, PIPE_GRACE_MS);
    });
  });
}

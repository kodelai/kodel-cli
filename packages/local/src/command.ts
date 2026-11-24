/**
 * Running a pipeline command. The command goes through the platform shell (`sh -c` or `cmd /c`),
 * stdin is closed, stdout and stderr are merged into a bounded tail, and a timeout or an abort
 * kills the whole process tree, not just the shell.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { redactCutPrivateKey } from "@kodel-ai/pipeline-core";
import { liveProcess } from "./process-table";

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

export const DEFAULT_MAX_TAIL_BYTES = 64 * 1024;
/**
 * Read this much more than is kept: redaction runs on the text before the final cut, so a secret
 * that straddles the start of the kept tail is seen whole and cannot survive as a suffix.
 */
export const REDACT_MARGIN_BYTES = 1024;
const OMITTED = "[earlier output omitted]\n";
/** How long a command that ignores SIGTERM is given before it is killed outright. */
export const KILL_GRACE_MS = 2_000;
const PIPE_GRACE_MS = 2_000;

/** What `killTree` needs of the command it ends: a `ChildProcess` that was started as the leader of its group. */
export interface TreeLeader {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
}

export interface KillTreeParts {
  /** `process.kill` by default. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether the pid is a live process (not a zombie); the process table by default. */
  alive?: (pid: number) => boolean;
  graceMs?: number;
  platform?: NodeJS.Platform;
}

const escalations = new WeakMap<TreeLeader, () => void>();

/**
 * Ends a command and everything in its process group: `SIGTERM` to the group, then `SIGKILL` to it for what
 * ignored that. A group is signalled only while its leader is this live child: once the child has ended, its
 * group's number may belong to another program, so the later `SIGKILL` is dropped when the child exits and
 * the child is looked at again right before it is sent. Returns what drops a pending `SIGKILL`.
 */
export function killTree(child: TreeLeader, parts: KillTreeParts = {}): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => {};
  if ((parts.platform ?? process.platform) === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => {},
    );
    return () => {};
  }
  const kill = parts.kill ?? ((target, signal) => void process.kill(target, signal));
  const alive = parts.alive ?? liveProcess;
  // Not reaped by this process, so the pid is still the child's own; and not a zombie waiting to be.
  const leads = (): boolean => child.exitCode === null && child.signalCode === null && alive(pid);
  if (!leads()) return () => {};
  try {
    kill(-pid, "SIGTERM");
  } catch {
    return () => {};
  }
  const pending = escalations.get(child);
  if (pending) return pending;
  const timer = setTimeout(() => {
    escalations.delete(child);
    if (!leads()) return;
    try {
      kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, parts.graceMs ?? KILL_GRACE_MS);
  timer.unref();
  const cancel = (): void => {
    clearTimeout(timer);
    escalations.delete(child);
  };
  escalations.set(child, cancel);
  child.once("exit", cancel);
  return cancel;
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
      if (options.redact) tail = options.redact(truncated ? redactCutPrivateKey(tail) : tail);
      const bytes = Buffer.byteLength(tail);
      const cut = truncated || bytes > maxTail;
      if (cut) {
        // The marker counts toward the limit, so what is stored never exceeds it.
        const keep = Math.min(bytes, Math.max(0, maxTail - Buffer.byteLength(OMITTED)));
        const kept = Buffer.from(tail)
          .subarray(bytes - keep)
          .toString("utf8")
          .replace(/^�+/, "");
        tail = `${OMITTED}${kept}`;
      }
      resolve({
        exit,
        timedOut,
        aborted,
        tail,
        truncated: cut,
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
      const limit = maxTail + REDACT_MARGIN_BYTES;
      while (kept > limit && chunks.length > 0) {
        const first = chunks[0] as Buffer;
        const excess = kept - limit;
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
      killTree(child);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
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

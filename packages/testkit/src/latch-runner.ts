/**
 * A command runner for the host whose commands end when the test says so, not after a sleep: each
 * command parks on a latch keyed by `node#attempt` (or by what the caller names) until the test
 * releases it with an exit code. Tests of races and of overlap in a fork hold two branches open at
 * once and let them go in the order they want, with no timing in the test.
 */
import type { CommandContext, CommandOptions, CommandResult, RunCommandFn } from "@kodel-ai/local";

export interface LatchRunner {
  /** The runner to give the host (`runCommand`). */
  runner: RunCommandFn;
  /** Resolves when the command of this key has started (the host called the runner). */
  started(key: string): Promise<CommandContext>;
  /** Let the command of this key end with this exit code; a command not yet started ends as soon as it starts. */
  release(key: string, exit?: number, tail?: string): void;
  /** The keys of the commands that have started and not ended, in the order they started. */
  running(): string[];
  /** Every key that was ever started, in order. */
  seen(): string[];
}

/** The default key of a command: its node and attempt (a check adds its index). */
export function latchKeyOf(context: CommandContext): string {
  const base = `${context.node}#${context.attempt}`;
  return context.source === "check" ? `${base}#check${context.checkIndex ?? 0}` : base;
}

interface Latch {
  started: Promise<CommandContext>;
  markStarted: (context: CommandContext) => void;
  released: Promise<{ exit: number; tail: string }>;
  release: (outcome: { exit: number; tail: string }) => void;
}

function newLatch(): Latch {
  let markStarted!: (context: CommandContext) => void;
  let release!: (outcome: { exit: number; tail: string }) => void;
  const started = new Promise<CommandContext>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<{ exit: number; tail: string }>((resolve) => {
    release = resolve;
  });
  return { started, markStarted, released, release };
}

export function createLatchRunner(
  keyOf: (context: CommandContext) => string = latchKeyOf,
): LatchRunner {
  const latches = new Map<string, Latch>();
  const running: string[] = [];
  const seen: string[] = [];
  const latch = (key: string): Latch => {
    let found = latches.get(key);
    if (!found) {
      found = newLatch();
      latches.set(key, found);
    }
    return found;
  };
  const runner: RunCommandFn = async (
    _command: string,
    options: CommandOptions,
    context: CommandContext,
  ): Promise<CommandResult> => {
    const key = keyOf(context);
    const held = latch(key);
    seen.push(key);
    running.push(key);
    held.markStarted(context);
    const begun = Date.now();
    // An abort (the run was cancelled, the host stopped) ends the command like a killed process.
    const aborted = new Promise<{ exit: number; tail: string; aborted: true }>((resolve) => {
      // A signal aborted before the command started never fires `abort` again.
      if (options.signal?.aborted) resolve({ exit: 137, tail: "", aborted: true });
      options.signal?.addEventListener(
        "abort",
        () => resolve({ exit: 137, tail: "", aborted: true }),
        { once: true },
      );
    });
    const outcome = await Promise.race([held.released, aborted]);
    running.splice(running.indexOf(key), 1);
    return {
      exit: outcome.exit,
      timedOut: false,
      aborted: "aborted" in outcome,
      tail: outcome.tail,
      truncated: false,
      durationMs: Date.now() - begun,
    };
  };
  return {
    runner,
    started: (key) => latch(key).started,
    release: (key, exit = 0, tail = "") => latch(key).release({ exit, tail }),
    running: () => [...running],
    seen: () => [...seen],
  };
}

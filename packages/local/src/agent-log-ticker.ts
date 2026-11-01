/**
 * The timer that copies the agent's log while a run goes. One per run, in the process that serves the MCP tools:
 * the first call of the run it sees starts it, and it stops when the run is not running, when the copy has been
 * given up (a state that cannot be read, three times in a row), when the timer has used the copies it may
 * journal, and when the process is stopped. A timer never keeps the process alive and never throws.
 *
 * It is not started by the commands a person runs (`status`, `report`, `wait`, `gate`): the host that serves them
 * has no registry, so there is nothing to start.
 */
import type { AgentLogRun, AgentLogWriter } from "./agent-log";

/** Ticks that go wrong one after another before the timer gives up. */
export const MAX_FAILED_TICKS = 3;

export interface TimerHandle {
  unref?: () => void;
}

export interface Timers {
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
}

const SYSTEM_TIMERS: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

interface Entry {
  handle: TimerHandle;
  run: AgentLogRun;
  failures: number;
}

export class AgentLogTickers {
  private readonly entries = new Map<string, Entry>();
  /** Runs for which a start is being decided, so that two calls at once make one timer. */
  private readonly starting = new Set<string>();
  /** Why the last start was not made; for tests and for anyone who wonders. */
  lastRefusal: string | undefined;

  constructor(
    private readonly writer: AgentLogWriter,
    private readonly timers: Timers = SYSTEM_TIMERS,
  ) {}

  private refuse(reason: string): void {
    this.lastRefusal = reason;
  }

  /** Whether the run has a timer going. */
  has(runId: string): boolean {
    return this.entries.has(runId);
  }

  /**
   * Start the timer of a run if it should have one and has none. The interval is the one the run was started with;
   * a run that does not copy, or copies only at the end of a step (`interval_s: 0`), gets none.
   */
  async ensure(run: AgentLogRun): Promise<void> {
    if (this.entries.has(run.runId) || this.starting.has(run.runId)) return;
    this.starting.add(run.runId);
    try {
      const state = await run.state();
      const config = state.history?.agent_log;
      if (state.status !== "running") return this.refuse("not_running");
      if (state.agentLog === undefined || config?.enabled !== true) {
        return this.refuse("disabled");
      }
      if (config.interval_s <= 0) return this.refuse("interval_off");
      // With no session named by the environment or the hooks there is nothing to copy; a later call tries again.
      if (!(await this.writer.hasCandidates())) return this.refuse("no_candidates");
      if (this.entries.has(run.runId)) return;
      const entry: Entry = {
        run,
        failures: 0,
        handle: this.timers.setInterval(() => void this.tick(run.runId), config.interval_s * 1_000),
      };
      // A timer must not be the reason a process stays up.
      entry.handle.unref?.();
      this.entries.set(run.runId, entry);
      this.lastRefusal = undefined;
    } catch {
      this.lastRefusal = "unreadable";
    } finally {
      this.starting.delete(run.runId);
    }
  }

  /** One tick, also called by tests with a manual timer. */
  async tick(runId: string): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry === undefined) return;
    try {
      const result = await this.writer.capture(entry.run, { why: "tick", waitMs: 0 });
      if (result.skipped === "not_running" || result.skipped === "disabled") {
        this.stop(runId);
      } else if (result.skipped === "tick_cap") {
        // The copies the timer may journal are used; the ends of steps still copy.
        try {
          await entry.run.apply({ type: "agent_log_failed", reason: "tick_cap" });
        } catch {
          // said or not, the timer is done
        }
        // (what the timer knows about the log is kept: the ends of steps go on copying)
        this.stop(runId, false);
      } else if (result.errored === true) {
        entry.failures += 1;
        if (entry.failures >= MAX_FAILED_TICKS) {
          try {
            await entry.run.apply({ type: "agent_log_failed", reason: "unreadable" });
          } catch {
            // a state that cannot be read cannot take the news either
          }
          this.stop(runId);
        }
      } else {
        entry.failures = 0;
      }
    } catch {
      entry.failures += 1;
      if (entry.failures >= MAX_FAILED_TICKS) this.stop(runId);
    }
  }

  stop(runId: string, forget = true): void {
    const entry = this.entries.get(runId);
    if (entry === undefined) return;
    this.entries.delete(runId);
    this.timers.clearInterval(entry.handle);
    if (forget) this.writer.forget(runId);
  }

  stopAll(): void {
    for (const runId of [...this.entries.keys()]) this.stop(runId);
  }
}

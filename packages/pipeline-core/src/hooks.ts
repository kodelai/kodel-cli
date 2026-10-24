/**
 * The hook transport: what a coding agent tells Kodel about its session (a session started, a tool
 * is about to run), independent of the agent. A per-agent normalizer makes a `HookEvent`; the
 * handlers in a `HookRegistry` decide what to do with it. The registry is the single source of
 * truth for which events anything needs, so the agent's hook configuration is derived from it and a
 * new handler for an event that is already registered needs no change of that configuration.
 *
 * Everything here is pure: reading stdin, files and timers come in through the caller.
 */

export const HOOK_AGENTS = ["claude-code", "codex", "opencode"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export interface HookEvent {
  agent: HookAgent;
  /** The agent's own event name, e.g. `SessionStart` or `PreToolUse`. */
  name: string;
  session_id: string;
  cwd: string;
  /** When the event was seen, ISO 8601. */
  ts: string;
  transcript_path?: string;
  tool?: string;
  /** The payload as the agent sent it. Untrusted; handlers read from it with care. */
  raw: Record<string, unknown>;
}

export interface HookContext {
  /** The Kodel project the event belongs to. */
  root: string;
}

export interface HookHandler {
  id: string;
  /** Event names the handler needs, in the agents' own spelling. */
  events: readonly string[];
  /** Only these agents; all of them when left out. */
  agents?: readonly HookAgent[];
  /**
   * Whether the text the handler returns may reach the agent's stdout. For some events it enters the
   * agent's context, so it is off unless a handler means it.
   */
  prints?: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: a handler that returns nothing is the usual one
  run(event: HookEvent, context: HookContext): void | string | Promise<void | string>;
}

export class HookRegistry {
  private readonly handlers: HookHandler[] = [];

  register(handler: HookHandler): this {
    if (this.handlers.some((h) => h.id === handler.id)) {
      throw new Error(`hook handler "${handler.id}" is already registered`);
    }
    this.handlers.push(handler);
    return this;
  }

  all(): readonly HookHandler[] {
    return this.handlers;
  }

  handlersFor(agent: HookAgent, name: string): HookHandler[] {
    return this.handlers.filter(
      (h) => h.events.includes(name) && (h.agents === undefined || h.agents.includes(agent)),
    );
  }

  /** The events to register with `agent`: the union of what its handlers need, in registration order. */
  events(agent: HookAgent): string[] {
    const names: string[] = [];
    for (const h of this.handlers) {
      if (h.agents !== undefined && !h.agents.includes(agent)) continue;
      for (const name of h.events) if (!names.includes(name)) names.push(name);
    }
    return names;
  }
}

/** A timer the caller provides; the engine has no clock. `start` returns the function that cancels it. */
export interface HookTimer {
  start(ms: number, onTimeout: () => void): () => void;
}

export interface HookFailure {
  handler: string;
  reason: string;
}

export interface DispatchOptions {
  timer: HookTimer;
  /** How long one handler may take. */
  timeoutMs: number;
}

export interface DispatchResult {
  /** What handlers that may print asked to print; empty by default. */
  output: string;
  failures: HookFailure[];
}

function raced<T>(work: Promise<T>, ms: number, timer: HookTimer): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = timer.start(ms, () => reject(new Error(`timed out after ${ms} ms`)));
    work.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}

/**
 * Run the handlers registered for the event. One that throws or takes too long is reported and the
 * others still run; this function does not throw.
 */
export async function dispatch(
  registry: HookRegistry,
  event: HookEvent,
  context: HookContext,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const failures: HookFailure[] = [];
  const handlers = registry.handlersFor(event.agent, event.name);
  // Indexed, so the output keeps the order of registration, not of finishing.
  const parts: string[] = handlers.map(() => "");
  await Promise.all(
    handlers.map(async (handler, index) => {
      try {
        const text = await raced(
          Promise.resolve().then(() => handler.run(event, context)),
          options.timeoutMs,
          options.timer,
        );
        if (handler.prints === true && typeof text === "string") parts[index] = text;
      } catch (error) {
        failures.push({
          handler: handler.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return { output: parts.join(""), failures };
}

/** Which of `registered` the registry no longer asks for, and which it asks for that are missing. */
export function staleHookEvents(
  registered: readonly string[],
  wanted: readonly string[],
): { missing: string[]; extra: string[] } {
  return {
    missing: wanted.filter((name) => !registered.includes(name)),
    extra: registered.filter((name) => !wanted.includes(name)),
  };
}

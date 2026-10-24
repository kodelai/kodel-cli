/**
 * Running the hook. The contract with the agent is narrow: whatever happens, the caller exits 0 (an
 * exit code of 2 blocks the agent on some events, any other non-zero is a visible error), and nothing
 * goes to stdout unless a handler that may print asked for it, because the stdout of some events
 * enters the agent's context. So nothing in here throws, and every failure goes to `.kodel/hooks.log`
 * of the project, or nowhere when there is no project.
 */
import {
  dispatch,
  HOOK_AGENTS,
  type HookAgent,
  type HookRegistry,
  type HookTimer,
  normalizeHookPayload,
} from "@kodel-ai/pipeline-core/hooks";
import { appendHookLog } from "./log";
import { findProjectRoot } from "./project";
import { defaultHookRegistry } from "./registry";

/** More than this on stdin is not an event of ours; the rest is read and thrown away. */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const HANDLER_TIMEOUT_MS = 2_000;

export const nodeTimer: HookTimer = {
  start(ms, onTimeout) {
    const handle = setTimeout(onTimeout, ms);
    return () => clearTimeout(handle);
  },
};

export interface HookInput {
  text: string;
  /** Whether stdin was longer than the cap (then `text` is not the whole payload). */
  tooLarge: boolean;
}

/** Read a stream up to the cap; what comes after is drained, not kept. */
export async function readCapped(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): Promise<HookInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(buffer);
      }
    }
  } catch {
    // A broken pipe is the end of the input.
  }
  return { text: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"), tooLarge };
}

export interface RunHookOptions {
  now?: Date;
  registry?: HookRegistry;
  timeoutMs?: number;
  timer?: HookTimer;
}

/** The text for the agent's stdout; empty unless a handler that may print asked for something. */
export async function runHook(
  agent: string,
  input: HookInput,
  options: RunHookOptions = {},
): Promise<string> {
  try {
    if (!HOOK_AGENTS.includes(agent as HookAgent) || input.tooLarge) return "";
    let payload: unknown;
    try {
      payload = JSON.parse(input.text);
    } catch {
      return "";
    }
    const now = options.now ?? new Date();
    const event = normalizeHookPayload(agent as HookAgent, payload, now);
    if (event === undefined) return "";
    const root = await findProjectRoot(event.cwd);
    if (root === undefined) return "";
    const result = await dispatch(
      options.registry ?? defaultHookRegistry(),
      event,
      { root },
      { timer: options.timer ?? nodeTimer, timeoutMs: options.timeoutMs ?? HANDLER_TIMEOUT_MS },
    );
    for (const failure of result.failures) {
      await appendHookLog(
        root,
        `${agent} ${event.name}: ${failure.handler}: ${failure.reason}`,
        now,
      );
    }
    return result.output;
  } catch {
    return "";
  }
}

/** `kodel hook <agent>`: the arguments after `hook`, and the stream the agent writes the event to. */
export async function hookMain(
  args: readonly string[],
  stdin: AsyncIterable<Buffer | string>,
): Promise<string> {
  const input = await readCapped(stdin);
  return runHook(args[0] ?? "", input);
}

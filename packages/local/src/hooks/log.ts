/**
 * The hook's own log, `.kodel/hooks.log`: the only place a failure of the hook is written, since
 * the hook must not say anything to the agent. It is capped, and it never throws.
 */
import { appendFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HOOK_LOG = join(".kodel", "hooks.log");
export const HOOK_LOG_MAX_BYTES = 64 * 1024;
const MAX_MESSAGE = 500;

// Anything from a payload may end up in the message; controls would reach a terminal as escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export async function appendHookLog(root: string, message: string, now: Date): Promise<void> {
  try {
    const file = join(root, HOOK_LOG);
    const clean = message.replace(CONTROL, "?").slice(0, MAX_MESSAGE);
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    // Over the cap the old lines go: the newest are the ones worth reading.
    if (size > HOOK_LOG_MAX_BYTES) await writeFile(file, "(older lines dropped)\n");
    await appendFile(file, `${now.toISOString()} ${clean}\n`);
  } catch {
    // Nowhere left to report to.
  }
}

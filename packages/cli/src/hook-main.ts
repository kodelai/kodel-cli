/**
 * The entry of `kodel hook <agent>`. An agent starts it on every event it is registered for, a tool
 * call included, so it imports only the hook transport and exits as soon as it has an answer. It
 * always exits 0: an exit code of 2 blocks the agent on some events, and any other non-zero shows
 * the person an error for something that is not theirs to fix.
 */
import { hookMain } from "@kodel-ai/local/hooks";

export async function runHookEntry(args: readonly string[]): Promise<void> {
  const quit = () => process.exit(0);
  process.on("uncaughtException", quit);
  process.on("unhandledRejection", quit);
  process.stdout.on("error", quit);
  // Typed by a person at a terminal: there is no event to wait for.
  if (process.stdin.isTTY === true) quit();
  let out = "";
  try {
    out = await hookMain(args, process.stdin);
  } catch {
    // hookMain does not throw; this is for what it cannot foresee.
  }
  if (out === "") quit();
  else process.stdout.write(out, quit);
}

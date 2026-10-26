/**
 * The hooks step of `kodel init`: it registers the events the handlers need (and only those) with
 * each agent, so the agent tells `kodel hook <agent>` what happens in its sessions. The list comes from
 * the handler registry, so running `init` again picks up the events of handlers added since.
 *
 * Like the rest of `init` it only adds: the person's own hooks stay, our entry is added once, and a
 * file that is not plain JSON is left alone with a note.
 */
import {
  HOOK_FILES,
  hookCommand,
  isKodelHookCommand,
  opencodePluginSource,
} from "@kodel-ai/local/hooks";
import type { HookAgent } from "@kodel-ai/pipeline-core/hooks";
import { type Context, editFile, editJson, objectAt, SkipEdit } from "./files";

/** Seconds the agent waits for the hook; it is quick, so a stuck one must not hold the agent. */
const HOOK_TIMEOUT_S = 10;

const OPENCODE_HEADER = "// @ts-nocheck\n// Written by `kodel init`";

type Entry = { type?: string; command?: unknown; timeout?: number };
type Group = { hooks?: Entry[] };

/** Add our command to each event; one already there (whatever program starts it) is kept unless `--force`. */
function addHooks(
  ctx: Context,
  config: Record<string, unknown>,
  agent: HookAgent,
  command: string,
  events: readonly string[],
): void {
  const hooks = objectAt(config, "hooks");
  for (const name of events) {
    const existing = hooks[name];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new SkipEdit(`"hooks.${name}" is not a list; left as it was`);
    }
    const groups = (existing as Group[] | undefined) ?? [];
    const ours = groups
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .find((entry) => isKodelHookCommand(entry?.command, agent));
    if (ours) {
      if (ctx.force) ours.command = command;
    } else {
      groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] });
    }
    hooks[name] = groups;
  }
}

/** Register `events` with `agent`; the command is the server command with `hook <agent>` in place of `mcp`. */
export async function registerHooks(
  ctx: Context,
  agent: HookAgent,
  serverCommand: string,
  events: readonly string[],
): Promise<void> {
  const command = hookCommand(serverCommand, agent);
  const file = HOOK_FILES[agent];
  if (agent === "opencode") {
    await editFile(ctx, file, (previous) => {
      if (previous !== undefined && !previous.startsWith(OPENCODE_HEADER) && !ctx.force) {
        return { skip: "not written by kodel; use --force to replace it" };
      }
      return { text: opencodePluginSource(command, events) };
    });
    return;
  }
  await editFile(ctx, file, (previous) =>
    editJson(previous, (config) => addHooks(ctx, config, agent, command, events)),
  );
}

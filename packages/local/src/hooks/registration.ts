/**
 * How the hook is registered with each agent: the command, the file `kodel init` writes, and how to
 * read back which events are registered. `init` writes and the hook itself reads (to notice that the
 * registered events no longer match the registry), so both sit here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookAgent } from "@kodel-ai/pipeline-core/hooks";

/** Where each agent's registration lives, relative to the project root. */
export const HOOK_FILES: Record<HookAgent, string> = {
  "claude-code": ".claude/settings.local.json",
  codex: ".codex/hooks.json",
  opencode: ".opencode/plugins/kodel-hooks.ts",
};

/** The small program that only runs the hook; it starts in about 30 ms, `kodel hook` in about 50. */
export const HOOK_BIN = "kodel-hook";

/**
 * The command an agent runs for an event. It starts the same program the server does: for the
 * installed `kodel` that is the small `kodel-hook <agent>`, for any other command (a script run by
 * `bun`, `npx kodel@1`) it is that command with `hook <agent>` after it. `serverCommand` has no
 * subcommand: `mcp` is added where the server is started.
 */
export function hookCommand(serverCommand: string, agent: HookAgent): string {
  const words = serverCommand.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0] === "kodel") return `${HOOK_BIN} ${agent}`;
  return [...words, "hook", agent].join(" ");
}

/** Whether a command in an agent's config is a Kodel hook, whatever the program in front of it. */
export function isKodelHookCommand(command: unknown, agent: HookAgent): boolean {
  if (typeof command !== "string") return false;
  const text = command.trim();
  // The bin may be quoted or carry a Windows extension (`"C:\...\kodel-hook.cmd" codex`).
  const bin = new RegExp(`(^|[\\s/\\\\"])${HOOK_BIN}(\\.cmd|\\.exe)?"?\\s+${agent}$`);
  return text.endsWith(` hook ${agent}`) || bin.test(text);
}

const EVENTS_LINE = /^\/\/ kodel:events (.*)$/m;

export function opencodePluginSource(command: string, events: readonly string[]): string {
  return `// @ts-nocheck
// Written by \`kodel init\`: it passes OpenCode's session and tool events to \`kodel hook opencode\`.
// It is replaced when init runs again; edit nothing here.
// kodel:events ${events.join(",")}
import { spawn } from "node:child_process";

const COMMAND = ${JSON.stringify(command)};
const EVENTS = new Set(${JSON.stringify(events)});

export default {
  id: "kodel-hooks",
  async setup(ctx) {
    const directory = ctx?.location?.directory ?? process.cwd();
    const send = (name, sessionID, cwd, tool) => {
      if (!EVENTS.has(name) || typeof sessionID !== "string") return;
      try {
        const child = spawn(COMMAND, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => {});
        child.stdin.on("error", () => {});
        child.stdin.end(
          JSON.stringify({ hook_event_name: name, session_id: sessionID, cwd, tool_name: tool }),
        );
        child.unref();
      } catch {}
    };
    // The event stream is the server's, and a server can hold plugins of several directories: only the
    // sessions of this directory are ours. A session is known by an event that says where it is, or by a
    // tool call of this directory.
    const inside = (where) =>
      where === directory || where.startsWith(directory + "/") || where.startsWith(directory + "\\\\");
    const mine = new Set();
    // OpenCode creates a session before the plugin may be listening (the first run in a directory), so a
    // session is started for us when it is first seen, whatever the event: that also covers a resumed one.
    const first = (sessionID, cwd) => {
      if (typeof sessionID !== "string" || mine.has(sessionID)) return;
      mine.add(sessionID);
      send("SessionStart", sessionID, cwd);
    };
    try {
      const controller = new AbortController();
      (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              const id = event?.data?.sessionID;
              const where = event?.location?.directory;
              if (typeof where === "string") {
                if (!inside(where)) continue;
                first(id, where);
              } else if (!mine.has(id)) continue;
              if (event.type === "session.execution.succeeded") send("Stop", id, directory);
            } catch {}
          }
        } catch {}
      })();
      await ctx.tool.hook("execute.before", (e) => {
        first(e?.sessionID, directory);
        send("PreToolUse", e?.sessionID, directory, e?.tool);
      });
      await ctx.tool.hook("execute.after", (e) => {
        first(e?.sessionID, directory);
        send("PostToolUse", e?.sessionID, directory, e?.tool);
      });
      return () => controller.abort();
    } catch {}
  },
};
`;
}

/** The events of the Kodel hook an agent has registered; `undefined` when there is no readable registration. */
export async function readRegisteredEvents(
  agent: HookAgent,
  root: string,
): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, HOOK_FILES[agent]), "utf8");
  } catch {
    return undefined;
  }
  if (agent === "opencode") {
    const line = EVENTS_LINE.exec(text)?.[1];
    return line === undefined ? undefined : line.split(",").filter(Boolean);
  }
  try {
    const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
    const events: string[] = [];
    for (const [name, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const ours = groups.some(
        (group: unknown) =>
          Array.isArray((group as { hooks?: unknown })?.hooks) &&
          ((group as { hooks: unknown[] }).hooks as { command?: unknown }[]).some((h) =>
            isKodelHookCommand(h?.command, agent),
          ),
      );
      if (ours) events.push(name);
    }
    return events;
  } catch {
    return undefined;
  }
}

/**
 * The handlers Kodel ships. This is the single source of truth for which events anything needs:
 * `kodel init` registers exactly `events(agent)`, so a handler added here for an event that is already
 * registered needs no change of the agent's configuration, and one for a new event is picked up the
 * next time `init` runs (the hook says so at `SessionStart` until it does).
 */
import { type HookHandler, HookRegistry, staleHookEvents } from "@kodel-ai/pipeline-core/hooks";
import { appendHookLog } from "./log";
import { readRegisteredEvents } from "./registration";
import { sessionRegistrar } from "./session-registrar";

function staleCheck(registry: () => HookRegistry): HookHandler {
  return {
    id: "stale-check",
    events: ["SessionStart"],
    async run(event, context) {
      const registered = await readRegisteredEvents(event.agent, context.root);
      // No registration by init (the person set the hook up by hand, or not at all): nothing to compare.
      if (registered === undefined) return;
      const { missing } = staleHookEvents(registered, registry().events(event.agent));
      if (missing.length === 0) return;
      await appendHookLog(
        context.root,
        `${event.agent}: events not registered: ${missing.join(", ")}; run \`kodel init\``,
        new Date(event.ts),
      );
    },
  };
}

export function defaultHookRegistry(): HookRegistry {
  const registry = new HookRegistry();
  registry.register(sessionRegistrar);
  registry.register(staleCheck(() => registry));
  return registry;
}

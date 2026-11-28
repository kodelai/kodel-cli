/**
 * What the web UI's Start and Stop agent buttons act through: the same functions the terminal's `s` and the
 * manager's tools call (`manual-start.ts`, `manual-stop.ts`), with a person's `by` and `web` as `via`. They
 * need no key of `decisions.agent`: those keys are for an agent, and a person at the page is not one.
 */
import type { Caller } from "@kodel-ai/pipeline-core";
import { type ActingPorts, readManualTask } from "../manager-ports";
import { checkManualStart, type ManualStartDeps, startManual } from "../manual-start";
import { stopRunAgent } from "../manual-stop";
import type { WebApi } from "./handler";

export function webActing(input: {
  acting: ActingPorts;
  platform: string;
  now?: () => number;
}): Pick<WebApi, "startTask" | "stopAgent"> {
  // Agents and the start lock do not exist on Windows yet: no button is offered.
  if (input.platform === "win32") return {};
  const { acting } = input;
  const caller: Caller = { name: "kodel-web", version: acting.version };
  const { tasks } = acting;

  const depsOf = async (): Promise<ManualStartDeps> => {
    const worktreesDir = await acting.worktreesDir?.();
    return {
      host: acting.host,
      launcher: await acting.launcher(),
      readTask: (key) =>
        tasks === undefined
          ? Promise.resolve({ status: "failed", message: "tasks are off in this project" })
          : readManualTask(tasks, key),
      serve: acting.serve,
      caller,
      dialog: await acting.dialog(),
      root: acting.root,
      ...(worktreesDir === undefined ? {} : { worktreesDir }),
      ...(input.now === undefined ? {} : { now: input.now }),
    };
  };

  return {
    ...(tasks === undefined
      ? {}
      : {
          startTask: {
            check: async (key) => checkManualStart(await depsOf(), { key, via: "web" }),
            start: async ({ key, pipeline, force }) =>
              startManual(await depsOf(), {
                key,
                ...(pipeline === undefined ? {} : { pipeline }),
                by: "person",
                via: "web",
                force,
              }),
          },
        }),
    stopAgent: async (runId) =>
      stopRunAgent(
        { host: acting.host, launcher: await acting.launcher() },
        { runId, by: "person" },
      ),
  };
}

/**
 * The shape of an engine step that runs its command as a session (what TASK-WKJ4 will be), written on the public
 * interface only: it imports nothing of the pipeline engine. A sketch of the consumer, not WKJ4 itself.
 *
 * The retry rule: the name is derived from (run, node, attempt), so a second try finds the first one's session.
 * A live session is joined; a finished one yields its result; a name that was used and is gone, or a `lost`
 * session, fails the step ("unknown, a person decides") and never runs the attempt again.
 */
import { createHash } from "node:crypto";
import { type SessionAdapter, SessionError, type SessionSpec } from "@kodel-ai/pipeline-core";

export type StepOutcome =
  | { kind: "result"; exitCode: number; tail: string }
  | { kind: "failed"; why: string }
  | { kind: "unknown"; why: string };

export const stepSessionName = (run: string, node: string, attempt: number): string =>
  `n${createHash("sha256").update(`${run}\0${node}\0${attempt}`).digest("hex").slice(0, 10)}`;

export async function runStepAsSession(
  adapter: SessionAdapter,
  step: { run: string; node: string; attempt: number },
  program: Pick<SessionSpec, "argv" | "cwd" | "timeoutMs">,
  opts: { waitMs?: number } = {},
): Promise<StepOutcome> {
  const name = stepSessionName(step.run, step.node, step.attempt);
  let id: string;
  try {
    id = (await adapter.start({ ...program, name })).id;
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    if (error.code === "NAME_USED") {
      return {
        kind: "unknown",
        why: "the attempt was started before and its session is gone; a person decides",
      };
    }
    if (error.code !== "NAME_TAKEN")
      return { kind: "failed", why: `${error.code}: ${error.message}` };
    const found = (await adapter.list({ name }))[0];
    if (!found) return { kind: "unknown", why: "the name is taken but no session was found" };
    id = found.id;
  }
  const done = await adapter.wait(id, opts.waitMs === undefined ? {} : { timeoutMs: opts.waitMs });
  if (done.timedOut) return { kind: "unknown", why: "still running at the bound" };
  if (done.state === "lost")
    return { kind: "unknown", why: "the session was lost; a person decides" };
  if (done.childAlive) return { kind: "unknown", why: "the session ended but its child is alive" };
  if (done.state === "killed")
    return { kind: "failed", why: `killed (${done.reason ?? done.signal ?? "unknown"})` };
  const tail = (await adapter.tail(id)).text;
  return { kind: "result", exitCode: done.exitCode ?? 0, tail };
}

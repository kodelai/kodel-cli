/**
 * The client of the Kodel feedback inbox. It is deliberately separate from the engine: it needs no
 * repository and no run, and sends nothing but the text the person wrote and a small description
 * of the environment.
 */

import { arch, platform, release } from "node:os";

export const FEEDBACK_TYPES = ["bug", "feature", "feedback"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Fixed on purpose: text and context must not be redirected elsewhere by a flag or a variable. */
export const FEEDBACK_ENDPOINT = "https://kodel.ai/api/feedback";

/** The inbox refuses a longer message; saying so here keeps a huge piped text off the screen. */
export const FEEDBACK_MESSAGE_MAX = 8000;
const FEEDBACK_TIMEOUT_MS = 15_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function isFeedbackType(value: string): value is FeedbackType {
  return (FEEDBACK_TYPES as readonly string[]).includes(value);
}

/** What the person is running; nothing from the repository, the run or the environment variables. */
export function feedbackContext(version: string): Record<string, string> {
  return {
    kodelVersion: version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
  };
}

async function failure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error.slice(0, 100) : undefined;
  if (response.status === 429) return "too many reports, try again in a few minutes";
  return code ? `${code} (HTTP ${response.status})` : `HTTP ${response.status}`;
}

export async function submitFeedback(
  fetcher: Fetch,
  input: { type: FeedbackType; message: string; context?: Record<string, string> },
): Promise<string> {
  const response = await fetcher(FEEDBACK_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    // A redirect would send the text and the context to an address the person was not shown.
    redirect: "error",
    signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
  }).catch((error: unknown) => {
    // "fetch failed" alone does not tell a DNS failure from a refused connection; the cause does.
    const cause = error instanceof Error ? error.cause : undefined;
    const why =
      cause instanceof Error ? cause.message : error instanceof Error ? error.message : "";
    throw new Error(`could not reach the feedback inbox: ${why}`.trim());
  });
  if (!response.ok) throw new Error(`the feedback inbox refused it: ${await failure(response)}`);
  const body = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined;
  if (typeof body?.id !== "string") throw new Error("the feedback inbox sent no id");
  return body.id;
}

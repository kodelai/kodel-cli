/**
 * The client of the feedback inbox (the same one `kodelctl feedback` talks to). It is deliberately
 * separate from the engine: it needs no repository and no run, and sends nothing but the text the
 * person wrote and a small description of the environment.
 */

import { arch, platform, release } from "node:os";

export const FEEDBACK_TYPES = ["bug", "feature", "feedback"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const DEFAULT_FEEDBACK_URL = "https://kodel.ai";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FeedbackRecord {
  id: string;
  type: string;
  message: string;
  status: string;
  comment: string | null;
  createdAt: string;
}

export function isFeedbackType(value: string): value is FeedbackType {
  return (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function resolveFeedbackUrl(
  flag: string | undefined,
  environment: Record<string, string | undefined> | undefined,
): string {
  const url = flag ?? environment?.KODEL_FEEDBACK_URL ?? DEFAULT_FEEDBACK_URL;
  return url.replace(/\/+$/, "");
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
  const code = typeof body?.error === "string" ? body.error : undefined;
  if (response.status === 429) return "too many reports, try again in a few minutes";
  return code ? `${code} (HTTP ${response.status})` : `HTTP ${response.status}`;
}

export async function submitFeedback(
  fetcher: Fetch,
  baseUrl: string,
  input: { type: FeedbackType; message: string; context?: Record<string, string> },
): Promise<string> {
  const response = await fetcher(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`the feedback inbox refused it: ${await failure(response)}`);
  const body = (await response.json().catch(() => undefined)) as { id?: unknown } | undefined;
  if (typeof body?.id !== "string") throw new Error("the feedback inbox sent no id");
  return body.id;
}

export async function getFeedback(
  fetcher: Fetch,
  baseUrl: string,
  id: string,
): Promise<FeedbackRecord> {
  const response = await fetcher(`${baseUrl}/api/feedback/${encodeURIComponent(id)}`);
  if (response.status === 404) throw new Error(`no feedback ${id}`);
  if (!response.ok) throw new Error(`the feedback inbox failed: ${await failure(response)}`);
  return (await response.json()) as FeedbackRecord;
}

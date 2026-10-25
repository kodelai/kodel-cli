/**
 * Who acted on a run and which engine served it. Every value says where it came from, and none comes
 * from the agent's own word: the agent's tool arguments are never read for it, so a model that lies
 * about itself cannot reach the history.
 */
import type { z } from "zod";
import { stableJson } from "./canonical";

export const EXECUTOR_SOURCES = [
  /** From the protocol itself (the MCP handshake). */
  "observed",
  /** From the environment of the server process. */
  "observed-env",
  /** From the payload of an agent hook. */
  "observed-hook",
  /** From the project's own configuration. */
  "declared",
  /** Read out of something else that was observed (the agent's session log). */
  "derived",
] as const;
export type ExecutorSource = (typeof EXECUTOR_SOURCES)[number];

export interface Sourced<T> {
  value: T;
  source: ExecutorSource;
}

/** The client that makes the calls, as the transport states it. Opaque to the core. */
export interface Caller {
  name: string;
  version: string;
}

/** What one call or one record knows about who acted. Every part is optional: no value is made up. */
export interface ExecutorRecord {
  client?: Sourced<Caller>;
  session?: Sourced<string>;
  model?: Sourced<string>;
}

/** The engine that wrote a run's records. Written once, at the start of a run. */
export interface EngineRecord {
  version: string;
  /** The commit the artifact was built from; `unknown` for a build that did not say. */
  commit: string;
  record_version: number;
  meta_version: number;
  /** The three below are there when the host knows what the agent was served. */
  contract_version?: number;
  /** Hash of the instructions the agent was given when it connected. */
  instructions_hash?: string;
  /** Hash of the tools the agent was given: names, descriptions and arguments. */
  tools_hash?: string;
}

/** Longest value kept from outside: a name or an id is short, and a long one is an attack or a bug. */
export const MAX_EXECUTOR_TEXT = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * A value from outside the engine, made safe to keep: control characters removed, cut at
 * `MAX_EXECUTOR_TEXT`. Secrets are taken out by the store, which redacts everything it writes.
 * Empty after cleaning means there is no value.
 */
export function cleanExecutorText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(CONTROL, "").trim().slice(0, MAX_EXECUTOR_TEXT);
  return text === "" ? undefined : text;
}

export function sourced<T>(value: T, source: ExecutorSource): Sourced<T> {
  return { value, source };
}

/** The caller as the record keeps it, or nothing when the transport did not give a usable name. */
export function clientOf(caller: Caller | undefined): Sourced<Caller> | undefined {
  const name = cleanExecutorText(caller?.name);
  if (name === undefined) return undefined;
  return sourced({ name, version: cleanExecutorText(caller?.version) ?? "" }, "observed");
}

/** Whether two records say the same about who acted. */
export function sameExecutor(
  a: ExecutorRecord | undefined,
  b: ExecutorRecord | undefined,
): boolean {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

/**
 * The text a hash of the tools is made of: what the agent reads of them, in a fixed order. The type name
 * is zod v3's own (the project is pinned to v3); a field without one still hashes, as `unknown`.
 */
export function toolsFingerprint(
  tools: readonly { name: string; description: string; shape: z.ZodRawShape }[],
): string {
  return stableJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      arguments: Object.entries(tool.shape)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, field]) => ({
          name,
          type: (field._def as { typeName?: string }).typeName ?? "unknown",
          optional: field.isOptional(),
          description: field.description ?? "",
        })),
    })),
  );
}

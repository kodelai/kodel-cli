import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PipelineSpec, parsePipeline, type Registry } from "@kodel-ai/pipeline-core";
import type { PipelineRef } from "./types";

/** The repository root, so scenarios can name `examples/pipelines/feature.yaml`. */
export function repoRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

/**
 * Load and validate the pipeline a scenario runs on. Throws a `KodelError` if it is invalid. `registry`:
 * the kinds of the engine under test, when it has more than the built-in ones.
 */
export function loadPipeline(
  ref: PipelineRef,
  root: string = repoRoot(),
  registry?: Registry,
): PipelineSpec {
  const text = "inline" in ref ? ref.inline : readFileSync(join(root, ref.file), "utf8");
  return parsePipeline(text, registry === undefined ? {} : { registry });
}

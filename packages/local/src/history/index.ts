/** History collectors: the files of coding agents, read into the universal history event. */
import { HistoryCollectorRegistry } from "@kodel-ai/pipeline-core";
import { type ClaudeCodeCollectorOptions, claudeCodeCollector } from "./claude-code/collector";

export * from "./claude-code/collector";
export * from "./claude-code/locate";
export * from "./claude-code/normalize";
export * from "./claude-code/window";
export * from "./jsonl";
export * from "./scope";

export function defaultHistoryRegistry(
  options: { claudeCode?: ClaudeCodeCollectorOptions } = {},
): HistoryCollectorRegistry {
  return new HistoryCollectorRegistry().register(claudeCodeCollector(options.claudeCode));
}

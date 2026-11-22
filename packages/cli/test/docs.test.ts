/**
 * The docs agree with the code (T-45): what AGENTS.md tells an agent not to run is the registry of the
 * person's commands, no more and no less.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_READ_COMMANDS } from "../src/agent-commands";
import { HUMAN_ONLY_COMMANDS } from "../src/human-only";

const agentsMd = readFileSync(join(import.meta.dir, "../../../AGENTS.md"), "utf8");

/** The commands a list in backticks names: `pipeline changes apply|discard` is two of them. */
const commandsOf = (text: string): string[] =>
  [...text.matchAll(/`([a-z][a-z |-]*)`/g)].flatMap((match) => {
    const words = (match[1] ?? "").split(" ");
    const last = words.pop() ?? "";
    return last.split("|").map((verb) => [...words, verb].join(" "));
  });

describe("t45 the docs and the registry of the person's commands", () => {
  test("t45_agents_md_lists_the_registrys_human_only_commands", () => {
    // The rule an agent reads: from "Do not run" to the colon that ends the list.
    const rule = /^- Do not run ([\s\S]*?): they\s+refuse/m.exec(agentsMd)?.[1] ?? "";
    expect(commandsOf(rule).sort()).toEqual([...HUMAN_ONLY_COMMANDS].sort());
    // The layout section names the same set.
    const layout = /including human-only commands \(([^)]*)\)/.exec(agentsMd)?.[1] ?? "";
    expect(commandsOf(layout).sort()).toEqual([...HUMAN_ONLY_COMMANDS].sort());
    // What only reads is said to be the agent's, by name, and is in neither list.
    const whole = /^- Do not run [\s\S]*?(?=^- )/m.exec(agentsMd)?.[0] ?? "";
    for (const command of AGENT_READ_COMMANDS) {
      expect(whole).toContain(`\`${command}\``);
      expect(HUMAN_ONLY_COMMANDS).not.toContain(command);
      expect(commandsOf(rule)).not.toContain(command);
    }
    expect(whole).toMatch(/only read and are yours/);
  });
});

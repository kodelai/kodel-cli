/**
 * What can be said about a proposed pipeline from its text alone, so every host applies the same rules
 * to a pipeline the agent proposes outside a run (a new one, or a change of one that exists).
 */
import type { PipelineSpec } from "./pipeline";

/** Proposals waiting at once; a flood of them is a person's chore. */
export const MAX_PIPELINE_PROPOSALS = 10;

/** The largest pipeline an agent may propose. */
export const MAX_PIPELINE_PROPOSAL_BYTES = 256 * 1024;

/** A pipeline's name is also its file's name. */
const FILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function proposalNameProblem(name: string): string | undefined {
  return FILE_NAME.test(name)
    ? undefined
    : `the name "${name.slice(0, 80)}" cannot be a file name: use lowercase letters, digits and dashes, up to 63`;
}

/**
 * Characters that move the cursor, fake a line or reorder text. A person is shown the text they accept,
 * so it may hold none (a newline and a tab are fine): what they read has to be what is written.
 */
const HIDDEN: [from: number, to: number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad], // soft hyphen
  [0x34f, 0x34f], // combining grapheme joiner
  [0x61c, 0x61c],
  [0x115f, 0x1160], // Hangul fillers
  [0x180e, 0x180e],
  [0x200b, 0x200f], // zero-width characters and the direction marks
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2069], // word joiner, invisible operators, isolates
  [0x2800, 0x2800], // blank braille
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // more variation selectors
];

export function hiddenCharacterProblem(text: string): string | undefined {
  let line = 1;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) line += 1;
    if (HIDDEN.some(([from, to]) => code >= from && code <= to)) {
      return `line ${line} has a character that is not shown to a person (U+${code.toString(16).toUpperCase().padStart(4, "0")}); leave it out`;
    }
  }
  return undefined;
}

export interface PipelineCommand {
  /** Where it is: the step, and the check if it is one. */
  where: string;
  command: string;
}

/**
 * Every shell command the pipeline would run, in the order of its steps. A parameter named `command` is
 * what makes one (the engine does not look at kinds), in a step or in one of its checks.
 */
export function commandsOf(spec: PipelineSpec): PipelineCommand[] {
  const found: PipelineCommand[] = [];
  for (const node of spec.nodes) {
    // The runner turns the value into text, so whatever is there is listed as that text.
    if (node.params.command !== undefined) {
      found.push({ where: `step "${node.slug}"`, command: String(node.params.command) });
    }
    for (const check of node.checks) {
      if (check.params.command !== undefined) {
        found.push({
          where: `step "${node.slug}", ${check.kind} check`,
          command: String(check.params.command),
        });
      }
    }
  }
  return found;
}

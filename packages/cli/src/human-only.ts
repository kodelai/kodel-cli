/**
 * The commands that are a person's (Principle 6): each refuses under `KODEL_ENGINE`, inside a kodel agent
 * session and without a terminal (`requireHuman` in `cli.ts`). One list, so that what the CLI guards, what
 * a worker's deny list refuses and what AGENTS.md tells an agent not to run are checked against each other
 * by the tests. `tui` asks for a person in the same way, but it is a screen, not a decision: a worker is
 * not refused the word, and it cannot be opened without a terminal.
 */
import { AGENT_HUMAN_COMMANDS } from "./agent-commands";

export const HUMAN_ONLY_COMMANDS: readonly string[] = [
  "gate",
  "resume",
  "migrate",
  "ack",
  "seal",
  "pipeline changes apply",
  "pipeline changes discard",
  "pipeline changes restore",
  "pipeline proposals apply",
  "pipeline proposals discard",
  "task approve",
  ...AGENT_HUMAN_COMMANDS,
];

/** What a person's command says when it is run inside an agent's session. */
export const INSIDE_SESSION_REFUSAL =
  "this command is for a person; it will not run inside a kodel agent session";

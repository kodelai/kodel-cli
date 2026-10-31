/**
 * Claude Code logs as fixtures: sessions shaped after real ones (version 2.1.306), with the text of the
 * conversation replaced. `__CWD__` in a fixture stands for the working directory of the session and is set
 * when the fixture is installed, so a test puts the session into whatever project it builds.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/history/claude-code/v2.1.306/", import.meta.url),
);
export const CLAUDE_FIXTURE_SESSION = "11111111-1111-4111-8111-111111111111";

export const claudeFolderName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export interface InstallOptions {
  /** `<configDir>/projects/<folder>/` is where the log goes. */
  configDir: string;
  /** The working directory of the session. */
  cwd: string;
  sessionId?: string;
  /** Replaces the folder name Claude Code would use (a long name with a hash, say). */
  folder?: string;
  /** Replaces the `version` of every entry. */
  version?: string;
  /** Left out: no subagent files. */
  subagents?: boolean;
}

/** Puts the fixture session (and its subagent logs) into a Claude Code store. Returns the path of the log. */
export async function installClaudeSession(options: InstallOptions): Promise<string> {
  const sessionId = options.sessionId ?? CLAUDE_FIXTURE_SESSION;
  const folder = join(
    options.configDir,
    "projects",
    options.folder ?? claudeFolderName(options.cwd),
  );
  const rewrite = (text: string): string => {
    let out = text
      .replaceAll("__CWD__", JSON.stringify(options.cwd).slice(1, -1))
      .replaceAll(CLAUDE_FIXTURE_SESSION, sessionId);
    if (options.version !== undefined)
      out = out.replaceAll('"version":"2.1.306"', `"version":"${options.version}"`);
    return out;
  };
  await mkdir(folder, { recursive: true });
  const log = join(folder, `${sessionId}.jsonl`);
  await writeFile(log, rewrite(await readFile(join(CLAUDE_FIXTURE, "session.jsonl"), "utf8")));
  if (options.subagents !== false) {
    const dir = join(folder, sessionId, "subagents");
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(join(CLAUDE_FIXTURE, "subagents"))) {
      const text = await readFile(join(CLAUDE_FIXTURE, "subagents", name), "utf8");
      await writeFile(join(dir, name), rewrite(text));
    }
  }
  return log;
}

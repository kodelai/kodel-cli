import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENABLED, MAIN_TS, MODEL, TURN_TIMEOUT_MS } from "./harness";

/**
 * The hooks on the real agents. `kodel init` registers them in a throwaway project; a headless
 * session of each agent then has to put itself into `.kodel/sessions.jsonl`, and the same session
 * in a directory that is not a Kodel project has to leave nothing behind. The assertions are on files,
 * never on what the agent said. They use the agents the machine is logged in to, so they only run
 * with KODEL_AGENT_TESTS=1 (`bun run test:agents`).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scenario = ENABLED ? test : test.skip;
const PROMPT = "Reply with the single word ok. Do not use any tool.";

type AgentName = "claude-code" | "codex" | "opencode";

/** How each agent is started headless in a directory. */
const START: Record<AgentName, { binary: string; args: string[] }> = {
  "claude-code": { binary: "claude", args: ["-p", PROMPT, "--model", MODEL] },
  codex: {
    binary: "codex",
    // Project hooks need a trusted layer and a reviewed hook; trust is a person's, so the test bypasses it for this run.
    args: [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--dangerously-bypass-hook-trust",
      PROMPT,
    ],
  },
  opencode: { binary: "opencode", args: ["run", PROMPT] },
};

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kodel-hooks-${label}-`)));
  dirs.push(dir);
  return dir;
}

/** The hooks as `init` writes them, with the server started from source like this repository does. */
function init(dir: string, agent: AgentName) {
  execFileSync(
    process.execPath,
    [
      MAIN_TS,
      "init",
      "--agent",
      agent,
      "--yes",
      "--storage",
      "project",
      "--server-command",
      `bun ${MAIN_TS}`,
    ],
    { cwd: dir, stdio: "pipe" },
  );
}

function session(dir: string, agent: AgentName) {
  const { binary, args } = START[agent];
  const result = spawnSync(binary, args, {
    cwd: dir,
    // A shell sets PWD when it changes directory, and OpenCode finds its project by it; `cwd` alone does not.
    env: { ...process.env, PWD: dir },
    encoding: "utf8",
    timeout: TURN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The agent must finish normally: the hook may not make it fail. The exception is the agent's own usage
 * limit (a free model, say): it fails before it answers whatever the hook does, so only that is said and
 * the file assertions, which do not depend on an answer, still run.
 */
function expectExit0(
  agent: string,
  result: { status: number | null; stdout: string; stderr: string },
) {
  if (result.status === 0) return;
  if (/usage limit|rate limit|quota/i.test(result.stderr)) {
    console.warn(
      `${agent}: the exit status was not checked, the agent hit its own limit: ${result.stderr.trim()}`,
    );
    return;
  }
  throw new Error(
    `the agent exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

const records = (dir: string) => {
  const file = join(dir, ".kodel", "sessions.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
};

describe("hooks on the real agents", () => {
  for (const agent of ["claude-code", "codex", "opencode"] as const) {
    scenario(
      `${agent}_a_session_in_a_project_is_in_the_index`,
      () => {
        const dir = tempDir(agent);
        init(dir, agent);
        const result = session(dir, agent);
        expectExit0(agent, result);
        const found = records(dir).filter((r) => r.agent === agent);
        if (found.length === 0) {
          throw new Error(
            `no session in the index of ${dir}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
          );
        }
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(found[0]?.cwd).toBe(dir);
        expect(found[0]?.session_id).toMatch(/\S/);
        expect(found[0]?.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
      },
      TURN_TIMEOUT_MS + 30_000,
    );

    scenario(
      `${agent}_a_session_outside_a_project_writes_nothing_and_the_agent_is_unaffected`,
      () => {
        const dir = tempDir(`${agent}-out`);
        init(dir, agent);
        // The hook files stay, the marker goes: this is a directory that is not a Kodel project.
        rmSync(join(dir, ".kodel"), { recursive: true, force: true });
        writeFileSync(join(dir, "note.txt"), "x");
        const result = session(dir, agent);
        expectExit0(agent, result);
        expect(existsSync(join(dir, ".kodel"))).toBe(false);
      },
      TURN_TIMEOUT_MS + 30_000,
    );
  }
});

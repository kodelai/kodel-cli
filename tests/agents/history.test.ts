import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeCollector,
  claudeConfigDir,
  projectFolderName,
} from "../../packages/local/src/history";
import {
  type HistoryEvent,
  historyEventSchema,
  newReadStats,
  selectProfile,
} from "../../packages/pipeline-core/src";
import { ENABLED, MODEL, TURN_TIMEOUT_MS } from "./harness";

/**
 * The Claude Code history collector on the real agent: one headless turn in a throwaway Kodel project, then
 * the collector reads the log the agent itself wrote. The assertions are on the events and on the agent's own
 * figures (`--output-format json`), never on what the agent said. They use the agent the machine is logged in
 * to, so they only run with KODEL_AGENT_TESTS=1 (`bun run test:agents`).
 *
 * The second test is the canary of the format: the installed version has to be one a profile lists. When a
 * new version leaves the known range this fails on purpose, saying what to add.
 */
const PROMPT =
  "Run the shell command `echo kodel-history` with the Bash tool, then reply with the single word done.";
/** What the log may differ from the agent's own total by: requests that never reach the transcript (titles, summaries). */
const TOLERANCE = 0.1;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scenario = ENABLED ? test : test.skip;

function run(binary: string, args: string[], cwd: string) {
  return spawnSync(binary, args, {
    cwd,
    env: { ...process.env, PWD: cwd },
    encoding: "utf8",
    timeout: TURN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function installedVersion(): string {
  const out = run("claude", ["--version"], tmpdir()).stdout;
  const match = /(\d+\.\d+\.\d+\S*)/.exec(out);
  if (!match?.[1]) throw new Error(`cannot read the version of claude from "${out.trim()}"`);
  return match[1];
}

describe("vh9g history collector on the real Claude Code", () => {
  scenario(
    "vh9g_a_real_session_becomes_valid_events_and_the_totals_agree_with_the_agent",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "kodel-history-real-")));
      dirs.push(root);
      mkdirSync(join(root, ".kodel"));
      writeFileSync(join(root, ".kodel", "config.yaml"), "version: 1\n");
      const folder = join(claudeConfigDir(), "projects", projectFolderName(root));
      dirs.push(folder);

      const turn = run(
        "claude",
        [
          "-p",
          PROMPT,
          "--model",
          MODEL,
          "--output-format",
          "json",
          "--allowedTools",
          "Bash(echo:*)",
        ],
        root,
      );
      expect(turn.status, turn.stderr).toBe(0);
      const result = JSON.parse(turn.stdout) as {
        session_id: string;
        usage: {
          output_tokens: number;
          cache_read_input_tokens: number;
          cache_creation_input_tokens: number;
        };
      };

      return (async () => {
        const collector = claudeCodeCollector();
        const ref = (await collector.locate(root)).find((r) => r.session_id === result.session_id);
        expect(ref, "the session of the turn was not found by locate").toBeDefined();
        if (!ref) return;
        const stats = newReadStats();
        const events: HistoryEvent[] = [];
        for await (const e of collector.read(ref, undefined, { stats })) events.push(e);
        for (const e of events) expect(historyEventSchema.safeParse(e).success).toBe(true);

        const call = events.find((e) => e.kind === "tool_call" && e.name === "Bash");
        expect(call, "no Bash call in the log").toBeDefined();
        const paired = events.find(
          (e) => e.kind === "tool_result" && call?.kind === "tool_call" && e.id === call.id,
        );
        expect(paired).toMatchObject({ ok: true });

        const total = { output: 0, cache_read: 0, cache_write: 0 };
        for (const e of events) {
          if (e.kind !== "usage") continue;
          total.output += e.output;
          total.cache_read += e.cache_read;
          total.cache_write += e.cache_write;
        }
        const near = (ours: number, own: number) =>
          Math.abs(ours - own) <= Math.max(5, own * TOLERANCE);
        const figures = JSON.stringify({ ours: total, own: result.usage });
        expect(near(total.output, result.usage.output_tokens), figures).toBe(true);
        expect(near(total.cache_read, result.usage.cache_read_input_tokens), figures).toBe(true);
        expect(near(total.cache_write, result.usage.cache_creation_input_tokens), figures).toBe(
          true,
        );
        expect(stats.drift).toEqual([]);
      })();
    },
    300_000,
  );

  scenario("vh9g_canary_the_installed_claude_code_is_a_version_a_profile_knows", () => {
    const version = installedVersion();
    const { profile, match } = selectProfile(claudeCodeCollector().profiles, version);
    expect(
      match,
      `Claude Code ${version} is outside the known profiles (nearest: ${profile.id}, ${profile.versions}): ` +
        "read a session of it, add a profile and a fixture under fixtures/history/claude-code/, then widen the range",
    ).toBe("exact");
  });
});

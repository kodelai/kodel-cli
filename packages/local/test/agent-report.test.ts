import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFolderName, installClaudeSession } from "../../testkit/src/history-fixtures";
import { agentUsage, lastAgentReport } from "../src/history";

let base: string;
let root: string;
let workdir: string;
let configDir: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-report-")));
  root = join(base, "project");
  workdir = join(root, ".kodel", "worktrees", "r_1");
  configDir = join(base, "claude");
  await mkdir(workdir, { recursive: true });
  await writeFile(join(root, ".kodel", "config.yaml"), "version: 1\n");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const at = (iso: string) => Date.parse(iso);

/** Lines of a Claude Code log, as the agent writes them. */
const entry = (type: string, ts: string, message: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    cwd: workdir,
    timestamp: ts,
    uuid: `${type}-${ts}-${Math.random()}`,
    message,
    ...extra,
  });

const text = (id: string, words: string) => ({ id, content: [{ type: "text", text: words }] });

async function install(lines: string[], cwd = workdir, name = "s1") {
  const folder = join(configDir, "projects", claudeFolderName(cwd));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.jsonl`), `${lines.join("\n")}\n`);
}

describe("the agent's last report", () => {
  test("it is the last response with words in it, whole, with its text blocks joined", async () => {
    await install([
      entry("user", "2026-10-27T10:00:00.000Z", { content: "go" }),
      entry("assistant", "2026-10-27T10:01:00.000Z", text("m1", "Working on it.")),
      entry("assistant", "2026-10-27T10:02:00.000Z", {
        id: "m2",
        content: [{ type: "tool_use", name: "Bash", id: "t1" }],
      }),
      entry("assistant", "2026-10-27T10:30:00.000Z", text("m3", "First part.")),
      entry("assistant", "2026-10-27T10:30:01.000Z", text("m3", "Second part.")),
    ]);
    const found = await lastAgentReport({
      root,
      workdir,
      configDir,
      since: at("2026-10-27T10:00:00.000Z"),
    });
    expect(found?.text).toBe("First part.\n\nSecond part.");
    expect(found?.ts).toBe(at("2026-10-27T10:30:01.000Z"));
  });

  test("a report longer than the preview of the history events is not cut", async () => {
    const long = "word ".repeat(2000).trim();
    await install([entry("assistant", "2026-10-27T10:30:00.000Z", text("m1", long))]);
    const found = await lastAgentReport({ root, workdir, configDir, since: 0 });
    expect(found?.text).toHaveLength(long.length);
  });

  test("words written before the run reached the gate are not its report", async () => {
    await install([entry("assistant", "2026-10-27T10:00:00.000Z", text("m1", "Old news."))]);
    const found = await lastAgentReport({
      root,
      workdir,
      configDir,
      since: at("2026-10-27T11:00:00.000Z"),
    });
    expect(found).toBeUndefined();
  });

  test("a session of another directory, a subagent's lines and a project without a marker are not read", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await install(
      [entry("assistant", "2026-10-27T10:30:00.000Z", text("m1", "Not mine."), { cwd: elsewhere })],
      elsewhere,
      "other",
    );
    await install([
      entry("assistant", "2026-10-27T10:30:00.000Z", text("m2", "Mine."), { isSidechain: false }),
      entry("assistant", "2026-10-27T10:40:00.000Z", text("m3", "A subagent talking."), {
        isSidechain: true,
      }),
    ]);
    const found = await lastAgentReport({ root, workdir, configDir, since: 0 });
    expect(found?.text).toBe("Mine.");

    await rm(join(root, ".kodel", "config.yaml"));
    expect(await lastAgentReport({ root, workdir, configDir, since: 0 })).toBeUndefined();
  });

  test("secrets the rules know are taken out", async () => {
    await install([
      entry("assistant", "2026-10-27T10:30:00.000Z", text("m1", "The key is sekret-123.")),
    ]);
    const found = await lastAgentReport({
      root,
      workdir,
      configDir,
      since: 0,
      rules: [{ name: "test", pattern: /sekret-\d+/g, replace: () => "[hidden]" }],
    });
    expect(found?.text).toBe("The key is [hidden].");
  });

  test("a project with no agent logs has no report, and that is not an error", async () => {
    expect(await lastAgentReport({ root, workdir, configDir, since: 0 })).toBeUndefined();
  });
});

describe("the tokens of a run", () => {
  test("they are summed from the usage the logs report, within the time of the run", async () => {
    await installClaudeSession({ configDir, cwd: workdir });
    const used = await agentUsage({ root, workdir, configDir, from: 0, to: Date.now() });
    expect(used?.tokens).toBeGreaterThan(0);
    expect(used?.approx).toBe(false);
    const none = await agentUsage({ root, workdir, configDir, from: 0, to: 1 });
    expect(none?.tokens).toBe(0);
  });

  test("a run that works in the project's own directory is marked as approximate", async () => {
    await installClaudeSession({ configDir, cwd: root });
    const used = await agentUsage({ root, workdir: root, configDir, from: 0, to: Date.now() });
    expect(used?.approx).toBe(true);
  });

  test("no session, no numbers", async () => {
    expect(await agentUsage({ root, workdir, configDir, from: 0, to: Date.now() })).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeFolderName, installClaudeSession } from "../../testkit/src/history-fixtures";
import { agentLog, lastAgentReport } from "../src/history";

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

describe("the sessions the engine names", () => {
  const said = (id: string, words: string) =>
    entry("assistant", "2026-10-27T10:30:00.000Z", text(id, words), { cwd: root });

  test("a session that began in the project's own directory is the run's when the engine names it", async () => {
    await install([said("m1", "From the session at the root.")], root, "main");
    // by the directory the run works in, this session is not its own
    expect(await lastAgentReport({ root, workdir, configDir, since: 0 })).toBeUndefined();
    const found = await lastAgentReport({
      root,
      workdir,
      configDir,
      since: 0,
      sessionIds: ["main"],
    });
    expect(found?.text).toBe("From the session at the root.");
  });

  test("only the sessions it names are read", async () => {
    await install([said("m1", "Mine.")], root, "mine");
    await install([said("m2", "Somebody else's.")], root, "other");
    const found = await lastAgentReport({
      root,
      workdir,
      configDir,
      since: 0,
      sessionIds: ["mine"],
    });
    expect(found?.text).toBe("Mine.");
    const log = await agentLog({
      root,
      workdir,
      configDir,
      from: 0,
      to: Date.now(),
      sessionIds: ["mine"],
    });
    expect(log?.map((e) => e.text)).toEqual(["Mine."]);
  });

  test("a name that matches no session gives nothing, not the sessions of the directory", async () => {
    await install([said("m1", "In the directory.")]);
    expect(
      await lastAgentReport({ root, workdir, configDir, since: 0, sessionIds: ["gone"] }),
    ).toBeUndefined();
  });

  test("what the log shows has the secrets the rules know taken out", async () => {
    await install([said("m1", "The key is sekret-123.")], root, "main");
    const log = await agentLog({
      root,
      workdir,
      configDir,
      from: 0,
      to: Date.now(),
      sessionIds: ["main"],
      rules: [{ name: "test", pattern: /sekret-\d+/g, replace: () => "[hidden]" }],
    });
    expect(log?.map((e) => e.text).join(" ")).toContain("[hidden]");
    expect(log?.map((e) => e.text).join(" ")).not.toContain("sekret-123");
  });
});

describe("the agent's log", () => {
  test("what it said and the tools it called, in the order it happened, each result joined to its call", async () => {
    await installClaudeSession({ configDir, cwd: workdir });
    const log = await agentLog({ root, workdir, configDir, from: 0, to: Date.now() });
    expect(log?.length).toBeGreaterThan(0);
    const entries = log ?? [];
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("text")).toBe(true);
    expect(kinds.has("call")).toBe(true);
    expect(entries.map((e) => e.ts)).toEqual([...entries.map((e) => e.ts)].sort((a, b) => a - b));
    const answered = entries.filter((e) => e.kind === "call" && e.result !== undefined);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.every((e) => e.tool !== undefined && e.tool !== "")).toBe(true);
  });

  test("a run asks only for its own time, and for the last entries if there are too many", async () => {
    await installClaudeSession({ configDir, cwd: workdir });
    const all = (await agentLog({ root, workdir, configDir, from: 0, to: Date.now() })) ?? [];
    const last =
      (await agentLog({ root, workdir, configDir, from: 0, to: Date.now(), limit: 3 })) ?? [];
    expect(last).toEqual(all.slice(-3));
    expect(await agentLog({ root, workdir, configDir, from: 0, to: 1 })).toEqual([]);
  });

  test("no session, no log", async () => {
    expect(await agentLog({ root, workdir, configDir, from: 0, to: Date.now() })).toBeUndefined();
  });
});

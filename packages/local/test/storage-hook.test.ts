import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeSession } from "../../testkit/src/history-fixtures";
import { observeExecutor } from "../src";
import { locateClaudeSessions } from "../src/history";
import { HOOK_LOG, runHook, SESSIONS_INDEX } from "../src/hooks";

const ID = "demo-aaaa1111";
const NOW = new Date("2026-10-24T12:00:00.000Z");

let tmp: string;
let root: string;
let base: string;
let saved: string | undefined;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "kodel-storage-hook-")));
  root = join(tmp, "project");
  base = join(tmp, "base");
  await mkdir(join(root, ".kodel"), { recursive: true });
  await mkdir(base);
  saved = process.env.KODEL_STATE_DIR;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.KODEL_STATE_DIR;
  else process.env.KODEL_STATE_DIR = saved;
  await rm(tmp, { recursive: true, force: true });
});

const config = (text: string) => writeFile(join(root, ".kodel", "config.yaml"), text);

const start = (cwd: string, over: Record<string, unknown> = {}) => ({
  text: JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "s-1",
    transcript_path: "/t/s-1.jsonl",
    cwd,
    ...over,
  }),
  tooLarge: false,
});

const read = (path: string) => readFile(path, "utf8").catch(() => "");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const sessionIds = async (path: string) =>
  (await read(path))
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { session_id: string }).session_id);

describe("the hook and the place of the index", () => {
  test("storage_hook_follows_config", async () => {
    process.env.KODEL_STATE_DIR = base;
    const home = join(base, "projects", ID, "sessions.jsonl");
    const inProject = join(root, ".kodel", "sessions.jsonl");

    await config(`storage: home\nproject_id: ${ID}\n`);
    expect(await runHook("claude-code", start(root), { now: NOW })).toBe("");
    expect(await sessionIds(home)).toEqual(["s-1"]);
    expect(await exists(inProject)).toBe(false);
    expect(JSON.parse((await read(home)).trim())).toMatchObject({
      agent: "claude-code",
      cwd: root,
    });

    // No key: the project's own index, as before.
    await rm(join(base, "projects"), { recursive: true });
    await config("version: 1\n");
    await runHook("claude-code", start(root, { session_id: "s-2" }), { now: NOW });
    expect(await sessionIds(join(root, SESSIONS_INDEX))).toEqual(["s-2"]);
    expect(await exists(join(base, "projects"))).toBe(false);

    // `storage: project` is the same.
    await config("storage: project\n");
    await runHook("claude-code", start(root, { session_id: "s-3" }), { now: NOW });
    expect(await sessionIds(join(root, SESSIONS_INDEX))).toEqual(["s-2", "s-3"]);
  });

  test("storage_hook_logs_failed_write", async () => {
    // The base lies under a regular file, so the folders cannot be made.
    const file = join(tmp, "plain-file");
    await writeFile(file, "x");
    process.env.KODEL_STATE_DIR = join(file, "state");
    await config(`storage: home\nproject_id: ${ID}\n`);
    expect(await runHook("claude-code", start(root), { now: NOW })).toBe("");
    expect(await exists(join(root, ".kodel", "sessions.jsonl"))).toBe(false);
    const log = await read(join(root, HOOK_LOG));
    expect(log).toContain("session-registrar");
    expect(log.trim().split("\n")).toHaveLength(1);
  });

  test("storage_hook_logs_failed_write: home without a project_id", async () => {
    process.env.KODEL_STATE_DIR = base;
    await config("storage: home\n");
    await runHook("claude-code", start(root), { now: NOW });
    expect(await exists(join(root, ".kodel", "sessions.jsonl"))).toBe(false);
    expect(await read(join(root, HOOK_LOG))).toContain("project_id");
  });

  test("storage_hook_config_unreadable_is_logged", async () => {
    process.env.KODEL_STATE_DIR = base;
    await config("storage: cloud\n");
    expect(await runHook("claude-code", start(root), { now: NOW })).toBe("");
    expect(await exists(join(root, ".kodel", "sessions.jsonl"))).toBe(false);
    expect(await exists(join(base, "projects"))).toBe(false);
    expect(await read(join(root, HOOK_LOG))).toContain("storage");
  });
});

describe("the shared index", () => {
  let claude: string;
  let other: string; // another clone of the project
  const SESSION_MINE = "aaaaaaaa-0000-4000-8000-000000000001";
  const SESSION_THEIRS = "bbbbbbbb-0000-4000-8000-000000000002";
  const line = (session_id: string, cwd: string, transcript_path: string) =>
    `${JSON.stringify({ session_id, agent: "claude-code", cwd, transcript_path, ts: NOW.toISOString() })}\n`;

  beforeEach(async () => {
    claude = join(tmp, "claude");
    other = join(tmp, "other-clone");
    await mkdir(claude);
    await mkdir(join(other, ".kodel"), { recursive: true });
    process.env.KODEL_STATE_DIR = base;
    await config(`storage: home\nproject_id: ${ID}\n`);
  });

  const indexFile = () => join(base, "projects", ID, "sessions.jsonl");

  test("storage_index_ignores_foreign_cwd", async () => {
    const mine = await installClaudeSession({
      configDir: claude,
      cwd: root,
      sessionId: SESSION_MINE,
      subagents: false,
    });
    const theirs = await installClaudeSession({
      configDir: claude,
      cwd: other,
      sessionId: SESSION_THEIRS,
      subagents: false,
    });
    await mkdir(join(base, "projects", ID), { recursive: true });
    await writeFile(
      indexFile(),
      line(SESSION_MINE, root, mine) + line(SESSION_THEIRS, other, theirs),
    );
    const refs = await locateClaudeSessions(root, join(claude, "projects"));
    expect(refs.map((r) => r.session_id)).toEqual([SESSION_MINE]);

    // Only another clone's lines: they name nothing here and do not stop the scan, which finds
    // this checkout's log by its own cwd.
    await writeFile(indexFile(), line(SESSION_THEIRS, other, theirs));
    expect(
      (await locateClaudeSessions(root, join(claude, "projects"))).map((r) => r.session_id),
    ).toEqual([SESSION_MINE]);
  });

  test("storage_index_scan_back", async () => {
    const dirs = [root];
    const indexPath = join(tmp, "shared-sessions.jsonl");
    const foreign = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        line(`foreign-${i}`, other, "/t/foreign.jsonl").replace(
          '"ts"',
          `"pad":"${"x".repeat(200)}","ts"`,
        ),
      ).join("");
    const ask = () =>
      observeExecutor(undefined, { root, indexPath, dirs, env: { CLAUDE_CONFIG_DIR: claude } });

    // This clone's line, then more than 64 KB of other clones' lines: found by reading further back.
    const filler = foreign(400); // about 100 KB
    expect(Buffer.byteLength(filler)).toBeGreaterThan(64 * 1024);
    await writeFile(indexPath, line("mine-1", root, "/t/mine.jsonl") + filler);
    expect((await ask()).session).toEqual({ value: "mine-1", source: "observed-hook" });

    // The newest line of this clone wins over an older one.
    await writeFile(
      indexPath,
      line("mine-0", root, "/t/mine.jsonl") + line("mine-1", root, "/t/mine.jsonl") + filler,
    );
    expect((await ask()).session?.value).toBe("mine-1");

    // Beyond the bound (1 MB): nothing, and not an error.
    await writeFile(indexPath, line("mine-1", root, "/t/mine.jsonl") + foreign(6000));
    expect(Buffer.byteLength(await read(indexPath))).toBeGreaterThan(1024 * 1024);
    const none = await ask();
    expect(none).not.toHaveProperty("session");

    // No line of this clone at all, and no index at all.
    await writeFile(indexPath, filler);
    expect(await ask()).not.toHaveProperty("session");
    await rm(indexPath);
    expect(await ask()).not.toHaveProperty("session");
  });
});

describe("what the hook loads", () => {
  test("storage_hook_imports_nothing_heavy", async () => {
    const src = new URL("../src/", import.meta.url).pathname;
    const files = {
      "storage-paths.ts": () => false,
      "hooks/session-registrar.ts": (spec: string) =>
        spec === "@kodel-ai/pipeline-core/hooks" || spec === "../storage-paths",
    } as const;
    for (const [name, extra] of Object.entries(files)) {
      const text = await readFile(join(src, name), "utf8");
      const specs = [
        ...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/g),
      ].map((m) => m[1] as string);
      const sideEffect = [...text.matchAll(/(?:^|\n)\s*import\s+"([^"]+)"/g)].map(
        (m) => m[1] as string,
      );
      expect(text, name).not.toMatch(/\bimport\(|\brequire\(/);
      expect([...specs, ...sideEffect].length, name).toBeGreaterThan(0);
      for (const spec of [...specs, ...sideEffect]) {
        expect(spec.startsWith("node:") || extra(spec), `${name} imports ${spec}`).toBe(true);
        expect(spec, name).not.toMatch(/yaml|zod|store|config/);
      }
    }
  });
});

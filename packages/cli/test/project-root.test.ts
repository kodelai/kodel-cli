import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCli } from "../src/cli";

let base: string;
let main: string;
let linked: string;
let outside: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-cliroot-")));
  main = join(base, "main");
  outside = join(base, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(join(main, ".kodel"), { recursive: true });
  await mkdir(join(main, "src", "deep"), { recursive: true });
  await writeFile(join(main, "src", "deep", "a.txt"), "a");
  await writeFile(
    join(main, ".kodel", "config.yaml"),
    "tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n",
  );
  git(main, "init", "-q");
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "T");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "initial");
  linked = join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "side", linked);
  linked = await realpath(linked);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function cliIn(cwd: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: false,
    environment: {},
    confirm: async () => true,
    select: async () => [],
  });
  return { code, out, err };
}

const tasksIn = (root: string) => readdir(join(root, ".kodel", "tasks")).catch(() => []);

describe("tXJPC_cli_project_root", () => {
  test("tasks from the root, a subfolder and a worktree all go to the main checkout", async () => {
    for (const cwd of [main, join(main, "src", "deep"), linked, join(linked, "src")]) {
      const made = await cliIn(cwd, "task", "add", `from ${cwd}`);
      expect(made.code, made.err).toBe(0);
    }
    expect((await tasksIn(main)).length).toBe(4);
    expect(await tasksIn(linked)).toEqual([]);
    const listed = await cliIn(linked, "task", "list");
    expect(listed.out.match(/KDL-/g)?.length).toBe(4);
  });

  test("the stderr line appears for a worktree, not for a subfolder, and never on stdout", async () => {
    const sub = await cliIn(join(main, "src"), "status");
    expect(sub.err).toBe("");
    const root = await cliIn(main, "status");
    expect(root.err).toBe("");
    for (const cwd of [linked, join(linked, "src", "deep")]) {
      const wt = await cliIn(cwd, "status");
      expect(wt.err).toBe(`kodel: using the project at ${main}: you are in a worktree of it\n`);
      expect(wt.out).not.toContain("using the project");
      const json = await cliIn(cwd, "status", "--json");
      expect(JSON.parse(json.out)).toEqual([]);
      expect(json.err.split("\n").filter(Boolean).length).toBe(1);
    }
  });

  test("without git, a folder below the marker is used and the climb is said on stderr", async () => {
    const plain = join(base, "plain");
    await mkdir(join(plain, ".kodel"), { recursive: true });
    await writeFile(join(plain, ".kodel", "config.yaml"), "");
    await mkdir(join(plain, "a", "b"), { recursive: true });
    const result = await cliIn(join(plain, "a", "b"), "status");
    expect(result.code).toBe(0);
    expect(result.err).toBe(`kodel: using the project at ${plain}: it is above this folder\n`);
  });

  test("outside a project every command says what to do, and writes nothing", async () => {
    for (const args of [["status"], ["task", "list"], ["task", "add", "x"]]) {
      const result = await cliIn(outside, ...args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toContain("no Kodel project here");
      expect(result.err).toContain("kodel init");
      expect(result.out).toBe("");
    }
    expect(await readdir(outside)).toEqual([]);
  });

  test("kodel init makes the project it never looks for, and the other commands then find it", async () => {
    const fresh = join(outside, "fresh");
    await mkdir(join(fresh, "deep"), { recursive: true });
    expect((await cliIn(fresh, "status")).err).toContain("no Kodel project here");
    const init = await cliIn(fresh, "init", "--yes", "--agent", "claude-code", "--no-hooks");
    expect(init.code, init.err + init.out).toBe(0);
    expect(existsSync(join(fresh, ".kodel", "config.yaml"))).toBe(true);
    // From a folder below it the project is found, with the climb said on stderr.
    const below = await cliIn(join(fresh, "deep"), "status");
    expect(below.code, below.err).toBe(0);
    expect(below.err).toContain(`using the project at ${fresh}`);
    // init in a subfolder makes a project of its own there, not in the one above.
    const nested = await cliIn(
      join(fresh, "deep"),
      "init",
      "--yes",
      "--agent",
      "claude-code",
      "--no-hooks",
    );
    expect(nested.code, nested.err + nested.out).toBe(0);
    expect(existsSync(join(fresh, "deep", ".kodel", "config.yaml"))).toBe(true);
  });

  test("--root wins, also from outside any project", async () => {
    const made = await cliIn(outside, "--root", main, "task", "add", "explicit");
    expect(made.code, made.err).toBe(0);
    expect(made.err).toBe("");
    expect((await tasksIn(main)).length).toBe(1);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("tXJPC_mcp_project_root", () => {
  const connect = async (cwd: string, env: Record<string, string> = {}) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../src/main.ts"), "mcp"],
      cwd,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(transport);
    return Object.assign(client, { stderr: transport.stderr });
  };
  const answer = (result: unknown) =>
    JSON.parse(((result as { content: { text: string }[] }).content[0] as { text: string }).text);

  test("from the root, a subfolder and a worktree the tools see the same store", async () => {
    await cliIn(main, "task", "add", "one");
    for (const cwd of [main, join(main, "src"), linked, join(linked, "src", "deep")]) {
      const client = await connect(cwd);
      const listed = answer(await client.callTool({ name: "task_list", arguments: {} }));
      expect(listed.ok, cwd).toBe(true);
      expect(JSON.stringify(listed)).toContain("one");
      await client.close();
    }
  });

  test("outside a project the server starts, lists its tools, and every tool answers NO_PROJECT", async () => {
    const client = await connect(outside);
    let noted = "";
    client.stderr?.on("data", (d: Buffer) => {
      noted += d.toString();
    });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("pipeline_start");
    expect(names.some((n) => n.startsWith("task_"))).toBe(false);
    for (const call of [
      { name: "pipeline_list", arguments: {} },
      { name: "pipeline_start", arguments: { task: "x" } },
      {
        name: "pipeline_next_step",
        arguments: { run_id: "r_000000000_0000" },
      },
    ]) {
      const result = answer(await client.callTool(call));
      expect(result.ok, call.name).toBe(false);
      expect(result.code, call.name).toBe("NO_PROJECT");
      expect(result.message).toContain("kodel init");
    }
    // The note on stderr is said once at the start, not again for each call.
    expect(noted.split("no Kodel project here").length - 1).toBe(1);
    await client.close();
  });

  test("KODEL_ROOT makes a server outside a project serve that project", async () => {
    const client = await connect(outside, { KODEL_ROOT: main });
    const listed = answer(await client.callTool({ name: "pipeline_list", arguments: {} }));
    expect(listed.ok).toBe(true);
    await client.close();
  });
});

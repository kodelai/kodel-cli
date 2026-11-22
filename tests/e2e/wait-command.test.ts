/**
 * The wait command of a background agent on the built binary (T-45). The history is kept under the
 * state base (`storage: home`) and the starter has a state dir of its own (`KODEL_STATE_DIR`), which
 * the agent's shell does not have: the command the server's waiting answer spells, run as it is in the
 * agent's environment, finds the run and reports the person's decision. Like the fork test, this one
 * builds `packages/cli/dist/kodel.js` itself (CI runs `bun test` before `bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workerMcpConfig, workerWaitCommand } from "../../packages/cli/src/claude-worker";
import { runCli } from "../../packages/cli/src/cli";

const REPO = resolve(import.meta.dir, "..", "..");
const ARTIFACT = join(REPO, "packages", "cli", "dist", "kodel.js");
/** Plain Node when one is on the PATH: the artifact is shipped for Node, not only for Bun. */
const RUNTIME =
  spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0 ? "node" : process.execPath;

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write a file for {{task}}",
  "  - slug: approve",
  "    kind: human",
  "    prompt: Looks fine?",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const CONFIG = "worktree:\n  mode: off\nstorage: home\nproject_id: demo-aaaa1111\n";

interface McpClient {
  connect(transport: unknown): Promise<void>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: { text?: string }[];
  }>;
  close(): Promise<void>;
}

/** The MCP SDK as the CLI package has it (this folder has no dependencies of its own). */
async function sdk(): Promise<{
  Client: new (info: { name: string; version: string }) => McpClient;
  StdioClientTransport: new (options: Record<string, unknown>) => unknown;
}> {
  const require_ = createRequire(join(REPO, "packages", "cli", "package.json"));
  const load = (file: string) =>
    import(pathToFileURL(require_.resolve(`@modelcontextprotocol/sdk/${file}`)).href) as Promise<
      Record<string, unknown>
    >;
  const client = await load("client/index.js");
  const stdio = await load("client/stdio.js");
  return {
    Client: client.Client as never,
    StdioClientTransport: stdio.StdioClientTransport as never,
  };
}

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A person's decision, made by the command, where the starter keeps its state. */
async function decide(root: string, env: Record<string, string>, runId: string): Promise<void> {
  const before = { HOME: process.env.HOME, KODEL_STATE_DIR: process.env.KODEL_STATE_DIR };
  // The record of what this machine vouches for is found through the process's own environment.
  Object.assign(process.env, env);
  let err = "";
  try {
    const code = await runCli(["--root", root, "gate", "approve", runId], {
      cwd: root,
      out: () => {},
      err: (text) => {
        err += text;
      },
      interactive: true,
      confirm: async () => true,
      select: async () => [],
      environment: { PATH: process.env.PATH ?? "", ...env },
    });
    if (code !== 0) throw new Error(`gate approve ${runId}: ${err}`);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("t45 the wait command on the built binary", () => {
  beforeAll(() => {
    const built = spawnSync("bun", ["run", "build"], {
      cwd: REPO,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (built.status !== 0) {
      throw new Error(`the build failed: ${built.stdout}${built.stderr}`);
    }
    if (!existsSync(ARTIFACT)) throw new Error(`the build left no ${ARTIFACT}`);
  }, 120_000);

  test("t45_wait_command_finds_the_run_under_a_state_dir", async () => {
    const root = temp("kodel-e2e-wait-");
    const stateDir = temp("kodel-e2e-wait-state-");
    const home = temp("kodel-e2e-wait-home-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "initial");
    mkdirSync(join(root, ".kodel", "pipelines"), { recursive: true });
    writeFileSync(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
    writeFileSync(join(root, ".kodel", "config.yaml"), CONFIG);

    // What the launcher builds for a worker that stays alive at a wait: the command, and the server
    // that is told to spell it.
    const self = { exec: RUNTIME, args: [ARTIFACT], root, stateDir };
    const template = workerWaitCommand(self);
    const server = (
      JSON.parse(workerMcpConfig({ ...self, waitCommand: template })) as {
        mcpServers: { kodel: { command: string; args: string[]; env: Record<string, string> } };
      }
    ).mcpServers.kodel;
    const shared = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    };

    const { Client, StdioClientTransport } = await sdk();
    const client = new Client({ name: "e2e-wait", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: root,
        env: { ...shared, ...server.env },
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        (await client.callTool({ name, arguments: args })).content
          .map((c) => c.text ?? "")
          .join(""),
      ) as Record<string, unknown>;
    try {
      const started = await call("pipeline_start", { pipeline: "demo", task: "t", title: "wait" });
      const runId = String(started.run_id);
      await call("pipeline_next_step", { run_id: runId });
      await call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
      const waiting = (await call("pipeline_next_step", { run_id: runId })).waiting as {
        reason: string;
        tell_the_person: string;
      };
      expect(waiting.reason).toBe("gate");
      // The command as the agent reads it: byte for byte the one the launcher built.
      const spelled = /start `(.+?)` that way/.exec(waiting.tell_the_person)?.[1];
      expect(spelled).toBe(template.replace("{run}", runId));

      // The agent's shell: no `KODEL_STATE_DIR` (a session's environment has no `KODEL_*` but the mark).
      const agentEnv = { ...shared, KODEL_ENGINE: "1" };
      // Without the state dir the run is not there for a plain `kodel wait`: the prefix is what finds it.
      const bare = spawnSync(RUNTIME, [ARTIFACT, "--root", root, "wait", runId, "--timeout", "2"], {
        cwd: root,
        env: agentEnv,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(bare.status).not.toBe(0);
      expect(`${bare.stdout}${bare.stderr}`).not.toContain("Call pipeline_next_step");

      const watching = spawn("sh", ["-c", spelled as string], { cwd: root, env: agentEnv });
      let out = "";
      let err = "";
      watching.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      watching.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString("utf8");
      });
      const exited = new Promise<number | null>((done) => watching.on("close", done));
      try {
        // It watches: nothing is printed and it has not ended while nobody has decided.
        const early = await Promise.race([
          exited.then(() => "ended"),
          new Promise<string>((done) => setTimeout(() => done("watching"), 3_000)),
        ]);
        expect(`${early}: ${out}${err}`).toBe("watching: ");
        await decide(root, { HOME: home, KODEL_STATE_DIR: stateDir }, runId);
        const code = await Promise.race([
          exited,
          new Promise<string>((done) => setTimeout(() => done("still watching"), 20_000)),
        ]);
        expect(`${code}: ${err}`).toBe("0: ");
        expect(out.trim().split("\n")).toHaveLength(1);
        expect(out).toContain(runId);
        expect(out).toContain("Call pipeline_next_step");
        expect(out).not.toContain("still waiting");
      } finally {
        watching.kill("SIGKILL");
      }
      // and the server goes on from the decision
      const after = await call("pipeline_next_step", { run_id: runId });
      expect(after.done).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);
});

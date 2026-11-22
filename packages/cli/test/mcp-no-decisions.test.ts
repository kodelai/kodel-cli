/**
 * `kodel mcp --no-decisions` and `--no-wait-hint` (TASK-9PNS, Decision 2a): the server of a background
 * agent. A real `kodel mcp` from source, driven by the MCP client over stdio, in a temporary project
 * whose config turns the dialog and the agent's decisions on and whose `KODEL_*` environment says the
 * same: the flags win. Without the flags the server is today's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentProfile } from "../src/agent-profiles";
import { WORKER_DENIED, workerMcpConfig, workerWaitCommand } from "../src/claude-worker";
import { runCli } from "../src/cli";

const main = join(import.meta.dir, "../src/main.ts");

const DEMO = [
  "name: demo",
  "description: A small pipeline for the tests.",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write a file for {{task}}",
  "    checks:",
  '      - { kind: diff, paths: ["out.txt"] }',
  "  - slug: approve",
  "    kind: human",
  "    prompt: Looks fine?",
  "  - slug: impl",
  "    kind: agent",
  "    prompt: implement it",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: impl }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

/** The dialog and both agent decisions on: everything the flags must switch off. */
const CONFIG = [
  "worktree:",
  "  mode: off",
  "decisions:",
  "  dialog: true",
  "  agent:",
  "    gate: true",
  "    pipeline_change: true",
  "",
].join("\n");

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kodel-nodecisions-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  writeFileSync(join(dir, ".kodel", "config.yaml"), CONFIG);
  return dir;
}

interface Connected {
  client: Client;
  stderr: () => string;
  /** Every elicitation the server asked for; the client answers nothing. */
  asked: unknown[];
  close(): Promise<void>;
}

/** A client with the form capability, so a server that wanted a dialog could ask for one. */
async function connect(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  command: { exec: string; args: string[] } = {
    exec: process.execPath,
    args: [main, "--root", dir, "mcp", ...args],
  },
): Promise<Connected> {
  // A home of its own, outside the repository: the trusted hashes of the runs live under it.
  const home = mkdtempSync(join(tmpdir(), "kodel-nodecisions-home-"));
  made.push(home);
  const transport = new StdioClientTransport({
    command: command.exec,
    args: command.args,
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      // The server's git snapshots go to the temporary directory: a sandbox allows only this one.
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      KODEL_DIALOG_TIMEOUT_S: "600",
      ...env,
    },
    stderr: "pipe",
  });
  let stderr = "";
  const asked: unknown[] = [];
  const client = new Client(
    { name: "worker-test", version: "0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked.push(request.params);
    return { action: "decline" };
  });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return {
    client,
    stderr: () => stderr,
    asked,
    close: () => client.close(),
  };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

/** The tool's answer as JSON, or its text under `text` when it is not JSON (an error of the server). */
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const answer = text(await client.callTool({ name, arguments: args }));
  try {
    return JSON.parse(answer) as Record<string, unknown>;
  } catch {
    return { text: answer } as Record<string, unknown>;
  }
};

/** The server at a gate: a run started and its first step completed. */
async function atGate(dir: string, client: Client): Promise<string> {
  const started = await call(client, "pipeline_start", {
    pipeline: "demo",
    task: "write out.txt",
    title: "write-it",
  });
  const runId = String(started.run_id);
  // The step is served first: the diff check compares with the snapshot taken then.
  await call(client, "pipeline_next_step", { run_id: runId });
  writeFileSync(join(dir, "out.txt"), "hello\n");
  await call(client, "pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
  return runId;
}

const journalEvents = (dir: string, runId: string): string[] =>
  readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { event: string }).event);

describe("task_9pns kodel mcp --no-decisions --no-wait-hint", () => {
  test("task_9pns_mcp_no_decisions_serves_no_decision_tool_and_no_dialog", async () => {
    const dir = makeRepo();
    const c = await connect(dir, ["--no-decisions", "--no-wait-hint"], {
      KODEL_STATE_DIR: join(dir, "state"),
    });
    try {
      const tools = (await c.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("pipeline_next_step");
      expect(tools).not.toContain("pipeline_decide_gate");
      expect(tools).not.toContain("pipeline_accept_change");
      const instructions = c.client.getInstructions() ?? "";
      expect(instructions).not.toContain("pipeline_decide_gate");
      expect(instructions).not.toContain("pipeline_accept_change");
      expect(instructions).not.toContain("kodel wait");
      const runId = await atGate(dir, c.client);
      const waiting = await call(c.client, "pipeline_next_step", { run_id: runId });
      const words = JSON.stringify(waiting);
      expect(waiting.waiting).toBeDefined();
      expect(words).not.toContain("pipeline_decide_gate");
      expect(words).not.toContain("kodel wait");
      // The agent proposes a change of the pipeline: the same, no tool to accept it and no dialog.
      const proposed = await call(c.client, "pipeline_propose_change", {
        run_id: runId,
        yaml: DEMO.replace("prompt: implement it", "prompt: implement it well"),
        summary: "a better prompt",
      });
      expect(JSON.stringify(proposed)).not.toContain("pipeline_accept_change");
      expect(c.asked).toEqual([]);
      // Calling either fails as unknown.
      for (const name of ["pipeline_decide_gate", "pipeline_accept_change"]) {
        const refused = await c.client
          .callTool({
            name,
            arguments: { run_id: runId, node_slug: "approve", attempt: 1, decision: "approved" },
          })
          .then((r) => ({ error: r.isError === true, text: text(r) }))
          .catch((error: unknown) => ({ error: true, text: String(error) }));
        expect(refused.error).toBe(true);
      }
      const events = journalEvents(dir, runId);
      expect(events).toContain("gate_waiting");
      expect(events).not.toContain("gate_decided");
      expect(events).not.toContain("pipeline_accepted");
    } finally {
      await c.close();
    }
  }, 40_000);

  test("task_9pns_mcp_no_decisions_says_the_agent_allowance_is_off", async () => {
    const dir = makeRepo();
    const c = await connect(dir, ["--no-decisions"]);
    try {
      await c.client.listTools();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(c.stderr()).toContain("--no-decisions");
      expect(c.stderr()).toContain("decisions.agent");
    } finally {
      await c.close();
    }
  }, 40_000);

  test("task_9pns_mcp_no_wait_hint_text_ends_the_turn_and_without_the_flags_is_unchanged", async () => {
    // With `--no-wait-hint`, the waiting answer is byte for byte the one `agent_hints: {wait: false}` gives.
    const flagged = makeRepo();
    const configured = makeRepo();
    writeFileSync(
      join(configured, ".kodel", "config.yaml"),
      `${CONFIG}agent_hints:\n  wait: false\n`,
    );
    const a = await connect(flagged, ["--no-decisions", "--no-wait-hint"]);
    const b = await connect(configured, ["--no-decisions"]);
    try {
      const runA = await atGate(flagged, a.client);
      const runB = await atGate(configured, b.client);
      const textA = JSON.stringify(await call(a.client, "pipeline_next_step", { run_id: runA }));
      const textB = JSON.stringify(await call(b.client, "pipeline_next_step", { run_id: runB }));
      expect(textA).not.toContain("kodel wait");
      expect(textA.replaceAll(runA, "<run>")).toBe(textB.replaceAll(runB, "<run>"));
      expect(a.client.getInstructions()).toBe(b.client.getInstructions());
    } finally {
      await a.close();
      await b.close();
    }
    // Without the flags: the decision tools, the dialog and the offer as the config says.
    const plain = makeRepo();
    const c = await connect(plain, []);
    try {
      const tools = (await c.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("pipeline_decide_gate");
      expect(tools).toContain("pipeline_accept_change");
      expect(c.client.getInstructions() ?? "").toContain("kodel wait");
      const runId = await atGate(plain, c.client);
      const waiting = JSON.stringify(await call(c.client, "pipeline_next_step", { run_id: runId }));
      expect(waiting).toContain(`kodel wait ${runId}`);
      // The dialog was asked (and declined by this client).
      expect(c.asked.length).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  }, 60_000);

  test("task_9pns_worker_server_cannot_decide", async () => {
    // The launcher's exact `--mcp-config`: command, args and env, as the worker's `claude` would start it.
    const dir = makeRepo();
    const stateDir = join(dir, "state");
    const config = JSON.parse(
      workerMcpConfig({ exec: process.execPath, args: [main], root: dir, stateDir }),
    ) as {
      mcpServers: { kodel: { command: string; args: string[]; env: Record<string, string> } };
    };
    const { command, args, env } = config.mcpServers.kodel;
    const c = await connect(dir, [], env, { exec: command, args });
    try {
      const tools = (await c.client.listTools()).tools.map((t) => t.name);
      expect(tools).not.toContain("pipeline_decide_gate");
      expect(tools).not.toContain("pipeline_accept_change");
      const runId = await atGate(dir, c.client);
      const waiting = JSON.stringify(await call(c.client, "pipeline_next_step", { run_id: runId }));
      expect(waiting).not.toContain("kodel wait");
      expect(waiting).not.toContain("pipeline_decide_gate");
      expect(c.asked).toEqual([]);
      expect(journalEvents(dir, runId)).not.toContain("gate_decided");
    } finally {
      await c.close();
    }
  }, 40_000);
});

describe("t45 kodel mcp --wait-command", () => {
  /** A person's decision at the gate, as the command makes it, in the environment the server has. */
  async function decide(dir: string, env: Record<string, string>, ...args: string[]) {
    let err = "";
    // The record of what this machine vouches for is found through the process's own environment.
    const before = { HOME: process.env.HOME, KODEL_STATE_DIR: process.env.KODEL_STATE_DIR };
    Object.assign(process.env, env);
    try {
      const code = await runCli(["--root", dir, "gate", ...args], {
        cwd: dir,
        out: () => {},
        err: (t) => {
          err += t;
        },
        interactive: true,
        confirm: async () => true,
        select: async () => [],
        environment: { PATH: process.env.PATH ?? "", ...env },
      });
      if (code !== 0) throw new Error(`gate ${args.join(" ")}: ${err}`);
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("t45_waiting_answers_spell_the_wait_command", async () => {
    // The launcher's exact `--mcp-config` for a worker that stays alive at a wait, in a project that
    // turned the offer off for its own agents: the worker is offered its command all the same.
    const dir = makeRepo();
    writeFileSync(join(dir, ".kodel", "config.yaml"), `${CONFIG}agent_hints:\n  wait: false\n`);
    const home = mkdtempSync(join(tmpdir(), "kodel-waitcmd-home-"));
    made.push(home);
    const stateDir = join(dir, "state");
    const self = { exec: process.execPath, args: [main], root: dir, stateDir };
    const template = workerWaitCommand(self);
    const config = JSON.parse(workerMcpConfig({ ...self, waitCommand: template })) as {
      mcpServers: { kodel: { command: string; args: string[]; env: Record<string, string> } };
    };
    const { command, args, env } = config.mcpServers.kodel;
    expect(args.slice(-4)).toEqual(["mcp", "--no-decisions", "--wait-command", template]);
    expect(args).not.toContain("--no-wait-hint");
    const c = await connect(dir, [], { ...env, HOME: home }, { exec: command, args });
    try {
      const instructions = c.client.getInstructions() ?? "";
      expect(instructions).toContain(`\`${template.replace("{run}", "<run_id>")}\``);
      expect(instructions).not.toContain("kodel wait");
      const runId = await atGate(dir, c.client);
      const spelled = template.replace("{run}", runId);
      const offer = `start \`${spelled}\` that way and end your turn`;
      const first = await call(c.client, "pipeline_next_step", { run_id: runId });
      const tell = (answer: Record<string, unknown>) =>
        String((answer.waiting as { tell_the_person?: string } | undefined)?.tell_the_person);
      expect(tell(first)).toContain(offer);
      expect(tell(first)).toContain("run_in_background");
      expect(JSON.stringify(first)).not.toContain("kodel wait");
      expect(JSON.stringify(first)).not.toContain("{kodel-wait-command}");
      // The person sends the step back; at the second gate the answer spells the command again.
      await decide(dir, { ...env, HOME: home }, "reject", runId, "--reason", "once more");
      await call(c.client, "pipeline_next_step", { run_id: runId });
      writeFileSync(join(dir, "out.txt"), "hello again\n");
      const done = await call(c.client, "pipeline_complete_step", {
        run_id: runId,
        node_slug: "write",
        attempt: 2,
      });
      expect(tell(done.next as Record<string, unknown>)).toContain(offer);
      const second = await call(c.client, "pipeline_next_step", { run_id: runId });
      expect(second.waiting).toMatchObject({ reason: "gate", attempt: 2 });
      expect(tell(second)).toContain(offer);
      // It decides nothing: this is still a background agent's server.
      expect(c.asked).toEqual([]);
      expect(journalEvents(dir, runId).filter((e) => e === "gate_decided")).toHaveLength(1);
    } finally {
      await c.close();
    }
  }, 60_000);

  test("t45_wait_command_flag_needs_the_run", async () => {
    const dir = makeRepo();
    let err = "";
    const code = await runCli(["--root", dir, "mcp", "--wait-command", "kodel wait"], {
      cwd: dir,
      out: () => {},
      err: (t) => {
        err += t;
      },
      interactive: false,
      confirm: async () => false,
      select: async () => [],
      environment: { PATH: process.env.PATH ?? "" },
    });
    expect(code).toBe(1);
    expect(err).toContain("--wait-command needs {run}");
  });
});

describe("t45 the server of a worker", () => {
  test("t45_worker_server_serves_no_decision_tool", async () => {
    // The claude profile's exact server arguments, for a terminal worker (with its wait command) and for
    // a print worker, in a project whose config lets an agent decide: the server refuses both tools.
    const profile = agentProfile("claude");
    if (!profile) throw new Error("no claude profile");
    for (const terminal of [true, false]) {
      const dir = makeRepo();
      const self = {
        exec: process.execPath,
        args: [main],
        root: dir,
        stateDir: join(dir, "state"),
      };
      const config = JSON.parse(
        profile.mcpConfig(terminal ? { ...self, waitCommand: profile.waitCommand(self) } : self),
      ) as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      };
      // One server, ours, with the flag that takes the decisions away.
      expect(Object.keys(config.mcpServers)).toEqual(["kodel"]);
      const server = config.mcpServers.kodel;
      if (!server) throw new Error("no kodel server in the config");
      expect(server.args).toContain("--no-decisions");
      const c = await connect(dir, [], server.env, { exec: server.command, args: server.args });
      try {
        const tools = (await c.client.listTools()).tools.map((t) => t.name);
        const decisions = WORKER_DENIED.map((tool) => tool.replace("mcp__kodel__", ""));
        expect(decisions.sort()).toEqual(["pipeline_accept_change", "pipeline_decide_gate"]);
        for (const tool of decisions) expect(tools, tool).not.toContain(tool);
        const runId = await atGate(dir, c.client);
        // Called all the same (a client that ignores the list): refused, and the gate stays undecided.
        for (const tool of decisions) {
          const answer = await c.client
            .callTool({
              name: tool,
              arguments: { run_id: runId, decision: "approved", node_slug: "approve" },
            })
            .then(
              (result) => ({ isError: result.isError === true, text: text(result) }),
              (error: unknown) => ({ isError: true, text: String(error) }),
            );
          expect(answer.isError, `${tool}: ${answer.text}`).toBe(true);
        }
        expect(journalEvents(dir, runId)).not.toContain("gate_decided");
        const waiting = await call(c.client, "pipeline_next_step", { run_id: runId });
        expect(waiting.waiting).toBeDefined();
        expect(JSON.stringify(waiting)).not.toContain("pipeline_decide_gate");
        expect(c.asked).toEqual([]);
      } finally {
        await c.close();
      }
    }
  }, 90_000);
});

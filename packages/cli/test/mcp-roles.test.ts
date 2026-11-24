/**
 * Decision 5M9D through a real server: `kodel mcp` from source, driven by the MCP client over stdio.
 * An agent connected to it can call exactly the tools chosen by the role, the `mcp.roles` block and
 * `--read-only`, listed or not; a wrong start command and an unusable `mcp` block serve nothing; and a
 * `--read-only` server changes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_TOOL_NAMES, ROLE_TOOLS, summarizeRun } from "@kodel-ai/pipeline-core";
import { decisionOf, resumeVerdict } from "@kodel-ai/pipeline-core/serve";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sessionEnv } from "../../local/src";
import { makeStates, snapshotAll } from "../../local/test/helpers/run-states";
import { workerMcpConfig } from "../src/claude-worker";
import { formatReport } from "../src/format";
import { plain } from "../src/plain";
import { workerServedTools } from "../src/worker-factory";

// biome-ignore lint/suspicious/noExplicitAny: the answers are read as loose JSON, each test names what it checks
type Loose = any;

const main = join(import.meta.dir, "../src/main.ts");

const DEMO = [
  "name: demo",
  "nodes:",
  "  - { slug: write, kind: agent, prompt: write it }",
  "  - { slug: approve, kind: human, prompt: Looks fine? }",
  "  - { slug: ship, kind: agent, prompt: ship it }",
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: ship }",
  "  - { from: approve, to: write, when: rejected }",
  "",
].join("\n");

const DECISIONS = "decisions:\n  agent:\n    gate: true\n    pipeline_change: true\n";
const TASKS =
  "tasks:\n  enabled: true\n  on_run:\n    mode: ask\n  adapters:\n    local:\n      prefix: KDL\n";
const OFF = "worktree:\n  mode: off\n";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function makeRepo(config: string): string {
  const dir = tempDir("kodel-roles-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  mkdirSync(join(dir, ".kodel", "pipelines"), { recursive: true });
  writeFileSync(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
  writeFileSync(join(dir, ".kodel", "config.yaml"), config);
  return dir;
}

/** The environment of a server of these tests: a home of its own, and never the engine's mark of the run that runs them. */
function serverEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    KODEL_STATE_DIR: join(home, "state"),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...extra,
  };
}

interface Connected {
  client: Client;
  stderr: () => string;
  asked: unknown[];
  names: string[];
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, Loose>>;
  /** Whether a call of this name is refused as a tool the server does not have. */
  refuses(name: string): Promise<boolean>;
  close(): Promise<void>;
}

async function connect(
  dir: string,
  args: string[],
  options: { env?: Record<string, string>; home?: string; command?: string[] } = {},
): Promise<Connected> {
  const home = options.home ?? tempDir("kodel-roles-home-");
  const command = options.command ?? [main, "--root", dir, "mcp", ...args];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: command,
    cwd: dir,
    env: serverEnv(home, options.env),
    stderr: "pipe",
  });
  let stderr = "";
  const asked: unknown[] = [];
  const client = new Client(
    { name: "roles-test", version: "0" },
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
  const { tools } = await client.listTools();
  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  const raw = async (name: string, input: Record<string, unknown>) => {
    try {
      const result = await client.callTool({ name, arguments: input });
      return { text: text(result), isError: result.isError === true };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  return {
    client,
    stderr: () => stderr,
    asked,
    tools,
    names: tools.map((tool) => tool.name),
    call: async (name, input = {}) => {
      const answer = await raw(name, input);
      try {
        return JSON.parse(answer.text) as Record<string, Loose>;
      } catch {
        return { text: answer.text };
      }
    },
    refuses: async (name) => {
      const answer = await raw(name, {});
      return answer.isError && /not found|there is no tool/i.test(answer.text);
    },
    close: () => client.close(),
  };
}

/** How a start command that must not serve ends: its exit code and what it said on stderr. */
function startAndExit(dir: string, args: string[], env: Record<string, string> = {}) {
  const home = tempDir("kodel-roles-home-");
  const result = spawnSync(process.execPath, [main, "--root", dir, "mcp", ...args], {
    cwd: dir,
    env: serverEnv(home, env),
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

const NEVER = ["pipeline_approve", "manager_decide"];
const EVERY = [...KNOWN_TOOL_NAMES, ...NEVER];
const sorted = (names: readonly string[]) => [...names].sort();
const withoutTasks = (names: readonly string[]) => names.filter((n) => !n.startsWith("task_"));
/** A server outside a project has a host that keeps no attachments. */
const withoutAttachments = (names: readonly string[]) =>
  names.filter((n) => !n.startsWith("pipeline_attachment_"));
const withoutDecisions = (names: readonly string[]) =>
  names.filter((n) => n !== "pipeline_decide_gate" && n !== "pipeline_accept_change");

/** Every name outside the set is refused, whether the client listed it or not. */
async function expectOnly(server: Connected, expected: readonly string[]) {
  expect(sorted(server.names)).toEqual(sorted(expected));
  for (const name of EVERY) {
    if (expected.includes(name)) continue;
    expect(await server.refuses(name), `${name} must be refused`).toBe(true);
  }
}

const CONFIGS = [
  {
    name: "tasks and decisions.agent on",
    text: OFF + DECISIONS + TASKS,
    tasks: true,
    decides: true,
  },
  { name: "both off", text: OFF, tasks: false, decides: false },
];

describe("5m9d a server serves exactly its set", () => {
  test("5m9d_worker_cannot_call_a_tool_outside_its_set", async () => {
    for (const config of CONFIGS) {
      const dir = makeRepo(config.text);
      const expected = config.tasks ? ROLE_TOOLS.worker : withoutTasks(ROLE_TOOLS.worker);
      const worker = await connect(dir, ["--role", "worker"]);
      await expectOnly(worker, expected);
      expect(worker.stderr()).toContain("role worker");
      await worker.close();
    }
    // The background agent's own server: the same set, whatever the config lets an agent decide.
    const dir = makeRepo(OFF + DECISIONS);
    const background = await connect(dir, ["--role", "worker", "--no-decisions", "--no-wait-hint"]);
    await expectOnly(background, withoutTasks(ROLE_TOOLS.worker));
    await background.close();
  }, 120_000);

  test("5m9d_manager_cannot_call_a_tool_outside_its_set", async () => {
    for (const config of CONFIGS) {
      const dir = makeRepo(config.text);
      let expected: readonly string[] = ROLE_TOOLS.manager;
      if (!config.tasks) expected = withoutTasks(expected);
      if (!config.decides) expected = withoutDecisions(expected);
      const manager = await connect(dir, ["--role", "manager"]);
      await expectOnly(manager, expected);
      for (const name of [
        "pipeline_start",
        "pipeline_next_step",
        "pipeline_take_step",
        "pipeline_complete_step",
        "pipeline_report_result",
      ]) {
        expect(manager.names).not.toContain(name);
      }
      await manager.close();
    }
  }, 120_000);

  test("5m9d_read_only_serves_only_read_tools", async () => {
    for (const config of CONFIGS) {
      const dir = makeRepo(config.text);
      const readOnly = await connect(dir, ["--read-only"]);
      for (const tool of readOnly.tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      }
      const expected = [
        "pipeline_list",
        "pipeline_docs",
        "pipeline_resolve",
        "pipeline_plan",
        "pipeline_attachment_read",
        "pipeline_attachment_list",
        "history_runs",
        "history_run_details",
        "history_agent_log",
        "history_stats",
        "manager_inbox",
        "manager_run_report",
        "manager_gate_changes",
        "manager_serve_status",
        "manager_agents",
        "manager_agent_log",
        "manager_watch",
        ...(config.tasks ? ["task_schema", "task_list", "task_get"] : []),
      ];
      await expectOnly(readOnly, expected);
      expect(readOnly.names).not.toContain("pipeline_next_step");
      await readOnly.close();
      // On top of a role: the manager's reads.
      const manager = await connect(dir, ["--role", "manager", "--read-only"]);
      await expectOnly(
        manager,
        expected.filter((name) => name !== "pipeline_plan"),
      );
      await manager.close();
    }
  }, 120_000);

  test("5m9d_override_narrowed_server_refuses_removed_tool", async () => {
    const block = [
      "mcp:",
      "  roles:",
      "    worker:",
      "      remove: [pipeline_plan]",
      "    manager:",
      "      remove: [history_stats]",
      "      add: [pipeline_start, task_update, pipeline_decide_gate]",
      "",
    ].join("\n");
    for (const config of CONFIGS) {
      const dir = makeRepo(config.text + block);
      const worker = await connect(dir, ["--role", "worker"]);
      const workerSet = (config.tasks ? ROLE_TOOLS.worker : withoutTasks(ROLE_TOOLS.worker)).filter(
        (name) => name !== "pipeline_plan",
      );
      await expectOnly(worker, workerSet);
      await worker.close();

      // 5m9d_the_person_can_give_the_manager_run_tools: `pipeline_start` is taken.
      const manager = await connect(dir, ["--role", "manager"]);
      let managerSet = [...ROLE_TOOLS.manager, "pipeline_start"].filter(
        (name) => name !== "history_stats",
      );
      if (!config.tasks) managerSet = withoutTasks(managerSet);
      if (!config.decides) managerSet = withoutDecisions(managerSet);
      await expectOnly(manager, managerSet);
      // 5m9d_an_unserved_known_name_is_reported: a known name this server cannot serve is said on stderr.
      if (!config.tasks) expect(manager.stderr()).toContain("task_update is not served here");
      if (!config.decides) {
        expect(manager.stderr()).toContain("pipeline_decide_gate is not served here");
      }
      await manager.close();

      // With no role: the union after the overrides. Each removed tool was in one role only, so it is gone.
      const all = await connect(dir, []);
      let union = KNOWN_TOOL_NAMES.filter(
        (name) => name !== "pipeline_plan" && name !== "history_stats",
      );
      if (!config.tasks) union = withoutTasks(union);
      if (!config.decides) union = withoutDecisions(union);
      await expectOnly(all, union);
      await all.close();
    }
  }, 180_000);

  test("5m9d_no_role_serves_every_tool_as_before", async () => {
    const dir = makeRepo(OFF + DECISIONS + TASKS);
    const all = await connect(dir, []);
    await expectOnly(all, KNOWN_TOOL_NAMES);
    expect(all.tools.find((t) => t.name === "pipeline_next_step")?.annotations?.readOnlyHint).toBe(
      false,
    );
    expect(all.stderr()).toContain("no role: every tool");
    await all.close();
  }, 60_000);
});

describe("5m9d the start command", () => {
  test("5m9d_wrong_start_commands_are_refused_before_serving", () => {
    const dir = makeRepo(OFF);
    const cases: { args: string[]; env?: Record<string, string>; says: string }[] = [
      { args: ["--role", "admin"], says: '--role is worker or manager, not "admin"' },
      { args: ["--role", "worker", "--read-only"], says: "--role worker cannot be --read-only" },
      { args: ["--role", "manager"], env: { KODEL_ENGINE: "1" }, says: "KODEL_ENGINE is set" },
      { args: ["--read-only"], env: { KODEL_ENGINE: "1" }, says: "the server is a worker there" },
      {
        args: ["--role", "manager", "--read-only"],
        env: { KODEL_ENGINE: "1" },
        says: "KODEL_ENGINE is set",
      },
    ];
    for (const { args, env, says } of cases) {
      const ended = startAndExit(dir, args, env);
      expect(ended.code, args.join(" ")).toBe(1);
      expect(ended.stderr, args.join(" ")).toContain(says);
      // Nothing was served: stdout is the protocol, and not a byte of it was written.
      expect(ended.stdout).toBe("");
    }
    // Outside a project the flags are judged first too.
    const nowhere = tempDir("kodel-roles-nowhere-");
    expect(startAndExit(nowhere, ["--role", "worker", "--read-only"]).code).toBe(1);
  }, 120_000);

  test("5m9d_under_the_engine_mark_the_server_is_a_worker", async () => {
    // The environment as a session child gets it (`session-env.ts`): the mark, and no role flag.
    const env = sessionEnv(undefined, true, { PATH: process.env.PATH ?? "" });
    expect(env.KODEL_ENGINE).toBe("1");
    const dir = makeRepo(OFF + DECISIONS + TASKS);
    const marked = await connect(dir, [], { env: { KODEL_ENGINE: env.KODEL_ENGINE ?? "" } });
    await expectOnly(marked, ROLE_TOOLS.worker);
    expect(marked.stderr()).toContain("role worker");
    // No decision tool, no history, and no word of either in what the agent is told.
    const instructions = marked.client.getInstructions() ?? "";
    expect(instructions).not.toContain("history_runs");
    expect(instructions).not.toContain("pipeline_decide_gate");
    await marked.close();
  }, 60_000);

  test("5m9d_roles_hold_outside_a_project", async () => {
    const nowhere = tempDir("kodel-roles-nowhere-");
    // Without `--root`: the server looks for a project from where it stands, and finds none.
    const outside = (args: string[]) => connect(nowhere, [], { command: [main, "mcp", ...args] });
    const manager = await outside(["--role", "manager"]);
    await expectOnly(
      manager,
      withoutAttachments(withoutDecisions(withoutTasks(ROLE_TOOLS.manager))),
    );
    // Every tool it does serve answers with the reason there is no project.
    expect(await manager.call("manager_inbox")).toMatchObject({ ok: false, code: "NO_PROJECT" });
    expect(await manager.call("pipeline_list")).toMatchObject({ ok: false, code: "NO_PROJECT" });
    await manager.close();
    const readOnly = await outside(["--read-only"]);
    expect(readOnly.names).not.toContain("pipeline_start");
    expect(await readOnly.refuses("pipeline_start")).toBe(true);
    for (const tool of readOnly.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    await readOnly.close();
    const worker = await outside(["--role", "worker"]);
    await expectOnly(worker, withoutAttachments(withoutTasks(ROLE_TOOLS.worker)));
    await worker.close();
  }, 90_000);
});

describe("5m9d the mcp block and the server", () => {
  test("5m9d_unusable_mcp_block_stops_the_server", async () => {
    const dir = makeRepo(OFF);
    const config = join(dir, ".kodel", "config.yaml");
    const unusable: [string, string][] = [
      ["mcp:\n  rolez: {}\n", "rolez"],
      ["mcp:\n  roles: worker\n", "mcp.roles"],
      ["mcp:\n  roles:\n    admin:\n      add: [pipeline_plan]\n", "admin"],
      ["mcp:\n  roles:\n    manager:\n      add: [pipeline_strat]\n", '"pipeline_strat"'],
      ["mcp: null\n", "mcp"],
      [
        "mcp:\n  roles:\n    worker:\n      add: [pipeline_decide_gate]\n",
        '"pipeline_decide_gate"',
      ],
      ["mcp:\n  roles:\n    worker:\n      remove: [pipeline_start]\n", '"pipeline_start"'],
    ];
    for (const [block, says] of unusable) {
      writeFileSync(config, OFF + block);
      for (const args of [[], ["--role", "worker"], ["--role", "manager", "--read-only"]]) {
        const ended = startAndExit(dir, args);
        expect(ended.code, `${block} ${args.join(" ")}`).toBe(1);
        expect(ended.stderr, block).toContain(says);
        expect(ended.stdout).toBe("");
      }
    }
    // `mcp: {}`, no block and an empty file start as today.
    for (const text of [`${OFF}mcp: {}\n`, OFF, ""]) {
      writeFileSync(config, text);
      const server = await connect(dir, []);
      expect(server.names).toContain("pipeline_start");
      expect(server.names).toContain("manager_inbox");
      await server.close();
    }
  }, 240_000);

  test("5m9d_a_bad_block_elsewhere_keeps_the_narrowed_set", async () => {
    // A broken `tasks` block: the task tools are not served, as before, and the `mcp` block still holds.
    const dir = makeRepo(
      `${OFF}tasks:\n  enabled: maybe\nmcp:\n  roles:\n    worker:\n      remove: [pipeline_plan, pipeline_feedback]\n`,
    );
    const worker = await connect(dir, ["--role", "worker"]);
    await expectOnly(
      worker,
      withoutTasks(ROLE_TOOLS.worker).filter(
        (name) => name !== "pipeline_plan" && name !== "pipeline_feedback",
      ),
    );
    expect(worker.stderr()).toContain("the task tools are not served");
    await worker.close();
  }, 60_000);

  test("5m9d_unparseable_config_stops_only_with_an_mcp_line", async () => {
    const dir = makeRepo("worktree: [unclosed\n");
    // Not YAML, and nothing says the set was narrowed: the server starts with its defaults, as before.
    const server = await connect(dir, []);
    expect(server.names).toContain("pipeline_start");
    await server.close();
    // With a top-level `mcp:` line the person narrowed the set and it cannot be read.
    writeFileSync(join(dir, ".kodel", "config.yaml"), "worktree: [unclosed\nmcp:\n  roles: {}\n");
    const ended = startAndExit(dir, []);
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain("not valid YAML");
    expect(ended.stdout).toBe("");
  }, 60_000);
});

describe("5m9d what the agent is told", () => {
  /** No name of a tool the server does not serve, in its instructions or in any description. */
  function expectNoAbsentName(server: Connected, where: string) {
    const absent = KNOWN_TOOL_NAMES.filter((name) => !server.names.includes(name));
    const texts = [
      server.client.getInstructions() ?? "",
      ...server.tools.map((tool) => `${tool.description}\n${JSON.stringify(tool.inputSchema)}`),
    ];
    for (const name of absent) {
      const word = new RegExp(`\\b${name}\\b`);
      for (const text of texts)
        expect(word.test(text), `${name} in a text of ${where}`).toBe(false);
    }
  }

  test("5m9d_texts_name_only_served_tools", async () => {
    const dir = makeRepo(OFF + DECISIONS + TASKS);
    for (const args of [
      ["--role", "worker"],
      ["--role", "manager"],
      ["--read-only"],
      ["--role", "manager", "--read-only"],
      ["--role", "worker", "--no-decisions", "--no-wait-hint"],
    ]) {
      const server = await connect(dir, args);
      expectNoAbsentName(server, args.join(" "));
      await server.close();
    }
    const plainDir = makeRepo(OFF);
    for (const args of [["--role", "worker"], ["--role", "manager"], ["--read-only"]]) {
      const server = await connect(plainDir, args);
      expectNoAbsentName(server, `${args.join(" ")} (no tasks)`);
      await server.close();
    }
  }, 180_000);

  test("5m9d_worker_role_ignores_decisions_agent", async () => {
    const dir = makeRepo(OFF + DECISIONS);
    for (const args of [
      ["--role", "worker"],
      ["--role", "worker", "--no-decisions", "--no-wait-hint"],
    ]) {
      const worker = await connect(dir, args);
      const instructions = worker.client.getInstructions() ?? "";
      expect(instructions).not.toContain("lets you decide");
      expect(instructions).not.toContain("Unless rule");
      expect(instructions).toContain("\n9b. ");
      const started = await worker.call("pipeline_start", {
        task: `gate ${args.length}`,
        pipeline: "demo",
      });
      const done = await worker.call("pipeline_complete_step", {
        run_id: started.run_id,
        node_slug: "write",
        attempt: 1,
      });
      // The waiting answer has no word of deciding it yourself.
      expect(done.next.waiting.reason).toBe("gate");
      const told = JSON.stringify(done.next.waiting);
      expect(told).not.toContain("pipeline_decide_gate");
      expect(told).not.toContain("decide it yourself");
      expect(await worker.refuses("pipeline_decide_gate")).toBe(true);
      await worker.close();
    }
    // The same project through a server with no role offers the tool, as before.
    const all = await connect(dir, []);
    expect(all.names).toContain("pipeline_decide_gate");
    expect(all.client.getInstructions() ?? "").toContain("lets you decide");
    await all.close();
  }, 120_000);

  test("5m9d_worker_done_answer_names_no_task_update", async () => {
    const DONE = "name: one\nnodes:\n  - { slug: only, kind: agent, prompt: do it }\nedges: []\n";
    const dir = makeRepo(OFF + TASKS);
    writeFileSync(join(dir, ".kodel", "pipelines", "one.yaml"), DONE);
    const finish = async (args: string[], title: string) => {
      const server = await connect(dir, args);
      const made = await server.call("task_create", { title });
      const started = await server.call("pipeline_start", {
        task: title,
        pipeline: "one",
        task_key: made.task.key,
      });
      const done = await server.call("pipeline_complete_step", {
        run_id: started.run_id,
        node_slug: "only",
        attempt: 1,
      });
      await server.close();
      return String(done.next.tell_the_person ?? "");
    };
    const worker = await finish(["--role", "worker"], "closed by the person");
    expect(worker).toContain("tell the person the task is still open");
    expect(worker).toContain("kodel task set");
    expect(worker).not.toContain("task_update");
    const all = await finish([], "closed by the agent when asked");
    expect(all).toContain("call task_update with the done status");
  }, 120_000);

  test("5m9d_worker_allowlist_matches_the_served_set", async () => {
    // What the launcher allows the worker is what the worker's own server lists, start after start.
    const dir = makeRepo(OFF + DECISIONS + TASKS);
    const config = join(dir, ".kodel", "config.yaml");
    const listed = async () => {
      const spec = JSON.parse(workerMcpConfig({ exec: process.execPath, args: [main], root: dir }));
      const args = spec.mcpServers.kodel.args as string[];
      // 5m9d_claude_worker_starts_the_worker_role
      expect(args.slice(args.indexOf("mcp"))).toEqual([
        "mcp",
        "--role",
        "worker",
        "--no-decisions",
        "--no-wait-hint",
      ]);
      const server = await connect(dir, [], { command: args });
      const names = server.names;
      await server.close();
      return sorted(names);
    };
    expect(sorted(await workerServedTools(join(dir, ".kodel")))).toEqual(await listed());
    // The person narrows the worker between two starts: both follow.
    writeFileSync(
      config,
      `${OFF}${DECISIONS}${TASKS}mcp:\n  roles:\n    worker:\n      remove: [pipeline_plan, task_create]\n`,
    );
    const narrowed = await listed();
    expect(narrowed).not.toContain("pipeline_plan");
    expect(narrowed).not.toContain("task_create");
    expect(sorted(await workerServedTools(join(dir, ".kodel")))).toEqual(narrowed);
  }, 120_000);
});

describe("5m9d the dialog", () => {
  const DIALOG = "decisions:\n  dialog: true\n";

  /** Start a run and hand in its first step, so the next answer is the gate. */
  async function toTheGate(server: Connected, task: string) {
    const started = await server.call("pipeline_start", { task, pipeline: "demo" });
    await server.call("pipeline_complete_step", {
      run_id: started.run_id,
      node_slug: "write",
      attempt: 1,
    });
    return started.run_id as string;
  }

  test("5m9d_dialog_follows_the_config_as_before", async () => {
    const dir = makeRepo(OFF + DIALOG);
    for (const args of [[], ["--role", "worker"]]) {
      const server = await connect(dir, args);
      await toTheGate(server, `a dialog ${args.length}`);
      // The person is asked in the client, as the config says; the client of the test declines.
      expect(server.asked.length, args.join(" ")).toBeGreaterThan(0);
      await server.close();
    }
  }, 120_000);

  test("5m9d_read_only_server_opens_no_dialog", async () => {
    const dir = makeRepo(
      `${OFF}decisions:\n  dialog: true\n  agent:\n    gate: true\n    pipeline_change: true\n`,
    );
    const worker = await connect(dir, ["--role", "worker"]);
    const runId = await toTheGate(worker, "a gate to look at");
    await worker.close();
    for (const args of [
      ["--read-only"],
      ["--role", "manager", "--read-only"],
      ["--role", "manager"],
    ]) {
      const server = await connect(dir, args);
      const inbox = await server.call("manager_inbox");
      expect(
        inbox.waiting.some((item: Loose) => item.kind === "gate" && item.run_id === runId),
      ).toBe(true);
      await server.call("manager_gate_changes", { run_id: runId });
      await server.call("history_run_details", { run_id: runId });
      await server.call("pipeline_resolve", { pipeline: "demo", run_id: runId });
      expect(server.asked, args.join(" ")).toEqual([]);
      await server.close();
    }
  }, 120_000);
});

describe("5m9d a server that only reads", () => {
  test("5m9d_read_only_server_leaves_everything_as_it_was", async () => {
    const tmp = tempDir("kodel-roles-states-");
    const states = await makeStates(tmp);
    const home = join(tmp, "home");
    mkdirSync(home);
    // The server is started once before the picture is taken: its own first start may make its folders.
    const warm = await connect(states.root, ["--read-only"], { home });
    await warm.close();
    const before = await snapshotAll(tmp);

    for (const args of [["--read-only"], ["--role", "manager", "--read-only"]]) {
      const server = await connect(states.root, args, { home });
      for (const tool of server.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
      const cursor = (await server.call("manager_watch", {})).cursor;
      for (const runId of Object.values(states.runs)) {
        const perRun: Record<string, Record<string, unknown>> = {
          pipeline_resolve: { pipeline: "gated", run_id: runId },
          history_run_details: { run_id: runId },
          history_agent_log: { run_id: runId, node: "write", attempt: 1 },
          manager_run_report: { run_id: runId },
          manager_gate_changes: { run_id: runId },
          pipeline_attachment_list: { run_id: runId },
          pipeline_attachment_read: { run_id: runId, name: "plan.md" },
        };
        for (const [name, input] of Object.entries(perRun)) {
          if (server.names.includes(name)) await server.call(name, input);
        }
      }
      const once: Record<string, Record<string, unknown>> = {
        pipeline_list: {},
        pipeline_docs: {},
        pipeline_plan: { pipeline: "gated", task: "x" },
        history_runs: {},
        history_stats: { pipeline: "gated" },
        manager_inbox: {},
        manager_serve_status: {},
        manager_agents: {},
        manager_agent_log: { id: "nobody" },
        manager_watch: { cursor, wait_s: 1 },
      };
      // Every tool the server lists was called: nothing it serves is left untried.
      for (const name of server.names) {
        if (once[name] !== undefined) await server.call(name, once[name]);
        else
          expect([
            "pipeline_resolve",
            "history_run_details",
            "history_agent_log",
            "manager_run_report",
            "manager_gate_changes",
            "pipeline_attachment_list",
            "pipeline_attachment_read",
          ]).toContain(name);
      }
      const inbox = await server.call("manager_inbox");
      expect(inbox.ok).toBe(true);
      expect(inbox.waiting.some((item: Loose) => item.run_id === states.runs.gate)).toBe(true);
      await server.close();
    }
    // The run folders (state, journal, served/, snapshots), the proposals, the integrity records,
    // the session and serve records under the state base, the git refs, index and working tree.
    expect(await snapshotAll(tmp)).toEqual(before);
    const v1 = JSON.parse(
      readFileSync(join(states.root, ".kodel", "runs", states.runs.v1, "state.json"), "utf8"),
    );
    expect(v1.v).toBe(1);
  }, 240_000);
});

describe("5m9d a decision through a manager", () => {
  test("5m9d_manager_decision_does_not_serve_a_step", async () => {
    const dir = makeRepo(OFF + DECISIONS);
    const home = tempDir("kodel-roles-home-");
    const journalOf = (runId: string) =>
      readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Loose);
    const worker = await connect(dir, ["--role", "worker"], { home });
    const started = await worker.call("pipeline_start", {
      task: "decided by a manager",
      pipeline: "demo",
    });
    const runId = started.run_id as string;
    await worker.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
    await worker.close();
    const servedBefore = journalOf(runId).filter((r) => r.event === "step_served").length;

    const manager = await connect(dir, ["--role", "manager"], { home });
    const inbox = await manager.call("manager_inbox");
    const gate = inbox.waiting.find((item: Loose) => item.kind === "gate" && item.run_id === runId);
    expect(gate).toMatchObject({ node_slug: "approve", attempt: 1 });
    // 5m9d_manager_decides_from_the_inbox: a wrong attempt points back to the inbox, not to a step.
    const wrong = await manager.call("pipeline_decide_gate", {
      run_id: runId,
      node_slug: "approve",
      attempt: 7,
      decision: "approved",
      instruction: "approve it",
    });
    expect(wrong).toMatchObject({ ok: false, code: "ATTEMPT_MISMATCH" });
    expect(wrong.message).toContain("manager_inbox");
    const decided = await manager.call("pipeline_decide_gate", {
      run_id: runId,
      node_slug: gate.node_slug,
      attempt: gate.attempt,
      decision: "approved",
      instruction: "approve it",
    });
    expect(decided).toMatchObject({
      ok: true,
      decided_by: "agent",
      decision: "approved",
      run: { open_step: "ship" },
    });
    // No step to do came back, and none was served to anyone.
    expect(decided.next).toBeUndefined();
    await manager.close();

    const journal = journalOf(runId);
    const record = journal.find((r) => r.event === "gate_decided");
    expect(record).toMatchObject({ decided_by: "agent", decided_via: "manager" });
    expect(journal.filter((r) => r.event === "step_served")).toHaveLength(servedBefore);
    expect(journal.some((r) => r.seq > record.seq && r.event === "command_started")).toBe(false);
    // So the daemon still resumes the run's worker: the decision reads as one nobody acted on.
    const marks = decisionOf(journal);
    expect(marks.moved).toBe(false);
    const verdict = resumeVerdict(
      { runId, status: "running", waitsForPerson: false, marks },
      {
        id: "a_000000001_test",
        name: `kw-${runId}`,
        state: "exited",
        label: "exited (0)",
        exitCode: 0,
        started: 0,
        since: marks.lastWait?.ts ?? 0,
        sessionId: "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c",
        resumed: [],
        resumes: 0,
      },
      { refuseMoved: true },
    );
    expect(verdict).toMatchObject({ kind: "resume", seq: record.seq });

    // The worker goes on from there, and the report says which servers were behind the run.
    const again = await connect(dir, ["--role", "worker"], { home });
    const next = await again.call("pipeline_next_step", { run_id: runId });
    expect(next.node.slug).toBe("ship");
    await again.close();
    const state = JSON.parse(
      readFileSync(join(dir, ".kodel", "runs", runId, "state.json"), "utf8"),
    );
    const text = formatReport(summarizeRun(state, journalOf(runId)), plain);
    expect(text).toContain("server role: started by worker; steps served by worker");
  }, 120_000);

  test("5m9d_manager_approves_a_gate_with_attachments_from_what_it_was_shown", async () => {
    const dir = makeRepo(OFF + DECISIONS);
    const home = tempDir("kodel-roles-home-");
    const servedIn = (runId: string) =>
      readFileSync(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Loose)
        .filter((r) => r.event === "step_served").length;
    const worker = await connect(dir, ["--role", "worker"], { home });
    const started = await worker.call("pipeline_start", { task: "attached", pipeline: "demo" });
    const runId = started.run_id as string;
    const written = await worker.call("pipeline_attachment_write", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
      name: "plan.md",
      content: "a plan\n",
    });
    expect(written).toMatchObject({ ok: true, version: 1 });
    await worker.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
    await worker.close();
    const servedBefore = servedIn(runId);

    const manager = await connect(dir, ["--role", "manager"], { home });
    // The manager reads the attachments (T-45) and has no tool that writes one.
    expect(manager.names).toContain("pipeline_attachment_read");
    expect(manager.names).toContain("pipeline_attachment_list");
    expect(manager.names).not.toContain("pipeline_attachment_write");
    expect(await manager.refuses("pipeline_attachment_write")).toBe(true);
    const shown = await manager.call("manager_gate_changes", { run_id: runId });
    expect(shown).toMatchObject({
      gates: [{ node_slug: "approve", attempt: 1 }],
      attachments: [{ name: "plan.md", version: 1 }],
    });
    expect(typeof shown.attachments_fingerprint).toBe("string");
    // Without what the person was shown the approval is refused, and nothing is served to the manager.
    const blind = await manager.call("pipeline_decide_gate", {
      run_id: runId,
      node_slug: "approve",
      attempt: 1,
      decision: "approved",
      instruction: "approve it",
    });
    expect(blind).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
    expect(blind.message).toContain("manager_gate_changes");
    expect(blind.details).toMatchObject({ attachments_fingerprint: shown.attachments_fingerprint });
    expect(blind.details.next).toBeUndefined();
    expect(servedIn(runId)).toBe(servedBefore);
    const decided = await manager.call("pipeline_decide_gate", {
      run_id: runId,
      node_slug: "approve",
      attempt: 1,
      decision: "approved",
      instruction: "approve it",
      attachments_fingerprint: shown.attachments_fingerprint,
    });
    expect(decided).toMatchObject({ ok: true, decided_by: "agent", run: { open_step: "ship" } });
    expect(servedIn(runId)).toBe(servedBefore);
    await manager.close();
  }, 120_000);
});

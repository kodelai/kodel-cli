import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  homeHashKey,
  homePlace,
  LocalPipelineHost,
  loadConfig,
  projectIdProblem,
  resolveStoragePlace,
  type StoragePlace,
} from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../src/cli";
import { createServer } from "../src/mcp-server";

const ID = "demo-aaaa1111";

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

const HOME_CONFIG = `worktree:\n  mode: off\nstorage: home\nproject_id: ${ID}\n`;
const PROJECT_CONFIG = "worktree:\n  mode: off\n";

const temps: string[] = [];
let dir: string; // the project
let base: string; // KODEL_STATE_DIR
let savedStateDir: string | undefined;

async function makeProject(config: string): Promise<string> {
  // The real path, as the CLI finds the project root: a run records the root it was made in.
  const root = await realpath(await mkdtemp(join(tmpdir(), "kodel-storage-cli-")));
  temps.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO);
  await writeFile(join(root, ".kodel", "config.yaml"), config);
  return root;
}

beforeEach(async () => {
  dir = await makeProject(HOME_CONFIG);
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-storage-cli-base-")));
  temps.push(base);
  // The CLI looks for the integrity hashes in the process environment, as a real run does.
  savedStateDir = process.env["KODEL_STATE_DIR"];
  process.env["KODEL_STATE_DIR"] = base;
});
afterEach(async () => {
  if (savedStateDir === undefined) delete process.env["KODEL_STATE_DIR"];
  else process.env["KODEL_STATE_DIR"] = savedStateDir;
  for (const path of temps.splice(0)) await rm(path, { recursive: true, force: true });
});

interface Person {
  interactive?: boolean;
  environment?: Record<string, string | undefined>;
  cwd?: string;
  answer?: boolean;
}

async function cliAs(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: person.cwd ?? dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? true,
    environment: person.environment ?? { KODEL_STATE_DIR: base },
    select: async () => [],
    confirm: async () => person.answer ?? true,
  });
  return { code, out, err };
}

const cli = (...args: string[]) => cliAs({}, ...args);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const tree = () => join(base, "projects", ID);

const placeOf = (root: string, environment: Record<string, string | undefined> = {}) =>
  resolveStoragePlace({ root, dataDir: join(root, ".kodel"), env: environment });

/** A host the way the CLI builds it, so what it plants is what the CLI looks for (or, with a place, elsewhere). */
function hostFor(root: string, storage?: StoragePlace) {
  return new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: base,
    ...(storage === undefined ? {} : { storage }),
  });
}

async function runAtGate(host: LocalPipelineHost, task = "t"): Promise<string> {
  const { run } = await host.start({ pipeline: "demo", task, restart: false });
  await run.completeStep("write", 1);
  await run.waitForRest(5_000);
  return run.runId;
}

// ── kodel init ────────────────────────────────────────────────────────────────

describe("kodel init --storage", () => {
  let fresh: string;
  beforeEach(async () => {
    fresh = await mkdtemp(join(tmpdir(), "kodel-storage-init-"));
    temps.push(fresh);
    await mkdir(join(fresh, ".git"));
  });

  const init = (...args: string[]) =>
    cliAs(
      { cwd: fresh, interactive: false, environment: { PATH: "" } },
      "init",
      "-y",
      "--agent",
      "claude-code",
      "--no-hooks",
      ...args,
    );

  test("storage_init_flag_writes_keys", async () => {
    const result = await init("--storage", "home");
    expect(result.code).toBe(0);
    const text = await readFile(join(fresh, ".kodel", "config.yaml"), "utf8");
    expect(text).toContain("storage: home\n");
    const id = /^project_id: (.+)$/m.exec(text)?.[1];
    expect(id).toBeDefined();
    expect(projectIdProblem(id ?? "")).toBeUndefined();
    const config = await loadConfig(join(fresh, ".kodel"));
    expect(config.storage).toBe("home");
    expect(config.project_id).toBe(id);
    expect(result.out).toContain("must be upgraded before it is committed");
  });

  test("storage_init_without_flag_is_unchanged", async () => {
    const result = await init();
    expect(result.code).toBe(0);
    expect(await readFile(join(fresh, ".kodel", "config.yaml"), "utf8")).toBe(
      "# The Kodel project config. Every key is optional.\nversion: 1\ntasks:\n  enabled: false\n",
    );
    expect(result.out).not.toContain("project_id");
  });

  test("storage_init_keeps_existing_config", async () => {
    await mkdir(join(fresh, ".kodel"), { recursive: true });
    const mine = "# mine\nversion: 1\n";
    await writeFile(join(fresh, ".kodel", "config.yaml"), mine);
    const result = await init("--storage", "home");
    expect(result.code).toBe(0);
    expect(await readFile(join(fresh, ".kodel", "config.yaml"), "utf8")).toBe(mine);
    expect(result.out).toContain("storage: home / project_id: ");
  });

  test("storage_init_rejects_bad_storage_value", async () => {
    const result = await init("--storage", "cloud");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('--storage is "home" or "project", not "cloud"');
    expect(await exists(join(fresh, ".kodel", "config.yaml"))).toBe(false);
  });
});

// ── status ────────────────────────────────────────────────────────────────────

describe("status in home mode", () => {
  test("storage_status_prints_mode_and_place", async () => {
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    await runAtGate(hostFor(dir, place));

    const person = await cliAs({ interactive: true }, "status");
    expect(person.code).toBe(0);
    expect(person.out).toContain(`storage: home (${tree()})`);

    const agent = await cliAs({ interactive: false }, "status");
    expect(agent.out).toContain(`storage: home (<home>${join("/projects", ID)})`);
    expect(agent.out).not.toContain(base);
  });

  test("storage_status_json_has_foreign", async () => {
    const clone = await makeProject(HOME_CONFIG);
    const place = await placeOf(clone, { KODEL_STATE_DIR: base });
    const foreignId = await runAtGate(hostFor(clone, place));

    const json = await cli("status", "--json");
    expect(json.code).toBe(0);
    const list = JSON.parse(json.out) as { runId: string; foreign?: string }[];
    expect(list.find((r) => r.runId === foreignId)?.foreign).toContain(basename(clone));
    const table = await cli("status");
    expect(table.out).toContain("[foreign: made by");

    // The default project prints what it always did.
    const plainDir = await makeProject(PROJECT_CONFIG);
    const plainId = await runAtGate(hostFor(plainDir));
    const env = { KODEL_STATE_DIR: base };
    const plainJson = await cliAs({ cwd: plainDir, environment: env }, "status", "--json");
    const plainList = JSON.parse(plainJson.out) as Record<string, unknown>[];
    expect(plainList.map((r) => r["runId"])).toEqual([plainId]);
    expect(plainList.every((r) => !("foreign" in r))).toBe(true);
    const plainTable = await cliAs({ cwd: plainDir, environment: env }, "status");
    expect(plainTable.out).not.toContain("foreign");
    // On a machine that keeps history under `~/.kodel` it says which of the two it reads, so a
    // branch that dropped the keys is seen (the base here has the `projects` folder of the home project).
    expect(plainTable.out).toContain("storage: project (this project keeps its history in .kodel");
    // With no such folder in the environment, or without headers, it prints what it always did.
    expect((await cliAs({ cwd: plainDir, environment: {} }, "status")).out).not.toContain(
      "storage:",
    );
    expect(
      (await cliAs({ cwd: plainDir, environment: env }, "status", "--no-headers")).out,
    ).not.toContain("storage:");
  });

  test("storage_flip_to_project_is_named: the hint and the status line for a project that lost the keys", async () => {
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    const id = await runAtGate(hostFor(dir, place));
    // A branch without the keys: the same project, now reading `.kodel`.
    await writeFile(join(dir, ".kodel", "config.yaml"), PROJECT_CONFIG);
    const status = await cli("status");
    expect(status.out).toContain("no runs yet");
    expect(status.out).toContain("storage: project (this project keeps its history in .kodel");
    const asked = await cli("wait", id);
    expect(asked.code).toBe(1);
    expect(asked.err).toContain("it may be kept in the other place");
  });

  test("storage_status_counts_unhashed_runs", async () => {
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    const id = await runAtGate(hostFor(dir, place));
    expect((await cli("status")).out).not.toContain("no recorded hash");

    const file = join(base, homeHashKey(ID), `${id}.sha256`);
    expect(await exists(file)).toBe(true);
    await unlink(file);
    const result = await cli("status");
    expect(result.out).toContain("1 run has no recorded hash here");
  });
});

// ── every surface reads only the configured place ─────────────────────────────

describe("the place a command reads", () => {
  const NOT_KEPT_HERE = "it may be kept in the other place";

  /** Home config: the run lives in the project's own `.kodel`. Project config: it lives in the home tree. */
  const scenarios = [
    { config: HOME_CONFIG, planted: "project" },
    { config: PROJECT_CONFIG, planted: "home" },
  ] as const;

  const clearPlaces = async () => {
    await rm(join(dir, ".kodel", "runs"), { recursive: true, force: true });
    await rm(join(dir, ".kodel", "proposals"), { recursive: true, force: true });
    await rm(join(base, "projects"), { recursive: true, force: true });
  };

  async function plantRun(planted: "project" | "home"): Promise<string> {
    const place = planted === "home" ? homePlace({ root: dir, projectId: ID, base }) : undefined;
    return runAtGate(hostFor(dir, place));
  }

  async function plantProposal(planted: "project" | "home"): Promise<string> {
    const place = planted === "home" ? homePlace({ root: dir, projectId: ID, base }) : undefined;
    const outcome = await hostFor(dir, place).proposePipeline({
      yaml: DEMO.replace("name: demo", "name: other"),
      summary: "a new pipeline",
    });
    expect(outcome).toMatchObject({ ok: true });
    return "other";
  }

  const label = (config: string) => `config ${config === HOME_CONFIG ? "home" : "project"}`;

  // One table-driven test per surface that reads a run: the run planted in the other place is
  // invisible, and asking for it by id fails at once with the hint.
  const runSurfaces: { name: string; args: (id: string) => string[] }[] = [
    { name: "status", args: (id) => ["status", id] },
    { name: "report", args: (id) => ["report", id] },
    { name: "wait", args: (id) => ["wait", id] },
  ];
  for (const surface of runSurfaces) {
    test(`storage_surface_${surface.name}_reads_only_configured_place`, async () => {
      for (const { config, planted } of scenarios) {
        await writeFile(join(dir, ".kodel", "config.yaml"), config);
        await clearPlaces();
        const id = await plantRun(planted);
        const at = `${label(config)} ${surface.name}`;

        const listing = await cli("status");
        expect(listing.out, at).toContain("no runs yet");
        expect(listing.out, at).not.toContain(id);

        const result = await cli(...surface.args(id));
        expect(result.code, at).toBe(1);
        expect(result.err, at).toContain(`there is no run "${id}"`);
        // The hint is for a project that keeps its history under `~/.kodel`, and for one on a machine
        // that has such a tree (the base here does: a run was planted in it or in the project).
        expect(result.err, at).toContain(NOT_KEPT_HERE);
        if (surface.name === "report") {
          // With no id it says there is nothing, not that it found the other place's run.
          expect((await cli("report")).err, at).toContain("there are no runs yet");
        }
      }
    });
  }

  test("storage_surface_default_project_message_is_unchanged", async () => {
    const plainDir = await makeProject(PROJECT_CONFIG);
    for (const args of [
      ["status", "nope"],
      ["report", "nope"],
      ["wait", "nope"],
    ]) {
      const result = await cliAs({ cwd: plainDir, environment: {} }, ...args);
      expect(result).toMatchObject({ code: 1, err: 'kodel: there is no run "nope"\n' });
    }
  });

  const proposalSurfaces = [
    {
      name: "pipeline_proposals_show",
      run: async (name: string) => {
        const list = await cli("pipeline", "proposals", "show");
        expect(list.out).toContain("no pipeline proposal waits");
        const one = await cli("pipeline", "proposals", "show", name);
        expect(one.code).toBe(1);
        expect(one.err).toContain(`no proposal of a pipeline named "${name}" waits`);
      },
    },
    {
      name: "pipeline_proposals_discard",
      run: async (name: string) => {
        const result = await cli("pipeline", "proposals", "discard", name);
        expect(result.out).toContain(`no proposal of a pipeline named "${name}" waits`);
      },
    },
    {
      name: "pipeline_proposals_apply",
      run: async (name: string) => {
        const result = await cli("pipeline", "proposals", "apply", name);
        expect(result.code).toBe(1);
        expect(result.err).toContain(`no proposal of a pipeline named "${name}" waits`);
        // Nothing was written into the pipelines.
        expect(await exists(join(dir, ".kodel", "pipelines", `${name}.yaml`))).toBe(false);
      },
    },
  ];
  for (const surface of proposalSurfaces) {
    test(`storage_surface_${surface.name}_reads_only_configured_place`, async () => {
      for (const { config, planted } of scenarios) {
        await writeFile(join(dir, ".kodel", "config.yaml"), config);
        await clearPlaces();
        const name = await plantProposal(planted);
        const plantedRoot =
          planted === "home"
            ? homePlace({ root: dir, projectId: ID, base }).proposalsRoot
            : join(dir, ".kodel", "proposals");
        await surface.run(name);
        // Whatever the command did, it did not touch the proposal in the other place.
        expect((await readdir(plantedRoot)).length, label(config)).toBeGreaterThan(0);
      }
    });
  }
});

// ── foreign runs ──────────────────────────────────────────────────────────────

describe("a run of another checkout", () => {
  test("storage_foreign_run_decisions_warn", async () => {
    const clone = await makeProject(HOME_CONFIG);
    const place = await placeOf(clone, { KODEL_STATE_DIR: base });
    const id = await runAtGate(hostFor(clone, place));

    const gate = await cli("gate", "approve", id);
    expect(gate.code).toBe(0);
    expect(gate.err).toContain(`run ${id} was made by the checkout at`);
    expect(gate.err).toContain(basename(clone));

    // `ack` is a decision too: the warning comes before anything else it says.
    const second = await runAtGate(hostFor(clone, place), "second");
    const ack = await cli("ack", second);
    expect(ack.err).toContain(`run ${second} was made by the checkout at`);
    expect(ack.err).toContain(basename(clone));
    expect(ack.err).not.toContain("there is no run");
  });

  test("storage_foreign_run_other_commands_warn: seal and the changes of the pipeline", async () => {
    const clone = await makeProject(HOME_CONFIG);
    const place = await placeOf(clone, { KODEL_STATE_DIR: base });
    const id = await runAtGate(hostFor(clone, place));
    const said = `run ${id} was made by the checkout at`;
    for (const args of [
      ["seal", id],
      ["pipeline", "changes", "apply", id],
      ["pipeline", "changes", "discard", id],
      ["pipeline", "changes", "restore", id],
    ]) {
      const result = await cli(...args);
      expect(result.err, args.join(" ")).toContain(said);
      expect(result.err, args.join(" ")).not.toContain("there is no run");
    }
  });
});

describe("what stays in the project in home mode", () => {
  test("worktrees and the hook log stay in the project; runs and the index do not", async () => {
    // The default `worktree` mode: the run works in a worktree under `.kodel/worktrees`.
    await writeFile(join(dir, ".kodel", "config.yaml"), `storage: home\nproject_id: ${ID}\n`);
    execFileSync("git", ["add", ".kodel"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: dir, stdio: "ignore" });
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    const { run } = await hostFor(dir, place).start({
      pipeline: "demo",
      task: "t",
      restart: false,
    });
    expect(await exists(join(dir, ".kodel", "worktrees", run.runId))).toBe(true);
    expect(await exists(join(tree(), "runs", run.runId, "meta.json"))).toBe(true);
    expect(await exists(join(dir, ".kodel", "runs"))).toBe(false);
    expect(await exists(join(dir, ".kodel", "sessions.jsonl"))).toBe(false);
  });
});

// ── mcp ───────────────────────────────────────────────────────────────────────

describe("kodel mcp with a place that cannot be used", () => {
  const MAIN = join(import.meta.dir, "../src/main.ts");

  /** What a server answers to the tools that need no history and to the ones that do. */
  async function toolAnswers(
    config: string,
    stateDir: string | undefined,
  ): Promise<{ list: string; docs: string; start: string }> {
    await writeFile(join(dir, ".kodel", "config.yaml"), config);
    const environment = { ...(process.env as Record<string, string>) };
    delete environment["KODEL_STATE_DIR"];
    if (stateDir !== undefined) environment["KODEL_STATE_DIR"] = stateDir;
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, "--root", dir, "mcp"],
        env: environment,
        stderr: "pipe",
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("pipeline_list");
      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.stringify(await client.callTool({ name, arguments: args }));
      return {
        list: await call("pipeline_list", {}),
        docs: await call("pipeline_docs", {}),
        start: await call("pipeline_start", { pipeline: "demo", task: "t" }),
      };
    } finally {
      await client.close();
    }
  }

  test("storage_mcp_starts_with_bad_state_dir: only the tools that need the history refuse", async () => {
    const relative = await toolAnswers(HOME_CONFIG, "relative/state");
    // The pipelines and their documentation are served; the history is what is refused.
    expect(relative.list).toContain("demo");
    expect(relative.list).not.toContain("CONFIG_INVALID");
    expect(relative.docs).not.toContain("CONFIG_INVALID");
    expect(relative.start).toContain("CONFIG_INVALID");
    expect(relative.start).toContain("KODEL_STATE_DIR must be an absolute path");

    const noId = await toolAnswers("worktree:\n  mode: off\nstorage: home\n", base);
    expect(noId.list).toContain("demo");
    expect(noId.start).toContain("CONFIG_INVALID");
    expect(noId.start).toContain("no project_id");
    // The agent is not given the absolute path of the project in the message.
    expect(noId.start).not.toContain(dir);
  });
});

// ── source checks ─────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, "../../..");

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("the place is never built by hand", () => {
  test("storage_cli_always_resolves", async () => {
    const text = await readFile(join(REPO, "packages/cli/src/cli.ts"), "utf8");
    const constructions = [...text.matchAll(/new LocalPipelineHost\(/g)];
    expect(constructions.length).toBeGreaterThan(0);
    for (const match of constructions) {
      const from = (match.index ?? 0) + match[0].length;
      let depth = 1;
      let end = from;
      while (depth > 0 && end < text.length) {
        const ch = text[end];
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        end++;
      }
      const options = text.slice(from, end - 1);
      // The options object has a `storage` key (not just the word in a condition).
      expect(options, options).toMatch(/(?<![\w.])storage(?::\s*(?!undefined\b)\S|\s*[,}])/);
    }
  });

  test("storage_no_hardcoded_runs_path", async () => {
    const owners = ["packages/local/src/store.ts", "packages/local/src/storage-paths.ts"];
    // Text shown to people or agents (not a path that is opened) is listed here, with the file and
    // the piece of the line that is allowed; every other line that names `.kodel/runs` or
    // `.kodel/proposals` in code is an offender.
    const exceptions: { file: string; contains: string }[] = [
      { file: "packages/pipeline-core/src/mcp/tools.ts", contains: ".kodel/runs" },
      { file: "packages/cli/src/elicit.ts", contains: ".kodel/runs/" },
    ];
    const pathLiteral = /\.kodel\/(?:runs|proposals)\b/;
    // A string "runs" or "proposals" as an argument of join/resolve, or `/runs` in a template string.
    const call = /\b(?:path\.)?(?:join|resolve)\((?:[^()]|\([^()]*\))*\)/g;
    const literal = /["'`](?:runs|proposals)["'`]/;
    const template = /`[^`\n]*\/(?:runs|proposals)\b[^`\n]*`/g;

    const offenders: string[] = [];
    const files = (await readdir(join(REPO, "packages"))).map((p) =>
      join(REPO, "packages", p, "src"),
    );
    for (const root of files) {
      if (!(await exists(root))) continue;
      for (const file of await sourceFiles(root)) {
        const rel = file.slice(REPO.length + 1).replaceAll("\\", "/");
        if (owners.includes(rel)) continue;
        // Comments are not code: lines that start a comment are dropped before looking.
        const lines = (await readFile(file, "utf8"))
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
        const code = lines.join("\n");
        const hits = [
          ...[...code.matchAll(call)].map((m) => m[0]).filter((c) => literal.test(c)),
          ...(code.match(template) ?? []),
          // A string that names the project's folders: `".kodel/runs"`, `".kodel/proposals/x"`.
          ...lines.filter((line) => pathLiteral.test(line)).map((line) => line.trim()),
        ];
        for (const hit of hits) {
          const allowed = exceptions.some((e) => e.file === rel && hit.includes(e.contains));
          if (!allowed) offenders.push(`${rel}: ${hit}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── the dialog ────────────────────────────────────────────────────────────────

describe("the dialog for a state changed outside kodel", () => {
  /** The message of the form shown for a run whose state.json was edited by hand. */
  async function ackMessage(root: string, storage: StoragePlace | undefined): Promise<string> {
    const host = new LocalPipelineHost({
      root,
      heartbeatMs: 0,
      integrityDir: base,
      ...(storage === undefined ? {} : { storage }),
    });
    const server = createServer(host, "0.0.0", undefined, undefined, {
      humans: host,
      dialog: true,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "agent", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    const forms: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      forms.push((request.params as { message: string }).message);
      return { action: "decline" };
    });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    };
    try {
      const started = await call("pipeline_start", { task: "t" });
      const runId = started.run_id as string;
      const path = join(storage?.runsRoot ?? join(root, ".kodel", "runs"), runId, "state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.nodes.write.attempts = 0;
      await writeFile(path, JSON.stringify(state));
      const refused = await call("pipeline_next_step", { run_id: runId });
      expect(refused).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
      expect(forms).toHaveLength(1);
      return `${forms[0]}\n${runId}`;
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  }

  test("storage_dialog_names_real_folder", async () => {
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    const home = await ackMessage(dir, place);
    const runId = home.split("\n").at(-1) ?? "";
    expect(home).toContain(join(tree(), "runs", runId));
    expect(home).not.toContain(`.kodel/runs/${runId}`);

    const plainDir = await makeProject(PROJECT_CONFIG);
    const project = await ackMessage(plainDir, undefined);
    const projectId = project.split("\n").at(-1) ?? "";
    expect(project).toContain(`(.kodel/runs/${projectId})`);
  });
});

describe("a config the loader refuses", () => {
  test("storage_commands_work_on_broken_config: status lists the runs and says the config was refused", async () => {
    const place = await placeOf(dir, { KODEL_STATE_DIR: base });
    const host = hostFor(dir, place);
    const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
    await writeFile(join(dir, ".kodel", "config.yaml"), `${HOME_CONFIG}not_a_key: 1\n`);
    const status = await cli("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain(run.runId);
    expect(status.err).toContain("the config was refused");
    expect(status.err).toContain("not_a_key");
    // The same for one run, and for the report.
    expect((await cli("status", run.runId)).out).toContain(run.runId);
    expect((await cli("report", run.runId)).code).toBe(0);
  });

  test("a config refused in a way the matcher cannot read is an error, not a guess", async () => {
    await writeFile(join(dir, ".kodel", "config.yaml"), "storage: [home]\n");
    const status = await cli("status");
    expect(status.code).not.toBe(0);
    expect(status.err).toContain("storage");
  });
});

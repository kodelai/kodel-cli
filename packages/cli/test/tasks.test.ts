import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Command } from "commander";
import { runCli, withPlural } from "../src/cli";
import { formatSchema } from "../src/task-format";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-clitasks-"));
  await mkdir(join(dir, ".kodel"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = (text: string) => writeFile(join(dir, ".kodel", "config.yaml"), text);
const ENABLED = "tasks:\n  enabled: true\n  adapters:\n    local:\n      prefix: KDL\n";

async function cli(...args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: dir,
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

/** Create a task and return its key. */
async function add(...args: string[]): Promise<string> {
  const made = await cli("task", "add", ...args);
  expect(made.err).toBe("");
  const key = /created (\S+):/.exec(made.out)?.[1];
  if (!key) throw new Error(`no key in ${made.out}`);
  return key;
}

describe("t3_tasks_are_off_by_default", () => {
  test("every task command refuses and says how to turn them on", async () => {
    for (const args of [
      ["task", "add", "x"],
      ["task", "list"],
      ["task", "show", "KDL-2222"],
      ["task", "set", "KDL-2222", "--title", "y"],
      ["task", "schema"],
      ["task", "doctor"],
    ]) {
      const result = await cli(...args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err, args.join(" ")).toContain("tasks are off");
      expect(result.err).toContain("tasks.enabled");
      expect(result.out).toBe("");
    }
  });

  test("an explicit enabled: false is the same", async () => {
    await config("tasks:\n  enabled: false\n");
    expect((await cli("task", "list")).err).toContain("tasks are off");
  });

  test("nothing is written when tasks are off", async () => {
    await cli("task", "add", "x");
    await expect(readdirOrEmpty(join(dir, ".kodel", "tasks"))).resolves.toEqual([]);
  });
});

async function readdirOrEmpty(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path).catch(() => []);
}

describe("the commands", () => {
  beforeEach(async () => {
    await config(ENABLED);
  });

  test("add, list, show and set work on one task", async () => {
    const key = await add(
      "Fix the report",
      "--body",
      "durations print as 0s",
      "--priority",
      "high",
    );
    expect(key).toMatch(/^KDL-[2-9A-HJKMNP-TV-Z]{4}$/);

    const listed = await cli("task", "list");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(key);
    expect(listed.out).toContain("Fix the report");
    expect(listed.out).toContain("high");

    const shown = await cli("task", "show", key.toLowerCase());
    expect(shown.out).toContain(`${key}: Fix the report`);
    expect(shown.out).toContain("status: todo");
    expect(shown.out).toContain("durations print as 0s");

    const set = await cli("task", "set", key, "--status", "progress", "--priority", "low");
    expect(set.code).toBe(0);
    expect(set.out).toContain(`updated ${key}: progress`);
    expect((await cli("task", "show", key)).out).toContain("priority: low");
  });

  test("the suffix alone finds the task", async () => {
    const key = await add("By suffix");
    expect((await cli("task", "show", key.slice(-4))).out).toContain(key);
  });

  test("a finished task leaves the default list and --state brings it back", async () => {
    const key = await add("Soon done");
    await add("Still open");
    await cli("task", "set", key, "--status", "declined", "--comment", "by design");
    expect((await cli("task", "list")).out).not.toContain("Soon done");
    const finished = await cli("task", "list", "--state", "done");
    expect(finished.out).toContain("Soon done");
    expect(finished.out).toContain("by design");
    const both = await cli("task", "list", "--state", "todo,done");
    expect(both.out).toContain("Soon done");
    expect(both.out).toContain("Still open");
  });

  test("t12_subtasks: --parent makes one, show lists it, --top-level and --parent filter", async () => {
    const parent = await add("Parent");
    const child = await add("Child", "--parent", parent);
    const shown = await cli("task", "show", parent);
    expect(shown.out).toContain("subtasks:");
    expect(shown.out).toContain(`${child}  Child`);
    expect((await cli("task", "list", "--top-level")).out).not.toContain("Child");
    const kids = await cli("task", "list", "--parent", parent);
    expect(kids.out).toContain("Child");
    expect(kids.out).not.toContain("Parent");
    expect((await cli("task", "list")).out).toContain("0/1");
    expect((await cli("task", "set", parent, "--status", "done")).out).toContain(
      "1 subtask(s) are still open",
    );
  });

  test("t17_--clear empties a field and --comment only adds", async () => {
    const key = await add("Has text", "--body", "old", "--comment", "one");
    await cli("task", "set", key, "--comment", "two", "--clear", "body");
    const shown = (await cli("task", "show", key)).out;
    expect(shown).not.toContain("old");
    expect(shown).toContain("one");
    expect(shown).toContain("two");
  });

  test("runs are attached with --run and --add-run and searched with --run", async () => {
    const key = await add("With runs", "--run", "r_0mvimyn54_tc9o");
    await cli("task", "set", key, "--add-run", "r_0mvin1n0q_c91r");
    expect((await cli("task", "show", key)).out).toContain("r_0mvimyn54_tc9o, r_0mvin1n0q_c91r");
    expect((await cli("task", "list", "--run", "r_0mvin1n0q_c91r")).out).toContain(key);
    expect((await cli("task", "list", "--run", "r_0000000aa_zzzz")).out).toContain("no tasks");
  });

  test("t18_--limit and --cursor page through the list", async () => {
    for (const title of ["a", "b", "c"]) await add(title);
    const first = await cli("task", "list", "--limit", "2");
    // The hint repeats the filter the cursor belongs to.
    expect(first.out).toContain("more: kodel task list --limit 2 --cursor ");
    const cursor = /--cursor (\S+)/.exec(first.out)?.[1] as string;
    const second = await cli("task", "list", "--limit", "2", "--cursor", cursor);
    expect(second.out).not.toContain("more:");
    const lines = (text: string) => text.split("\n").filter((l) => l.startsWith("KDL-")).length;
    expect(lines(first.out) + lines(second.out)).toBe(3);
  });

  test("list --json prints the answer as JSON with the same fields the tool gives", async () => {
    const key = await add("Json");
    const answer = JSON.parse((await cli("task", "list", "--json")).out);
    expect(answer).toMatchObject({ ok: true, truncated: false, problems: [] });
    expect(answer.tasks[0]).toMatchObject({ key, title: "Json", status: "todo", state: "todo" });
    const shown = JSON.parse((await cli("task", "show", key, "--json")).out);
    expect(shown.task.key).toBe(key);
  });

  test("t13_--json does not carry characters that reorder or fake a line either", async () => {
    const key = await add("evil ‮title next\u007f");
    for (const args of [
      ["task", "list", "--json"],
      ["task", "show", key, "--json"],
    ]) {
      const out = (await cli(...args)).out;
      for (const raw of ["‮", " ", "\u007f"]) expect(out).not.toContain(raw);
      expect(out).toContain("\\u202e");
      expect(JSON.parse(out)).toBeDefined();
    }
  });

  test("schema capabilities: all six when on, none when off", () => {
    const base = { adapter: "x", statuses: [], fields: [] };
    const plain = (t: string) => t;
    const all = formatSchema(
      {
        ...base,
        capabilities: {
          subtasks: true,
          runs: "attach",
          comment: "append",
          fields: true,
          priority: true,
          types: true,
        },
      },
      plain,
    );
    expect(all).toContain(
      "capabilities:\n  subtasks\n  runs (attach)\n  comments (append)\n  fields\n  priority\n  types\n",
    );
    const none = formatSchema(
      {
        ...base,
        capabilities: {
          subtasks: false,
          runs: "none",
          comment: "none",
          fields: false,
          priority: false,
          types: false,
        },
      },
      plain,
    );
    expect(none).toContain("capabilities: none\n");
  });

  test("schema lists the statuses, the priorities and what the adapter can do", async () => {
    const schema = (await cli("task", "schema")).out;
    for (const part of [
      "adapter: local",
      "todo (todo)",
      "declined (done)",
      "high",
      "normal",
      "capabilities:\n  subtasks\n  runs (full)\n  comments (append)\n  priority\n",
    ]) {
      expect(schema, part).toContain(part);
    }
    expect(schema).not.toMatch(/^ {2}(fields|types)$/m);
    const key = await add("For moves");
    expect((await cli("task", "schema", key)).out).toContain("moves from this status:");
    expect(JSON.parse((await cli("task", "schema", "--json")).out).statuses.length).toBe(4);
  });

  test("doctor says ok, and names a file that cannot be read", async () => {
    await add("Fine");
    const ok = await cli("task", "doctor");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("ok");
    await writeFile(join(dir, ".kodel", "tasks", "KDL-3333.yaml"), "nonsense: [");
    const bad = await cli("task", "doctor");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("KDL-3333.yaml");
    expect(bad.err).toContain("1 problem(s)");
  });

  test("a list shows the problems of the folder on stderr and still lists the rest", async () => {
    await add("Fine");
    await mkdir(join(dir, ".kodel", "tasks"), { recursive: true });
    await writeFile(join(dir, ".kodel", "tasks", "KDL-3333.yaml"), "nonsense: [");
    const listed = await cli("task", "list");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("Fine");
    expect(listed.err).toContain("problem:");
  });
});

describe("the header of the list", () => {
  test("task list starts with a header and aligns the columns", async () => {
    await config(ENABLED);
    const a = await add("Short", "--priority", "high");
    const b = await add("A much longer title", "--priority", "low");
    await cli("task", "set", b, "--comment", "the latest note");
    const lines = (await cli("task", "list")).out.split("\n").filter((l) => !l.startsWith("    "));
    const header = lines[0] ?? "";
    expect(header).toMatch(/^KEY\s+STATUS\s+PRIORITY\s+TITLE\s+SUBTASKS\s+PARENT$/);
    const rows = lines.filter((l) => l.startsWith("KDL-"));
    expect(rows.length).toBe(2);
    for (const col of ["STATUS", "PRIORITY", "TITLE", "SUBTASKS", "PARENT"]) {
      const at = header.indexOf(col);
      for (const row of rows) expect(row[at - 1], `${col} in ${row}`).toBe(" ");
    }
    const row = rows.find((r) => r.startsWith(a)) ?? "";
    expect(row.indexOf("high")).toBe(header.indexOf("PRIORITY"));
    expect(row.indexOf("Short")).toBe(header.indexOf("TITLE"));
  });

  test("the latest comment stays under its row, and subtasks and parent are columns", async () => {
    await config(ENABLED);
    const parent = await add("Parent");
    const child = await add("Child", "--parent", parent);
    await cli("task", "set", child, "--comment", "note here");
    const out = (await cli("task", "list")).out.split("\n");
    const at = out.findIndex((l) => l.startsWith(child));
    expect(out[at]).toMatch(new RegExp(`Child\\s+-\\s+${parent}$`));
    expect(out[at + 1]).toBe('    "note here"');
    expect(out.find((l) => l.startsWith(parent))).toMatch(/\s0\/1\s/);
  });

  test("--no-headers drops the header and nothing else; --json is the same either way", async () => {
    await config(ENABLED);
    await add("Only");
    const withHeader = (await cli("task", "list")).out.split("\n");
    const without = (await cli("task", "list", "--no-headers")).out.split("\n");
    expect(withHeader[0]).toStartWith("KEY");
    expect(without[0]).toStartWith("KDL-");
    expect(without.length).toBe(withHeader.length - 1);
    expect((await cli("task", "list", "--json", "--no-headers")).out).toBe(
      (await cli("task", "list", "--json")).out,
    );
  });

  test("an empty list prints no header", async () => {
    await config(ENABLED);
    expect((await cli("task", "list")).out).toBe("no tasks\n");
  });

  test("control characters in a title cannot break the table", async () => {
    await config(ENABLED);
    await add("bad\u001b[2Jtitle");
    const out = (await cli("task", "list")).out;
    expect(out).not.toContain("\u001b");
    expect(out.split("\n").filter(Boolean).length).toBe(2);
  });
});

describe("refusals are one readable line", () => {
  beforeEach(async () => {
    await config(ENABLED);
  });

  test("an unknown task, an unknown status and an empty change", async () => {
    const missing = await cli("task", "show", "KDL-2222");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("TASK_NOT_FOUND");
    const key = await add("t");
    const status = await cli("task", "set", key, "--status", "finished");
    expect(status.err).toContain("INVALID_TASK");
    expect(status.err).toContain("declined");
    const empty = await cli("task", "set", key);
    expect(empty.err).toContain("nothing to change");
  });

  test("a capability the local adapter lacks is TASK_UNSUPPORTED, not a crash", async () => {
    const result = await cli("task", "add", "x", "--field", "Component=Backend");
    expect(result.code).toBe(1);
    expect(result.err).toContain("TASK_UNSUPPORTED");
  });

  test("--field needs name=value", async () => {
    const result = await cli("task", "add", "x", "--field", "oops");
    expect(result.err).toContain("name=value");
  });

  test("a config that cannot be used says so by name", async () => {
    await config("tasks:\n  enabled: true\n  adapter: trello\n");
    const result = await cli("task", "list");
    expect(result.code).toBe(1);
    expect(result.err).toContain("CONFIG_INVALID");
    expect(result.err).toContain("trello");
  });

  test("t13_what_comes_from_a_task_is_printed_without_control_characters", async () => {
    const key = await add("red \u001b[31mtitle\u001b[0m");
    const out = (await cli("task", "list")).out + (await cli("task", "show", key)).out;
    expect(out).not.toContain("\u001b");
    expect(out).toContain("title");
  });
});

describe("tasks over MCP", () => {
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../src/main.ts"), "--root", dir, "mcp"],
      env: { ...(process.env as Record<string, string>) },
      stderr: "pipe",
    });
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(transport);
    return { client, stderr: transport.stderr };
  };
  const text = (result: unknown) =>
    ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

  test("t3_with_tasks_off_the_agent_has_no_task_tools_and_is_told_nothing", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith("task_"))).toBe(false);
    expect(client.getInstructions() ?? "").not.toContain("task_schema");
    await client.close();
  });

  test("with tasks on the agent has the five tools and the instructions", async () => {
    await config(ENABLED);
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((n) => n.startsWith("task_"))).toEqual([
      "task_schema",
      "task_create",
      "task_list",
      "task_get",
      "task_update",
    ]);
    expect(tools.some((t) => t.name === "pipeline_start")).toBe(true);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("pipeline_start");
    expect(instructions).toContain("task_schema");
    await client.close();
  });

  test("an agent creates a task, the person sees it in the CLI, and the person's change shows to the agent", async () => {
    await config(ENABLED);
    const { client } = await connect();
    const created = JSON.parse(
      text(
        await client.callTool({
          name: "task_create",
          arguments: { title: "Found on the way", body: "a bug" },
        }),
      ),
    );
    expect(created).toMatchObject({
      ok: true,
      task: { title: "Found on the way", status: "todo" },
    });
    const key = created.task.key as string;
    expect((await cli("task", "list")).out).toContain(key);
    await cli("task", "set", key, "--status", "done");
    const seen = JSON.parse(text(await client.callTool({ name: "task_get", arguments: { key } })));
    expect(seen.task.status).toBe("done");
    const open = JSON.parse(text(await client.callTool({ name: "task_list", arguments: {} })));
    expect(open.tasks).toEqual([]);
    await client.close();
  });

  test("an agent finds a problem in the middle of a run: the task is tied to the run and the run goes on", async () => {
    // The directory is not a git repository, so patches are off.
    await config(`${ENABLED}worktree:\n  mode: off\nhistory:\n  changes: { enabled: false }\n`);
    await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
    await writeFile(
      join(dir, ".kodel", "pipelines", "one.yaml"),
      "name: one\nnodes:\n  - slug: write\n    kind: agent\n    prompt: do it\n",
    );
    const { client } = await connect();
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(text(await client.callTool({ name, arguments: args })));
    const started = await call("pipeline_start", { task: "a change" });
    const runId = started.run_id as string;
    expect(started.next.node.slug).toBe("write");

    // The agent learns the tracker's values first, then records the find, then a subtask of it.
    expect((await call("task_schema", {})).statuses.map((s: { name: string }) => s.name)).toContain(
      "declined",
    );
    const found = await call("task_create", {
      title: "Durations print as 0s",
      body: "seen in report.ts while working on a change",
      run: runId,
      priority: "high",
    });
    const sub = await call("task_create", {
      title: "Add a test",
      parent: found.task.key,
      run: runId,
    });
    expect(found.ok && sub.ok).toBe(true);

    // The run did not notice: the same step is still the one to do.
    const after = await call("pipeline_next_step", { run_id: runId });
    expect(after.node.slug).toBe("write");

    // The run can be asked about later, from either side.
    const forRun = await call("task_list", { run: runId });
    expect(forRun.tasks.map((t: { key: string }) => t.key).sort()).toEqual(
      [found.task.key, sub.task.key].sort(),
    );
    expect((await cli("task", "list", "--run", runId)).out).toContain("Durations print as 0s");
    expect((await cli("task", "show", found.task.key)).out).toContain(
      `${sub.task.key}  Add a test`,
    );
    await client.close();
  });

  test("t6_a_parameter_the_adapter_cannot_honour_never_comes_through", async () => {
    await config(ENABLED);
    const { client } = await connect();
    const result = await client.callTool({
      name: "task_create",
      arguments: { title: "t", fields: { Component: "x" } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("fields");
    await client.close();
  });

  test("a config that cannot be used does not take the pipelines down with it", async () => {
    await config("tasks:\n  enabled: true\n  adapter: trello\n");
    const { client, stderr } = await connect();
    let message = "";
    stderr?.on("data", (chunk: Buffer) => {
      message += chunk.toString();
    });
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "pipeline_start")).toBe(true);
    expect(tools.some((t) => t.name.startsWith("task_"))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(message).toContain("the task tools are not served");
    expect(message).toContain("trello");
    await client.close();
  });
});

describe("plural aliases of the command groups", () => {
  test("kodel tasks works like kodel task", async () => {
    await config(ENABLED);
    const added = await cli("tasks", "add", "Aliased");
    expect(added.code).toBe(0);
    const listed = await cli("tasks", "list");
    expect(listed.out).toContain("Aliased");
    expect((await cli("task", "list")).out).toBe(listed.out);
  });

  test("kodel pipelines is accepted like kodel pipeline", async () => {
    const r = await cli("pipelines", "changes", "r_000000000_0000");
    expect(r.err).not.toContain("unknown command");
  });

  test("the alias is not a second entry in the help and a new group gets it from the helper", async () => {
    const help = await cli("--help");
    const text = help.out + help.err;
    expect(text).toContain("task|tasks");
    expect(text.match(/\btasks\b(?!\.)/g)?.length ?? 0).toBeLessThan(3);
    const group = withPlural(new Command("widget"));
    expect(group.aliases()).toEqual(["widgets"]);
  });
});

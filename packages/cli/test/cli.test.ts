import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCli } from "../src/cli";

let dir: string;

const DEMO = [
  "name: demo",
  "nodes:",
  "  - slug: write",
  "    kind: agent",
  "    prompt: write a file for {{task}}",
  "  - slug: approve",
  "    kind: human",
  "    prompt: Looks fine?",
  "  - slug: build",
  "    kind: command",
  `    command: node -e "console.log('built')"`,
  "edges:",
  "  - { from: write, to: approve }",
  "  - { from: approve, to: build }",
  "  - { from: approve, to: write, when: rejected }",
  "  - { from: build, to: write, when: failed }",
  "",
].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cli-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Person {
  interactive?: boolean;
  answer?: boolean;
}

/** Run a command as a person at a terminal who says yes, unless told otherwise. */
async function cliAs(person: Person, ...args: string[]) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const code = await runCli(args, {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: person.interactive ?? true,
    confirm: async (question) => {
      asked.push(question);
      return person.answer ?? true;
    },
  });
  return { code, out, err, asked };
}

const cli = (...args: string[]) => cliAs({}, ...args);

/** A run waiting at the human step, made the way an agent would. */
async function runAtGate() {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
  const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
  await run.completeStep("write", 1);
  await run.waitForRest(5_000);
  return run.runId;
}

describe("status", () => {
  test("says so when there are no runs", async () => {
    expect(await cli("status")).toMatchObject({ code: 0, out: "no runs yet\n" });
  });

  test("lists runs, and shows one with where it waits", async () => {
    const id = await runAtGate();
    const list = await cli("status");
    expect(list.out).toContain(id);
    expect(list.out).toContain("demo");
    const one = await cli("status", id);
    expect(one.out).toContain("waiting:   approve (gate)");
    expect(one.out).toContain("integrity: ok");
  });

  test("an unknown run is an error, not a crash", async () => {
    expect(await cli("status", "nope")).toMatchObject({
      code: 1,
      err: 'kodel: there is no run "nope"\n',
    });
  });
});

describe("gate", () => {
  test("approve passes the gate and waits for the engine's work after it", async () => {
    const id = await runAtGate();
    const result = await cli("gate", "approve", id);
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toContain(`${id}: `);
    // the build command ran in the CLI process before it let go
    const after = await cli("status", id);
    expect(after.out).toContain("write");
    expect(after.out).toContain("approve");
    expect(after.out).toContain("build");
  });

  test("reject needs a reason, and sends the run back with it", async () => {
    const id = await runAtGate();
    expect(await cli("gate", "reject", id)).toMatchObject({ code: 1 });
    expect((await cli("gate", "reject", id, "--reason", "too big")).code).toBe(0);
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const next = await (await host.open(id))?.nextStep();
    expect(next).toMatchObject({ node: { slug: "write", attempt: 2 } });
    expect(JSON.stringify(next)).toContain("too big");
  });

  test("refuses a bad decision word, an unknown run, and a run that waits for nothing", async () => {
    const id = await runAtGate();
    expect((await cli("gate", "maybe", id)).err).toContain('"approve" or "reject"');
    expect((await cli("gate", "approve", "nope")).code).toBe(1);
    await cli("gate", "approve", id);
    const again = await cli("gate", "approve", id);
    expect(again).toMatchObject({ code: 1 });
    expect(again.err).toContain("not waiting for a decision");
  });
});

describe("ack, seal and resume", () => {
  test("a hand-edited state is refused until it is acknowledged", async () => {
    const id = await runAtGate();
    const path = join(dir, ".kodel", "runs", id, "state.json");
    const text = await Bun.file(path).text();
    await writeFile(path, text.replace('"task": "t"', '"task": "t "'));
    expect((await cli("status", id)).out).toContain("integrity: modified");
    expect((await cli("gate", "approve", id)).err).toContain("STATE_MODIFIED_EXTERNALLY");
    expect((await cli("ack", id, "--note", "fixed the task")).out).toContain("accepted");
    expect((await cli("gate", "approve", id)).code).toBe(0);
  });

  test("seal refuses a run that is still going; resume refuses one that is not paused", async () => {
    const id = await runAtGate();
    expect((await cli("seal", id)).code).toBe(1);
    expect((await cli("resume", id)).code).toBe(1);
  });
});

describe("only a person can decide", () => {
  test("without a terminal none of the decision commands runs, and nothing changes", async () => {
    const id = await runAtGate();
    const script = { interactive: false };
    for (const args of [
      ["gate", "approve", id],
      ["gate", "reject", id, "--reason", "no"],
      ["resume", id],
      ["ack", id],
      ["seal", id],
    ]) {
      const result = await cliAs(script, ...args);
      expect(result.code).toBe(1);
      expect(result.err).toContain("for a person at a terminal");
      expect(result.asked).toEqual([]);
    }
    expect((await cli("status", id)).out).toContain("waiting:   approve (gate)");
  });

  test("a person who does not confirm changes nothing", async () => {
    const id = await runAtGate();
    const result = await cliAs({ answer: false }, "gate", "approve", id);
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toContain("not confirmed");
    expect((await cli("status", id)).out).toContain("waiting:   approve (gate)");
  });

  test("the question names what changed since the run stopped at the gate", async () => {
    const id = await runAtGate();
    await writeFile(join(dir, "sneaked.txt"), "added after the checks\n");
    const result = await cliAs({}, "gate", "approve", id);
    expect(result.asked[0]).toContain("1 file(s) changed since the run stopped here");
    expect(result.asked[0]).toContain("sneaked.txt");
  });

  test("with nothing changed the question is plain", async () => {
    const id = await runAtGate();
    const result = await cliAs({}, "gate", "approve", id);
    expect(result.asked[0]).toBe(`Approve "approve" of run ${id}?`);
  });
});

describe("what status shows and does", () => {
  test("control characters in an agent's text cannot move the cursor or fake a line", async () => {
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const { run } = await host.start({
      pipeline: "demo",
      task: "x\u001b[2J\u001b[1;1Hstatus: completed",
      restart: false,
    });
    const list = await cli("status");
    const one = await cli("status", run.runId);
    for (const text of [list.out, one.out]) {
      expect(text).not.toContain("\u001b");
      expect(text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(6);
    }
  });

  test("looking at a run writes nothing", async () => {
    const id = await runAtGate();
    const dirOfRun = join(dir, ".kodel", "runs", id);
    const before = [
      await readFile(join(dirOfRun, "state.json"), "utf8"),
      await readFile(join(dirOfRun, "journal.jsonl"), "utf8"),
    ];
    await cli("status", id);
    await cli("status");
    const after = [
      await readFile(join(dirOfRun, "state.json"), "utf8"),
      await readFile(join(dirOfRun, "journal.jsonl"), "utf8"),
    ];
    expect(after).toEqual(before);
  });
});

describe("mcp over stdio", () => {
  test("a real client sees the tools and can start a run", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../src/main.ts"), "--root", dir, "mcp"],
      env: { ...(process.env as Record<string, string>) },
      stderr: "pipe",
    });
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("pipeline_start");
    const started = await client.callTool({ name: "pipeline_start", arguments: { task: "t" } });
    const body = JSON.parse(((started.content as { text: string }[])[0] as { text: string }).text);
    expect(body).toMatchObject({ ok: true, next: { node: { slug: "write" } } });
    await client.close();
  });
});

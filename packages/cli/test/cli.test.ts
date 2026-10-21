import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { plain, runCli } from "../src/cli";

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
  // These tests are about the root; the run's own worktree is tested in worktree.test.ts.
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Person {
  interactive?: boolean;
  /** One answer for every question, or one answer per question in turn (the last one repeats). */
  answer?: boolean | boolean[];
  /** The environment the command runs in. */
  environment?: Record<string, string | undefined>;
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
    environment: person.environment ?? {},
    confirm: async (question) => {
      asked.push(question);
      const answers = person.answer ?? true;
      if (typeof answers === "boolean") return answers;
      return answers[Math.min(asked.length - 1, answers.length - 1)] ?? true;
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

  test("--json lists the runs as an array of objects", async () => {
    const id = await runAtGate();
    const result = await cli("status", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([
      { runId: id, pipeline: "demo", status: "running", task: "t" },
    ]);
  });

  test("--json is for the list: with a run id the text of that run is printed", async () => {
    const id = await runAtGate();
    const result = await cli("status", id, "--json");
    expect(result.code).toBe(0);
    expect(result.out).toContain(`run:       ${id}`);
    expect(() => JSON.parse(result.out)).toThrow();
  });

  test("--json with no runs is an empty array", async () => {
    const result = await cli("status", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([]);
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

describe("report", () => {
  test("shows where the time went for the latest run, and for one that is named", async () => {
    const id = await runAtGate();
    const latest = await cli("report");
    expect(latest.code).toBe(0);
    expect(latest.out).toContain(`run ${id}`);
    expect(latest.out).toContain("waiting for a person");
    expect(latest.out).toContain("write");
    expect(latest.out).toContain("(a person decides)");
    expect(latest.out).toBe((await cli("report", id)).out);
  });

  test("with --json it is the data, for anything that wants to read it", async () => {
    const id = await runAtGate();
    const parsed = JSON.parse((await cli("report", id, "--json")).out);
    expect(parsed).toMatchObject({ runId: id, status: "running", extra_attempts: 0 });
    expect(parsed.nodes.map((n: { node: string }) => n.node)).toEqual(["write", "approve"]);
  });

  test("a rejection and its reason show under what did not pass", async () => {
    const id = await runAtGate();
    await cli("gate", "reject", id, "--reason", "too big");
    const out = (await cli("report", id)).out;
    expect(out).toContain("what did not pass");
    expect(out).toContain("approve #1 rejected: too big");
    expect(out).toContain("1 extra attempt(s)");
  });

  test("it shows what the agent said it did, and which of its calls the engine refused", async () => {
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const { run } = await host.start({ pipeline: "demo", task: "t", restart: false });
    const mine = (await host.open(run.runId)) as NonNullable<Awaited<ReturnType<typeof host.open>>>;
    await mine.completeStep("write", 9); // not the attempt it is on: refused
    await mine.completeStep("write", 1, "made the file and ran the tests");
    await mine.waitForRest(10_000);
    const text = (await cli("report", run.runId)).out;
    expect(text).toContain("1 call(s) refused");
    expect(text).toContain("what the agent said it did:");
    expect(text).toContain("write #1: made the file and ran the tests");
    expect(text).toContain("calls the engine refused:");
    expect(text).toContain("complete_step write: ATTEMPT_MISMATCH");
    const json = JSON.parse((await cli("report", run.runId, "--json")).out);
    expect(json.refused).toBe(1);
    expect(json.nodes[0].attempts[0].summary).toBe("made the file and ran the tests");
  });

  test("no runs, or an unknown one, is an error and not a crash", async () => {
    expect(await cli("report")).toMatchObject({ code: 1, err: "kodel: there are no runs yet\n" });
    expect((await cli("report", "r_000000009_aaaa")).code).toBe(1);
  });

  test("control characters from the agent cannot get into the report", async () => {
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    await host.start({ pipeline: "demo", task: "x\u001b[2Jfake", restart: false });
    expect((await cli("report")).out).not.toContain("\u001b");
  });
});

describe("a gate whose record of the files cannot be used", () => {
  /** Make the record of the files at the gate unusable, as `git gc` or a broken repository would. */
  async function spoilGateRecord(id: string, how: "bogus" | "missing") {
    const file = join(dir, ".kodel", "runs", id, "snapshots.json");
    const snapshots = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    const key = Object.keys(snapshots).find((k) => k.startsWith("gate:approve")) as string;
    if (how === "bogus") snapshots[key] = "0".repeat(40);
    else delete snapshots[key];
    await writeFile(file, JSON.stringify(snapshots));
  }

  test("approving says it cannot tell what changed, and needs a second yes", async () => {
    for (const how of ["bogus", "missing"] as const) {
      const id = await runAtGate();
      await spoilGateRecord(id, how);
      const result = await cliAs({ answer: [true, false] }, "gate", "approve", id);
      expect(result.code, how).toBe(1);
      expect(result.asked.length, how).toBe(2);
      expect(result.asked[0], how).toContain("WARNING: the engine cannot tell what changed");
      expect(result.asked[1], how).toContain("could not be checked");
      expect((await cli("status", id)).out, how).toContain("waiting:   approve (gate)");
      await cli("gate", "reject", id, "--reason", "start over"); // leave nothing waiting
      await rm(join(dir, ".kodel"), { recursive: true, force: true });
      await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
      await writeFile(join(dir, ".kodel", "pipelines", "demo.yaml"), DEMO);
    }
  });

  test("with both answers yes it goes through, and the warning was shown before", async () => {
    const id = await runAtGate();
    await spoilGateRecord(id, "bogus");
    const result = await cliAs({ answer: true }, "gate", "approve", id);
    expect(result.code).toBe(0);
    expect(result.asked[0]).toContain("WARNING");
    expect(result.asked.length).toBe(2);
  });

  test("rejecting is safe whatever was done, so it asks once, with the warning", async () => {
    const id = await runAtGate();
    await spoilGateRecord(id, "missing");
    const result = await cliAs({}, "gate", "reject", id, "--reason", "no");
    expect(result.code).toBe(0);
    expect(result.asked.length).toBe(1);
    expect(result.asked[0]).toContain("WARNING");
  });

  test("a gate whose files were compared says nothing alarming, and asks once", async () => {
    const id = await runAtGate();
    const result = await cliAs({}, "gate", "approve", id);
    expect(result.code).toBe(0);
    expect(result.asked.length).toBe(1);
    expect(result.asked[0]).not.toContain("WARNING");
  });
});

describe("commands a person runs refuse to run from the engine", () => {
  test("gate, resume, ack and seal are refused whatever the terminal, and ask nothing", async () => {
    const id = await runAtGate();
    const inEngine = { environment: { KODEL_ENGINE: "1" } };
    for (const args of [
      ["gate", "approve", id],
      ["gate", "reject", id, "--reason", "no"],
      ["resume", id],
      ["ack", id],
      ["seal", id],
    ]) {
      const result = await cliAs(inEngine, ...args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toContain("will not run from a command the engine runs");
      expect(result.asked).toEqual([]);
    }
    expect((await cli("status", id)).out).toContain("waiting:   approve (gate)");
  });

  test("looking is still allowed from there", async () => {
    const id = await runAtGate();
    const result = await cliAs({ environment: { KODEL_ENGINE: "1" } }, "status", id);
    expect(result.code).toBe(0);
  });
});

describe("what a person is shown cannot be bent by files an agent can write", () => {
  const evil = `x${String.fromCodePoint(0x1b)}[2Jy${String.fromCodePoint(0x202e)}z${String.fromCodePoint(0x2028)}w${String.fromCodePoint(0x85)}v`;

  test("plain takes out controls, reordering marks and separators, and keeps ordinary text", () => {
    const cleaned = plain(evil);
    for (const code of [0x1b, 0x202e, 0x2028, 0x85]) {
      expect(cleaned.includes(String.fromCodePoint(code)), `U+${code.toString(16)}`).toBe(false);
    }
    expect(cleaned).toBe("x [2Jy z w v");
    expect(plain("файл.txt, 日本語, 🙂")).toBe("файл.txt, 日本語, 🙂");
    expect(plain("a\n\n\tb")).toBe("a b"); // a run of them is one space
  });

  test("an error that repeats what was typed does not carry the escape sequences", async () => {
    const result = await cli("status", evil);
    expect(result.code).toBe(1);
    expect(result.err.includes(String.fromCodePoint(0x1b))).toBe(false);
    expect(result.err.includes(String.fromCodePoint(0x202e))).toBe(false);
  });

  test("a run whose meta.json names another run is not listed, and its text is never shown", async () => {
    const id = await runAtGate();
    const file = join(dir, ".kodel", "runs", id, "meta.json");
    const meta = JSON.parse(await readFile(file, "utf8")) as { runId: string };
    meta.runId = `r_000000000_aaaa${String.fromCodePoint(0x1b)}[2J`;
    await writeFile(file, JSON.stringify(meta));
    const list = await cli("status");
    expect(list.out).toBe("no runs yet\n");
    expect(list.out.includes(String.fromCodePoint(0x1b))).toBe(false);
  });
});

describe("status and report when the files of a run are not as they should be", () => {
  test("a state that names a step that is not there is said to be unreadable, not a crash", async () => {
    const id = await runAtGate();
    const file = join(dir, ".kodel", "runs", id, "state.json");
    const state = JSON.parse(await readFile(file, "utf8")) as { active: { node: string }[] };
    (state.active[0] as { node: string }).node = "ghost";
    await writeFile(file, JSON.stringify(state));
    const result = await cli("status", id);
    expect(result.code).toBe(0);
    expect(result.out).toContain("integrity: modified");
    expect(result.out).toContain("cannot be worked out from this state");
  });

  test("a report says whether the run's files are as kodel left them, and warns when they are not", async () => {
    const id = await runAtGate();
    expect((await cli("report", id)).out).toContain("files: integrity ok, seal open");
    const file = join(dir, ".kodel", "runs", id, "state.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"task": "t"', '"task": "u"'));
    const text = (await cli("report", id)).out;
    expect(text).toContain("WARNING: the files of this run were changed outside kodel");
    const parsed = JSON.parse((await cli("report", id, "--json")).out);
    expect(parsed).toMatchObject({ integrity: "modified", seal: "open" });
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
    // The rules of working with a pipeline come with the server, not from a file in the project.
    const instructions = client.getInstructions() ?? "";
    for (const part of ["pipeline_start", "tell_the_person", "wait_s", "pipeline_feedback"]) {
      expect(instructions, part).toContain(part);
    }
    const started = await client.callTool({ name: "pipeline_start", arguments: { task: "t" } });
    const body = JSON.parse(((started.content as { text: string }[])[0] as { text: string }).text);
    expect(body).toMatchObject({ ok: true, next: { node: { slug: "write" } } });
    await client.close();
  });

  test("a server whose agent closed the pipe exits, and does not wait for ever", async () => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "../src/main.ts"), "--root", dir, "mcp"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    await new Promise((resolve) => setTimeout(resolve, 800)); // let it start and begin to listen
    child.stdin.end();
    const outcome = await Promise.race([
      exited,
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 5_000)),
    ]);
    if (outcome === "still running") child.kill("SIGKILL");
    expect(outcome).toBe(0);
  });

  // The agent's session ends while a command of the pipeline is still going. The server must not
  // leave that command running with nobody to report to: the next session starts it again.
  const orphanCheck = async (script: string, waitMs: number) => {
    {
      const marker = `kodel-orphan-check-${Date.now()}`;
      await writeFile(
        join(dir, ".kodel", "pipelines", "longcmd.yaml"),
        [
          "name: longcmd",
          "nodes:",
          "  - slug: wait",
          "    kind: command",
          `    command: node -e "${script}" ${marker}`,
          "  - slug: after",
          "    kind: command",
          `    command: node -e "process.exit(0)"`,
          "edges:",
          "  - { from: wait, to: after }",
          "  - { from: wait, to: after, when: failed }",
          "  - { from: after, to: wait, when: failed }",
          "",
        ].join("\n"),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "../src/main.ts"), "--root", dir, "mcp"],
        env: { ...(process.env as Record<string, string>) },
        stderr: "pipe",
      });
      const client = new Client({ name: "agent", version: "0.0.0" });
      await client.connect(transport);
      const started = await client.callTool({
        name: "pipeline_start",
        arguments: { task: "t", pipeline: "longcmd" },
      });
      const running = () =>
        execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" }).includes(marker);
      try {
        expect(running(), `the command never started: ${JSON.stringify(started.content)}`).toBe(
          true,
        );
        await client.close();
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        expect(running(), "the command was left running after the server exited").toBe(false);
      } finally {
        try {
          execFileSync("pkill", ["-f", marker]);
        } catch {
          // none left, which is the point
        }
      }
    }
  };

  test.skipIf(process.platform === "win32")(
    "when the agent goes away, the command the server was running is stopped",
    () => orphanCheck("setTimeout(() => {}, 60000)", 3_500),
    20_000,
  );

  // A command that ignores the polite request to stop is killed after a grace period, and the
  // server has to stay up for that long: exiting at once would leave it running, orphaned.
  test.skipIf(process.platform === "win32")(
    "a command that ignores SIGTERM does not outlive the server either",
    () => orphanCheck("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)", 5_000),
    20_000,
  );
});

describe("a run in its own worktree", () => {
  async function runInWorktree() {
    const host = new LocalPipelineHost({
      root: dir,
      heartbeatMs: 0,
      worktree: { mode: "auto", dir: ".kodel/worktrees" },
    });
    const { run, workdir } = await host.start({ pipeline: "demo", task: "wt", restart: false });
    return { id: run.runId, workdir: workdir?.path ?? "", branch: workdir?.branch ?? "" };
  }

  test("tNN_status_and_report_show_where_the_run_works", async () => {
    const { id, workdir, branch } = await runInWorktree();
    expect((await cli("status")).out).toContain(`in ${workdir}`);
    const one = (await cli("status", id)).out;
    expect(one).toContain(`workdir:   ${workdir}`);
    expect(one).toContain(`branch:    ${branch}`);
    expect(JSON.parse((await cli("status", "--json")).out)[0].workdir).toBe(workdir);
    expect((await cli("report", id)).out).toContain(`workdir: ${workdir}`);
    expect(JSON.parse((await cli("report", id, "--json")).out).workdir).toBe(workdir);
  });

  test("tNN_a_gate_reads_the_workdir_from_the_run_and_shows_what_changed_there", async () => {
    const { id, workdir } = await runInWorktree();
    await writeFile(join(workdir, "out.txt"), "hi\n");
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const run = await host.open(id);
    await run?.completeStep("write", 1);
    await run?.waitForRest(5_000);
    await writeFile(join(workdir, "after.txt"), "later\n");
    await writeFile(join(dir, "in-the-root.txt"), "not this\n");

    const result = await cli("gate", "approve", id);
    expect(result.code).toBe(0);
    expect(result.asked[0]).toContain("after.txt");
    expect(result.asked[0]).not.toContain("in-the-root.txt");
  });

  test("tNN_a_gate_whose_worktree_is_gone_cannot_tell_what_changed_and_says_so", async () => {
    const { id, workdir } = await runInWorktree();
    await writeFile(join(workdir, "out.txt"), "hi\n");
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const run = await host.open(id);
    await run?.completeStep("write", 1);
    await run?.waitForRest(5_000);
    execFileSync("git", ["worktree", "remove", "--force", workdir], { cwd: dir, stdio: "ignore" });

    const result = await cli("gate", "approve", id);
    expect(result.asked[0]).toContain("WARNING");
    expect(result.asked[0]).toContain("WORKDIR_MISSING");
    expect(result.asked.length).toBe(2); // approving needs one more yes
  });
});

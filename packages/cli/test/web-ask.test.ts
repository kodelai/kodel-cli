/**
 * Questions about a run from the web UI (T-44): off unless `kodel web --ask` turns them on; a question
 * goes to a read-only fork of the run's Claude Code session, a follow-up to that fork, and the answer is
 * redacted before it leaves the machine. The `claude` process is a fake: the tests check what it is given.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@kodel-ai/local";
import { runCli } from "../src/cli";
import { Asker, type AskProcess, type Spawner } from "../src/web/ask";
import { demoApi } from "../src/web/command";
import { DeviceStore } from "../src/web/devices";
import { createHandler, type WebApi } from "../src/web/handler";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-ask-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FORK = "11111111-2222-3333-4444-555555555555";

interface Call {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}

/** A `claude` that answers with the given text and names the fork, at once. */
function fakeClaude(answer: string, calls: Call[], gate?: Promise<void>): Spawner {
  return (argv, options) => {
    calls.push({ argv, ...options });
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: FORK }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: `${options.cwd}/src/a.ts` } },
          ],
        },
      }),
      JSON.stringify({ type: "result", result: answer, is_error: false, session_id: FORK }),
    ];
    async function* gen() {
      if (gate) await gate;
      yield* lines;
    }
    const proc: AskProcess = {
      lines: gen(),
      ended: (gate ?? Promise.resolve()).then(() => ({ code: 0, stderr: "" })),
      kill: () => undefined,
    };
    return proc;
  };
}

async function settled(asker: Asker, runId: string) {
  for (let i = 0; i < 100; i++) {
    const t = await asker.thread(runId);
    if (!t.turns.some((x) => x.state === "running")) return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the turn did not end");
}

const located = { ok: true as const, sessionId: "run-session-1", cwd: "/work/tree" };

describe("asking the agent", () => {
  test("t44_ask_is_a_flag_of_the_server_not_a_config_key", async () => {
    let out = "";
    await runCli(["web", "--help"], {
      cwd: dir,
      out: (t) => {
        out += t;
      },
      err: () => undefined,
      interactive: false,
      environment: { KODEL_STATE_DIR: join(dir, "state") },
      select: async () => [],
      confirm: async () => true,
    });
    expect(out).toContain("--ask");
    // The project config stays what every engine reads: an older one refuses a key it does not know.
    await writeFile(join(dir, "config.yaml"), "version: 1\nweb:\n  ask: true\n");
    await expect(loadConfig(dir)).rejects.toThrow();
  });

  test("t44_ask_route_is_refused_when_off", async () => {
    const api: WebApi = { ...(await demoApi(Date.now())), source: "project" };
    delete api.ask;
    delete api.askThread;
    const devices = new DeviceStore(join(dir, "web"));
    const web = createHandler({
      api,
      devices,
      assets: { html: "", js: "", css: "" },
      secureCookie: false,
      audit: () => undefined,
    });
    const { code } = await devices.createPairing();
    const paired = await web.handle({
      method: "POST",
      path: "/api/pair",
      query: new URLSearchParams(),
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code, name: "p" }),
      ip: "127.0.0.1",
    });
    const cookie = (paired.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const me = await web.handle({
      method: "GET",
      path: "/api/me",
      query: new URLSearchParams(),
      headers: { host: "127.0.0.1:4317", cookie },
      body: "",
      ip: "127.0.0.1",
    });
    expect(JSON.parse(String(me.body)).canAsk).toBe(false);
    const asked = await web.handle({
      method: "POST",
      path: "/api/runs/r_1/ask",
      query: new URLSearchParams(),
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ question: "why?" }),
      ip: "127.0.0.1",
    });
    expect(asked.status).toBe(403);
  });

  test("t44_ask_forks_the_session_and_may_only_read", async () => {
    const calls: Call[] = [];
    const asker = new Asker({
      dir,
      locate: async () => located,
      spawn: fakeClaude("Because the plan said so.", calls),
      env: { PATH: "/bin", KODEL_RUN_ID: "r_1", KODEL_STATE_DIR: "/x" },
    });
    await asker.ask("r_1", "why did you change a.ts?");
    const thread = await settled(asker, "r_1");
    expect(thread.turns[0]).toMatchObject({
      state: "done",
      answer: "Because the plan said so.",
      tools: ["Read src/a.ts"],
    });
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.cwd).toBe("/work/tree");
    const argv = call.argv.join(" ");
    expect(argv).toContain("--resume run-session-1 --fork-session");
    expect(argv).toContain("--tools Read,Grep,Glob");
    expect(argv).toContain("--permission-mode dontAsk");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--setting-sources user");
    // The question goes in on stdin, never in argv; nothing ties the fork to the run.
    expect(argv).not.toContain("why did you change");
    expect(call.stdin).toContain("why did you change a.ts?");
    expect(Object.keys(call.env).filter((k) => k.startsWith("KODEL_"))).toEqual([]);
  });

  test("t44_ask_carries_the_picked_lines_and_their_notes", async () => {
    const calls: Call[] = [];
    const asker = new Asker({ dir, locate: async () => located, spawn: fakeClaude("ok", calls) });
    await asker.ask("r_1", "", [
      { place: "src/a.ts:3-4", code: "+const a = 1;\n+const b = 2;", note: "why two?" },
      { place: "src/b.ts:9", code: "-old()", note: "" },
    ]);
    const thread = await settled(asker, "r_1");
    expect(thread.turns[0]?.refs?.map((r) => r.place)).toEqual(["src/a.ts:3-4", "src/b.ts:9"]);
    const stdin = calls[0]?.stdin ?? "";
    expect(stdin).toContain("1. src/a.ts:3-4");
    expect(stdin).toContain("The person asks: why two?");
    expect(stdin).toContain("+const b = 2;");
    expect(stdin).toContain("2. src/b.ts:9");
    // Nothing to ask is refused, and so is a place too long to be one.
    await expect(asker.ask("r_1", "  ")).rejects.toMatchObject({ code: "bad_question" });
    await expect(
      asker.ask("r_1", "", [{ place: "x", code: "y".repeat(5_000), note: "" }]),
    ).rejects.toMatchObject({ code: "bad_question" });
  });

  test("t44_follow_up_resumes_the_fork", async () => {
    const calls: Call[] = [];
    const options = { dir, locate: async () => located, spawn: fakeClaude("ok", calls) };
    const asker = new Asker(options);
    await asker.ask("r_1", "first");
    await settled(asker, "r_1");
    // Another server, later: the fork is kept on disk.
    const again = new Asker(options);
    await again.ask("r_1", "second");
    await settled(again, "r_1");
    const second = calls[1]?.argv.join(" ") ?? "";
    expect(second).toContain(`--resume ${FORK}`);
    expect(second).not.toContain("--fork-session");
    expect((await again.thread("r_1")).turns.map((t) => t.question)).toEqual(["first", "second"]);
  });

  test("t44_ask_answer_is_redacted", async () => {
    const key = `AKIA${"B".repeat(16)}`;
    const asker = new Asker({
      dir,
      locate: async () => located,
      spawn: fakeClaude(`The key is ${key}`, []),
    });
    await asker.ask("r_1", "what key?");
    const thread = await settled(asker, "r_1");
    expect(JSON.stringify(thread)).not.toContain(key);
  });

  test("t44_one_question_at_a_time_per_run", async () => {
    let open = () => undefined as void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const asker = new Asker({
      dir,
      locate: async () => located,
      spawn: fakeClaude("ok", [], gate),
    });
    await asker.ask("r_1", "first");
    await expect(asker.ask("r_1", "second")).rejects.toMatchObject({ code: "busy" });
    open();
    await settled(asker, "r_1");
  });

  test("t44_two_first_questions_at_once_start_one_agent", async () => {
    let open = () => undefined as void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const calls: Call[] = [];
    let release = () => undefined as void;
    const located_ = new Promise<void>((r) => {
      release = r;
    });
    const asker = new Asker({
      dir,
      // The run's session is found slowly: both questions are past the first read before either has a turn.
      locate: async () => {
        await located_;
        return located;
      },
      spawn: fakeClaude("ok", calls, gate),
    });
    const both = Promise.allSettled([asker.ask("r_1", "one"), asker.ask("r_1", "two")]);
    release();
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    open();
    const t = await settled(asker, "r_1");
    expect(calls).toHaveLength(1);
    expect(t.turns).toHaveLength(1);
  });

  test("t44_first_read_of_a_thread_is_shared", async () => {
    await writeFile(
      join(dir, "r_1.json"),
      JSON.stringify({ v: 1, fork: FORK, cwd: "/work/tree", turns: [] }),
    );
    const asker = new Asker({ dir, locate: async () => located, spawn: fakeClaude("ok", []) });
    // A page reads the thread while it asks: the turn must not be lost to a second copy of the thread.
    const [, asked] = await Promise.all([asker.thread("r_1"), asker.ask("r_1", "q")]);
    expect(asked.turns).toHaveLength(1);
    expect((await settled(asker, "r_1")).turns).toHaveLength(1);
  });

  test("t44_ask_answer_uses_the_projects_redaction", async () => {
    const asker = new Asker({
      dir,
      locate: async () => located,
      spawn: fakeClaude("the code is PROJECT-SECRET-42", []),
      redact: (t) => t.replaceAll("PROJECT-SECRET-42", "[REDACTED]"),
    });
    await asker.ask("r_1", "what?");
    const t = await settled(asker, "r_1");
    expect(t.turns[0]?.answer).toBe("the code is [REDACTED]");
  });

  test("t44_ask_without_a_session_says_why", async () => {
    const asker = new Asker({
      dir,
      locate: async () => ({ ok: false, message: "No Claude Code session is known for this run." }),
      spawn: fakeClaude("ok", []),
    });
    await expect(asker.ask("r_1", "why?")).rejects.toMatchObject({ code: "no_session" });
    expect((await asker.thread("r_1")).turns).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

const SRC = join(import.meta.dir, "../src");
const INDEX = join(".kodel", "sessions.jsonl");

let base: string;
let project: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-hook-cli-")));
  project = join(base, "project");
  await mkdir(join(project, ".kodel"), { recursive: true });
  await writeFile(join(project, ".kodel", "config.yaml"), "version: 1\n");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Start `bun <script> <args>` and feed it `input`; a child that stops reading early is not an error. */
function run(
  script: string,
  args: string[],
  input: string | Buffer | (() => AsyncIterable<Buffer>),
  cwd = base,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SRC, script), ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    void (async () => {
      if (typeof input === "function") {
        for await (const chunk of input())
          if (!child.stdin.write(chunk)) await new Promise((r) => child.stdin.once("drain", r));
        child.stdin.end();
      } else child.stdin.end(input);
    })().catch(() => {});
  });
}

const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "s-1",
    transcript_path: "/t/s-1.jsonl",
    cwd: project,
    ...over,
  });

const indexLines = async () =>
  (await readFile(join(project, INDEX), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { session_id: string });

describe("kodel-hook (the small entry)", () => {
  test("a_session_start_in_a_project_is_recorded_silently", async () => {
    const out = await run("hook-bin.ts", ["claude-code"], event());
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await indexLines()).map((l) => l.session_id)).toEqual(["s-1"]);
  });

  test("the_same_event_through_the_main_binary_works_too", async () => {
    const out = await run("main.ts", ["hook", "codex"], event({ session_id: "s-2" }));
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await indexLines()).map((l) => l.session_id)).toEqual(["s-2"]);
  });

  test("outside_a_project_nothing_is_written_and_it_exits_zero", async () => {
    const plain = join(base, "plain");
    await mkdir(plain);
    const out = await run("hook-bin.ts", ["claude-code"], event({ cwd: plain }), plain);
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await readdir(plain)).toEqual([]);
    expect((await readdir(base)).sort()).toEqual(["plain", "project"]);
  });

  test("every_failure_path_exits_zero_with_nothing_on_stdout_or_stderr", async () => {
    // A directory where the index goes: the handler fails and the failure is only logged.
    await mkdir(join(project, INDEX));
    const bad: [string, string[], string | Buffer][] = [
      ["a handler that cannot write", ["claude-code"], event()],
      ["empty stdin", ["claude-code"], ""],
      ["not json", ["claude-code"], "not json"],
      ["truncated json", ["claude-code"], event().slice(0, 20)],
      ["json of the wrong shape", ["claude-code"], "[1,2,3]"],
      ["binary data", ["claude-code"], Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])],
      ["terminal escapes", ["claude-code"], `\u001b[2J\u001b]0;x\u0007${event()}`],
      ["escapes in fields", ["claude-code"], event({ session_id: "a\u001b[31m", cwd: "/x\u0000" })],
      ["no agent", [], event()],
      ["an unknown agent", ["emacs"], event()],
      ["extra arguments", ["claude-code", "--what", "ever"], event()],
    ];
    for (const [label, args, input] of bad) {
      const out = await run("hook-bin.ts", args, input);
      expect({ label, ...out }).toEqual({ label, code: 0, stdout: "", stderr: "" });
    }
    expect(await readFile(join(project, ".kodel", "hooks.log"), "utf8")).toContain(
      "session-registrar",
    );
  });

  test("a_hundred_megabytes_on_stdin_are_dropped_and_it_still_exits_zero", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x7b);
    const started = Date.now();
    const out = await run("hook-bin.ts", ["claude-code"], async function* () {
      for (let i = 0; i < 100; i += 1) yield chunk;
    });
    expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await indexLines()).toEqual([]);
  });

  test("two_processes_at_once_never_tear_a_line", async () => {
    // Long lines on purpose: a torn write shows as invalid JSON or as a missing session.
    const long = "p".repeat(3500);
    const starts = Array.from({ length: 40 }, (_, i) =>
      run(
        "hook-bin.ts",
        ["claude-code"],
        event({ session_id: `c-${i}`, transcript_path: `/${long}/${i}` }),
      ),
    );
    const outs = await Promise.all(starts);
    for (const out of outs) expect(out).toEqual({ code: 0, stdout: "", stderr: "" });
    const text = await readFile(join(project, INDEX), "utf8");
    const rows = text.split("\n").filter(Boolean);
    expect(rows).toHaveLength(40);
    const ids = rows.map((row) => (JSON.parse(row) as { session_id: string }).session_id);
    expect(new Set(ids).size).toBe(40);
  });

  test("a_closed_stdin_is_the_end_of_the_input", async () => {
    const child = spawn(process.execPath, [join(SRC, "hook-bin.ts"), "claude-code"], {
      cwd: base,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
  });
});

describe("kodel hook (the command)", () => {
  async function hook(stdin: () => Promise<string>, agent = "claude-code") {
    let out = "";
    let err = "";
    const code = await runCli(["hook", agent], {
      cwd: base,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      interactive: false,
      confirm: async () => false,
      select: async () => [],
      readStdin: stdin,
    });
    return { code, out, err };
  }

  test("it_records_the_session_and_prints_nothing", async () => {
    expect(await hook(async () => event())).toEqual({ code: 0, out: "", err: "" });
    expect((await indexLines()).map((l) => l.session_id)).toEqual(["s-1"]);
  });

  test("a_stdin_that_fails_is_no_event", async () => {
    expect(
      await hook(async () => {
        throw new Error("EPIPE");
      }),
    ).toEqual({ code: 0, out: "", err: "" });
    expect(await indexLines()).toEqual([]);
  });

  test("garbage_and_an_unknown_agent_exit_zero", async () => {
    expect(await hook(async () => "garbage")).toEqual({ code: 0, out: "", err: "" });
    expect(await hook(async () => event(), "emacs")).toEqual({ code: 0, out: "", err: "" });
  });
});

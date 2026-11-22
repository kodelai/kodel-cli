import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity, resolveBase, sessionDirOf, sessionPlace } from "@kodel-ai/local";
import { type SessionAdapter, SessionError, type SessionListEntry } from "@kodel-ai/pipeline-core";
import {
  AGENT_HUMAN_COMMANDS,
  AGENT_READ_COMMANDS,
  agentLabel,
  conversationLabel,
  groupNote,
  pipesAdapter,
  resolveSession,
  stateLabel,
} from "../src/agent-commands";
import type { AttachClientOptions, AttachResult, AttachTerminal } from "../src/attach-client";
import { type CliEnv, runCli } from "../src/cli";
import { FakeSessions } from "./fake-sessions";

// `stop` signals only a process whose identity it can check; a sandbox without the process table skips these, visibly.
const tableTest = test.skipIf(
  processIdentity(process.pid) === undefined && process.env.KODEL_REQUIRE_PROCTABLE !== "1",
);

// Sessions do not run on Windows: there every agent command answers `PLATFORM_UNSUPPORTED` first.
const unixTest = test.skipIf(process.platform === "win32");

const launcher = { exec: process.execPath, args: [join(import.meta.dir, "../src/main.ts")] };

let dir: string;
let state: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-cliagent-")));
  state = await realpath(await mkdtemp(join(tmpdir(), "kodel-cliagent-state-")));
  await mkdir(join(dir, ".kodel"), { recursive: true });
  await writeFile(join(dir, ".kodel", "config.yaml"), "");
});
afterEach(async () => {
  const listed = await cli({ interactive: false }, "agent", "ls", "--json");
  for (const row of JSON.parse(listed.out || "[]") as { id: string }[]) {
    await cli({ interactive: true }, "agent", "stop", row.id);
  }
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

interface Opts {
  interactive: boolean;
  engine?: boolean;
  confirm?: boolean;
  /** What the PTY check answers; under Bun the real one refuses. */
  pty?: { ok: true } | { ok: false; reason: string };
  platform?: string;
  /** Called when a command asks for the size of the terminal. */
  size?: () => { cols: number; rows: number } | undefined;
  /** The session adapter and the attach client, in place of the machine's own. */
  agent?: CliEnv["agent"];
  /** Every question a command asked, in order. */
  asked?: string[];
}

async function cli(opts: Opts, ...args: string[]) {
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
    interactive: opts.interactive,
    environment: { KODEL_STATE_DIR: state, ...(opts.engine ? { KODEL_ENGINE: "1" } : {}) },
    confirm: async (question) => {
      opts.asked?.push(question);
      return opts.confirm ?? true;
    },
    select: async () => [],
    sessionLauncher: launcher,
    ...(opts.pty ? { ptyProbe: () => opts.pty as NonNullable<Opts["pty"]> } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.size ? { terminalSize: opts.size } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  });
  return { code, out, err };
}

describe("kodel agent", () => {
  test("tA_agent_ls_is_read_only_and_works_for_an_engine", async () => {
    const empty = await cli({ interactive: false, engine: true, platform: "linux" }, "agent", "ls");
    expect(empty).toMatchObject({ code: 0, out: "no agents\n" });
    expect(AGENT_READ_COMMANDS).toContain("agent ls");
  });

  test("tA_every_human_command_refuses_in_session", async () => {
    const argsFor: Record<string, string[]> = {
      "agent stop": ["agent", "stop", "a_000000000_0000"],
      "agent rm": ["agent", "rm", "a_000000000_0000"],
      "agent exec": ["agent", "exec", "--", "true"],
      "agent forget-name": ["agent", "forget-name", "x"],
      "agent attach": ["agent", "attach", "x"],
      // not a command of its own: the terminal form of `exec` refuses like the plain one
      "agent exec --pty": ["agent", "exec", "--pty", "--", "true"],
      "agent start": ["agent", "start", "hello"],
      "agent prune": ["agent", "prune"],
      // forms of the commands above, each refused like its plain one
      "agent exec --pty --attach": ["agent", "exec", "--pty", "--attach", "--", "true"],
      "agent exec --pty -a": ["agent", "exec", "--pty", "-a", "--", "true"],
      "agent start --pipeline": ["agent", "start", "--pipeline", "one", "do it"],
      "agent start --resume": ["agent", "start", "--resume", "x"],
      "agent prune --dry-run": ["agent", "prune", "--dry-run"],
    };
    expect(AGENT_HUMAN_COMMANDS).toContain("agent attach");
    expect(AGENT_HUMAN_COMMANDS).toContain("agent start");
    expect(AGENT_HUMAN_COMMANDS).toContain("agent prune");
    // `doctor` only reads: it is the agent's, and not in the person's list.
    expect(AGENT_READ_COMMANDS).toContain("agent doctor");
    expect(AGENT_HUMAN_COMMANDS as readonly string[]).not.toContain("agent doctor");
    const forms = Object.keys(argsFor).filter(
      (name) => !(AGENT_HUMAN_COMMANDS as readonly string[]).includes(name),
    );
    for (const name of [...AGENT_HUMAN_COMMANDS, ...forms]) {
      const args = argsFor[name] as string[];
      const withMark = await cli({ interactive: true, engine: true, platform: "linux" }, ...args);
      expect(withMark.code, `${name} under the engine mark`).toBe(1);
      expect(withMark.err).toContain("for a person");
      const noTerminal = await cli({ interactive: false, platform: "linux" }, ...args);
      expect(noTerminal.code, `${name} without a terminal`).toBe(1);
      expect(noTerminal.err).toContain("terminal");
    }
    expect(await readdir(state)).toEqual([]); // nothing was written by a refusal
  });

  test("tA_agent_human_commands_refuse: on Windows the platform answers before the human check", async () => {
    for (const args of [
      ["agent", "attach", "x"],
      ["agent", "exec", "--pty", "--", "true"],
      ["agent", "exec", "--pty", "--attach", "--", "true"],
      ["agent", "start", "hello"],
      ["agent", "prune"],
    ]) {
      // an engine without a terminal gets the same answer as a person: the platform, not "for a person"
      const r = await cli({ interactive: false, engine: true, platform: "win32" }, ...args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("PLATFORM_UNSUPPORTED");
      expect(r.err).not.toContain("for a person");
    }
  });

  test("tA_agents_md_lists_attach: the instruction names every human-only agent command", () => {
    const text = readFileSync(join(import.meta.dir, "../../../AGENTS.md"), "utf8");
    const rule = /^- Do not run [\s\S]*?(?=^- )/m.exec(text)?.[0] ?? "";
    const listed = /`agent ([a-z|-]+)`/.exec(rule)?.[1]?.split("|") ?? [];
    expect(listed.sort()).toEqual(AGENT_HUMAN_COMMANDS.map((c) => c.replace("agent ", "")).sort());
    // `exec` and `attach` ask for none, `start` only about a block that is not the committed one; the
    // instruction says so by name.
    expect(rule).toContain("all but two ask for a confirmation");
    expect(rule).toContain("asks when the `engines` block is\n  not the committed one");
    expect(rule).toMatch(
      /`agent exec`[\s\S]*`agent attach`[\s\S]*ask\s+for none[\s\S]*`agent start`/,
    );
    // What only reads is the agent's, `doctor` among it.
    for (const command of AGENT_READ_COMMANDS) expect(rule).toContain(`\`${command}\``);
  });

  tableTest(
    "tA_agent_exec_ls_stop_rm_by_hand",
    async () => {
      const started = await cli(
        { interactive: true },
        "agent",
        "exec",
        "--name",
        "hand",
        "--",
        "sleep",
        "60",
      );
      expect(started.code, started.err).toBe(0);
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      expect(id).toBeDefined();
      const listed = await cli({ interactive: false }, "agent", "ls");
      expect(listed.out).toContain(id);
      expect(listed.out).toContain("running");
      expect(listed.out).toContain("hand");
      const refusedRm = await cli({ interactive: true }, "agent", "rm", id);
      expect(refusedRm.code).toBe(1);
      expect(refusedRm.err).toContain("STILL_RUNNING");
      // The command is not a column: it was cut short there. `--json` has it whole.
      expect(listed.out).not.toContain("COMMAND");
      expect(listed.out).not.toContain("sleep 60");
      const asJson = JSON.parse(
        (await cli({ interactive: false }, "agent", "ls", "--json")).out,
      ) as SessionListEntry[];
      expect(asJson.find((r) => r.id === id)?.command).toBe("sleep 60");
      const stopped = await cli({ interactive: true }, "agent", "stop", id);
      expect(stopped.out).toContain(`${id}: stopped`);
      const afterStop = await cli({ interactive: false }, "agent", "ls");
      expect(afterStop.out).toContain("stopped");
      expect(afterStop.out).not.toContain("killed");
      const removed = await cli({ interactive: true }, "agent", "rm", id);
      expect(removed.out).toContain("removed");
      // a session started from the command line frees its name with its folder
      const retry = await cli(
        { interactive: true },
        "agent",
        "exec",
        "--name",
        "hand",
        "--",
        "true",
      );
      expect(retry.code, retry.err).toBe(0);
    },
    60_000,
  );

  tableTest(
    "tA_agent_stop_not_confirmed_changes_nothing",
    async () => {
      const started = await cli({ interactive: true }, "agent", "exec", "--", "sleep", "60");
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      const declined = await cli({ interactive: true, confirm: false }, "agent", "stop", id);
      expect(declined.code).toBe(1);
      expect(declined.err).toContain("not confirmed");
      expect((await cli({ interactive: false }, "agent", "ls")).out).toContain("running");
    },
    60_000,
  );

  unixTest(
    "tA_forget_name_refuses_while_the_session_exists",
    async () => {
      const started = await cli(
        { interactive: true },
        "agent",
        "exec",
        "--name",
        "keep",
        "--",
        "sleep",
        "30",
      );
      expect(started.code, started.err).toBe(0);
      const refused = await cli({ interactive: true }, "agent", "forget-name", "keep");
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("still exists");
    },
    30_000,
  );

  unixTest(
    "tA_agent_logs_prints_stdout_and_stderr_apart",
    async () => {
      const started = await cli(
        { interactive: true },
        "agent",
        "exec",
        "--",
        "sh",
        "-c",
        "echo to-out; echo to-err >&2",
      );
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      for (
        let i = 0;
        i < 80 && !(await cli({ interactive: false }, "agent", "ls")).out.includes("exited (0)");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const both = await cli({ interactive: false }, "agent", "logs", id);
      expect(both.out).toContain("to-out");
      expect(both.out).toContain("to-err");
      const out = await cli({ interactive: false }, "agent", "logs", id, "--stdout");
      expect(out.out).toContain("to-out");
      expect(out.out).not.toContain("to-err");
      const err = await cli({ interactive: false }, "agent", "logs", id, "--stderr");
      expect(err.out).toContain("to-err");
      expect(err.out).not.toContain("to-out");
      const bad = await cli({ interactive: false }, "agent", "logs", id, "--stdout", "--stderr");
      expect(bad.code).toBe(1);
      expect(
        (await cli({ interactive: false }, "agent", "logs", "a_000000000_0000")).err,
      ).toContain("NOT_FOUND");
    },
    30_000,
  );

  unixTest(
    "tA_agent_exec_pty_refused_by_probe_names_the_reason",
    async () => {
      const refused = await cli(
        { interactive: true, pty: { ok: false, reason: "the optional package is not installed" } },
        "agent",
        "exec",
        "--pty",
        "--name",
        "term",
        "--",
        "true",
      );
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("UNSUPPORTED: the optional package is not installed");
      expect(await readdir(state)).toEqual([]); // no record, and the name is free
      // the check of this build, as it is: the tests run under Bun, where a terminal session cannot be hosted
      const own = await cli({ interactive: true }, "agent", "exec", "--pty", "--", "true");
      expect(own.code).toBe(1);
      expect(own.err).toContain("UNSUPPORTED");
      expect(own.err).toContain("Bun");
      // pipes are not touched by a PTY that cannot run
      const pipes = await cli(
        { interactive: true, pty: { ok: false, reason: "no" } },
        "agent",
        "exec",
        "--",
        "true",
      );
      expect(pipes.code, pipes.err).toBe(0);

      // tA_agent_exec_pty_size_from_context: the size of a terminal session is asked of the context, once, and
      // this process's own stdout is not read for it
      let asked = 0;
      const size = () => {
        asked++;
        return { cols: 132, rows: 43 };
      };
      const readsOfStdout: string[] = [];
      const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
      for (const key of ["columns", "rows"] as const) {
        Object.defineProperty(process.stdout, key, {
          configurable: true,
          get: () => {
            readsOfStdout.push(key);
            return 80;
          },
        });
      }
      try {
        const sized = await cli(
          { interactive: true, pty: { ok: false, reason: "no terminal here" }, size },
          "agent",
          "exec",
          "--pty",
          "--",
          "true",
        );
        expect(sized.err).toContain("UNSUPPORTED: no terminal here");
        expect(asked).toBe(1);
        await cli({ interactive: true, size }, "agent", "exec", "--", "true");
        expect(asked).toBe(1);
        expect(readsOfStdout).toEqual([]);
      } finally {
        for (const [key, was] of [
          ["columns", columns],
          ["rows", rows],
        ] as const) {
          if (was) Object.defineProperty(process.stdout, key, was);
          else delete (process.stdout as { columns?: number; rows?: number })[key];
        }
      }
    },
    30_000,
  );

  unixTest(
    "tA_agent_attach_resolves_name_or_id",
    async () => {
      const started = await cli(
        { interactive: true },
        "agent",
        "exec",
        "--name",
        "Piped",
        "--",
        "sleep",
        "30",
      );
      expect(started.code, started.err).toBe(0);
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      // found by id, by name and by the name in another case: each gets the answer about that session
      for (const ref of [id, "piped", "PIPED"]) {
        const r = await cli({ interactive: true }, "agent", "attach", ref);
        expect(r.code, ref).toBe(1);
        expect(r.err, ref).toContain(`NOT_ATTACHABLE: session ${id} runs on pipes`);
      }
      for (const ref of ["nobody", "a_000000000_0000", "../x"]) {
        const r = await cli({ interactive: true }, "agent", "attach", ref);
        expect(r.code, ref).toBe(1);
        expect(r.err, ref).toContain("NOT_FOUND");
      }
    },
    30_000,
  );

  unixTest(
    "tA_agent_attach_refuses_pipes_and_ended",
    async () => {
      const started = await cli({ interactive: true }, "agent", "exec", "--", "true");
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      for (
        let i = 0;
        i < 80 && !(await cli({ interactive: false }, "agent", "ls")).out.includes("exited (0)");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const pipes = await cli({ interactive: true }, "agent", "attach", id);
      expect(pipes.code).toBe(1);
      expect(pipes.err).toContain("it has no terminal to attach to");
      // The same record as a terminal session would have left it: only the mode differs (no PTY runs under Bun).
      const file = join(
        sessionDirOf(
          sessionPlace({ base: resolveBase({ KODEL_STATE_DIR: state }), root: dir }),
          id,
        ),
        "session.json",
      );
      writeFileSync(file, readFileSync(file, "utf8").replace('"mode":"pipes"', '"mode":"pty"'));
      expect(readFileSync(file, "utf8")).toContain('"mode":"pty"');
      const ended = await cli({ interactive: true }, "agent", "attach", id);
      expect(ended.code).toBe(1);
      expect(ended.err).toContain(`NOT_ATTACHABLE: session ${id} is exited`);
    },
    30_000,
  );

  unixTest(
    "tA_agent_logs_is_a_read_an_engine_may_run_and_validates_bytes",
    async () => {
      const started = await cli({ interactive: true }, "agent", "exec", "--", "echo", "hi");
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      for (
        let i = 0;
        i < 80 && !(await cli({ interactive: false }, "agent", "ls")).out.includes("exited (0)");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const asEngine = await cli({ interactive: false, engine: true }, "agent", "logs", id);
      expect(asEngine).toMatchObject({ code: 0 });
      expect(asEngine.out).toContain("hi");
      for (const bad of ["0", "-3", "abc"]) {
        const r = await cli({ interactive: false }, "agent", "logs", id, "--bytes", bad);
        expect(r.code, bad).toBe(1);
        expect(r.err).toContain("positive whole number");
      }
    },
    30_000,
  );

  test("tA_state_label_reads_as_one_word_with_its_detail", () => {
    const row = (status: Record<string, unknown>, problem?: string) =>
      ({ id: "a_000000000_0000", status, ...(problem ? { problem } : {}) }) as never;
    expect(stateLabel(row({ state: "running" }))).toBe("running");
    expect(stateLabel(row({ state: "starting" }))).toBe("starting");
    expect(stateLabel(row({ state: "exited", exitCode: 0 }))).toBe("exited (0)");
    expect(stateLabel(row({ state: "exited", exitCode: 3 }))).toBe("exited (3)");
    expect(stateLabel(row({ state: "exited" }))).toBe("exited"); // no code is not success
    expect(stateLabel(row({ state: "killed", reason: "stopped" }))).toBe("stopped");
    expect(stateLabel(row({ state: "killed", reason: "timeout" }))).toBe("killed (timeout)");
    expect(stateLabel(row({ state: "killed", signal: "SIGKILL" }))).toBe("killed (SIGKILL)");
    expect(stateLabel(row({ state: "killed" }))).toBe("killed");
    expect(stateLabel(row({ state: "killed", reason: "holder_error" }))).toBe(
      "failed (could not start)",
    );
    expect(stateLabel(row({ state: "killed", reason: "rules_unknown" }))).toBe(
      "failed (a redaction rule cannot be used)",
    );
    expect(stateLabel(row({ state: "killed", reason: "start_late" }))).toBe(
      "failed (started too late)",
    );
    expect(stateLabel(row({ state: "lost", reason: "holder_gone" }))).toBe("lost (holder gone)");
    expect(stateLabel(row({ state: "lost", reason: "no_status" }))).toBe("lost (no answer)");
    expect(stateLabel(row({ state: "lost" }))).toBe("lost");
    expect(stateLabel(row({ state: "lost", reason: "timeout" }))).toBe("lost (timeout)");
    expect(stateLabel(row({ state: "lost", reason: "holder_gone", childAlive: true }))).toBe(
      "lost (holder gone, child still runs)",
    );
    // a process that is still alive is said so in every state that claims to be over
    expect(stateLabel(row({ state: "killed", reason: "stopped", childAlive: true }))).toBe(
      "stopped (child still runs)",
    );
    expect(stateLabel(row({ state: "killed", reason: "timeout", childAlive: true }))).toBe(
      "killed (timeout, child still runs)",
    );
    expect(stateLabel(row({ state: "exited", exitCode: 0, childAlive: true }))).toBe(
      "exited (0, child still runs)",
    );
    expect(stateLabel(row({ state: "lost", childAlive: true }))).toBe("lost (child still runs)");
    expect(stateLabel(row({ state: "lost" }, "FOREIGN"))).toBe("unknown (another machine)");
    expect(stateLabel(row({ state: "lost" }, "NEWER_FORMAT"))).toBe("unknown (newer kodel)");
    expect(stateLabel(row({ state: "lost" }, "CANNOT_READ"))).toBe("unknown (cannot be read)");
  });

  unixTest(
    "tA_agent_ls_lists_mode_and_agent",
    async () => {
      const conversation = "0f4b1c2d-0000-4000-8000-000000000001";
      const prompt = "Drive the run and keep the word PINEAPPLE to yourself";
      // The starter of an agent session is the launcher (and `agent start`); here it is the adapter the CLI builds.
      const adapter = pipesAdapter({
        root: dir,
        environment: { KODEL_STATE_DIR: state },
        launcher,
      });
      const withAgent = await adapter.start({
        argv: ["sh", "-c", "exit 0", prompt],
        cwd: dir,
        name: "with-agent",
        origin: "cli",
        agent: { engine: "claude", session: conversation },
      });
      const older = await adapter.start({ argv: ["sh", "-c", "exit 0"], cwd: dir, origin: "cli" });
      await adapter.wait(withAgent.id, { timeoutMs: 15_000 });
      await adapter.wait(older.id, { timeoutMs: 15_000 });

      const listed = await cli({ interactive: false, engine: true }, "agent", "ls");
      expect(listed.code, listed.err).toBe(0);
      const lines = listed.out.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^ID\s+NAME\s+STATE\s+MODE\s+AGENT\s+CONVERSATION$/);
      const rowOf = (id: string) => (lines.find((l) => l.startsWith(id)) ?? "").split(/\s{2,}/);
      // the engine and the id of its conversation are two columns, each under a header of its own
      expect(rowOf(withAgent.id).slice(1)).toEqual([
        "with-agent",
        "exited (0)",
        "pipes",
        "claude",
        conversation,
      ]);
      // a session with no agent record (an older one, or a plain command) has neither
      expect(rowOf(older.id).slice(1)).toEqual(["-", "exited (0)", "pipes", "-", "-"]);
      expect(listed.out).not.toContain("PINEAPPLE");

      const json = JSON.parse(
        (await cli({ interactive: false }, "agent", "ls", "--json")).out,
      ) as SessionListEntry[];
      const first = json.find((r) => r.id === withAgent.id);
      expect(first?.mode).toBe("pipes");
      expect(first?.agent).toEqual({ engine: "claude", session: conversation, source: "chosen" });
      expect(JSON.stringify(first?.agent)).not.toContain("PINEAPPLE");
      const second = json.find((r) => r.id === older.id);
      expect(second?.mode).toBe("pipes");
      expect(second && "agent" in second).toBe(false);

      const entry = (agent?: SessionListEntry["agent"]): SessionListEntry => ({
        id: "a_000000000_0001",
        status: { state: "exited" },
        ...(agent ? { agent } : {}),
      });
      expect(agentLabel(entry())).toBe("-");
      expect(agentLabel(entry({ engine: "claude" }))).toBe("claude");
      expect(agentLabel(entry({ engine: "claude", session: "abc" }))).toBe("claude");
      expect(conversationLabel(entry())).toBe("-");
      expect(conversationLabel(entry({ engine: "claude" }))).toBe("-");
      expect(conversationLabel(entry({ engine: "claude", session: "abc" }))).toBe("abc");
      expect(conversationLabel(entry({ engine: "claude", session: conversation }))).toBe(
        conversation,
      );
      // an id longer than a UUID is cut to the column; `--json` has all of it
      const long = conversationLabel(entry({ engine: "x", session: "s".repeat(60) }));
      expect([...long].length).toBe(36);
      expect(long.endsWith("…")).toBe(true);
      // what `agent stop` adds when it signalled nothing of a group it could not call the session's
      expect(groupNote(undefined)).toBeUndefined();
      expect(groupNote("unread")).toContain("process table could not be read");
      expect(groupNote("stranger")).toContain("belongs to another process");
    },
    30_000,
  );

  tableTest(
    "tA_ls_has_no_detail_column_and_rm_asks_a_plain_question",
    async () => {
      const started = await cli({ interactive: true }, "agent", "exec", "--", "sh", "-c", "exit 3");
      const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
      for (
        let i = 0;
        i < 80 && !(await cli({ interactive: false }, "agent", "ls")).out.includes("exited (3)");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const listed = await cli({ interactive: false }, "agent", "ls");
      expect(listed.out.split("\n")[0]).toMatch(
        /^ID\s+NAME\s+STATE\s+MODE\s+AGENT\s+CONVERSATION$/,
      );
      expect(listed.out).not.toContain("DETAIL");
      expect(listed.out).toContain("exited (3)");
      let asked = "";
      await runCli(["agent", "rm", id], {
        cwd: dir,
        out: () => {},
        err: () => {},
        interactive: true,
        environment: { KODEL_STATE_DIR: state },
        confirm: async (q) => {
          asked = q;
          return true;
        },
        select: async () => [],
        sessionLauncher: launcher,
      });
      expect(asked).toBe(`Remove agent ${id}?`);
    },
    30_000,
  );

  test("tA_agents_alias_works", async () => {
    expect((await cli({ interactive: false, platform: "linux" }, "agents", "ls")).out).toBe(
      "no agents\n",
    );
  });
});

describe("resolveSession", () => {
  test("tA_agent_attach_unreadable_session_names_the_reason: a session that cannot be judged is not NOT_FOUND", async () => {
    const rows: SessionListEntry[] = [
      { id: "a_000000000_0001", name: "ok", status: { state: "running" } },
      { id: "a_000000000_0002", name: "broken", status: { state: "lost" }, problem: "CANNOT_READ" },
      { id: "a_000000000_0003", status: { state: "lost" }, problem: "NEWER_FORMAT" },
      { id: "a_000000000_0004", name: "far", status: { state: "lost" }, problem: "FOREIGN" },
    ];
    const adapter = { list: async () => rows } as unknown as SessionAdapter;
    expect(await resolveSession(adapter, "ok")).toEqual({ id: "a_000000000_0001", name: "ok" });
    for (const [ref, code, text] of [
      ["broken", "CANNOT_READ", "cannot be read"],
      ["a_000000000_0002", "CANNOT_READ", "cannot be read"],
      ["a_000000000_0003", "NEWER_FORMAT", "upgrade kodel"],
      ["FAR", "CANNOT_READ", "another machine"],
      ["nobody", "NOT_FOUND", "no agent"],
      // what is no name matches no row, and not the unreadable row that has no name either
      ["../x", "NOT_FOUND", "no agent"],
      ["-x", "NOT_FOUND", "no agent"],
      ["", "NOT_FOUND", "no agent"],
    ] as const) {
      const error = await resolveSession(adapter, ref).then(
        () => undefined,
        (e: { code: string; message: string }) => e,
      );
      expect(error?.code, ref).toBe(code);
      expect(error?.message, ref).toContain(text);
    }
  });
});

describe("kodel agent exec --pty --attach (TASK-K6MA)", () => {
  const terminal = (): AttachTerminal => ({
    size: () => ({ cols: 100, rows: 30 }),
    raw() {},
    write: () => true,
    onDrain() {},
    onInput() {},
    onResize() {},
    onSignal() {},
    release() {},
  });

  /** `agent exec` over a fake adapter and a fake attach client that ends as the test says. */
  async function exec(
    sessions: FakeSessions,
    end: AttachResult | undefined,
    ...args: string[]
  ): Promise<{ code: number; out: string; err: string; attaches: { name: string }[] }> {
    const attaches: { name: string }[] = [];
    const result = await cli(
      {
        interactive: true,
        pty: { ok: true },
        platform: "linux",
        size: () => ({ cols: 100, rows: 30 }),
        agent: {
          sessions: async () => sessions,
          attachTerminal: terminal,
          attach: async (options: AttachClientOptions) => {
            attaches.push({ name: options.name });
            return end ?? { end: { how: "detached" }, line: `[detached: ${options.name}]` };
          },
        },
      },
      "agent",
      "exec",
      ...args,
    );
    return { ...result, attaches };
  }

  test("tA_exec_attach_starts_then_attaches", async () => {
    for (const flag of ["--attach", "-a"]) {
      const sessions = new FakeSessions();
      const r = await exec(sessions, undefined, "--pty", flag, "--name", "cc", "--", "sleep", "30");
      expect(r.code, r.err).toBe(0);
      // `started` first, then the attach client that `agent attach` runs; no hint how to attach.
      expect(r.out).toMatch(/^started a_\S+ \(cc\)\n$/);
      expect(sessions.specs[0]).toMatchObject({
        argv: ["sleep", "30"],
        mode: "pty",
        name: "cc",
        origin: "cli",
        size: { cols: 100, rows: 30 },
      });
      expect(r.attaches.map((a) => a.name)).toEqual(["cc"]);
      expect(sessions.attached).toEqual([sessions.rows[0]?.id ?? ""]);
      // The session was started before anything was attached, and it is left running by a detach.
      expect(sessions.calls.indexOf("start")).toBeLessThan(
        sessions.calls.indexOf(`attach ${sessions.rows[0]?.id}`),
      );
      expect(sessions.rows[0]?.status.state).toBe("running");
    }

    // `-a` after the command's first word is the command's own, with a terminal and without one.
    for (const pty of [[], ["--pty"]]) {
      const own = new FakeSessions();
      const r = await exec(own, undefined, ...pty, "ls", "-a", "x");
      expect(r.code, r.err).toBe(0);
      expect(own.specs[0]?.argv).toEqual(["ls", "-a", "x"]);
      expect(r.attaches).toEqual([]);
    }
    // Before the command it is `--attach`, which needs `--pty`.
    const bare = new FakeSessions();
    const noPty = await exec(bare, undefined, "-a", "--", "cat");
    expect(noPty.code).toBe(1);
    expect(noPty.err).toContain("--attach needs --pty");
    expect(bare.specs).toEqual([]);

    // The exit code is the attach's: 0 when the command ended while attached, the problem otherwise.
    const ended = await exec(
      new FakeSessions(),
      { end: { how: "ended", exitCode: 3 }, line: "[ended: x, exit 3]" },
      "--pty",
      "--attach",
      "--",
      "true",
    );
    expect(ended.code).toBe(0);
    const refused = await exec(
      new FakeSessions(),
      {
        end: { how: "refused", text: "too many terminals are attached" },
        line: "[detached: x]",
        problem: "too many terminals are attached",
      },
      "--pty",
      "--attach",
      "--",
      "true",
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("too many terminals are attached");
    expect(refused.out).toMatch(/^started a_/);

    // Without the flag `exec --pty` still starts a session without taking the terminal.
    const plainPty = await exec(new FakeSessions(), undefined, "--pty", "--", "true");
    expect(plainPty.attaches).toEqual([]);
    expect(plainPty.out).toContain("attach with: kodel agent attach a_");

    // `--attach` without `--pty` is refused with a reason, and nothing is started.
    const pipes = new FakeSessions();
    for (const flag of ["--attach", "-a"]) {
      const r = await exec(pipes, undefined, flag, "--", "true");
      expect(r.code).toBe(1);
      expect(r.err).toContain("--attach needs --pty");
    }
    expect(pipes.specs).toEqual([]);

    // A start that fails prints its own error and does not attach.
    const failing = new FakeSessions();
    failing.failStart = new SessionError("HOLDER_BOOT_FAILED", "the holder could not start");
    const failed = await exec(failing, undefined, "--pty", "--attach", "--", "true");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("HOLDER_BOOT_FAILED: the holder could not start");
    expect(failed.out).toBe("");
    expect(failed.attaches).toEqual([]);

    // It stays a person's command, with no new confirmation.
    const marked = await cli(
      { interactive: true, engine: true, platform: "linux" },
      "agent",
      "exec",
      "--pty",
      "--attach",
      "--",
      "true",
    );
    expect(marked.err).toContain("for a person");
  });

  test("tA_exec_attach_of_a_command_that_already_ended", async () => {
    // The command was over before the terminal could be connected: the line of its end, code 0.
    const quick = new FakeSessions();
    quick.startedAs = { state: "exited", exitCode: 0 };
    const r = await exec(quick, undefined, "--pty", "--attach", "--name", "cc", "--", "true");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^started a_\S+ \(cc\)\n\[ended: cc, exit 0\]\n$/);
    expect(r.attaches).toEqual([]);
    const failed = new FakeSessions();
    failed.startedAs = { state: "exited", exitCode: 2 };
    const nonZero = await exec(failed, undefined, "--pty", "-a", "--", "false");
    expect(nonZero.code).toBe(0);
    expect(nonZero.out).toMatch(/\[ended: a_\S+, exit 2\]\n$/);
    const killed = new FakeSessions();
    killed.startedAs = { state: "killed", reason: "timeout" };
    const gone = await exec(killed, undefined, "--pty", "--attach", "--name", "cc", "--", "true");
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("[killed: cc]\n");
  });

  describe("a name or an id, resolved before the question", () => {
    const fixture = () => {
      const sessions = new FakeSessions();
      // Two sessions used the name over time: the one that runs is meant.
      sessions.add({
        id: "a_000000001_old0",
        name: "sh1",
        mode: "pty",
        status: { state: "exited" },
      });
      sessions.add({
        id: "a_000000002_live",
        name: "sh1",
        mode: "pty",
        status: { state: "running" },
      });
      sessions.add({
        id: "a_000000003_done",
        name: "done",
        status: { state: "exited", exitCode: 0 },
      });
      sessions.add({ id: "a_000000004_anon", status: { state: "running" } });
      sessions.add({
        id: "a_000000005_bad0",
        name: "broken",
        status: { state: "lost" },
        problem: "CANNOT_READ",
      });
      return { sessions, seam: { agent: { sessions: async () => sessions } } };
    };

    test("tA_agent_stop_takes_a_name_or_an_id", async () => {
      for (const ref of ["sh1", "SH1", "a_000000002_live"]) {
        const { sessions, seam } = fixture();
        const asked: string[] = [];
        const r = await cli({ interactive: true, asked, ...seam }, "agent", "stop", ref);
        expect(r.code, r.err).toBe(0);
        // The question names the session found, by its name and its id.
        expect(asked, ref).toEqual(["Stop agent sh1 (a_000000002_live)?"]);
        expect(sessions.stopped, ref).toEqual(["a_000000002_live"]);
        expect(r.out, ref).toBe("a_000000002_live: stopped\n");
      }
      // A session with no name is asked about by its id alone.
      const anon = fixture();
      const asked: string[] = [];
      await cli({ interactive: true, asked, ...anon.seam }, "agent", "stop", "a_000000004_anon");
      expect(asked).toEqual(["Stop agent a_000000004_anon?"]);
      expect(anon.sessions.stopped).toEqual(["a_000000004_anon"]);
    });

    test("tA_agent_stop_of_an_unknown_name_fails_before_the_question", async () => {
      for (const command of ["stop", "rm"]) {
        for (const [ref, code] of [
          ["nobody", 'NOT_FOUND: no agent "nobody"'],
          ["../x", "NOT_FOUND"],
          // a name whose records cannot be judged: the reason, not a question
          ["broken", "CANNOT_READ"],
        ] as const) {
          const { sessions, seam } = fixture();
          const asked: string[] = [];
          const r = await cli({ interactive: true, asked, ...seam }, "agent", command, ref);
          expect(r.code, `${command} ${ref}`).toBe(1);
          expect(r.err, `${command} ${ref}`).toContain(code);
          expect(asked, `${command} ${ref}`).toEqual([]);
          expect(sessions.stopped).toEqual([]);
          expect(sessions.removed).toEqual([]);
        }
      }
      // An answer of "no" leaves the session found alone.
      const { sessions, seam } = fixture();
      const no = await cli({ interactive: true, confirm: false, ...seam }, "agent", "stop", "sh1");
      expect(no.code).toBe(1);
      expect(sessions.stopped).toEqual([]);
    });

    test("tA_agent_rm_takes_a_name_or_an_id", async () => {
      for (const ref of ["done", "Done", "a_000000003_done"]) {
        const { sessions, seam } = fixture();
        const asked: string[] = [];
        const r = await cli({ interactive: true, asked, ...seam }, "agent", "rm", ref);
        expect(r.code, r.err).toBe(0);
        expect(asked, ref).toEqual(["Remove agent done (a_000000003_done)?"]);
        expect(sessions.removed, ref).toEqual(["a_000000003_done"]);
        expect(r.out, ref).toBe("a_000000003_done: removed\n");
      }
      // The name of a session that runs: the question names it, and the adapter's refusal is the answer.
      const { sessions, seam } = fixture();
      const asked: string[] = [];
      const live = await cli({ interactive: true, asked, ...seam }, "agent", "rm", "sh1");
      expect(asked).toEqual(["Remove agent sh1 (a_000000002_live)?"]);
      expect(live.code).toBe(1);
      expect(live.err).toContain("STILL_RUNNING");
      expect(sessions.removed).toEqual([]);
    });

    test("tA_agent_logs_takes_a_name_or_an_id", async () => {
      for (const ref of ["sh1", "a_000000002_live"]) {
        const { sessions, seam } = fixture();
        // a read: an engine may run it, with no terminal and no question
        const r = await cli({ interactive: false, engine: true, ...seam }, "agent", "logs", ref);
        expect(r.code, r.err).toBe(0);
        expect(sessions.tailed, ref).toEqual(["a_000000002_live"]);
        expect(r.out, ref).toBe("output of a_000000002_live\n");
      }
      const { sessions, seam } = fixture();
      const none = await cli({ interactive: false, ...seam }, "agent", "logs", "nobody");
      expect(none.code).toBe(1);
      expect(none.err).toContain('NOT_FOUND: no agent "nobody"');
      expect(sessions.tailed).toEqual([]);
    });

    tableTest(
      "tA_agent_stop_and_rm_by_name_on_a_real_session",
      async () => {
        const started = await cli(
          { interactive: true },
          "agent",
          "exec",
          "--name",
          "sh1",
          "--",
          "sh",
          "-c",
          "echo from-sh1; sleep 60",
        );
        const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
        for (
          let i = 0;
          i < 80 &&
          !(await cli({ interactive: false }, "agent", "logs", "sh1")).out.includes("from");
          i++
        ) {
          await new Promise((r) => setTimeout(r, 100));
        }
        expect((await cli({ interactive: false }, "agent", "logs", "sh1")).out).toContain(
          "from-sh1",
        );
        const asked: string[] = [];
        const stopped = await cli({ interactive: true, asked }, "agent", "stop", "sh1");
        expect(stopped.code, stopped.err).toBe(0);
        expect(asked).toEqual([`Stop agent sh1 (${id})?`]);
        expect(stopped.out).toContain(`${id}: stopped`);
        const removed = await cli({ interactive: true, asked }, "agent", "rm", "sh1");
        expect(removed.out).toBe(`${id}: removed\n`);
        const again = await cli({ interactive: true }, "agent", "stop", "sh1");
        expect(again.code).toBe(1);
        expect(again.err).toContain('NOT_FOUND: no agent "sh1"');
      },
      30_000,
    );
  });

  test("tA_agent_ls_hints_the_resume_of_a_finished_agent", async () => {
    const sessions = new FakeSessions();
    const agent = { engine: "claude", session: "0f4b1c2d-0000-4000-8000-000000000001" };
    sessions.add({
      id: "a_000000001_stop",
      name: "cc",
      mode: "pty",
      command: "claude",
      agent,
      status: { state: "killed", reason: "stopped" },
    });
    sessions.add({
      id: "a_000000002_live",
      name: "dd",
      mode: "pty",
      agent,
      status: { state: "running" },
    });
    sessions.add({
      id: "a_000000003_pipe",
      name: "ee",
      mode: "pipes",
      status: { state: "exited" },
    });
    const seam = { agent: { sessions: async () => sessions } };
    const listed = await cli({ interactive: false, engine: true, ...seam }, "agent", "ls");
    expect(listed.code, listed.err).toBe(0);
    const lines = listed.out.trimEnd().split("\n");
    // Under the table, one line for the stopped agent that can be continued, and for no other.
    expect(lines.filter((line) => line.includes("agent start --resume"))).toEqual([
      "cc can be continued: kodel agent start --resume cc",
    ]);
    expect(lines.at(-1)).toBe("cc can be continued: kodel agent start --resume cc");
    expect(lines.find((line) => line.startsWith("a_000000001_stop"))).toMatch(
      /cc\s+stopped\s+pty\s+claude\s+0f4b1c2d-0000-4000-8000-000000000001$/,
    );
    // The JSON is the list and nothing else.
    const json = await cli({ interactive: false, ...seam }, "agent", "ls", "--json");
    expect(json.out).not.toContain("--resume");
    expect((JSON.parse(json.out) as unknown[]).length).toBe(3);
  });
});

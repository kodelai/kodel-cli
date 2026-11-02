import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "@kodel-ai/local";
import { AGENT_HUMAN_COMMANDS, AGENT_READ_COMMANDS, stateLabel } from "../src/agent-commands";
import { runCli } from "../src/cli";

// `stop` signals only a process whose identity it can check; a sandbox without the process table skips these, visibly.
const tableTest = test.skipIf(
  processIdentity(process.pid) === undefined && process.env.KODEL_REQUIRE_PROCTABLE !== "1",
);

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
    confirm: async () => opts.confirm ?? true,
    select: async () => [],
    sessionLauncher: launcher,
  });
  return { code, out, err };
}

describe("kodel agent", () => {
  test("tA_agent_ls_is_read_only_and_works_for_an_engine", async () => {
    const empty = await cli({ interactive: false, engine: true }, "agent", "ls");
    expect(empty).toMatchObject({ code: 0, out: "no agents\n" });
    expect(AGENT_READ_COMMANDS).toContain("agent ls");
  });

  test("tA_every_human_command_refuses_in_session", async () => {
    const argsFor: Record<string, string[]> = {
      "agent stop": ["agent", "stop", "a_000000000_0000"],
      "agent rm": ["agent", "rm", "a_000000000_0000"],
      "agent exec": ["agent", "exec", "--", "true"],
      "agent forget-name": ["agent", "forget-name", "x"],
    };
    for (const name of AGENT_HUMAN_COMMANDS) {
      const args = argsFor[name] as string[];
      const withMark = await cli({ interactive: true, engine: true }, ...args);
      expect(withMark.code, `${name} under the engine mark`).toBe(1);
      expect(withMark.err).toContain("for a person");
      const noTerminal = await cli({ interactive: false }, ...args);
      expect(noTerminal.code, `${name} without a terminal`).toBe(1);
      expect(noTerminal.err).toContain("terminal");
    }
    expect(await readdir(state)).toEqual([]); // nothing was written by a refusal
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
      expect(listed.out).toContain("COMMAND");
      expect(listed.out).toContain("sleep 60");
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

  test("tA_forget_name_refuses_while_the_session_exists", async () => {
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
  }, 30_000);

  test("tA_agent_logs_prints_stdout_and_stderr_apart", async () => {
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
    expect((await cli({ interactive: false }, "agent", "logs", "a_000000000_0000")).err).toContain(
      "NOT_FOUND",
    );
  }, 30_000);

  test("tA_agent_exec_pty_is_not_in_this_build", async () => {
    const r = await cli({ interactive: true }, "agent", "exec", "--pty", "--", "true");
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNSUPPORTED");
  });

  test("tA_agent_logs_is_a_read_an_engine_may_run_and_validates_bytes", async () => {
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
  }, 30_000);

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
      expect(listed.out.split("\n")[0]).toMatch(/^ID\s+NAME\s+STATE\s+COMMAND$/);
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
    expect((await cli({ interactive: false }, "agents", "ls")).out).toBe("no agents\n");
  });
});

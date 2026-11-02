import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_HUMAN_COMMANDS, AGENT_READ_COMMANDS } from "../src/agent-commands";
import { runCli } from "../src/cli";

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

  test("tA_agent_exec_ls_stop_rm_by_hand", async () => {
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
    const stopped = await cli({ interactive: true }, "agent", "stop", id);
    expect(stopped.out).toContain("killed (stopped)");
    const removed = await cli({ interactive: true }, "agent", "rm", id);
    expect(removed.out).toContain("removed");
    const again = await cli({ interactive: true }, "agent", "exec", "--name", "hand", "--", "true");
    expect(again.code).toBe(1);
    expect(again.err).toContain("NAME_USED");
    const freed = await cli({ interactive: true }, "agent", "forget-name", "hand");
    expect(freed.out).toContain("freed");
    const retry = await cli({ interactive: true }, "agent", "exec", "--name", "hand", "--", "true");
    expect(retry.code, retry.err).toBe(0);
  }, 60_000);

  test("tA_agent_stop_not_confirmed_changes_nothing", async () => {
    const started = await cli({ interactive: true }, "agent", "exec", "--", "sleep", "60");
    const id = /started (a_\S+)/.exec(started.out)?.[1] as string;
    const declined = await cli({ interactive: true, confirm: false }, "agent", "stop", id);
    expect(declined.code).toBe(1);
    expect(declined.err).toContain("not confirmed");
    expect((await cli({ interactive: false }, "agent", "ls")).out).toContain("running");
  }, 60_000);

  test("tA_agent_exec_pty_is_not_in_this_build", async () => {
    const r = await cli({ interactive: true }, "agent", "exec", "--pty", "--", "true");
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNSUPPORTED");
  });

  test("tA_agents_alias_works", async () => {
    expect((await cli({ interactive: false }, "agents", "ls")).out).toBe("no agents\n");
  });
});

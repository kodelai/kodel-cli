/**
 * The third guard of a person's commands (T-47): a command run inside a kodel agent session is refused
 * whatever its environment and its terminal say. A table from the registry of the person's commands, with
 * the probe injected; the probe itself is tested in `packages/local/test/session-guard.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GuardView,
  insideSession,
  PipesSessionAdapter,
  processIdentity,
  systemGuardView,
} from "@kodel-ai/local";
import { AGENT_HUMAN_COMMANDS } from "../src/agent-commands";
import { runCli } from "../src/cli";
import { HUMAN_ONLY_COMMANDS, INSIDE_SESSION_REFUSAL } from "../src/human-only";

const RUN = "r_0mw53d7fj_none";
const SESSION = "a_000000001_0000";

/** Arguments that take each command of the registry to its guard, and no further than a harmless refusal. */
const ARGS: Record<string, string[]> = {
  gate: ["gate", "approve", RUN],
  resume: ["resume", RUN],
  migrate: ["migrate", RUN],
  ack: ["ack", RUN],
  seal: ["seal", RUN],
  "pipeline changes apply": ["pipeline", "changes", "apply", RUN],
  "pipeline changes discard": ["pipeline", "changes", "discard", RUN],
  "pipeline changes restore": ["pipeline", "changes", "restore", RUN],
  "pipeline proposals apply": ["pipeline", "proposals", "apply", "none"],
  "pipeline proposals discard": ["pipeline", "proposals", "discard", "none"],
  "task approve": ["task", "approve", "KDL-NONE"],
  "web pair": ["web", "pair"],
  "web revoke": ["web", "revoke", "none"],
  "web token add": ["web", "token", "add", "--name", "laptop"],
  "web token revoke": ["web", "token", "revoke", "none"],
  "agent stop": ["agent", "stop", SESSION],
  "agent rm": ["agent", "rm", SESSION],
  // A name that is not valid: outside a session the command stops there, before it starts anything.
  "agent exec": ["agent", "exec", "--name", "not a name", "--", "true"],
  "agent forget-name": ["agent", "forget-name", "none"],
  "agent attach": ["agent", "attach", "none"],
  // There is no such agent to continue: outside a session the command stops there.
  "agent start": ["agent", "start", "--resume", "none"],
  "agent prune": ["agent", "prune", "--dry-run"],
};

let dir: string;
let state: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-human-")));
  state = await realpath(await mkdtemp(join(tmpdir(), "kodel-human-state-")));
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(dir, ".kodel", "config.yaml"), "tasks:\n  enabled: true\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

interface Opts {
  inside?: () => "inside" | "outside" | "unknown";
  interactive?: boolean;
  engine?: boolean;
}

async function cli(opts: Opts, args: string[]) {
  let out = "";
  let err = "";
  let asked = 0;
  const code = await runCli(["--root", dir, ...args], {
    cwd: dir,
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive: opts.interactive ?? true,
    environment: { KODEL_STATE_DIR: state, ...(opts.engine ? { KODEL_ENGINE: "1" } : {}) },
    confirm: async () => {
      asked += 1;
      return false;
    },
    select: async () => [],
    ...(opts.inside === undefined ? {} : { insideSession: opts.inside }),
  });
  return { code, out, err, asked };
}

const filesOf = (root: string) => (readdirSync(root, { recursive: true }) as string[]).sort();

describe("t47 a person's commands inside an agent session", () => {
  test("t47_persons_commands_refuse_inside_a_session", async () => {
    // Every command of the registry has its row, so a new one cannot be added without it.
    expect(Object.keys(ARGS).sort()).toEqual([...HUMAN_ONLY_COMMANDS].sort());
    const before = filesOf(dir);
    for (const command of HUMAN_ONLY_COMMANDS) {
      // A terminal on both ends and no mark: only the session stands in the way.
      const result = await cli({ inside: () => "inside" }, ARGS[command] ?? []);
      expect(result.code, command).toBe(1);
      expect(result.err, command).toContain(INSIDE_SESSION_REFUSAL);
      expect(result.asked, command).toBe(0);
      expect(result.out, command).toBe("");
    }
    // Nothing was written: not in the project, not in the state base.
    expect(filesOf(dir)).toEqual(before);
    expect(filesOf(state)).toEqual([]);
    // The registry is what the CLI guards: one call of the guard per command, and the screen (`tui`).
    const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");
    expect(source("cli.ts").match(/^\s+requireHuman\(\);$/gm)?.length).toBe(
      HUMAN_ONLY_COMMANDS.length - AGENT_HUMAN_COMMANDS.length + 1,
    );
    expect(source("agent-commands.ts").match(/ctx\.requireHuman\(\);/g)?.length).toBe(
      AGENT_HUMAN_COMMANDS.length,
    );
    expect(INSIDE_SESSION_REFUSAL).toBe(
      "this command is for a person; it will not run inside a kodel agent session",
    );
  });

  test("t47_session_guard_reads_the_terminal_session", async () => {
    // No session among the parents (the command's parent is the root), but the leader of the terminal
    // it runs on is the process a session's holder started: the real probe says `inside`.
    const view: GuardView = {
      rows: () => [
        { pid: 1, ppid: 0, state: "Ss", tty: "??" },
        { pid: 500, ppid: 1, state: "S", tty: "??" },
        { pid: 510, ppid: 500, state: "Ss", tty: "ttys009" },
        { pid: 800, ppid: 1, state: "S+", tty: "ttys009" },
      ],
      identity: () => undefined,
    };
    const inside = () =>
      insideSession({ pid: 800, sessions: [{ holder: { pid: 500 }, child: { pid: 510 } }], view });
    expect(inside()).toBe("inside");
    for (const command of ["gate", "seal", "agent stop"]) {
      const result = await cli({ inside }, ARGS[command] ?? []);
      expect(result.code, command).toBe(1);
      expect(result.err, command).toContain(INSIDE_SESSION_REFUSAL);
      expect(result.asked, command).toBe(0);
    }
  });

  // Real processes and the real process table; skipped where the table cannot be read (a sandbox).
  test.skipIf(processIdentity(process.pid) === undefined || systemGuardView.rows() === undefined)(
    "t47_session_guard_finds_a_session_of_another_state_base",
    async () => {
      // The person uses `KODEL_STATE_DIR`: the session's record is written there. A session's
      // environment gets no `KODEL_*`, so a `kodel gate` its agent runs resolves the default state base
      // (under a home folder of this test's own), which holds no session at all. The mark is taken off
      // (`env -u KODEL_ENGINE`), so only the session guard can speak of a session.
      const main = join(import.meta.dir, "../src/main.ts");
      const home = await realpath(await mkdtemp(join(tmpdir(), "kodel-human-home-")));
      const adapter = new PipesSessionAdapter({
        base: state,
        root: dir,
        holder: { exec: process.execPath, args: [main, "session-holder", "holder"] },
        intermediate: { exec: process.execPath, args: [main, "session-holder"] },
        pollMs: 50,
      });
      try {
        const { id } = await adapter.start({
          argv: [
            "/usr/bin/env",
            "-u",
            "KODEL_ENGINE",
            process.execPath,
            main,
            "--root",
            dir,
            ...(ARGS.gate ?? []),
          ],
          cwd: dir,
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          inheritEnv: false,
          timeoutMs: 60_000,
        });
        const done = await adapter.wait(id, { timeoutMs: 45_000 });
        const { text } = await adapter.tail(id);
        expect(text).toContain(INSIDE_SESSION_REFUSAL);
        expect(text).not.toContain("the engine runs");
        expect(done).toMatchObject({ state: "exited", exitCode: 1 });
        // The default state base of that home holds no session: the record was not what refused.
        expect(readdirSync(home)).not.toContain(".kodel");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test("t47_session_guard_lets_a_person_through", async () => {
    // No session among the parents: each command goes on to what it did before (here: there is no such
    // run, task or agent), and none speaks of a person.
    for (const command of HUMAN_ONLY_COMMANDS) {
      const result = await cli({ inside: () => "outside" }, ARGS[command] ?? []);
      expect(result.err, command).not.toContain("for a person");
    }
    const gate = await cli({ inside: () => "outside" }, ARGS.gate ?? []);
    expect(gate.err).toContain(`there is no run "${RUN}"`);
    // And without a probe at all (a caller that gives none): as before.
    const plainGate = await cli({}, ARGS.gate ?? []);
    expect(plainGate.err).toContain(`there is no run "${RUN}"`);
  });

  test("t47_session_guard_unreadable_table_keeps_the_old_guards", async () => {
    const unknown = () => "unknown" as const;
    for (const command of HUMAN_ONLY_COMMANDS) {
      const args = ARGS[command] ?? [];
      // A person at a terminal where the table cannot be read (a sandbox) still decides.
      const person = await cli({ inside: unknown }, args);
      expect(person.err, command).not.toContain("for a person");
      // The two older guards decide as they did.
      const script = await cli({ inside: unknown, interactive: false }, args);
      expect(script.err, command).toContain(
        "this command is for a person at a terminal; it will not run from a script or an agent",
      );
      const engine = await cli({ inside: unknown, engine: true }, args);
      expect(engine.err, command).toContain(
        "this command is for a person; it will not run from a command the engine runs",
      );
    }
    // The order: the mark first, then the session, then the terminal.
    let asked = 0;
    const counted = () => {
      asked += 1;
      return "inside" as const;
    };
    const marked = await cli({ inside: counted, engine: true }, ARGS.gate ?? []);
    expect(marked.err).toContain("from a command the engine runs");
    expect(asked).toBe(0);
    const noTerminal = await cli({ inside: counted, interactive: false }, ARGS.gate ?? []);
    expect(noTerminal.err).toContain(INSIDE_SESSION_REFUSAL);
    // A command that is not a person's never asks the probe.
    asked = 0;
    for (const args of [["status"], ["agent", "ls"], ["agent", "logs", SESSION]]) {
      await cli({ inside: counted, interactive: false, engine: true }, args);
    }
    expect(asked).toBe(0);
  });
});

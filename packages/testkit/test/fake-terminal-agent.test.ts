/**
 * The scripted fake terminal agent, without a terminal: what the launcher's probes get from it, what its
 * log says of a start with the argv of the real profile, and its wrapper. On a real PTY it is driven by
 * `tests/pty/worker-terminal.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeTerminalAgent } from "../src";

const UUID = "7f3b2a9c-1d4e-4f6a-9b8c-0d1e2f3a4b5c";
const made: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kodel-fake-agent-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hasNode = spawnSync("node", ["--version"]).status === 0;
const nodeTest = test.skipIf(!hasNode);

const run = (program: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(program, args, {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", ...env },
  });

describe("t45 the scripted fake terminal agent", () => {
  nodeTest("t45_fake_terminal_agent_answers_the_probes", () => {
    for (const wrapper of [false, true]) {
      const agent = writeFakeTerminalAgent({ dir: folder(), wrapper });
      const auth = run(agent.program, ["auth", "status", "--json"]);
      expect(auth.status).toBe(0);
      expect(JSON.parse(auth.stdout)).toMatchObject({ loggedIn: true });
      expect(run(agent.program, ["--version"]).stdout).toMatch(/^\d+\.\d+\.\d+ /);
      // A probe is no start.
      expect(agent.starts()).toEqual([]);
    }
  });

  nodeTest("t45_fake_terminal_agent_logs_its_start_and_acts_on_lines", () => {
    const dir = folder();
    const agent = writeFakeTerminalAgent({
      dir,
      shims: { kodel: ["sh", "-c", 'echo "kodel $*"', "kodel"] },
      startup: ["hello there", "!kodel gate approve r_x; exit 3", "quit 4"],
    });
    // The argv of the real profile in a terminal: flags, then the prompt after `--`.
    const argv = ["--session-id", UUID, "--permission-mode", "dontAsk", "--", "doctor\n"];
    const done = run(agent.program, argv, {
      PATH: `${agent.bin}:${process.env.PATH ?? ""}`,
      KODEL_ENGINE: "1",
    });
    expect(done.status).toBe(4);
    expect(done.stdout).toContain(`fake-agent ready ${UUID}\r\n`);
    expect(done.stdout).toContain("prompt: doctor\r\n");
    expect(done.stdout).toContain("agent heard: hello there\r\n");
    // A command of the agent's shell: the shim beside it is found on PATH, and its code is shown.
    expect(done.stdout).toContain("kodel gate approve r_x\n");
    expect(done.stdout).toContain("[exit 3]\r\n");
    expect(agent.starts()).toEqual([
      {
        pid: expect.any(Number) as unknown as number,
        argv,
        cwd: process.cwd(),
        session: UUID,
        resumed: false,
        prompt: "doctor\n",
        engine: "1",
        stateDir: null,
        tty: false,
      },
    ]);
    expect(agent.events().map((entry) => entry.event)).toEqual(["start", "ran"]);
    // A resumed conversation says so.
    const again = writeFakeTerminalAgent({ dir: folder(), startup: ["quit"] });
    const resumedRun = run(again.program, ["--resume", UUID]);
    expect(resumedRun.status).toBe(0);
    expect(resumedRun.stdout).toContain(`fake-agent ready ${UUID} (resumed)`);
    expect(again.starts()[0]).toMatchObject({ session: UUID, resumed: true });
  });

  nodeTest("t45_fake_terminal_agent_behind_a_wrapper", () => {
    // The wrapper is the program; the agent behind it is another process and ends by its own script.
    const agent = writeFakeTerminalAgent({ dir: folder(), wrapper: true, startup: ["quit 0"] });
    const text = execFileSync(agent.program, ["--session-id", UUID], {
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(text).toContain(`fake-agent ready ${UUID}`);
    expect(agent.starts().length).toBe(1);
    expect(agent.starts()[0]?.tty).toBe(false);
  });
});

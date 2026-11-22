/**
 * `kodel agent attach` and `kodel agent exec --pty` as a person runs them: the built artifact on Node, typed
 * into a shell that sits in a terminal of the test's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { TERMINAL_RESET } from "../../packages/pipeline-core/src";
import {
  type Availability,
  alive,
  artifactProblem,
  Host,
  KODEL,
  type PtyRegister,
  ptyTests,
  realPtyTests,
  sleep,
  type Term,
  until,
  Wire,
  type World,
  world,
} from "./harness";

const real = realPtyTests();
const ptyTest = real.test;
/** The reset of a client whose program never entered the alternate screen. */
const RESET = TERMINAL_RESET.slice(0, -"\u001b[?1049l".length);

const worlds: World[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  for (const w of worlds.splice(0)) await w.dispose();
});

/** A project, a terminal with a shell in it, and a session started for the test. */
async function scene(script?: string, name = "worker") {
  const w = world();
  worlds.push(w);
  const host = new Host();
  hosts.push(host);
  const term = await host.shell(w);
  const started =
    script === undefined
      ? undefined
      : await w.adapter().start({
          argv: ["sh", "-c", script],
          cwd: w.root,
          mode: "pty",
          name,
          timeoutMs: 120_000,
        });
  return { w, host, term, id: started?.id ?? "", name };
}

/** The settings of the terminal the shell sits in, as `stty` prints them for itself. */
const settings = async (term: Term): Promise<string> => {
  const { shown } = await term.sh('echo "S<$(stty -g)>"');
  const found = /S<([^$>][^>]*)>/.exec(shown)?.[1];
  if (!found) throw new Error(`stty gave nothing: ${JSON.stringify(shown)}`);
  return found;
};

const clientPid = async (name: string): Promise<number> =>
  until(() => {
    const found = spawnSync("pgrep", ["-f", `agent attach ${name}$`], { encoding: "utf8" });
    const pid = Number(found.stdout.trim().split("\n")[0]);
    return pid > 1 ? pid : undefined;
  }, `the attach client of ${name}`);

describe("kodel agent attach on a terminal of its own", () => {
  ptyTest("tA_attach_client_clean_after_detach", async () => {
    const s = await scene("echo session-ready; exec cat");
    const before = await settings(s.term);
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    s.term.type("typed-in\r");
    await s.term.sees("typed-in\r\ntyped-in", undefined, from);
    s.term.type("\u001c");
    const done = await s.term.finished(from);
    expect(done.code).toBe(0);
    expect(done.shown).toContain(`${RESET}\r\n[detached: ${s.name}]`);
    expect(await settings(s.term)).toBe(before);
    // the agent goes on, and a second attach by id shows what was there
    expect((await s.w.adapter().status(s.id)).state).toBe("running");
    const again = s.term.begin(`${KODEL} agent attach ${s.id}`);
    await s.term.sees("typed-in\r\ntyped-in", undefined, again);
    s.term.type("\u001c");
    expect((await s.term.finished(again)).shown).toContain(`[detached: ${s.name}]`);
  });

  ptyTest("tA_attach_client_clean_after_exit", async () => {
    const s = await scene("echo session-ready; read line; exit 4");
    const before = await settings(s.term);
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    s.term.type("go\r");
    const done = await s.term.finished(from);
    expect(done.code).toBe(0);
    expect(done.shown).toContain(`${RESET}\r\n[ended: ${s.name}, exit 4]`);
    expect(await settings(s.term)).toBe(before);
  });

  ptyTest("t45_attach_client_keep_screen_leaves_the_terminal_clean", async () => {
    // What the TUI's `o` runs, here on a terminal with a shell: the client does not switch the screen
    // and writes no line of its own, and the terminal's settings are put back all the same.
    const s = await scene(
      "printf '\\033[?1049h\\033[?1000h\\033[?2004h'; echo session-ready; exec cat",
    );
    const before = await settings(s.term);
    const from = s.term.begin(`${KODEL} agent attach ${s.name} --keep-screen`);
    await s.term.sees("session-ready", undefined, from);
    s.term.type("typed-in\r");
    await s.term.sees("typed-in\r\ntyped-in", undefined, from);
    s.term.type("\u001c");
    const done = await s.term.finished(from);
    expect(done.code).toBe(0);
    // Cleared once before the first output; the session's switch of the screen is not passed on; the
    // modes it switched on are put back; no line, and the alternate screen is neither entered nor left.
    expect(done.shown).toContain("\u001b[2J\u001b[H");
    expect(done.shown).toContain(RESET);
    expect(done.shown).not.toContain("\u001b[?1049");
    expect(done.shown).not.toContain("[detached:");
    expect(await settings(s.term)).toBe(before);
    expect((await s.w.adapter().status(s.id)).state).toBe("running");
  });

  ptyTest("tA_attach_client_clean_after_kill", async () => {
    // the program switches modes on that the shell must not inherit
    const s = await scene(
      "printf '\\033[?1049h\\033[?1000h\\033[?2004h'; echo session-ready; exec cat",
    );
    const before = await settings(s.term);
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    await s.w.adapter().stop(s.id);
    const done = await s.term.finished(from);
    expect(done.code).toBe(0);
    // it had entered the alternate screen, so the reset leaves it
    expect(done.shown).toContain(`${TERMINAL_RESET}\r\n[killed: ${s.name}]`);
    expect(await settings(s.term)).toBe(before);
  });

  ptyTest("tA_attach_client_ctrl_c_goes_to_child", async () => {
    const s = await scene(
      "trap 'echo GOT-INT' INT; echo session-ready; while :; do sleep 0.2; done",
    );
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    const pid = await clientPid(s.name);
    s.term.type("\u0003");
    await s.term.sees("GOT-INT", undefined, from);
    s.term.type("\u0003");
    await s.term.sees(/GOT-INT[\s\S]*GOT-INT/, undefined, from);
    expect(alive(pid)).toBe(true);
    expect((await s.w.adapter().status(s.id)).state).toBe("running");
    s.term.type("\u001c");
    expect((await s.term.finished(from)).code).toBe(0);
  });

  ptyTest("tA_attach_client_resize", async () => {
    const s = await scene("echo session-ready; exec sh");
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    s.term.type("stty size\r");
    await s.term.sees("24 80", undefined, from);
    s.term.resize(91, 33);
    await until(
      async () => {
        const at = s.term.output.length;
        s.term.type("stty size\r");
        await sleep(200);
        return s.term.output.slice(at).includes("33 91");
      },
      "the new size to reach the agent",
      15_000,
      () => s.term.output.slice(from),
    );
    s.term.type("\u001c");
    await s.term.finished(from);
  });

  ptyTest(
    "tA_attach_client_blocked_stdout",
    async () => {
      const s = await scene(
        "echo session-ready; read line; head -c 6000000 /dev/zero | tr '\\0' x; echo; echo FLOOD-DONE; exec cat",
      );
      const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
      await s.term.sees("session-ready", undefined, from);
      // the terminal window stops drawing: the client's writes to it block
      s.term.pause();
      const other = new Wire(await s.w.adapter().attach(s.id)).hello();
      other.input("go\r");
      await other.sees("FLOOD-DONE", 45_000);
      other.input("still-here\r");
      await other.sees("still-here\r\nstill-here");
      expect((await s.w.adapter().status(s.id)).state).toBe("running");
      // the client that did not read was dropped; it restores its terminal when the window draws again
      s.term.resume();
      const done = await s.term.finished(from, 45_000);
      expect(done.shown).toContain(`[detached: ${s.name}]`);
      expect(done.code).toBe(1);
    },
    120_000,
  );

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const) {
    ptyTest(`tA_attach_client_${signal.toLowerCase()}_restores`, async () => {
      const s = await scene(
        "printf '\\033[?1000h'; echo session-ready; exec cat",
        `by-${signal.toLowerCase()}`,
      );
      const before = await settings(s.term);
      const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
      await s.term.sees("session-ready", undefined, from);
      process.kill(await clientPid(s.name), signal);
      const done = await s.term.finished(from);
      expect(done.shown).toContain(`${RESET}\r\n[detached: ${s.name}]`);
      expect(done.shown).toContain(signal);
      expect(done.code).toBe(1);
      expect(await settings(s.term)).toBe(before);
      expect((await s.w.adapter().status(s.id)).state).toBe("running");
    });
  }

  ptyTest("tA_attach_client_socket_dropped_exits", async () => {
    const s = await scene("echo session-ready; exec cat");
    const before = await settings(s.term);
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    process.kill((s.w.status(s.id).holder as { pid: number }).pid, "SIGKILL");
    const done = await s.term.finished(from);
    expect(done.shown).toContain(`${RESET}\r\n[detached: ${s.name}]`);
    expect(done.shown).toContain("the connection to the session was lost");
    expect(done.code).toBe(1);
    expect(await settings(s.term)).toBe(before);
  });

  ptyTest("tA_attach_client_drains_late_answer", async () => {
    const s = await scene("echo session-ready; exec cat");
    const from = s.term.begin(`${KODEL} agent attach ${s.name}`);
    await s.term.sees("session-ready", undefined, from);
    s.term.type("\u001c");
    await s.term.sees("[detached:", undefined, from);
    // what a terminal answers to a query of the last output arrives after the detach was drawn
    s.term.type("\u001b[12;40R");
    const done = await s.term.finished(from);
    expect(done.code).toBe(0);
    const after = (await s.term.sh("echo shell-is-clean")).shown;
    // the shell never saw the answer: it neither echoed it nor ran it
    expect(done.shown.split("[detached:")[1]).not.toContain("12;40R");
    expect(after).not.toContain("12;40R");
    expect(after).toContain("shell-is-clean");
  });

  ptyTest("tA_agent_attach_real_refusals_name_the_reason", async () => {
    const s = await scene("exit 0", "over");
    await s.w.adapter().wait(s.id, { timeoutMs: 15_000 });
    const ended = await s.term.sh(`${KODEL} agent attach over`);
    expect(ended.code).toBe(1);
    expect(ended.shown).toContain("NOT_ATTACHABLE");
    expect(ended.shown).toContain("is exited");
    const pipes = await s.term.sh(`${KODEL} agent exec --name piped -- sleep 30`);
    expect(pipes.code).toBe(0);
    const refused = await s.term.sh(`${KODEL} agent attach piped`);
    expect(refused.code).toBe(1);
    expect(refused.shown).toContain("it has no terminal to attach to");
    expect((await s.term.sh(`${KODEL} agent attach nobody`)).shown).toContain("NOT_FOUND");
  });
});

describe("kodel agent exec --pty at a shell", () => {
  ptyTest("tA_pty_starter_returns", async () => {
    const s = await scene();
    const started = await s.term.sh(`${KODEL} agent exec --pty --name bg -- sleep 300`);
    // the starter is back at the prompt while the agent runs: it holds nothing of the holder
    expect(started.code).toBe(0);
    expect(started.shown).toMatch(/started a_[0-9a-z_]+ \(bg\)/);
    expect(started.shown).toContain("kodel agent attach bg");
    const [row] = await s.w.adapter().list({ name: "bg" });
    expect(row?.status.state).toBe("running");
    const record = s.w.status(row?.id as string) as { holder: { pid: number }; sock: string };
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(record.holder.pid)], {
      encoding: "utf8",
    });
    expect(Number(parent.stdout.trim())).toBe(1);
    const listed = await s.term.sh(`${KODEL} agent ls`);
    expect(listed.shown).toMatch(/bg\s+running/);
    const logs = await s.term.sh(`${KODEL} agent logs ${row?.id} --stdout`);
    expect(logs.code).toBe(1);
    expect(logs.shown).toContain("UNSUPPORTED");
  });

  ptyTest("tA_pty_exec_no_such_cmd_frees_name", async () => {
    const s = await scene();
    const missing = await s.term.sh(`${KODEL} agent exec --pty --name once -- no-such-command-xyz`);
    expect(missing.code).toBe(1);
    expect(missing.shown).toContain("HOLDER_BOOT_FAILED");
    expect(await s.w.adapter().list()).toEqual([]);
    const again = await s.term.sh(`${KODEL} agent exec --pty --name once -- sleep 300`);
    expect(again.code).toBe(0);
    expect(again.shown).toContain("(once)");
  });
});

describe("the skip of a real test", () => {
  const recorder = () => {
    const ran: { name: string; body: () => unknown }[] = [];
    const skipped: string[] = [];
    const register: PtyRegister = {
      run: (name, body) => void ran.push({ name, body }),
      skip: (name) => void skipped.push(name),
    };
    return { ran, skipped, register };
  };
  const missing: Availability = { ok: false, reason: "a terminal cannot be opened here" };

  test("tA_pty_skip_is_reported_not_passed", () => {
    const lines: string[] = [];
    const quiet = recorder();
    const suite = ptyTests({
      available: missing,
      required: false,
      register: quiet.register,
      log: (line) => lines.push(line),
    });
    suite.test("tA_one", () => {});
    suite.test("tA_two", () => {});
    expect(quiet.ran).toEqual([]);
    expect(quiet.skipped).toEqual(["tA_one", "tA_two"]);
    expect(suite.done()).toBe(2);
    expect(lines).toEqual(["PTY tests skipped: 2, a terminal cannot be opened here"]);

    // where a terminal is required, the same tests are registered to run and each of them fails
    const strict = recorder();
    const required = ptyTests({ available: missing, required: true, register: strict.register });
    required.test("tA_one", () => {});
    expect(strict.skipped).toEqual([]);
    expect(() => strict.ran[0]?.body()).toThrow(/KODEL_REQUIRE_PTY=1.*a terminal cannot be opened/);
    expect(required.done()).toBe(0);

    const there = recorder();
    const runs = ptyTests({ available: { ok: true }, required: true, register: there.register });
    let called = 0;
    runs.test("tA_one", () => void called++);
    there.ran[0]?.body();
    expect(called).toBe(1);

    // a build older than the sources is a reason like any other: skipped, or failed where required
    expect(artifactProblem(undefined, 5)).toContain("bun run build");
    expect(artifactProblem(4, 5)).toContain("older than the sources");
    expect(artifactProblem(5, 5)).toBeUndefined();
  });
});

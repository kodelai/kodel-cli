import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@kodel-ai/pipeline-core";
import {
  DEFAULT_MAX_TAIL_BYTES,
  killTree,
  liveProcess,
  type ProcessIdentity,
  parseLstart,
  processIdentity,
  runCommand,
  type StartClock,
  type StartedRow,
  type StartMark,
  startedBefore,
  type TreeLeader,
} from "../src";

// A sandbox may forbid `ps`; a test that needs the process table is then skipped, unless the job requires it.
const skipTable =
  processIdentity(process.pid) === undefined && process.env.KODEL_REQUIRE_PROCTABLE !== "1";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const node = (code: string) => `node -e "${code}"`;
const run = (command: string, over: Record<string, unknown> = {}) =>
  runCommand(command, { cwd: dir, ...over });

describe("running a command", () => {
  test("a command that succeeds: exit 0 and its output", async () => {
    const result = await run(node("console.log('hello from the command')"));
    expect(result).toMatchObject({ exit: 0, timedOut: false, aborted: false, truncated: false });
    expect(result.tail).toContain("hello from the command");
  });

  test("a failing exit code is passed on", async () => {
    expect((await run(node("process.exit(3)"))).exit).toBe(3);
  });

  test("stdout and stderr end up in the same tail, in order", async () => {
    const result = await run(node("console.log('out'); console.error('err')"));
    expect(result.tail).toContain("out");
    expect(result.tail).toContain("err");
  });

  test("the command runs in the given directory", async () => {
    const result = await run(node("console.log(process.cwd())"));
    expect(result.tail.trim().toLowerCase()).toContain(dir.toLowerCase().replace(/^\/private/, ""));
  });

  test("extra environment variables are visible, and unset ones are not", async () => {
    const result = await run(node("console.log('v=' + process.env.KODEL_TEST_VAR)"), {
      env: { KODEL_TEST_VAR: "yes" },
    });
    expect(result.tail).toContain("v=yes");
  });

  test("stdin is closed, so a command that reads it does not hang", async () => {
    const result = await run(
      node("process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"),
      { timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.tail).toContain("eof");
  });

  test("a command that does not exist fails without throwing", async () => {
    const result = await run("kodel-no-such-command-xyz");
    expect(result.exit).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the duration is measured", async () => {
    const result = await run(node("setTimeout(() => {}, 150)"));
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });
});

describe("timeout and abort", () => {
  test("a command that runs too long is killed and reported as timed out", async () => {
    const result = await run(node("setTimeout(() => {}, 60000)"), { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exit).not.toBe(0);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  test.skipIf(process.platform === "win32")(
    "the whole process tree is killed, not only the shell",
    async () => {
      const pidFile = join(dir, "child.pid");
      const code =
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
        `require('fs').writeFileSync('${pidFile.replace(/\\/g, "/")}', String(c.pid));` +
        "setTimeout(() => {}, 60000)";
      const result = await run(node(code), { timeoutMs: 800 });
      expect(result.timedOut).toBe(true);
      const pid = Number(await readFile(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  );

  test("an abort signal stops the command", async () => {
    const controller = new AbortController();
    const pending = run(node("setTimeout(() => {}, 60000)"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("a signal that is already aborted never lets the command run on", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(node("setTimeout(() => {}, 60000)"), { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });
});

describe("output", () => {
  test("only the end of long output is kept, and that is said", async () => {
    const result = await run(node("for (let i = 0; i < 20000; i++) console.log('line ' + i)"), {
      maxTailBytes: 2000,
    });
    expect(result.exit).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.tail.startsWith("[earlier output omitted]")).toBe(true);
    expect(result.tail).toContain("line 19999");
    expect(result.tail).not.toContain("line 0\n");
    expect(Buffer.byteLength(result.tail)).toBeLessThan(2200);
  });

  test("short output is not marked as truncated", async () => {
    const result = await run(node("console.log('short')"), { maxTailBytes: 2000 });
    expect(result.truncated).toBe(false);
    expect(result.tail).not.toContain("omitted");
  });

  test("a secret in the output is redacted before it is returned", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const result = await run(node(`console.log('using ${key}')`), {
      redact: (t: string) => redactText(t),
    });
    expect(result.tail).not.toContain(key);
    expect(result.tail).toContain("[REDACTED:aws-key]");
  });

  test("output split in the middle of a multi-byte character does not leave garbage at the start", async () => {
    const result = await run(node("console.log('я'.repeat(3000))"), { maxTailBytes: 1001 });
    expect(result.tail.replace("[earlier output omitted]\n", "").startsWith("�")).toBe(false);
  });
});

describe("cnz6 the output kept from a command", () => {
  const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  test("cnz6_the_default_tail_is_64_kib", () => {
    expect(DEFAULT_MAX_TAIL_BYTES).toBe(64 * 1024);
  });

  test("cnz6_no_piece_of_a_secret_survives_wherever_the_cut_falls", async () => {
    for (const after of [1950, 1965, 1975, 1985, 1995, 2005, 2020]) {
      const code = `process.stdout.write('x'.repeat(1990) + ' ${secret} ' + 'y'.repeat(${after}))`;
      const result = await run(node(code), {
        maxTailBytes: 2000,
        redact: (t: string) => redactText(t),
      });
      for (let i = 0; i + 6 <= secret.length; i++) {
        expect(result.tail).not.toContain(secret.slice(i, i + 6));
      }
    }
  });

  test("cnz6_the_stored_tail_with_its_marker_never_exceeds_the_limit", async () => {
    const result = await run(node("console.log('z'.repeat(5000))"), { maxTailBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(100);
    expect(result.tail.startsWith("[earlier output omitted]\n")).toBe(true);
  });

  test("cnz6_abort_keeps_what_was_read", async () => {
    const controller = new AbortController();
    const pending = run(node("console.log('read before abort'); setTimeout(() => {}, 60000)"), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1000);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.tail).toContain("read before abort");
  });

  test("cnz6_crlf_output_is_kept_as_it_was_written", async () => {
    const result = await run(node("process.stdout.write('one\\r\\ntwo\\r\\n')"));
    expect(result.tail).toBe("one\r\ntwo\r\n");
  });

  test("cnz6_a_hundred_megabytes_of_output_keep_only_the_default_limit", async () => {
    const code =
      "const b = Buffer.alloc(1 << 20, 97); let n = 0; (function w() { while (n < 100) { n++; if (!process.stdout.write(b)) return process.stdout.once('drain', w); } })()";
    const result = await run(node(code));
    expect(result.exit).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(DEFAULT_MAX_TAIL_BYTES);
  }, 60_000);

  test("cnz6_invalid_utf8_and_nul_bytes_come_back_as_text_without_throwing", async () => {
    const result = await run(
      node("process.stdout.write(Buffer.from([0x61, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x62]))"),
    );
    expect(result.exit).toBe(0);
    expect(result.tail.startsWith("a")).toBe(true);
    expect(result.tail.endsWith("b")).toBe(true);
    expect(result.tail).toContain("\0");
  });

  test("cnz6_a_private_key_whose_header_is_cut_off_is_still_redacted", async () => {
    // The key is longer than the margin, so the read window starts inside its body.
    const script = join(dir, "pem.js");
    await writeFile(
      script,
      [
        "const body = Array.from({ length: 80 }, (_, i) => 'Zm9v' + String(i).padStart(4, '0') + 'QmFyQmF6UXV4'.repeat(4)).join('\\n');",
        "process.stdout.write('x'.repeat(100) + '\\n-----BEGIN RSA PRIVATE KEY-----\\n' + body + '\\n-----END RSA PRIVATE KEY-----\\nafter the key\\n');",
      ].join("\n"),
    );
    const result = await run(`node ${script}`, {
      maxTailBytes: 2000,
      redact: (t: string) => redactText(t),
    });
    expect(result.truncated).toBe(true);
    expect(result.tail).not.toContain("QmFyQmF6UXV4");
    expect(result.tail).not.toContain("END RSA PRIVATE KEY");
    expect(result.tail).toContain("after the key");
  });

  test("cnz6_a_secret_split_across_two_writes_is_redacted", async () => {
    const code = `process.stdout.write('${secret.slice(0, 8)}'); setTimeout(() => process.stdout.write('${secret.slice(8)}'), 100)`;
    const result = await run(node(code), { redact: (t: string) => redactText(t) });
    expect(result.tail).not.toContain(secret.slice(4));
  });

  test("cnz6_timeout_keeps_what_was_read", async () => {
    const code = "console.log('before the hang'); setTimeout(() => {}, 60000)";
    const result = await run(node(code), { timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.tail).toContain("before the hang");
  });

  test("cnz6_a_command_that_prints_a_lot_keeps_only_the_limit", async () => {
    const code =
      "const b = Buffer.alloc(1 << 20, 97); for (let i = 0; i < 20; i++) process.stdout.write(b)";
    const result = await run(node(code), { maxTailBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(4096 + 30);
  });

  test("cnz6_binary_nul_ansi_and_a_last_line_without_a_newline_do_not_break_the_tail", async () => {
    const code =
      "process.stdout.write(Buffer.from([0, 255, 254, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x61, 0x0d, 0x0a, 0x7a]))";
    const result = await run(node(code));
    expect(result.exit).toBe(0);
    expect(result.tail.endsWith("z")).toBe(true);
    expect(result.tail).toContain("\r\n");
  });
});

describe("killTree signals a process group only while its leader lives", () => {
  class FakeLeader implements TreeLeader {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    constructor(readonly pid: number) {}
    end(signal: NodeJS.Signals) {
      this.signalCode = signal;
    }
  }
  const row = (pid: number, started: number, over: Partial<StartedRow> = {}): StartedRow => ({
    pid,
    pgid: 4242,
    session: 4242,
    zombie: false,
    started,
    identity: { method: "proc-ticks", value: String(started) },
    ...over,
  });
  const world = (pid = 4242) => {
    const sent: [number, string][] = [];
    const state: {
      alive: boolean;
      tick: number | undefined;
      rows: StartedRow[] | undefined;
      reads: number;
      identity: (pid: number) => ProcessIdentity | undefined;
    } = {
      alive: true,
      tick: 1000,
      rows: [],
      reads: 0,
      identity: (target) => state.rows?.find((r) => r.pid === target)?.identity,
    };
    const leader = new FakeLeader(pid);
    const clock: StartClock = {
      now: () =>
        state.tick === undefined ? undefined : { method: "proc-ticks", at: state.tick, mono: 0 },
      rows: () => {
        state.reads += 1;
        return state.rows;
      },
      identity: (target) => state.identity(target),
    };
    const parts = {
      kill: (target: number, signal: NodeJS.Signals) => void sent.push([target, signal]),
      alive: () => state.alive,
      clock,
      graceMs: 30,
      platform: "linux" as const,
    };
    return { sent, state, leader, parts };
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("t47_kill_tree_leader_gone_before_the_grace_kills_its_members_by_pid_and_no_group", async () => {
    const w = world();
    killTree(w.leader, w.parts);
    expect(w.sent).toEqual([[-4242, "SIGTERM"]]);
    w.leader.end("SIGTERM");
    w.state.tick = 1200;
    w.state.rows = [
      row(5001, 900), // a member that ignored SIGTERM
      row(5002, 999),
      row(5003, 1000), // started in the tick of the SIGTERM: not known to be before it
      row(5004, 1100), // started after the SIGTERM: the number may be another program's by then
      row(5005, 900, { pgid: 7 }),
      row(5006, 900, { zombie: true }),
      row(5007, 900, { session: 7 }),
      row(5008, 900, { identity: { method: "ps-lstart", value: "x" } }),
    ];
    await pause(80);
    expect(w.sent).toEqual([
      [-4242, "SIGTERM"],
      [5001, "SIGKILL"],
      [5002, "SIGKILL"],
    ]);
    expect(w.state.reads).toBe(1);
  });

  test("t47_kill_tree_leader_gone_with_no_member_left_signals_nothing_more", async () => {
    const w = world();
    killTree(w.leader, w.parts);
    w.leader.end("SIGTERM");
    await pause(80);
    expect(w.sent).toEqual([[-4242, "SIGTERM"]]);
  });

  test("t47_kill_tree_member_is_killed_only_while_it_is_still_the_process_of_the_table", async () => {
    const w = world();
    killTree(w.leader, w.parts);
    w.leader.end("SIGTERM");
    w.state.rows = [row(5001, 900), row(5002, 900), row(5003, 900)];
    w.state.identity = (target) =>
      target === 5001
        ? { method: "proc-ticks", value: "1500" } // the pid is another process by now
        : target === 5002
          ? undefined // gone, or cannot be read
          : { method: "proc-ticks", value: "900" };
    await pause(80);
    expect(w.sent).toEqual([
      [-4242, "SIGTERM"],
      [5003, "SIGKILL"],
    ]);
  });

  test("t47_kill_tree_leader_gone_signals_nothing_where_the_table_or_the_clock_cannot_be_read", async () => {
    const table = world();
    killTree(table.leader, table.parts);
    table.leader.end("SIGTERM");
    table.state.rows = undefined;

    const clock = world();
    clock.state.tick = undefined; // not read at the SIGTERM
    killTree(clock.leader, clock.parts);
    clock.leader.end("SIGTERM");
    clock.state.tick = 1200;
    clock.state.rows = [row(5001, 900)];

    const later = world();
    killTree(later.leader, later.parts);
    later.leader.end("SIGTERM");
    later.state.tick = undefined; // not read at the escalation
    later.state.rows = [row(5001, 900)];

    await pause(80);
    for (const w of [table, clock, later]) expect(w.sent).toEqual([[-4242, "SIGTERM"]]);
  });

  test("t47_started_before_takes_a_whole_second_of_ps_and_refuses_a_clock_set_back", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 30, 500);
    const second = (s: number) => Date.UTC(2026, 0, 1, 12, 0, s);
    const ps = (pid: number, started: number): StartedRow => ({
      pid,
      pgid: 4242,
      zombie: false,
      started,
      identity: { method: "ps-lstart", value: String(started) },
    });
    const rows = [ps(1, second(28)), ps(2, second(29)), ps(3, second(30)), ps(4, second(31))];
    const mark = { method: "ps-lstart" as const, at, mono: 10_000 };
    const pids = (later: StartMark) => startedBefore(rows, 4242, mark, later)?.map((r) => r.pid);
    expect(pids({ method: "ps-lstart", at: at + 2_000, mono: 12_000 })).toEqual([1, 2]);
    // The wall clock went back a second while two passed: a new process would look old.
    expect(pids({ method: "ps-lstart", at: at - 1_000, mono: 12_000 })).toBeUndefined();
    expect(pids({ method: "proc-ticks", at: 5, mono: 12_000 })).toBeUndefined();
    // Just after the turn of a second, the second before it is not taken for wholly earlier.
    const turn = { method: "ps-lstart" as const, at: second(30) + 50, mono: 0 };
    expect(
      startedBefore(rows, 4242, turn, { ...turn, at: turn.at + 2_000, mono: 2_000 })?.map(
        (r) => r.pid,
      ),
    ).toEqual([1]);
    expect(parseLstart("Tue Nov 24 10:02:03 2026")).toBe(Date.UTC(2026, 10, 24, 10, 2, 3));
    expect(parseLstart("Sun Nov  1 00:00:00 2026")).toBe(Date.UTC(2026, 10, 1));
    expect(parseLstart("10:02")).toBeUndefined();
  });

  test("t47_kill_tree_leader_that_ignores_sigterm_gets_sigkill", async () => {
    const w = world();
    killTree(w.leader, w.parts);
    killTree(w.leader, w.parts); // asked again (the holder's watcher): one escalation, not two
    await pause(80);
    expect(w.sent).toEqual([
      [-4242, "SIGTERM"],
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
    expect(w.state.reads).toBe(0);
  });

  test("t47_kill_tree_looks_at_the_leader_again_before_the_sigkill", async () => {
    // The exit was not reported yet, but the process is gone: its group number may be another's.
    const gone = world();
    killTree(gone.leader, gone.parts);
    gone.state.alive = false;
    gone.state.rows = [row(5001, 900), row(5002, 1100)];
    await pause(80);
    expect(gone.sent).toEqual([
      [-4242, "SIGTERM"],
      [5001, "SIGKILL"],
    ]);

    // reaped without the listener having run
    const reaped = world();
    killTree(reaped.leader, reaped.parts);
    reaped.leader.exitCode = 0;
    await pause(80);
    expect(reaped.sent).toEqual([[-4242, "SIGTERM"]]);
  });

  test("t47_kill_tree_signals_nothing_of_a_leader_that_has_ended", async () => {
    const ended = world();
    ended.leader.exitCode = 0;
    ended.state.rows = [row(5001, 900)];
    killTree(ended.leader, ended.parts);
    const dead = world();
    dead.state.alive = false;
    dead.state.rows = [row(5001, 900)];
    killTree(dead.leader, dead.parts);
    await pause(80);
    expect(ended.sent).toEqual([]);
    expect(dead.sent).toEqual([]);
  });

  test("t47_kill_tree_cancel_drops_the_pending_sigkill", async () => {
    const w = world();
    killTree(w.leader, w.parts)();
    w.leader.end("SIGTERM");
    w.state.rows = [row(5001, 900)];
    await pause(80);
    expect(w.sent).toEqual([[-4242, "SIGTERM"]]);
  });

  test.skipIf(process.platform === "win32")(
    "t47_kill_tree_real_leader_that_ends_on_sigterm_is_not_signalled_again",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        stdio: "ignore",
        detached: true,
      });
      await new Promise((resolve) => child.once("spawn", resolve));
      const sent: [number, string][] = [];
      const exited = new Promise((resolve) => child.once("exit", resolve));
      killTree(child, {
        graceMs: 300,
        kill: (target, signal) => {
          sent.push([target, signal]);
          process.kill(target, signal);
        },
      });
      await exited;
      await pause(500);
      expect(sent).toEqual([[-(child.pid as number), "SIGTERM"]]);
    },
  );

  // The shape of `sh -c 'node ...'` where the shell does not exec its last command (Linux): the leader ends on
  // SIGTERM and a member of its group that ignores it lives on, in a group without a leader.
  test.skipIf(process.platform === "win32" || skipTable)(
    "t47_kill_tree_real_member_that_ignores_sigterm_does_not_outlive_its_leader",
    async () => {
      const member = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const leader = [
        "const { spawn } = require('node:child_process');",
        `const c = spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: 'inherit' });`,
        "console.log(c.pid);",
        "setInterval(() => {}, 1000);",
      ].join("");
      const child = spawn(process.execPath, ["-e", leader], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
      const memberPid = await new Promise<number>((resolve) => {
        child.stdout?.once("data", (data: Buffer) => resolve(Number(data.toString().trim())));
      });
      const sent: [number, string][] = [];
      try {
        expect(Number.isInteger(memberPid)).toBe(true);
        // `ps` tells a start to the second: the member has to be a whole second old at the SIGTERM.
        await pause(2_200);
        const exited = new Promise((resolve) => child.once("exit", resolve));
        killTree(child, {
          graceMs: 500,
          kill: (target, signal) => {
            sent.push([target, signal]);
            process.kill(target, signal);
          },
        });
        await exited;
        expect(liveProcess(memberPid)).toBe(true);
        const until = Date.now() + 5_000;
        while (liveProcess(memberPid) && Date.now() < until) await pause(50);
        expect(liveProcess(memberPid)).toBe(false);
        expect(sent).toEqual([
          [-(child.pid as number), "SIGTERM"],
          [memberPid, "SIGKILL"],
        ]);
      } finally {
        for (const pid of [memberPid, child.pid]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "t47_run_command_timeout_kills_a_command_that_ignores_sigterm",
    async () => {
      const code = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)";
      const result = await run(`exec node -e "${code}"`, { timeoutMs: 500 });
      expect(result.timedOut).toBe(true);
      expect(result.exit).toBe(137);
    },
    15_000,
  );
});

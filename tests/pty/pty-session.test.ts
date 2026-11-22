/**
 * Terminal sessions on a real PTY: the holder is the built artifact on Node, the adapter and the clients that
 * speak the frames are in this process.
 */
import { afterEach, describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { staleSocket } from "../../packages/local/test/helpers/socket-env";
import {
  encodeSend,
  FRAME,
  type RedactRule,
  SEND_PASTE_GAP_MS,
  SessionError,
  type SessionSpec,
} from "../../packages/pipeline-core/src";
import { sessionContract } from "../../packages/testkit/src";
import {
  ARTIFACT,
  alive,
  Host,
  KODEL,
  realPtyTests,
  shortDir,
  until,
  Wire,
  type World,
  world,
} from "./harness";

const real = realPtyTests();
const ptyTest = real.test;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;

const worlds: World[] = [];
const hosts: Host[] = [];
const temps: string[] = [];
/** A short folder for a `TMPDIR` of the test, removed when the test is over. */
const tempDir = (prefix: string): string => {
  const dir = shortDir(prefix);
  temps.push(dir);
  return dir;
};
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  for (const w of worlds.splice(0)) await w.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const newWorld = (options?: Parameters<typeof world>[0]): World => {
  const w = world(options);
  worlds.push(w);
  return w;
};

const pty = (w: World, argv: string[], extra: Partial<SessionSpec> = {}): SessionSpec => ({
  argv,
  cwd: w.root,
  mode: "pty",
  timeoutMs: 120_000,
  ...extra,
});
const sh = (w: World, script: string, extra: Partial<SessionSpec> = {}): SessionSpec =>
  pty(w, ["sh", "-c", script], extra);

/** A client that shows the terminal, as `attach` makes one. */
const attach = async (w: World, id: string, cols = 80, rows = 24): Promise<Wire> =>
  new Wire(await w.adapter().attach(id)).hello({ cols, rows });

const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof SessionError ? error.code : `other: ${String(error)}`;
  }
};

/** Runs `body` with another `TMPDIR`: a holder started inside inherits it. */
const withTmp = async <T>(dir: string, body: () => Promise<T>): Promise<T> => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
};

describe("a terminal session on a real PTY", () => {
  ptyTest("tA_pty_host_helper_selftest", async () => {
    const w = newWorld();
    const host = new Host();
    hosts.push(host);
    await host.ping(7);
    const term = await host.open("/bin/sh", ["-c", "echo from-the-host; exit 5"], {
      cwd: w.root,
      env: w.env,
    });
    expect(term.pid).toBeGreaterThan(1);
    expect((await term.ended()).exitCode).toBe(5);
    expect(term.output).toContain("from-the-host");
    const echo = await host.open("/bin/cat", [], { cwd: w.root, env: w.env });
    echo.type("typed\r");
    await echo.sees("typed\r\ntyped");
    echo.kill("SIGKILL");
    await echo.ended();
  });

  ptyTest("tA_pty_attach_echo", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const client = await attach(w, id);
    await until(() => client.welcome, "the welcome");
    client.input("ping\r");
    // the terminal echoes the typing and `cat` writes the line back
    await client.sees("ping\r\nping\r\n");
  });

  ptyTest(
    "tA_pty_input_bytes_unchanged: a mouse report and keys with the eighth bit reach the program as typed",
    async () => {
      const w = newWorld();
      // A program that shows every byte as it arrives, in hex, and then `end`: what `od` shows waits for a whole
      // line, and a byte that was lost or changed on the way is seen at once, with the ones before it.
      const reader = [
        "import os, sys",
        "n = 0",
        "while n < 16:",
        "    got = os.read(0, 16)",
        "    if not got:",
        "        break",
        "    for byte in got:",
        '        sys.stdout.write("%02x " % byte)',
        "    sys.stdout.flush()",
        "    n += len(got)",
        'sys.stdout.write("end\\n")',
        "sys.stdout.flush()",
      ].join("\n");
      const { id } = await w
        .adapter()
        .start(sh(w, `stty raw -echo; echo ready; exec python3 -u -c '${reader}'`));
      const client = await attach(w, id);
      await client.sees("ready");
      // an X10 mouse report at column 200 and row 223, then bytes that are no UTF-8 text: 16 bytes
      const typed = [
        0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0xff, 0xe1, 0x80, 0xc3, 0x28, 0xfe, 0x41, 0x9b, 0x42, 0xa9,
        0x43,
      ];
      client.input(String.fromCharCode(...typed));
      const line = typed.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
      await client.sees(`${line} end`);
    },
  );

  ptyTest(
    "tA_attach_input_flood_paused_at_bound: a program that does not read does not grow the holder",
    async () => {
      const w = newWorld();
      // a raw terminal: the system takes typed bytes only as long as it has room, and the program takes none
      const { id } = await w.adapter().start(sh(w, "stty raw -echo; echo ready; exec sleep 60"));
      const holder = (w.status(id).holder as { pid: number }).pid;
      const rss = (): number =>
        Number(
          spawnSync("ps", ["-o", "rss=", "-p", String(holder)], { encoding: "utf8" }).stdout.trim(),
        ) * 1024;
      const flood = await attach(w, id);
      await flood.sees("ready");
      const before = rss();
      expect(before).toBeGreaterThan(0);
      const total = 96 * 1024 * 1024;
      const piece = "x".repeat(32 * 1024);
      for (let sent = 0; sent < total; sent += piece.length) flood.input(piece);
      // time for a holder that takes everything to take it
      await until(
        () => flood.stream.pending() < total / 2 || undefined,
        "the flood to be read",
        4_000,
      ).catch(() => {});
      // the holder stopped reading this client: most of the flood is still on the client's side
      expect(flood.stream.pending()).toBeGreaterThan(total / 2);
      expect(rss() - before).toBeLessThan(32 * 1024 * 1024);
      // the session and its other clients go on
      expect(w.status(id).state).toBe("running");
      const other = await attach(w, id);
      await other.sees("ready");
      expect(flood.closed).toBe(false);
      flood.close();
      other.close();
    },
  );

  ptyTest(
    "tA_attach_send_flood_paused_at_bound: sends to a program that does not read are not answered and not queued",
    async () => {
      const w = newWorld();
      const { id } = await w.adapter().start(sh(w, "stty raw -echo; echo ready; exec sleep 60"));
      const watch = await attach(w, id);
      await watch.sees("ready");
      const flood = new Wire(await w.adapter().attach(id)).helloQuiet();
      const text = "x".repeat(60_000);
      const count = 200;
      const frame = encodeSend({ text, submit: false });
      for (let i = 0; i < count; i++) flood.raw(frame);
      const sent = (): number => flood.frames.filter((f) => f.type === FRAME.SENT).length;
      // time for a holder that answers a send as soon as it is queued to answer them all
      await until(() => sent() >= count || undefined, "every send to be answered", 4_000).catch(
        () => {},
      );
      // the terminal has room for a little and the program takes nothing: the first send is still owed
      expect(sent()).toBe(0);
      // the holder stopped reading this client at the bound: the rest is still on the client's side
      expect(flood.stream.pending()).toBeGreaterThan((count * frame.length) / 2);
      expect(flood.closed).toBe(false);
      expect(w.status(id).state).toBe("running");
      const other = await attach(w, id);
      await other.sees("ready");
      flood.close();
      other.close();
      watch.close();
    },
  );

  ptyTest(
    "tA_bye_flushed_before_holder_ends: a client that reads late still gets the last output and the end",
    async () => {
      const w = newWorld();
      const { id } = await w.adapter().start(
        sh(
          w,
          // The second before `exit` is for the holder to take what the program wrote: on Linux the kernel
          // throws away output nobody has read yet when the program that leads the session ends, and a holder that
          // is a few kilobytes behind (a loaded machine, 3 MB at once) would lose the end of it.
          "echo ready; read line; head -c 3000000 /dev/zero | tr '\\0' x; echo; echo LAST-LINE; sleep 1; exit 7",
        ),
      );
      const client = await attach(w, id);
      await client.sees("ready");
      // the client stops reading, the program writes 3 MB and ends: the holder has them queued when it ends
      client.stream.pause();
      client.input("\r");
      await until(
        () => !alive((w.status(id).child as { pid: number }).pid) || undefined,
        "the program to end",
      );
      await new Promise((r) => setTimeout(r, 300));
      client.stream.resume();
      await client.sees("LAST-LINE");
      await until(() => client.bye, "the end to be told");
      expect(client.bye).toEqual({ reason: "exited", exitCode: 7 });
      expect(client.output.length).toBeGreaterThan(3_000_000);
    },
  );

  ptyTest("tA_pty_reattach_replay", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const first = await attach(w, id);
    first.input("remember-me\r");
    await first.sees("remember-me\r\nremember-me");
    first.close();
    const second = await attach(w, id);
    await second.sees("remember-me\r\nremember-me");
    second.input("again\r");
    await second.sees("again\r\nagain");
  });

  ptyTest("tA_pty_detach_keeps_child", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const child = (w.status(id).child as { pid: number }).pid;
    const client = await attach(w, id);
    client.input("x\r");
    await client.sees("x\r\nx");
    client.close();
    await until(() => client.closed, "the client to close");
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(child)).toBe(true);
    expect((await w.adapter().status(id)).state).toBe("running");
  });

  ptyTest("tA_pty_resize_reaches_child", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["sh"], { size: { cols: 70, rows: 20 } }));
    const client = await attach(w, id, 100, 30);
    client.input("stty size\r");
    await client.sees("30 100");
    client.resize(91, 22);
    client.input("stty size\r");
    await client.sees("22 91");
  });

  ptyTest("tA_pty_child_term_default", async () => {
    const w = newWorld();
    const script = 'echo "T=$TERM L=$' + "{LINES-none} C=$" + '{COLUMNS-none}"; sleep 30';
    const bare = w.adapter({
      baseEnv: { PATH: process.env.PATH, TERM: "dumb", LINES: "5", COLUMNS: "7" },
    });
    const dumb = await bare.start(sh(w, script));
    await (await attach(w, dumb.id)).sees("T=xterm-256color L=none C=none");
    const own = w.adapter({ baseEnv: { PATH: process.env.PATH, TERM: "vt220" } });
    const kept = await own.start(sh(w, script));
    await (await attach(w, kept.id)).sees("T=vt220 L=none C=none");
  });

  ptyTest("tA_pty_child_cwd_from_spec", async () => {
    const w = newWorld();
    const sub = join(w.root, "sub dir");
    mkdirSync(sub);
    const { id } = await w.adapter().start(sh(w, "pwd; sleep 30", { cwd: sub }));
    await (await attach(w, id, 200, 24)).sees(sub);
  });

  ptyTest("tA_pty_child_umask_unchanged", async () => {
    const w = newWorld();
    const mine = process.umask().toString(8).padStart(4, "0");
    const { id } = await w.adapter().start(sh(w, 'echo "umask=$(umask)"; sleep 30'));
    await (await attach(w, id)).sees(`umask=${mine}`);
  });

  ptyTest("tA_pty_ready_after_listen", async () => {
    const w = newWorld();
    for (let i = 0; i < 4; i++) {
      const { id } = await w.adapter().start(pty(w, ["cat"]));
      // no wait between the start and the attach: `ready` was written after the socket listened
      const client = await attach(w, id);
      await until(() => client.welcome, "the welcome");
      expect(client.bye).toBeUndefined();
    }
  });

  ptyTest("tA_pty_socket_modes", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const sock = w.status(id).sock as string;
    const file = lstatSync(sock);
    expect(file.isSocket()).toBe(true);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.uid).toBe(uid);
    const folder = lstatSync(dirname(sock));
    expect(folder.isDirectory() && !folder.isSymbolicLink()).toBe(true);
    expect(folder.mode & 0o777).toBe(0o700);
    expect(await w.adapter().attachable(id)).toEqual({ ok: true });
  });

  ptyTest("tA_pty_socket_missing_not_attachable", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const sock = w.status(id).sock as string;
    rmSync(sock);
    expect(await code(w.adapter().attach(id))).toBe("NOT_ATTACHABLE");
    const answer = await w.adapter().attachable(id);
    expect(answer.ok).toBe(false);
    expect(answer.ok ? "" : answer.reason).toContain("does not exist");
    // the session is otherwise whole: it is listed, read and stopped
    expect((await w.adapter().status(id)).state).toBe("running");
    expect((await w.adapter().stop(id)).state).toBe("killed");
  });

  ptyTest("tA_pty_final_record_drops_sock", async () => {
    const w = newWorld();
    const ended = await w.adapter().start(sh(w, "sleep 1; exit 3"));
    expect(w.status(ended.id).sock).toBeTypeOf("string");
    const done = await w.adapter().wait(ended.id, { timeoutMs: 15_000 });
    expect(done).toMatchObject({ state: "exited", exitCode: 3 });
    expect("sock" in w.status(ended.id)).toBe(false);
    const stopped = await w.adapter().start(pty(w, ["cat"]));
    await w.adapter().stop(stopped.id);
    expect("sock" in w.status(stopped.id)).toBe(false);
    expect(w.status(stopped.id)).toMatchObject({ state: "killed", reason: "stopped" });
  });

  ptyTest("tA_pty_socket_removed", async () => {
    const w = newWorld();
    const ended = await w.adapter().start(sh(w, "sleep 1"));
    const first = w.status(ended.id).sock as string;
    expect(existsSync(first)).toBe(true);
    await w.adapter().wait(ended.id, { timeoutMs: 15_000 });
    await until(() => !existsSync(first), "the socket of the ended session to go");
    const stopped = await w.adapter().start(pty(w, ["cat"]));
    const second = w.status(stopped.id).sock as string;
    const client = await attach(w, stopped.id);
    await w.adapter().stop(stopped.id);
    expect(existsSync(second)).toBe(false);
    // the attached client was told before the end
    await until(() => client.bye, "the bye");
    expect(client.bye?.reason).toBe("killed");
  });

  ptyTest("tA_pty_stale_sock_after_sigkill", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["sleep", "300"]));
    const record = w.status(id) as { sock: string; holder: { pid: number } };
    process.kill(record.holder.pid, "SIGKILL");
    await until(
      async () => (await w.adapter().status(id)).state !== "running",
      "the session to be seen as lost",
    );
    // the record still names the socket and the file is still there: neither means somebody listens
    expect(w.status(id).sock).toBe(record.sock);
    expect(existsSync(record.sock)).toBe(true);
    expect(await code(w.adapter().attach(id))).toBe("NOT_ATTACHABLE");
    expect((await w.adapter().attachable(id)).ok).toBe(false);
    await until(
      async () => (await code(w.adapter().remove(id))) === undefined,
      "the session to be removed",
    );
    expect(existsSync(w.dirOf(id))).toBe(false);
    expect(existsSync(record.sock)).toBe(false);
  });

  ptyTest("tA_pty_holder_killed_child_hup", async () => {
    const w = newWorld();
    const { id } = await w
      .adapter()
      .start(sh(w, "trap 'echo got-hup > hup.txt; exit 0' HUP; while :; do sleep 0.1; done"));
    const record = w.status(id) as { holder: { pid: number }; child: { pid: number } };
    await new Promise((r) => setTimeout(r, 300));
    process.kill(record.holder.pid, "SIGKILL");
    await until(() => !alive(record.child.pid), "the child to end after its holder was killed");
    expect(readFileSync(join(w.root, "hup.txt"), "utf8")).toContain("got-hup");
  });

  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    ptyTest(`tA_pty_holder_signal_ends_as_stop: ${signal} to the holder`, async () => {
      const w = newWorld();
      const { id } = await w.adapter().start(pty(w, ["cat"]));
      const record = w.status(id) as {
        holder: { pid: number };
        child: { pid: number };
        sock: string;
      };
      const client = await attach(w, id);
      await until(() => client.welcome, "the welcome");
      process.kill(record.holder.pid, signal);
      // the holder does not just end: its client is told, the socket goes, and the record says what happened
      await until(() => client.bye, "the client to be told");
      expect(client.bye?.reason).toBe("killed");
      await until(() => !alive(record.holder.pid), "the holder to end");
      expect(alive(record.child.pid)).toBe(false);
      expect(existsSync(record.sock)).toBe(false);
      expect(w.status(id)).toMatchObject({ state: "killed", reason: "stopped" });
      expect("sock" in w.status(id)).toBe(false);
      expect((await w.adapter().status(id)).state).toBe("killed");
    });
  }

  ptyTest("tA_rm_unlinks_only_derived_sock", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(sh(w, "exit 0"));
    await w.adapter().wait(id, { timeoutMs: 15_000 });
    // A record forged to name a socket that is not this session's, in the very folder the real ones live in.
    const decoy = join(w.adapter().place.runDir, "decoy.sock");
    await staleSocket(decoy);
    const file = join(w.dirOf(id), "status.json");
    writeFileSync(file, JSON.stringify({ ...w.status(id), sock: decoy }));
    await w.adapter().remove(id);
    expect(existsSync(w.dirOf(id))).toBe(false);
    expect(existsSync(decoy)).toBe(true);
  });

  ptyTest("tA_pty_socket_primary_and_fallback_bind", async () => {
    const short = newWorld();
    const primary = await short.adapter().start(pty(short, ["cat"]));
    expect(dirname(short.status(primary.id).sock as string)).toBe(short.adapter().place.runDir);

    const long = newWorld({ longBase: true });
    const tmp = tempDir("kd-tmp-");
    const inTmp = await withTmp(tmp, () => long.adapter().start(pty(long, ["cat"])));
    expect(dirname(long.status(inTmp.id).sock as string)).toBe(join(tmp, `kodel-${uid}`));
    const onFallback = await attach(long, inTmp.id);
    await until(() => onFallback.welcome, "an attach on the fallback");

    // A `TMPDIR` that is too long as well: the last place is the system's temporary folder.
    const deep = join(tempDir("kd-deep-"), "d".repeat(90));
    mkdirSync(deep);
    const inSystem = await withTmp(deep, () => long.adapter().start(pty(long, ["cat"])));
    expect(dirname(long.status(inSystem.id).sock as string)).toBe(`/tmp/kodel-${uid}`);
    const sock = long.status(inSystem.id).sock as string;
    await long.adapter().stop(inSystem.id);
    expect(existsSync(sock)).toBe(false);
  });

  ptyTest("tA_pty_tmpdir_differs_between_holder_and_client", async () => {
    const w = newWorld({ longBase: true });
    const holderTmp = tempDir("kd-ha-");
    const clientTmp = tempDir("kd-cl-");
    const { id } = await withTmp(holderTmp, () => w.adapter().start(pty(w, ["sleep", "300"])));
    const record = w.status(id) as { sock: string; holder: { pid: number } };
    expect(record.sock.startsWith(join(holderTmp, `kodel-${uid}`))).toBe(true);
    await withTmp(clientTmp, async () => {
      const client = await attach(w, id);
      await until(() => client.welcome, "the welcome under another TMPDIR");
      client.close();
      process.kill(record.holder.pid, "SIGKILL");
      await until(
        async () => (await code(w.adapter().remove(id))) === undefined,
        "the session to be removed",
      );
    });
    expect(existsSync(record.sock)).toBe(false);
  });

  ptyTest("tA_pty_send_paste_only_with_2004", async () => {
    const w = newWorld();
    const send = w.adapter().send.bind(w.adapter());
    const plain = await w.adapter().start(pty(w, ["cat", "-v"]));
    const before = await attach(w, plain.id);
    await send(plain.id, "no paste here");
    await before.sees("no paste here\r\nno paste here");
    expect(before.output).not.toContain("200~");
    // the program switches bracketed paste on, in two writes: the switch is cut by the chunk border
    const pasting = await w
      .adapter()
      .start(sh(w, "printf '\\033[?20'; sleep 0.3; printf '04h'; echo ready; exec cat -v"));
    const after = await attach(w, pasting.id);
    await after.sees("ready");
    await send(pasting.id, "pasted text");
    await after.sees("^[[200~pasted text^[[201~");
  });

  ptyTest("tA_pty_send_enter_own_write", async () => {
    const w = newWorld();
    const { id } = await w.adapter().start(pty(w, ["cat"]));
    const client = await attach(w, id);
    await until(() => client.welcome, "the welcome");
    const started = Date.now();
    const sent = await w.adapter().send(id, "a line");
    expect(Date.now() - started).toBeGreaterThanOrEqual(SEND_PASTE_GAP_MS - 20);
    expect(sent.bytes).toBeGreaterThan("a line".length);
    // Enter arrived: `cat` got the whole line and wrote it back
    await client.sees("a line\r\na line\r\n");
    const kept = await w.adapter().send(id, "not submitted", { submit: false });
    expect(kept.bytes).toBe("not submitted".length);
    await client.sees("not submitted");
    expect(client.output).not.toContain("not submitted\r\n");
    // sending text does not change the size of the terminal
    expect(client.welcome).toEqual({ cols: 80, rows: 24 });
  });

  const rules: RedactRule[] = [{ name: "token", pattern: /SECRET-[A-Z0-9]+/g }];
  const secretSession = async (w: World) => {
    const { id } = await w
      .adapter()
      .start(
        sh(
          w,
          "printf '\\033[31mred\\033[0m SECRET-'; sleep 0.4; printf 'ABC123 after\\n'; exec cat",
        ),
      );
    const client = await attach(w, id);
    await client.sees("ABC123 after");
    client.input("SECRET-TYPED9\r");
    await client.sees("SECRET-TYPED9\r\nSECRET-TYPED9");
    const tail = await until(
      async () => {
        const read = await w.adapter().tail(id);
        return read.text.includes("after") && read.text.includes("REDACTED:token]\n[") && read;
      },
      "the tail on disk",
      15_000,
    );
    return { id, client, tail };
  };

  ptyTest("tA_pty_no_raw_bytes_on_disk", async () => {
    const w = newWorld({ rules });
    const { id } = await secretSession(w);
    const files = readdirSync(w.dirOf(id));
    expect(files).toContain("tail.txt");
    expect(files).not.toContain("stdout.txt");
    expect(files).not.toContain("stderr.txt");
    for (const file of files) {
      const text = readFileSync(join(w.dirOf(id), file), "latin1");
      expect(text.includes("\u001b"), `${file} holds an escape`).toBe(false);
      expect(text.includes("SECRET-ABC123"), `${file} holds the secret`).toBe(false);
      expect(text.includes("SECRET-TYPED9"), `${file} holds the typed secret`).toBe(false);
    }
  });

  ptyTest("tA_pty_logs_stripped_and_redacted", async () => {
    const w = newWorld({ rules });
    const { id, tail } = await secretSession(w);
    expect(tail.text).toContain("red [REDACTED:token] after");
    expect(tail.text).not.toContain("\u001b");
    expect(tail.text).not.toContain("\r");
    expect(await code(w.adapter().tail(id, 1024, "stdout"))).toBe("UNSUPPORTED");
    expect(await code(w.adapter().tail(id, 1024, "stderr"))).toBe("UNSUPPORTED");
  });

  ptyTest("tA_pty_tail_redacts_split_and_echo", async () => {
    const w = newWorld({ rules });
    const { tail, client } = await secretSession(w);
    // the terminal itself showed the secret, in two chunks and as the echo of the typing
    expect(client.output).toContain("SECRET-TYPED9");
    expect(tail.text).not.toContain("SECRET-");
    expect(tail.text.match(/\[REDACTED:token\]/g)?.length).toBe(3);
  });

  ptyTest("tA_pty_session_refuses_human_commands", async () => {
    const w = newWorld();
    // The child gets no KODEL_* of the starter (only the mark), so the script says where the state is itself.
    const kodel = `KODEL_STATE_DIR='${w.state}' node ${ARTIFACT}`;
    const script = [
      "test -t 0 && test -t 1 && echo HAS-A-TERMINAL",
      'echo "engine=$KODEL_ENGINE"',
      `${kodel} agent stop a_000000000_0000; echo "stop=$?"`,
      `${kodel} agent rm a_000000000_0000; echo "rm=$?"`,
      `${kodel} agent exec --pty -- true; echo "exec=$?"`,
      `${kodel} agent ls; echo "ls=$?"`,
      "sleep 30",
    ].join("; ");
    // other KODEL_* of the starter's shell do not reach the child, the mark does
    const marked = w.adapter({ baseEnv: { ...w.env, KODEL_OTHER: "1", KODEL_ENGINE: "" } });
    const { id } = await marked.start(sh(w, script));
    const client = await attach(w, id, 200, 50);
    await client.sees("ls=0");
    expect(client.output).toContain("HAS-A-TERMINAL");
    expect(client.output).toContain("engine=1");
    for (const refused of ["stop=1", "rm=1", "exec=1"]) expect(client.output).toContain(refused);
    expect(client.output.match(/this command is for a person/g)?.length).toBe(3);
  });

  ptyTest("tA_pty_attach_refuses_inside_session", async () => {
    const w = newWorld();
    const target = await w.adapter().start(pty(w, ["cat"], { name: "target" }));
    const script = `KODEL_STATE_DIR='${w.state}' node ${ARTIFACT} agent attach target; echo "attach=$?"; sleep 30`;
    const { id } = await w.adapter().start(sh(w, script));
    const client = await attach(w, id, 200, 50);
    await client.sees("attach=1");
    expect(client.output).toContain("this command is for a person");
    expect((await w.adapter().status(target.id)).state).toBe("running");
  });

  ptyTest(
    "tA_exec_attach_real_terminal",
    async () => {
      // TASK-K6MA: `exec --pty --attach` starts the session and opens it at once, in the same terminal.
      const w = newWorld();
      const host = new Host();
      hosts.push(host);
      const term = await host.shell(w);
      const from = term.begin(`${KODEL} agent exec --pty --attach --name cc -- cat`);
      // `started` first, then the terminal is the session's: what is typed comes back from `cat`.
      await term.sees(/started (a_[0-9a-z_]+) \(cc\)/, 30_000, from);
      const id = /started (a_[0-9a-z_]+) \(cc\)/.exec(term.output.slice(from))?.[1] ?? "";
      term.type("typed-in\r");
      await term.sees("typed-in\r\ntyped-in", undefined, from);
      expect(term.output.slice(from)).not.toContain("attach with:");
      // The detach chord gives the terminal back; the exit code is the attach's.
      term.type("\u001c");
      const done = await term.finished(from);
      expect(done.code).toBe(0);
      expect(done.shown).toContain("[detached: cc]");
      // The session is left running, and the person comes back to it by name.
      expect((await w.adapter().status(id)).state).toBe("running");
      const again = term.begin(`${KODEL} agent attach cc`);
      await term.sees("typed-in\r\ntyped-in", undefined, again);
      term.type("\u001c");
      expect((await term.finished(again)).shown).toContain("[detached: cc]");

      // `-a` is the same flag; a command that ends while attached gives its end, and code 0.
      const short = term.begin(
        `${KODEL} agent exec --pty -a --name dd -- sh -c 'read line; exit 3'`,
      );
      await term.sees(/started a_[0-9a-z_]+ \(dd\)/, 30_000, short);
      term.type("go\r");
      const ended = await term.finished(short);
      expect(ended.code).toBe(0);
      expect(ended.shown).toContain("[ended: dd, exit 3]");
      // One that is over before the terminal could be connected gives the same line.
      const quick = await term.sh(`${KODEL} agent exec --pty --attach --name ee -- true`, 60_000);
      expect(quick.code).toBe(0);
      expect(quick.shown).toMatch(/\[ended: ee(, exit 0)?\]/);
      // Without `--pty` it is refused, and nothing is started.
      const refused = await term.sh(`${KODEL} agent exec --attach --name ff -- cat`);
      expect(refused.code).toBe(1);
      expect(refused.shown).toContain("--attach needs --pty");
      expect(await w.adapter().list({ name: "ff" })).toEqual([]);
    },
    180_000,
  );
});

describe("a terminal session passes the session contract", () => {
  const made: World[] = [];
  const cases = sessionContract(() => {
    const w = world();
    made.push(w);
    const p = (script: string, extra: Partial<SessionSpec> = {}) => ({
      argv: ["sh", "-c", script],
      mode: "pty" as const,
      ...extra,
    });
    return {
      adapter: w.adapter(),
      programs: {
        exit: (n: number) => p(`exit ${n}`),
        echoExit: (t: string, n: number) => p(`echo ${t}; exit ${n}`),
        hang: () => p("sleep 120", { timeoutMs: 120_000 }),
      },
      cwd: w.root,
      unknownId: "a_000000000_0000",
      dispose: () => w.dispose(),
    };
  });
  ptyTest(
    "tA_pty_passes_session_contract",
    async () => {
      for (const c of cases) {
        try {
          await c.run();
        } catch (error) {
          throw new Error(`${c.name}: ${(error as Error).message}`);
        }
      }
      // the one row a terminal session answers differently: it has one stream
      const w = world();
      made.push(w);
      try {
        const { id } = await w.adapter().start(sh(w, "echo one-stream; exit 0"));
        await w.adapter().wait(id, { timeoutMs: 15_000 });
        expect((await w.adapter().tail(id)).text).toContain("one-stream");
        expect(await code(w.adapter().tail(id, 1024, "stdout"))).toBe("UNSUPPORTED");
      } finally {
        await w.dispose();
      }
    },
    180_000,
  );
});

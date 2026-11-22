import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { encodeRecord, type SocketCandidate, socketCandidates } from "@kodel-ai/pipeline-core";
import { sessionEnv } from "../src/session-env";
import { runHolder } from "../src/session-holder";
import {
  ATTACH_FLUSH_MS,
  DEFAULT_TERM,
  descriptorWriter,
  duplicateDescriptor,
  findExecutable,
  HOLDER_SIGNALS,
  type PtyHolderParts,
  type PtyLoader,
  ptyChildEnv,
  ptyCommand,
  ptyFromModule,
  signalName,
} from "../src/session-pty";
import { readStatus } from "../src/session-records";
import {
  type BoundSocket,
  bindSessionSocket,
  type SocketBinder,
  socketHash,
} from "../src/session-socket";
import {
  FakeRawPty,
  type FakeSpawn,
  fakePtyModule,
  memoryPair,
  TestClient,
} from "./helpers/attach-fakes";
import { liveSocket, shortDir, socketSkipReason, staleSocket, uid } from "./helpers/socket-env";

const socketTest = test.skipIf(socketSkipReason !== undefined);

/**
 * The writer owns its descriptor on macOS only: Linux opens a FIFO through `/dev/fd` again, as a blocking file
 * description, so the test would wait on a full pipe for good there.
 */
const duplicateApplies = process.platform === "darwin";
/** Why the test of the writer's own descriptor is skipped: a sandbox may refuse to open `/dev/fd`. */
const duplicateSkipReason = ((): string | undefined => {
  if (!duplicateApplies) return undefined;
  const probeDir = shortDir("kd-dup-");
  try {
    const fd = openSync(join(probeDir, "probe"), "w");
    const own = duplicateDescriptor(fd);
    closeSync(fd);
    if (own === undefined) return "a descriptor cannot be duplicated through /dev/fd here";
    closeSync(own);
    return undefined;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();
if (duplicateSkipReason !== undefined) {
  if (process.env.KODEL_REQUIRE_PTY === "1") throw new Error(duplicateSkipReason);
  console.log(`descriptor test skipped: ${duplicateSkipReason}`);
}
const ID = "a_000000000_0000";
const KEY = "abcdef012345";

let base: string;
let dir: string;
let runDir: string;
beforeEach(() => {
  base = shortDir("kd-pty-");
  dir = join(base, "session");
  runDir = join(base, "run");
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(runDir, { mode: 0o700 });
});
afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // removed by the test
  }
  rmSync(base, { recursive: true, force: true });
});

const candidates = (): SocketCandidate[] =>
  socketCandidates({ runDir, uid, checkoutKey: KEY, id: ID, hash: socketHash });

/** A binder that binds nothing: the order of the holder's steps is what these tests look at. */
const fakeBinder = () => {
  const state = {
    calls: 0,
    closed: 0,
    path: "",
    client: (_stream: ReturnType<typeof memoryPair>["holder"]) => {},
    onClose: () => {},
    /** The waits of the holder for its clients, and what a test makes each wait for. */
    flushes: [] as number[],
    flush: (): Promise<void> => Promise.resolve(),
  };
  const bind: SocketBinder = async (list) => {
    state.calls++;
    const first = list[0] as SocketCandidate;
    state.path = first.path;
    const bound: BoundSocket = {
      path: first.path,
      kind: first.kind,
      onClient(listener) {
        state.client = listener;
      },
      close() {
        state.closed++;
        state.onClose();
      },
      flushed(timeoutMs) {
        state.flushes.push(timeoutMs);
        return state.flush();
      },
    };
    return bound;
  };
  return { state, bind };
};

const eventually = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not reached");
};

interface World {
  lines: string[];
  spawns: FakeSpawn[];
  loads: number;
  binder: ReturnType<typeof fakeBinder>;
  done: Promise<number>;
  spawned(): Promise<FakeSpawn>;
}

const start = (
  over: Record<string, unknown> = {},
  parts: {
    load?: PtyLoader | null;
    bind?: SocketBinder;
    onSpawn?: (spawn: FakeSpawn) => void;
    extra?: Partial<PtyHolderParts>;
  } = {},
): World => {
  const lines: string[] = [];
  const fake = fakePtyModule();
  const binder = fakeBinder();
  const world: World = {
    lines,
    spawns: fake.spawns,
    loads: 0,
    binder,
    done: Promise.resolve(0),
    spawned: async () => {
      await eventually(() => fake.spawns.length > 0 && lines.includes("ready"));
      return fake.spawns[0] as FakeSpawn;
    },
  };
  const module = parts.onSpawn
    ? {
        spawn: (...args: Parameters<typeof fake.module.spawn>) => {
          const process = fake.module.spawn(...args);
          parts.onSpawn?.(fake.spawns.at(-1) as FakeSpawn);
          return process;
        },
      }
    : fake.module;
  const load: PtyLoader = async () => {
    world.loads++;
    return { ok: true, pty: module };
  };
  world.done = runHolder({
    input: {
      v: 1,
      dir,
      argv: ["sh", "-c", "exit 0"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      graceMs: 30_000,
      started: Date.now(),
      mode: "pty",
      socket: { runDir, uid, checkoutKey: KEY, id: ID },
      ...over,
    } as never,
    boot: (line) => lines.push(line),
    pty: {
      ...(parts.load === null ? {} : { load: parts.load ?? load }),
      bind: parts.bind ?? binder.bind,
      watchMs: 10,
      drainMs: 1,
      roots: { tmpDir: undefined, systemTmp: join(base, "none") },
      ...parts.extra,
    },
  });
  return world;
};

const status = () => readStatus(dir) as Exclude<ReturnType<typeof readStatus>, string>;

/**
 * Opens files until one of them gets the number `wanted`: a new file takes the lowest free number, which is the one
 * a test has just closed only when nothing lower is free, and on a busy process something is. The files opened on
 * the way are the caller's to close (`spares`).
 */
const openOnNumber = (
  dir: string,
  prefix: string,
  wanted: number,
): { fd: number; path: string; spares: number[] } => {
  const spares: number[] = [];
  for (let i = 0; i < 512; i++) {
    const path = join(dir, `${prefix}-${i}`);
    const fd = openSync(path, "w");
    if (fd === wanted) return { fd, path, spares };
    spares.push(fd);
  }
  for (const spare of spares) closeSync(spare);
  throw new Error(`no file got the number ${wanted}`);
};

describe("pty trait", () => {
  test("tA_pty_signal_number_mapped", async () => {
    expect(signalName(0)).toBeUndefined();
    expect(signalName(undefined)).toBeUndefined();
    expect(signalName(15)).toBe("SIGTERM");
    expect(signalName(9)).toBe("SIGKILL");
    expect(signalName(1)).toBe("SIGHUP");
    expect(signalName(999)).toBe("SIG999");
    // the trait hands on a name, and no signal at all for the module's 0
    const fake = fakePtyModule();
    const child = ptyFromModule(fake.module).spawn({
      file: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      cols: 80,
      rows: 24,
    });
    const exits: unknown[] = [];
    child.onExit((exit) => exits.push(exit));
    fake.spawns[0]?.process.exit(0, 15);
    fake.spawns[0]?.process.exit(3, 0);
    expect(exits).toEqual([{ exitCode: 0, signal: "SIGTERM" }, { exitCode: 3 }]);
    // a write reaches the module as the same bytes, whatever they are
    const typed = new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0xff, 0x80, 0xe1]);
    child.write(typed.subarray(1));
    const written = fake.spawns[0]?.process.writes[0];
    expect(typeof written).not.toBe("string");
    expect([...(written as Uint8Array)]).toEqual([...typed.subarray(1)]);

    // through the holder: a child ended by a signal is `killed`, never `exited 0`
    const world = start();
    (await world.spawned()).process.exit(0, 15);
    expect(await world.done).toBe(0);
    expect(status()).toMatchObject({ state: "killed", signal: "SIGTERM" });
    expect(status().exitCode).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "tA_attach_input_flood_paused_at_bound: a descriptor that blocks is written in order, off the loop",
    async () => {
      const file = join(base, "written");
      const fd = openSync(file, "w");
      const order: string[] = [];
      let closed = false;
      const write = descriptorWriter(fd, () => closed);
      await new Promise<void>((resolve) => {
        write(Buffer.from("one "), () => order.push("one"));
        write(Buffer.alloc(300_000, "2"), () => order.push("two"));
        write(Buffer.from(" three"), () => {
          order.push("three");
          resolve();
        });
        // nothing is reported before the descriptor took it
        expect(order).toEqual([]);
      });
      expect(order).toEqual(["one", "two", "three"]);
      // a descriptor that is closed: nothing is written to its number, the writes are reported
      closed = true;
      await new Promise<void>((resolve) => {
        write(Buffer.from("lost"), () => order.push("lost"));
        write(Buffer.from("lost too"), resolve);
      });
      closeSync(fd);
      expect(order).toEqual(["one", "two", "three", "lost"]);
      expect(readFileSync(file, "utf8")).toBe(`one ${"2".repeat(300_000)} three`);
      // one that fails owes nothing either
      await new Promise<void>((resolve) =>
        descriptorWriter(fd, () => false)(Buffer.from("x"), resolve),
      );

      // a terminal that has no room: the rest waits and is written when there is room, nothing is lost
      const fifo = join(base, "fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const pipe = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      const size = 1024 * 1024;
      let reported = false;
      descriptorWriter(pipe, () => false)(Buffer.alloc(size, "x"), () => {
        reported = true;
      });
      const ticks = { count: 0 };
      const ticking = setInterval(() => ticks.count++, 5);
      await new Promise((r) => setTimeout(r, 300));
      // the pipe is full and nobody reads: the write is owed, and the loop goes on meanwhile
      expect(reported).toBe(false);
      expect(ticks.count).toBeGreaterThan(20);
      clearInterval(ticking);
      let read = 0;
      const chunk = Buffer.alloc(64 * 1024);
      const until = Date.now() + 10_000;
      while (read < size && Date.now() < until) {
        try {
          read += readSync(pipe, chunk, 0, chunk.length, null);
        } catch {
          await new Promise((r) => setTimeout(r, 5)); // empty for now
        }
      }
      expect(read).toBe(size);
      await eventually(() => reported);
      closeSync(pipe);

      // the trait takes that way only where it is told to, and the module shows a descriptor and a stream
      const taken: string[] = [];
      const raw = new FakeRawPty();
      const out = openSync(join(base, "through"), "w");
      Object.assign(raw, {
        fd: out,
        _socket: {
          destroyed: false,
          write(_data: Uint8Array, done: () => void) {
            taken.push("stream");
            done();
          },
        },
      });
      const request = { file: "/bin/sh", args: [], cwd: "/", env: {}, cols: 80, rows: 24 };
      await new Promise<void>((resolve) =>
        ptyFromModule({ spawn: () => raw }, false)
          .spawn(request)
          .write(Buffer.from("a"), resolve),
      );
      expect(taken).toEqual(["stream"]);
      await new Promise<void>((resolve) =>
        ptyFromModule({ spawn: () => raw }, true)
          .spawn(request)
          .write(Buffer.from("bc"), resolve),
      );
      expect(taken).toEqual(["stream"]);
      closeSync(out);
      expect(readFileSync(join(base, "through"), "utf8")).toBe("bc");
    },
  );

  test.skipIf(process.platform === "win32")(
    "tA_pty_default_writes_by_descriptor_on_every_system: the stream is not the way, on macOS or on Linux",
    async () => {
      const base = shortDir("kd-default-");
      const taken: string[] = [];
      const raw = new FakeRawPty();
      const out = openSync(join(base, "by-number"), "w");
      Object.assign(raw, {
        fd: out,
        _socket: {
          destroyed: false,
          write(_data: Uint8Array, done: () => void) {
            taken.push("stream");
            done();
          },
        },
      });
      const request = { file: "/bin/sh", args: [], cwd: "/", env: {}, cols: 80, rows: 24 };
      // no second argument: the stream's own write spins the loop on a program that does not read, on Linux as on
      // macOS, so a terminal with a descriptor is written to by that descriptor
      await new Promise<void>((resolve) =>
        ptyFromModule({ spawn: () => raw })
          .spawn(request)
          .write(Buffer.from("typed"), resolve),
      );
      closeSync(out);
      expect(taken).toEqual([]);
      expect(readFileSync(join(base, "by-number"), "utf8")).toBe("typed");
      rmSync(base, { recursive: true, force: true });
    },
  );

  test.skipIf(!duplicateApplies || duplicateSkipReason !== undefined)(
    "tA_pty_writer_never_writes_to_a_reused_descriptor: typed bytes go to the terminal or nowhere",
    async () => {
      // The terminal: a pipe that is full, so the write is owed and tried again by number, later.
      const fifo = join(base, "terminal");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const reader = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      const fill = Buffer.alloc(64 * 1024, "f");
      let filled = 0;
      for (;;) {
        try {
          filled += writeSync(reader, fill);
        } catch {
          break; // full
        }
      }
      const shared = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      const closers: (() => void)[] = [];
      const raw = new FakeRawPty();
      Object.assign(raw, {
        fd: shared,
        _socket: {
          destroyed: false,
          write() {
            throw new Error("the stream is not used");
          },
          once(_event: string, listener: () => void) {
            closers.push(listener);
          },
        },
      });
      const duplicates: number[] = [];
      const child = ptyFromModule({ spawn: () => raw }, true, (fd) => {
        const own = duplicateDescriptor(fd);
        if (own !== undefined) duplicates.push(own);
        return own;
      }).spawn({ file: "/bin/sh", args: [], cwd: "/", env: {}, cols: 80, rows: 24 });
      expect(duplicates.length).toBe(1);
      const own = duplicates[0] as number;
      expect(own).not.toBe(shared);
      const done: string[] = [];
      child.write(Buffer.from("typed-secret"), () => done.push("first"));
      child.write(Buffer.from("typed-later"), () => done.push("second"));
      await new Promise((r) => setTimeout(r, 30));
      expect(done).toEqual([]);

      // The module closes its descriptor, and the next file opened gets the number, before anybody is told.
      closeSync(shared);
      const strangerOpened = openOnNumber(base, "stranger", shared);
      const strangerPath = strangerOpened.path;
      const stranger = strangerOpened.fd;
      expect(stranger).toBe(shared);
      // the terminal has room again: the owed bytes go to the terminal, through the writer's own descriptor
      const chunk = Buffer.alloc(64 * 1024);
      let read = 0;
      while (read < filled) read += readSync(reader, chunk, 0, chunk.length, null);
      await eventually(() => done.length === 2);
      expect(readFileSync(strangerPath, "utf8")).toBe("");
      expect(readSync(reader, chunk, 0, chunk.length, null)).toBe("typed-secrettyped-later".length);

      // The stream says it closed while a write is owed: that write is reported, nothing more is written, and
      // the writer's descriptor is closed only when no write is on its way.
      for (;;) {
        try {
          writeSync(reader, fill);
        } catch {
          break;
        }
      }
      child.write(Buffer.from("never-typed"), () => done.push("third"));
      child.write(Buffer.from("never-typed-either"), () => done.push("fourth"));
      await new Promise((r) => setTimeout(r, 30));
      expect(closers.length).toBe(1);
      for (const close of closers) close();
      await eventually(() => done.length === 4);
      expect(() => fstatSync(own)).toThrow();
      const reusedOpened = openOnNumber(base, "reused", own);
      const reused = reusedOpened.fd;
      expect(reused).toBe(own);
      child.write(Buffer.from("after-close"), () => done.push("fifth"));
      await eventually(() => done.length === 5);
      await new Promise((r) => setTimeout(r, 80));
      expect(readFileSync(reusedOpened.path, "utf8")).toBe("");
      for (const spare of reusedOpened.spares) closeSync(spare);
      expect(readFileSync(strangerPath, "utf8")).toBe("");
      let rest = "";
      for (;;) {
        try {
          rest += chunk.subarray(0, readSync(reader, chunk, 0, chunk.length, null)).toString();
        } catch {
          break;
        }
      }
      expect(rest.includes("never-typed") || rest.includes("after-close")).toBe(false);
      closeSync(reused);
      closeSync(stranger);
      closeSync(reader);
    },
  );

  test.skipIf(process.platform === "win32")(
    "tA_pty_writer_close_waits_for_the_write_on_its_way: an owned descriptor is closed once, and never written after",
    async () => {
      const fifo = join(base, "owned");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const reader = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      const fill = Buffer.alloc(64 * 1024, "f");
      let filled = 0;
      for (;;) {
        try {
          filled += writeSync(reader, fill);
        } catch {
          break; // full
        }
      }
      const own = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      const writer = descriptorWriter(own, () => false, true);
      const done: string[] = [];
      writer(Buffer.from("owed"), () => done.push("first"));
      writer(Buffer.from("queued"), () => done.push("second"));
      // closed in the same turn: the first write is with the system, and the number is not given up under it
      writer.close();
      expect(() => fstatSync(own)).not.toThrow();
      expect(done).toEqual([]);
      await eventually(() => done.length === 2);
      expect(done).toEqual(["first", "second"]);
      expect(() => fstatSync(own)).toThrow();
      // the number is another file's now: a later write is reported and goes nowhere
      const taken = openOnNumber(base, "reused", own);
      const reused = taken.fd;
      const reusedPath = taken.path;
      writer(Buffer.from("after-close"), () => done.push("third"));
      await eventually(() => done.length === 3);
      writer.close();
      expect(() => fstatSync(reused)).not.toThrow();
      await new Promise((r) => setTimeout(r, 80));
      expect(readFileSync(reusedPath, "utf8")).toBe("");
      for (const spare of taken.spares) closeSync(spare);
      const chunk = Buffer.alloc(64 * 1024);
      let read = 0;
      for (;;) {
        try {
          read += readSync(reader, chunk, 0, chunk.length, null);
        } catch {
          break;
        }
      }
      expect(read).toBe(filled);
      closeSync(reused);
      closeSync(reader);

      // a close with nothing on its way closes the resting's descriptor at once, and only once
      const idle = openSync(join(base, "idle"), "w");
      const resting = descriptorWriter(idle, () => false, true);
      resting.close();
      expect(() => fstatSync(idle)).toThrow();
      const next = openSync(join(base, "next"), "w");
      resting.close();
      expect(() => fstatSync(next)).not.toThrow();
      closeSync(next);
    },
  );

  test("tA_pty_child_term_default: the environment of the child", () => {
    expect(ptyChildEnv({}).TERM).toBe(DEFAULT_TERM);
    expect(ptyChildEnv({ TERM: "dumb" }).TERM).toBe(DEFAULT_TERM);
    expect(ptyChildEnv({ TERM: "" }).TERM).toBe(DEFAULT_TERM);
    expect(ptyChildEnv({ TERM: "xterm-kitty", COLORTERM: "truecolor" })).toEqual({
      TERM: "xterm-kitty",
      COLORTERM: "truecolor",
      KODEL_ENGINE: "1",
    });
    const sized = ptyChildEnv({ LINES: "50", COLUMNS: "200", A: "b" });
    expect("LINES" in sized || "COLUMNS" in sized).toBe(false);
    expect(sized.A).toBe("b");
  });

  test("tA_pty_missing_command_fails_boot: the lookup", () => {
    const env = { PATH: `${join(base, "nowhere")}:/bin:/usr/bin` };
    expect(findExecutable("sh", env, "/")).toBe("/bin/sh");
    expect(findExecutable("/bin/sh", {}, "/")).toBe("/bin/sh");
    expect(findExecutable("kodel-no-such-command", env, "/")).toBeUndefined();
    expect(findExecutable("sh", { PATH: "" }, "/")).toBeUndefined();
    expect(findExecutable("sh", {}, "/")).toBeUndefined();
    // a file that is there but cannot be run, a folder, and a relative path against the child's cwd
    const plain = join(base, "plain");
    writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    expect(findExecutable(plain, env, "/")).toBeUndefined();
    expect(findExecutable(base, env, "/")).toBeUndefined();
    chmodSync(plain, 0o755);
    expect(findExecutable("./plain", env, base)).toBe(plain);
    expect(findExecutable("plain", { PATH: base }, "/")).toBe(plain);
    expect(ptyCommand({ argv: ["a", "b", "c"] })).toEqual({ file: "a", args: ["b", "c"] });
  });
});

describe("pty holder, fake terminal", () => {
  test("tA_pty_loader_injected: the module comes from the loader, before the socket and the child", async () => {
    const order: string[] = [];
    const fake = fakePtyModule();
    const binder = fakeBinder();
    const world = start(
      { size: { cols: 132, rows: 43 }, cwd: base },
      {
        load: async () => {
          order.push(`load:${existsSync(join(dir, "status.json"))}`);
          return {
            ok: true,
            pty: {
              spawn: (...args) => {
                order.push("spawn");
                return fake.module.spawn(...args);
              },
            },
          };
        },
        bind: async (...args) => {
          order.push("bind");
          return binder.bind(...args);
        },
      },
    );
    await eventually(() => world.lines.includes("ready"));
    // the `starting` record exists before the module is loaded; the socket is bound before the child is made
    expect(order).toEqual(["load:true", "bind", "spawn"]);
    const spawn = fake.spawns[0] as FakeSpawn;
    expect(spawn.file).toBe("sh");
    expect(spawn.args).toEqual(["-c", "exit 0"]);
    expect(spawn.options).toMatchObject({ cols: 132, rows: 43, cwd: base });
    const running = status();
    expect(running).toMatchObject({ state: "running", sock: binder.state.path });
    expect(running.child?.pid).toBe(spawn.process.pid);
    expect(binder.state.path).toBe((candidates()[0] as SocketCandidate).path);
    spawn.process.emit("out");
    spawn.process.exit(7);
    expect(await world.done).toBe(0);
    expect(status()).toMatchObject({ state: "exited", exitCode: 7 });
    expect(binder.state.closed).toBe(1);
  });

  test("tA_pty_holder_load_failure_after_probe: the holder's half", async () => {
    const refusals: [string, PtyLoader | null][] = [
      [
        "the optional package is not installed",
        async () => ({ ok: false, reason: "the optional package is not installed" }),
      ],
      ["dlopen failed", async () => Promise.reject(new Error("dlopen failed"))],
      ["no terminal module", null],
    ];
    for (const [reason, load] of refusals) {
      const world = start({}, { load });
      expect(await world.done).toBe(1);
      expect(world.lines).toEqual([expect.stringContaining("HOLDER_BOOT_FAILED:")]);
      expect(world.lines[0]).toContain(reason);
      // no child existed: no pid in the record, no socket, no `ready`
      expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
      expect(status().child).toBeUndefined();
      expect(status().sock).toBeUndefined();
      expect(world.spawns).toEqual([]);
      expect(world.binder.state.calls).toBe(0);
      rmSync(join(dir, "status.json"));
    }
  });

  test("tA_pty_bind_failure_no_child", async () => {
    const failing: SocketBinder = async () => {
      throw new Error("listen EADDRINUSE");
    };
    const world = start({}, { bind: failing });
    expect(await world.done).toBe(1);
    expect(world.lines.length).toBe(1);
    expect(world.lines[0]).toContain("HOLDER_BOOT_FAILED:");
    expect(world.lines[0]).toContain("EADDRINUSE");
    expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
    expect(status().child).toBeUndefined();
    expect(world.spawns).toEqual([]);

    // the real bind: a file that is no socket is in the way
    rmSync(join(dir, "status.json"));
    const path = (candidates()[0] as SocketCandidate).path;
    writeFileSync(path, "not a socket");
    const blocked = start({}, { bind: bindSessionSocket });
    expect(await blocked.done).toBe(1);
    expect(blocked.lines[0]).toContain("is in the way");
    expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
    expect(status().child).toBeUndefined();
    expect(blocked.spawns).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("not a socket");

    // an id that is not a session id never becomes a socket path
    rmSync(join(dir, "status.json"));
    const bad = start({ socket: { runDir, uid, checkoutKey: KEY, id: "../x" } });
    expect(await bad.done).toBe(1);
    expect(bad.binder.state.calls).toBe(0);
    expect(bad.spawns).toEqual([]);
  });

  test("tA_pty_bind_after_exclusive_status: a holder that lost to a tombstone never makes a socket", async () => {
    writeFileSync(
      join(dir, "status.json"),
      encodeRecord("status", {
        v: 1,
        state: "lost",
        by: "reader",
        reason: "no_status",
        since: Date.now(),
      }),
    );
    const world = start();
    expect(await world.done).toBe(1);
    expect(world.lines).toEqual(["HOLDER_BOOT_FAILED:tombstone"]);
    expect(world.loads).toBe(0);
    expect(world.binder.state.calls).toBe(0);
    expect(world.spawns).toEqual([]);
    expect(status()).toMatchObject({ state: "lost", by: "reader" });
  });

  test("tA_pty_missing_command_fails_boot", async () => {
    for (const argv of [["kodel-no-such-command", "x"], [join(base, "missing")]]) {
      const world = start({ argv });
      expect(await world.done).toBe(1);
      // the spawn was never called: the module would have forked and reported a child that ended
      expect(world.spawns).toEqual([]);
      expect(world.lines.length).toBe(1);
      expect(world.lines[0]).toContain("HOLDER_BOOT_FAILED:");
      expect(world.lines[0]).toContain("command not found");
      expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
      expect(status().child).toBeUndefined();
      expect(world.binder.state.closed).toBe(1);
      rmSync(join(dir, "status.json"));
    }
  });

  test("tA_pty_command_runs_through_sh", async () => {
    const world = start({ argv: undefined, command: "no-such-program | cat; echo $HOME" });
    const spawn = await world.spawned();
    // the shell reports a missing program itself, as in pipes mode: no lookup of the string
    expect(spawn.file).toBe("/bin/sh");
    expect(spawn.args).toEqual(["-c", "no-such-program | cat; echo $HOME"]);
    spawn.process.exit(127);
    expect(await world.done).toBe(0);
    expect(status()).toMatchObject({ state: "exited", exitCode: 127 });
  });

  test("tA_pty_holder_forces_engine_flag", async () => {
    for (const env of [
      { PATH: "/usr/bin:/bin" },
      { PATH: "/usr/bin:/bin", KODEL_ENGINE: "0", TERM: "dumb", LINES: "3", COLUMNS: "4" },
    ]) {
      const world = start({ env });
      const spawn = await world.spawned();
      const given = spawn.options.env ?? {};
      expect(given.KODEL_ENGINE).toBe("1");
      expect(given.TERM).toBe(DEFAULT_TERM);
      expect(spawn.options.name).toBe(DEFAULT_TERM);
      expect("LINES" in given || "COLUMNS" in given).toBe(false);
      spawn.process.exit(0);
      await world.done;
      rmSync(join(dir, "status.json"));
    }
  });

  test("tA_session_env_keeps_engine_flag: whatever KODEL_* the starter's shell has, the child of the holder is marked", async () => {
    const shell = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KODEL_STATE_DIR: "/somewhere",
      KODEL_ENGINE: "",
      KODEL_DIALOG_TIMEOUT_S: "5",
    };
    for (const env of [
      sessionEnv(undefined, true, shell),
      sessionEnv({ KODEL_ENGINE: "0" }, false, shell),
    ]) {
      const world = start({ env: { PATH: shell.PATH, ...env } });
      const spawn = await world.spawned();
      const given = spawn.options.env ?? {};
      expect(Object.keys(given).filter((key) => key.startsWith("KODEL_"))).toEqual([
        "KODEL_ENGINE",
      ]);
      expect(given.KODEL_ENGINE).toBe("1");
      spawn.process.exit(0);
      await world.done;
      rmSync(join(dir, "status.json"));
    }
  });

  test("tA_bye_before_final_record", async () => {
    const world = start();
    const spawn = await world.spawned();
    const pair = memoryPair();
    const client = new TestClient(pair.client);
    world.binder.state.client(pair.holder);
    client.hello();
    spawn.process.emit("hello from the terminal");
    expect(client.output).toBe("hello from the terminal");
    // what the record says at the moment the client is told, and at the moment the socket goes
    const seen: string[] = [];
    pair.client.onData(() => {
      if (client.bye) seen.push(`bye:${status().state}:${status().sock !== undefined}`);
    });
    world.binder.state.onClose = () => seen.push(`unlink:${status().state}`);
    spawn.process.exit(0);
    expect(await world.done).toBe(0);
    expect(seen).toEqual(["bye:running:true", "unlink:running"]);
    expect(client.bye).toEqual({ reason: "exited", exitCode: 0 });
    expect(client.closed).toBe(true);
    expect(status().state).toBe("exited");
  });

  test("tA_bye_flushed_before_holder_ends: the holder waits for its clients to take the end", async () => {
    const world = start();
    const spawn = await world.spawned();
    let release = () => {};
    const seen: string[] = [];
    world.binder.state.onClose = () => seen.push("closed");
    world.binder.state.flush = () => {
      seen.push(`flush:${status().state}`);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    let ended = false;
    world.done.then(() => {
      ended = true;
    });
    spawn.process.exit(0);
    await eventually(() => seen.length === 2);
    // the socket is closed first (the `BYE` is queued by then), and the holder does not end while it waits
    expect(seen).toEqual(["closed", "flush:running"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(ended).toBe(false);
    expect(status().state).toBe("running");
    release();
    expect(await world.done).toBe(0);
    expect(status().state).toBe("exited");
    // a bounded wait, longer than the second a closed stream gives a peer that does not read
    expect(world.binder.state.flushes).toEqual([ATTACH_FLUSH_MS]);
    expect(ATTACH_FLUSH_MS).toBeGreaterThan(1_000);
    expect(ATTACH_FLUSH_MS).toBeLessThanOrEqual(2_000);
  });

  test("tA_pty_final_record_drops_sock: after an exit, a signal, a stop and a timeout", async () => {
    const ends: [string, (world: World, spawn: FakeSpawn) => void, Record<string, unknown>][] = [
      ["exit", (_w, s) => s.process.exit(0), { state: "exited", exitCode: 0 }],
      ["signal", (_w, s) => s.process.exit(0, 9), { state: "killed", signal: "SIGKILL" }],
      [
        "stop",
        (_w, s) => {
          writeFileSync(join(dir, "stop.json"), "{}");
          s.process.exit(0, 15);
        },
        { state: "killed", reason: "stopped" },
      ],
    ];
    for (const [label, end, expected] of ends) {
      const world = start();
      const spawn = await world.spawned();
      expect(status().sock, label).toBe(world.binder.state.path);
      spawn.process.emit("some output");
      end(world, spawn);
      expect(await world.done, label).toBe(0);
      expect(status(), label).toMatchObject(expected);
      expect("sock" in status(), label).toBe(false);
      expect(status().child?.pid, label).toBe(spawn.process.pid);
      expect(world.binder.state.closed, label).toBe(1);
      rmSync(join(dir, "status.json"));
      rmSync(join(dir, "stop.json"), { force: true });
    }
    // the timeout: the holder signals the child, and the record says why
    const world = start({ timeoutMs: 30 });
    const spawn = await world.spawned();
    await eventually(() => spawn.process.kills.includes("SIGTERM"));
    spawn.process.exit(0, 15);
    expect(await world.done).toBe(0);
    expect(status()).toMatchObject({ state: "killed", reason: "timeout" });
    expect("sock" in status()).toBe(false);
  });

  test("tA_pty_holder_signal_ends_as_stop: SIGTERM and SIGHUP stop the child, and the session ends with a record", async () => {
    expect([...HOLDER_SIGNALS]).toEqual(["SIGTERM", "SIGHUP"]);
    for (const signal of HOLDER_SIGNALS) {
      const listeners = new Map<string, () => void>();
      let removed = 0;
      const world = start(
        {},
        {
          extra: {
            killGraceMs: 20,
            onSignal: (name, listener) => {
              listeners.set(name, listener);
              return () => {
                removed++;
                listeners.delete(name);
              };
            },
          },
        },
      );
      const spawn = await world.spawned();
      const pair = memoryPair();
      const client = new TestClient(pair.client);
      world.binder.state.client(pair.holder);
      client.hello();
      expect([...listeners.keys()].sort(), signal).toEqual([...HOLDER_SIGNALS].sort());
      listeners.get(signal)?.();
      expect(spawn.process.kills, signal).toEqual(["SIGTERM"]);
      // the holder is still there for its clients while the child ends, and a child that will not end is killed
      expect(client.bye, signal).toBeUndefined();
      expect(world.binder.state.closed, signal).toBe(0);
      await eventually(() => spawn.process.kills.includes("SIGKILL"));
      spawn.process.exit(0, 9);
      expect(await world.done, signal).toBe(0);
      expect(status(), signal).toMatchObject({ state: "killed", reason: "stopped" });
      expect("sock" in status(), signal).toBe(false);
      expect(client.bye?.reason, signal).toBe("killed");
      expect(world.binder.state.closed, signal).toBe(1);
      expect(removed, signal).toBe(HOLDER_SIGNALS.length);
      rmSync(join(dir, "status.json"));
    }
  });

  test("tA_pty_holder_signal_before_spawn_starts_no_child: the socket goes and the record ends", async () => {
    const order: string[] = [];
    let removed = 0;
    const binder = fakeBinder();
    const world = start(
      {},
      {
        bind: async (...args) => {
          order.push("bind");
          return binder.bind(...args);
        },
        extra: {
          // the signal is there the moment the holder listens for it
          onSignal: (name, listener) => {
            order.push(`listen:${name}`);
            if (name === "SIGTERM") listener();
            return () => {
              removed++;
            };
          },
        },
      },
    );
    expect(await world.done).toBe(1);
    // the holder listens right after the bind, before anything else can end it
    expect(order).toEqual(["bind", "listen:SIGTERM", "listen:SIGHUP"]);
    expect(world.spawns.length).toBe(0);
    expect(status()).toMatchObject({ state: "killed", reason: "stopped" });
    expect("sock" in status()).toBe(false);
    expect(binder.state.closed).toBe(1);
    expect(world.lines.length).toBe(1);
    expect(world.lines[0]).toStartWith("HOLDER_BOOT_FAILED:");
    expect(removed).toBe(HOLDER_SIGNALS.length);
  });

  test("tA_pty_holder_signal_after_exit_changes_nothing: the child that ended by itself is not signalled", async () => {
    const listeners = new Map<string, () => void>();
    const world = start(
      {},
      {
        extra: {
          drainMs: 60,
          killGraceMs: 10,
          onSignal: (name, listener) => {
            listeners.set(name, listener);
            return () => {};
          },
        },
      },
    );
    const spawn = await world.spawned();
    spawn.process.exit(0);
    // inside the drain: the exit was seen, the record is not written yet
    listeners.get("SIGTERM")?.();
    expect(await world.done).toBe(0);
    // longer than the grace: no SIGKILL to a process group that may be somebody else's by now
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawn.process.kills).toEqual([]);
    expect(status()).toMatchObject({ state: "exited", exitCode: 0 });
    expect(status().reason).toBeUndefined();
  });

  test("tA_pty_holder_real_signal_listeners_are_removed", async () => {
    const before = HOLDER_SIGNALS.map((signal) => process.listenerCount(signal));
    const world = start();
    const spawn = await world.spawned();
    expect(HOLDER_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
      before.map((count) => count + 1),
    );
    spawn.process.exit(0);
    expect(await world.done).toBe(0);
    expect(HOLDER_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  test("tA_pty_socket_unlinked_on_unexpected_throw: the clients are told, the child is killed, the record ends", async () => {
    // before `ready`: the starter gets its line
    let spawned: FakeSpawn | undefined;
    const early = start(
      {},
      {
        onSpawn: (spawn) => {
          spawned = spawn;
          spawn.process.onData = () => {
            throw new Error("boom at the start");
          };
        },
      },
    );
    expect(await early.done).toBe(1);
    expect(early.lines).toEqual(["HOLDER_BOOT_FAILED:boom at the start"]);
    expect(spawned?.process.kills).toContain("SIGKILL");
    expect(early.binder.state.closed).toBe(1);
    expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
    rmSync(join(dir, "status.json"));

    // after `ready`, with a client attached: the wait for the clients throws
    const world = start();
    const spawn = await world.spawned();
    const pair = memoryPair();
    const client = new TestClient(pair.client);
    world.binder.state.client(pair.holder);
    client.hello();
    world.binder.state.flush = () => Promise.reject(new Error("boom at the end"));
    const signals = HOLDER_SIGNALS.map((signal) => process.listenerCount(signal));
    spawn.process.exit(0);
    expect(await world.done).toBe(1);
    expect(world.lines).toEqual(["ready"]);
    expect(client.bye).toBeDefined();
    expect(client.closed).toBe(true);
    expect(world.binder.state.closed).toBe(1);
    expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
    expect("sock" in status()).toBe(false);
    expect(HOLDER_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(
      signals.map((count) => count - 1),
    );
  });

  test("tA_pty_final_record_write_failure_is_not_a_crash: a folder that cannot be written at the end", async () => {
    const world = start();
    const spawn = await world.spawned();
    world.binder.state.flush = async () => {
      chmodSync(dir, 0o500);
    };
    spawn.process.exit(0);
    expect(await world.done).toBe(0);
    chmodSync(dir, 0o700);
    expect(status().state).toBe("running");
    expect(world.binder.state.closed).toBe(1);
  });

  test("tA_pty_tail_is_one_stream_stripped_and_redacted", async () => {
    const world = start({ rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }] });
    const spawn = await world.spawned();
    spawn.process.emit("\u001b[1mbold\u001b[0m ZZSEC");
    spawn.process.emit("\u001b[31mRETZZ\u001b[0m done\r\n");
    spawn.process.exit(0);
    await world.done;
    expect(readFileSync(join(dir, "tail.txt"), "utf8")).toBe("bold [REDACTED:zz] done\n");
    // one stream: no file per stream, and no raw byte of the terminal anywhere in the folder
    expect(existsSync(join(dir, "stdout.txt")) || existsSync(join(dir, "stderr.txt"))).toBe(false);
    for (const file of ["tail.txt", "status.json"]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text.includes("\u001b") || text.includes("ZZSECRETZZ"), file).toBe(false);
    }
  });

  test("tA_terminal_tail_redacts_a_printed_secret", async () => {
    // A worker in a terminal prints a secret as a line, as a tool's output or an echoed variable does:
    // a project rule and the built-in rules both find it, in colour or not, cut by a chunk border or not.
    const token = `ghp_${"A1b2C3d4E5f6G7h8I9".repeat(2)}`;
    const world = start({ rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }] });
    const spawn = await world.spawned();
    spawn.process.emit("$ echo $API_KEY\r\n");
    spawn.process.emit("ZZSECRETZZ\r\n");
    spawn.process.emit(`\u001b[32mexport GH_TOKEN=${token}\u001b[0m\r\n`);
    spawn.process.emit(`again ${token.slice(0, 12)}`);
    spawn.process.emit(`${token.slice(12)} and ZZSEC`);
    spawn.process.emit("RETZZ\r\nthe step is done\r\n");
    spawn.process.exit(0);
    await world.done;
    const tail = readFileSync(join(dir, "tail.txt"), "utf8");
    expect(tail).not.toContain("ZZSECRETZZ");
    expect(tail).not.toContain(token);
    expect(tail).not.toContain(token.slice(4, 16));
    expect(tail).toContain("[REDACTED:zz]");
    expect(tail).toContain("[REDACTED:github-token]");
    // what is not a secret is still there to read
    expect(tail).toContain("$ echo $API_KEY\n");
    expect(tail.endsWith("the step is done\n")).toBe(true);
    // and no other file of the session holds it
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const text = readFileSync(join(dir, file.name), "utf8");
      expect(text.includes("ZZSECRETZZ") || text.includes(token), file.name).toBe(false);
    }
  });

  test("tA_terminal_tail_painted_secret_is_the_known_limit", async () => {
    // A full-screen program paints its screen in pieces: it moves the cursor between the halves of a
    // word, so the text of the tail never holds the word in one piece and no rule can find it. This is
    // the documented limit of a terminal's tail (`docs/session-formats.md`): the tail is bounded, newer
    // output replaces it, and `kodel agent rm` or `prune` removes it. The test pins the limit, so a
    // change of it (a screen model, say) is seen and the docs are changed with it.
    const world = start({ rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }] });
    const spawn = await world.spawned();
    // The second half is painted first, at its column; then the cursor goes back for the first half.
    spawn.process.emit("\u001b[2J\u001b[5;10HRETZZ\u001b[5;5HZZSEC\u001b[6;1H\r\n");
    spawn.process.exit(0);
    await world.done;
    const tail = readFileSync(join(dir, "tail.txt"), "utf8");
    // The escape sequences are gone, and the pieces stay as they were written: not the secret as a word.
    expect(tail.includes("\u001b")).toBe(false);
    expect(tail).not.toContain("ZZSECRETZZ");
    expect(tail).not.toContain("[REDACTED:zz]");
    expect(tail).toContain("RETZZ");
    expect(tail).toContain("ZZSEC");
    // The same bytes painted in reading order are a printed word, and that one is caught.
    rmSync(join(dir, "status.json"));
    const printed = start({ rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }] });
    const again = await printed.spawned();
    again.process.emit("\u001b[2J\u001b[5;5HZZSEC\u001b[5;10HRETZZ\u001b[6;1H\r\n");
    again.process.exit(0);
    await printed.done;
    const caught = readFileSync(join(dir, "tail.txt"), "utf8");
    expect(caught).toContain("[REDACTED:zz]");
    expect(caught).not.toContain("ZZSECRETZZ");
  });
});

describe("pty holder, a tail that lost its beginning", () => {
  const TAIL = 16 * 1024;
  const MARGIN = 1024;
  const KEEP = TAIL + MARGIN;
  const tailOf = async (chunks: string[], tailBytes = TAIL): Promise<string> => {
    const world = start({ tailBytes });
    const spawn = await world.spawned();
    for (const chunk of chunks) spawn.process.emit(chunk);
    spawn.process.exit(0);
    await world.done;
    const text = readFileSync(join(dir, "tail.txt"), "utf8");
    rmSync(join(dir, "status.json"));
    return text;
  };

  test("tA_pty_tail_margin_in_stripped_text: a token cut at the head of an escape-heavy tail is not written", async () => {
    const token = `ghp_${"A1b2C3d4E5f6G7h8I9".repeat(2)}`;
    // whole, the rule finds it
    expect(await tailOf([`see ${token}\r\n`])).toBe("see [REDACTED:github-token]\n");
    // Ten raw bytes for every one that is text: the raw bytes kept begin with the second half of the token, and
    // stripped they are far shorter than the tail, so cutting to the tail's size drops nothing.
    const half = token.slice(token.length / 2);
    const coloured = "\u001b[31ma\u001b[0m";
    const end = "  done\r\n";
    const units = (KEEP - half.length - end.length) / coloured.length;
    expect(Number.isInteger(units)).toBe(true);
    const raw = `${"x".repeat(100)}${token}${coloured.repeat(units)}${end}`;
    expect(Buffer.byteLength(raw.slice(raw.length - KEEP))).toBe(KEEP);
    expect(raw.slice(raw.length - KEEP).startsWith(half)).toBe(true);
    for (const chunks of [[raw], [raw.slice(0, 130), raw.slice(130)]]) {
      const tail = await tailOf(chunks);
      for (let at = 0; at + 6 <= half.length; at++) {
        expect(tail.includes(half.slice(at, at + 6)), `${at}`).toBe(false);
      }
      // the margin came off the text that is written, and the rest of it is there
      expect(tail).toBe(
        `${"a".repeat(units + half.length + "  done\n".length - MARGIN - 7)}  done\n`,
      );
    }
    // a tail that lost nothing keeps its first byte
    expect(await tailOf([`first ${coloured.repeat(50)} last\r\n`])).toBe(
      `first ${"a".repeat(50)} last\n`,
    );
  });

  test("tA_pty_tail_cut_key_after_strip: a cut key whose END line carries escape sequences is not written", async () => {
    // a line of a key that no other rule takes (the entropy rule would hide a longer one, and this test with it)
    const line = "b3BlbnNzaC1rZXktdjEAAAAA";
    const after = `${"after the key ".repeat(120)}\r\n`;
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      ...Array.from({ length: 800 }, () => line),
      "-----END \u001b[1mRSA PRIVATE\u001b[0m KEY-----",
      "",
    ].join("\r\n");
    const tail = await tailOf([key, after]);
    expect(tail.includes(line.slice(0, 16))).toBe(false);
    expect(tail.endsWith("after the key \n")).toBe(true);
    expect(tail.length).toBeGreaterThan(500);
  });
});

/** Every way out of the holder after the bind, with a binder that binds nothing and (where it can) a real one. */
const BINDERS: [string, boolean][] = [
  ["fake binder", false],
  ["real socket", true],
];

describe("pty holder, the socket is gone on every way out", () => {
  const each = (
    name: string,
    body: (
      make: () => { bind: SocketBinder; gone: () => boolean; made: () => boolean },
    ) => Promise<void>,
  ) => {
    for (const [label, real] of BINDERS) {
      const run = real ? socketTest : test;
      run(`${name}: ${label}`, async () => {
        await body(() => {
          if (!real) {
            const binder = fakeBinder();
            return {
              bind: binder.bind,
              gone: () => binder.state.closed === 1,
              made: () => binder.state.calls === 1,
            };
          }
          let path = "";
          return {
            bind: async (list, owner) => {
              const bound = await bindSessionSocket(list, owner);
              path = bound.path;
              return bound;
            },
            gone: () => path !== "" && !existsSync(path),
            made: () => path !== "",
          };
        });
      });
    }
  };

  each("tA_pty_socket_unlinked_on_failboot", async (make) => {
    const binder = make();
    const world = start(
      {},
      {
        bind: binder.bind,
        onSpawn: () => {
          throw new Error("forkpty(3) failed.");
        },
      },
    );
    expect(await world.done).toBe(1);
    expect(world.lines[0]).toContain("forkpty");
    expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
    expect(status().child).toBeUndefined();
    expect(binder.made()).toBe(true);
    expect(binder.gone()).toBe(true);

    // a command that is not there is the same way out
    rmSync(join(dir, "status.json"));
    const second = make();
    const missing = start({ argv: ["kodel-no-such-command"] }, { bind: second.bind });
    expect(await missing.done).toBe(1);
    expect(second.made()).toBe(true);
    expect(second.gone()).toBe(true);
  });

  each("tA_pty_socket_unlinked_on_tombstone", async (make) => {
    const binder = make();
    let spawned: FakeSpawn | undefined;
    const world = start(
      {},
      {
        bind: binder.bind,
        // a reader gave the session up while the child was being made
        onSpawn: (spawn) => {
          spawned = spawn;
          writeFileSync(
            join(dir, "status.json"),
            encodeRecord("status", {
              v: 1,
              state: "lost",
              by: "reader",
              reason: "no_status",
              since: Date.now(),
            }),
          );
        },
      },
    );
    expect(await world.done).toBe(1);
    expect(world.lines).toEqual(["HOLDER_BOOT_FAILED:tombstone"]);
    expect(spawned?.process.kills).toContain("SIGKILL");
    expect(status()).toMatchObject({ state: "lost", by: "reader" });
    expect(binder.gone()).toBe(true);
  });

  each("tA_pty_socket_unlinked_on_running_write_failure", async (make) => {
    const binder = make();
    let spawned: FakeSpawn | undefined;
    const world = start(
      {},
      {
        bind: binder.bind,
        // the record can still be read, but nothing can be written beside it
        onSpawn: (spawn) => {
          spawned = spawn;
          chmodSync(dir, 0o500);
        },
      },
    );
    expect(await world.done).toBe(1);
    chmodSync(dir, 0o700);
    expect(world.lines).toEqual([]);
    expect(spawned?.process.kills).toContain("SIGKILL");
    expect(status().state).toBe("starting");
    expect(binder.gone()).toBe(true);
  });

  each("tA_pty_socket_unlinked_on_dir_removed", async (make) => {
    const binder = make();
    const world = start({}, { bind: binder.bind });
    const spawn = await world.spawned();
    expect(binder.gone()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    // the watcher finds the folder gone and ends the child; the socket goes when the child has ended
    await eventually(() => spawn.process.kills.includes("SIGTERM"));
    spawn.process.exit(0, 15);
    expect(await world.done).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(binder.gone()).toBe(true);
  });
});

describe("pty holder, a leftover at the socket path", () => {
  socketTest("tA_pty_bind_leftover_replaced", async () => {
    const path = (candidates()[0] as SocketCandidate).path;
    await staleSocket(path);
    expect(existsSync(path)).toBe(true);
    const world = start({}, { bind: bindSessionSocket });
    const spawn = await world.spawned();
    expect(status()).toMatchObject({ state: "running", sock: path });
    spawn.process.exit(0);
    expect(await world.done).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  socketTest("tA_pty_bind_live_leftover_refused", async () => {
    const path = (candidates()[0] as SocketCandidate).path;
    const other = await liveSocket(path);
    try {
      const world = start({}, { bind: bindSessionSocket });
      expect(await world.done).toBe(1);
      expect(world.lines.length).toBe(1);
      expect(world.lines[0]).toContain("somebody listens");
      expect(status()).toMatchObject({ state: "killed", reason: "holder_error" });
      expect(status().child).toBeUndefined();
      expect(world.spawns).toEqual([]);
      // the socket of whoever listens is not touched
      expect(existsSync(path)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

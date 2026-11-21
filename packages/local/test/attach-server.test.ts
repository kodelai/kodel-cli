import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACH_PROTOCOL_VERSION,
  createModeTracker,
  encodeBye,
  encodeFrame,
  encodeHello,
  encodeSend,
  encodeWelcome,
  FRAME,
  fromBinary,
  MAX_FRAME_PAYLOAD,
  parseSent,
  SEND_PASTE_GAP_MS,
  stripTerminalQueries,
  toBinary,
} from "@kodel-ai/pipeline-core";
import {
  ATTACH_HELLO_TIMEOUT_MS,
  ATTACH_INPUT_PENDING_BYTES,
  ATTACH_LAG_BYTES,
  ATTACH_MAX_CLIENTS,
  ATTACH_PAUSED_PROBE_MS,
  ATTACH_RING_BYTES,
  AttachServer,
  OutputRing,
} from "../src/attach-server";
import { ptyFromModule } from "../src/session-pty";
import { forgetName } from "../src/session-records";
import { bindSessionSocket, connectSocket } from "../src/session-socket";
import {
  FakeChild,
  FakeRawPty,
  ManualTimers,
  memoryPair,
  TestClient,
} from "./helpers/attach-fakes";
import { shortDir, socketSkipReason, uid } from "./helpers/socket-env";

const socketTest = test.skipIf(socketSkipReason !== undefined);

const ESC = "\u001b";
/** The modules this change added, as the process of `tA_new_modules_import_on_windows` imports them. */
const MODULES = [
  "./src/attach-server.ts",
  "./src/session-pty.ts",
  "./src/session-socket.ts",
  "../cli/src/attach-client.ts",
  "../cli/src/pty-loader.ts",
  "@kodel-ai/pipeline-core",
];

const setup = (options: { child?: boolean; ringBytes?: number; lagBytes?: number } = {}) => {
  const timers = new ManualTimers();
  const server = new AttachServer({
    timers,
    ...(options.ringBytes !== undefined ? { ringBytes: options.ringBytes } : {}),
    ...(options.lagBytes !== undefined ? { lagBytes: options.lagBytes } : {}),
  });
  const child = new FakeChild();
  if (options.child !== false) server.setChild(child);
  const connect = () => {
    const pair = memoryPair();
    const client = new TestClient(pair.client);
    server.accept(pair.holder);
    return client;
  };
  const attach = (cols = 80, rows = 24) => connect().hello({ cols, rows });
  return { timers, server, child, connect, attach };
};

/** Each hostile behaviour is tried with the child running and in the window before it exists. */
const WINDOWS = [
  ["with the child", true],
  ["before the child exists", false],
] as const;

/** The well-behaved client and the child go on after a hostile one was dropped. */
const othersGoOn = (
  world: ReturnType<typeof setup>,
  good: TestClient,
  hasChild: boolean,
  label: string,
) => {
  expect(good.closed, label).toBe(false);
  expect(good.bye, label).toBeUndefined();
  if (!hasChild) {
    world.server.setChild(world.child);
  }
  world.child.emit("still here");
  expect(good.output.endsWith("still here"), label).toBe(true);
  good.input("k");
  expect(world.child.writes.at(-1), label).toBe("k");
  expect(world.child.kills, label).toEqual([]);
};

describe("attach server, hostile clients", () => {
  test("tA_attach_no_hello_times_out", () => {
    for (const [label, hasChild] of WINDOWS) {
      const world = setup({ child: hasChild });
      const good = world.attach();
      const silent = world.connect();
      world.timers.advance(ATTACH_HELLO_TIMEOUT_MS - 1);
      expect(silent.closed, label).toBe(false);
      expect(world.server.clientCount()).toBe(2);
      world.timers.advance(1);
      expect(silent.bye?.reason, label).toBe("hello_timeout");
      expect(silent.closed, label).toBe(true);
      expect(world.server.clientCount()).toBe(1);
      // a client that said hello in time is not timed out later
      world.timers.advance(ATTACH_HELLO_TIMEOUT_MS * 3);
      othersGoOn(world, good, hasChild, label);
    }
  });

  test("tA_attach_partial_hello_times_out", () => {
    for (const [label, hasChild] of WINDOWS) {
      const world = setup({ child: hasChild });
      const good = world.attach();
      const slow = world.connect();
      const hello = encodeHello({ cols: 80, rows: 24 });
      slow.raw(hello.subarray(0, hello.length - 1));
      world.timers.advance(ATTACH_HELLO_TIMEOUT_MS - 1);
      expect(slow.closed, label).toBe(false);
      world.timers.advance(1);
      expect(slow.bye?.reason, label).toBe("hello_timeout");
      expect(slow.closed, label).toBe(true);
      othersGoOn(world, good, hasChild, label);
    }
  });

  test("tA_attach_frame_before_hello_closed", () => {
    for (const [label, hasChild] of WINDOWS) {
      for (const first of [
        encodeFrame(FRAME.INPUT, fromBinary("rm -rf /\r")),
        encodeFrame(FRAME.RESIZE, fromBinary('{"cols":1,"rows":1}')),
        encodeSend({ text: "x" }),
        encodeFrame(FRAME.HELLO, fromBinary("not json")),
        new Uint8Array([0x7f, 0, 0, 0, 0]),
        (() => {
          const head = new Uint8Array([FRAME.INPUT, 0, 0, 0, 0]);
          new DataView(head.buffer).setUint32(1, MAX_FRAME_PAYLOAD + 1);
          return head;
        })(),
      ]) {
        const world = setup({ child: hasChild });
        const good = world.attach();
        const before = world.server.size();
        const hostile = world.connect();
        hostile.raw(first);
        expect(hostile.bye?.reason, label).toBe("protocol");
        expect(hostile.closed, label).toBe(true);
        expect(hostile.welcome, label).toBeUndefined();
        expect(world.child.writes, label).toEqual([]);
        expect(world.server.size(), label).toEqual(before);
        expect(world.timers.waiting(), label).toBe(0);
        othersGoOn(world, good, hasChild, label);
      }
    }
  });

  test("tA_attach_version_mismatch: the holder answers BYE and names both versions", () => {
    const world = setup();
    const good = world.attach();
    const other = world.connect().hello({ cols: 80, rows: 24 }, ATTACH_PROTOCOL_VERSION + 1);
    expect(other.bye?.reason).toBe("version");
    expect(other.bye?.text).toContain(String(ATTACH_PROTOCOL_VERSION + 1));
    expect(other.closed).toBe(true);
    expect(other.welcome).toBeUndefined();
    othersGoOn(world, good, true, "version");
  });

  test("tA_attach_holder_only_frame_closed", () => {
    for (const [label, hasChild] of WINDOWS) {
      for (const frame of [
        encodeWelcome({ cols: 80, rows: 24 }),
        encodeFrame(FRAME.OUTPUT, fromBinary("fake output")),
        encodeFrame(FRAME.SENT, fromBinary('{"bytes":1}')),
        encodeBye({ reason: "exited" }),
        encodeHello({ cols: 80, rows: 24 }), // a second hello
      ]) {
        const world = setup({ child: hasChild });
        const good = world.attach();
        const hostile = world.attach();
        expect(hostile.welcome, label).toBeDefined();
        hostile.raw(frame);
        expect(hostile.bye?.reason, label).toBe("protocol");
        expect(hostile.closed, label).toBe(true);
        expect(good.output, label).not.toContain("fake output");
        othersGoOn(world, good, hasChild, label);
      }
    }
  });

  test("tA_attach_input_flood_paused_at_bound", () => {
    expect(ATTACH_INPUT_PENDING_BYTES).toBe(64 * 1024);
    const world = setup();
    world.child.takes = false;
    const good = world.attach();
    const flood = world.attach();
    const piece = "x".repeat(16 * 1024);
    for (let i = 0; i < 3; i++) flood.input(piece);
    expect((flood.end as ReturnType<typeof memoryPair>["client"]).peer.paused).toBe(false);
    flood.input(piece); // 64 KiB are pending now: the stream is paused
    const holderEnd = (flood.end as ReturnType<typeof memoryPair>["client"]).peer;
    expect(holderEnd.paused).toBe(true);
    for (let i = 0; i < 20; i++) flood.input(piece);
    // nothing past the bound was taken: it waits in the stream, not in the holder
    expect(world.child.writes.join("").length).toBe(ATTACH_INPUT_PENDING_BYTES);
    expect(holderEnd.inbox.length).toBe(20);
    // the other client types on meanwhile
    good.input("ok");
    expect(world.child.writes.at(-1)).toBe("ok");
    expect(flood.closed).toBe(false);
    // the terminal takes what it was given: the flood goes on, and is paused again at the bound
    world.child.drain();
    expect(world.child.writes.join("").length).toBe(2 * ATTACH_INPUT_PENDING_BYTES + 2);
    expect(holderEnd.paused).toBe(true);
    world.child.takes = true;
    world.child.drain();
    expect(holderEnd.paused).toBe(false);
    expect(holderEnd.inbox.length).toBe(0);
    expect(world.child.writes.join("").length).toBe(24 * piece.length + 2);

    // before the child exists a flood is dropped, not kept: nothing is pending and nothing is paused
    const early = setup({ child: false });
    const patient = early.attach();
    const noisy = early.attach();
    for (let i = 0; i < 20; i++) noisy.input(piece);
    expect((noisy.end as ReturnType<typeof memoryPair>["client"]).peer.pauses).toBe(0);
    expect(early.server.buffered()).toBe(0);
    othersGoOn(early, patient, false, "flood before the child");
    expect(early.child.writes).toEqual(["k"]);
  });

  test("tA_attach_input_flood_paused_at_bound: the module's stream, not a turn of the loop, says a write left", async () => {
    // The module's own `write` hands the bytes to this stream and never asks whether they left.
    const taken: (() => void)[] = [];
    let queued = 0;
    const raw = new FakeRawPty();
    const stream = {
      write(data: Uint8Array, done: () => void): boolean {
        queued += data.length;
        taken.push(() => {
          queued -= data.length;
          done();
        });
        return false;
      },
    };
    Object.assign(raw, { _socket: stream });
    const child = ptyFromModule({ spawn: () => raw }, false).spawn({
      file: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      cols: 80,
      rows: 24,
    });
    const server = new AttachServer({ timers: new ManualTimers() });
    server.setChild(child);
    const pair = memoryPair();
    const flood = new TestClient(pair.client).hello();
    server.accept(pair.holder);
    const piece = "x".repeat(16 * 1024);
    const turns = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 24; i++) flood.input(piece);
      await turns();
      // a child that does not read: what the holder keeps for it never passes the bound
      expect(queued).toBe(ATTACH_INPUT_PENDING_BYTES);
      expect(pair.holder.paused).toBe(true);
      expect(raw.writes.length).toBe(0);
    }
    expect(pair.holder.inbox.length).toBe(3 * 24 - 4);
    // the terminal takes one piece: one more is let in
    taken.shift()?.();
    await turns();
    expect(queued).toBe(ATTACH_INPUT_PENDING_BYTES);
    expect(pair.holder.inbox.length).toBe(3 * 24 - 5);
    while (taken.length > 0) taken.shift()?.();
    expect(pair.holder.inbox.length).toBe(0);
    expect(pair.holder.paused).toBe(false);
    expect(queued).toBe(0);

    // a module that shows no stream: the bytes still reach it, and the write is reported
    const plain = new FakeRawPty();
    const other = ptyFromModule({ spawn: () => plain }).spawn({
      file: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      cols: 80,
      rows: 24,
    });
    let reported = 0;
    other.write(fromBinary("abc"), () => reported++);
    await turns();
    expect([plain.writes.length, reported]).toEqual([1, 1]);
    // a stream that throws (the terminal is gone) leaves nothing owed
    const broken = new FakeRawPty();
    Object.assign(broken, {
      _socket: {
        write() {
          throw new Error("gone");
        },
      },
    });
    const dead = ptyFromModule({ spawn: () => broken }).spawn({
      file: "/bin/sh",
      args: [],
      cwd: "/",
      env: {},
      cols: 80,
      rows: 24,
    });
    dead.write(fromBinary("abc"), () => reported++);
    expect(reported).toBe(2);
  });

  test("tA_attach_paused_client_that_died_frees_its_place", () => {
    expect(ATTACH_PAUSED_PROBE_MS).toBeLessThanOrEqual(10_000);
    const world = setup();
    world.child.takes = false;
    const good = world.attach();
    const dead = world.attach();
    const alive = world.attach();
    const piece = "x".repeat(ATTACH_INPUT_PENDING_BYTES);
    dead.input(piece);
    alive.input(piece);
    const ends = [dead, alive].map((c) => (c.end as ReturnType<typeof memoryPair>["client"]).peer);
    expect(ends.map((end) => end.paused)).toEqual([true, true]);
    // the client is gone; its paused stream reports nothing, so the holder still counts it
    (ends[0] as (typeof ends)[number]).peerVanished = true;
    expect(world.server.clientCount()).toBe(3);
    world.timers.advance(ATTACH_PAUSED_PROBE_MS);
    expect(world.server.clientCount()).toBe(2);
    // a paused client that lives stays, however long; what it was sent meanwhile shows nothing
    for (let i = 0; i < 10; i++) world.timers.advance(ATTACH_PAUSED_PROBE_MS);
    expect(world.server.clientCount()).toBe(2);
    expect(alive.closed).toBe(false);
    expect(alive.output).toBe("");
    // once the terminal took the input nobody is probed any more
    world.child.takes = true;
    world.child.drain();
    expect(ends[1]?.paused).toBe(false);
    const frames = alive.frames.length;
    world.timers.advance(10 * ATTACH_PAUSED_PROBE_MS);
    expect(alive.frames.length).toBe(frames);
    expect(world.timers.waiting()).toBe(0);
    othersGoOn(world, good, true, "after a paused client died");
  });

  socketTest(
    "tA_attach_paused_client_that_died_frees_its_place: over a socket, where a paused stream sees no end",
    async () => {
      const dir = shortDir("kd-probe-dead-");
      const bound = await bindSessionSocket([{ kind: "run", dir, path: join(dir, "a.sock") }], uid);
      try {
        const server = new AttachServer({ pausedProbeMs: 50 });
        const child = new FakeChild();
        child.takes = false;
        server.setChild(child);
        bound.onClient((stream) => server.accept(stream));
        const socket = await connectSocket(bound.path);
        socket.on("error", () => {});
        socket.write(encodeHello({ cols: 80, rows: 24 }));
        socket.write(encodeFrame(FRAME.INPUT, fromBinary("x".repeat(ATTACH_INPUT_PENDING_BYTES))));
        const until = async (done: () => boolean): Promise<void> => {
          for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
        };
        await until(() => child.writes.length === 1);
        expect(server.clientCount()).toBe(1);
        socket.destroy();
        await until(() => server.clientCount() === 0);
        expect(server.clientCount()).toBe(0);
      } finally {
        bound.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("tA_attach_before_spawn_window", () => {
    const world = setup({ child: false });
    expect(world.server.size()).toEqual({ cols: 80, rows: 24 });
    const first = world.attach(100, 30);
    expect(first.welcome).toEqual({ cols: 100, rows: 30 });
    first.resize(120, 40);
    const second = world.attach(90, 20);
    second.resize(132, 43);
    first.input("typed too early");
    // the last size a client gave is the size to spawn with
    expect(world.server.size()).toEqual({ cols: 132, rows: 43 });
    world.server.setChild(world.child);
    expect(world.child.writes).toEqual([]);
    expect(world.child.resizes).toEqual([]);
    first.input("now");
    expect(world.child.writes).toEqual(["now"]);
  });

  test("tA_attach_client_error_keeps_holder", () => {
    const world = setup();
    const good = world.attach();
    for (const error of [
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    ]) {
      const broken = world.attach();
      expect(world.server.clientCount()).toBe(2);
      (broken.end as ReturnType<typeof memoryPair>["client"]).end(error);
      expect(world.server.clientCount()).toBe(1);
      // output after the error is not written to the dead stream (a write there would throw)
      world.child.emit("after");
    }
    // a stream whose write throws is dropped by the write, nothing else
    const throwing = memoryPair();
    world.server.accept(throwing.holder);
    new TestClient(throwing.client).hello();
    throwing.holder.closed = true;
    world.child.emit("x");
    expect(world.server.clientCount()).toBe(1);
    othersGoOn(world, good, true, "errors");
  });
});

describe("attach server, the ring and the replay", () => {
  test("tA_ring_bounded", () => {
    expect(ATTACH_RING_BYTES).toBe(1024 * 1024);
    const dropped: number[] = [];
    const ring = new OutputRing(ATTACH_RING_BYTES, (bytes) => dropped.push(bytes.length));
    let written = 0;
    for (const size of [1, 700_000, 400_000, 3_000_000, 5, 1_048_576, 17]) {
      ring.add(new Uint8Array(size).fill(size % 251));
      written += size;
      expect(ring.length).toBeLessThanOrEqual(ATTACH_RING_BYTES);
      expect(ring.bytes().length).toBe(ring.length);
      // every byte is either in the ring or was handed on, none twice
      expect(ring.length + dropped.reduce((a, b) => a + b, 0)).toBe(written);
    }
    expect(ring.wrapped).toBe(true);
    // the ring holds the end of what was written, in order
    const order = new OutputRing(4, () => {});
    for (const text of ["ab", "cde", "f"]) order.add(fromBinary(text));
    expect(toBinary(order.bytes())).toBe("cdef");

    const world = setup();
    world.child.emit(new Uint8Array(ATTACH_RING_BYTES + 5000).fill(65));
    expect(world.server.buffered()).toBe(ATTACH_RING_BYTES);
    expect(world.attach().output.length).toBe(ATTACH_RING_BYTES);
  });

  test("tA_ring_cut_mid_sequence", () => {
    // the cut inside a UTF-8 sequence: the replay starts at a character
    const euro = "â\u0082¬"; // the three bytes of one character
    for (let lost = 1; lost <= 2; lost++) {
      const world = setup({ ringBytes: 10 + (3 - lost) });
      world.child.emit(`${"z".repeat(20)}${euro}0123456789`);
      const replay = fromBinary(world.attach().output);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(replay)).toBe("0123456789");
    }
    // the cut inside an escape sequence: its start comes back, so the terminal sees it whole
    const colour = `${ESC}[38;5;196m`;
    for (let cut = 1; cut < colour.length; cut++) {
      const kept = colour.slice(cut);
      const world = setup({ ringBytes: kept.length + 3 });
      world.child.emit(`${"z".repeat(30)}${colour}red`);
      expect(world.attach().output, String(cut)).toBe(`${colour}red`);
    }
    // an unwrapped ring that begins with bytes that look like a continuation is not touched
    const whole = setup();
    whole.child.emit(new Uint8Array([0x80, 0x81, 0x41]));
    expect(whole.attach().output).toBe("\u0080\u0081A");
  });

  test("tA_attach_replay_prefix_then_ring", () => {
    // before the ring wraps there is no prefix: the ring is the whole history
    const fresh = setup({ ringBytes: 4096 });
    const start = `${ESC}[?1049h${ESC}[?2004h${ESC}[>1u${ESC}[?1000h`;
    fresh.child.emit(`${start}hello`);
    expect(fresh.attach().output).toBe(`${start}hello`);

    // after it wrapped: the modes as they were at the ring's oldest byte, then the ring
    const world = setup({ ringBytes: 64 });
    world.child.emit(start);
    world.child.emit(`${ESC}[?1000l`); // switched off again while still in what will be dropped
    world.child.emit("x".repeat(100));
    world.child.emit(`${ESC}[?1004h`); // switched on inside the ring: not in the prefix
    world.child.emit("tail");
    const replay = world.attach().output;
    const ring = `${"x".repeat(64 - 8 - 4)}${ESC}[?1004htail`;
    const prefix = `${ESC}[?1049h${ESC}[?2004h${ESC}[>1u`;
    expect(replay).toBe(prefix + ring);
    // nothing is set twice: the kitty keyboard entry is pushed once, the mode of the ring is set once
    expect(replay.split(`${ESC}[>1u`).length - 1).toBe(1);
    expect(replay.split(`${ESC}[?1004h`).length - 1).toBe(1);
    expect(toBinary(stripTerminalQueries(fromBinary(prefix)))).toBe(prefix);
    // a terminal that got prefix and ring is in the state of one that saw everything
    const seenAll = createModeTracker();
    seenAll.feed(fromBinary(`${start}${ESC}[?1000l${"x".repeat(100)}${ESC}[?1004htail`));
    const seenReplay = createModeTracker();
    seenReplay.feed(fromBinary(replay));
    expect(seenReplay.state()).toEqual(seenAll.state());

    // a switch the cut went through is whole in the replay, and counted once
    const through = setup({ ringBytes: 10 });
    through.child.emit(`aaaaaaaaaaaa${ESC}[?20`);
    through.child.emit("04hbbbbbb");
    const cutReplay = through.attach().output;
    expect(cutReplay).toBe(`${ESC}[?2004hbbbbbb`);

    // a query in the ring is not replayed; the live stream keeps its queries
    const asking = setup();
    asking.child.emit(`one${ESC}[6n${ESC}[c${ESC}]11;?\u0007two${ESC}[`);
    const late = asking.attach();
    expect(late.output).toBe("onetwo");
    asking.child.emit(`5n${ESC}[6nlive`);
    expect(late.output).toBe(`onetwo${ESC}[6nlive`);
    const early = setup();
    const watching = early.attach();
    early.child.emit(`a${ESC}[6nb`);
    expect(watching.output).toBe(`a${ESC}[6nb`);
  });
});

/** Every kind of query the replay filter knows, one of each form. */
const QUERIES = [
  `${ESC}[c`,
  `${ESC}[>0c`,
  `${ESC}[=c`,
  `${ESC}[5n`,
  `${ESC}[6n`,
  `${ESC}[?6n`,
  `${ESC}[?u`,
  `${ESC}[?2026$p`,
  `${ESC}[>q`,
  `${ESC}[18t`,
  `${ESC}[14;2t`,
  `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\`,
  `${ESC}]4;1;?\u0007`,
  `${ESC}]11;?${ESC}\\`,
  `${ESC}]52;c;?\u0007`,
  `${ESC}]52;c;?${ESC}\\`,
  `${ESC}P+q544e${ESC}\\`,
];

describe("attach server, no query in the replay", () => {
  test("tA_replay_no_query_across_ring_cut: the probe", () => {
    const world = setup({ ringBytes: 10 });
    world.child.emit(`abcdefgh${ESC}[`);
    world.child.emit("6nXYZWVUTS");
    expect(world.attach().output).toBe("XYZWVUTS");
  });

  test("tA_replay_no_query_across_ring_cut: every query kind, the cut at every byte of it", () => {
    for (const query of QUERIES) {
      // `lost` bytes of the query fell out of the ring; 0 is a query at the very start of it
      for (let lost = 0; lost < query.length; lost++) {
        for (const chunks of [
          [`${"z".repeat(30)}${query}TAIL`],
          [`${"z".repeat(30)}${query.slice(0, lost)}`, `${query.slice(lost)}TAIL`],
        ]) {
          const label = JSON.stringify([query, lost, chunks.length]);
          const world = setup({ ringBytes: query.length - lost + 4 });
          for (const chunk of chunks) world.child.emit(chunk);
          const replay = world.attach().output;
          expect(replay.endsWith("TAIL"), label).toBe(true);
          expect(toBinary(stripTerminalQueries(fromBinary(replay))), label).toBe(replay);
          // what is left of a query the tracker could not carry is text, never a sequence that begins one
          expect(replay.includes(ESC) && !replay.endsWith(`${ESC}\\TAIL`), label).toBe(false);
          // a query whose start is whole in the carry, or in the ring, is gone without a trace
          if (lost <= 1 || query.startsWith(`${ESC}[`)) expect(replay, label).toBe("TAIL");
        }
      }
    }
  });

  test("tA_replay_no_query_across_ring_cut: the carry, the ring and the first live bytes make one query", () => {
    for (const query of QUERIES.filter((q) => q.startsWith(`${ESC}[`) && q.length >= 4)) {
      const world = setup({ ringBytes: 1 });
      // the carry holds the start, the ring one byte, and the end is not written yet
      world.child.emit(`zzzz${query.slice(0, -1)}`);
      const late = world.attach();
      expect(late.output, JSON.stringify(query)).toBe("");
      world.child.emit(`${query.slice(-1)}live`);
      expect(late.output, JSON.stringify(query)).toBe("live");
    }
    // a switch that is no query comes back whole the same way
    const world = setup({ ringBytes: 1 });
    world.child.emit(`zzzz${ESC}[38;5;196`);
    const late = world.attach();
    world.child.emit("mred");
    expect(late.output).toBe(`${ESC}[38;5;196mred`);
  });
});

describe("attach server, no query made by the cut of another", () => {
  test("tA_replay_strips_terminal_queries: nested queries leave nothing in the replay", () => {
    const BEL = "\u0007";
    for (const nested of [
      `${ESC}[${ESC}[6n6n`,
      `${ESC}]52;c;${ESC}]52;c;?${BEL}?${BEL}`,
      `${ESC}[${ESC}[${ESC}[${ESC}[6n6n6n6n`,
      `${ESC}_Ga=${ESC}[14;2tq;${ESC}\\`,
    ]) {
      const world = setup();
      world.child.emit(`x${nested}y`);
      expect(world.attach().output, JSON.stringify(nested)).toBe("xy");
    }
    // when the history ends inside one, what the live bytes finish is cut too, with the level around it
    for (const [history, live, seen] of [
      [`x${ESC}[${ESC}[6n`, "6ny", "x6ny"],
      [`x${ESC}[${ESC}[6`, "n6ny", "x6ny"],
      [`x${ESC}]52;c;${ESC}]52;c;?`, `${BEL}?${BEL}y`, `x?${BEL}y`],
      // (a query of the live bytes alone stays: the program asks now)
      [`x${ESC}`, `[${ESC}[6n6ny`, `x${ESC}[${ESC}[6n6ny`],
    ] as const) {
      const split = setup();
      split.child.emit(history);
      const late = split.attach();
      split.child.emit(live);
      expect(late.output, JSON.stringify([history, live])).toBe(seen);
    }
    // the cut of a query in the history must not leave a sequence the live bytes finish
    const world = setup();
    world.child.emit(`out${ESC}]52;c;${ESC}[6n${ESC}[6`);
    const late = world.attach();
    expect(late.output).toBe("out");
    world.child.emit(`n?${BEL}live`);
    expect(late.output).toBe(`out?${BEL}live`);
  });
});

describe("attach server, several clients", () => {
  test("tA_attach_two_clients", () => {
    const world = setup();
    const first = world.attach();
    world.child.emit("one ");
    const second = world.attach();
    expect(first.closed).toBe(false);
    expect(first.bye).toBeUndefined();
    expect(second.output).toBe("one ");
    world.child.emit("two");
    expect(first.output).toBe("one two");
    expect(second.output).toBe("one two");
    first.input("a");
    second.input("b");
    expect(world.child.writes).toEqual(["a", "b"]);
    // input cut inside a character reaches the terminal as the same bytes: the terminal joins them
    first.input("â\u0082");
    first.input("¬");
    expect(world.child.writes.slice(-2)).toEqual(["â\u0082", "¬"]);
    // one leaves, the other stays
    first.end.close();
    world.child.emit("!");
    expect(second.output).toBe("one two!");
    expect(world.server.clientCount()).toBe(1);
    // the end of the session reaches the client as a BYE, and a late client is told the same
    world.server.end({ reason: "exited", exitCode: 3 });
    expect(second.bye).toEqual({ reason: "exited", exitCode: 3 });
    expect(second.closed).toBe(true);
    expect(world.attach().bye).toEqual({ reason: "exited", exitCode: 3 });
    expect(world.server.clientCount()).toBe(0);
  });

  test("tA_attach_last_resize_wins", () => {
    const world = setup();
    const first = world.attach(100, 30);
    expect(world.child.resizes).toEqual([[100, 30]]);
    const second = world.attach(80, 24);
    expect(second.welcome).toEqual({ cols: 80, rows: 24 });
    first.resize(120, 40);
    second.resize(90, 28);
    first.resize(132, 50);
    expect(world.child.resizes.at(-1)).toEqual([132, 50]);
    expect(world.server.size()).toEqual({ cols: 132, rows: 50 });
    // a size that is none ends that client and changes nothing
    second.raw(encodeFrame(FRAME.RESIZE, fromBinary('{"cols":0,"rows":0}')));
    expect(second.bye?.reason).toBe("protocol");
    expect(world.server.size()).toEqual({ cols: 132, rows: 50 });
    // a client that does not show the terminal resizes nothing and gets no output
    const quiet = world.connect().helloQuiet();
    world.child.emit("out");
    expect(quiet.welcome).toEqual({ cols: 132, rows: 50 });
    expect(quiet.output).toBe("");
    expect(world.child.resizes.at(-1)).toEqual([132, 50]);
  });

  test("tA_attach_quiet_client_resize_refused: a client that declared no size cannot resize the terminal", () => {
    for (const [label, hasChild] of WINDOWS) {
      const world = setup({ child: hasChild });
      const good = world.attach(100, 30);
      const resizes = world.child.resizes.length;
      const quiet = world.connect().helloQuiet();
      expect(quiet.welcome, label).toEqual({ cols: 100, rows: 30 });
      quiet.resize(1, 1);
      expect(quiet.bye?.reason, label).toBe("protocol");
      expect(quiet.closed, label).toBe(true);
      expect(world.server.size(), label).toEqual({ cols: 100, rows: 30 });
      expect(world.child.resizes.length, label).toBe(resizes);
      othersGoOn(world, good, hasChild, label);
    }
  });

  test("tA_attach_input_bytes_unchanged: what is not UTF-8 reaches the terminal as it was typed", () => {
    const world = setup();
    const client = world.attach();
    // an X10 mouse report at column 200 and row 223, a key with the eighth bit, a lone continuation byte
    for (const typed of [
      `${ESC}[M \u00e8\u00ff`,
      "\u00e1",
      "\u0080",
      `${ESC}[M#\u00c3`,
      "\u00a9x",
    ]) {
      client.input(typed);
      expect(world.child.writes.at(-1), JSON.stringify(typed)).toBe(typed);
    }
    expect(world.child.writes.length).toBe(5);
  });

  test("tA_attach_client_cap", () => {
    expect(ATTACH_MAX_CLIENTS).toBe(8);
    const world = setup();
    const clients = Array.from({ length: ATTACH_MAX_CLIENTS }, () => world.attach());
    const ninth = world.attach();
    expect(ninth.bye?.reason).toBe("full");
    expect(ninth.bye?.text).toContain("8");
    expect(ninth.closed).toBe(true);
    expect(ninth.welcome).toBeUndefined();
    expect(clients.every((c) => !c.closed)).toBe(true);
    // a client that has not said hello holds a place too, until it is timed out
    clients[0]?.end.close();
    const silent = world.connect();
    expect(world.attach().bye?.reason).toBe("full");
    world.timers.advance(ATTACH_HELLO_TIMEOUT_MS);
    expect(silent.closed).toBe(true);
    expect(world.attach().bye).toBeUndefined();
  });

  test("tA_attach_slow_client_dropped", () => {
    expect(ATTACH_LAG_BYTES).toBe(4 * 1024 * 1024);
    const world = setup();
    const good = world.attach();
    const slow = world.attach();
    const slowEnd = slow.end as ReturnType<typeof memoryPair>["client"];
    slowEnd.reading = false;
    const chunk = new Uint8Array(512 * 1024).fill(66);
    let sent = 0;
    while (!slowEnd.closed && sent < 64) {
      world.child.emit(chunk);
      sent++;
    }
    // dropped once its unread bytes would pass the limit (the frame headers count too)
    expect(sent).toBe(8);
    expect(slowEnd.closed).toBe(true);
    expect(world.server.clientCount()).toBe(1);
    expect(good.closed).toBe(false);
    expect(good.output.length).toBe(sent * chunk.length);
    // it may come back, and gets the ring
    const back = world.attach();
    expect(back.bye).toBeUndefined();
    expect(back.output.length).toBe(ATTACH_RING_BYTES);
    world.child.emit("z");
    expect(back.output.endsWith("z")).toBe(true);
  });

  test("tA_attach_memory_bound_at_cap", () => {
    const world = setup();
    const ends = Array.from({ length: ATTACH_MAX_CLIENTS }, () => {
      const client = world.attach();
      const end = client.end as ReturnType<typeof memoryPair>["client"];
      end.reading = false;
      return end;
    });
    const bound = ATTACH_RING_BYTES + ATTACH_MAX_CLIENTS * ATTACH_LAG_BYTES;
    const chunk = new Uint8Array(256 * 1024).fill(67);
    let most = 0;
    for (let i = 0; i < 15; i++) {
      world.child.emit(chunk);
      most = Math.max(most, world.server.buffered());
      expect(world.server.buffered()).toBeLessThanOrEqual(bound);
    }
    // all eight are filled close to the limit and still attached
    expect(world.server.clientCount()).toBe(ATTACH_MAX_CLIENTS);
    expect(most).toBeGreaterThan(ATTACH_RING_BYTES + ATTACH_MAX_CLIENTS * 3.5 * 1024 * 1024);
    expect(world.attach().bye?.reason).toBe("full");
    // one more chunk is past the limit for every one of them: each is dropped and frees its share
    for (let i = 0; i < 2; i++) world.child.emit(chunk);
    expect(world.server.clientCount()).toBe(0);
    expect(ends.every((end) => end.closed)).toBe(true);
    expect(world.server.buffered()).toBe(ATTACH_RING_BYTES);
    expect(world.attach().bye).toBeUndefined();
  });

  test("tA_forget_name_keeps_attached_client", () => {
    const names = mkdtempSync(join(tmpdir(), "kdjs-names-"));
    try {
      writeFileSync(join(names, "worker.json"), "{}");
      const world = setup();
      const client = world.attach();
      expect(forgetName(names, "worker")).toBe(true);
      expect(client.closed).toBe(false);
      expect(client.bye).toBeUndefined();
      world.child.emit("still attached");
      expect(client.output).toBe("still attached");
    } finally {
      rmSync(names, { recursive: true, force: true });
    }
  });
});

describe("attach server, send", () => {
  const PASTE_ON = `${ESC}[?2004h`;
  const PASTE_OFF = `${ESC}[?2004l`;

  test("tA_pty_send_paste_only_with_2004", async () => {
    const world = setup();
    const now = () => Promise.resolve();
    await world.server.send("plain", false, now);
    expect(world.child.writes).toEqual(["plain"]);
    // switched on in a chunk that is cut inside the switch
    world.child.emit(`prompt${PASTE_ON.slice(0, 4)}`);
    expect(world.server.bracketedPaste()).toBe(false);
    world.child.emit(PASTE_ON.slice(4));
    expect(world.server.bracketedPaste()).toBe(true);
    await world.server.send(`two\nlines${ESC}[201~x`, false, now);
    // the paste end inside the text is taken out: it would end the paste early
    expect(world.child.writes.at(-1)).toBe(`${ESC}[200~two\nlinesx${ESC}[201~`);
    world.child.emit(PASTE_OFF);
    await world.server.send("after", false, now);
    expect(world.child.writes.at(-1)).toBe("after");
    // without a terminal there is nothing to send to
    const early = setup({ child: false });
    expect(early.server.send("x", true, now)).rejects.toThrow();
  });

  test("tA_pty_send_gap_uses_clock: Enter is a write of its own, after the gap on the injected clock", async () => {
    const world = setup();
    world.child.emit(PASTE_ON);
    const waits: number[] = [];
    let release = () => {};
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        release = resolve;
      });
    const sent = world.server.send("hello", true, sleep);
    await Promise.resolve();
    await Promise.resolve();
    expect(world.child.writes).toEqual([`${ESC}[200~hello${ESC}[201~`]);
    expect(waits).toEqual([SEND_PASTE_GAP_MS]);
    release();
    expect(await sent).toEqual({ bytes: `${ESC}[200~hello${ESC}[201~\r`.length });
    expect(world.child.writes).toEqual([`${ESC}[200~hello${ESC}[201~`, "\r"]);

    // the SEND frame of a client waits on the server's own clock, and is answered with the bytes written
    const client = world.connect().helloQuiet();
    client.raw(encodeSend({ text: "via frame" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(world.child.writes.at(-1)).toBe(`${ESC}[200~via frame${ESC}[201~`);
    expect(client.frames.some((f) => f.type === FRAME.SENT)).toBe(false);
    world.timers.advance(SEND_PASTE_GAP_MS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.child.writes.at(-1)).toBe("\r");
    const answer = client.frames.find((f) => f.type === FRAME.SENT);
    expect(answer && parseSent(answer.payload)).toEqual({
      bytes: `${ESC}[200~via frame${ESC}[201~\r`.length,
    });
    // a send before the terminal exists ends that client only
    const early = setup({ child: false });
    const hasty = early.connect().helloQuiet();
    hasty.raw(encodeSend({ text: "x" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasty.bye?.reason).toBe("protocol");
  });

  test("tA_attach_send_flood_paused_at_bound: queued sends count as input the terminal has not taken", async () => {
    const world = setup();
    world.child.takes = false;
    const good = world.attach();
    const flood = world.connect().helloQuiet();
    const holderEnd = (flood.end as ReturnType<typeof memoryPair>["client"]).peer;
    const text = "x".repeat(60_000);
    const count = 200;
    for (let i = 0; i < count; i++) flood.raw(encodeSend({ text }));
    // two are past the bound: the stream is paused, and the rest waits in it, not in the holder
    expect(holderEnd.paused).toBe(true);
    expect(holderEnd.inbox.length).toBe(count - 2);
    const sent = () => flood.frames.filter((f) => f.type === FRAME.SENT).length;
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    // the program does not read: a send is not over when its bytes are handed to the terminal, only when taken
    for (let i = 0; i < 20; i++) {
      await turn();
      world.timers.advance(SEND_PASTE_GAP_MS);
    }
    expect(sent()).toBe(0);
    expect(world.child.writes.length).toBe(1);
    expect(holderEnd.paused).toBe(true);
    expect(holderEnd.inbox.length).toBe(count - 2);
    expect(world.server.clientCount()).toBe(2);
    let most = 0;
    // the program reads again, one write a turn
    for (let i = 0; i < 10 * count && sent() < count; i++) {
      world.child.drain();
      await turn();
      most = Math.max(most, count - holderEnd.inbox.length - sent());
      expect(world.child.writes.join("").length).toBeLessThanOrEqual(
        (sent() + 2) * (text.length + 1),
      );
      world.timers.advance(SEND_PASTE_GAP_MS);
    }
    world.child.takes = true;
    world.child.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // never more than the two that reach the bound were held by the holder at once
    expect(most).toBeLessThanOrEqual(2);
    expect(sent()).toBe(count);
    expect(world.child.writes.length).toBe(2 * count);
    expect(world.child.writes.filter((w) => w === "\r").length).toBe(count);
    expect(holderEnd.paused).toBe(false);
    expect(flood.closed).toBe(false);
    othersGoOn(world, good, true, "send flood");

    // a client that goes away with sends queued is not resumed, and the others are not held up
    const second = setup();
    const gone = second.connect().helloQuiet();
    for (let i = 0; i < 3; i++) gone.raw(encodeSend({ text }));
    const goneEnd = (gone.end as ReturnType<typeof memoryPair>["client"]).peer;
    expect(goneEnd.paused).toBe(true);
    gone.end.close();
    for (let turn = 0; turn < 10; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      second.timers.advance(SEND_PASTE_GAP_MS);
    }
    expect(second.server.clientCount()).toBe(0);
    expect(goneEnd.paused).toBe(true);

    // the end of the session frees a send whose bytes the program never took
    const third = setup();
    third.child.takes = false;
    const waits = third.server.send("never read", true, () => Promise.resolve());
    await turn();
    third.server.end({ reason: "killed" });
    expect(await waits).toEqual({ bytes: "never read".length });
  });
});

describe("new session modules", () => {
  test("tA_new_modules_import_on_windows: importing reads no uid, touches no terminal and registers no signal", () => {
    // In a process of its own: the modules are imported there for the first time, under the spies. `process.getuid`
    // does not exist on Windows, so reading it at import is what would break there.
    const script = `
      const touched = [];
      const spy = (target, key, name) => {
        const real = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, {
          configurable: true,
          get() {
            touched.push(name);
            return real && "value" in real ? real.value : real?.get?.call(target);
          },
        });
      };
      spy(process, "getuid", "getuid");
      spy(process, "stdin", "stdin");
      for (const method of ["on", "once", "addListener", "prependListener"]) {
        const real = process[method];
        process[method] = function (event, ...rest) {
          if (typeof event === "string" && event.startsWith("SIG")) touched.push(event);
          return real.call(this, event, ...rest);
        };
      }
      const before = touched.length;
      const modules = [];
      for (const path of ${JSON.stringify(MODULES)}) modules.push(Object.keys(await import(path)).length);
      const atImport = touched.slice(before);
      // the spies see what they are there for
      process.getuid;
      process.stdin;
      process.on("SIGWINCH", () => {});
      console.log(JSON.stringify({ modules, atImport, after: touched.slice(before + atImport.length) }));
      process.exit(0);
    `;
    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    const seen = JSON.parse(run.stdout) as {
      modules: number[];
      atImport: string[];
      after: string[];
    };
    expect(seen.modules.length).toBe(MODULES.length);
    expect(seen.modules.every((exports) => exports > 0)).toBe(true);
    expect(seen.atImport).toEqual([]);
    expect(seen.after).toEqual(["getuid", "stdin", "SIGWINCH"]);
  });
});

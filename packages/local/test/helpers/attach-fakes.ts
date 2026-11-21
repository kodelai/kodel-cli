/** Fakes for the attach tests: an in-memory stream pair, a terminal that records, a clock moved by hand. */
import {
  type AttachStream,
  type ByeMessage,
  createFrameDecoder,
  encodeFrame,
  encodeHello,
  encodeResize,
  FRAME,
  type Frame,
  fromBinary,
  parseBye,
  parseHello,
  type TerminalSize,
  toBinary,
} from "@kodel-ai/pipeline-core";
import type { AttachTimers } from "../../src/attach-server";
import type { PtyChild, PtyExit, RawPtyModule, RawPtyProcess } from "../../src/session-pty";

export class MemoryEnd implements AttachStream {
  peer!: MemoryEnd;
  /** Bytes the peer wrote that this end has not taken. */
  inbox: Uint8Array[] = [];
  /** A test switches this off for an end whose owner does not read. */
  reading = true;
  paused = false;
  closed = false;
  pauses = 0;
  private data: ((bytes: Uint8Array) => void)[] = [];
  private closers: ((error?: Error) => void)[] = [];

  /**
   * The peer is gone and this end was not told: what a socket that is not read knows of a peer that closed.
   * Only a write finds out.
   */
  peerVanished = false;

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error("write after close");
    if (this.peerVanished) throw new Error("write EPIPE");
    this.peer.inbox.push(bytes);
    this.peer.pump();
  }
  pending(): number {
    return this.peer.inbox.reduce((sum, b) => sum + b.length, 0);
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.data.push(listener);
    this.pump();
  }
  onClose(listener: (error?: Error) => void): void {
    this.closers.push(listener);
  }
  pause(): void {
    this.paused = true;
    this.pauses++;
  }
  resume(): void {
    this.paused = false;
    this.pump();
  }
  close(): void {
    this.end();
  }
  /** Both ends see the close; `error` stands for a reset or `EPIPE`. */
  end(error?: Error): void {
    for (const side of [this as MemoryEnd, this.peer]) {
      if (side.closed) continue;
      side.closed = true;
      for (const listener of side.closers) listener(error);
    }
  }
  pump(): void {
    while (this.reading && !this.paused && this.data.length > 0 && this.inbox.length > 0) {
      const next = this.inbox.shift() as Uint8Array;
      for (const listener of this.data) listener(next);
    }
  }
}

export const memoryPair = (): { holder: MemoryEnd; client: MemoryEnd } => {
  const holder = new MemoryEnd();
  const client = new MemoryEnd();
  holder.peer = client;
  client.peer = holder;
  return { holder, client };
};

/** A client as a test drives it: it reads frames and remembers them. */
export class TestClient {
  frames: Frame[] = [];
  closed = false;
  closeError: Error | undefined;
  private readonly decoder = createFrameDecoder();

  constructor(readonly end: AttachStream) {
    end.onClose((error) => {
      this.closed = true;
      this.closeError = error;
    });
    end.onData((bytes) => {
      this.frames.push(...this.decoder.push(bytes).frames);
    });
  }
  /** A write to a stream the holder has closed already is lost, as on a socket. */
  raw(bytes: Uint8Array): void {
    try {
      this.end.write(bytes);
    } catch {
      // closed
    }
  }
  hello(size: TerminalSize = { cols: 80, rows: 24 }, v?: number): this {
    this.raw(encodeHello(size, v));
    return this;
  }
  /** The hello of a client that does not show the terminal. */
  helloQuiet(): this {
    this.raw(encodeHello(undefined));
    return this;
  }
  input(text: string): void {
    this.raw(encodeFrame(FRAME.INPUT, fromBinary(text)));
  }
  resize(cols: number, rows: number): void {
    this.raw(encodeResize({ cols, rows }));
  }
  get welcome(): TerminalSize | undefined {
    const frame = this.frames.find((f) => f.type === FRAME.WELCOME);
    return frame ? parseHello(frame.payload)?.size : undefined;
  }
  get bye(): ByeMessage | undefined {
    const frame = this.frames.find((f) => f.type === FRAME.BYE);
    return frame ? parseBye(frame.payload) : undefined;
  }
  /** Everything the terminal sent, as a binary string. */
  get output(): string {
    return this.frames
      .filter((f) => f.type === FRAME.OUTPUT)
      .map((f) => toBinary(f.payload))
      .join("");
  }
}

export class FakeChild implements PtyChild {
  readonly pid = 2_000_000_000;
  /** What was written, as binary strings (one char per byte). */
  writes: string[] = [];
  resizes: [number, number][] = [];
  kills: string[] = [];
  /** When off, a write is not taken until the test calls `drain`. */
  takes = true;
  private waiting: (() => void)[] = [];
  private data: ((bytes: Uint8Array) => void)[] = [];
  private exits: ((exit: PtyExit) => void)[] = [];

  write(data: Uint8Array, done?: () => void): void {
    this.writes.push(toBinary(data));
    if (!done) return;
    if (this.takes) done();
    else this.waiting.push(done);
  }
  drain(): void {
    for (const done of this.waiting.splice(0)) done();
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  onData(listener: (bytes: Uint8Array) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (exit: PtyExit) => void): void {
    this.exits.push(listener);
  }
  kill(signal: NodeJS.Signals): void {
    this.kills.push(signal);
  }
  emit(text: string | Uint8Array): void {
    const bytes = typeof text === "string" ? fromBinary(text) : text;
    for (const listener of this.data) listener(bytes);
  }
  exit(exit: PtyExit = { exitCode: 0 }): void {
    for (const listener of this.exits) listener(exit);
  }
}

export class ManualTimers implements AttachTimers {
  now = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.now + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((t) => !t.cancelled && t.at <= this.now);
    this.timers = this.timers.filter((t) => !due.includes(t) && !t.cancelled);
    for (const timer of due.sort((a, b) => a.at - b.at)) timer.fn();
  }
  waiting(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

/** A PTY module as the real one looks to the holder: text out, a signal as a number, a pid no process has. */
export class FakeRawPty implements RawPtyProcess {
  readonly pid = 2_000_000_001;
  writes: (string | Uint8Array)[] = [];
  resizes: [number, number][] = [];
  kills: (string | undefined)[] = [];
  private data: ((text: string) => void)[] = [];
  private exits: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  onData(listener: (text: string) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exits.push(listener);
  }
  write(data: string | Uint8Array): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  emit(text: string): void {
    for (const listener of this.data) listener(text);
  }
  exit(exitCode: number, signal = 0): void {
    for (const listener of this.exits) listener({ exitCode, signal });
  }
}

export interface FakeSpawn {
  file: string;
  args: string[];
  options: Parameters<RawPtyModule["spawn"]>[2];
  process: FakeRawPty;
}

export const fakePtyModule = (): { module: RawPtyModule; spawns: FakeSpawn[] } => {
  const spawns: FakeSpawn[] = [];
  return {
    spawns,
    module: {
      spawn(file, args, options) {
        const process = new FakeRawPty();
        spawns.push({ file, args, options, process });
        return process;
      },
    },
  };
};

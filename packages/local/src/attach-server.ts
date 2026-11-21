/**
 * The holder's side of an attach: the clients of one terminal session, over `AttachStream`s (a socket, or an
 * in-memory pair in a test). It owns no socket, no process and no timer of its own: the terminal is a `PtyChild`,
 * time comes in as `AttachTimers`.
 *
 * Everything a client sends is untrusted. A client that breaks the protocol, says nothing, or does not read is
 * told `BYE` and dropped; the other clients and the child never notice.
 */
import {
  ATTACH_PROTOCOL_VERSION,
  type AttachStream,
  type ByeMessage,
  createFrameDecoder,
  createModeTracker,
  encodeBye,
  encodeChunked,
  encodeFrame,
  encodeSent,
  encodeWelcome,
  FRAME,
  type Frame,
  joinHeldEscape,
  type PasteTrack,
  parseHello,
  parseSend,
  parseSize,
  planSend,
  SEND_PASTE_GAP_MS,
  splitReplay,
  type TerminalSize,
  toBinary,
  trackBracketedPasteChunk,
} from "@kodel-ai/pipeline-core";
import type { PtyChild } from "./session-pty";

export const ATTACH_RING_BYTES = 1024 * 1024;
/** What one client may leave unread before it is dropped. */
export const ATTACH_LAG_BYTES = 4 * 1024 * 1024;
export const ATTACH_MAX_CLIENTS = 8;
export const ATTACH_HELLO_TIMEOUT_MS = 5_000;
/**
 * Input of one client that the terminal has not taken yet, typed or sent (`SEND`); at this much its stream is
 * paused.
 */
export const ATTACH_INPUT_PENDING_BYTES = 64 * 1024;
/**
 * How often a paused client is written an empty `OUTPUT` frame. A stream that is not read never reports that its
 * peer closed, so a client that died while paused would keep its place until the session ends; a write to it
 * fails, and that is seen.
 */
export const ATTACH_PAUSED_PROBE_MS = 5_000;
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** The clock of the server: a test moves it by hand. */
export interface AttachTimers {
  /** Returns the function that cancels the timer. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const realAttachTimers: AttachTimers = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface AttachServerOptions {
  timers?: AttachTimers;
  size?: TerminalSize;
  ringBytes?: number;
  lagBytes?: number;
  maxClients?: number;
  helloTimeoutMs?: number;
  inputPendingBytes?: number;
  pausedProbeMs?: number;
}

/** The last bytes of the terminal's output. What falls out is handed to `dropped`, in order. */
export class OutputRing {
  private chunks: Uint8Array[] = [];
  private size = 0;
  wrapped = false;
  constructor(
    private readonly keep: number,
    private readonly dropped: (bytes: Uint8Array) => void,
  ) {}

  get length(): number {
    return this.size;
  }

  add(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.keep) {
      const first = this.chunks[0] as Uint8Array;
      const over = this.size - this.keep;
      this.wrapped = true;
      if (first.length <= over) {
        this.chunks.shift();
        this.size -= first.length;
        this.dropped(first);
      } else {
        this.chunks[0] = first.subarray(over);
        this.size -= over;
        this.dropped(first.subarray(0, over));
      }
    }
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

interface Client {
  stream: AttachStream;
  state: "new" | "ready" | "gone";
  /** A client that said hello without a size does not show the terminal: it gets no output and resizes nothing. */
  shows: boolean;
  cancelHello: () => void;
  decoder: ReturnType<typeof createFrameDecoder>;
  pendingInput: number;
  paused: boolean;
  /** Stops the probe of a paused client. */
  cancelProbe: () => void;
  /** The end of this client's replay that was inside an escape sequence, waiting for the live bytes. */
  held: Uint8Array;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const encoder = new TextEncoder();

export class AttachServer {
  private readonly timers: AttachTimers;
  private readonly lagBytes: number;
  private readonly maxClients: number;
  private readonly helloTimeoutMs: number;
  private readonly inputPendingBytes: number;
  private readonly pausedProbeMs: number;
  private readonly clients = new Set<Client>();
  private readonly tracker = createModeTracker();
  private readonly ring: OutputRing;
  private terminal: TerminalSize;
  private child: PtyChild | undefined;
  private paste: PasteTrack = { on: false, carry: "" };
  private ended: ByeMessage | undefined;
  private sending: Promise<unknown> = Promise.resolve();
  private readonly writesWaiting = new Set<() => void>();

  constructor(options: AttachServerOptions = {}) {
    this.timers = options.timers ?? realAttachTimers;
    this.lagBytes = options.lagBytes ?? ATTACH_LAG_BYTES;
    this.maxClients = options.maxClients ?? ATTACH_MAX_CLIENTS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? ATTACH_HELLO_TIMEOUT_MS;
    this.inputPendingBytes = options.inputPendingBytes ?? ATTACH_INPUT_PENDING_BYTES;
    this.pausedProbeMs = options.pausedProbeMs ?? ATTACH_PAUSED_PROBE_MS;
    this.terminal = options.size ?? DEFAULT_TERMINAL_SIZE;
    // The tracker is fed what leaves the ring, so it holds the modes as they were at the ring's oldest byte.
    this.ring = new OutputRing(options.ringBytes ?? ATTACH_RING_BYTES, (bytes) =>
      this.tracker.feed(bytes),
    );
  }

  /** The size the terminal has, or will be started with: the last one a client gave. */
  size(): TerminalSize {
    return this.terminal;
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Bytes held for the clients: the ring and what each of them has not read yet. */
  buffered(): number {
    let total = this.ring.length;
    for (const client of this.clients) total += client.stream.pending();
    return total;
  }

  /** Whether the program has bracketed paste on now (for `send`). */
  bracketedPaste(): boolean {
    return this.paste.on;
  }

  /** From here on input reaches the terminal. Before it, a client is answered and its input is dropped. */
  setChild(child: PtyChild): void {
    this.child = child;
    child.onData((data) => this.output(data));
  }

  accept(stream: AttachStream): void {
    if (this.ended) {
      this.refuse(stream, this.ended);
      return;
    }
    if (this.clients.size >= this.maxClients) {
      this.refuse(stream, {
        reason: "full",
        text: `${this.maxClients} clients are attached already`,
      });
      return;
    }
    const client: Client = {
      stream,
      state: "new",
      shows: false,
      cancelHello: () => {},
      decoder: createFrameDecoder(),
      pendingInput: 0,
      paused: false,
      cancelProbe: () => {},
      held: new Uint8Array(0),
    };
    this.clients.add(client);
    client.cancelHello = this.timers.setTimeout(() => {
      if (client.state === "new") {
        this.drop(client, { reason: "hello_timeout", text: "no hello in time" });
      }
    }, this.helloTimeoutMs);
    stream.onClose(() => this.forget(client));
    stream.onData((data) => {
      // Whatever a client makes this code throw is that client's problem only.
      try {
        this.received(client, data);
      } catch {
        this.drop(client, { reason: "protocol", text: "the frame could not be handled" });
      }
    });
  }

  /** Output of the terminal: kept in the ring and sent to every client that shows it. */
  output(data: Uint8Array): void {
    if (data.length === 0) return;
    this.ring.add(data);
    this.paste = trackBracketedPasteChunk(toBinary(data), this.paste);
    for (const client of [...this.clients]) {
      if (client.state !== "ready" || !client.shows) continue;
      let live = data;
      if (client.held.length > 0) {
        const joined = joinHeldEscape(client.held, data);
        client.held = joined.held;
        live = joined.out;
      }
      if (live.length > 0) this.deliver(client, live);
    }
  }

  /**
   * Writes text into the terminal as `send` does: a bracketed paste only while the program has it on, then the
   * submit key as a write of its own after a pause. One `send` at a time, and it is over only when the terminal
   * has taken its bytes (or the session ended): a program that does not read holds the next one back.
   */
  send(
    text: string,
    submit: boolean,
    sleep: (ms: number) => Promise<void>,
  ): Promise<{ bytes: number }> {
    const run = async (): Promise<{ bytes: number }> => {
      const child = this.child;
      if (!child || this.ended) throw new Error("the terminal does not run");
      const plan = planSend(text, this.paste.on);
      const paste = encoder.encode(plan.paste);
      await this.taken(child, paste);
      let bytes = paste.length;
      if (submit && !this.ended) {
        await sleep(SEND_PASTE_GAP_MS);
        if (this.ended) return { bytes };
        const key = encoder.encode(plan.submit);
        await this.taken(child, key);
        bytes += key.length;
      }
      return { bytes };
    };
    const result = this.sending.then(run, run);
    this.sending = result.catch(() => {});
    return result;
  }

  /** One write, over when the terminal has taken it; the end of the session frees whoever waits for that. */
  private taken(child: PtyChild, bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.writesWaiting.delete(done);
        resolve();
      };
      this.writesWaiting.add(done);
      child.write(bytes, done);
    });
  }

  /** The session is over: every client is told and closed, and a later one is told the same. */
  end(bye: ByeMessage): void {
    if (this.ended) return;
    this.ended = bye;
    for (const done of [...this.writesWaiting]) done();
    for (const client of [...this.clients]) this.drop(client, bye);
  }

  private refuse(stream: AttachStream, bye: ByeMessage): void {
    try {
      stream.write(encodeBye(bye));
      stream.close();
    } catch {
      // the stream is gone already
    }
  }

  private forget(client: Client): void {
    if (client.state === "gone") return;
    client.state = "gone";
    client.cancelHello();
    client.cancelProbe();
    this.clients.delete(client);
  }

  private drop(client: Client, bye: ByeMessage): void {
    if (client.state === "gone") return;
    this.forget(client);
    try {
      client.stream.write(encodeBye(bye));
      client.stream.close();
    } catch {
      // the stream is gone already
    }
  }

  private deliver(client: Client, data: Uint8Array): void {
    if (client.stream.pending() + data.length > this.lagBytes) {
      this.drop(client, { reason: "lagging", text: "the client does not read; attach again" });
      return;
    }
    try {
      for (const frame of encodeChunked(FRAME.OUTPUT, data)) client.stream.write(frame);
    } catch {
      this.forget(client);
    }
  }

  private received(client: Client, data: Uint8Array): void {
    // Asked again after every frame: handling one may have dropped the client.
    const gone = (): boolean => client.state === "gone";
    if (gone()) return;
    const { frames, problem } = client.decoder.push(data);
    for (const frame of frames) {
      if (gone()) return;
      this.frame(client, frame);
    }
    if (problem && !gone()) {
      this.drop(client, {
        reason: "protocol",
        text: problem === "oversize" ? "the frame is too long" : "the frame type is not known",
      });
    }
  }

  private frame(client: Client, frame: Frame): void {
    if (client.state === "new") {
      if (frame.type !== FRAME.HELLO) {
        this.drop(client, { reason: "protocol", text: "the first frame must be a hello" });
        return;
      }
      const hello = parseHello(frame.payload);
      if (!hello) {
        this.drop(client, { reason: "protocol", text: "the hello cannot be read" });
        return;
      }
      if (hello.v !== ATTACH_PROTOCOL_VERSION) {
        this.drop(client, {
          reason: "version",
          text: `this holder speaks version ${ATTACH_PROTOCOL_VERSION} of the attach protocol, the client ${hello.v}`,
        });
        return;
      }
      client.cancelHello();
      client.state = "ready";
      if (hello.size) {
        client.shows = true;
        this.resize(hello.size);
      }
      client.stream.write(encodeWelcome(this.terminal));
      if (client.shows) this.replay(client);
      return;
    }
    switch (frame.type) {
      case FRAME.INPUT:
        this.input(client, frame.payload);
        return;
      case FRAME.RESIZE: {
        const size = parseSize(frame.payload);
        if (!size) {
          this.drop(client, { reason: "protocol", text: "the size cannot be read" });
          return;
        }
        // A client that said it shows no terminal has no size to give.
        if (!client.shows) {
          this.drop(client, {
            reason: "protocol",
            text: "a client that shows no terminal may not resize it",
          });
          return;
        }
        this.resize(size);
        return;
      }
      case FRAME.SEND: {
        const message = parseSend(frame.payload);
        if (!message) {
          this.drop(client, { reason: "protocol", text: "the send cannot be read" });
          return;
        }
        const wait = (ms: number) =>
          new Promise<void>((resolve) => this.timers.setTimeout(resolve, ms));
        // A send waits its turn, for the terminal to take it and for the pause before its submit key: until
        // then it counts as input the terminal has not taken, so a client cannot queue more than the bound.
        const size = frame.payload.length;
        this.owes(client, size);
        this.send(message.text, message.submit !== false, wait).then(
          ({ bytes }) => {
            this.took(client, size);
            if (client.state === "ready") client.stream.write(encodeSent(bytes));
          },
          () => {
            this.took(client, size);
            this.drop(client, { reason: "protocol", text: "the terminal does not run yet" });
          },
        );
        return;
      }
      default:
        // a second hello, or a frame only the holder may send
        this.drop(client, { reason: "protocol", text: "a client may not send this frame" });
    }
  }

  private resize(size: TerminalSize): void {
    this.terminal = { cols: size.cols, rows: size.rows };
    try {
      this.child?.resize(size.cols, size.rows);
    } catch {
      // the terminal has just ended
    }
  }

  /**
   * The modes at the ring's oldest byte, then the ring: together the whole history, with nothing set twice, and
   * with no terminal query (the attaching terminal would answer it into the session).
   */
  private replay(client: Client): void {
    let kept = this.ring.bytes();
    if (this.ring.wrapped) {
      // The cut may be inside a UTF-8 sequence: its rest is not a character.
      let skip = 0;
      while (skip < 3 && skip < kept.length && ((kept[skip] as number) & 0xc0) === 0x80) skip++;
      kept = kept.subarray(skip);
    }
    // `pending` is the start of a sequence the cut went through; with it the ring begins with a whole one. The
    // two are filtered and split as one stream: a query may lie across the cut, or end in the first live bytes.
    const { whole, open } = splitReplay(concat([this.tracker.pending(), kept]));
    client.held = open;
    const replay = concat([this.tracker.prefix(), whole]);
    if (replay.length > 0) this.deliver(client, replay);
  }

  private input(client: Client, payload: Uint8Array): void {
    const child = this.child;
    // Before the child exists there is nothing to type into; nothing is kept for later.
    if (!child || this.ended || payload.length === 0) return;
    const size = payload.length;
    this.owes(client, size);
    // The bytes as the client sent them: a mouse report or a key with the eighth bit is not UTF-8 text.
    child.write(payload, () => this.took(client, size));
  }

  private owes(client: Client, size: number): void {
    client.pendingInput += size;
    if (!client.paused && client.pendingInput >= this.inputPendingBytes) {
      client.paused = true;
      client.stream.pause();
      this.probe(client);
    }
  }

  /** While a client is paused its end is not seen by reading: a write that fails shows it (the stream closes). */
  private probe(client: Client): void {
    client.cancelProbe = this.timers.setTimeout(() => {
      if (client.state === "gone" || !client.paused) return;
      try {
        client.stream.write(encodeFrame(FRAME.OUTPUT));
      } catch {
        this.forget(client);
        return;
      }
      this.probe(client);
    }, this.pausedProbeMs);
  }

  private took(client: Client, size: number): void {
    client.pendingInput -= size;
    if (client.paused && client.pendingInput < this.inputPendingBytes) {
      client.paused = false;
      client.cancelProbe();
      if (client.state !== "gone") client.stream.resume();
    }
  }
}
